#!/usr/bin/env node
/*
 * The Stables card guardian (2026-11-03, first version; design GUARDIAN_DESIGN.md). One program for the founder's PC and
 * a Linux server; the phone's guardian mode follows the same rules (android/).
 *
 * Every pass (default every 5 minutes, at least once an hour):
 *   1. reads its own Minima node (and a second one if given): the tip, the seal head and copies, every open exit request
 *      and contested request of the card vault (generation R2T5 now);
 *   2. runs the package check on each new request (R2Checker, the same Java check the Council and the app run);
 *   3. a request found bad (twice, confirmBlocks apart) is stopped: one guardian is enough;
 *   4. each new Council seal: rebuilds its approved and rejected roots from what the guardian saw; an approval the
 *      guardian found bad, or a root it cannot rebuild, goes to the owner with a freeze prepared (3 guardians needed);
 *   5. checks in when due (default every 7 days; the seat is open to election after 60 days without one);
 *   6. writes every decision to its public log (hash-chained JSON lines) and tells its owner what needs a person;
 *   7. once an hour, publishes that log and a short status to its own public git repository (publish-log.mjs).
 *
 * DRY RUN IS THE DEFAULT: transactions are built and checked offline with Minima's own script engine (the guardian's
 * public key named, nothing signed), then logged as "would post". Posting needs BOTH --post on the command line and
 * "allowPost": true in the config, and a key and seat. In dry run the node only ever receives read commands.
 *
 *   node guardian.mjs watch [--once] [--config guardian.config.json] [--post]
 *   node guardian.mjs status [--config ...]          one read-only pass, printed, nothing logged as acted
 *   node guardian.mjs verify-log [--config ...]      checks the public log's hash chain
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as core from './guardian-core.mjs';
import * as offline from './offline.mjs';
import { parlonsSender, alertText } from './alert-parlons.mjs';
import { publishDue, publishLog } from './publish-log.mjs';
import { wotsGuard } from './wots-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { same, portsOf, amountOf } = core;
const sha = x => createHash('sha256').update(x).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

export const DEFAULTS = {
  node: 'http://127.0.0.1:9005',          // the guardian's own Minima node RPC (read-only unless posting)
  node2: null,                            // a second, independent node: disagreements go to the owner
  generation: '../../stream_1_app/work/simcard/evidence/R2T5-DEPLOY-03/generation.json',
  dataDir: './data',                      // state.json, guardian-log.jsonl (public), alerts.jsonl, the WOTS journal
  wotsJournal: null,                      // the key's write-ahead journal (wots-guard.mjs); null = <dataDir>/wots-journal.jsonl
  publicKey: null,                        // this guardian's key (in its node's wallet); null = watch only
  seat: null,                             // its seat in the head (0 to 8); checked against the head every pass
  passSeconds: 300,
  confirmBlocks: 20,                      // a bad verdict is checked again this many blocks later before a stop
  failClosedBlocks: 720,                  // a request it cannot check is stopped this long before it could pay
  checkInEveryBlocks: 12096,              // 7 days (the seat opens to election after 103,680 blocks, 60 days)
  allowPost: false,
  checker: {                              // R2Checker: the app's own verifier (simcard/route2/checker, build.sh)
    classes: '../../stream_1_app/work/simcard/route2/checker/build',
    status: '../../stream_1_app/work/standalone-android/stables-android/app/src/main/assets/route2/attestation-status.json',
    r2t1: '0x78A7881E711158B9E3AECCB026223822D401440B864218E106122DC18B5CC7F0',
  },
  alert: { command: null, parlons: null, telegram: null },   // parlons: { url, ticketFile, to | toFile } (alert-parlons.mjs); telegram: { tokenEnv, chatId }
  publish: null,                          // { repoDir, everyMinutes, push, name, repoUrl }: its own public log repository (publish-log.mjs)
  jdk: null, jar: null,
};

export function loadConfig(file, over = {}) {
  const base = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const dir = file ? path.dirname(path.resolve(file)) : HERE;
  const c = { ...DEFAULTS, ...base, ...over, checker: { ...DEFAULTS.checker, ...(base.checker || {}) }, alert: { ...DEFAULTS.alert, ...(base.alert || {}) } };
  const abs = p => (p && !path.isAbsolute(p) ? path.resolve(dir === HERE ? HERE : dir, p) : p);
  c.generation = abs(c.generation); c.dataDir = abs(c.dataDir); c.wotsJournal = abs(c.wotsJournal);
  c.checker.classes = abs(c.checker.classes); c.checker.status = abs(c.checker.status);
  if (c.publish) c.publish = { ...c.publish, repoDir: abs(c.publish.repoDir) };
  return c;
}

/* ---------- the node ---------- */
// The only commands the guardian ever sends. Reads in every mode; the writes only when posting.
const READS = new Set(['status', 'coins', 'mmrcreate']);
const WRITES = new Set(['keys', 'txncreate', 'txninput', 'txnoutput', 'txnstate', 'txnbasics', 'txnsign', 'txncheck', 'txnpost', 'txndelete']);
export function nodeRpc(url, { posting = false } = {}) {
  return async cmd => {
    const verb = cmd.trim().split(/\s/)[0];
    if (!READS.has(verb) && !(posting && WRITES.has(verb))) throw new Error(`refused (${posting ? 'outside the recipe' : 'dry run: reads only'}): ${verb}`);
    if (verb === 'txnsign' && /publickey:auto/.test(cmd)) throw new Error('the guardian signs with its own key only');
    const long = cmd.length > 1800;
    const res = await fetch(long ? url : url + '/' + encodeURIComponent(cmd), long ? { method: 'POST', body: cmd } : {});
    const j = await res.json();
    if (!j.status) throw new Error(`node refused ${verb}: ${j.error || 'no reason'}`);
    return j.response;
  };
}

