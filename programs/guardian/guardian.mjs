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
 *   node guardian.mjs sign-release <file> --post      R2T6: this guardian's signature on a release or overrule
 *   node guardian.mjs stop <request id> --post        stops one open request by hand (rehearsal, owner's judgement)
 *   node guardian.mjs fallback <request id> --post    R2T6: the 3-day fallback of one request, unsigned
 *   node guardian.mjs checkin|freeze|unfreeze --seats 0,1,2 [--post]   a head act by hand, seats whose keys are on this node
 */
import fs from 'node:fs';
import net from 'node:net';
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
const WRITES = new Set(['keys', 'txncreate', 'txninput', 'txnoutput', 'txnstate', 'txnscript', 'txnbasics', 'txnsign', 'txncheck', 'txnpost', 'txndelete', 'txnimport', 'txnexport', 'txnlist']);
export function nodeRpc(url, { posting = false } = {}) {
  return async cmd => {
    const verb = cmd.trim().split(/\s/)[0];
    if (!READS.has(verb) && !(posting && WRITES.has(verb))) throw new Error(`refused (${posting ? 'outside the recipe' : 'dry run: reads only'}): ${verb}`);
    if (verb === 'txnsign' && /publickey:auto/.test(cmd)) throw new Error('the guardian signs with its own key only');
    // Long commands (a release's record proofs, 966 bytes each) go as a raw POST: Minima answers fetch()'s POST with []
    // (its headers), as the approvers' program and the box's door found.
    const j = cmd.length > 1800 ? await rawPost(url, cmd) : await (await fetch(url + '/' + encodeURIComponent(cmd))).json();
    if (!j.status) throw new Error(`node refused ${verb}: ${j.error || 'no reason'}`);
    return j.response;
  };
}

function rawPost(url, command) {
  const u = new URL(url), body = Buffer.from(command);
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: u.hostname, port: Number(u.port) }), chunks = [];
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('RPC timeout')); }, 180000);
    sock.on('connect', () => { sock.write(`POST / HTTP/1.1
Host: ${u.hostname}
Content-Type: text/plain
Content-Length: ${body.length}
Connection: close

`); sock.end(body); });
    sock.on('data', c => chunks.push(c)); sock.on('error', e => { clearTimeout(timer); reject(e); });
    sock.on('close', () => { clearTimeout(timer); try { const t = Buffer.concat(chunks).toString(); resolve(JSON.parse(t.slice(t.indexOf('{')).trim())); } catch (e) { reject(e); } });
  });
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
export function createGuardian({ cfg, gen, rpc, rpc2 = null, checker, scriptCheck, mmrRoot, alertOut = null, posting = false, r6 = null, recordTree = null, mmrProofs = null }) {
  const C = gen.contracts, keys = gen.keys, g = gen.config;
  const rules = { fallbackWaitBlocks: g.fallback.waitBlocks, confirmBlocks: cfg.confirmBlocks, failClosedBlocks: cfg.failClosedBlocks };
  const dir = cfg.dataDir; fs.mkdirSync(dir, { recursive: true });
  const files = { state: path.join(dir, 'state.json'), log: path.join(dir, 'guardian-log.jsonl'), alerts: path.join(dir, 'alerts.jsonl'),
    seen: path.join(dir, 'seen-hops.txt'), journal: cfg.wotsJournal || path.join(dir, 'wots-journal.jsonl') };
  const st = fs.existsSync(files.state) ? JSON.parse(fs.readFileSync(files.state, 'utf8'))
    : { requests: {}, seals: {}, alerted: {}, lastCheckIn: null, lastPass: null };
  const save = () => { fs.writeFileSync(files.state + '.tmp', JSON.stringify(st, null, 1)); fs.renameSync(files.state + '.tmp', files.state); };
  // R2T6 (guardian-r2t6.mjs, loaded by main for an R2T6 generation): the paid-coin lists it keeps (st.records), the
  // approved lists of the ring slots it rebuilt (st.ring: root -> { ids, filler, sealedAt }), and its transactions.
  let R6 = null;
  if (r6) {
    st.records ||= {}; st.ring ||= {}; st.release ||= {};
    const book = r6.recordBook({ gen, lists: st.records, recordTree });
    R6 = { book, sp: r6.r2t6Specs(gen, book), prefix: 'R2T6 filler ' };
    files.exitLists = path.join(dir, 'exit-lists.json');
  }

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

  /** Builds, checks and (only when posting) posts one transaction. Returns what happened, for the log. `open`: a
   *  transaction no key signs (R2T6's 3-day fallback): checked with no signer, posted unsigned. */
  async function act(spec, tip, label, { open = false } = {}) {
    const signer = cfg.publicKey || (cfg.seat != null ? keys.guardians[cfg.seat] : null);
    if (!signer && !open) return { done: 'not built', why: 'no guardian key or seat configured (watch only)' };
    const check = scriptCheck(spec, { signers: open ? [] : [signer], block: tip + 1 });
    const summary = { kind: spec.kind, inputs: spec.inputs.map(c => c.coinid), scripts: check.ok, detail: check.inputs };
    if (!check.ok) return { done: 'refused by the scripts offline', ...summary };
    if (!posting) return { done: 'would post (dry run)', ...summary };
    const r = await postOnNode(spec, label, { sign: !open });
    return { done: r.posted ? 'posted' : 'not posted (the node check failed)', ...summary, ...r };
  }

  // Posting path (never used tonight): the node builds the transaction from the same spec, adds proofs, the guardian's
  // key signs once (write-ahead WOTS journal first), the node's own txncheck must pass all four checks, then txnpost.
  async function postOnNode(spec, label, { sign = true } = {}) {
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
      const keyUses = !sign ? null : await wotsGuard(files.journal).guardedSign({ rpc, pub: cfg.publicKey, node: cfg.node, txn: id, purpose: 'guardian ' + spec.kind,
        sign: () => rpc(`txnsign id:${id} publickey:${cfg.publicKey}`) });
      const v = (await rpc('txncheck id:' + id)).valid || {};
      if (!(v.basic && v.signatures && v.mmrproofs && v.scripts)) return { posted: false, valid: v, keyUses };
      const r = await rpc(`txnpost id:${id}`);
      return { posted: true, txpowid: r && (r.txpowid || r.body?.txpowid), keyUses };
    } finally { await rpc('txndelete id:' + id).catch(() => {}); }
  }

  async function stopOne(c, id, rec, why, tip, copies, out) {
    let spec;
    try {
      if (R6) spec = R6.sp.stop(c, copies);
      else {
        const copy = copies.find(x => portsOf(x)[27] === '0');
        if (!copy) throw new Error('no free unfrozen copy');
        spec = core.stopSpec({ request: c, copy, contestedAddress: C.contested.address });
      }
    } catch (e) { log('stop waits', { request: id, why: e.message }); return; }
    const r = await act(spec, tip, 'stop_' + id.slice(2, 10));
    log('stop', { request: id, why, ...r });
    out.actions.push({ stop: id, ...r });
    if (r.done === 'posted' && r.posted) rec.stopped = tip;
    await alert('important', 'stop ' + id, `request ${id}: ${why}. Stop: ${r.done}.`);
  }

  /**
   * R2T6, every pass after the seal check:
   *   1. a request the Council approved (in a ring slot this guardian rebuilt) that it did not pass is stopped at once,
   *      bad or unchecked alike: the stop holds it until 5 guardians release it, a missed one pays 216 blocks after
   *      the seal is mined at the earliest;
   *   2. a contested coin it found good (a stop it now passes, or a refusal it disagrees with): the 5-guardian payout is
   *      prepared (path 1 from a slot the Council approved it in, else path 2 once 3 days old) and checked with five
   *      guardian keys named, for the owner and four other guardians to sign; before the final rejection;
   *   3. a request it found good that nobody paid or refused for 3 days: the fallback payout (no signature), while the
   *      Council's heartbeat is under a day old and the vault is not frozen; one per record shard per pass.
   */
  async function r2t6Work({ hp, tip, reqs, cont, copies, records, vault, out }) {
    const T = R6.sp.T, lists = await r6.ringLists(hp, st.ring, mmrProofs, T.RING);
    const inRing = id => Object.values(lists).some(l => l.ids.some(x => same(x, id)));
    for (const c of reqs) {
      const id = core.norm(c.coinid), rec = st.requests[id];
      if (!rec || rec.class === 'good' || rec.stopped || !inRing(id)) continue;
      await stopOne(c, id, rec, `the Council approved it and this guardian did not pass it (${rec.class}${rec.code ? ': ' + rec.code : ''})`, tip, copies, out);
    }
    const guardianKeys = keys.guardians, own = cfg.publicKey || (cfg.seat != null ? guardianKeys[cfg.seat] : null);
    const fiveNamed = [own, ...guardianKeys.filter(k => !same(k, own))].filter(Boolean).slice(0, g.guardians.release);
    for (const c of cont) {
      const id = core.norm(c.coinid), rec = st.requests[id];
      if (!rec || rec.class !== 'good') continue;
      const slot = T.slotFor(hp, lists, c, tip), from = T.fallbackFrom(c), finalFrom = T.finalRejectFrom(c);
      const prior = st.release[id];
      if (!slot && tip < from) {
        if (!prior) { st.release[id] = { waits: from }; log('release waits', { contested: id, from, finalRejectionFrom: finalFrom }); }
        continue;
      }
      const via = slot ? 1 : 2;
      if (prior && prior.path === via && prior.built && tip - prior.at < 72) continue;
      const spec = R6.sp.payout({ coin: c, path: via, slot, vault, copies, records, tip, kind: via === 1 ? 'release' : 'overrule' });
      if (spec.why) { log('release not built', { contested: id, path: via, why: spec.why }); st.release[id] = { path: via, at: tip, why: spec.why }; continue; }
      const check = scriptCheck(spec, { signers: fiveNamed, block: tip + 1 });
      const file = path.join(dir, `release-prepared-${id.slice(2, 10)}.json`);
      fs.writeFileSync(file, JSON.stringify({ contested: id, path: via, why: via === 1 ? 'a stopped coin the Council approved, which this guardian passes' : 'a contested coin this guardian passes, 3 days old',
        signaturesNeeded: g.guardians.release, finalRejectionFrom: finalFrom, scriptsWithFiveGuardians: check.ok, spec }, null, 1));
      st.release[id] = { path: via, at: tip, built: true, scripts: check.ok, file: path.basename(file) };
      log('release prepared', { contested: id, path: via, scripts: check.ok, finalRejectionFrom: finalFrom });
      out.actions.push({ releasePrepared: id, path: via, scripts: check.ok });
      await alert(tip > finalFrom - 1728 ? 'urgent' : 'important', 'release ' + id, `contested coin ${id} passes the package check here. Its payout (${via === 1 ? 'the Council approved it' : 'overrule'}) needs ${g.guardians.release} guardian signatures and is prepared in ${path.basename(file)}${check.ok ? '' : ' (BUT the scripts refused it offline: see the file)'}. The Council's final rejection is possible from block ${finalFrom} (now ${tip}).`);
    }
    if (hp[27] !== '0' || tip - Number(hp[23]) > g.fallback.heartbeatMaxAgeBlocks - 10) return;
    const shardsUsed = new Set();
    for (const c of reqs) {
      const id = core.norm(c.coinid), rec = st.requests[id];
      if (!rec || rec.class !== 'good' || rec.stopped || tip < T.fallbackFrom(c) || inRing(id) || (rec.fallback && tip - rec.fallback < 72)) continue;
      const p = portsOf(c), shard = R6.book.name(p[13]) + '/' + r6.shardOf(p[11], R6.sp.shards);
      if (shardsUsed.has(shard)) continue;
      const spec = R6.sp.payout({ coin: c, path: 2, vault, copies, records, tip, kind: 'fallback' });
      if (spec.why) { log('fallback not built', { request: id, why: spec.why }); rec.fallback = tip; continue; }
      const r = await act(spec, tip, 'fallback_' + id.slice(2, 10), { open: true });
      log('fallback', { request: id, why: 'passed here, 3 days without a payout or a refusal', ...r });
      out.actions.push({ fallback: id, ...r });
      rec.fallback = tip; shardsUsed.add(shard);
      await alert('important', 'fallback ' + id, `request ${id} passed here and was neither paid nor refused for 3 days. Fallback payout: ${r.done}.`);
    }
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

    // R2T6: the paid-coin lists follow the record coins; a shard out of step is caught up from published lists, and
    // only a list that rebuilds the chain's root is taken.
    let records = [], vault = [];
    if (R6) {
      try {
        records = (await unspent(rpc, C.record.address)).filter(c => same(c.tokenid, keys.recordToken));
        vault = await unspent(rpc, C.vault.address);
        const behind = R6.book.follow(records);
        if (behind.length) {
          const r = await r6.catchUp(R6.book, behind, (cfg.r2t6 && cfg.r2t6.listSources) || []);
          for (const a of r.adopted) log('paid-coin list caught up', { token: a.token, shard: a.shard, from: a.adopted.from, keys: a.adopted.keys });
          if (r.left.length) await alert('important', 'exit lists', `the paid-coin lists of ${r.left.map(b => b.token + ' shard ' + b.shard).join(', ')} do not rebuild the chain's record root, and no source given has one that does: payouts by the guardians wait`);
        }
        const pub = JSON.stringify(R6.book.published().lists);
        if (pub !== st.publishedLists) { fs.writeFileSync(files.exitLists, JSON.stringify(R6.book.published(), null, 1)); st.publishedLists = pub; }
      } catch (e) { await alert('important', 'exit lists', 'the paid-coin lists could not be followed: ' + e.message); }
    }

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
      // R2T6: a contested coin is never stopped again (restopNeedsFreeze); it is released or overruled (r2t6Work).
      const d = R6 && kind === 'contested' ? { action: 'none', why: 'contested: released or overruled only' } : core.decideRequest({ coin: c, kind, rec, tip, gen: rules });
      if (d.action === 'alert') await alert('warning', 'unchecked ' + id, `request ${id} could not be checked: ${d.why}`);
      if (d.action === 'stop' && !rec.stopped) await stopOne(c, id, rec, d.why, tip, copies, out);
    }
    for (const [id, r] of Object.entries(st.requests)) if (r.open && !open.some(o => same(o.c.coinid, id))) { r.open = false; r.closedAt = tip; }

    // 4. A new Council seal: rebuild both roots from the guardian's own verdicts.
    const sealKey = hp[20] + '/' + hp[26];
    if (!st.seals[sealKey]) {
      // Only requests that existed when the Council sealed (its heartbeat block, port 23) can be in this seal.
      // Also those it saw close (paid, refused) since that heartbeat: a seal can approve a request paid before this pass.
      const openIds = [...new Set([...open.filter(o => Number(o.c.created) <= Number(hp[23])).map(o => core.norm(o.c.coinid)),
        ...Object.entries(st.requests).filter(([, r]) => !r.open && r.closedAt >= Number(hp[23]) && r.created <= Number(hp[23])).map(([id]) => id)])].filter(id => st.requests[id]);
      const good = openIds.filter(id => st.requests[id].class === 'good');
      const notGood = openIds.filter(id => st.requests[id].class !== 'good');
      const rej = openIds.filter(id => st.requests[id].class === 'bad');
      const prefix = R6 ? R6.prefix : undefined;
      const a = await core.rebuildRoot({ root: hp[20], ids: good, others: notGood, fromSeal: Number(hp[21]) - 1, list: 'a', mmrRoot, prefix });
      const b = await core.rebuildRoot({ root: hp[26], ids: rej, others: openIds.filter(id => !rej.includes(id)), fromSeal: Number(hp[21]) - 1, list: 'r', mmrRoot, prefix });
      st.seals[sealKey] = { seenAt: tip, seal: Number(hp[21]), approved: a, rejected: b };
      // R2T6: the approved list stays payable from its ring slot for 3 seals; the guardian keeps what it rebuilt.
      if (R6 && a.matched) st.ring[String(hp[20]).toUpperCase()] = { ids: a.leaves, filler: a.filler, sealedAt: Number(hp[23]) };
      log('seal checked', { seal: hp[21], approvedRoot: hp[20], approvedRebuilt: a.matched, approvedExtra: a.extra || [], rejectedRebuilt: b.matched, heartbeat: hp[23], payableFrom: hp[24] });
      // A request this guardian passed that the Council left out: censorship at worst, moves no money; the owner hears.
      if (a.matched && a.missing.length) await alert('warning', 'left out ' + sealKey, `seal ${hp[21]} leaves out ${a.missing.join(', ')}, which passed the package check here`);
      // A refusal of a request this guardian found good: in R2T5 that money stays locked in the vault and only a payment by
      // hand makes the person whole (the refusal gap, REFUSAL_GAP_FIX_2026-11-03.md). The owner hears at once.
      const goodRefused = b.matched ? b.extra.filter(id => st.requests[id]?.class === 'good') : [];
      if (goodRefused.length) await alert(R6 ? 'important' : 'urgent', 'refused good ' + sealKey, R6
        ? `seal ${hp[21]} refuses ${goodRefused.join(', ')}, which passed the package check here. Once refused (a contested coin), 5 guardians can overrule it 3 days later, until the Council's final rejection ${g.hardening.refusalOverrule} blocks after the refusal. This guardian prepares that payout.`
        : `seal ${hp[21]} refuses ${goodRefused.join(', ')}, which passed the package check here. In R2T5 a refused exit cannot be paid by the vault any more: the lab must pay it back by hand.`);
      const badApproved = a.matched ? a.extra.filter(id => st.requests[id]?.class === 'bad') : [];
      // R2T6: a stop holds a Council approval until 5 guardians release it, so what the Council approved and this
      // guardian did not pass is stopped below (every pass, while the approval is in the ring); the owner hears here.
      if (R6 && a.matched && !badApproved.length) { /* stops below */ }
      else if (badApproved.length || !a.matched) {
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

    if (R6) await r2t6Work({ hp, tip, reqs, cont, copies, records, vault, out });

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
  /**
   * R2T6: one guardian's turn in signing a release or overrule (a contested coin's payout, 5 guardian signatures). The
   * input is this guardian's own release-prepared-<id>.json (built on its node) or a file another guardian handed on
   * with the transaction so far ({ contested, path, data }). It signs only what it would build itself (sameRelease),
   * once (WOTS journal first), writes release-<id>-<n>of5.json for the next guardian, and posts at the 5th signature.
   * The files travel between owners by hand (Parlons!, mail): they hold no secret, only the transaction.
   */
  async function signRelease(file) {
    if (!R6) throw new Error('sign-release is for an R2T6 generation');
    if (!cfg.publicKey) throw new Error('sign-release needs this guardian\'s publicKey');
    const j = JSON.parse(fs.readFileSync(file, 'utf8')), id = core.norm(j.contested), via = Number(j.path);
    const rec = st.requests[id];
    if (!rec || rec.class !== 'good') return { done: 'refused', why: 'this guardian has not passed that contested coin (run watch first)' };
    const tip = Number((await rpc('status')).chain.block);
    const head = (await unspent(rpc, C.head.address)).find(c => same(c.tokenid, keys.sealToken)), hp = portsOf(head);
    const copies = (await unspent(rpc, C.copy.address)).filter(c => same(c.tokenid, keys.sealToken));
    const records = (await unspent(rpc, C.record.address)).filter(c => same(c.tokenid, keys.recordToken));
    const vault = await unspent(rpc, C.vault.address);
    const c = (await unspent(rpc, C.contested.address)).find(x => same(x.coinid, id));
    if (!c) return { done: 'refused', why: 'the contested coin is not unspent on this node' };
    R6.book.follow(records);
    const T = R6.sp.T, slot = via === 1 ? T.slotFor(hp, await r6.ringLists(hp, st.ring, mmrProofs, T.RING), c, tip) : null;
    if (via === 1 && !slot) return { done: 'refused', why: 'no ring slot this guardian rebuilt holds it payable now' };
    if (via === 2 && tip < T.fallbackFrom(c)) return { done: 'refused', why: 'not 3 days old yet' };
    const spec = R6.sp.payout({ coin: c, path: via, slot, vault, copies, records, tip, kind: via === 1 ? 'release' : 'overrule' });
    if (spec.why) return { done: 'refused', why: spec.why };
    const tid = 'guardian_release_' + id.slice(2, 10);
    await rpc('txndelete id:' + tid).catch(() => {});
    try {
      if (j.data) {
        await rpc(`txnimport id:${tid} data:${j.data}`);
        const l = await rpc('txnlist id:' + tid), txn = (Array.isArray(l) ? l[0] : l).transaction;
        const rec6 = spec.inputs[spec.inputs.length - 1];
        const same6 = r6.sameRelease(txn, spec, gen, { tip, prev41: portsOf(rec6)[41] });
        if (!same6.ok) { log('release refused', { contested: id, why: same6.why }); return { done: 'refused', why: same6.why }; }
      } else {
        await rpc('txncreate id:' + tid);
        for (const x of spec.inputs) await rpc(`txninput id:${tid} coinid:${x.coinid}`);
        for (const o of spec.outputs) await rpc(`txnoutput id:${tid} amount:${o.amount} address:${o.address} tokenid:${o.tokenid} storestate:${o.storestate}`);
        for (const [p, v] of Object.entries(spec.state).sort(([a], [b]) => a - b)) await rpc(`txnstate id:${tid} port:${p} value:${v}`);
        await rpc('txnbasics id:' + tid);
      }
      const keyUses = await wotsGuard(files.journal).guardedSign({ rpc, pub: cfg.publicKey, node: cfg.node, txn: tid, purpose: 'guardian ' + spec.kind + ' ' + id,
        sign: () => rpc(`txnsign id:${tid} publickey:${cfg.publicKey}`) });
      const chk = await rpc('txncheck id:' + tid), n = Number(chk.signatures) || 0, v = chk.valid || {};
      const ex = await rpc('txnexport id:' + tid), data = String(ex.data ?? ex);
      const outFile = path.join(dir, `release-${id.slice(2, 10)}-${n}of${g.guardians.release}.json`);
      fs.writeFileSync(outFile, JSON.stringify({ contested: id, path: via, signatures: n, data }, null, 1));
      log('release signed', { contested: id, path: via, signatures: n, keyUses });
      if (n < g.guardians.release) return { done: 'signed', signatures: n, file: outFile };
      if (!(v.basic && v.signatures && v.mmrproofs && v.scripts)) return { done: 'signed, not valid', signatures: n, valid: v, file: outFile };
      const r = await rpc('txnpost id:' + tid);
      log('release posted', { contested: id, path: via, txpowid: r && (r.txpowid || r.body?.txpowid) });
      return { done: 'posted', signatures: n, file: outFile };
    } finally { await rpc('txndelete id:' + tid).catch(() => {}); }
  }
  /** A stop by hand (rehearsal, or an owner's own judgement): this guardian stops one named open request, whatever the
   *  package check said. Same transaction, script check and WOTS journal as a stop the program decides. */
  async function stopByHand(reqId, why = 'stopped by hand') {
    const id = core.norm(reqId), tip = Number((await rpc('status')).chain.block);
    const c = (await unspent(rpc, C.request.address)).find(x => same(x.coinid, id));
    if (!c) return { done: 'refused', why: 'not an open request on this node' };
    const copies = (await unspent(rpc, C.copy.address)).filter(x => same(x.tokenid, keys.sealToken));
    const rec = st.requests[id] ||= { firstSeen: tip, created: Number(c.created), class: 'unknown' };
    const out = { actions: [] };
    await stopOne(c, id, rec, why, tip, copies, out);
    save();
    return out.actions[0] || { done: 'not built (see the log)' };
  }
  /** R2T6: the 3-day fallback of one named request, by hand (the rehearsal, or an owner who sees the approvers silent):
   *  request path 2, no signature, from the guardian's own paid-coin lists. The scripts allow it only once the request
   *  is fallback.waitBlocks old, the approvers' heartbeat under a day old and the vault not frozen; it is checked
   *  offline before the node sees it. */
  async function fallbackByHand(reqId) {
    if (!R6) throw new Error('fallback is for an R2T6 generation');
    const id = core.norm(reqId), tip = Number((await rpc('status')).chain.block);
    const c = (await unspent(rpc, C.request.address)).find(x => same(x.coinid, id));
    if (!c) return { done: 'refused', why: 'not an open request on this node' };
    if (tip < R6.sp.T.fallbackFrom(c)) return { done: 'refused', why: `not 3 days old yet: from block ${R6.sp.T.fallbackFrom(c)} (now ${tip})` };
    const copies = (await unspent(rpc, C.copy.address)).filter(x => same(x.tokenid, keys.sealToken));
    const records = (await unspent(rpc, C.record.address)).filter(x => same(x.tokenid, keys.recordToken));
    const vault = await unspent(rpc, C.vault.address);
    const behind = R6.book.follow(records);
    if (behind.length) { const r = await r6.catchUp(R6.book, behind, (cfg.r2t6 && cfg.r2t6.listSources) || []); if (r.left.length) return { done: 'refused', why: 'paid-coin lists out of step: ' + r.left.map(b => b.token + '/' + b.shard).join(', ') }; }
    const spec = R6.sp.payout({ coin: c, path: 2, vault, copies, records, tip, kind: 'fallback' });
    if (spec.why) return { done: 'refused', why: spec.why };
    const r = await act(spec, tip, 'fallback_' + id.slice(2, 10), { open: true });
    log('fallback', { request: id, why: 'by hand', ...r });
    save();
    return { fallback: id, ...r };
  }
  /**
   * A head act by hand, signed by several seats whose keys are on this node (the lab rehearsal: the nine lab keys sit on
   * one node; real guardians each sign on their own node, a later version). kind: checkin (any seats), freeze (3),
   * unfreeze (5). R2T6's freeze and its release are MAST branches: the branch script goes into the witness (txnscript).
   * Without posting: built and checked offline only. Each signature through the WOTS journal.
   */
  async function headActByHand(kind, seats) {
    const tip = Number((await rpc('status')).chain.block);
    const head = (await unspent(rpc, C.head.address)).find(c => same(c.tokenid, keys.sealToken));
    const copies = (await unspent(rpc, C.copy.address)).filter(c => same(c.tokenid, keys.sealToken));
    if (!head) return { done: 'refused', why: 'no seal head on this node' };
    const sealCopies = g.council.sealCopies, hp = portsOf(head);
    let spec;
    try {
      if (kind === 'checkin') spec = core.checkInSpec({ head, copies, seats, block: tip, sealCopies });
      else if (kind === 'freeze') { if (hp[27] !== '0') return { done: 'refused', why: 'already frozen' }; spec = core.freezeSpec({ head, copies, block: tip, sealCopies }); }
      else if (kind === 'unfreeze') { if (hp[27] !== '1') return { done: 'refused', why: 'not frozen' }; spec = core.unfreezeSpec({ head, copies, sealCopies }); }
      else throw new Error('kind: checkin, freeze or unfreeze');
    } catch (e) { return { done: 'refused', why: e.message }; }
    const act = Number(spec.state[29]);
    const branch = gen.branches ? Object.values(gen.branches).find(b => b.opener && (b.opener.match(/act EQ \d+/g) || []).includes('act EQ ' + act)) : null;
    if (branch) spec.witnessScripts = [branch.script];
    const signers = seats.map(i => keys.guardians[i]);
    const check = scriptCheck(spec, { signers, block: tip + 1 });
    const summary = { kind, seats, seal: hp[21], branch: branch ? branch.address : null, scripts: check.ok, detail: check.inputs };
    if (!check.ok || !posting) {
      const done = check.ok ? 'would post (dry run)' : 'refused by the scripts offline';
      log('head act', { ...summary, done });
      return { done, ...summary };
    }
    const id = 'guardian_' + kind + '_' + tip;
    await rpc('txndelete id:' + id).catch(() => {});
    try {
      await rpc('txncreate id:' + id);
      for (const c of spec.inputs) await rpc(`txninput id:${id} coinid:${c.coinid}`);
      for (const o of spec.outputs) await rpc(`txnoutput id:${id} amount:${o.amount} address:${o.address} tokenid:${o.tokenid} storestate:${o.storestate}`);
      for (const [p, v] of Object.entries(spec.state).sort(([x], [y]) => x - y)) await rpc(`txnstate id:${id} port:${p} value:${v}`);
      if (branch) await rpc(`txnscript id:${id} scripts:${JSON.stringify({ [branch.script]: '' })}`);
      await rpc('txnbasics id:' + id);
      const pre = (await rpc('txncheck id:' + id)).valid || {};
      if (!(pre.basic && pre.mmrproofs)) return { done: 'not posted (the node check failed)', ...summary, valid: pre };
      const uses = [];
      for (const pub of signers) uses.push(await wotsGuard(files.journal).guardedSign({ rpc, pub, node: cfg.node, txn: id, purpose: 'guardian ' + kind,
        sign: () => rpc(`txnsign id:${id} publickey:${pub}`) }));
      const v = (await rpc('txncheck id:' + id)).valid || {};
      if (!(v.basic && v.signatures && v.mmrproofs && v.scripts)) { log('head act', { ...summary, done: 'not posted', valid: v }); return { done: 'not posted (the node check failed)', ...summary, valid: v, keyUses: uses }; }
      const r = await rpc(`txnpost id:${id}`);
      const out = { done: 'posted', ...summary, txpowid: r && (r.txpowid || r.body?.txpowid), keyUses: uses };
      log('head act', out); save();
      return out;
    } finally { await rpc('txndelete id:' + id).catch(() => {}); }
  }
  return { pass, signRelease, stopByHand, fallbackByHand, headActByHand, state: st, files, save };
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
  if ((cmd === 'sign-release' || cmd === 'stop' || cmd === 'fallback') || (['checkin', 'freeze', 'unfreeze'].includes(cmd) && argv.includes('--post'))) {
    if (!(argv.includes('--post') && cfg.allowPost === true && cfg.publicKey)) throw new Error('sign-release signs: it needs --post, "allowPost": true and a publicKey');
  }
  if (cmd === 'verify-log') { console.log(JSON.stringify(verifyLog(path.join(cfg.dataDir, 'guardian-log.jsonl')))); return; }
  const posting = argv.includes('--post') && cfg.allowPost === true && !!cfg.publicKey && cfg.seat != null;
  if (argv.includes('--post') && !posting) throw new Error('--post needs "allowPost": true, a publicKey and a seat in the config');
  const gen = JSON.parse(fs.readFileSync(cfg.generation, 'utf8'));
  const rpc = nodeRpc(cfg.node, { posting }), rpc2 = cfg.node2 ? nodeRpc(cfg.node2) : null;
  const workDir = cfg.dataDir; fs.mkdirSync(workDir, { recursive: true });
  // R2T6 brings its own module (it imports r2t6-tx.mjs from the approvers' folder); R2T5 never loads it.
  const r6 = (gen.config?.generation?.name || gen.generation) === 'R2T6' ? await import('./guardian-r2t6.mjs') : null;
  const G = createGuardian({ cfg, gen, rpc, rpc2, posting, r6,
    recordTree: r6 ? r6.recordTreeTool({ ...offline.javaPaths(cfg), workDir }) : null,
    mmrProofs: async leaves => (await rpc(`mmrcreate nodes:${JSON.stringify(leaves)}`)).nodes.map(n => n.proof),
    checker: r2Checker(cfg, gen, cfg.node),
    scriptCheck: (spec, o) => offline.scriptCheck(spec, { ...o, contracts: gen.contracts, cfg, workDir }),
    mmrRoot: async leaves => (await rpc(`mmrcreate nodes:${JSON.stringify(leaves)}`)).root.data });
  if (cmd === 'sign-release') { console.log(JSON.stringify(await G.signRelease(argv[1]))); return; }
  if (['checkin', 'freeze', 'unfreeze'].includes(cmd)) { const seats = String(opt('--seats') || cfg.seat).split(',').map(Number); console.log(JSON.stringify(await G.headActByHand(cmd, seats))); return; }
  if (cmd === 'fallback') { console.log(JSON.stringify(await G.fallbackByHand(argv[1]))); return; }
  if (cmd === 'stop') { console.log(JSON.stringify(await G.stopByHand(argv[1], opt('--why') || 'stopped by hand'))); return; }
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
