/*
 * cosign.mjs: one approver machine's side of a seal signed across several machines (DESIGN.md, 2026-11-03).
 *
 * A proposer sends { data: txnexport hex, approve: [coin ids], reject: [coin ids] }. This machine imports it on its own
 * node, checks it against its own view (its node's head and copies, its own checker's verdicts, its owner's settings),
 * and only then signs with its own keys, each signature guarded by its own WOTS journal. Nothing here trusts the
 * proposer: a message can only make this machine sign what its own node and checker agree with.
 *
 *   const r = await checkProposal({ rpc, id, prop, verdicts, view, cfg });   // { ok, why, txn }
 *   if (r.ok) await signWith({ rpc, id, keys, guard, purpose });            // then txnexport and send back
 */
import { createHash } from 'node:crypto';

const sha = x => createHash('sha256').update(x).digest('hex').toUpperCase();
const same = (a, b) => String(a).toUpperCase() === String(b).toUpperCase();
const portsOf = st => Object.fromEntries((st || []).map(p => [Number(p.port), String(p.data)]));

/** The roots the approvers' program writes (r2t5-council.mjs mmr(); r2t6-tx.mjs listLeaves with 'R2T6 filler '): the
 *  sorted ids, then one filler for that seal. */
export async function listRoot(rpc, ids, tag, filler = 'R2T5 filler ') {
  const leaves = [...ids, '0x' + sha(filler + tag)];
  return (await rpc(`mmrcreate nodes:${JSON.stringify(leaves)}`)).root.data;
}

/**
 * prop:     { approve, reject } as sent by the proposer.
 * verdicts: { [coinid]: 'approve' | 'reject' } from this machine's own checker.
 * view:     { head, copies, tip } as this machine's node sees them (head and copies: unspent coins with state).
 * cfg:      { headAddress, copyAddress, sealToken, payoutDelay, maxHeartbeatAge, keyFirst, keyLast, plannedKeys,
 *             txpowLimit, signatureBytes, signaturesToCome }
 */
