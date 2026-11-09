/*
 * The guardian's R2T6 part (R2T6_PLAN step 6, written 2026-11-05). guardian.mjs loads it when its generation file is
 * R2T6 (vault-shared, stables.config.json); R2T5 keeps guardian-core.mjs alone. What R2T6 changes for a guardian:
 *   - a stop holds a request until 5 guardians sign its payout (contested path 1: a ring slot the Council approved it
 *     in, sealed after the stop; path 2: 3 days after the stop, with or without the Council), so the stop is now the
 *     defence against a wrong Council approval, and the guardian stops anything the Council approves that it did not;
 *   - a refused request becomes a contested coin the guardians can overrule the same way (path 2), until the Council's
 *     final rejection (refusalOverrule, 7 days after the refusal);
 *   - a request the Council neither pays nor refuses can be paid by anyone after 3 days (request path 2, no signature),
 *     while the Council's heartbeat is under a day old and the vault is not frozen;
 *   - every payout inserts the card coin into its token's exit record (per shard, a sorted list in a Merkle tree), so
 *     each of those payouts needs the paid-coin lists. The guardian keeps its own from the chain (card review F5).
 * The transactions are r2t6-tx.mjs's: the functions the approvers' program and its offline test use.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { r2t6 } from '../approvers/r2t6/r2t6-tx.mjs';
import { same, norm, portsOf, amountOf } from './guardian-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const isR2T6 = gen => (gen.config?.generation?.name || gen.generation) === 'R2T6';

export const atoms = s => { const [a, b = ''] = String(s).split('.'); return BigInt(a) * 100000000n + BigInt(b.padEnd(8, '0').slice(0, 8)); };
export const decimal = n => { const t = (n % 100000000n).toString().padStart(8, '0').replace(/0+$/, ''); return (n / 100000000n) + (t ? '.' + t : ''); };
/** A card coin's key in the exit record (record.kiss: SUBSET(0 16 STATE(11))) and its shard (the first byte). */
export const keyOf = card => '0x' + String(card).replace(/^0x/i, '').slice(0, 32).toUpperCase();
export const shardOf = (card, shards) => Math.floor(parseInt(String(card).replace(/^0x/i, '').slice(0, 2), 16) / (256 / shards));

/** RecordTree.java (vault-shared/tools, copied into tools/), compiled once into the data folder. spec -> its JSON. */
export function recordTreeTool({ java, javac, jar, workDir, source = path.join(HERE, 'tools/RecordTree.java') }) {
  const bin = path.join(workDir, 'record-tree');
  return spec => {
    if (!fs.existsSync(path.join(bin, 'RecordTree.class'))) {
      fs.mkdirSync(bin, { recursive: true });
      const c = spawnSync(javac, ['-cp', jar, '-d', bin, source], { encoding: 'utf8' });
      if (c.status !== 0) throw new Error('RecordTree compile: ' + c.stderr.slice(0, 300));
    }
    const f = path.join(bin, `spec-${process.pid}.json`);
    fs.writeFileSync(f, JSON.stringify(spec));
    const r = spawnSync(java, ['-cp', jar + path.delimiter + bin, 'RecordTree', f], { encoding: 'utf8', maxBuffer: 1 << 24 });
    if (r.status !== 0) throw new Error('RecordTree: ' + r.stderr.slice(0, 300));
    return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
  };
}

/**
 * The paid-coin lists (card review F5): per token and shard, the card-coin keys in insertion order, which is what
 * rebuilds each record root (RecordTree). Followed from the chain: each record coin carries its last payout's state,
 * so port 11 names the key that payout inserted. A list is only ever taken (from the chain or from a published
 * exit-lists.json, the approvers' or another guardian's) when it rebuilds the root the chain shows, so no source is
 * trusted. Kept in lists (state.json's records), published as exit-lists.json in the approvers' format.
 */
