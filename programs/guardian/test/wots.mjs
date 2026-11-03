/* The one-time-signature guard (wots-guard.mjs), against a fake node. Also reads a COPY of the lab's real guardian
 * journal, if this machine has it, to prove the format is the campaign's own (the lab journal is never written here). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wotsGuard } from '../wots-guard.mjs';

let n = 0, ok = 0;
const expect = (name, cond) => { n++; if (cond) ok++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wots-'));
const PUB = '0x' + 'AB'.repeat(32);
const node = uses => { let u = uses; return { rpc: async c => (c === 'keys' ? { keys: [{ publickey: PUB, uses: u }] } : null), bump: () => { u++; } }; };

const j = path.join(tmp, 'journal.jsonl'), G = wotsGuard(j, { run: 'test' });
let fake = node(5);
const r = await G.guardedSign({ rpc: fake.rpc, pub: PUB, node: 'fake', txn: 't1', purpose: 'test', sign: async () => fake.bump() });
expect('a first signature is journalled: reserve at 5, signed at 6', r.before === 5 && r.after === 6 && G.entries().map(e => e.kind).join() === 'reserve,signed');
expect('the floor is now 6', G.floor(PUB) === 6);
fake = node(3);
let threw = null; try { await G.guardedSign({ rpc: fake.rpc, pub: PUB, node: 'fake', txn: 't2', purpose: 'test', sign: async () => fake.bump() }); } catch (e) { threw = e.message; }
expect('a node restored to 3 uses is refused before signing', /below the journal floor 6/.test(threw || '') && G.entries().length === 2);
fake = node(6);
threw = null; try { await G.guardedSign({ rpc: fake.rpc, pub: PUB, node: 'fake', txn: 't3', purpose: 'test', sign: async () => {} }); } catch (e) { threw = e.message; }
expect('a signature that did not advance the count is caught', /did not advance/.test(threw || ''));
expect('after a reserve with no signature, the floor moves past it (7)', G.floor(PUB) === 7);
const lines = fs.readFileSync(j, 'utf8').split('\n'); lines[0] = lines[0].replace('"uses":5', '"uses":1'); fs.writeFileSync(j, lines.join('\n'));
threw = null; try { G.check(); } catch (e) { threw = e.message; }
expect('an edited journal is refused', /broken/.test(threw || ''));

const LAB = '<lab>/Minima/WotsGuards/R2T5-Guardians/journal.jsonl';
if (fs.existsSync(LAB)) {
  const copy = path.join(tmp, 'lab-copy.jsonl'); fs.copyFileSync(LAB, copy);
  const L = wotsGuard(copy);
  let good = true; try { L.check(); } catch { good = false; }
  expect(`the lab's guardian journal (a copy, ${L.entries().length} lines) is read as a whole chain`, good);
}
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('./out/wots-results.json', import.meta.url), JSON.stringify({ ok, n }, null, 1));
console.log(`wots: ${ok} of ${n} as expected`);