/* ---------- the package check ---------- */
export function r2Checker(cfg, gen, nodeUrl) {
  const jp = offline.javaPaths(cfg);
  const port = new URL(nodeUrl).port;
  if (!['127.0.0.1', 'localhost'].includes(new URL(nodeUrl).hostname)) throw new Error('R2Checker reads only a node on this machine (127.0.0.1)');
  return (coinId, reqAddress, exited, seenFile) => {
    const r = spawnSync(jp.java, ['-cp', jp.jar + path.delimiter + cfg.checker.classes, 'org.stablescouncil.stables.route2.R2Checker', '--rpc', port,
      '--request', coinId, '--reqaddr', reqAddress, '--anchor', gen.contracts.anchor.address, '--vault', gen.contracts.vault.address,
      '--r2t1', cfg.checker.r2t1, '--gen', gen.tag, '--status', cfg.checker.status, '--exited', exited.join(','), '--seen', seenFile],
    { encoding: 'utf8', maxBuffer: 16 << 20 });
    if (r.status !== 0) return { error: true, detail: 'checker failed: ' + (r.stderr || '').slice(0, 300) };
    try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: true, detail: 'checker output unreadable' }; }
  };
}

/* ---------- the guardian ---------- */
/**
 * createGuardian({ cfg, rpc, rpc2?, checker, scriptCheck?, mmrRoot?, alertOut?, posting? }) -> { pass(), state }.
 * Everything outside is injected, so the tests drive it against a fixture node.
 */
