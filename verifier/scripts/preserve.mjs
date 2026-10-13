#!/usr/bin/env node
/*
 * Route 2 evidence, step 1b: keep the raw transactions. Minima prunes transaction bodies after its window, and no
 * public explorer keeps them, so the evidence would otherwise become unverifiable. For every transaction in the card
 * ledger this saves the node's full answer for the transaction (`txpow txpowid:`) and for the block that included it
 * (`txpow block:`), whose txnlist names the transaction. A reader can then check offline that the transaction's
 * signatures and state are what the report says, and that the block lists it.
 *
 * Usage: node preserve.mjs --rpc 10005 --ledger card-ledger.json --out raw
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const RPC = 'http://127.0.0.1:' + arg('rpc', '10005') + '/';
const OUT = arg('out', 'raw');
const LEDGER = JSON.parse(fs.readFileSync(arg('ledger', 'card-ledger.json'), 'utf8'));
fs.mkdirSync(OUT, { recursive: true });

function get(url) {
  return new Promise((resolve, reject) => {
    // The node ends header lines with a bare LF; the lenient parser accepts it (local node only).
    const req = http.get(url, { insecureHTTPParser: true, agent: false }, (res) => { let s = ''; res.setEncoding('utf8'); res.on('data', (d) => (s += d)); res.on('end', () => resolve(s)); });
    req.on('error', reject); req.setTimeout(60000, () => req.destroy(new Error('timeout')));
  });
}
// The node sometimes drops a connection ("socket hang up"): a fresh connection per request, retried.
async function rpc(cmd) {
  for (let attempt = 0; ; attempt++) {
    try { const s = await get(RPC + encodeURIComponent(cmd).replace(/%3A/g, ':')); JSON.parse(s); return s; }
    catch (e) { if (attempt >= 5) throw e; await new Promise((r) => setTimeout(r, 700 * (attempt + 1))); }
  }
}

let saved = 0;
const blocks = new Set();
for (const t of LEDGER.transactions) {
  const raw = await rpc('txpow txpowid:' + t.txpowid);
  if (!JSON.parse(raw).status) { console.error('missing ' + t.txpowid); continue; }
  fs.writeFileSync(path.join(OUT, 'txpow-' + t.txpowid + '.json'), raw);
  blocks.add(t.block); saved++;
}
for (const b of blocks) fs.writeFileSync(path.join(OUT, 'block-' + b + '.json'), await rpc('txpow block:' + b));
console.error('saved ' + saved + ' transactions and ' + blocks.size + ' blocks to ' + OUT);
