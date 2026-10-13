#!/usr/bin/env node
/*
 * Route 2 evidence, step 4: a page a person can read. It takes the evidence (report.mjs), the card ledger and the
 * checking code itself, and writes one self-contained HTML page: every card transaction, each coin's journey drawn
 * from its exit package (deposits, hand-overs between phones, the exit line), every TEE signature with the key that
 * made it and that key's certificate chain, what the Council signed, and the code that performs each check, quoted
 * from the source files as they are.
 *
 * Usage: node viewer.mjs --dir evidence/2026-10-12 --council evidence/council.json --java verifier/java --contracts contracts
 *        [--standalone] [--out <file>]
 */
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const DIR = arg('dir', 'evidence/2026-10-12');
const EV = JSON.parse(fs.readFileSync(path.join(DIR, 'evidence.json'), 'utf8'));
const LEDGER = JSON.parse(fs.readFileSync(path.join(DIR, 'card-ledger.json'), 'utf8'));
const COUNCIL = JSON.parse(fs.readFileSync(arg('council', 'evidence/council.json'), 'utf8'));
const JAVA = arg('java', 'verifier/java') + '/org/stablescouncil/stables/route2/';
const CONTRACTS = arg('contracts', 'contracts');
const OUT = arg('out', path.join(DIR, 'viewer.html'));
const STANDALONE = process.argv.includes('--standalone');

// The code, quoted as it is: [file, first line, last line] found by their opening text, so a change in the source moves the quote with it.
function quote(file, startText, lines) {
  const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const i = src.findIndex((l) => l.includes(startText));
  if (i < 0) throw new Error('not found in ' + file + ': ' + startText);
  return { file: path.basename(file), from: i + 1, to: Math.min(src.length, i + lines), text: src.slice(i, i + lines).join('\n') };
}
const CODE = [
  { title: 'A signature is checked with the public key, never trusted', plain: 'Every signature in a coin\'s history is checked here: the signed bytes, the signature and the public key of the coin that was spent. ECDSA on the P-256 curve with SHA-256, the scheme the phone\'s secure chip uses.',
    q: quote(JAVA + 'R2Codec.java', 'public static boolean verify(byte[] point,byte[] message,byte[] der)', 3) },
  { title: 'The key was made inside genuine secure hardware', plain: 'Each key comes with a certificate chain written by the phone\'s chip. The chain must end at one of Google\'s attestation roots pinned in the app; every link must be signed by the next; no certificate may be on the revocation list.',
    q: quote(JAVA + 'R2Attestation.java', 'public void verifyChain(List<byte[]> chain)', 12) },
  { title: 'The key can sign once, was generated in the chip, and the phone is locked', plain: 'The leaf certificate describes the key. These lines refuse it unless the hardware itself enforces a usage limit of exactly 1, the key was generated inside the chip, it is a P-256 signing key, the bootloader is locked and the boot is verified (or a pinned GrapheneOS key).',
    q: quote(JAVA + 'R2Attestation.java', 'public Key verifyKey(byte[] leafDer,List<byte[]> chain)', 44) },
  { title: 'Every hand-over is signed by the key of the coin it spends, and nothing is created', plain: 'Walking the history in order: each parent coin must exist, the hand-over must be signed by that coin\'s key, the key must be attested, the currency cannot change, a key never receives again, and what goes out equals what came in.',
    q: quote(JAVA + 'R2Receiver.java', 'for(R2Hop h:b.hops()){', 23) },
  { title: 'The exit line: the Council\'s check before it approves', plain: 'The exiting coin must be in its history and unspent there, never paid away or exited before, with the same currency and amount, its key attested, and the exit line signed by that key.',
    q: quote(JAVA + 'R2Receiver.java', 'public ExitResult checkExit(byte[] pkg,Ledger ledger){', 20) },
];
const KISS = ['r2t3_request.kiss', 'r2t3_vault.kiss', 'r2t3_head.kiss', 'r2t3_copy.kiss', 'r2t3_anchor.kiss'].map((f) => ({ file: f, text: fs.readFileSync(path.join(CONTRACTS, f), 'utf8').trim() }));

