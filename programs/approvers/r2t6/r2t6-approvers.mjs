// The R2T6 approvers' program (R2T6_PLAN step 4, written 2026-11-04; testing phase, version 0.2.0-test), beside the
// node that holds this machine's approver keys. The 11 keys are on three machines (r2t6-keys/keys-public.json): one
// runs as the proposer (the VPS), the others as signers (stables-approver-3, this PC). Every 30 s, one pass:
//   1. check every new exit request and contested coin (R2Checker, the app's own verifier, --gen R2T6);
//   2. seal (proposer) when an approval or rejection is new, and at least every heartbeat interval; the seal is signed
//      across the machines (../cosign/): this machine's keys, then each peer checks it on its own node and adds its
//      own, until 7;
//   3. turn each refused request into a contested coin (no signature: the proof in the sealed rejected list);
//   4. post the final rejection of a contested coin rejected again once it is refusalOverrule blocks old;
//   5. pay approved requests from their ring slot once payable, one per copy and one per exit-record shard;
//   6. clean each copy given back large by 3 to 5 (copyLoneClean), so every seal carries clean copies;
//   7. publish the exit lists (exit-lists.json): anyone can rebuild every record root from them;
//   8. (proposer) answer phones' requests for fresh R2T6 deposit proofs at the proof post box (no key).
// A signer only checks requests and answers seal proposals (r2t6-tx.mjs and cosign.mjs say what it signs). The
// approvers never post a fallback payout, never pay a contested coin (that takes 5 guardian signatures) and never
// propose a key change from here (a later version, with the owner's listed change).
//   node r2t6-approvers.mjs watch [--once]
//   node r2t6-approvers.mjs check <coin id>
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { r2t6, listLeaves } from './r2t6-tx.mjs';

const WIN = process.platform === 'win32';
const env = (k, d) => process.env['R2T6_' + k] ?? d;
const GEN_DIR = env('GENERATION');                   // the deployment campaign's folder: generation.json
const EVID = env('EVID');                            // this machine's state, log and exit lists
const GUARD = env('GUARD');                          // this machine's WOTS journal (never restored from an old copy)
const NODE = Number(env('NODE', 9005));
const ROLE = JSON.parse(fs.readFileSync(env('COSIGN'), 'utf8'));   // { role, myKeys, peers | listen, maxHeartbeatAge }
const JAVA = env('JAVA', WIN ? 'C:/Program Files/Eclipse Adoptium/jdk-17.0.18.8-hotspot/bin/java.exe' : 'java');
const JAVAC = env('JAVAC', WIN ? 'C:/Program Files/Eclipse Adoptium/jdk-17.0.18.8-hotspot/bin/javac.exe' : 'javac');
const JAR = env('MINIMA_JAR');
const CHECKER = env('CHECKER_CLASSES');
const STATUS = env('STATUS');                        // attestation-status.json (revoked device keys)
const RECORD_TOOL = env('RECORD_TOOL');              // RecordTree.java
// How many copies given back by payouts or refusals a seal can carry and stay under 90% of the TxPoW limit
// (test/r2t6-tx.test.mjs measures it: 1 with the R2T6 contracts of 2026-11-04). More waits for a seal first.
const MAX_LARGE_COPIES = Number(env('MAX_LARGE_COPIES', 1));
// Rehearsal only (R2T6_PLAN step 8): request ids this machine leaves undecided, as a silent or censoring approver would,
// so the guardians' 3-day fallback can be rehearsed. Empty unless set; never set before real money.
const IGNORE = new Set(String(env('IGNORE', '')).split(',').filter(Boolean).map(x => x.toUpperCase()));
if (!GEN_DIR || !EVID || !GUARD || !JAR) throw new Error('Set R2T6_GENERATION, R2T6_EVID, R2T6_GUARD, R2T6_MINIMA_JAR and R2T6_COSIGN');
if (!['proposer', 'signer'].includes(ROLE.role) || !ROLE.myKeys?.length) throw new Error('R2T6_COSIGN: role proposer or signer, and myKeys');
const PHASE = process.argv[2];
const SEP = WIN ? ';' : ':';

const json = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const G = json(path.join(GEN_DIR, 'generation.json'));   // contracts, public keys, tokens, config (as R2T5's)
const cfg = G.config, S = G.contracts, K = G.keys, T = r2t6(G, cfg), H = cfg.hardening;
if (cfg.generation.name !== 'R2T6') throw new Error('not an R2T6 generation');
for (const k of ROLE.myKeys) if (!K.council.some(x => same(x, k))) throw new Error('R2T6_COSIGN names a key that is not an R2T6 approver key: ' + k.slice(0, 12));
const STATE = path.join(EVID, 'approvers-state.json');
const sha = x => createHash('sha256').update(x).digest('hex').toUpperCase();
const now = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const write = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2)); fs.renameSync(f + '.tmp', f); };
function same(a, b) { return String(a).toUpperCase() === String(b).toUpperCase(); }
const atoms = s => { const [a, b = ''] = String(s).split('.'); return BigInt(a) * 100000000n + BigInt(b.padEnd(8, '0').slice(0, 8)); };
const decimal = n => { const t = (n % 100000000n).toString().padStart(8, '0').replace(/0+$/, ''); return (n / 100000000n) + (t ? '.' + t : ''); };
const stateOf = c => Object.fromEntries((c.state || []).map(p => [String(p.port), p.data]));
function log(event, data = {}) { fs.mkdirSync(EVID, { recursive: true }); const e = { at: now(), event, ...data }; fs.appendFileSync(path.join(EVID, 'approvers-log.jsonl'), JSON.stringify(e) + '\n'); console.log(e.at, event, JSON.stringify(data).slice(0, 300)); }
let st = fs.existsSync(STATE) ? json(STATE) : { decided: {}, lists: {}, pending: {}, paid: {}, records: {}, cosigned: {} };
if (!Object.keys(st.records).length && G.records) st.records = JSON.parse(JSON.stringify(G.records));
const save = () => write(STATE, st);

