#!/usr/bin/env node
/*
 * One phone signature, followed from the chain to the check. Takes one exit request from the evidence and writes a page
 * that shows: the transaction's kept values, the package inside them, the exit line byte by byte, the signature and the
 * chip key that made it (re-verified in the reader's own browser with WebCrypto), the hand-over that gave the coin to that
 * key (also re-verified), the deposit it started from, and the certificate chain that puts the key in a phone's chip.
 *
 * Usage: node walkthrough.mjs --dir evidence/2026-10-12 --tx <txpowid of an exit request> [--out <file>] [--standalone]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const DIR = arg('dir', 'evidence/2026-10-12');
const EV = JSON.parse(fs.readFileSync(path.join(DIR, 'evidence.json'), 'utf8'));
const LEDGER = JSON.parse(fs.readFileSync(path.join(DIR, 'card-ledger.json'), 'utf8'));
const TX = arg('tx');
const OUT = arg('out', path.join(DIR, 'signature-walkthrough.html'));
const STANDALONE = process.argv.includes('--standalone');
// On the published site the page sits two folders under the start page; a private preview has nowhere to go back to.
const BACK = STANDALONE ? '<a class="back" href="../../" style="display:inline-block;margin-bottom:10px;font-size:14px;font-weight:600;color:var(--accent);text-decoration:none">&larr; All evidence pages</a>' : '';

const r = EV.results.find((x) => x.txpowid.toUpperCase() === String(TX).toUpperCase());
if (!r || !r.package) { console.error('not an exit request with a package: ' + TX); process.exit(2); }
const t = LEDGER.transactions.find((x) => x.txpowid === r.txpowid);
const p = r.package;
const hex = (h) => String(h).replace(/^0x/i, '').toUpperCase();
const port = (n) => { const s = (t.state || []).find((x) => Number(x.port) === n); return s ? String(s.data) : ''; };

// The package as the chain holds it: ports 30.. in order.
let pkgHex = ''; for (let n = 30; n < 40; n++) if (port(n)) pkgHex += hex(port(n));
const pkg = Buffer.from(pkgHex, 'hex');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();

// Exit line inside the package: "STR2P" | ver | var16 exit body | u8 sig length | sig | bundle...
const exitBody = Buffer.from(hex(p.exit.bodyHex), 'hex');
const exitSig = Buffer.from(hex(p.exit.signatureDer), 'hex');
const bodyAt = pkg.indexOf(exitBody);
const fieldsExit = (b) => {
  let o = 0; const take = (n) => { const s = b.subarray(o, o + n); o += n; return s; };
  return [
    ['Magic', take(5), '"STR2E": this is an exit line'],
    ['Version', take(1), 'format version 1'],
    ['Coin', take(32), 'the coin leaving the card'],
    ['Currency', take(32), 'the token id (Winiwa)'],
    ['Amount', take(8), ''],
    ['Pay to', take(32), 'the Savings address to pay'],
    ['Nonce', take(16), 'random, so no two exit lines are alike'],
  ].map(([name, bytes, note]) => ({ name, hex: bytes.toString('hex').toUpperCase(), note }));
};
const exitFields = fieldsExit(exitBody);
const amountAtoms = BigInt('0x' + exitFields[4].hex);
exitFields[4].note = String(amountAtoms) + ' atoms = ' + (Number(amountAtoms) / 1e8) + ' Winiwa';

// DER signature: 30 len 02 rlen r 02 slen s
const der = (b) => { let o = 2; const rl = b[o + 1]; const rr = b.subarray(o + 2, o + 2 + rl); o += 2 + rl; const sl = b[o + 1]; const ss = b.subarray(o + 2, o + 2 + sl); return { r: rr.toString('hex').toUpperCase(), s: ss.toString('hex').toUpperCase(), len: b.length }; };

// The hand-over that made the exited coin: its received coin id is SHA-256(body | 0x01).
const hopOf = (coin) => p.hops.find((h) => hex(h.pays.coin) === hex(coin) || (h.change && hex(h.change.coin) === hex(coin)));
const made = hopOf(p.exit.exitedCoin);
const fieldsHop = (b) => {
  let o = 0; const take = (n) => { const s = b.subarray(o, o + n); o += n; return s; };
  const out = [['Magic', take(5), '"STR2H": a hand-over'], ['Version', take(1), ''], ['Currency', take(32), '']];
  const n = take(1); out.push(['Parents', n, n[0] + ' coin(s) spent']);
  for (let i = 0; i < n[0]; i++) out.push(['Parent ' + (i + 1), take(32), 'a coin spent, signed by its own key']);
  out.push(['Receiver key', take(65), 'the new coin\'s one-use key (made in the receiving chip)']);
  const ra = take(8); out.push(['Amount', ra, String(BigInt('0x' + ra.toString('hex'))) + ' atoms']);
  const hc = take(1); out.push(['Change?', hc, hc[0] ? 'yes' : 'no']);
  if (hc[0]) { out.push(['Change key', take(65), 'the payer\'s own fresh key']); const ca = take(8); out.push(['Change', ca, String(BigInt('0x' + ca.toString('hex'))) + ' atoms']); }
  return out.map(([name, bytes, note]) => ({ name, hex: bytes.toString('hex').toUpperCase(), note }));
};

// Each key, by its fingerprint, with its device and certificate chain.
const keyByHash = new Map(p.keys.map((k) => [hex(k.keyHash || ''), k]));
const keyOf = (pub) => keyByHash.get(sha(Buffer.from(hex(pub), 'hex'))) || null;
const devOf = (pub) => { const k = keyOf(pub); return k ? { device: k.device, os: k.os, keyHash: k.keyHash, chain: k.chain, rules: k.rules, level: k.securityLevel, boot: k.bootState } : null; };

// The deposit transaction(s) on chain for the anchors in this history.
const anchorTx = p.anchors.map((a) => {
  const tx = LEDGER.transactions.find((x) => x.outputs.some((o) => hex(o.coinid) === hex(a.anchorCoin)));
  return { anchor: a.anchorCoin, amount: a.amount, tx: tx ? tx.txpowid : '', block: tx ? tx.block : 0 };
});

// What happened after the request: the Council's seal, then the payout that spends the request.
const COUNCIL = JSON.parse(fs.readFileSync(arg('council', path.join(DIR, '..', 'council.json')), 'utf8'));
const MEMBER = new Map(COUNCIL.members.map((m) => [hex(m.publickey), m.member]));
const portOf = (x, n) => { const v = (x.state || []).find((y) => Number(y.port) === n); return v ? String(v.data) : ''; };
// Minima signs with one-use keys under a key tree; the tree's root is the wallet key a contract names (MULTISIG).
const rootKeysOf = (id) => {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'raw', 'txpow-' + id + '.json'), 'utf8')).response;
    return (raw.body.witness.signatures || []).map((g) => ({ rootkey: hex(g.signatures[0].rootkey), oneUse: g.signatures.length }));
  } catch (_) { return []; }
};
const reqOut = t.outputs.find((o) => /exit request/.test(o.role || ''));
const payTx = reqOut && LEDGER.transactions.find((x) => x.inputs.some((i) => hex(i.coinid) === hex(reqOut.coinid)));
const sealRoot = payTx ? hex(portOf(payTx, 20)) : '';
const sealTx = sealRoot && LEDGER.transactions.find((x) => x.inputs.some((i) => i.role === 'council seal') && hex(portOf(x, 20)) === sealRoot);
const COUNCIL_D = {
  members: COUNCIL.members.map((m) => ({ member: m.member, key: hex(m.publickey) })), quorum: COUNCIL.quorum, note: COUNCIL.note,
  seal: sealTx ? (() => {
    const head = sealTx.inputs.find((i) => i.role === 'council seal');
    return { id: sealTx.txpowid, block: sealTx.block, time: sealTx.time, root: sealRoot, period: Number(portOf(sealTx, 21)),
      prevRoot: hex(portOf(head, 20)), prevPeriod: Number(portOf(head, 21)), copies: sealTx.outputs.filter((o) => /seal copy/.test(o.role || '')).length,
      signers: rootKeysOf(sealTx.txpowid).map((g) => ({ key: g.rootkey, member: MEMBER.get(g.rootkey) || 0, oneUse: g.oneUse })) };
  })() : null,
  pay: payTx ? { id: payTx.txpowid, block: payTx.block, time: payTx.time, signers: rootKeysOf(payTx.txpowid).length,
    inputs: payTx.inputs.map((i) => ({ role: i.role || '', amount: i.amount, coin: i.coinid })),
    outputs: payTx.outputs.map((o) => ({ role: o.role || '', amount: o.amount, address: hex(o.address) })),
    ports: [15, 16, 20, 21, 25].map((n) => ({ port: n, data: portOf(payTx, n) })) } : null,
  exitPay: exitFields[5].hex, exitAmount: String(Number(amountAtoms) / 1e8),
};

const D = {
  council: COUNCIL_D,
  tx: { id: r.txpowid, block: r.block, time: r.time, request: t.outputs.find((o) => /exit request/.test(o.role || '')),
    state: (t.state || []).filter((s) => Number(s.port) < 30).map((s) => ({ port: Number(s.port), data: String(s.data) })),
    chunks: (t.state || []).filter((s) => Number(s.port) >= 30 && Number(s.port) < 40).map((s) => ({ port: Number(s.port), bytes: hex(s.data).length / 2 })),
    signers: t.signers },
  pkg: { hex: pkgHex, bytes: pkg.length, sha: sha(pkg), port10: hex(port(10)), head: pkg.subarray(0, 6).toString('hex').toUpperCase(), bodyAt, bundleAt: bodyAt + exitBody.length + 1 + exitSig.length },
  exit: { fields: exitFields, bodyHex: hex(p.exit.bodyHex), sigHex: hex(p.exit.signatureDer), der: der(exitSig), pub: hex(p.exit.signerPublicKey), signer: devOf(p.exit.signerPublicKey), payout: p.exit.payout },
  made: made ? { hop: made.hop, bodyHex: hex(made.bodyHex), fields: fieldsHop(Buffer.from(hex(made.bodyHex), 'hex')), spends: made.spends.map((s) => ({ coin: s.coin, amount: s.amount, sigHex: hex(s.signatureDer), pub: hex(s.signerPublicKey), signer: devOf(s.signerPublicKey) })), pays: made.pays } : null,
  hops: p.hops.length, devices: p.devices, keys: p.keys.length, anchors: anchorTx, verdict: p.verdict,
};

const page = `<title>Phone Signature Walkthrough</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700&family=Public+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
/* Layout: one reading column, a numbered sequence of steps (the order is the point: chain, package, line, signature, key, chip). */
:root{ --bg:#f3f5f7; --panel:#fff; --ink:#14212b; --muted:#5d6b76; --line:#d9e0e6; --soft:#eef2f5;
  --accent:#1c5d8c; --ok:#1d7a4f; --okbg:#e2f3ea; --bad:#b3261e; --badbg:#fbe4e2;
  --f1:#e3eef9; --f2:#efe6f8; --f3:#e6f4ea; --f4:#fdf0dc; --f5:#e8eaf6; --f6:#fde7ef; --f7:#e0f4f5;
  --display:'Bricolage Grotesque',ui-sans-serif,system-ui,sans-serif; --body:'Public Sans',ui-sans-serif,system-ui,sans-serif; --mono:'JetBrains Mono',ui-monospace,Menlo,monospace; }
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){ --bg:#0f161c; --panel:#16212a; --ink:#e4ebf0; --muted:#97a6b2; --line:#2a3946; --soft:#1d2a35;
  --accent:#6fb1e6; --ok:#5fcf98; --okbg:#173326; --bad:#f08a82; --badbg:#3a1a18;
  --f1:#1c3048; --f2:#2c2140; --f3:#173326; --f4:#3a2e14; --f5:#232a48; --f6:#3a1f2c; --f7:#14363a; color-scheme:dark }}
:root[data-theme="dark"]{ --bg:#0f161c; --panel:#16212a; --ink:#e4ebf0; --muted:#97a6b2; --line:#2a3946; --soft:#1d2a35;
  --accent:#6fb1e6; --ok:#5fcf98; --okbg:#173326; --bad:#f08a82; --badbg:#3a1a18;
  --f1:#1c3048; --f2:#2c2140; --f3:#173326; --f4:#3a2e14; --f5:#232a48; --f6:#3a1f2c; --f7:#14363a; color-scheme:dark }
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:15.5px/1.6 var(--body);padding-inline:16px;padding-block:24px 64px}
.wrap{max-width:860px;margin:0 auto;display:flex;flex-direction:column;gap:22px}
h1{font:700 clamp(28px,4.4vw,40px)/1.1 var(--display);margin:0;text-wrap:balance}
h2{font:700 21px/1.25 var(--display);margin:0;text-wrap:balance;display:flex;gap:12px;align-items:baseline}
h2 .n{font:600 13px var(--mono);color:var(--accent);min-width:2ch}
.lead{color:var(--muted);max-width:68ch;margin:6px 0 0}
section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:12px;min-width:0}
p{margin:0;max-width:72ch}
.mono,code{font-family:var(--mono);font-size:12.5px;overflow-wrap:anywhere}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600}
.bytes{display:flex;flex-wrap:wrap;gap:6px}
.seg{border-radius:8px;padding:8px 10px;min-width:0;max-width:100%}
.seg b{display:block;font-size:12px}
.seg span{font:12px/1.45 var(--mono);overflow-wrap:anywhere;display:block}
.seg i{font-style:normal;font-size:12px;color:var(--muted)}
.c1{background:var(--f1)}.c2{background:var(--f2)}.c3{background:var(--f3)}.c4{background:var(--f4)}.c5{background:var(--f5)}.c6{background:var(--f6)}.c7{background:var(--f7)}
.verify{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
button{font:600 14px var(--body);border-radius:999px;padding:9px 16px;border:1px solid var(--accent);background:var(--accent);color:var(--panel);cursor:pointer}
button.ghost{background:transparent;color:var(--accent)}
button:focus-visible,label:focus-within{outline:2px solid var(--accent);outline-offset:2px}
.result{font-weight:600;padding:6px 12px;border-radius:999px;font-size:14px}
.result.ok{background:var(--okbg);color:var(--ok)} .result.bad{background:var(--badbg);color:var(--bad)} .result.wait{background:var(--soft);color:var(--muted)}
.note{font-size:13.5px;color:var(--muted)}
a{color:var(--accent);text-underline-offset:2px;overflow-wrap:anywhere}
.chain{margin:0;padding-left:20px;font-size:13px}
.callout{margin:0;border-left:3px solid var(--accent);background:var(--soft);padding:10px 14px;border-radius:0 8px 8px 0;font-size:14.5px}
pre.code{margin:0;background:var(--soft);border-radius:8px;padding:12px;font:12px/1.6 var(--mono);overflow-x:auto;white-space:pre}
.tick{color:var(--ok);font-weight:600} .cross{color:var(--bad);font-weight:600}
.chain li{margin:2px 0;overflow-wrap:anywhere}
.who{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.who div{border:1px solid var(--line);border-radius:10px;padding:12px;font-size:14px}
.who b{display:block;margin-bottom:4px}
label.tamper{display:inline-flex;gap:8px;align-items:center;font-size:14px;cursor:pointer}
</style>
<div class="wrap">
  <header>
  ${BACK}
    <h1>One phone signature, from the chain to the check</h1>
    <p class="lead" id="lead"></p>
  </header>
  <section id="s1"></section>
  <section id="s2"></section>
  <section id="s3"></section>
  <section id="s4"></section>
  <section id="s5"></section>
  <section id="s6"></section>
  <section id="s7"></section>
  <section id="s8"></section>
  <section id="s9"></section>
</div>
<script>
const D = ${JSON.stringify(D)};
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
const PORTS = {0:'Tag: an exit request',10:'Fingerprint (SHA-256) of the package below',11:'The coin leaving the card',12:'Amount',13:'Currency',14:'Savings address to pay',17:'Refund atom'};
const bytesOf = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
// The public Minima explorer shows each transaction and block, kept values included (checked 2026-10-13).
const EXPLORER = 'https://explorer.minima.global';
const txLink = (id, text) => '<a href="' + EXPLORER + '/transactions/' + esc(id) + '" target="_blank" rel="noopener">' + esc(text || id) + '</a>';
const blockLink = (b) => '<a href="' + EXPLORER + '/blocks/' + b + '" target="_blank" rel="noopener">' + b + '</a>';
const short = (h, n) => h.length > (n || 24) ? h.slice(0, n || 24) + '…' + h.slice(-8) : h;

$('#lead').textContent = 'A real Remove from the Stables card on Minima mainnet, block ' + D.tx.block + ' (' + D.tx.time.slice(0, 16).replace('T', ' ') + ' UTC): 0.0298 Winiwa that went through both test phones before it left the card. Every value below is taken from that transaction and from the two that followed it, the Council seal and the payout; the signatures are checked again in this browser when you press the buttons.';

// 1. The transaction on chain
$('#s1').innerHTML = '<h2><span class="n">1</span>The transaction on chain</h2><p>A Remove is an ordinary Minima transaction from Savings: one atom of Winiwa sent to the exit request address, with values kept in the coin\\'s state. Minima signs it with the owner\\'s wallet key, like any send. The phone\\'s signature is not a Minima signature: it travels as data, in the kept values.</p>'
  + '<div class="scroll"><table><thead><tr><th>Port</th><th>Meaning</th><th>Value on chain</th></tr></thead><tbody>'
  + D.tx.state.map((s) => '<tr><td class="mono">' + s.port + '</td><td>' + esc(PORTS[s.port] || '') + '</td><td class="mono">' + esc(s.data) + '</td></tr>').join('')
  + '<tr><td class="mono">' + D.tx.chunks.map((c) => c.port).join(', ') + '</td><td>The package: the phone\\'s signed exit line and the coin\\'s whole history</td><td class="mono">' + D.tx.chunks.map((c) => c.bytes + ' bytes').join(' + ') + '</td></tr></tbody></table></div>'
  + '<p class="note">TxPoW <span class="mono">' + txLink(D.tx.id) + '</span>, block ' + blockLink(D.tx.block) + ', on the Minima explorer (its State Variables list these same ports, the package included).</p>';

// 2. The package
$('#s2').innerHTML = '<h2><span class="n">2</span>Inside the kept values: the package</h2><p>Ports ' + D.tx.chunks[0].port + ' to ' + D.tx.chunks[D.tx.chunks.length - 1].port + ' joined give ' + D.pkg.bytes.toLocaleString('en') + ' bytes. Their SHA-256 must equal port 10, so nothing in them can be swapped after posting.</p>'
  + '<div class="verify"><button id="b2">Hash the package here</button><span class="result wait" id="r2">Not checked yet</span></div>'
  + '<div class="bytes"><div class="seg c1"><b>Header</b><span>' + D.pkg.head + '</span><i>"STR2P", version 1</i></div><div class="seg c2"><b>Exit line, 126 bytes</b><span>at byte ' + D.pkg.bodyAt + '</span><i>signed by the phone</i></div><div class="seg c3"><b>Signature</b><span>' + (D.exit.sigHex.length / 2) + ' bytes</span><i>DER, ECDSA P-256</i></div><div class="seg c4"><b>History</b><span>from byte ' + D.pkg.bundleAt + '</span><i>' + D.hops + ' hand-overs, ' + D.keys + ' keys, ' + D.devices + ' phones, ' + D.anchors.length + ' deposits</i></div></div>';

// 3. The exit line
$('#s3').innerHTML = '<h2><span class="n">3</span>The exit line, byte by byte</h2><p>This is what the phone signed: 126 bytes saying which coin leaves, how much, and where the money goes. Change any byte and the signature no longer matches.</p>'
  + '<p class="callout"><b>No Council input here.</b> Only the phone signs the exit line. The Council comes in two transactions later (steps 7 and 8): it can approve or refuse this request, but it cannot change the amount or the address, because the payout must match these bytes.</p>'
  + '<div class="bytes">' + D.exit.fields.map((f, i) => '<div class="seg c' + (i % 7 + 1) + '"><b>' + esc(f.name) + ' (' + f.hex.length / 2 + ')</b><span>' + esc(f.hex) + '</span><i>' + esc(f.note) + '</i></div>').join('') + '</div>';

// 4. The signature and the key
const signer = D.exit.signer || {};
$('#s4').innerHTML = '<h2><span class="n">4</span>The signature and the chip key that made it</h2>'
  + '<p>The phone asked its chip to sign the exit line with the coin\\'s own key. That key can sign once: the chip refuses a second signature and the app deletes it, so the money has left the card the moment this signature exists. The signature is two numbers, r and s:</p>'
  + '<div class="bytes"><div class="seg c1"><b>r</b><span>' + D.exit.der.r + '</span></div><div class="seg c2"><b>s</b><span>' + D.exit.der.s + '</span></div></div>'
  + '<p>The key that must have made it is the coin\\'s owner, recorded in the history (an uncompressed P-256 point: 04, then x, then y):</p>'
  + '<div class="seg c5"><b>Public key</b><span>' + D.exit.pub + '</span><i>' + esc((signer.device || '') + ' · ' + (signer.os || '') + ' · ' + (signer.level || '') + ' chip') + '</i></div>'
  + '<div class="verify"><button id="b4">Verify this signature here</button><label class="tamper"><input type="checkbox" id="t4"> Change one byte of the amount first</label><span class="result wait" id="r4">Not checked yet</span></div>'
  + '<p class="note">Your browser checks it with its own cryptography (WebCrypto, ECDSA P-256 with SHA-256), from the bytes shown here. The Council\\'s checker and every receiving phone run the same check (R2Codec.verify).</p>';

// 5. Where the key comes from
const mk = D.made;
$('#s5').innerHTML = '<h2><span class="n">5</span>Where that key comes from</h2>'
  + (mk ? '<p>The key above did not appear from nowhere. Hand-over ' + mk.hop + ' created this coin and gave it to that key, and the hand-over itself is signed by the key of every coin it spent. Here is that hand-over:</p>'
    + '<div class="bytes">' + mk.fields.map((f, i) => '<div class="seg c' + (i % 7 + 1) + '"><b>' + esc(f.name) + ' (' + f.hex.length / 2 + ')</b><span>' + esc(short(f.hex, 40)) + '</span><i>' + esc(f.note) + '</i></div>').join('') + '</div>'
    + mk.spends.map((s, i) => '<div class="verify"><span>Spends ' + esc(s.amount) + ' Winiwa, signed in <b>' + esc((s.signer && (s.signer.device + ' · ' + s.signer.os)) || '?') + '</b></span><button class="ghost" data-sp="' + i + '">Verify this signature here</button><span class="result wait" id="rs' + i + '">Not checked yet</span></div>').join('')
    + '<p>Following the parents back the same way, hand-over by hand-over, every coin ends at a deposit into the vault, made from Savings and visible on chain:</p>'
    + '<div class="scroll"><table><thead><tr><th>Deposit (Add)</th><th>Amount</th><th>Block</th><th>TxPoW</th></tr></thead><tbody>' + D.anchors.map((a) => '<tr><td class="mono">' + esc(short(a.anchor, 18)) + '</td><td>' + esc(a.amount) + '</td><td>' + (a.block ? blockLink(a.block) : '') + '</td><td class="mono">' + (a.tx ? txLink(a.tx, short(a.tx, 18)) : '') + '</td></tr>').join('') + '</tbody></table></div>'
  : '<p>No hand-over in this history.</p>');

// 6. The chip
$('#s6').innerHTML = '<h2><span class="n">6</span>Is that key really inside a phone\\'s chip?</h2>'
  + '<p>When the phone made the key, its chip wrote a certificate for it and signed it with the device\\'s own attestation key, installed at the factory and signed up to Google\\'s hardware root. That chain travels in the history. For the key that signed the exit line:</p>'
  + '<ol class="chain">' + (signer.chain || []).map((c) => '<li class="mono">' + esc(c.subject) + '</li>').join('') + '</ol>'
  + '<p>Checked against Google\\'s pinned roots, the certificate says:</p><ul class="chain">' + (signer.rules || []).map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>'
  + '<p class="note">These certificate checks are not repeated in the browser: they parse Android\\'s key description, which the Stables checking code does (R2Attestation.verifyKey). Its result for every key of this Remove: ' + esc(D.verdict) + '.</p>';

// 7. The Council's seal
const C = D.council, SE = C.seal, PY = C.pay;
const memberName = (n) => n ? 'Member ' + n : 'Not a Council key';
$('#s7').innerHTML = SE ? '<h2><span class="n">7</span>The Council approves: a seal signed by 5 of 7</h2>'
  + '<p>The Council does not sign the request itself. Its checker reads the package from the chain and runs the same checks as steps 2 to 6, plus two of its own: this coin never left a card before, and the exit line agrees with ports 11 to 14. Every request it approves goes into a list, and the list is folded into one fingerprint, the <b>approvals root</b>. Then 5 of the 7 Council keys sign one transaction that writes that root on chain, in the Council&rsquo;s seal coin.</p>'
  + '<div class="scroll"><table><thead><tr><th></th><th>Before</th><th>After this seal</th></tr></thead><tbody>'
  + '<tr><td>Period (port 21)</td><td class="mono">' + SE.prevPeriod + '</td><td class="mono">' + SE.period + '</td></tr>'
  + '<tr><td>Approvals root (port 20)</td><td class="mono">' + esc(short('0x' + SE.prevRoot, 18)) + '</td><td class="mono">0x' + esc(SE.root) + '</td></tr></tbody></table></div>'
  + '<p>Who signed it, read from the transaction&rsquo;s signatures. Minima signs with a one-use key under each wallet&rsquo;s key tree; the tree&rsquo;s top is the wallet key that the contract names, and these are compared with the 7 published Council keys:</p>'
  + '<div class="scroll"><table><thead><tr><th>Signature</th><th>Wallet key (top of the tree)</th><th>Published as</th></tr></thead><tbody>'
  + SE.signers.map((g, i) => '<tr><td>' + (i + 1) + '</td><td class="mono">0x' + esc(g.key) + '</td><td>' + (g.member ? '<span class="tick">' + memberName(g.member) + '</span>' : '<span class="cross">' + memberName(0) + '</span>') + '</td></tr>').join('')
  + '</tbody></table></div>'
  + '<p>The rule the chain enforces on the seal coin (contract <span class="mono">r2t3_head.kiss</span>, the seven keys written in at creation):</p>'
  + '<pre class="code">ASSERT MULTISIG(5 K1 K2 K3 K4 K5 K6 K7)   5 of the 7 Council keys must sign\\nASSERT STATE(21) EQ (PREVSTATE(21) + 1)   the period goes up by exactly one\\n...                                        the seal coin and its ' + SE.copies + ' copies are re-created</pre>'
  + '<p class="note">Seal transaction <span class="mono">' + txLink(SE.id) + '</span>, block ' + blockLink(SE.block) + ', ' + esc(SE.time.slice(0, 16).replace('T', ' ')) + ' UTC. ' + esc(C.note) + '</p>'
  : '<h2><span class="n">7</span>The Council</h2><p>No Council seal for this request in this record.</p>';

// 8. The payout
const exitOut = PY ? PY.outputs[0] : null;
$('#s8').innerHTML = PY ? '<h2><span class="n">8</span>The payout: the contract checks the seal and the exit line</h2>'
  + '<p>The payout signs with nobody&rsquo;s key' + (PY.signers ? '' : ' (this transaction carries no signature at all)') + '. It is allowed because the contracts check, on chain, what the Council sealed. It spends:</p>'
  + '<div class="scroll"><table><thead><tr><th>Input</th><th>Amount</th><th>Coin</th></tr></thead><tbody>'
  + PY.inputs.map((x) => '<tr><td>' + esc(x.role.replace('R2T3 ', '')) + '</td><td>' + esc(x.amount) + '</td><td class="mono">' + esc(short(x.coin, 18)) + '</td></tr>').join('') + '</tbody></table></div>'
  + '<p>and creates:</p><div class="scroll"><table><thead><tr><th>Output</th><th>Amount</th><th>To</th></tr></thead><tbody>'
  + PY.outputs.map((o, i) => '<tr><td>' + (i === 0 ? 'Payout to Savings' : /seal copy/.test(o.role) ? 'Seal copy, back for the next payout' : i === 1 ? 'Request atom, refunded' : 'Change, back to the vault') + '</td><td>' + esc(o.amount) + '</td><td class="mono">' + esc(short('0x' + o.address, 18)) + '</td></tr>').join('') + '</tbody></table></div>'
  + '<p>The rule on the request coin (contract <span class="mono">r2t3_request.kiss</span>), line by line:</p>'
  + '<pre class="code">ASSERT VERIFYOUT(0 STATE(14) STATE(12) STATE(13) FALSE)   output 0 pays the amount of port 12 to the address of port 14\\nIF @COINAGE GTE wait THEN RETURN TRUE ENDIF               Council silent long enough: pays itself\\nASSERT GETINADDR(..) EQ sealaddr                          otherwise a Council seal copy must be spent too\\nRETURN PROOF(@COINID 0 STATE(20) 0 STATE(25))             and this request must be in the sealed approvals root</pre>'
  + '<p>The seal copy&rsquo;s own contract (<span class="mono">r2t3_copy.kiss</span>) makes sure port 20 here is the root the Council sealed (<span class="mono">SAMESTATE(20 22)</span>), so the proof is checked against the Council&rsquo;s signed root and nothing else. Port 25 holds the proof itself: the path from this request to the root.</p>'
  + '<div class="verify"><button id="b8">Compare with the exit line and the seal here</button><span class="result wait" id="r8">Not checked yet</span></div><ul class="chain" id="l8"></ul>'
  + '<p class="note">These comparisons run in your browser on the values shown on this page. The tree proof (PROOF) and the Council&rsquo;s signatures use Minima&rsquo;s own hashing and one-use keys and are not repeated in the browser: every Minima node checked them before accepting the transaction into block ' + PY.block + ', and a transaction failing any of them could not be in a block. Payout transaction <span class="mono">' + txLink(PY.id) + '</span>, block ' + blockLink(PY.block) + ', ' + esc(PY.time.slice(0, 16).replace('T', ' ')) + ' UTC.</p>'
  : '<h2><span class="n">8</span>The payout</h2><p>Not paid yet in this record.</p>';

// 9. Who checks what
$('#s9').innerHTML = '<h2><span class="n">9</span>Who checks what, and when</h2><div class="who">'
  + '<div><b>The receiving phone, at each payment</b>Every signature, every certificate, the deposit on chain, amounts conserved, before it credits anything. Offline, in about 0.1 s.</div>'
  + '<div><b>The Council, at the Remove</b>The same checks on the whole package, plus: this coin never exited before, the exit line matches ports 11 to 14. Then 5 of its 7 keys sign a seal approving the request (step 7).</div>'
  + '<div><b>The contract on chain</b>Minima cannot check a P-256 signature itself, so it checks what the Council signed: a seal by 5 of 7, the request in the sealed list, the exact amount to the exact address. Silent Council: the request pays itself after the waiting period (step 8), without the contract looking at the package. So the Council must reject a bad request before the wait ends: in this test it watches every block, and the tokens have no value.</div>'
  + '<div><b>Anyone, afterwards</b>Everything above is in the transaction. This page, the evidence report and the published checking code repeat the checks from the bytes alone.</div></div>';

// The checks, in this browser.
const derToRaw = (der) => { const b = bytesOf(der); let o = 2; const rl = b[o + 1]; let r = b.slice(o + 2, o + 2 + rl); o += 2 + rl; const sl = b[o + 1]; let s = b.slice(o + 2, o + 2 + sl);
  const fix = (x) => { while (x.length > 32 && x[0] === 0) x = x.slice(1); const out = new Uint8Array(32); out.set(x, 32 - x.length); return out; };
  const raw = new Uint8Array(64); raw.set(fix(r), 0); raw.set(fix(s), 32); return raw; };
async function verify(pubHex, msgHex, sigHex) {
  const key = await crypto.subtle.importKey('raw', bytesOf(pubHex), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(sigHex), bytesOf(msgHex));
}
const show = (el, ok, yes, no) => { el.className = 'result ' + (ok ? 'ok' : 'bad'); el.textContent = ok ? yes : no; };
$('#b2').addEventListener('click', async () => {
  const el = $('#r2');
  try {
    // The package bytes exactly as ports 30 onward hold them on chain, hashed by this browser.
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytesOf(D.pkg.hex)));
    const h = Array.from(d).map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
    show(el, h === D.pkg.port10, 'SHA-256 ' + h.slice(0, 12) + '… matches port 10', 'SHA-256 ' + h.slice(0, 12) + '… does not match port 10');
  } catch (e) { el.className = 'result bad'; el.textContent = String(e.message || e); }
});
$('#b4').addEventListener('click', async () => {
  const el = $('#r4'); el.className = 'result wait'; el.textContent = 'Checking…';
  let msg = D.exit.bodyHex;
  if ($('#t4').checked) { const i = (5 + 1 + 32 + 32 + 7) * 2; const b = parseInt(msg.slice(i, i + 2), 16) ^ 1; msg = msg.slice(0, i) + b.toString(16).padStart(2, '0').toUpperCase() + msg.slice(i + 2); }
  try { show(el, await verify(D.exit.pub, msg, D.exit.sigHex), 'Valid: made by this chip key over these exact bytes', 'Invalid: the bytes are not what the key signed'); }
  catch (e) { el.className = 'result bad'; el.textContent = 'This browser cannot check P-256: ' + (e.message || e); }
});
if ($('#b8')) $('#b8').addEventListener('click', () => {
  const port = (n) => (PY.ports.find((x) => x.port === n) || {}).data || '';
  const H = (h) => String(h).replace(/^0x/i, '').toUpperCase();
  const checks = [
    ['Output 0 goes to the address the phone signed (exit line, Pay to)', H(exitOut.address) === H(C.exitPay)],
    ['Output 0 pays the amount the phone signed (' + C.exitAmount + ')', Number(exitOut.amount) === Number(C.exitAmount)],
    ['Port 20 is the approvals root the Council sealed in step 7', !!SE && H(port(20)) === H(SE.root)],
    ['Port 21 is that seal&rsquo;s period (' + (SE ? SE.period : '?') + ')', !!SE && Number(port(21)) === SE.period],
    ['The seal was signed by at least ' + C.quorum + ' different published Council keys', !!SE && new Set(SE.signers.filter((g) => g.member).map((g) => g.member)).size >= C.quorum],
    ['The seal came before the payout (block ' + (SE ? SE.block : '?') + ' before ' + PY.block + ')', !!SE && SE.block < PY.block],
  ];
  $('#l8').innerHTML = checks.map(([t, ok]) => '<li>' + (ok ? '<span class="tick">Yes</span> ' : '<span class="cross">No</span> ') + t + '</li>').join('');
  const all = checks.every((c) => c[1]);
  show($('#r8'), all, 'All ' + checks.length + ' match', 'Something does not match');
});
document.querySelectorAll('[data-sp]').forEach((b) => b.addEventListener('click', async () => {
  const i = +b.getAttribute('data-sp'), s = D.made.spends[i], el = document.getElementById('rs' + i);
  el.className = 'result wait'; el.textContent = 'Checking…';
  try { show(el, await verify(s.pub, D.made.bodyHex, s.sigHex), 'Valid', 'Invalid'); } catch (e) { el.className = 'result bad'; el.textContent = String(e.message || e); }
}));
</script>`;

const html = STANDALONE ? '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' + page.replace('<div class="wrap">', '</head><body>\n<div class="wrap">') + '\n</body></html>\n' : page;
fs.writeFileSync(OUT, html);
console.log('wrote ' + OUT + ' (' + Math.round(html.length / 1024) + ' KB); package sha ' + (D.pkg.sha === D.pkg.port10 ? 'matches' : 'DIFFERS from') + ' port 10');