export function createGuardian({ cfg, gen, rpc, rpc2 = null, checker, scriptCheck, mmrRoot, alertOut = null, posting = false }) {
  const C = gen.contracts, keys = gen.keys, g = gen.config;
  const rules = { fallbackWaitBlocks: g.fallback.waitBlocks, confirmBlocks: cfg.confirmBlocks, failClosedBlocks: cfg.failClosedBlocks };
  const dir = cfg.dataDir; fs.mkdirSync(dir, { recursive: true });
  const files = { state: path.join(dir, 'state.json'), log: path.join(dir, 'guardian-log.jsonl'), alerts: path.join(dir, 'alerts.jsonl'),
    seen: path.join(dir, 'seen-hops.txt'), journal: cfg.wotsJournal || path.join(dir, 'wots-journal.jsonl') };
  const st = fs.existsSync(files.state) ? JSON.parse(fs.readFileSync(files.state, 'utf8'))
    : { requests: {}, seals: {}, alerted: {}, lastCheckIn: null, lastPass: null };
  const save = () => { fs.writeFileSync(files.state + '.tmp', JSON.stringify(st, null, 1)); fs.renameSync(files.state + '.tmp', files.state); };

  // The public log: one JSON line per decision, each carrying the hash of the line before it, so a line removed or
  // changed later shows. Meant to be published as it is (it holds only chain facts and verdicts, no secret).
  let lastHash = null;
  const tail = () => {
    if (lastHash) return lastHash;
    if (!fs.existsSync(files.log)) return (lastHash = '0'.repeat(64));
    const lines = fs.readFileSync(files.log, 'utf8').trim().split('\n').filter(Boolean);
    return (lastHash = lines.length ? JSON.parse(lines.at(-1)).hash : '0'.repeat(64));
  };
  function log(event, data = {}) {
    const body = { at: new Date().toISOString(), guardian: cfg.publicKey || 'watch-only', seat: cfg.seat, event, ...data, prev: tail() };
    body.hash = sha(JSON.stringify(body));
    fs.appendFileSync(files.log, JSON.stringify(body) + '\n');
    lastHash = body.hash;
    return body;
  }
  const parlons = cfg.alert.parlons && !alertOut ? parlonsSender({ ...cfg.alert.parlons, sessionFile: path.join(dir, 'parlons-session.txt') }) : null;
  // The owner hears what needs a person, once per subject (again after 6 hours if it still stands).
  async function alert(level, subject, text, data = {}) {
    const k = level + ':' + subject, now = Date.now();
    if (st.alerted[k] && now - st.alerted[k] < 6 * 3600e3) return;
    st.alerted[k] = now;
    const a = { at: new Date().toISOString(), level, subject, text, ...data };
    fs.appendFileSync(files.alerts, JSON.stringify(a) + '\n');
    log('alert', { level, subject, text });
    if (alertOut) return alertOut(a);
    if (cfg.alert.command) spawnSync(cfg.alert.command, { shell: true, input: JSON.stringify(a), timeout: 30000 });
    const tg = cfg.alert.telegram;
    if (tg && tg.chatId && process.env[tg.tokenEnv || 'GUARDIAN_TELEGRAM_TOKEN']) {
      try {
        await fetch(`https://api.telegram.org/bot${process.env[tg.tokenEnv || 'GUARDIAN_TELEGRAM_TOKEN']}/sendMessage`, { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: tg.chatId, text: `Guardian ${level}: ${text}` }) });
      } catch (e) { log('alert not delivered', { channel: 'telegram', error: e.message }); }
    }
    if (parlons) {
      try { const r = await parlons.send(alertText(a)); log('alert sent', { channel: 'parlons', subject, state: r.state }); }
      catch (e) { log('alert not delivered', { channel: 'parlons', subject, error: e.message }); }
    }
  }

  const unspent = async (r, addr) => (await r('coins address:' + addr)).filter(c => same(c.address, addr) && !c.spent);

  /** Builds, checks and (only when posting) posts one transaction. Returns what happened, for the log. */
  async function act(spec, tip, label) {
    const signer = cfg.publicKey || (cfg.seat != null ? keys.guardians[cfg.seat] : null);
    if (!signer) return { done: 'not built', why: 'no guardian key or seat configured (watch only)' };
    const check = scriptCheck(spec, { signers: [signer], block: tip + 1 });
    const summary = { kind: spec.kind, inputs: spec.inputs.map(c => c.coinid), scripts: check.ok, detail: check.inputs };
    if (!check.ok) return { done: 'refused by the scripts offline', ...summary };
    if (!posting) return { done: 'would post (dry run)', ...summary };
    return { done: 'posted', ...summary, ...(await postOnNode(spec, label)) };
  }

  // Posting path (never used tonight): the node builds the transaction from the same spec, adds proofs, the guardian's
  // key signs once (write-ahead WOTS journal first), the node's own txncheck must pass all four checks, then txnpost.
  async function postOnNode(spec, label) {
    const id = 'guardian_' + label.replace(/[^a-z0-9]/gi, '_').slice(0, 40);
    await rpc('txndelete id:' + id).catch(() => {});
    try {
      await rpc('txncreate id:' + id);
      for (const c of spec.inputs) await rpc(`txninput id:${id} coinid:${c.coinid}`);
      for (const o of spec.outputs) await rpc(`txnoutput id:${id} amount:${o.amount} address:${o.address} tokenid:${o.tokenid} storestate:${o.storestate}`);
      for (const [p, v] of Object.entries(spec.state).sort(([a], [b]) => a - b)) await rpc(`txnstate id:${id} port:${p} value:${v}`);
      await rpc('txnbasics id:' + id);
      const pre = (await rpc('txncheck id:' + id)).valid || {};
      if (!(pre.basic && pre.mmrproofs)) return { posted: false, valid: pre };
      // The one signature, only at or above the journal's floor for this key (wots-guard.mjs).
      const keyUses = await wotsGuard(files.journal).guardedSign({ rpc, pub: cfg.publicKey, node: cfg.node, txn: id, purpose: 'guardian ' + spec.kind,
        sign: () => rpc(`txnsign id:${id} publickey:${cfg.publicKey}`) });
      const v = (await rpc('txncheck id:' + id)).valid || {};
      if (!(v.basic && v.signatures && v.mmrproofs && v.scripts)) return { posted: false, valid: v, keyUses };
      const r = await rpc(`txnpost id:${id}`);
      return { posted: true, txpowid: r && (r.txpowid || r.body?.txpowid), keyUses };
    } finally { await rpc('txndelete id:' + id).catch(() => {}); }
  }

  async function pass() {
    const out = { actions: [] };
    let tip, head, copies, reqs, cont;
    try {
      tip = Number((await rpc('status')).chain.block);
      head = (await unspent(rpc, C.head.address)).find(c => same(c.tokenid, keys.sealToken));
      copies = (await unspent(rpc, C.copy.address)).filter(c => same(c.tokenid, keys.sealToken));
      reqs = await unspent(rpc, C.request.address);
      cont = await unspent(rpc, C.contested.address);
    } catch (e) {
      // Fails closed in the only way a blind guardian can: its owner hears at once.
      await alert('urgent', 'node', `cannot read the Minima node: ${e.message}. The guardian is blind until it can.`);
      save(); return { ...out, blind: true };
    }
    if (!head) { await alert('urgent', 'head', 'the seal head is not visible: does the node track the R2T5 scripts?'); save(); return { ...out, blind: true }; }
    const hp = portsOf(head);
    out.tip = tip; out.seal = Number(hp[21]); out.frozen = hp[27] === '1';

    // A second source must show the same head and the same open requests.
    if (rpc2) {
      try {
        const h2 = (await unspent(rpc2, C.head.address)).find(c => same(c.tokenid, keys.sealToken));
        const ids = l => l.map(c => core.norm(c.coinid)).sort().join();
        const r2 = [...await unspent(rpc2, C.request.address), ...await unspent(rpc2, C.contested.address)];
        if (!h2 || !same(h2.coinid, head.coinid) || ids(r2) !== ids([...reqs, ...cont])) await alert('urgent', 'sources', 'the two nodes disagree on the seal head or the open requests');
      } catch (e) { await alert('warning', 'node2', 'the second node cannot be read: ' + e.message); }
    }

    // Its own seat: the key the head holds there must be this guardian's.
    if (cfg.seat != null && cfg.publicKey && !same(hp[String(80 + cfg.seat)], cfg.publicKey))
      await alert('urgent', 'seat', `seat ${cfg.seat} no longer holds this guardian's key (an election?)`);

    // 1-3. Every open request and contested request.
    // Card coins this guardian already passed for exit (R2Checker refuses a second exit of the same coin).
    const exited = Object.values(st.requests).filter(r => r.class === 'good' && r.coinId).map(r => r.coinId);
    const open = [...reqs.map(c => ({ c, kind: 'request' })), ...cont.map(c => ({ c, kind: 'contested' }))];
    for (const { c, kind } of open) {
      const id = core.norm(c.coinid);
      if ((gen.labRequests || []).some(x => same(x, id))) continue;          // the deployment campaign's fixtures
      let rec = st.requests[id];
      const recheck = !rec || rec.class === 'wait' || rec.class === 'unknown' || (rec.class === 'bad' && !rec.confirmed && tip - rec.badSince >= cfg.confirmBlocks);
      if (recheck) {
        const v = checker(c.coinid, c.address, exited, files.seen);
        const cls = core.classify(v);
        rec = { ...(rec || { firstSeen: tip, created: Number(c.created) }), class: cls, code: v.code || null, detail: v.detail || null, checkedAt: tip, amount: v.amount || null, coinId: v.coinId || null,
          token: v.token ? (Object.entries(gen.tokens || {}).find(([, t]) => same(t, v.token))?.[0] || v.token) : null };
        if (cls === 'bad') { if (st.requests[id]?.class === 'bad') rec.confirmed = true; else rec.badSince = tip; }
        st.requests[id] = rec;
        log('checked', { request: id, kind, verdict: cls, code: rec.code, detail: rec.detail, block: tip });
      }
      rec.kind = kind; rec.open = true;
      const d = core.decideRequest({ coin: c, kind, rec, tip, gen: rules });
      if (d.action === 'alert') await alert('warning', 'unchecked ' + id, `request ${id} could not be checked: ${d.why}`);
      if (d.action === 'stop' && !rec.stopped) {
        const copy = copies.find(x => portsOf(x)[27] === '0');
        if (!copy) { log('stop waits', { request: id, why: 'no free unfrozen copy' }); continue; }
        const r = await act(core.stopSpec({ request: c, copy, contestedAddress: C.contested.address }), tip, 'stop_' + id.slice(2, 10));
        log('stop', { request: id, why: d.why, ...r });
        out.actions.push({ stop: id, ...r });
        if (r.done === 'posted' && r.posted) rec.stopped = tip;
        await alert('important', 'stop ' + id, `request ${id} found bad (${d.why}). Stop: ${r.done}.`);
      }
    }
    for (const [id, r] of Object.entries(st.requests)) if (r.open && !open.some(o => same(o.c.coinid, id))) { r.open = false; r.closedAt = tip; }

    // 4. A new Council seal: rebuild both roots from the guardian's own verdicts.
    const sealKey = hp[20] + '/' + hp[26];
    if (!st.seals[sealKey]) {
      // Only requests that existed when the Council sealed (its heartbeat block, port 23) can be in this seal.
      const openIds = open.filter(o => Number(o.c.created) <= Number(hp[23])).map(o => core.norm(o.c.coinid)).filter(id => st.requests[id]);
      const good = openIds.filter(id => st.requests[id].class === 'good');
      const notGood = openIds.filter(id => st.requests[id].class !== 'good');
      const rej = openIds.filter(id => st.requests[id].class === 'bad');
      const a = await core.rebuildRoot({ root: hp[20], ids: good, others: notGood, fromSeal: Number(hp[21]) - 1, list: 'a', mmrRoot });
      const b = await core.rebuildRoot({ root: hp[26], ids: rej, others: openIds.filter(id => !rej.includes(id)), fromSeal: Number(hp[21]) - 1, list: 'r', mmrRoot });
      st.seals[sealKey] = { seenAt: tip, seal: Number(hp[21]), approved: a, rejected: b };
      log('seal checked', { seal: hp[21], approvedRoot: hp[20], approvedRebuilt: a.matched, approvedExtra: a.extra || [], rejectedRebuilt: b.matched, heartbeat: hp[23], payableFrom: hp[24] });
      // A request this guardian passed that the Council left out: censorship at worst, moves no money; the owner hears.
      if (a.matched && a.missing.length) await alert('warning', 'left out ' + sealKey, `seal ${hp[21]} leaves out ${a.missing.join(', ')}, which passed the package check here`);
      // A refusal of a request this guardian found good: in R2T5 that money stays locked in the vault and only a payment by
      // hand makes the person whole (the refusal gap, REFUSAL_GAP_FIX_2026-11-03.md). The owner hears at once.
      const goodRefused = b.matched ? b.extra.filter(id => st.requests[id]?.class === 'good') : [];
      if (goodRefused.length) await alert('urgent', 'refused good ' + sealKey, `seal ${hp[21]} refuses ${goodRefused.join(', ')}, which passed the package check here. In R2T5 a refused exit cannot be paid by the vault any more: the lab must pay it back by hand.`);
      const badApproved = a.matched ? a.extra.filter(id => st.requests[id]?.class === 'bad') : [];
      if (badApproved.length || !a.matched) {
        const why = badApproved.length ? `the Council approved ${badApproved.join(', ')}, which failed the package check`
          : 'the approved list of this seal cannot be rebuilt from what this guardian saw';
        // In R2T5 a stop does not hold back a Council approval: only a freeze (3 guardians) does, before port 24.
        let prepared = null;
        try { prepared = core.freezeSpec({ head, copies, block: tip, sealCopies: g.council.sealCopies }); } catch (e) { prepared = { error: e.message }; }
        fs.writeFileSync(path.join(dir, `freeze-prepared-${hp[21]}.json`), JSON.stringify({ why, payableFrom: hp[24], spec: prepared }, null, 1));
        await alert(badApproved.length ? 'urgent' : 'important', 'seal ' + sealKey, `${why}. It can pay from block ${hp[24]} (now ${tip}). A freeze needs 3 guardians before then; one is prepared in freeze-prepared-${hp[21]}.json for you to review and sign.`);
        out.actions.push({ freezeProposed: hp[21], why });
      }
    }

    // Council silent: the fallback stops after a day without a heartbeat; succession opens after 3 days.
    const silent = tip - Number(hp[23]);
    if (silent > g.council.heartbeatEveryBlocks * 2) await alert('important', 'silence', `no Council seal for ${silent} blocks (succession possible after ${gen.config.succession.afterSilenceBlocks})`);
    if (out.frozen) log('frozen', { since: hp[28] });
    // The guardian set's health: an election needs electMin guardians active (checked in within activeWindowBlocks).
    const ages = Array.from({ length: g.guardians.size }, (_, i) => tip - Number(hp[String(100 + i)]));
    out.activeSeats = ages.filter(a => a <= g.guardians.activeWindowBlocks).length;
    if (out.activeSeats < g.guardians.electMin) await alert('important', 'active seats', `only ${out.activeSeats} of ${g.guardians.size} guardian seats checked in within ${g.guardians.activeWindowBlocks} blocks; an election needs ${g.guardians.electMin}`);
    // About a week ahead (12,096 blocks): seats whose last check-in will then be outside the window.
    else if (ages.filter(x => x + 12096 <= g.guardians.activeWindowBlocks).length < g.guardians.electMin)
      await alert('warning', 'active seats', `within 7 days fewer than ${g.guardians.electMin} guardian seats will count as active, unless they check in`);

    // 5. Check-in.
    if (cfg.seat != null && !out.frozen) {
      const due = core.checkInDue({ head, seat: cfg.seat, tip, every: cfg.checkInEveryBlocks, councilHeartbeatEvery: Math.min(g.council.heartbeatEveryBlocks, 216) });
      const recentlyTried = st.lastCheckIn && tip - st.lastCheckIn.tip < g.council.heartbeatSlackBlocks;
      if (due.due && !recentlyTried) {
        let r;
        try { r = await act(core.checkInSpec({ head, copies, seats: [cfg.seat], block: tip, sealCopies: g.council.sealCopies }), tip, 'checkin_' + tip); }
        catch (e) { r = { done: 'waits', why: e.message }; }
        log('check-in', { why: due.why, ...r });
        out.actions.push({ checkIn: cfg.seat, ...r });
        if (r.done !== 'waits') st.lastCheckIn = { tip, done: r.done };
        const age = tip - Number(hp[String(100 + cfg.seat)]);
        if (age > g.guardians.inactiveAfterBlocks - 20000) await alert('urgent', 'checkin', `seat ${cfg.seat} last checked in ${age} blocks ago; an election can take it at ${g.guardians.inactiveAfterBlocks}`);
      }
    }
    st.lastPass = { tip, at: new Date().toISOString(), open: open.length };
    st.passes = (st.passes || 0) + 1; st.firstPass ??= st.lastPass.at;     // its cumulative watch, for the public status
    st.head = { seal: out.seal, frozen: out.frozen, activeSeats: out.activeSeats, seatCheckIn: cfg.seat != null ? Number(hp[String(100 + cfg.seat)]) : null };
    log('pass', { tip, seal: hp[21], open: open.length, frozen: out.frozen, actions: out.actions.length });
    save();
    return out;
  }
  return { pass, state: st, files, save };
}

