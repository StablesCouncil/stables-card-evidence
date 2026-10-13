#!/usr/bin/env node
/*
 * Route 2 evidence, step 1: every Stables card transaction in a block range, read from a Minima node (read only).
 *
 * Walks the chain block by block (`txpow block:N`), opens each transaction in the block (`txpow txpowid:`) and keeps
 * those that touch a card contract: the R2T1 vault, the R2T2 and R2T3 anchor / vault / request / seal-copy addresses,
 * or any coin of the council's seal token (the seal head and its copies). Nothing is filtered by hand: the output is
 * the complete card ledger of the range, so a reader can check that every movement has the shape the design says.
 *
 * Usage: node collect.mjs --rpc 10005 --from 2362300 --to 2362950 --out card-ledger.json
 * Runs where the node's RPC is reachable (the council server: 127.0.0.1:10005).
 */
import fs from 'node:fs';
import http from 'node:http';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const RPC = 'http://127.0.0.1:' + arg('rpc', '10005') + '/';
const FROM = Number(arg('from')), TO = Number(arg('to')), OUT = arg('out', 'card-ledger.json');
if (!(FROM > 0) || !(TO >= FROM)) { console.error('usage: --from N --to M'); process.exit(2); }

// The card's contract addresses (R2AndroidRuntime.java) and the council's seal token (evidence/R2T3-COUNCIL/council.json).
const CONTRACTS = {
  '0x78A7881E711158B9E3AECCB026223822D401440B864218E106122DC18B5CC7F0': 'R2T1 vault',
  '0x2CD7CAD4439F2B8A10806998D4A261A84B25F582CD1C340CC362E28C1C5ADD4A': 'R2T2 anchor',
  '0xE9384126AF284F66EE0F8C39B2C645565AC1FE4B0ACAEA047F1DAAB66A079838': 'R2T2 vault',
  '0xA17D741BC402E9601D1C1FAA6CA162ACD969EDCCCB0F73704696AC5605B7566C': 'R2T2 exit request',
  '0x78143BBBC6F6F7D7826505CFDB143F81A86F7A5CF9ABE9BBE9079D4964F5A700': 'R2T2 seal copy',
  '0x3DC4BD9985D5924FEFB11C8F97A01AAE5C8D88CA4C270F9FD9889DB4CF45EE60': 'R2T3 anchor',
  '0xD7B367D654F20186DA21BE1B82BA1B4DF4FE0103CBDF12A50C7E4A7DC88F22B0': 'R2T3 vault',
  '0xB13ADD36D874B2E0640AEB1F06B9AC1B5B37EC784AAD318A1463CC13DF2ED3F7': 'R2T3 exit request',
  '0xAA222EFD8CC8E87A1616E3F8BAD1936A1363501C88337B53809664EF5E9EDF50': 'R2T3 seal copy',
};
const SEAL_TOKEN = '0x0E277A26E58F352BE2967C095E4587A671A28AED7A3EBED31D43093FDA3F2E82';
const up = (s) => String(s || '').toUpperCase().replace(/^0X/, '0x');
const roleOf = (c) => CONTRACTS[up(c.address)] || (up(c.tokenid) === up(SEAL_TOKEN) ? 'council seal' : null);

// Node's fetch refuses the node's bare HTTP reply ("fetch failed"); the plain http client reads it, as curl does.
function get(url) {
  return new Promise((resolve, reject) => {
    // The node ends header lines with a bare LF; the lenient parser accepts it (local node only).
    const req = http.get(url, { insecureHTTPParser: true }, (res) => { let s = ''; res.setEncoding('utf8'); res.on('data', (d) => (s += d)); res.on('end', () => resolve(s)); });
    req.on('error', reject); req.setTimeout(60000, () => req.destroy(new Error('timeout')));
  });
}
async function rpc(cmd) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const j = JSON.parse(await get(RPC + encodeURIComponent(cmd).replace(/%3A/g, ':')));
      if (j.status) return j.response;
      if (attempt === 3) throw new Error(j.error || 'refused');
    } catch (e) { if (attempt === 3) throw e; }
    await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
  }
}

const coinOf = (c) => ({ coinid: c.coinid, address: up(c.address), role: roleOf(c), amount: c.tokenamount || c.amount,
  tokenid: up(c.tokenid), state: c.state || [] });

const ledger = { source: 'Minima node RPC, read only', from: FROM, to: TO, collected: new Date().toISOString(), transactions: [] };
for (let b = FROM; b <= TO; b++) {
  let block;
  try { block = await rpc('txpow block:' + b); } catch (e) { console.error('block ' + b + ': ' + e.message); continue; }
  const ids = (block.body && block.body.txnlist) || [];
  // A block can also carry a transaction itself (the miner's own).
  if (block.istransaction) ids.unshift(block.txpowid);
  for (const id of ids) {
    let t;
    try { t = await rpc('txpow txpowid:' + id); } catch (e) { console.error('txpow ' + id + ': ' + e.message); continue; }
    const txn = t.body && t.body.txn;
    if (!txn) continue;
    const touches = txn.inputs.concat(txn.outputs).some((c) => roleOf(c));
    if (!touches) continue;
    const w = t.body.witness || {};
    ledger.transactions.push({
      txpowid: t.txpowid, transactionid: txn.transactionid, block: b, time: new Date(Number(t.header.timemilli)).toISOString(),
      inputs: txn.inputs.map(coinOf), outputs: txn.outputs.map(coinOf), state: txn.state || [],
      // Who signed: every public key that put a signature on this transaction (Minima's own wallet signatures).
      signers: (w.signatures || []).flatMap((s) => (s.signatures || []).map((x) => up(x.publickey))),
      // The contract scripts the transaction had to satisfy, as the witness carries them.
      scripts: (w.scripts || []).map((s) => ({ address: up(s.address), script: s.script })),
    });
  }
  if ((b - FROM) % 50 === 0) console.error('block ' + b + ': ' + ledger.transactions.length + ' card transactions so far');
}
fs.writeFileSync(OUT, JSON.stringify(ledger, null, 1));
console.error('wrote ' + OUT + ': ' + ledger.transactions.length + ' card transactions in blocks ' + FROM + '..' + TO);
