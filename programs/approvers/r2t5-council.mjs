// The R2T5 test Council (task_route2_tee_payments/r2t5/R2T5_DESIGN.md), on the server beside the node that holds its
// eleven keys (R2T5_NODE, default 10005). Every 30 s, one pass:
//   1. check every new exit request (R2Checker, the app's own verifier, --gen R2T5);
//   2. seal when an approval or a rejection is new, and at least every heartbeat interval (6 hours): the fallback only
//      works while the heartbeat is under a day old, so a silent Council freezes exits instead of opening the vault;
//   3. post the rejections in the sealed list (no signature needed: the request contract checks the proof);
//   4. pay the approved requests once the seal's payout delay has passed, one per seal copy and one per exit-record
//      shard per pass, inserting each paid card coin into its shard's exit record;
//   5. publish the exit lists (exit-lists.json): anyone can rebuild every record root from them.
// Beside each pass: answer phones' requests for fresh deposit proofs at the proof post box (keyless, 0.0.14.065).
// The Council never posts a fallback: it is alive, so it decides. Paths come from the environment (R2T5_*).
//   node r2t5-council.mjs watch [--once]
//   node r2t5-council.mjs check <request coin id>
//   node r2t5-council.mjs proofs [--loop]      fresh-proof answers only, no seal, payout or signature
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM = path.resolve(HERE, '..');
const WIN = process.platform === 'win32';
const GEN_DIR = process.env.R2T5_GENERATION || path.join(SIM, 'evidence', 'R2T5-DEPLOY-03');
const EVID = process.env.R2T5_EVID || path.join(SIM, 'evidence', 'R2T5-SRV-01');
const STATE = path.join(EVID, 'council-state.json');
const GUARD = process.env.R2T5_GUARD || '<lab>/Minima/WotsGuards/R2T5-Council/journal.jsonl';
const JAVA = process.env.R2T5_JAVA || (WIN ? 'C:/Program Files/Eclipse Adoptium/jdk-17.0.18.8-hotspot/bin/java.exe' : 'java');
const JAVAC = process.env.R2T5_JAVAC || (WIN ? 'C:/Program Files/Eclipse Adoptium/jdk-17.0.18.8-hotspot/bin/javac.exe' : 'javac');
const JAR = process.env.R2T5_MINIMA_JAR || '<lab>/Minima/Nodes/DevNodesSet/9101/minima.jar';
const STATUS = process.env.R2T5_STATUS || path.resolve(SIM, '..', 'standalone-android/stables-android/app/src/main/assets/route2/attestation-status.json');
const CHECKER = process.env.R2T5_CHECKER_CLASSES;
const RECORD_TOOL = process.env.R2T5_RECORD_TOOL || path.resolve(SIM, '../../../stream_3_governance/task_route2_tee_payments/r2t5/tools/RecordTree.java');
const NODE = Number(process.env.R2T5_NODE || 10005);
const PHASE = process.argv[2];
const SEP = WIN ? ';' : ':';

const json = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const G = json(path.join(GEN_DIR, 'generation.json'));         // contracts, public keys, tokens, lanes, config, lab fixtures
const cfg = G.config, S = G.contracts, K = G.keys;
const W = G.tokens.Winiwa, ATOM = '0.00000001', REQUEST_TAG = '0x52325445';
const R2T1_VAULT = '0x78A7881E711158B9E3AECCB026223822D401440B864218E106122DC18B5CC7F0';
const sha = x => createHash('sha256').update(x).digest('hex').toUpperCase();
const now = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const write = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2)); fs.renameSync(f + '.tmp', f); };
const same = (a, b) => String(a).toUpperCase() === String(b).toUpperCase();
const atoms = s => { const [a, b = ''] = String(s).split('.'); return BigInt(a) * 100000000n + BigInt(b.padEnd(8, '0').slice(0, 8)); };
const decimal = n => { const t = (n % 100000000n).toString().padStart(8, '0').replace(/0+$/, ''); return (n / 100000000n) + (t ? '.' + t : ''); };
const stateOf = c => Object.fromEntries((c.state || []).map(p => [String(p.port), p.data]));
function log(event, data = {}) { fs.mkdirSync(EVID, { recursive: true }); const e = { at: now(), event, ...data }; fs.appendFileSync(path.join(EVID, 'council-log.jsonl'), JSON.stringify(e) + '\n'); console.log(e.at, event, JSON.stringify(data).slice(0, 300)); }
let st = fs.existsSync(STATE) ? json(STATE) : { decided: {}, sealed: null, pending: {}, rejectedPosted: {}, paid: {}, records: {} };
// The deployment campaign's lab payouts are already in the records: the Council starts from the lists it hands over.
if (!Object.keys(st.records).length && G.records) st.records = JSON.parse(JSON.stringify(G.records));
const save = () => write(STATE, st);