// Transactions for the page: findings and packages from the report, inputs/outputs/state from the ledger (the package
// ports 30-39 are left out of the state table: the decoded package stands for them).
const byId = new Map(LEDGER.transactions.map((t) => [t.txpowid, t]));
const txs = EV.results.map((r) => {
  const t = byId.get(r.txpowid) || {};
  const slim = (c) => ({ coinid: c.coinid, address: c.address, role: c.role, amount: c.amount, token: c.tokenid });
  return Object.assign({}, r, { inputs: (t.inputs || []).map(slim), outputs: (t.outputs || []).map(slim),
    state: (t.state || []).filter((s) => Number(s.port) < 30).map((s) => ({ port: Number(s.port), data: String(s.data) })),
    packagePorts: (t.state || []).filter((s) => Number(s.port) >= 30 && Number(s.port) < 40).length });
});
const DATA = { range: EV.ledger, council: COUNCIL, txs, code: CODE, kiss: KISS };

const page = `<title>Stables Card Evidence</title>
<meta name="description" content="Every Stables card transaction on Minima mainnet, its TEE signatures and the Council's checks, made readable.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=Public+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
/* Layout: a ledger on the left (one row per transaction, by block), the selected transaction read on the right; one column on a phone. */
:root{
  --bg:#f3f5f7; --panel:#ffffff; --ink:#14212b; --muted:#5d6b76; --line:#d9e0e6; --soft:#e9eef2;
  --accent:#1c5d8c; --ok:#1d7a4f; --okbg:#e2f3ea; --warn:#9a6400; --warnbg:#fbefd8; --bad:#b3261e; --badbg:#fbe4e2;
  --devA:#2f6fb0; --devAbg:#e3eef9; --devB:#7a4bb3; --devBbg:#efe6f8; --gone:#8a96a0;
  --display:'Bricolage Grotesque',ui-sans-serif,system-ui,sans-serif; --body:'Public Sans',ui-sans-serif,system-ui,sans-serif; --mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --bg:#0f161c; --panel:#16212a; --ink:#e4ebf0; --muted:#97a6b2; --line:#2a3946; --soft:#1d2a35;
  --accent:#6fb1e6; --ok:#5fcf98; --okbg:#173326; --warn:#e3b35a; --warnbg:#33290f; --bad:#f08a82; --badbg:#3a1a18;
  --devA:#79aee6; --devAbg:#18304a; --devB:#bf98ea; --devBbg:#2c2140; --gone:#6f7d88; color-scheme:dark}}
:root[data-theme="dark"]{
  --bg:#0f161c; --panel:#16212a; --ink:#e4ebf0; --muted:#97a6b2; --line:#2a3946; --soft:#1d2a35;
  --accent:#6fb1e6; --ok:#5fcf98; --okbg:#173326; --warn:#e3b35a; --warnbg:#33290f; --bad:#f08a82; --badbg:#3a1a18;
  --devA:#79aee6; --devAbg:#18304a; --devB:#bf98ea; --devBbg:#2c2140; --gone:#6f7d88; color-scheme:dark}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:15px/1.55 var(--body);padding-inline:16px;padding-block:20px 48px}
.wrap{max-width:1180px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
header h1{font:700 clamp(26px,4vw,38px)/1.1 var(--display);margin:0;text-wrap:balance;letter-spacing:-.01em}
header p{margin:6px 0 0;color:var(--muted);max-width:70ch}
.tabs{display:flex;gap:6px;flex-wrap:wrap}
.tabs button{font:600 14px var(--body);color:var(--muted);background:transparent;border:1px solid var(--line);padding:7px 14px;border-radius:999px;cursor:pointer}
.tabs button[aria-selected="true"]{color:var(--panel);background:var(--ink);border-color:var(--ink)}
.tabs button:focus-visible,.row:focus-visible,.hopnode:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.summary{display:flex;flex-wrap:wrap;gap:8px}
.chip{font:500 12.5px var(--body);padding:4px 10px;border-radius:999px;background:var(--soft);color:var(--ink);border:1px solid var(--line);cursor:pointer}
.chip[aria-pressed="true"]{background:var(--ink);color:var(--panel);border-color:var(--ink)}
.grid{display:grid;grid-template-columns:minmax(260px,360px) minmax(0,1fr);gap:16px;align-items:start}
@media (max-width:820px){.grid{grid-template-columns:minmax(0,1fr)}}
.list{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden;max-height:78vh;overflow-y:auto}
.row{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;padding:10px 12px;border-bottom:1px solid var(--line);cursor:pointer;text-align:left;width:100%;background:none;border-left:3px solid transparent;color:inherit;font:inherit}
.row:hover{background:var(--soft)}
.row[aria-current="true"]{background:var(--soft);border-left-color:var(--accent)}
.row .blk{font:500 12px var(--mono);color:var(--muted);grid-row:1/3;padding-top:2px;font-variant-numeric:tabular-nums}
.row .t{font-weight:600;font-size:14px}
.row .k{font-size:12px;color:var(--muted)}
.detail{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px;min-width:0;display:flex;flex-direction:column;gap:16px}
.detail h2{font:700 22px/1.2 var(--display);margin:0;text-wrap:balance}
.meta{font:12.5px var(--mono);color:var(--muted);word-break:break-all}
.sec h3{font:600 12px var(--body);text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 8px}
.findings{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.findings li{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;align-items:start;font-size:14px;overflow-wrap:anywhere}
.tag{font:600 11px var(--mono);padding:2px 6px;border-radius:4px;letter-spacing:.04em}
.tag.PASS{background:var(--okbg);color:var(--ok)} .tag.INFO{background:var(--soft);color:var(--muted)} .tag.FAIL{background:var(--badbg);color:var(--bad)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:12px}
td.mono,.mono{font-family:var(--mono);font-size:12px;overflow-wrap:anywhere}
.hex{font:12px/1.5 var(--mono);background:var(--soft);border-radius:6px;padding:8px 10px;overflow-wrap:anywhere;max-height:9em;overflow-y:auto}
.journey{background:var(--soft);border-radius:8px;padding:10px;overflow-x:auto}
.journey svg{display:block;min-width:560px}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px;color:var(--muted)}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}
.card{border:1px solid var(--line);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px}
.card h4{margin:0;font:600 15px var(--body)}
.pill{display:inline-block;font:600 11.5px var(--body);padding:2px 8px;border-radius:999px}
.pill.ok{background:var(--okbg);color:var(--ok)} .pill.A{background:var(--devAbg);color:var(--devA)} .pill.B{background:var(--devBbg);color:var(--devB)}
.members{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.member{border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:13px}
.member.signed{border-color:var(--ok);background:var(--okbg)}
.member .mono{color:var(--muted)}
.codeblock{display:flex;flex-direction:column;gap:6px}
pre{margin:0;font:12.5px/1.55 var(--mono);background:var(--soft);border-radius:8px;padding:12px;overflow-x:auto;white-space:pre}
.note{font-size:13.5px;color:var(--muted)}
.prose{max-width:75ch;display:flex;flex-direction:column;gap:10px}
details summary{cursor:pointer;font-weight:600;font-size:13.5px}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
<div class="wrap">
  <header>
    <h1>Stables card evidence</h1>
    <p id="lead"></p>
  </header>
  <div class="tabs" role="tablist">
    <button role="tab" id="tab-tx" aria-selected="true">Transactions</button>
    <button role="tab" id="tab-code" aria-selected="false">How the checks work</button>
    <button role="tab" id="tab-contracts" aria-selected="false">Contracts</button>
  </div>
  <section id="view-tx">
    <div class="summary" id="filters"></div>
    <div class="grid" style="margin-top:12px">
      <nav class="list" id="list" aria-label="Card transactions"></nav>
      <article class="detail" id="detail" aria-live="polite"></article>
    </div>
  </section>
  <section id="view-code" hidden><div class="prose" id="code"></div></section>
  <section id="view-contracts" hidden><div class="prose" id="contracts"></div></section>
</div>
<script>
const D = ${JSON.stringify(DATA)};
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
const KIND = {'add':'Add','exit request':'Remove request','council seal':'Council seal','payout':'Payout','council rejection':'Rejection','R2T1 migration':'First vault returned','lab rescue':'Lab rescue'};
const PORTS = {0:'Tag: what this coin is',1:'Card key fingerprint (Add)',2:'Amount (Add)',3:'Currency (Add)',10:'Package fingerprint (SHA-256)',11:'Coin leaving the card',12:'Amount',13:'Currency',14:'Savings address to pay',15:'Change back to the vault',16:'Vault coins spent',17:'Refund atom',20:'Approvals root (Merkle)',21:'Seal period',22:'Council set'};
const pkgCount = D.txs.filter(t => t.package).length;
$('#lead').textContent = 'Every Minima mainnet transaction that touched a Stables card contract between blocks ' + D.range.from + ' and ' + D.range.to + ', ' + D.txs.length + ' in all, checked against the design. ' + pkgCount + ' of them carry a coin\\'s whole history with its TEE signatures; pick one to see it.';

// Filters
const kinds = ['all'].concat([...new Set(D.txs.map(t => t.kind))]);
let filter = 'all', current = null;
function drawFilters(){ $('#filters').innerHTML = kinds.map(k => '<button class="chip" aria-pressed="' + (k===filter) + '" data-k="' + esc(k) + '">' + esc(k==='all'?'All':KIND[k]||k) + ' ' + (k==='all'?D.txs.length:D.txs.filter(t=>t.kind===k).length) + '</button>').join(''); }
$('#filters').addEventListener('click', e => { const b = e.target.closest('button'); if(!b) return; filter = b.dataset.k; drawFilters(); drawList(); });
function drawList(){
  const items = D.txs.map((t,i)=>[t,i]).filter(([t]) => filter==='all' || t.kind===filter);
  $('#list').innerHTML = items.map(([t,i]) => '<button class="row" data-i="' + i + '" aria-current="' + (i===current) + '"><span class="blk">' + t.block + '</span><span class="t">' + esc(t.summary) + '</span><span class="k">' + esc(t.time.slice(0,16).replace('T',' ')) + ' UTC · ' + esc(KIND[t.kind]||t.kind) + (t.package ? ' · ' + t.package.hops.length + ' signed hand-over' + (t.package.hops.length===1?'':'s') : '') + '</span></button>').join('');
}
$('#list').addEventListener('click', e => { const b = e.target.closest('.row'); if(!b) return; current = +b.dataset.i; drawList(); drawDetail(); });

function findings(t){ return '<ul class="findings">' + t.findings.map(f => { const m = /^(PASS|INFO|FAIL): ([\\s\\S]*)$/.exec(f) || [0,'INFO',f]; return '<li><span class="tag ' + m[1] + '">' + m[1] + '</span><span>' + esc(m[2]) + '</span></li>'; }).join('') + '</ul>'; }
function coinsTable(t){
  const rows = (list, side) => list.map(c => '<tr><td>' + side + '</td><td>' + esc(c.role || 'Savings / wallet') + '</td><td class="mono">' + esc(c.amount) + '</td><td class="mono">' + esc(c.coinid || '') + '<br>' + esc(c.address) + '</td></tr>').join('');
  return '<div class="scroll"><table><thead><tr><th></th><th>Where</th><th>Amount</th><th>Coin and address</th></tr></thead><tbody>' + rows(t.inputs,'In') + rows(t.outputs,'Out') + '</tbody></table></div>';
}
function stateTable(t){
  if(!t.state.length && !t.packagePorts) return '';
  return '<div class="scroll"><table><thead><tr><th>Port</th><th>Meaning</th><th>Value kept on chain</th></tr></thead><tbody>' + t.state.map(s => '<tr><td class="mono">' + s.port + '</td><td>' + esc(PORTS[s.port] || (s.port>=100?'Lab rescue amount':'')) + '</td><td class="mono">' + esc(s.data) + '</td></tr>').join('') + (t.packagePorts ? '<tr><td class="mono">30 to ' + (29+t.packagePorts) + '</td><td>The package: exit line and the coin\\'s whole history</td><td>Decoded below</td></tr>' : '') + '</tbody></table></div>';
}

// The coin's journey, drawn from the package: deposits on the left, each hand-over as a step, the exit on the right.
function hashOf(label){ const m = /0x[0-9A-F]+/i.exec(label||''); return m ? m[0].toUpperCase() : ''; }
function journey(p){
  const dev = {}; p.keys.forEach(k => { if(k.keyHash) dev[k.keyHash.toUpperCase()] = k.device; });
  const devOf = (label) => dev[hashOf(label)] || null;
  const col = (d) => d==='device A' ? 'var(--devA)' : d==='device B' ? 'var(--devB)' : 'var(--gone)';
  const coins = {}; // coin id -> {x,y,amount,device}
  const W = 150, H = 54, top = 36;
  let lane = 0;
  p.anchors.forEach((a) => { coins[a.cardCoin.toUpperCase()] = {x:0, y:lane++, amount:a.amount, device:devOf(a.ownerKey), label:'Deposit ' + a.amount}; });
  const steps = [];
  p.hops.forEach((h, i) => {
    const x = i + 1;
    const ys = h.spends.map(s => (coins[s.coin.toUpperCase()]||{y:0}).y);
    const y0 = Math.min.apply(null, ys);
    coins[h.pays.coin.toUpperCase()] = {x, y:y0, amount:h.pays.amount, device:devOf(h.pays.ownerKey)};
    if(h.change){ coins[h.change.coin.toUpperCase()] = {x, y:Math.max(lane, y0+1), amount:h.change.amount, device:devOf(h.change.ownerKey)}; lane = Math.max(lane, y0+2); }
    steps.push({h, x, y0, ys, signer: devOf(h.spends[0].signedBy)});
  });
  const exitCoin = coins[p.exit.exitedCoin.toUpperCase()];
  const cols = p.hops.length + 2, rowsN = Math.max(lane, 1) + 1;
  const vw = cols * W + 40, vh = top + rowsN * H + 20;
  const X = (x) => 30 + x * W, Y = (y) => top + y * H + 20;
  let svg = '<svg viewBox="0 0 ' + vw + ' ' + vh + '" width="' + vw + '" height="' + vh + '" role="img" aria-label="The coin\\'s journey">';
  svg += '<text x="' + X(0) + '" y="18" font-size="11" fill="var(--muted)" font-family="var(--body)">Deposits</text>';
  steps.forEach(s => { svg += '<text x="' + (X(s.x)-12) + '" y="18" font-size="11" fill="var(--muted)" font-family="var(--body)">Hand-over ' + s.h.hop + '</text>'; });
  svg += '<text x="' + (X(cols-1)-12) + '" y="18" font-size="11" fill="var(--muted)" font-family="var(--body)">Exit</text>';
  // edges: parent coin -> child coins of each hop
  steps.forEach(s => {
    s.h.spends.forEach(sp => { const c = coins[sp.coin.toUpperCase()]; if(!c) return;
      [s.h.pays.coin, s.h.change && s.h.change.coin].filter(Boolean).forEach(cid => { const k = coins[cid.toUpperCase()];
        svg += '<path d="M' + (X(c.x)+8) + ' ' + Y(c.y) + ' C ' + (X(c.x)+W*0.6) + ' ' + Y(c.y) + ', ' + (X(k.x)-W*0.6) + ' ' + Y(k.y) + ', ' + (X(k.x)-8) + ' ' + Y(k.y) + '" fill="none" stroke="' + col(s.signer) + '" stroke-width="1.6" opacity=".55"/>'; }); });
  });
  if(exitCoin) svg += '<path d="M' + (X(exitCoin.x)+8) + ' ' + Y(exitCoin.y) + ' L ' + (X(cols-1)-10) + ' ' + Y(exitCoin.y) + '" stroke="var(--ok)" stroke-width="2" fill="none" stroke-dasharray="4 3"/>' +
    '<rect x="' + (X(cols-1)-10) + '" y="' + (Y(exitCoin.y)-14) + '" width="96" height="28" rx="6" fill="var(--okbg)" stroke="var(--ok)"/><text x="' + (X(cols-1)-2) + '" y="' + (Y(exitCoin.y)+4) + '" font-size="12" fill="var(--ok)" font-family="var(--body)" font-weight="600">To Savings ' + esc(p.exit.amount) + '</text>';
  Object.values(coins).forEach(c => {
    svg += '<circle cx="' + X(c.x) + '" cy="' + Y(c.y) + '" r="8" fill="' + col(c.device) + '"/>' +
      '<text x="' + (X(c.x)+13) + '" y="' + (Y(c.y)+4) + '" font-size="11.5" fill="var(--ink)" font-family="var(--mono)">' + esc(c.amount) + '</text>';
  });
  svg += '</svg>';
  return svg;
}
function devPill(label, keys){ const k = keys.find(k => k.keyHash && label && label.toUpperCase().includes(k.keyHash.toUpperCase())); if(!k) return '<span class="pill" style="background:var(--soft);color:var(--muted)">left this history</span>'; return '<span class="pill ' + (k.device==='device A'?'A':'B') + '">' + esc(k.device) + ' · ' + esc(k.os||'') + '</span>'; }
function packageView(p){
  let h = '<div class="sec"><h3>The coin\\'s journey, from its exit package</h3><div class="legend"><span><span class="dot" style="background:var(--devA)"></span>Device A · ' + esc((p.keys.find(k=>k.device==='device A')||{}).os||'') + '</span>' + (p.devices>1 ? '<span><span class="dot" style="background:var(--devB)"></span>Device B · ' + esc((p.keys.find(k=>k.device==='device B')||{}).os||'') + '</span>' : '') + '<span><span class="dot" style="background:var(--gone)"></span>a coin that left this history</span></div><div class="journey" style="margin-top:8px">' + journey(p) + '</div><p class="note">Each dot is a coin, coloured by the phone whose secure chip holds its key. Each line is a hand-over signed by the key of the coin it spends; the key is destroyed by that one signature.</p></div>';
  h += '<div class="sec"><h3>The signatures</h3><div style="display:flex;flex-direction:column;gap:10px">';
  p.hops.forEach(hp => {
    h += '<div class="card"><h4>Hand-over ' + hp.hop + ': ' + esc(hp.conservation) + '</h4>';
    hp.spends.forEach(s => { h += '<div>Spends <span class="mono">' + esc(s.coin) + '</span> (' + esc(s.amount) + '), signed in ' + devPill(s.signedBy, p.keys) + ' <span class="pill ok">' + esc(s.signature.split(' (')[0]) + '</span></div><details><summary>Signature and key</summary><div class="note" style="margin:6px 0 4px">Signature (DER, ECDSA P-256), ' + ((s.signatureDer.length-2)/2) + ' bytes</div><div class="hex">' + esc(s.signatureDer) + '</div><div class="note" style="margin:6px 0 4px">Public key of the coin it spends</div><div class="hex">' + esc(s.signerPublicKey) + '</div></details>'; });
    h += '<div>Pays <b>' + esc(hp.pays.amount) + '</b> to a new coin in ' + devPill(hp.pays.ownerKey, p.keys) + (hp.change ? '; change <b>' + esc(hp.change.amount) + '</b> in ' + devPill(hp.change.ownerKey, p.keys) : '') + '</div><details><summary>Signed bytes (' + hp.bodyBytes + ')</summary><div class="hex">' + esc(hp.bodyHex) + '</div></details></div>';
  });
  h += '<div class="card"><h4>Exit line: ' + esc(p.exit.amount) + ' to Savings</h4><div>Signed by the leaving coin\\'s key in ' + devPill(p.exit.signedBy, p.keys) + ' <span class="pill ok">' + esc(p.exit.signature.split(' (')[0]) + '</span></div><div class="mono">Pays to ' + esc(p.exit.payout) + '</div><details><summary>Exit line (126 bytes), signature and key</summary><div class="hex">' + esc(p.exit.bodyHex) + '</div><div class="note" style="margin:6px 0 4px">Signature</div><div class="hex">' + esc(p.exit.signatureDer) + '</div><div class="note" style="margin:6px 0 4px">Public key</div><div class="hex">' + esc(p.exit.signerPublicKey||'') + '</div></details></div></div></div>';
  h += '<div class="sec"><h3>The keys and their certificates (' + p.keys.length + ')</h3><div class="scroll"><table><thead><tr><th>Key fingerprint</th><th>Phone</th><th>Chip</th><th>Boot</th><th>Certificate chain</th></tr></thead><tbody>' + p.keys.map(k => '<tr><td class="mono">' + esc(k.keyHash||'') + '</td><td>' + devPill(k.keyHash, p.keys) + '</td><td>' + esc(k.securityLevel||'') + '</td><td>' + esc(k.bootState||'') + '</td><td><details><summary>' + (String(k.attestation).startsWith('accepted') ? 'Reaches a Google root' : esc(k.attestation)) + '</summary><ol style="margin:6px 0 0;padding-left:18px">' + (k.chain||[]).map(c => '<li class="mono">' + esc(c.subject) + '</li>').join('') + '</ol><ul style="margin:6px 0 0;padding-left:18px">' + (k.rules||[]).map(r => '<li>' + esc(r) + '</li>').join('') + '</ul></details></td></tr>').join('') + '</tbody></table></div></div>';
  return h;
}
function sealView(t){
  const signed = new Set(t.findings.join(' ').match(/member \\d/g) || []);
  return '<div class="sec"><h3>The Council (quorum ' + D.council.quorum + ' of ' + D.council.members.length + ')</h3><div class="members">' + D.council.members.map(m => '<div class="member' + (signed.has('member ' + m.member) ? ' signed' : '') + '"><b>Member ' + m.member + '</b> ' + (signed.has('member ' + m.member) ? '<span class="pill ok">signed</span>' : '') + '<div class="mono">' + esc(m.publickey) + '</div></div>').join('') + '</div><p class="note">' + esc(D.council.note) + '</p></div>';
}
function drawDetail(){
  const t = D.txs[current]; if(!t){ $('#detail').innerHTML = '<p class="note">Pick a transaction on the left.</p>'; return; }
  let h = '<div><h2>' + esc(t.summary) + '</h2><div class="meta">Block ' + t.block + ' · ' + esc(t.time.slice(0,19).replace('T',' ')) + ' UTC<br>TxPoW ' + esc(t.txpowid) + '</div></div>';
  h += '<div class="sec"><h3>Checks against the design</h3>' + findings(t) + '</div>';
  if(t.package) h += packageView(t.package);
  if(t.kind === 'council seal' || t.kind === 'council rejection') h += sealView(t);
  h += '<div class="sec"><h3>What went in and out</h3>' + coinsTable(t) + '</div>';
  const st = stateTable(t); if(st) h += '<div class="sec"><h3>Values kept on chain</h3>' + st + '</div>';
  $('#detail').innerHTML = h;
}

// The code, in plain words
$('#code').innerHTML = '<p>These are the lines that make every check on this page, quoted from the Stables card\\'s own code. The receiving phone runs them before it credits a payment, and the Council runs them before it approves a Remove.</p>' +
  D.code.map(c => '<div class="codeblock"><h3 style="font:700 19px/1.25 var(--display);margin:14px 0 0">' + esc(c.title) + '</h3><p class="note" style="margin:0">' + esc(c.plain) + '</p><div class="note mono">' + esc(c.q.file) + ', lines ' + c.q.from + ' to ' + c.q.to + '</div><pre>' + esc(c.q.text) + '</pre></div>').join('');
$('#contracts').innerHTML = '<p>The rules on chain, in Minima\\'s contract language (KISS). Placeholders such as <span class="mono">$K1</span> are filled with the real keys and addresses when the contracts are made; each raw transaction carries the exact scripts it ran.</p><p>The request: the Council (5 of 7) may spend it at any time, which is how it rejects. Otherwise it pays only the amount to the address named, with a refund atom; after 20 blocks it pays without approval; before that it needs a seal copy and a Merkle proof that the Council approved this request.</p>' +
  D.kiss.map(k => '<div class="codeblock"><div class="note mono" style="margin-top:10px">' + esc(k.file) + '</div><pre>' + esc(k.text) + '</pre></div>').join('');

// Tabs
const tabs = {tx:'#view-tx', code:'#view-code', contracts:'#view-contracts'};
function show(name){ Object.entries(tabs).forEach(([k,s]) => { $(s).hidden = k!==name; $('#tab-'+k).setAttribute('aria-selected', k===name); }); }
Object.keys(tabs).forEach(k => $('#tab-'+k).addEventListener('click', () => show(k)));
if(['code','contracts'].includes(location.hash.slice(1))) show(location.hash.slice(1));

// Open on the clearest case: the exit whose coin went through both phones.
current = D.txs.findIndex(t => t.package && t.package.devices > 1 && /0\\.0298/.test(t.summary));
if(current < 0) current = D.txs.findIndex(t => t.package);
drawFilters(); drawList(); drawDetail();
</script>`;

const html = STANDALONE ? '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' + page.replace('<div class="wrap">', '</head><body>\n<div class="wrap">') + '\n</body></html>\n' : page;
fs.writeFileSync(OUT, html);
console.log('wrote ' + OUT + ' (' + Math.round(html.length / 1024) + ' KB)');
