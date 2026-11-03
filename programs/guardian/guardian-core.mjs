/*
 * The Stables card guardian's rules (2026-11-03; design GUARDIAN_DESIGN.md). Pure functions: given what the chain shows
 * and what the package check said, decide what the guardian does, and build the transactions it may make. The program
 * (guardian.mjs) reads the node, runs these, writes every decision to its public log and acts.
 *
 * Shapes follow the deployed R2T5 scripts (r2t5/out-r2t5-deployed, run R2T5-DEPLOY-03) and, where the scripts allow, the
 * Bridge guardian's builder (The bay/Bridge/p4/guardian/minima-tx.mjs), so both projects keep one design:
 *   stop      request (or released contested) at input 0, one seal copy at input 1; the request goes to the contested
 *             address, the copy comes back at output 1 (port 19). One guardian signature.
 *   check-in  head at input 0, every copy after it, all given back; this seat's port 100+seat set to the block. Act 5.
 *   freeze    the same inputs, act 2, ports 27 = 1 and 28 = the block. Needs 3 guardians: prepared for the owner only.
 */
import { createHash } from 'node:crypto';

export const same = (a, b) => String(a).toUpperCase() === String(b).toUpperCase();
/** A coin id as the guardian keys its records: 0x and upper-case hex. */
export const norm = id => '0x' + String(id).replace(/^0x/i, '').toUpperCase();
export const portsOf = coin => Object.fromEntries((coin.state || []).map(s => [String(Number(s.port)), String(s.data)]));
export const amountOf = coin => String(coin.tokenamount ?? coin.amount);
const output = (address, amount, tokenid, storestate) => ({ address, amount: String(amount), tokenid, storestate });
const sha = x => createHash('sha256').update(x).digest('hex').toUpperCase();

// What a seal copy pins (copy.kiss: SAMESTATE 20 to 24, 26, 27 to 28, the guardian keys 80 on, their check-ins 100 on).
const SEALPORTS = ['20', '21', '22', '23', '24', '26', '27', '28'];
export const sealPins = copy => Object.fromEntries(Object.entries(portsOf(copy)).filter(([p]) => SEALPORTS.includes(p) || (Number(p) >= 80 && Number(p) < 120)));
// What a request carries and keeps (request.kiss: SAMESTATE 10 to 14, 17 the atom; 0 tag, 18 the package parts, 51).
export const requestPorts = coin => Object.fromEntries(Object.entries(portsOf(coin)).filter(([p]) => ['0', '10', '11', '12', '13', '14', '17', '18', '51'].includes(p)));

/** The stop of one request (or of a released contested request) by one guardian. */
export function stopSpec({ request, copy, contestedAddress }) {
  if (!contestedAddress) throw new Error('the contested address is required');
  if (!copy || amountOf(copy) !== '1') throw new Error('a free seal copy (1 unit) is required');
  if (portsOf(copy)[27] !== '0') throw new Error('the copy is frozen: nothing can be stopped through it');
  return {
    kind: 'stop', inputs: [request, copy],
    outputs: [output(contestedAddress, amountOf(request), request.tokenid, true), output(copy.address, 1, copy.tokenid, true)],
    // The copy's pins (the guardian keys the request reads in ports 80 on), then the request's ports, then the stop:
    // no vault coin (16 = 0), the copy back at output 1, and the contested coin not released (51 = 0, which the
    // contested script asks of a stop again and the next generation asks of every stop).
    state: { ...sealPins(copy), ...requestPorts(request), 16: '0', 19: '1', 51: '0' },
  };
}

/** Head actions spend the head and every copy and give them back (head.kiss: VERIFYOUT 0 the head, 1 to n the copies). */
function headSpec(kind, head, copies, change, act, sealCopies) {
  if (!head || amountOf(head) !== '2') throw new Error('the seal head (2 units) is required');
  if (copies.length !== sealCopies) throw new Error(`all ${sealCopies} copies are required, ${copies.length} are free`);
  const p = portsOf(head);
  return {
    kind, inputs: [head, ...copies],
    outputs: [output(head.address, 2, head.tokenid, true), ...copies.map(c => output(c.address, 1, c.tokenid, true))],
    state: { ...p, ...change, 21: String(Number(p[21]) + 1), 29: String(act) },
  };
}
/** A check-in of `seats` (usually this guardian's one) at `block`. */
export const checkInSpec = ({ head, copies, seats, block, sealCopies }) =>
  headSpec('check-in', head, copies, Object.fromEntries(seats.map(s => [String(100 + Number(s)), String(block)])), 5, sealCopies);
/** A freeze at `block`, for the owner to sign with two other guardians. Never signed or posted by the program. */
export const freezeSpec = ({ head, copies, block, sealCopies }) => headSpec('freeze', head, copies, { 27: '1', 28: String(block) }, 2, sealCopies);