export function recordBook({ gen, lists, recordTree }) {
  const cfg = gen.config, depth = cfg.exitRecord.depth;
  const name = tok => Object.keys(gen.tokens).find(k => same(gen.tokens[k], tok));
  const roots = {};                         // keys.join() -> root, so an unchanged shard costs no Java run
  const rootOf = keys => (roots[keys.join()] ??= recordTree({ depth, keys }).root);
  const entry = (n, s) => ((lists[n] ||= {})[s] ||= { keys: [] });

  /** Brings every shard in step with its record coin. Returns the shards still out of step: { token, shard, root }. */
  function follow(recordCoins) {
    const behind = [];
    for (const rc of recordCoins) {
      const p = portsOf(rc), n = name(p[39]), s = String(p[44]);
      if (!n) continue;
      const e = entry(n, s);
      if (e.root && same(e.root, p[40])) continue;
      if (same(rootOf(e.keys), p[40])) { e.root = p[40]; continue; }
      const k = p[11] ? keyOf(p[11]) : null;
      if (k && !e.keys.some(x => same(x, k)) && same(rootOf([...e.keys, k]), p[40])) { e.keys.push(k); e.root = p[40]; continue; }
      behind.push({ token: n, shard: s, root: p[40], have: e.keys.length });
    }
    return behind;
  }
  /** Takes a published list for one shard if, and only if, it rebuilds that shard's root on chain. */
  function adopt(n, s, keys, root) {
    const k = keys.map(keyOf);
    if (!same(rootOf(k), root)) return false;
    const e = entry(n, s); e.keys = k; e.root = root;
    return true;
  }
  const keysOf = (n, s) => entry(n, String(s)).keys;
  const inStep = (n, s, root) => same(rootOf(keysOf(n, s)), root);
  const paid = (n, card, shards) => keysOf(n, shardOf(card, shards)).some(x => same(x, keyOf(card)));
  const insertion = (n, s, key) => recordTree({ depth, keys: keysOf(n, s), insert: keyOf(key) });
  const published = () => ({ generation: 'R2T6', record: gen.contracts.record.address, depth, keyBytes: cfg.exitRecord.keyBytes, updated: new Date().toISOString(),
    note: 'Paid card coins per token and shard, in insertion order, kept by a guardian from the chain. Slot 0 is the sentinel; RecordTree.java rebuilds each record root.',
    lists: Object.fromEntries(Object.entries(lists).map(([n, sh]) => [n, Object.fromEntries(Object.entries(sh).map(([s, e]) => [s, e.keys]))])) });
  return { follow, adopt, keysOf, inStep, paid, insertion, published, name };
}

/** Reads published exit lists (a file path or an https URL) for the shards out of step; adopts what rebuilds. */
export async function catchUp(book, behind, sources = []) {
  const left = [];
  for (const b of behind) {
    let done = false;
    for (const src of sources) {
      try {
        const j = /^https?:/.test(src) ? await (await fetch(src, { signal: AbortSignal.timeout(20000) })).json() : JSON.parse(fs.readFileSync(src, 'utf8'));
        const keys = j.lists?.[b.token]?.[b.shard];
        if (Array.isArray(keys) && book.adopt(b.token, b.shard, keys, b.root)) { done = { from: src, keys: keys.length }; break; }
      } catch { /* the next source */ }
    }
    if (done) b.adopted = done; else left.push(b);
  }
  return { adopted: behind.filter(b => b.adopted), left };
}

/**
 * The R2T6 transactions as guardian specs ({ kind, inputs: coins, outputs, state }, as guardian.mjs's act() takes).
 * A payout picks its vault coins (one that covers it, else the largest up to maxVaultCoinsPerPayout), a free unfrozen
 * copy (a clean one first) and its shard's record coin, and inserts the card coin from the guardian's own lists.
 */
export function r2t6Specs(gen, book) {
  const cfg = gen.config, S = gen.contracts, T = r2t6(gen, cfg), shards = cfg.exitRecord.shardsPerToken;
  const byId = coins => Object.fromEntries(coins.map(c => [String(c.coinid).toUpperCase(), c]));
  const spec = (kind, tx, coins) => { const m = byId(coins); return { kind, inputs: tx.inputs.map(id => m[String(id).toUpperCase()]), outputs: tx.outputs, state: tx.state }; };
  const freeCopy = copies => copies.filter(c => portsOf(c)[27] === '0').sort((a, b) => T.isLarge(portsOf(a)) - T.isLarge(portsOf(b)))[0] || null;

  function stop(request, copies) {
    const copy = freeCopy(copies);
    if (!copy) throw new Error('no free unfrozen copy');
    return spec('stop', T.stopTx(request, portsOf(request), copy, portsOf(copy)), [request, copy]);
  }
  /** path 1 (slot from slotFor) or 2. Returns a spec, or { why } when it cannot be built now. */
  function payout({ coin, path, slot, vault, copies, records, tip, kind }) {
    const rs = portsOf(coin), n = book.name(rs[13]), s = shardOf(rs[11], shards);
    if (!n) return { why: 'token not in this generation' };
    if (book.paid(n, rs[11], shards)) return { why: 'card coin already in the exit record (paid before)' };
    const rec = records.find(c => same(portsOf(c)[39], rs[13]) && portsOf(c)[44] === String(s));
    if (!rec) return { why: `no record coin for ${n} shard ${s}` };
    if (!book.inStep(n, s, portsOf(rec)[40])) return { why: 'the paid-coin list is out of step' };
    const need = atoms(rs[12]), mine = vault.filter(c => same(c.tokenid, rs[13]));
    const one = mine.filter(c => atoms(amountOf(c)) >= need).sort((a, b) => (atoms(amountOf(a)) < atoms(amountOf(b)) ? -1 : 1))[0];
    const take = one ? [one] : [];
    if (!one) for (const c of [...mine].sort((a, b) => (atoms(amountOf(a)) > atoms(amountOf(b)) ? -1 : 1))) if (take.reduce((x, v) => x + atoms(amountOf(v)), 0n) < need && take.length < cfg.vault.maxVaultCoinsPerPayout) take.push(c);
    if (take.reduce((x, v) => x + atoms(amountOf(v)), 0n) < need) return { why: 'the vault coins do not cover it' };
    const copy = freeCopy(copies);
    if (!copy) return { why: 'no free unfrozen copy' };
    const tx = T.payoutTx({ rc: coin, rcState: rs, take: take.map(c => ({ ...c, tokenamount: amountOf(c) })), copy, copyState: portsOf(copy), rec, recState: portsOf(rec),
      slot, ins: book.insertion(n, s, rs[11]), t: tip, atoms, decimal, path });
    if (tx.overLimit) return { why: path === 1 ? 'the sealed approver limit for this shard is reached this period' : 'the fallback cap for this shard is reached this period' };
    return spec(kind, tx, [coin, ...take, copy, rec]);
  }
  return { T, stop, payout, freeCopy, shards };
}

