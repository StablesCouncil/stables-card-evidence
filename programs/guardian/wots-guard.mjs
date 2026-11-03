/* wots-guard.mjs: never sign twice at one use count (Minima keys are one-time-signature trees).
 *
 * The same write-ahead journal as the R2T5 campaign and the Council (route2/r2t5-campaign.mjs guardedSign), in the same
 * format, so one journal can hold every use of a key whoever signed: one JSON line per event, each carrying the hash of
 * the line before. Before a signature: the journal's chain must be whole, the node's use count for the key must be at or
 * above the floor (the highest use the journal has seen, +1 after a reserve), and a "reserve" line is written and synced.
 * After: the count must have moved on, and a "signed" line is written. A node restored from an old copy shows a count
 * below the floor and is refused before it can reuse a step.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sha = x => createHash('sha256').update(x).digest('hex');
const same = (a, b) => String(a).toUpperCase() === String(b).toUpperCase();

export function wotsGuard(file, { run = 'guardian' } = {}) {
  const entries = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  function check() {
    let prev = '0'.repeat(64);
    for (const e of entries()) {
      const { hash, ...b } = e;
      if (b.prev !== prev || sha(JSON.stringify(b)) !== hash) throw new Error('WOTS guard journal broken: ' + file);
      prev = hash;
    }
    return prev;
  }
  function append(e) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = { ...e, run, at: new Date().toISOString(), prev: check() };
    body.hash = sha(JSON.stringify(body));
    const fd = fs.openSync(file, 'a'); fs.writeSync(fd, JSON.stringify(body) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd);
  }
  function floor(pub) {
    let f = 0;
    for (const e of entries()) if (e.publickey && same(e.publickey, pub)) f = Math.max(f, e.kind === 'reserve' ? e.uses + 1 : e.uses);
    return f;
  }
  /** rpc: the guardian's node; sign: () => the one signature. */
  async function guardedSign({ rpc, pub, node, txn, purpose, sign }) {
    const uses = async () => {
      const k = ((await rpc('keys')).keys || []).find(x => same(x.publickey, pub));
      if (!k) throw new Error('the key ' + pub.slice(0, 10) + ' is not on this node');
      return Number(k.uses);
    };
    const before = await uses(), f = floor(pub);
    if (before < f) throw new Error(`WOTS guard: key ${pub.slice(0, 10)} at ${before} uses, below the journal floor ${f}: refusing to sign`);
    append({ kind: 'reserve', publickey: pub, node, uses: before, txn, purpose });
    await sign();
    const after = await uses();
    if (after <= before) throw new Error('WOTS guard: the use count did not advance');
    append({ kind: 'signed', publickey: pub, node, uses: after, txn, purpose });
    return { before, after, floor: f };
  }
  return { check, floor, guardedSign, entries };
}
