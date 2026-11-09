/*
 * r2t6-tx.mjs: the transactions the R2T6 approvers' program builds (R2T6_PLAN step 4, written 2026-11-04), as pure
 * functions over coins as the node lists them. No node, no keys: the program (r2t6-approvers.mjs) and the offline test
 * (test/r2t6-tx.test.mjs, which runs every one through Minima's own script engine against the generated contracts)
 * share them.
 *
 * What changed from R2T5 for the approvers (vault-shared, stables.config.json):
 * - Seal (head act 1): a ring of the last 3 lists (roots in ports 120 on, sealed-at in 130 on); the heartbeat may be
 *   up to heartbeatSlackBlocks (72) older than the block that mines it; payable-from is heartbeat + 216; ports 8 (the
 *   vault address), 9 (successions carried out), 30-31, 54-57 (a pending change) are kept; an unfrozen seal clears a
 *   scheduled succession (port 58 to 0), a frozen one keeps it.
 * - Payout (request path 1): names its ring slot (port 53) and pays from that slot's sealed-at + slack + delay (288);
 *   the request must exist by that sealed-at; the first vault coin is input 1 (port 8 checks it); the record meters
 *   against the sealed approver limit (port 56).
 * - Refusal (request path 0): the request becomes a contested coin, unreleased (port 51 = 0), with its state. The
 *   guardians can overrule it (5 signatures, the guardian program's work). Final rejection (contested path 0): the
 *   contested coin's own id in a later rejected list, once the coin is refusalOverrule (12096) blocks old.
 * - Copy cleaning: a copy is spent only beside the head, a request or a contested coin (review F2), except once,
 *   alone, when a payout, refusal or final rejection gave it back large (hardening.copyLoneClean: port 19 is the marker,
 *   255 once cleaned). With 7 signatures a seal fits only 1 large copy (test/r2t6-tx.test.mjs measures it).
 */
import { createHash } from 'node:crypto';

/** The leaves of an approved or rejected list: the sorted ids, then one filler for that seal (never an empty tree).
 *  The root is mmrcreate of these, on the program's node or offline (R2T5Offline mmr). */
export const listLeaves = (ids, tag) => [...ids, '0x' + createHash('sha256').update('R2T6 filler ' + tag).digest('hex').toUpperCase()];