/**
 * The approved lists of the ring slots, as the guardian rebuilt them (state.json's ring: root -> { ids, sealedAt }),
 * with proofs from mmrcreate (mmrProofs: leaves -> one proof per leaf), as slotFor wants them. Only roots still in the
 * head's ring are looked at.
 */
export async function ringLists(hp, ring, mmrProofs, RING) {
  const lists = {};
  for (let j = 0; j < RING; j++) {
    const root = String(hp[120 + j]).toUpperCase(), r = ring[root];
    if (!r || !r.ids.length) continue;
    const pr = await mmrProofs([...r.ids, r.filler]);
    lists[root] = { ids: r.ids, proofs: Object.fromEntries(r.ids.map((id, i) => [String(id).toUpperCase(), pr[i]])) };
  }
  return lists;
}
export { norm };

/**
 * Signing a release or overrule across guardians: a guardian signs a transaction handed to it only when it is exactly
 * the one it would build itself from its own view (r2t6Specs().payout): the same contested coin first, the same outputs
 * in order, the same state on every port, the vault coins at the vault address, the copy at the copy address and the
 * record coin of that shard last. `txn` is the node's txnlist transaction (inputs, outputs, state as the node lists them).
 * Returns { ok, why }.
 */
export function sameRelease(txn, spec, gen, { tip = null, prev41 = null } = {}) {
  const S = gen.contracts, no = why => ({ ok: false, why });
  const ins = txn.inputs || [], outs = txn.outputs || [];
  if (!ins.length || !same(ins[0].coinid, spec.inputs[0].coinid)) return no('not the payout of this contested coin');
  if (ins.length !== spec.inputs.length) return no('another number of inputs');
  const n = Number(spec.state[16]);
  for (let i = 1; i <= n; i++) if (!same(ins[i].address, S.vault.address) || !same(ins[i].tokenid, spec.state[13])) return no(`input ${i} is not a vault coin of the token`);
  if (!same(ins[n + 1].address, S.copy.address)) return no('the copy is not a seal copy');
  if (!same(ins[n + 2].coinid, spec.inputs[n + 2].coinid)) return no('not the record coin of this shard');
  if (outs.length !== spec.outputs.length) return no('another number of outputs');
  for (let i = 0; i < outs.length; i++) {
    const o = outs[i], w = spec.outputs[i];
    if (!same(o.address, w.address) || !same(o.tokenid, w.tokenid) || String(o.tokenamount ?? o.amount) !== String(w.amount) || !!o.storestate !== !!w.storestate)
      return no(`output ${i} differs from the payout this guardian builds`);
  }
  const st = Object.fromEntries((txn.state || []).map(s => [String(Number(s.port)), String(s.data)]));
  // Port 41: a payout that opens a new meter period writes the block it was built at, so the first signer's block may
  // differ from this one's. The record script takes any block from the last 72 up to now, a period after the previous;
  // accepted on the same terms (the transaction must then be mined within those 72 blocks).
  const ok41 = () => tip != null && prev41 != null && Number(spec.state[41]) !== Number(prev41) && Number(st[41]) >= Number(prev41) + gen.config.meter.periodBlocks
    && Number(st[41]) <= tip && Number(st[41]) >= tip - 72;
  for (const p of new Set([...Object.keys(st), ...Object.keys(spec.state)])) if (!same(st[p], spec.state[p]) && !(p === '41' && ok41())) return no(`port ${p} differs from the payout this guardian builds`);
  return { ok: true };
}