export function verifyLog(file) {
  let prev = '0'.repeat(64), n = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const { hash, ...body } = JSON.parse(line);
    if (body.prev !== prev || sha(JSON.stringify(body)) !== hash) return { ok: false, line: n + 1 };
    prev = hash; n++;
  }
  return { ok: true, lines: n };
}

/* ---------- command line ---------- */
async function main() {
  const argv = process.argv.slice(2), cmd = argv[0];
  const opt = k => (i => (i >= 0 ? argv[i + 1] : null))(argv.indexOf(k));
  const cfg = loadConfig(opt('--config') || path.join(HERE, 'guardian.config.json'), opt('--node') ? { node: opt('--node') } : {});
  if (cmd === 'verify-log') { console.log(JSON.stringify(verifyLog(path.join(cfg.dataDir, 'guardian-log.jsonl')))); return; }
  const posting = argv.includes('--post') && cfg.allowPost === true && !!cfg.publicKey && cfg.seat != null;
  if (argv.includes('--post') && !posting) throw new Error('--post needs "allowPost": true, a publicKey and a seat in the config');
  const gen = JSON.parse(fs.readFileSync(cfg.generation, 'utf8'));
  const rpc = nodeRpc(cfg.node, { posting }), rpc2 = cfg.node2 ? nodeRpc(cfg.node2) : null;
  const workDir = cfg.dataDir; fs.mkdirSync(workDir, { recursive: true });
  const G = createGuardian({ cfg, gen, rpc, rpc2, posting,
    checker: r2Checker(cfg, gen, cfg.node),
    scriptCheck: (spec, o) => offline.scriptCheck(spec, { ...o, contracts: gen.contracts, cfg, workDir }),
    mmrRoot: async leaves => (await rpc(`mmrcreate nodes:${JSON.stringify(leaves)}`)).root.data });
  console.log(`guardian: ${posting ? 'POSTING' : 'dry run'}, node ${cfg.node}, ${cfg.publicKey ? 'seat ' + cfg.seat : 'watch only'}`);
  for (;;) {
    const r = await G.pass().catch(e => ({ error: e.message }));
    console.log(new Date().toISOString(), JSON.stringify(r));
    if (publishDue(G.state, cfg)) {
      const p = publishLog({ cfg, st: G.state, logFile: G.files.log });
      G.state.lastPublish = { at: new Date().toISOString(), ...p }; G.save();
      console.log('publish:', JSON.stringify(p));
      if (!['pushed', 'committed', 'nothing new'].includes(p.done)) console.error('publish failed: ' + (p.why || p.done));
    }
    if (cmd !== 'watch' || argv.includes('--once')) return;
    await sleep(Math.min(cfg.passSeconds, 3600) * 1000);
  }
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exit(1); });