/* ---------- RPC ---------- */
// coinexport (0.0.14.065): a read; the fresh deposit proofs the Council's node gives phones after a resync.
const READS = new Set(['status', 'coins', 'txpow', 'mmrcreate', 'keys', 'coinexport']);
const WRITES = new Set(['newscript', 'coinimport', 'txncreate', 'txninput', 'txnoutput', 'txnstate', 'txnsign', 'txnbasics', 'txncheck', 'txnexport', 'txndelete', 'txnpost']);
async function rpc(command, allowFail = false) {
  const verb = command.trim().split(/\s/)[0];
  if (!READS.has(verb) && !WRITES.has(verb)) throw new Error('Command outside recipe: ' + verb);
  if (verb === 'keys' && command !== 'keys') throw new Error('Key command refused');
  if (verb === 'txnsign' && /publickey:auto/.test(command)) throw new Error('The Council signs with its own keys only');
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
const tip = async () => Number((await rpc('status')).response.chain.block);
async function unspentAt(address) { return (await rpc('coins address:' + address)).response.filter(c => same(c.address, address) && !c.spent); }
async function coinOn(id) { return (await rpc('coins coinid:' + id)).response.find(c => same(c.coinid, id)) || null; }

/* ---------- WOTS write-ahead guard ---------- */
function guardEntries() { return fs.existsSync(GUARD) ? fs.readFileSync(GUARD, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []; }
function guardCheck() { let prev = '0'.repeat(64); for (const e of guardEntries()) { const { hash, ...b } = e; if (b.prev !== prev || sha(JSON.stringify(b)).toLowerCase() !== hash) throw new Error('WOTS guard journal broken'); prev = hash; } return prev; }
function guardAppend(e) { const body = { ...e, at: now(), prev: guardCheck() }; body.hash = sha(JSON.stringify(body)).toLowerCase(); const fd = fs.openSync(GUARD, 'a'); fs.writeSync(fd, JSON.stringify(body) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); }
function guardFloor(pub) { let f = 0; for (const e of guardEntries()) if (e.publickey && same(e.publickey, pub)) f = Math.max(f, e.kind === 'reserve' ? e.uses + 1 : e.uses); return f; }
async function keyUses(pub) { const k = (await rpc('keys')).response.keys.find(x => same(x.publickey, pub)); if (!k) throw new Error('Council key not on this node'); return Number(k.uses); }
async function councilSign(id, purpose) {
  for (const pub of K.council.slice(0, cfg.council.quorum)) {
    const before = await keyUses(pub), floor = guardFloor(pub);
    if (before < floor) throw new Error(`WOTS guard: key ${pub.slice(0, 10)} at ${before} uses, below the journal floor ${floor}`);
    guardAppend({ kind: 'reserve', run: 'R2T5-SRV', publickey: pub, uses: before, txn: id, purpose });
    await rpc(`txnsign id:${id} publickey:${pub}`);
    const after = await keyUses(pub);
    if (after <= before) throw new Error('WOTS guard: use count did not advance');
    guardAppend({ kind: 'signed', run: 'R2T5-SRV', publickey: pub, uses: after, txn: id, purpose });
  }
}

/* ---------- transactions ---------- */
const out = (address, amount, tokenid, storestate = false) => ({ address, amount, tokenid, storestate });
/* MINIMA'S TXPOW LIMIT (2026-10-22). Seal 20 was 67,834 bytes for 19 hours (124 tries, never mined: "Mempool txn too
   big .. max:65536"): a seal is 7 Council signatures (~4.1 KB each) plus 7 coins whose MMR proofs grow while they wait
   unspent, and it no longer fitted ~6 hours after seal 19. Now the size is measured before the Council signs (txnbasics
   adds the proofs; the signatures are estimated), so a seal that cannot land is reported and never signed, and the
   final size is logged with every post. A guardian check-in re-creates the head and copies as young coins. */
const TXPOW_LIMIT = 65536, TXPOW_MARGIN = 2500, SIGNATURE_BYTES = 4250;
async function exportedBytes(id) {
  const r = await rpc('txnexport id:' + id), d = r.response?.data ?? r.response;
  return typeof d === 'string' && /^0x[0-9A-F]+$/i.test(d) ? (d.length - 2) / 2 : 0;
}
/* ONE txnbasics PER TRANSACTION (2026-10-24). The size check of 2026-10-22 ran txnbasics before signing and the old one
   after it still ran too: every coin proof went in twice (14 proofs for 7 inputs, the node: "Wrong number of MMRProofs(14)
   for Inputs(7)"), so seal 23 failed basic and scripts 15 times, each time after 7 signatures. Now the proofs are added once,
   the unsigned transaction must pass basic and mmrproofs BEFORE any key signs, and a signed check that fails stops all
   signing until the Council is restarted (signingHalted), instead of signing again every pass. */
async function buildCheck(id, t, sign, signatures = 0) {
  await rpc('txndelete id:' + id, true);
  await rpc('txncreate id:' + id);
  for (const c of t.inputs) await rpc(`txninput id:${id} coinid:${c}`);
  for (const o of t.outputs) await rpc(`txnoutput id:${id} amount:${o.amount} address:${o.address} tokenid:${o.tokenid} storestate:${o.storestate}`);
  for (const [p, v] of Object.entries(t.state || {})) await rpc(`txnstate id:${id} port:${p} value:${v}`);
  await rpc('txnbasics id:' + id);
  if (sign && signatures) {
    const expected = (await exportedBytes(id)) + signatures * SIGNATURE_BYTES;
    if (expected > TXPOW_LIMIT - TXPOW_MARGIN) {
      await rpc('txndelete id:' + id, true);
      return { ok: false, tooLarge: true, bytes: expected, valid: {} };
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
  if (sign && !ok) { signingHalted = true; log('SIGNING HALTED: a signed transaction failed its check; nothing more is signed until the Council is restarted', { txn: id, valid: v }); }
  return { ok, valid: v, bytes: await exportedBytes(id) };
}
let signingHalted = false;
/** Posts a checked transaction. Returns its first output's coin id (final before mining), which the next passes watch. */
async function post(id, label, checked) {
  if (checked.tooLarge) throw Object.assign(new Error(label + ' would be about ' + checked.bytes + ' bytes, over the ' + TXPOW_LIMIT + '-byte TxPoW limit; not signed, not posted'), { tooLarge: true, bytes: checked.bytes });
  if (!checked.ok) { await rpc('txndelete id:' + id, true); throw new Error(label + ' validators: ' + JSON.stringify(checked.valid)); }
  if (checked.bytes > TXPOW_LIMIT - 512) { await rpc('txndelete id:' + id, true); throw Object.assign(new Error(label + ' is ' + checked.bytes + ' bytes, over the TxPoW limit; not posted'), { tooLarge: true, bytes: checked.bytes }); }
  const txn = (await rpc(`txnpost id:${id} txndelete:true`)).response.body.txn;
  log('posted', { label, transactionid: txn.transactionid, firstOutput: txn.outputs[0].coinid, bytes: checked.bytes });
  return txn.outputs[0].coinid;
}

/* ---------- the exit record ---------- */
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
/** The shard's list as this Council holds it, checked against the record coin's root; a pending insertion is settled here. */
function syncRecord(name, shard, recRoot) {
  const r = recordKeys(name, shard), depth = cfg.exitRecord.depth;
  if (r.pending) {
    const withIt = recordTree({ depth, keys: [...r.keys, r.pending.key] }).root;
    if (same(withIt, recRoot)) { r.keys.push(r.pending.key); delete r.pending; save(); publish(); return true; }
  }
  if (same(recordTree({ depth, keys: r.keys }).root, recRoot)) return true;
  log('exit record out of step', { token: name, shard, chainRoot: recRoot, keys: r.keys.length });
  return false;
}
function publish() {
  const lists = {};
  for (const [name, shards] of Object.entries(st.records)) for (const [shard, r] of Object.entries(shards)) (lists[name] = lists[name] || {})[shard] = r.keys;
  write(path.join(EVID, 'exit-lists.json'), { generation: 'R2T5', record: S.record.address, depth: cfg.exitRecord.depth, keyBytes: 16, updated: now(),
    note: 'Paid card coins per token and shard, in insertion order. Slot 0 is the sentinel; RecordTree.java rebuilds each record root.', lists });
}

/* ---------- checking ---------- */
function check(coinId, reqAddress) {
  if (!CHECKER) throw new Error('Set R2T5_CHECKER_CLASSES (checker/build.sh output)');
  const exited = Object.values(st.decided).filter(v => v.verdict === 'approve' && v.coinId).map(v => v.coinId.toLowerCase());
  const r = spawnSync(JAVA, ['-cp', JAR + SEP + CHECKER, 'org.stablescouncil.stables.route2.R2Checker', '--rpc', String(NODE), '--request', coinId,
    '--reqaddr', reqAddress, '--anchor', S.anchor.address, '--vault', S.vault.address, '--r2t1', R2T1_VAULT, '--gen', '0x52325435',
    '--status', STATUS, '--exited', exited.join(','), '--seen', path.join(EVID, 'council-seen-hops.txt')], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('Checker failed: ' + r.stderr.slice(0, 400));
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

/* ---------- one pass ---------- */
const SEALPORTS = ['20', '21', '22', '23', '24', '26', '27', '28'];
const sealPins = cs => Object.fromEntries(Object.entries(stateOf(cs)).filter(([p]) => SEALPORTS.includes(p) || (Number(p) >= 80 && Number(p) < 120)));
const requestPorts = rc => Object.fromEntries(Object.entries(stateOf(rc)).filter(([p]) => ['0', '10', '11', '12', '13', '14', '17', '18', '51'].includes(p)));
/* LEAN COPIES (B1, 2026-10-24). A payout or a rejection gives its copy back carrying that transaction's whole state (record
   proofs in 47/48, the request ports): ~3.4 KB instead of ~1.3 KB, and every seal spends all 6 copies, each written twice,
   so 2-3 dirty copies push a seal over the TxPoW limit (seals 20 and 22). The copy contract's open path asks only
   @INPUT EQ STATE(16)+1 and its pins, so a dirty copy is spent ALONE (input 0, STATE(16) = -1) back to the copy address
   with only the pinned ports: no signature, no other coin, ~4.4 KB. Anyone may do this; the Council does it after each
   payout or rejection and before a seal. Lab check (txncheck on 9105, seal-23 copy): all four validators true. */
const LEAN_EXTRA = new Set(['16', '19', '29', ...Array.from({ length: 11 }, (_, i) => String(60 + i))]);
const isDirty = c => Object.keys(stateOf(c)).some(p => !LEAN_EXTRA.has(p) && !SEALPORTS.includes(p) && !(Number(p) >= 80 && Number(p) < 120));
const cleanFailedAt = {};   // a copy whose cleaning failed is tried again after 10 minutes, not every pass
async function cleanCopies(list, t) {
  let n = 0;
  for (const copy of list) {
    if (!isDirty(copy) || st.pending['clean' + copy.coinid] || Date.now() - (cleanFailedAt[copy.coinid] || 0) < 600000) continue;
    const tx = 'r2t5c_clean_' + copy.coinid.slice(2, 10);
    const c = await buildCheck(tx, { inputs: [copy.coinid], outputs: [out(S.copy.address, '1', K.sealToken, true)], state: { ...sealPins(copy), 16: '-1', 19: '0' } });
    try { st.pending['clean' + copy.coinid] = { firstOutput: await post(tx, 'clean-' + copy.coinid.slice(2, 10), c), tip: t, copy: copy.coinid }; save(); n++; }
    catch (e) { cleanFailedAt[copy.coinid] = Date.now(); log('copy not cleaned', { copy: copy.coinid, error: e.message }); }
  }
  return n;
}
async function mmr(ids, tag) {
  const leaves = [...ids, '0x' + sha('R2T5 filler ' + tag)];
  const r = (await rpc(`mmrcreate nodes:${JSON.stringify(leaves)}`)).response;
  return { root: r.root.data, proofs: Object.fromEntries(ids.map((id, i) => [id, r.nodes[i].proof])) };
}

async function pass() {
  const t = await tip();
  const reqs = [...await unspentAt(S.request.address), ...await unspentAt(S.contested.address)];
  const head = (await unspentAt(S.head.address)).find(c => same(c.tokenid, K.sealToken));
  const copies = (await unspentAt(S.copy.address)).filter(c => same(c.tokenid, K.sealToken));
  if (!head) { log('seal head not visible'); return; }
  const hp = stateOf(head);
  // Our posts that never landed (contention, a reorganisation): forgotten after 10 blocks, so they are tried again.
  for (const [k, p] of Object.entries(st.pending)) {
    const landed = await coinOn(p.firstOutput);
    if (landed && Number(landed.created) > 0) {
      if (p.record) { const r = recordKeys(p.record[0], p.record[1]); if (r.pending) { r.keys.push(r.pending.key); delete r.pending; publish(); } }
      delete st.pending[k]; continue;
    }
    if (t - p.tip > 10) { log('post did not land, will retry', { what: k }); delete st.pending[k]; if (p.record) { delete recordKeys(p.record[0], p.record[1]).pending; } }
  }
  save();

  // 1. Check every new request (lab fixtures of the deployment campaign are not exits).
  for (const q of reqs) {
    if (st.decided[q.coinid] || (G.labRequests || []).some(x => same(x, q.coinid))) continue;
    const v = check(q.coinid, q.address);
    if (v.verdict === 'reject' && /confirmations, needs|package-missing/.test((v.detail || '') + (v.code || '')) && t - Number(q.created) <= 10) { log('not yet', { request: q.coinid, detail: v.detail }); continue; }
    st.decided[q.coinid] = { ...v, at: now(), block: Number(q.created) }; save();
    log('checked', { request: q.coinid, verdict: v.verdict, code: v.code, detail: v.detail, amount: v.amount });
  }
  const open = reqs.filter(q => st.decided[q.coinid]);
  const approve = open.filter(q => st.decided[q.coinid].verdict === 'approve').map(q => q.coinid).sort();
  const reject = open.filter(q => st.decided[q.coinid].verdict === 'reject').map(q => q.coinid).sort();

  // 2. Seal: something new to approve or reject, or the heartbeat is due. Every copy must be free (the head takes them all).
  const sealed = st.sealed && same(st.sealed.approvedRoot, hp[20]) && same(st.sealed.rejectedRoot, hp[26]) ? st.sealed : null;
  const fresh = !sealed || approve.some(x => !sealed.approve.includes(x)) || reject.some(x => !sealed.reject.includes(x));
  /* A heartbeat at least every 216 blocks (~3 hours; 432 in the config): the head and copies never wait long enough for
     their proofs to push a seal over the TxPoW limit (seal 20, 2026-10-21). Still longer than the 144-block payout delay,
     so a heartbeat seal does not keep postponing an approval in its delay. Software only: the chain does not enforce it. */
  const HEARTBEAT_EVERY = Math.min(cfg.council.heartbeatEveryBlocks, 216);
  const due = t - Number(hp[23]) >= HEARTBEAT_EVERY;
  /* A seal restarts the payout delay (port 24) for every approval in it. While sealed approvals are still waiting for their
     payable block, a new approval waits for the next seal instead of postponing them (2026-10-18, the first phone Remove
     through R2T5); a new rejection or the heartbeat still seals at once. */
  const waitingPayout = !!sealed && t < Number(hp[24]) && sealed.approve.some((id) => reqs.some((q) => same(q.coinid, id)) && !st.paid[id]);
  const newReject = reject.some((x) => !sealed || !sealed.reject.includes(x));
  if (fresh && approve.length && waitingPayout && !newReject && !due) {
    if (!st.holdLogged) { log('new approval waits: sealing now would postpone approvals already in their delay', { payableFrom: hp[24] }); st.holdLogged = true; save(); }
  } else if ((fresh && (approve.length || reject.length)) || due) {
    st.holdLogged = false;
    if (st.pending.seal) { log('waiting for the seal', {}); return; }
    if (copies.length !== cfg.council.sealCopies) { log('seal copies busy, sealing next pass', { free: copies.length }); return; }
    // A copy still on its way (payout, rejection, cleaning) shows unspent until mined: sealing now would spend it twice.
    if (Object.values(st.pending).some(p => p.copy)) { log('seal waits for copies in flight', {}); return; }
    // Cleaning that cannot post never blocks the seal: it is then tried as it is (the size check still guards it).
    if (copies.some(isDirty)) { const n = await cleanCopies(copies, t); if (n) { log('cleaning copies before the seal', { posted: n }); return; } }
    const a = await mmr(approve, 'a' + hp[21]), r = await mmr(reject, 'r' + hp[21]);
    const state = { ...hp, 20: a.root, 26: r.root, 21: String(Number(hp[21]) + 1), 23: String(t), 24: String(t + cfg.council.payoutDelayBlocks), 29: '1' };
    const id = 'r2t5c_seal';
    const c = await buildCheck(id, { inputs: [head.coinid, ...copies.map(x => x.coinid)], outputs: [out(S.head.address, '2', K.sealToken, true), ...copies.map(() => out(S.copy.address, '1', K.sealToken, true))], state },
      i => councilSign(i, 'seal ' + state[21]), cfg.council.quorum);
    if (c.tooLarge) {
      if (!st.tooLargeSaidAt || Date.now() - st.tooLargeSaidAt > 30 * 60000) {
        log('seal too large: not signed, not posted; a guardian check-in re-creates the head and copies as young coins', { number: state[21], bytes: c.bytes, limit: TXPOW_LIMIT });
        st.tooLargeSaidAt = Date.now(); save();
      }
      return;
    }
    st.tooLargeSaidAt = 0;
    st.pending.seal = { firstOutput: await post(id, 'seal-' + state[21], c), tip: t };
    st.sealed = { approvedRoot: a.root, rejectedRoot: r.root, approve, reject, proofsA: a.proofs, proofsR: r.proofs, number: state[21], heartbeat: t, due };
    save(); log('sealed', { number: state[21], approve: approve.length, reject: reject.length, heartbeat: due });
    return;
  }
  if (!sealed || hp[27] !== '0') { if (hp[27] !== '0') log('frozen: nothing is paid or rejected', {}); return; }
  let free = copies.filter(c => !Object.values(st.pending).some(p => p.copy && same(p.copy, c.coinid)));

  // 3. Rejections (no signature: the proof in the sealed rejected list is enough).
  for (const id of sealed.reject) {
    if (!free.length || st.pending['rej' + id]) continue;
    const rc = reqs.find(q => same(q.coinid, id)); if (!rc) continue;
    const copy = free.shift(), tx = 'r2t5c_rej_' + id.slice(2, 10);
    const c = await buildCheck(tx, { inputs: [id, copy.coinid], outputs: [out(S.copy.address, '1', K.sealToken, true), out(stateOf(rc)[14], rc.tokenamount ?? ATOM, rc.tokenid)],
      state: { ...requestPorts(rc), ...sealPins(copy), 16: '0', 19: '0', 25: sealed.proofsR[id], 50: '0' } });
    try { st.pending['rej' + id] = { firstOutput: await post(tx, 'reject-' + id.slice(2, 10), c), tip: t, copy: copy.coinid }; save(); }
    catch (e) { log('rejection not posted', { request: id, error: e.message }); }
  }

  // 4. Payouts after the delay: one per copy, one per record shard. 5. Copies left dirty by earlier payouts or rejections
  // are cleaned at once, so a guardian act (it spends all 6 copies too) or the next seal never waits on them.
  if (t < Number(hp[24])) { await cleanCopies(free, t); return; }
  const records = (await unspentAt(S.record.address)).filter(c => same(c.tokenid, K.recordToken));
  const vault = await unspentAt(S.vault.address);
  const busyShards = new Set(Object.values(st.pending).filter(p => p.record).map(p => p.record.join('/')));
  for (const id of sealed.approve) {
    if (!free.length || st.pending['pay' + id]) continue;
    const rc = reqs.find(q => same(q.coinid, id)); if (!rc) continue;
    const rs = stateOf(rc), tok = rs[13], name = tokenName(tok), shard = shardOf(rs[11]);
    if (!name || busyShards.has(name + '/' + shard)) continue;
    const rec = records.find(c => same(stateOf(c)[39], tok) && stateOf(c)[44] === String(shard));
    if (!rec || !syncRecord(name, shard, stateOf(rec)[40])) continue;
    const recState = stateOf(rec), x = keyOf(rs[11]), keys = recordKeys(name, shard).keys;
    if (keys.some(k => same(k, x))) { log('card coin already in the exit record: never paid twice', { request: id, key: x }); continue; }
    const ins = recordTree({ depth: cfg.exitRecord.depth, keys, insert: x });
    const need = atoms(rs[12]);
    const mine = vault.filter(c => same(c.tokenid, tok) && !Object.values(st.pending).some(p => (p.vault || []).includes(c.coinid)));
    const one = mine.filter(c => atoms(c.tokenamount) >= need).sort((a, b) => (atoms(a.tokenamount) < atoms(b.tokenamount) ? -1 : 1))[0];
    let take = one ? [one] : [], sum = one ? atoms(one.tokenamount) : 0n;
    if (!one) for (const c of [...mine].sort((a, b) => (atoms(a.tokenamount) > atoms(b.tokenamount) ? -1 : 1))) if (sum < need && take.length < cfg.vault.maxVaultCoinsPerPayout) { take.push(c); sum += atoms(c.tokenamount); }
    if (sum < need) { log('vault coins do not cover the request', { request: id, amount: rs[12] }); continue; }
    const rem = sum - need, period = cfg.meter.periodBlocks;
    let p41 = Number(recState[41]), c42 = recState[42], f43 = recState[43];
    if (p41 + period <= t) { p41 = t; c42 = '0'; f43 = '0'; }
    const paid = atoms(c42) + need;
    if (paid > atoms(recState[35])) { log('Council cap for this shard reached this period', { request: id, token: name, shard }); continue; }
    const outputs = [out(rs[14], rs[12], tok), out(rs[14], rs[17], rc.tokenid)];
    if (rem > 0n) outputs.push(out(S.vault.address, decimal(rem), tok));
    const copyIndex = outputs.length, copy = free.shift();
    outputs.push(out(S.copy.address, '1', K.sealToken, true), out(S.record.address, '1', K.recordToken, true));
    const state = { ...requestPorts(rc), ...sealPins(copy), ...Object.fromEntries(['35', '36', '37', '38', '39', '44'].map(p => [p, recState[p]])),
      40: ins.new, 41: String(p41), 42: decimal(paid), 43: f43, 45: ins.lo, 46: ins.nx, 47: ins.pa, 48: ins.pb, 49: ins.mid,
      15: rem > 0n ? decimal(rem) : '0', 16: String(take.length), 19: String(copyIndex), 25: sealed.proofsA[id], 50: '1' };
    const tx = 'r2t5c_pay_' + id.slice(2, 10);
    const c = await buildCheck(tx, { inputs: [id, ...take.map(v => v.coinid), copy.coinid, rec.coinid], outputs, state });
    try {
      const first = await post(tx, 'payout-' + id.slice(2, 10), c);
      recordKeys(name, shard).pending = { key: x };
      st.pending['pay' + id] = { firstOutput: first, tip: t, copy: copy.coinid, record: [name, shard], vault: take.map(v => v.coinid) };
      st.paid[id] = { at: now(), amount: rs[12], token: name, shard, key: x };
      busyShards.add(name + '/' + shard); save();
    } catch (e) { log('payout not posted', { request: id, error: e.message }); }
  }
  await cleanCopies(free, t);
}

/* ---------- fresh deposit proofs (0.0.14.065) ---------- */
/* Founder 2026-10-28: "the phone gets fresh proofs from a node that still has them". A Minima Core resynced after falling far
   behind no longer takes the deposit-marker proofs the phone kept ("Invalid MMR Proof": older than Core's MMR history), and
   without them the phone's card coins would leave through a Council payout. This node tracks every R2T5 marker (trackall on
   the anchor), so it can always export a fresh proof. A phone asks with one atom at the post box, a keyless covenant
   ("LET tag=0x52325051 RETURN TRUE"): port 0 "R2PQ", port 1 the marker ids. The answer spends that atom back to the post box
   with the proofs in its state (port 0 "R2PA", port 1 the request coin, ports 10 on one proof each). NO SIGNATURE: no Council
   key, no WOTS use, nothing to guard. Only R2T5 deposit markers are exported, at most 12 per request and 4 requests per pass.
   The phone's node checks every proof on import, so a wrong answer could move nothing. Proven on mainnet 2026-10-28 with lab
   nodes (6 of 6 imported by a freshly resynced 1.1.1.26 node; answer 0xBA462181..., 6,405 bytes, all four validators). */
/* ONE ANSWERER AMONG MANY (0.0.14.081; founder 2026-11-02: "would be good if the Council would really become one answerer
   among many"). Every Stables app now answers too, after 1 to 6 blocks (instant-route2.js answerPass), and a phone mines its
   own TxPoW, slower than this server: answering at once, this node won every race (test 2026-11-02, request 0x9038828D, the
   phone's answer never mined). It now waits waitBlocks after the request is mined, so a phone answers first whenever one
   can, and this node still answers every request no phone took within about 10 minutes. */
const PROOF_BOX = { script: 'LET tag=0x52325051 RETURN TRUE', address: '0xC39ED8A7DC340C30CC767B5EB4A08A033057D6E68AD273CF3463D5E33CE7C10D',
  ask: '0x52325051', answer: '0x52325041', perAsk: 12, perPass: 4, waitBlocks: 12 };
async function answerProofRequests() {
  const t = await tip();
  st.proofAnswers = st.proofAnswers || {};
  for (const [k, v] of Object.entries(st.proofAnswers)) if (t - v.tip > 1000) delete st.proofAnswers[k];
  const asks = (await unspentAt(PROOF_BOX.address)).filter(c => same(stateOf(c)['0'] || '', PROOF_BOX.ask) && Number(c.created) > 0);
  let n = 0;
  for (const q of asks) {
    if (n >= PROOF_BOX.perPass) break;
    const done = st.proofAnswers[q.coinid];
    if (done && t - done.tip <= 10) continue;                     // answered, not mined yet: tried again after 10 blocks
    if (t - Number(q.created) < PROOF_BOX.waitBlocks) continue;   // the phones' turn first
    const ids = (String(stateOf(q)['1'] || '').replace(/^0x/i, '').match(/[0-9A-Fa-f]{64}/g) || []).slice(0, PROOF_BOX.perAsk);
    const state = { 0: PROOF_BOX.answer, 1: q.coinid };
    let k = 0;
    for (const id of ids) {
      const c = await coinOn('0x' + id);
      if (!c || c.spent || !same(c.address, S.anchor.address)) continue;   // R2T5 deposit markers only
      const ex = await rpc('coinexport coinid:0x' + id, true);
      const blob = ex.status ? (ex.response?.data ?? ex.response) : null;
      if (typeof blob === 'string' && /^0x[0-9A-F]+$/i.test(blob)) state[10 + k++] = blob;
    }
    const tx = 'r2t5c_pbx_' + q.coinid.slice(2, 10);
    const c = await buildCheck(tx, { inputs: [q.coinid], outputs: [out(PROOF_BOX.address, q.tokenamount ?? q.amount, q.tokenid, true)], state });
    try {
      await post(tx, 'proofs-' + q.coinid.slice(2, 10), c);
      st.proofAnswers[q.coinid] = { tip: t, proofs: k, asked: ids.length }; save(); n++;
      log('fresh proofs answered', { request: q.coinid, asked: ids.length, proofs: k });
    } catch (e) { log('fresh proofs not answered', { request: q.coinid, error: e.message }); }
  }
}

async function watch() {
  const once = process.argv.includes('--once');
  log('watch start', { generation: 'R2T5', node: NODE, council: K.council.length + ' keys, quorum ' + cfg.council.quorum });
  for (const c of Object.values(S)) await rpc('newscript trackall:true script:' + JSON.stringify(c.script), true);
  await rpc('newscript trackall:true script:' + JSON.stringify(PROOF_BOX.script), true);
  publish();
  for (;;) {
    try { await pass(); } catch (e) { log('pass error', { error: e.message }); }
    // Separate from the pass: a seal, payout or early return there never delays a phone's proofs, nor the reverse.
    try { await answerProofRequests(); } catch (e) { log('proof answers error', { error: e.message }); }
    if (once) return;
    await sleep(30000);
  }
}
if (PHASE === 'watch') await watch();
// proofs [--loop]: ONLY the fresh-proof answers, no seal, payout or signature (0.0.14.065). Lab use: R2T5_NODE=<a lab RPC port>.
else if (PHASE === 'proofs') {
  await rpc('newscript trackall:true script:' + JSON.stringify(PROOF_BOX.script), true);
  for (;;) { await answerProofRequests(); if (!process.argv.includes('--loop')) break; await sleep(30000); }
}
else if (PHASE === 'check') { const c = await coinOn(process.argv[3]); console.log(JSON.stringify(check(process.argv[3], c ? c.address : S.request.address), null, 1)); }
else throw new Error('Phases: watch [--once] | check <request coin id> | proofs [--loop]');