export async function checkProposal({ rpc, id, prop, verdicts, view, cfg }) {
  const no = why => ({ ok: false, why });
  const listed = await rpc(`txnlist id:${id}`);
  const txn = (Array.isArray(listed) ? listed[0] : listed).transaction;
  const st = portsOf(txn.state), hp = portsOf(view.head.state);

  // 1. It spends the head and copies this node sees unspent, and gives them back with the seal token.
  // The head first, then the copies in any order (another node may list them in another order).
  const want = [view.head.coinid, ...view.copies.map(c => c.coinid)];
  const copyIds = new Set(view.copies.map(c => String(c.coinid).toUpperCase()));
  if (txn.inputs.length !== want.length || !same(txn.inputs[0].coinid, view.head.coinid)
    || new Set(txn.inputs.slice(1).map(c => String(c.coinid).toUpperCase())).size !== copyIds.size
    || !txn.inputs.slice(1).every(c => copyIds.has(String(c.coinid).toUpperCase()))) return no('inputs are not the head and copies this node sees');
  if (txn.outputs.length !== want.length) return no('outputs do not give back the head and every copy');
  const [ho, ...co] = txn.outputs;
  if (!same(ho.address, cfg.headAddress) || !same(ho.tokenid, cfg.sealToken) || !ho.storestate) return no('the head is not given back');
  if (!co.every(o => same(o.address, cfg.copyAddress) && same(o.tokenid, cfg.sealToken) && o.storestate)) return no('a copy is not given back');

  // 2. Every approval and rejection is one this machine's own checker reached; sorted; no id in both.
  const sorted = a => a.every((x, i) => i === 0 || String(a[i - 1]).toUpperCase() < String(x).toUpperCase());
  if (!sorted(prop.approve) || !sorted(prop.reject)) return no('a list is not sorted');
  for (const x of prop.approve) if (verdicts[x] !== 'approve') return no(`approves ${x.slice(0, 12)}, which this machine did not approve`);
  for (const x of prop.reject) if (verdicts[x] !== 'reject') return no(`rejects ${x.slice(0, 12)}, which this machine did not reject`);

  // 3. The roots are this node's own mmrcreate of those lists.
  const prev = hp[21];
  if (!same(st[20], await listRoot(rpc, prop.approve, 'a' + prev, cfg.filler))) return no('the approved root is not the root of the approved list');
  if (!same(st[26], await listRoot(rpc, prop.reject, 'r' + prev, cfg.filler))) return no('the rejected root is not the root of the rejected list');

  // 4. A seal (act 1), numbered on from the head, with a fresh heartbeat and the payout delay.
  if (st[29] !== '1') return no('not a seal (port 29)');
  if (Number(st[21]) !== Number(prev) + 1) return no('the seal number is not the head\'s + 1');
  const hb = Number(st[23]);
  if (!(hb <= view.tip && hb >= view.tip - cfg.maxHeartbeatAge)) return no(`heartbeat ${hb} is not within ${cfg.maxHeartbeatAge} blocks of this node's tip ${view.tip}`);
  if (Number(st[24]) !== hb + cfg.payoutDelay) return no('payable-from is not heartbeat + the payout delay');

  // 6. The approver keys stay as they are, unless the change is exactly the one this machine's owner listed.
  for (let p = cfg.keyFirst; p <= cfg.keyLast; p++) {
    const planned = cfg.plannedKeys && cfg.plannedKeys[p];
    if (planned ? !same(st[p], planned) : !same(st[p], hp[p])) return no(`approver key port ${p} changed without the owner's listed change`);
  }

  // 7. R2T6 (cfg.r2t6 = { ring, successionToBackup }): the ring moves on by exactly this seal; a scheduled succession is
  // cleared only while not frozen; every other port is the head's own, so nothing else can ride on a seal (a proposed
  // change, a key, the vault address, the succession count: each needs its own act and its own check).
  if (cfg.r2t6) {
    const R = cfg.r2t6.ring, moved = new Set(['20', '21', '23', '24', '26', '29']);
    for (let i = 0; i < R; i++) {
      moved.add(String(120 + i)); moved.add(String(130 + i));
      const [root, at] = i === 0 ? [st[20], st[23]] : [hp[120 + i - 1], hp[130 + i - 1]];
      if (!same(st[120 + i], root) || String(st[130 + i]) !== String(at)) return no(`ring slot ${i} is not moved on by this seal`);
    }
    if (cfg.r2t6.successionToBackup && '58' in hp) {
      moved.add('58');
      if (String(st[58]) !== (hp[27] === '0' ? '0' : String(hp[58]))) return no('port 58 (a scheduled succession) is not cleared while working, or not kept while frozen');
    }
    for (const p of new Set([...Object.keys(hp), ...Object.keys(st)])) if (!moved.has(String(p)) && !same(st[p], hp[p])) return no(`port ${p} changed on a seal`);
  }

  // 5. It still fits under the TxPoW limit with the signatures to come (the quorum less those already on it: the
  // proposer's own, and any peer's before this one).
  const ex = await rpc(`txnexport id:${id}`);
  const have = Number((await rpc(`txncheck id:${id}`)).signatures) || 0;
  const bytes = (String(ex.data ?? ex).length - 2) / 2 + Math.max(0, cfg.signaturesToCome - have) * cfg.signatureBytes;
  if (bytes > cfg.txpowLimit) return no(`too large: about ${bytes} bytes with the signatures to come`);
  return { ok: true, txn, bytes };
}

/**
 * The signer's service (first transport: HTTP between named machines; Maxima later, DESIGN.md). POST /seal with
 * { data, approve, reject }: the transaction is imported on this machine's own node under a fresh id, checked
 * (checkProposal), signed with this machine's keys and sent back as { data } or refused as { refused: why }.
 * One signature per seal number: a second, different transaction for a number already signed is refused, so a proposer
 * cannot gather signatures on two seals and pick one.
 *   getView() -> { head, copies, tip }; getVerdicts() -> { coinid: verdict }; signed: a persistent object.
 */