/* ---------- RPC (a fixed recipe: anything else is refused before it reaches the node) ---------- */
const READS = new Set(['status', 'coins', 'txpow', 'mmrcreate', 'keys', 'coinexport']);   // coinexport: proofs for phones (post box)
const WRITES = new Set(['newscript', 'txncreate', 'txninput', 'txnoutput', 'txnstate', 'txnsign', 'txnbasics', 'txncheck', 'txnexport', 'txnimport', 'txnlist', 'txndelete', 'txnpost']);
async function rpc(command, allowFail = false) {
  const verb = command.trim().split(/\s/)[0];
  if (!READS.has(verb) && !WRITES.has(verb)) throw new Error('Command outside recipe: ' + verb);
  if (verb === 'keys' && command !== 'keys') throw new Error('Key command refused');
  if (verb === 'txnsign' && /publickey:auto/.test(command)) throw new Error('The approvers sign with their own keys only');
  if (verb === 'txnpost' && ROLE.role !== 'proposer') throw new Error('A signer never posts');
  const body = Buffer.from(command);
  const head = Buffer.from(`POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
  const r = await new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port: NODE }), chunks = [];
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('RPC timeout')); }, 180000);
    sock.on('connect', () => { sock.write(head); sock.end(body); }); sock.on('data', c => chunks.push(c));
    sock.on('error', e => { clearTimeout(timer); reject(e); });
    sock.on('close', () => { clearTimeout(timer); try { const t = Buffer.concat(chunks).toString(); resolve(JSON.parse(t.slice(t.indexOf('{')).trim())); } catch (e) { reject(e); } });
  });
  if (!r.status && !allowFail) throw new Error('RPC refused ' + verb + ': ' + r.error);
  return r;
}
const rpcR = async c => (await rpc(c)).response;
const tip = async () => Number((await rpc('status')).response.chain.block);
async function unspentAt(address) { return (await rpc('coins address:' + address)).response.filter(c => same(c.address, address) && !c.spent); }
async function coinOn(id) { return (await rpc('coins coinid:' + id)).response.find(c => same(c.coinid, id)) || null; }

/* ---------- WOTS write-ahead guard (as R2T5: a key whose use count went back is never used) ---------- */
function guardEntries() { return fs.existsSync(GUARD) ? fs.readFileSync(GUARD, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []; }
function guardCheck() { let prev = '0'.repeat(64); for (const e of guardEntries()) { const { hash, ...b } = e; if (b.prev !== prev || sha(JSON.stringify(b)).toLowerCase() !== hash) throw new Error('WOTS guard journal broken'); prev = hash; } return prev; }
function guardAppend(e) { const body = { ...e, at: now(), prev: guardCheck() }; body.hash = sha(JSON.stringify(body)).toLowerCase(); fs.mkdirSync(path.dirname(GUARD), { recursive: true }); const fd = fs.openSync(GUARD, 'a'); fs.writeSync(fd, JSON.stringify(body) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); }
function guardFloor(pub) { let f = 0; for (const e of guardEntries()) if (e.publickey && same(e.publickey, pub)) f = Math.max(f, e.kind === 'reserve' ? e.uses + 1 : e.uses); return f; }
async function keyUses(pub) { const k = (await rpc('keys')).response.keys.find(x => same(x.publickey, pub)); if (!k) throw new Error('approver key not on this node'); return Number(k.uses); }
const guard = { guardedSign: async ({ pub, txn, purpose, sign }) => {
  const before = await keyUses(pub), floor = guardFloor(pub);
  if (before < floor) throw new Error(`WOTS guard: key ${pub.slice(0, 10)} at ${before} uses, below the journal floor ${floor}`);
  guardAppend({ kind: 'reserve', run: 'R2T6', publickey: pub, uses: before, txn, purpose });
  await sign();
  const after = await keyUses(pub);
  if (after <= before) throw new Error('WOTS guard: use count did not advance');
  guardAppend({ kind: 'signed', run: 'R2T6', publickey: pub, uses: after, txn, purpose });
  return { before, after, floor };
} };

/* ---------- transactions: built, checked before any key signs, size-checked, posted ---------- */
const TXPOW_LIMIT = 65536, TXPOW_MARGIN = 2500, SIGNATURE_BYTES = 4250;
// D136 (founder, 2026-11-07, register row 41): warn from 90% of the TxPoW limit, hold a seal above 92% until a person
// looks. The TxPoW on chain is about 940 bytes more than the transaction export.
const TXPOW_OVERHEAD = 940, SIZE_WARN = 0.90, SIZE_HOLD = 0.92;
const SIZE_RELEASE = () => path.join(EVID, 'size-hold-release.txt');   // seal numbers a person released, one per line
const sizeHoldReleased = n => { try { return fs.readFileSync(SIZE_RELEASE(), 'utf8').split(/\s+/).includes(String(n)); } catch { return false; } };
// R2T6_ALERT_CMD: an executable given the message as its one argument (for example a script that messages the
// founder). Unset, an alert is only a log line, and says so.
const ALERT_CMD = env('ALERT_CMD');
function alert(message) {
  if (!ALERT_CMD) { log('alert (no R2T6_ALERT_CMD set: log only)', { message }); return; }
  const r = spawnSync(ALERT_CMD, [message], { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) log('alert command failed', { message, status: r.status, error: (r.stderr || String(r.error || '')).slice(0, 200) });
}
async function exportedBytes(id) { const r = await rpc('txnexport id:' + id), d = r.response?.data ?? r.response; return typeof d === 'string' && /^0x[0-9A-F]+$/i.test(d) ? (d.length - 2) / 2 : 0; }
let signingHalted = false;
async function buildCheck(id, t, sign, signatures = 0) {
  await rpc('txndelete id:' + id, true);
  await rpc('txncreate id:' + id);
  for (const c of t.inputs) await rpc(`txninput id:${id} coinid:${c}`);
  for (const o of t.outputs) await rpc(`txnoutput id:${id} amount:${o.amount} address:${o.address} tokenid:${o.tokenid} storestate:${o.storestate}`);
  for (const [p, v] of Object.entries(t.state || {})) await rpc(`txnstate id:${id} port:${p} value:${v}`);
  await rpc('txnbasics id:' + id);   // once: the coin proofs go in a single time
  if (sign && signatures) {
    const expected = (await exportedBytes(id)) + signatures * SIGNATURE_BYTES;
    if (expected > TXPOW_LIMIT - TXPOW_MARGIN) { await rpc('txndelete id:' + id, true); return { ok: false, tooLarge: true, bytes: expected, valid: {} }; }
    // D136 (founder, 2026-11-07): above 92% of the limit a seal is held before any key signs, until a person looks and
    // writes its number into size-hold-release.txt. The TxPoW is about 940 bytes more than the export (register row 41).
    const number = String(t.state?.[21] ?? '');
    if (expected + TXPOW_OVERHEAD > SIZE_HOLD * TXPOW_LIMIT && !sizeHoldReleased(number)) {
      await rpc('txndelete id:' + id, true); return { ok: false, held: true, number, bytes: expected + TXPOW_OVERHEAD, valid: {} };
    }
  }
  if (sign) {
    if (signingHalted) { await rpc('txndelete id:' + id, true); return { ok: false, halted: true, valid: {} }; }
    const pre = (await rpc('txncheck id:' + id)).response.valid || {};
    if (!(pre.basic && pre.mmrproofs)) { await rpc('txndelete id:' + id, true); return { ok: false, unsignedInvalid: true, valid: pre }; }
    await sign(id);
  }
  const v = (await rpc('txncheck id:' + id)).response.valid || {};
  const ok = !!(v.basic && v.signatures && v.mmrproofs && v.scripts);
  if (sign && !ok) { signingHalted = true; log('SIGNING HALTED: a signed transaction failed its check; nothing more is signed until restarted', { txn: id, valid: v }); }
  return { ok, valid: v, bytes: await exportedBytes(id) };
}
async function post(id, label, checked) {
  if (checked.tooLarge) throw Object.assign(new Error(`${label} would be about ${checked.bytes} bytes, over the TxPoW limit; not signed, not posted`), { tooLarge: true });
  if (!checked.ok) { await rpc('txndelete id:' + id, true); throw new Error(label + ' validators: ' + JSON.stringify(checked.valid)); }
  if (checked.bytes > TXPOW_LIMIT - 512) { await rpc('txndelete id:' + id, true); throw new Error(`${label} is ${checked.bytes} bytes, over the TxPoW limit; not posted`); }
  const posted = (await rpc(`txnpost id:${id} txndelete:true`)).response, txn = posted.body.txn;
  // The TxPoW on chain is about 940 bytes more than the transaction export (register row 41, 2026-11-07): the size
  // warning reads the TxPoW's own size when the node gives it. 88%: routine 7-signature seals are near it (founder's
  // yes, 2026-11-07); 92%: one more signature or proof away from a refused seal and a stopped heartbeat.
  const txpowBytes = Number(posted.size) > 0 ? Number(posted.size) : checked.bytes + TXPOW_OVERHEAD, share = txpowBytes / TXPOW_LIMIT;
  log('posted', { label, transactionid: txn.transactionid, firstOutput: txn.outputs[0].coinid, bytes: checked.bytes, txpowBytes });
  // D136: a warning from 90% (sent to the alert command too); above 92% a seal only gets here once a person released it.
  if (share >= SIZE_WARN) { const m = `${label}: TxPoW at ${(share * 100).toFixed(1)}% of the limit`; log('size warning: ' + m, { label, txpowBytes }); alert('R2T6 approvers, size warning: ' + m); }
  return txn.outputs[0].coinid;
}

/* ---------- the exit record (as R2T5) ---------- */
function recordTree(spec) {
  const build = path.join(EVID, 'tools');
  if (!fs.existsSync(path.join(build, 'RecordTree.class'))) {
    fs.mkdirSync(build, { recursive: true });
    const c = spawnSync(JAVAC, ['-cp', JAR, '-d', build, RECORD_TOOL], { encoding: 'utf8' });
    if (c.status !== 0) throw new Error('RecordTree compile: ' + c.stderr);
  }
  const f = path.join(build, 'spec.json'); fs.writeFileSync(f, JSON.stringify(spec));
  const r = spawnSync(JAVA, ['-cp', JAR + SEP + build, 'RecordTree', f], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('RecordTree: ' + r.stderr);
  return JSON.parse(r.stdout);
}
const keyOf = card => '0x' + card.replace(/^0x/i, '').slice(0, 32).toUpperCase();
const shardOf = card => Math.floor(parseInt(card.replace(/^0x/i, '').slice(0, 2), 16) / (256 / cfg.exitRecord.shardsPerToken));
const tokenName = id => Object.keys(G.tokens).find(k => same(G.tokens[k], id));
function recordKeys(name, shard) { const t = (st.records[name] = st.records[name] || {}); return (t[shard] = t[shard] || { keys: [] }); }
function syncRecord(name, shard, recRoot) {
  const r = recordKeys(name, shard), depth = cfg.exitRecord.depth;
  if (r.pending) {
    if (same(recordTree({ depth, keys: [...r.keys, r.pending.key] }).root, recRoot)) { r.keys.push(r.pending.key); delete r.pending; save(); publish(); return true; }
  }
  if (same(recordTree({ depth, keys: r.keys }).root, recRoot)) return true;
  log('exit record out of step', { token: name, shard, chainRoot: recRoot, keys: r.keys.length });
  return false;
}
function publish() {
  const lists = {};
  for (const [name, shards] of Object.entries(st.records)) for (const [shard, r] of Object.entries(shards)) (lists[name] = lists[name] || {})[shard] = r.keys;
  write(path.join(EVID, 'exit-lists.json'), { generation: 'R2T6', record: S.record.address, depth: cfg.exitRecord.depth, keyBytes: 16, updated: now(),
    note: 'Paid card coins per token and shard, in insertion order. Slot 0 is the sentinel; RecordTree.java rebuilds each record root.', lists });
}

/* ---------- checking ---------- */
const R2T1_VAULT = '0x78A7881E711158B9E3AECCB026223822D401440B864218E106122DC18B5CC7F0';   // as R2T5: older deposits the checker knows
function check(coinId, address) {
  if (!CHECKER) throw new Error('Set R2T6_CHECKER_CLASSES (checker/build.sh output, with R2T6 support)');
  const exited = Object.values(st.paid).map(v => v.coinId).filter(Boolean).map(x => x.toLowerCase());
  const r = spawnSync(JAVA, ['-cp', JAR + SEP + CHECKER, 'org.stablescouncil.stables.route2.R2Checker', '--rpc', String(NODE), '--request', coinId,
    '--reqaddr', address, '--anchor', S.anchor.address, '--vault', S.vault.address, '--r2t1', R2T1_VAULT, '--gen', cfg.generation.tag,
    '--status', STATUS, '--exited', exited.join(','), '--seen', path.join(EVID, 'seen-hops.txt')], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('Checker failed: ' + r.stderr.slice(0, 400));
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

/* ---------- one pass ---------- */
const isLarge = c => T.isLarge(stateOf(c));   // given back by a payout, refusal or final rejection, not yet cleaned
/* Cleaning (hardening.copyLoneClean): each large copy alone, once, back to itself with only its pinned ports (no key;
   anyone may). Done after each exit and before a seal, so a seal carries clean copies (73% of the limit, not 110%). */
const cleanFailedAt = {};   // a copy whose cleaning failed is tried again after 10 minutes, not every pass
async function cleanCopies(list, t) {
  let n = 0;
  for (const copy of list) {
    if (!isLarge(copy) || st.pending['clean' + copy.coinid] || Date.now() - (cleanFailedAt[copy.coinid] || 0) < 600000) continue;
    const tx = 'r2t6_clean_' + copy.coinid.slice(2, 10);
    const c = await buildCheck(tx, T.cleanTx(copy, stateOf(copy)));
    try { st.pending['clean' + copy.coinid] = { firstOutput: await post(tx, 'clean-' + copy.coinid.slice(2, 10), c), tip: t, copy: copy.coinid }; save(); n++; }
    catch (e) { cleanFailedAt[copy.coinid] = Date.now(); log('copy not cleaned', { copy: copy.coinid, error: e.message }); }
  }
  return n;
}
async function mmr(ids, tag) {
  const r = (await rpc(`mmrcreate nodes:${JSON.stringify(listLeaves(ids, tag))}`)).response;
  return { root: r.root.data, proofs: Object.fromEntries(ids.map((id, i) => [String(id).toUpperCase(), r.nodes[i].proof])) };
}
const noRecordSaid = new Set();   // payouts waiting on a record coin this node cannot see, already logged
const HEARTBEAT_EVERY = Math.min(cfg.council.heartbeatEveryBlocks, 216);   // smaller seals: young coins, short proofs (R2T5 seal 20)

async function pass() {
  const t = await tip();
  const reqs = await unspentAt(S.request.address), conts = await unspentAt(S.contested.address);
  const head = (await unspentAt(S.head.address)).find(c => same(c.tokenid, K.sealToken));
  const copies = (await unspentAt(S.copy.address)).filter(c => same(c.tokenid, K.sealToken));
  if (!head) { log('seal head not visible'); return; }
  const hp = stateOf(head);
  for (const [k, p] of Object.entries(st.pending)) {   // our posts that never landed are forgotten after 10 blocks, then retried
    const landed = await coinOn(p.firstOutput);
    if (landed && Number(landed.created) > 0) {
      if (p.record) { const r = recordKeys(p.record[0], p.record[1]); if (r.pending) { r.keys.push(r.pending.key); delete r.pending; publish(); } }
      delete st.pending[k]; continue;
    }
    if (t - p.tip > 10) { log('post did not land, will retry', { what: k }); delete st.pending[k]; if (p.record) delete recordKeys(p.record[0], p.record[1]).pending; if (k.startsWith('pay')) delete st.paid[k.slice(3)]; }
  }
  save();

  // 1. Check every new request and contested coin.
  for (const q of [...reqs, ...conts]) {
    if (st.decided[q.coinid]) continue;
    if (IGNORE.has(String(q.coinid).toUpperCase())) { if (!st.ignored?.[q.coinid]) { (st.ignored ||= {})[q.coinid] = now(); log('left undecided (R2T6_IGNORE, rehearsal)', { coin: q.coinid }); save(); } continue; }
    let v;
    try { v = check(q.coinid, q.address); } catch (e) { log('not checked', { coin: q.coinid, error: e.message.slice(0, 200) }); continue; }
    if (v.verdict === 'reject' && /confirmations, needs|package-missing/.test((v.detail || '') + (v.code || '')) && t - Number(q.created) <= 10) continue;
    st.decided[q.coinid] = { ...v, at: now(), block: Number(q.created), contested: same(q.address, S.contested.address) }; save();
    log('checked', { coin: q.coinid, contested: st.decided[q.coinid].contested, verdict: v.verdict, code: v.code, amount: v.amount });
  }
  if (ROLE.role === 'signer') return;
  const open = [...reqs, ...conts].filter(q => st.decided[q.coinid]);
  const approve = open.filter(q => st.decided[q.coinid].verdict === 'approve').map(q => q.coinid).sort();
  const reject = open.filter(q => st.decided[q.coinid].verdict === 'reject').map(q => q.coinid).sort();

  // 2. Seal: a new verdict or the heartbeat. All copies free (the head takes them all) and clean (cleaned first).
  const listOf = root => st.lists[String(root).toUpperCase()];
  const inList = (root, ids) => { const L = listOf(root); return !!L && ids.every(x => L.ids.some(y => same(x, y))); };
  const fresh = !inList(hp[20], approve) || !inList(hp[26], reject);
  const newReject = !inList(hp[26], reject);
  const due = t - Number(hp[23]) >= HEARTBEAT_EVERY;
  const large = copies.filter(isLarge).length;
  // Without copyLoneClean only a seal cleans: then a seal is due once MAX_LARGE_COPIES are large and an exit waits.
  const exitWaits = reqs.some(q => (inList(hp[26], [q.coinid]) && st.decided[q.coinid]?.verdict === 'reject') || (st.decided[q.coinid]?.verdict === 'approve' && !st.paid[q.coinid]));
  const cleaning = !H.copyLoneClean && large >= MAX_LARGE_COPIES && exitWaits;
  // The ring keeps 3 lists: a seal for a new approval alone waits while it would push out the oldest slot still holding
  // an unpaid approval (the heartbeat, a rejection or cleaning still seal; the approval is in every newer slot too).
  const evicted = listOf(hp[120 + T.RING - 1]);
  const evictsUnpaid = !!evicted && evicted.ids.some(x => reqs.some(q => same(q.coinid, x)) && !st.paid[x]);
  if (fresh || due || cleaning) {
    if (fresh && !due && !newReject && !cleaning && evictsUnpaid) {
      if (!st.holdLogged) { log('new approval waits: sealing now would push an unpaid approval\'s slot out of the ring', {}); st.holdLogged = true; save(); }
    } else {
      st.holdLogged = false;
      if (st.pending.seal) { log('waiting for the seal', {}); return; }
      if (copies.length !== cfg.council.sealCopies) { log('seal copies busy, sealing next pass', { free: copies.length }); return; }
      if (Object.values(st.pending).some(p => p.copy)) { log('seal waits for copies in flight', {}); return; }
      if (H.copyLoneClean && large) { const n = await cleanCopies(copies, t); if (n) { log('cleaning copies before the seal', { posted: n }); return; } }
      const a = await mmr(approve, 'a' + hp[21]), r = await mmr(reject, 'r' + hp[21]);
      const state = T.sealState(hp, a.root, r.root, t);
      const id = 'r2t6_seal';
      const c = await buildCheck(id, T.sealTx(head, copies, state), i => cosignSeal(i, state[21], approve, reject), cfg.council.quorum);
      if (c.tooLarge) {
        if (!st.tooLargeSaidAt || Date.now() - st.tooLargeSaidAt > 30 * 60000) { log('seal too large: not signed, not posted', { number: state[21], bytes: c.bytes, largeCopies: large }); st.tooLargeSaidAt = Date.now(); save(); }
        return;
      }
      if (c.held) {
        // Nothing signed. The heartbeat waits too: a person must look within the heartbeat slack (72 blocks, about an
        // hour) or the fallback clock and succession start counting. Said once per seal number.
        if (st.sizeHeldSaid !== c.number) {
          st.sizeHeldSaid = c.number; save();
          const m = `seal ${c.number} held: about ${c.bytes} bytes, ${(c.bytes / TXPOW_LIMIT * 100).toFixed(1)}% of the TxPoW limit (D136 hold above 92%). Nothing signed. To post it as it is, add ${c.number} to ${SIZE_RELEASE()}. The heartbeat waits: look by block ${t + Number(cfg.council.heartbeatSlackBlocks || 72)} (the ${cfg.council.heartbeatSlackBlocks || 72}-block slack, about an hour), or the fallback clock and succession start counting.`;
          log('size hold: ' + m, { number: c.number, bytes: c.bytes }); alert('R2T6 approvers, URGENT: ' + m);
        }
        return;
      }
      st.tooLargeSaidAt = 0;
      st.pending.seal ={ firstOutput: await post(id, 'seal-' + state[21], c), tip: t };
      st.lists[a.root.toUpperCase()] = { ids: approve, proofs: a.proofs, number: state[21], at: t };
      st.lists[r.root.toUpperCase()] = { ids: reject, proofs: r.proofs, number: state[21], at: t };
      // Keep only the lists the ring and the rejected root still name, after this seal.
      const keep = new Set([state[26], ...Array.from({ length: T.RING }, (_, i) => state[120 + i])].map(x => String(x).toUpperCase()));
      for (const k of Object.keys(st.lists)) if (!keep.has(k)) delete st.lists[k];
      save(); log('sealed', { number: state[21], approve: approve.length, reject: reject.length, heartbeat: due, cleaning, largeCopies: large });
      return;
    }
  }
  if (hp[27] !== '0') { log('frozen: nothing is paid or refused', {}); return; }
  let free = copies.filter(c => !Object.values(st.pending).some(p => p.copy && same(p.copy, c.coinid)));
  // Each exit below gives back one large copy. With copyLoneClean they are cleaned before any seal, so no limit here.
  let budget = H.copyLoneClean ? Infinity : Math.max(0, MAX_LARGE_COPIES - large);
  const takeCopy = () => { const i = free.findIndex(isLarge); return i >= 0 ? free.splice(i, 1)[0] : (budget-- > 0 ? free.shift() : null); };
  const rejected = listOf(hp[26]);

  // 3. Refusals: a request in the sealed rejected list becomes a contested coin (no signature).
  for (const rc of reqs) {
    if (!rejected || !rejected.ids.some(x => same(x, rc.coinid)) || st.pending['ref' + rc.coinid]) continue;
    const copy = takeCopy(); if (!copy) break;
    const tx = 'r2t6_ref_' + rc.coinid.slice(2, 10);
    const c = await buildCheck(tx, T.refusalTx(rc, stateOf(rc), copy, stateOf(copy), rejected.proofs[rc.coinid.toUpperCase()]));
    try { st.pending['ref' + rc.coinid] = { firstOutput: await post(tx, 'refusal-' + rc.coinid.slice(2, 10), c), tip: t, copy: copy.coinid }; save(); }
    catch (e) { log('refusal not posted', { request: rc.coinid, error: e.message }); }
  }

  // 4. Final rejections: a contested coin rejected again by its own id, once refusalOverrule blocks old.
  for (const cc of conts) {
    if (!rejected || !rejected.ids.some(x => same(x, cc.coinid)) || st.pending['fin' + cc.coinid] || t < T.finalRejectFrom(cc)) continue;
    const copy = takeCopy(); if (!copy) break;
    const tx = 'r2t6_fin_' + cc.coinid.slice(2, 10);
    const c = await buildCheck(tx, T.finalRejectTx(cc, stateOf(cc), copy, stateOf(copy), rejected.proofs[cc.coinid.toUpperCase()]));
    try { st.pending['fin' + cc.coinid] = { firstOutput: await post(tx, 'final-rejection-' + cc.coinid.slice(2, 10), c), tip: t, copy: copy.coinid }; save(); log('final rejection', { contested: cc.coinid }); }
    catch (e) { log('final rejection not posted', { contested: cc.coinid, error: e.message }); }
  }

  // 5. Payouts from their ring slot: one per copy, one per record shard.
  const records = (await unspentAt(S.record.address)).filter(c => same(c.tokenid, K.recordToken));
  const vault = await unspentAt(S.vault.address);
  const busyShards = new Set(Object.values(st.pending).filter(p => p.record).map(p => p.record.join('/')));
  for (const rc of reqs) {
    if (st.decided[rc.coinid]?.verdict !== 'approve' || st.paid[rc.coinid] || st.pending['pay' + rc.coinid]) continue;
    const slot = T.slotFor(hp, st.lists, rc, t); if (!slot) continue;
    const rs = stateOf(rc), tok = rs[13], name = tokenName(tok), shard = shardOf(rs[11]);
    if (!name || busyShards.has(name + '/' + shard)) continue;
    const rec = records.find(c => same(stateOf(c)[39], tok) && stateOf(c)[44] === String(shard));
    // A record coin this node does not track (it predates the node's tracking: 2026-11-07, Remove 0x5E0D9D66) left the
    // payout waiting in silence for hours: said once per request and token shard, so it is seen.
    if (!rec) { const k = rc.coinid + '/' + name + '/' + shard; if (!noRecordSaid.has(k)) { noRecordSaid.add(k); log('payout waits: the exit record coin is not visible on this node (coinimport it)', { request: rc.coinid, token: name, shard }); } continue; }
    if (!syncRecord(name, shard, stateOf(rec)[40])) continue;
    const x = keyOf(rs[11]), keys = recordKeys(name, shard).keys;
    if (keys.some(k => same(k, x))) { log('card coin already in the exit record: never paid twice', { request: rc.coinid, key: x }); continue; }
    const need = atoms(rs[12]);
    const mine = vault.filter(c => same(c.tokenid, tok) && !Object.values(st.pending).some(p => (p.vault || []).includes(c.coinid)));
    const one = mine.filter(c => atoms(c.tokenamount) >= need).sort((a, b) => (atoms(a.tokenamount) < atoms(b.tokenamount) ? -1 : 1))[0];
    let take = one ? [one] : [], sum = one ? atoms(one.tokenamount) : 0n;
    if (!one) for (const c of [...mine].sort((a, b) => (atoms(a.tokenamount) > atoms(b.tokenamount) ? -1 : 1))) if (sum < need && take.length < cfg.vault.maxVaultCoinsPerPayout) { take.push(c); sum += atoms(c.tokenamount); }
    if (sum < need) { log('vault coins do not cover the request', { request: rc.coinid, amount: rs[12] }); continue; }
    const copy = takeCopy(); if (!copy) { log('payout waits for a seal to clean the copies', { request: rc.coinid, largeCopies: large }); break; }
    const ins = recordTree({ depth: cfg.exitRecord.depth, keys, insert: x });
    const built = T.payoutTx({ rc, rcState: rs, take, copy, copyState: stateOf(copy), rec, recState: stateOf(rec), slot, ins, t, atoms, decimal });
    if (built.overLimit) { log('the sealed approver limit for this shard is reached this period', { request: rc.coinid, token: name, shard }); free.unshift(copy); if (!isLarge(copy)) budget++; continue; }
    const tx = 'r2t6_pay_' + rc.coinid.slice(2, 10);
    const c = await buildCheck(tx, built);
    try {
      const first = await post(tx, 'payout-' + rc.coinid.slice(2, 10), c);
      recordKeys(name, shard).pending = { key: x };
      st.pending['pay' + rc.coinid] = { firstOutput: first, tip: t, copy: copy.coinid, record: [name, shard], vault: take.map(v => v.coinid) };
      st.paid[rc.coinid] = { at: now(), amount: rs[12], token: name, shard, key: x, slot: slot.j, coinId: rs[11] };
      busyShards.add(name + '/' + shard); save();
    } catch (e) { log('payout not posted', { request: rc.coinid, error: e.message }); }
  }
  // 6. Copies still large (given back earlier) are cleaned now, so the next seal or guardian act never waits on them.
  if (H.copyLoneClean) await cleanCopies(free, t);
}

/* ---------- fresh deposit proofs for phones (as r2t5-council.mjs answerProofRequests, 2026-11-05) ----------
   A phone asks with one atom at the keyless post box (port 0 "R2PQ", port 1 the marker ids); the answer spends it back
   with the proofs (port 0 "R2PA", port 1 the request coin, ports 10 on one proof each). No key, nothing signed. This
   proposer answers the requests that name at least one R2T6 marker (the R2T5 council answers R2T5's), with every R2T6
   marker and, when R2T6_ALSO_ANCHORS names R2T5's anchor, the R2T5 markers in the same request, so a phone moving money
   over gets all of its proofs in one answer. It waits 12 blocks first, so a phone answers whenever one can. */
const PROOF_BOX = { address: '0xC39ED8A7DC340C30CC767B5EB4A08A033057D6E68AD273CF3463D5E33CE7C10D', ask: '0x52325051', answer: '0x52325041', perAsk: 12, perPass: 4, waitBlocks: 12,
  laneAsk: '0x52324C51', lanesPerAnswer: 4 };
const ALSO_ANCHORS = String(env('ALSO_ANCHORS', '')).split(',').filter(Boolean);
// A second answerer (2026-11-06): a signer answers too when R2T6_ANSWER=1, ANSWER_LATER blocks after the proposer
// would (lane requests 1 + 9, proof requests 12 + 18 by default), so the proposer normally answers and this machine
// only when the proposer does not: phones are not left without lanes or proofs when one server is down.
const ANSWERS = ROLE.role === 'proposer' || env('ANSWER', '') === '1';
const LATER = ROLE.role === 'proposer' ? 0 : Number(env('ANSWER_LATER', 18));
const LANE_LATER = ROLE.role === 'proposer' ? 0 : Number(env('LANE_ANSWER_LATER', 9));
async function answerProofRequests() {
  const t = await tip();
  st.proofAnswers = st.proofAnswers || {};
  for (const [k, v] of Object.entries(st.proofAnswers)) if (t - v.tip > 1000) delete st.proofAnswers[k];
  let n = 0;
  for (const q of (await unspentAt(PROOF_BOX.address)).filter(c => same(stateOf(c)['0'] || '', PROOF_BOX.ask) && Number(c.created) > 0)) {
    if (n >= PROOF_BOX.perPass) break;
    const done = st.proofAnswers[q.coinid];
    if ((done && t - done.tip <= 10) || t - Number(q.created) < PROOF_BOX.waitBlocks + LATER) continue;
    const ids = (String(stateOf(q)['1'] || '').replace(/^0x/i, '').match(/[0-9A-Fa-f]{64}/g) || []).slice(0, PROOF_BOX.perAsk);
    const markers = [];
    for (const id of ids) { const c = await coinOn('0x' + id); if (c && !c.spent) markers.push(c); }
    if (!markers.some(c => same(c.address, S.anchor.address))) continue;   // no R2T6 marker: the R2T5 council's
    const state = { 0: PROOF_BOX.answer, 1: q.coinid };
    let k = 0;
    for (const c of markers) {
      if (!same(c.address, S.anchor.address) && !ALSO_ANCHORS.some(a => same(a, c.address))) continue;
      const ex = await rpc('coinexport coinid:' + c.coinid, true);
      const blob = ex.status ? (ex.response?.data ?? ex.response) : null;
      if (typeof blob === 'string' && /^0x[0-9A-F]+$/i.test(blob)) state[10 + k++] = blob;
    }
    const tx = 'r2t6_pbx_' + q.coinid.slice(2, 10);
    const c = await buildCheck(tx, { inputs: [q.coinid], outputs: [{ address: PROOF_BOX.address, amount: q.tokenamount ?? q.amount, tokenid: q.tokenid, storestate: true }], state });
    try { await post(tx, 'proofs-' + q.coinid.slice(2, 10), c); st.proofAnswers[q.coinid] = { tip: t, proofs: k, asked: ids.length }; save(); n++; log('fresh proofs answered', { request: q.coinid, asked: ids.length, proofs: k }); }
    catch (e) { log('fresh proofs not answered', { request: q.coinid, error: e.message }); }
  }
}

/* Lane requests (2026-11-05, stables-f0's first R2T6 Add): a phone's node sees a lane coin only if it followed the gate
   when the coin was made, and the R2T6 lanes are older than any phone's tracking, so no phone can find a lane. A phone
   asks at the same post box with port 0 "R2LQ", port 1 the R2T6 gate address, port 2 the token; this node answers at
   once (no phone can) with coinexport proofs of up to 4 unspent lane coins of that token, in the proof answer's format
   (port 0 "R2PA", port 1 the request coin, ports 10 on), least recently handed out first, so phones spread over lanes.
   No key; the phone's node checks every proof on import. */
async function answerLaneRequests() {
  const t = await tip();
  st.laneAnswers = st.laneAnswers || {}; st.laneGiven = st.laneGiven || {};
  for (const [k, v] of Object.entries(st.laneAnswers)) if (t - v.tip > 1000) delete st.laneAnswers[k];
  let n = 0;
  for (const q of (await unspentAt(PROOF_BOX.address)).filter(c => same(stateOf(c)['0'] || '', PROOF_BOX.laneAsk) && Number(c.created) > 0)) {
    if (n >= PROOF_BOX.perPass) break;
    const done = st.laneAnswers[q.coinid];
    if ((done && t - done.tip <= 10) || t - Number(q.created) < 1 + LANE_LATER) continue;
    const p = stateOf(q);
    if (!same(p['1'] || '', S.gate.address)) continue;                     // another gate: not R2T6's
    const lanes = (await unspentAt(S.gate.address)).filter(c => same(c.tokenid, p['2'] || '') && stateOf(c)['5'] != null)
      .sort((a, b) => (st.laneGiven[stateOf(a)['6']] || 0) - (st.laneGiven[stateOf(b)['6']] || 0)).slice(0, PROOF_BOX.lanesPerAnswer);
    if (!lanes.length) { log('lane request: no lane of that token', { request: q.coinid, token: p['2'] }); st.laneAnswers[q.coinid] = { tip: t, lanes: 0 }; continue; }
    const state = { 0: PROOF_BOX.answer, 1: q.coinid };
    let k = 0;
    for (const c of lanes) {
      const ex = await rpc('coinexport coinid:' + c.coinid, true);
      const blob = ex.status ? (ex.response?.data ?? ex.response) : null;
      if (typeof blob === 'string' && /^0x[0-9A-F]+$/i.test(blob)) { state[10 + k++] = blob; st.laneGiven[stateOf(c)['6']] = t; }
    }
    const tx = 'r2t6_lane_' + q.coinid.slice(2, 10);
    const c = await buildCheck(tx, { inputs: [q.coinid], outputs: [{ address: PROOF_BOX.address, amount: q.tokenamount ?? q.amount, tokenid: q.tokenid, storestate: true }], state });
    try { await post(tx, 'lanes-' + q.coinid.slice(2, 10), c); st.laneAnswers[q.coinid] = { tip: t, lanes: k }; save(); n++; log('lane request answered', { request: q.coinid, token: p['2'], lanes: lanes.map(l => stateOf(l)['6']) }); }
    catch (e) { log('lane request not answered', { request: q.coinid, error: e.message }); }
  }
}

/* ---------- signing across machines (../cosign/, with the R2T6 seal checks) ---------- */
const cosignCfg = () => ({ headAddress: S.head.address, copyAddress: S.copy.address, sealToken: K.sealToken, payoutDelay: cfg.council.payoutDelayBlocks,
  maxHeartbeatAge: ROLE.maxHeartbeatAge || 10, keyFirst: 60, keyLast: 59 + K.council.length, plannedKeys: null,
  txpowLimit: TXPOW_LIMIT - TXPOW_MARGIN, signatureBytes: SIGNATURE_BYTES, signaturesToCome: cfg.council.quorum,
  filler: 'R2T6 filler ', r2t6: { ring: T.RING, successionToBackup: !!H.successionToBackup } });
async function cosignSeal(id, number, approve, reject) {
  const { signWith, collectSignatures } = await import('../cosign/cosign.mjs');
  await signWith({ rpc: rpcR, id, keys: ROLE.myKeys, guard, purpose: 'seal ' + number });
  const got = await collectSignatures({ rpc: rpcR, id, prop: { approve, reject }, peers: ROLE.peers || [], quorum: cfg.council.quorum, log });
  // Too few: nothing is posted; the next pass tries again (a long silence is covered by the vault's own rules).
  if (got < cfg.council.quorum) throw new Error(`cosign: ${got} of ${cfg.council.quorum} signatures on seal ${number}; not posted`);
}
async function serveCosign() {
  const { serveSigner } = await import('../cosign/cosign.mjs');
  await serveSigner({ port: ROLE.listen, host: ROLE.host || '127.0.0.1', rpc: rpcR, keys: ROLE.myKeys, guard, signed: st.cosigned, save, log,
    getView: async () => ({ head: (await unspentAt(S.head.address)).find(c => same(c.tokenid, K.sealToken)),
      copies: (await unspentAt(S.copy.address)).filter(c => same(c.tokenid, K.sealToken)), tip: await tip() }),
    getVerdicts: async () => Object.fromEntries(Object.entries(st.decided).map(([k, v]) => [k, v.verdict])),
    cfg: cosignCfg() });
  log('cosign signer listening', { port: ROLE.listen, keys: ROLE.myKeys.length });
}

async function watch() {
  const once = process.argv.includes('--once');
  log('watch start', { generation: 'R2T6', role: ROLE.role, node: NODE, keys: ROLE.myKeys.length, maxLargeCopies: MAX_LARGE_COPIES, answers: ANSWERS ? 'after ' + LATER + '/' + LANE_LATER + ' blocks' : false });
  for (const c of Object.values(S)) await rpc('newscript trackall:true script:' + JSON.stringify(c.script), true);
  if (ANSWERS) await rpc('newscript trackall:true script:"LET tag=0x52325051 RETURN TRUE"', true);   // the proof post box
  if (ROLE.role === 'proposer') publish();
  if (ROLE.role === 'signer') await serveCosign();
  for (;;) {
    try { await pass(); } catch (e) { log('pass error', { error: e.message }); }
    if (ANSWERS) try { await answerProofRequests(); await answerLaneRequests(); } catch (e) { log('proof answers error', { error: e.message }); }
    if (once) return;
    await sleep(30000);
  }
}
if (PHASE === 'watch') await watch();
else if (PHASE === 'check') { const c = await coinOn(process.argv[3]); console.log(JSON.stringify(check(process.argv[3], c ? c.address : S.request.address), null, 1)); }
else throw new Error('Phases: watch [--once] | check <coin id>');