/* ---------- verdicts ---------- */
// The package check (R2Checker) answers approve or reject with a code. A reject that only means "too early" (the
// deposit's confirmations, the package parts not all mined yet) is a wait, as the Council treats it.
const WAIT = /confirmations, needs|package-missing/;
export function classify(verdict) {
  if (!verdict || verdict.error) return 'unknown';
  if (verdict.verdict === 'approve') return 'good';
  if (verdict.verdict === 'reject') return WAIT.test(`${verdict.detail || ''}${verdict.code || ''}`) ? 'wait' : 'bad';
  return 'unknown';
}

/**
 * What the guardian does about one open request. `rec` is what it holds on the request: first seen, first found bad,
 * last verdict. Returns { action, why } with action one of: none, wait, stop, alert.
 * - bad, seen bad for at least confirmBlocks: stop (one guardian is enough; a wrong stop only sends the request to the
 *   contested address, where the Council can still decide it);
 * - unknown (the check could not run) until failClosedBlocks before the earliest it could pay: alert; then stop;
 * - a request already stopped (contested, 51 = 0): nothing more a single guardian can do.
 */
export function decideRequest({ coin, kind, rec, tip, gen }) {
  const p = portsOf(coin), cls = rec.class;
  if (kind === 'contested' && p[51] !== '1') return { action: 'none', why: 'already stopped' };
  const earliest = Number(coin.created) + gen.fallbackWaitBlocks;           // the fallback path: the only payout a stop prevents in R2T5
  if (cls === 'good') return { action: 'none', why: 'package check passed' };
  if (cls === 'wait') return { action: 'wait', why: rec.detail || 'not final yet' };
  if (cls === 'bad') {
    if (rec.confirmed) return { action: 'stop', why: `package check failed: ${rec.code}: ${rec.detail || ''}`.trim() };
    return { action: 'wait', why: `found bad at block ${rec.badSince}; checked again ${gen.confirmBlocks} blocks later before a stop` };
  }
  if (earliest - tip <= gen.failClosedBlocks) return { action: 'stop', why: 'could not be checked, and could pay soon (fail closed)' };
  return { action: 'alert', why: 'could not be checked: ' + (rec.detail || 'checker error') };
}

/* ---------- the sealed lists ---------- */
// The Council's lists (r2t5-council.mjs mmr()): leaves = the sorted request coin ids, then one filler, the SHA-256 of
// "R2T5 filler a<n>" (approved) or "r<n>" (rejected), n the seal number before that seal. mmrcreate makes the root.
export const filler = (list, n) => '0x' + sha(`R2T5 filler ${list}${n}`);

/**
 * Rebuilds a sealed root from the guardian's own view. Only requests that existed when the Council sealed (created at
 * or before the seal's heartbeat, port 23) can be in it. `ids` are those the guardian holds as approvable (or
 * rejectable), `others` the rest. The Council may not have decided some of `ids` yet, and may have put some of
 * `others` in. Tries the seal numbers from `fromSeal` down (check-ins and freezes raise the number without touching the
 * lists). With up to 6 candidates every combination is tried, the guardian's own set first; with more, its own set,
 * then one left out, then one added. Returns { matched, seal, leaves, extra, missing } (extra: requests the Council put
 * in that the guardian did not; missing: ones the guardian holds that the Council left out), or { matched: false }.
 */
export async function rebuildRoot({ root, ids, others = [], fromSeal, list, mmrRoot, tries = 20 }) {
  const mine = [...ids].sort(), all = [...mine, ...others];
  const sets = [];
  if (all.length <= 6) {
    for (let m = 0; m < 1 << all.length; m++) sets.push(all.filter((_, i) => m & (1 << i)));
    const diff = s => mine.filter(x => !s.includes(x)).length + s.filter(x => !mine.includes(x)).length;
    sets.sort((a, b) => diff(a) - diff(b));
  } else {
    sets.push(mine, ...mine.map(x => mine.filter(y => y !== x)), ...others.map(o => [...mine, o]));
  }
  for (let n = fromSeal; n > fromSeal - tries && n >= 0; n--) {
    const f = filler(list, n);
    for (const s of sets) {
      const leaves = [...s].sort();
      if (same(await mmrRoot([...leaves, f]), root))
        return { matched: true, seal: n, leaves, extra: leaves.filter(x => !mine.includes(x)), missing: mine.filter(x => !leaves.includes(x)) };
    }
  }
  return { matched: false };
}

/** When this guardian's next check-in is due; never inside the Council's busy time just before a heartbeat seal. */
export function checkInDue({ head, seat, tip, every, councilHeartbeatEvery }) {
  const p = portsOf(head), last = Number(p[String(100 + seat)]);
  const age = tip - last;
  if (age < every) return { due: false, why: `last check-in ${age} blocks ago` };
  // The Council seals at least every councilHeartbeatEvery blocks and needs every copy free: leave it the last 30.
  const sinceSeal = tip - Number(p[23]);
  if (sinceSeal > councilHeartbeatEvery - 30) return { due: false, why: 'the Council is about to seal; next pass' };
  return { due: true, why: `last check-in ${age} blocks ago (every ${every})` };
}