export async function serveSigner({ port, host = '127.0.0.1', rpc, getView, getVerdicts, cfg, keys, guard, signed, save = () => {}, log = () => {} }) {
  const http = await import('node:http');
  let busy = Promise.resolve();
  const handle = async (body) => {
    const prop = JSON.parse(body);
    if (!/^[0-9a-fA-Fx]+$/.test(String(prop.data || ''))) return { refused: 'no transaction data' };
    const id = 'cosign_in';
    await rpc(`txndelete id:${id}`).catch(() => {});
    await rpc(`txnimport id:${id} data:${prop.data}`);
    try {
      const listed = await rpc(`txnlist id:${id}`);
      const txn = (Array.isArray(listed) ? listed[0] : listed).transaction;
      const number = portsOf(txn.state)[21];
      if (signed[number] && !same(signed[number], txn.transactionid)) return { refused: `already signed another transaction for seal ${number}` };
      const r = await checkProposal({ rpc, id, prop, verdicts: await getVerdicts(), view: await getView(), cfg });
      if (!r.ok) { log('cosign refused', { number, why: r.why }); return { refused: r.why }; }
      // Exactly the quorum, never more (register row 41, founder's yes 2026-11-07): seal 11 carried 8 signatures when two
      // 4-key machines both signed in full, 94% of the TxPoW limit. This machine counts what is already on the
      // transaction itself and adds only what the quorum still needs (cfg.signaturesToCome is the quorum).
      const quorum = Number(cfg.signaturesToCome) || 0;
      const have = Number((await rpc(`txncheck id:${id}`)).signatures) || 0;
      const use = quorum ? keys.slice(0, Math.max(0, quorum - have)) : keys;
      if (!use.length) return { refused: `seal ${number} already carries the quorum (${have} of ${quorum})` };
      signed[number] = txn.transactionid; save();
      await signWith({ rpc, id, keys: use, guard, purpose: 'seal ' + number });
      const ex = await rpc(`txnexport id:${id}`);
      log('cosign signed', { number, keys: use.length, had: have });
      return { data: String(ex.data ?? ex) };
    } finally { await rpc(`txndelete id:${id}`).catch(() => {}); }
  };
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/seal') { res.writeHead(404); return res.end(); }
    let body = '';
    req.on('data', d => { body += d; if (body.length > 400000) req.destroy(); });
    req.on('end', () => {
      // One proposal at a time: the node's transaction id and the WOTS journal are shared.
      busy = busy.then(() => handle(body)).catch(e => ({ refused: 'error: ' + e.message }))
        .then(out => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out)); });
    });
  });
  await new Promise(r => server.listen(port, host, r));
  return server;
}

/**
 * The proposer's side: the transaction (already signed with the proposer's own keys) goes to each peer in turn, and each
 * returned export replaces it on the proposer's node, until the quorum of signatures is on it. Returns the count.
 */
export async function collectSignatures({ rpc, id, prop, peers, quorum, log = () => {}, timeoutMs = 120000 }) {
  const count = async () => Number((await rpc(`txncheck id:${id}`)).signatures);
  const tid = async () => { const l = await rpc(`txnlist id:${id}`); return (Array.isArray(l) ? l[0] : l).transaction.transactionid; };
  const mine = await tid();
  for (const peer of peers) {
    if (await count() >= quorum) break;
    const data = String((x => x.data ?? x)(await rpc(`txnexport id:${id}`)));
    let out;
    try {
      const res = await fetch(peer.url.replace(/\/$/, '') + '/seal', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data, approve: prop.approve, reject: prop.reject }), signal: AbortSignal.timeout(timeoutMs) });
      out = await res.json();
    } catch (e) { log('cosign peer unreachable', { peer: peer.name, error: e.message }); continue; }
    if (!out.data) { log('cosign peer refused', { peer: peer.name, why: out.refused }); continue; }
    await rpc(`txndelete id:${id}`);
    await rpc(`txnimport id:${id} data:${out.data}`);
    // A peer can only add signatures: a different transaction back is discarded and ours restored.
    if (!same(await tid(), mine) || !(await rpc(`txncheck id:${id}`)).valid.signatures) {
      log('cosign peer sent back something else: discarded', { peer: peer.name });
      await rpc(`txndelete id:${id}`);
      await rpc(`txnimport id:${id} data:${data}`);
      continue;
    }
    log('cosign peer signed', { peer: peer.name, signatures: await count() });
  }
  return count();
}

/** Signs with each of this machine's keys, each through its WOTS journal (wots-guard.mjs guardedSign). */
export async function signWith({ rpc, id, keys, guard, purpose, node = 'local' }) {
  const out = [];
  for (const pub of keys) out.push(await guard.guardedSign({ rpc, pub, node, txn: id, purpose, sign: () => rpc(`txnsign id:${id} publickey:${pub}`) }));
  return out;
}