export function r2t6(gen, cfg) {
  const S = gen.contracts, K = gen.keys, H = cfg.hardening || {};
  const C = cfg.council, RING = H.approvalRing | 0, GN = cfg.guardians.size;
  const PAYABLE_AFTER = C.payoutDelayBlocks + C.heartbeatSlackBlocks;   // a slot pays from its sealed-at + this (C2)
  const range = (a, n) => Array.from({ length: n }, (_, i) => a + i);
  // The ports a seal copy pins (copy.kiss SAMESTATE): every payout, refusal and final rejection carries them unchanged.
  const SEAL_PINS = new Set([8, 20, 21, 22, 23, 24, 26, 27, 28, 30, 31, 54, 55, 56, 57, ...range(80, GN), ...range(100, GN), ...range(120, RING), ...range(130, RING)].map(String));
  const REQUEST_PORTS = new Set(['0', '10', '11', '12', '13', '14', '17', '18', '51']);
  const pick = (st, set) => Object.fromEntries(Object.entries(st).filter(([p]) => set.has(p)));
  const out = (address, amount, tokenid, storestate = false) => ({ address, amount, tokenid, storestate });
  const same = (a, b) => String(a).toUpperCase() === String(b).toUpperCase();

  /** Head act 1. hp: the head's state; a, r: the new approved and rejected roots; t: the heartbeat block (the tip). */
  function sealState(hp, a, r, t) {
    const st = { ...hp, 20: a, 26: r, 21: String(Number(hp[21]) + 1), 23: String(t), 24: String(t + C.payoutDelayBlocks), 29: '1' };
    for (let i = RING - 1; i > 0; i--) { st[120 + i] = hp[120 + i - 1]; st[130 + i] = hp[130 + i - 1]; }
    if (RING) { st[120] = a; st[130] = String(t); }
    if (H.successionToBackup && hp[27] === '0') st[58] = '0';   // a working Council cancels a scheduled succession
    return st;
  }
  function sealTx(head, copies, state) {
    return { inputs: [head.coinid, ...copies.map(c => c.coinid)],
      outputs: [out(S.head.address, '2', K.sealToken, true), ...copies.map(() => out(S.copy.address, '1', K.sealToken, true))], state };
  }

  /** Refusal: the request in the sealed rejected list becomes a contested coin, unreleased, with its state. */
  function refusalTx(rc, rcState, copy, copyState, proof) {
    return { inputs: [rc.coinid, copy.coinid],
      outputs: [out(S.contested.address, rcState[17], rc.tokenid, true), out(S.copy.address, '1', K.sealToken, true)],
      state: { ...pick(rcState, REQUEST_PORTS), ...pick(copyState, SEAL_PINS), 16: '0', 19: '1', 25: proof, 50: '0', 51: '0' } };
  }

  /** Final rejection: a contested coin rejected again by its own id, once it is refusalOverrule blocks old. Its atom
   *  goes back to the exit address it named; the card money stays in the vault. */
  function finalRejectTx(cc, ccState, copy, copyState, proof) {
    return { inputs: [cc.coinid, copy.coinid],
      outputs: [out(S.copy.address, '1', K.sealToken, true), out(ccState[14], ccState[17], cc.tokenid)],
      state: { ...pick(ccState, REQUEST_PORTS), ...pick(copyState, SEAL_PINS), 16: '0', 19: '0', 25: proof, 50: '0' } };
  }
  const finalRejectFrom = cc => Number(cc.created) + (H.refusalOverrule | 0);

  /** The ring slot a request pays from: one whose list holds it, payable at t, sealed no earlier than the request.
   *  lists: { root: { ids, proofs } }. The oldest such slot, so a later seal is least likely to move it out. */
  function slotFor(hp, lists, rc, t) {
    for (let j = RING - 1; j >= 0; j--) {
      const L = lists[String(hp[120 + j]).toUpperCase()], at = Number(hp[130 + j]);
      if (!L || !L.ids.some(x => same(x, rc.coinid))) continue;
      if (t < at + PAYABLE_AFTER || Number(rc.created) > at) continue;
      return { j, proof: L.proofs[String(rc.coinid).toUpperCase()] };
    }
    return null;
  }

  /** Stop (the guardians' path of the request script): one guardian's signature sends a request to the contested
   *  address, unreleased (51 = 0). From there it pays only with 5 guardian signatures (contested paths 1 and 2). */
  function stopTx(rc, rcState, copy, copyState) {
    return { inputs: [rc.coinid, copy.coinid],
      outputs: [out(S.contested.address, rcState[17], rc.tokenid, true), out(S.copy.address, '1', K.sealToken, true)],
      state: { ...pick(rcState, REQUEST_PORTS), ...pick(copyState, SEAL_PINS), 16: '0', 19: '1', 51: '0' } };
  }
  /** The first block the 3-day path (2) is open to a request or contested coin: fallback.waitBlocks after it was made. */
  const fallbackFrom = rc => Number(rc.created) + cfg.fallback.waitBlocks;

  /**
   * Payout of a request or a contested coin (both scripts share the layout). path 1: from a ring slot (`slot`), the
   * Council's approval (a contested coin also needs 5 guardian signatures); path 2: the 3-day path, no slot (a request:
   * anyone, while the Council is alive and the vault not frozen; a contested coin: 5 guardian signatures), metered
   * against the record's fallback cap (port 36) instead of the sealed approver limit (port 56).
   * ins: the record insertion (RecordTree: new, lo, nx, pa, pb, mid); take: vault coins.
   */
  function payoutTx({ rc, rcState, take, copy, copyState, rec, recState, slot, ins, t, atoms, decimal, path = 1 }) {
    const need = atoms(rcState[12]), sum = take.reduce((s, c) => s + atoms(c.tokenamount ?? c.amount), 0n), rem = sum - need;
    if (rem < 0n) throw new Error('vault coins do not cover the request');
    let p41 = Number(recState[41]), c42 = recState[42], f43 = recState[43];
    if (p41 + cfg.meter.periodBlocks <= t) { p41 = t; c42 = '0'; f43 = '0'; }
    const paid = atoms(path === 1 ? c42 : f43) + need;
    if (paid > atoms(path === 1 ? copyState[56] : recState[36])) return { overLimit: true };
    const outputs = [out(rcState[14], rcState[12], rcState[13]), out(rcState[14], rcState[17], rc.tokenid)];
    if (rem > 0n) outputs.push(out(S.vault.address, decimal(rem), rcState[13]));
    const copyIndex = outputs.length;
    outputs.push(out(S.copy.address, '1', K.sealToken, true), out(S.record.address, '1', K.recordToken, true));
    const state = { ...pick(rcState, REQUEST_PORTS), ...pick(copyState, SEAL_PINS),
      ...Object.fromEntries(['35', '36', '37', '38', '39', '44'].map(p => [p, recState[p]])),
      40: ins.new, 41: String(p41), 42: path === 1 ? decimal(paid) : c42, 43: path === 1 ? f43 : decimal(paid),
      45: ins.lo, 46: ins.nx, 47: ins.pa, 48: ins.pb, 49: ins.mid,
      15: rem > 0n ? decimal(rem) : '0', 16: String(take.length), 19: String(copyIndex), 50: String(path),
      ...(path === 1 ? { 25: slot.proof, 53: String(slot.j) } : {}) };
    return { inputs: [rc.coinid, ...take.map(c => c.coinid), copy.coinid, rec.coinid], outputs, state };
  }

  /** A copy given back by a payout, refusal or final rejection carries that transaction's whole state (about 4 KB more
   *  in the next seal). hardening.copyLoneClean (the-bay-8a, founder's choice 2026-11-04): such a copy may be spent alone,
   *  once, back to itself with only its pinned ports and 19 = 255; a cleaned copy cannot be cleaned again. No key. */
  const isLarge = st => '19' in st && String(st[19]) !== '255';
  function cleanTx(copy, copyState) {
    return { inputs: [copy.coinid], outputs: [out(S.copy.address, '1', K.sealToken, true)], state: { ...pick(copyState, SEAL_PINS), 19: '255' } };
  }

  return { sealState, sealTx, refusalTx, finalRejectTx, finalRejectFrom, slotFor, stopTx, fallbackFrom, payoutTx, cleanTx, isLarge, SEAL_PINS, REQUEST_PORTS, PAYABLE_AFTER, RING };
}
