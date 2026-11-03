#!/usr/bin/env node
/*
 * OFFLINE PROOF (2026-11-03): the transactions the guardian program builds are accepted by the deployed R2T5 scripts
 * when signed by a guardian key the seal head holds, and refused otherwise. Nothing touches a node: Minima's own
 * classes (minima.jar) make REAL test keys, sign the real transaction id, and run the node's own checks
 * (TxPoWChecker.checkSignatures and checkTxPoWScripts, every input's script) through r2t5/tools/R2T5Offline.java.
 *
 * The seal: the live R2T5 head and its 6 copies as lab node 9305 showed them (fixtures/r2t5-live-head.json, read only),
 * with TEST keys put in guardian seats 0, 1 and 2, as if elected. The scripts: generation.json of R2T5-DEPLOY-03, the
 * very scripts at the live addresses. TEST KEYS ONLY: seeds below are public and must never hold a real seat.
 *
 *   node test/offline-proof.mjs     (about a minute: each Minima key takes a few seconds to make)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../guardian-core.mjs';
import * as offline from '../offline.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const gen = JSON.parse(fs.readFileSync(path.resolve(HERE, '../../../stream_1_app/work/simcard/evidence/R2T5-DEPLOY-03/generation.json'), 'utf8'));
const live = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/r2t5-live-head.json'), 'utf8'));
const C = gen.contracts, g = gen.config, W = gen.tokens.Winiwa;
const workDir = path.join(HERE, 'out'); fs.mkdirSync(workDir, { recursive: true });

// TEST KEYS. Seeds are public on purpose: these keys prove the scripts, they never guard anything.
const TEST = { seat0: '0x' + 'D0'.repeat(32), seat1: '0x' + 'D1'.repeat(32), seat2: '0x' + 'D2'.repeat(32), stranger: '0x' + 'E0'.repeat(32) };
const K = s => '$KEY:' + s;
const withSeats = coin => ({ ...coin, state: coin.state.map(p => ({ ...p,
  data: p.port === 80 ? K(TEST.seat0) : p.port === 81 ? K(TEST.seat1) : p.port === 82 ? K(TEST.seat2) : p.data })) });
const head = withSeats(live.head[0]), copies = live.copies.map(withSeats);
const tip = live.tip, block = tip + 1;

// A request as the app posts it (request.kiss ports), 1 atom of Winiwa at the live request address. Its package fails
// the check in this story; the scripts do not read the package, the guardian's checker does.
const st = (o) => Object.entries(o).map(([port, data]) => ({ port: Number(port), data }));
const reqPorts = { 0: '0x52325445', 10: '0x' + '0F'.repeat(32), 11: '0x5A' + '11'.repeat(31), 12: '10', 13: W, 14: '0x' + 'AB'.repeat(32), 17: '0.00000001', 18: '0x' + '0E'.repeat(32) };
const request = { coinid: '0x' + '11'.repeat(32), address: C.request.address, amount: '0.00000001', tokenamount: '0.00000001', tokenid: W, storestate: true, created: String(tip - 30), state: st(reqPorts) };
const released = { ...request, coinid: '0x' + '12'.repeat(32), address: C.contested.address, state: st({ ...reqPorts, 51: '1' }) };

const stop = core.stopSpec({ request, copy: copies[2], contestedAddress: C.contested.address });
const restop = core.stopSpec({ request: released, copy: copies[3], contestedAddress: C.contested.address });
const checkIn = seats => core.checkInSpec({ head, copies, seats, block, sealCopies: g.council.sealCopies });
const freeze = core.freezeSpec({ head, copies, block, sealCopies: g.council.sealCopies });
const SR = [C.request.script, C.copy.script], SC = [C.contested.script, C.copy.script], SH = [C.head.script, C.copy.script];

const cases = [
  // name, spec, signers, scripts, expected [signatures, scripts], extra
  ['stop: a guardian in seat 0 stops a request', stop, [TEST.seat0], SR, [true, true]],
  ['stop: the same stop signed by a key that holds no seat', stop, [TEST.stranger], SR, [true, false]],
  ['stop: built to send the request elsewhere than the contested address', { ...stop, outputs: [{ ...stop.outputs[0], address: '0x' + 'CD'.repeat(32) }, stop.outputs[1]] }, [TEST.seat0], SR, [true, false]],
  // Port 14 is pinned by the request too (SAMESTATE 10 to 14), so the scripts refuse it as well as the signature check.
  ['stop: changed after signing (payout port 14)', stop, [TEST.seat0], SR, [false, false], { tamper: { port: '14', value: '0x' + 'CD'.repeat(32) } }],
  ['stop: a signature made over another transaction', stop, [TEST.seat0], SR, [false, true], { signOther: true }],
  ['stop again: a released contested request, seat 1', restop, [TEST.seat1], SC, [true, true]],
  ['stop again: by a key that holds no seat', restop, [TEST.stranger], SC, [true, false]],
  ['check-in: seat 0 checks in', checkIn([0]), [TEST.seat0], SH, [true, true]],
  ['check-in: signed by a key that holds no seat', checkIn([0]), [TEST.stranger], SH, [true, false]],
  ['check-in: seat 0 writes seat 1\'s check-in', checkIn([1]), [TEST.seat0], SH, [true, false]],
  [`check-in: a block older than the ${g.council.heartbeatSlackBlocks}-block slack`, core.checkInSpec({ head, copies, seats: [0], block: block - g.council.heartbeatSlackBlocks - 1, sealCopies: g.council.sealCopies }), [TEST.seat0], SH, [true, false]],
  [`freeze (prepared for the owner): ${g.guardians.freeze} guardians sign`, freeze, [TEST.seat0, TEST.seat1, TEST.seat2], SH, [true, true]],
  [`freeze: ${g.guardians.freeze - 1} guardians only`, freeze, [TEST.seat0, TEST.seat1], SH, [true, false]],
];

const rows = offline.signedCheck(cases.map(([name, spec, signers, scripts, , extra]) => ({ name, spec, signers, scripts, block, ...(extra || {}) })), { workDir });
let pass = 0;
const table = rows.map((r, i) => {
  const [es, ec] = cases[i][4], ok = r.signatures === es && r.scripts === ec;
  if (ok) pass++;
  console.log(ok ? 'PASS' : 'FAIL', `expect sig ${es} scripts ${ec}`.padEnd(30), `got sig ${r.signatures} scripts ${r.scripts}`.padEnd(30), String(r.bytes).padStart(6), 'bytes ', r.name);
  return { name: r.name, expect: { signatures: es, scripts: ec }, got: { signatures: r.signatures, scripts: r.scripts }, bytes: r.bytes, pass: ok };
});
fs.writeFileSync(path.join(workDir, 'offline-proof-results.json'), JSON.stringify({ at: new Date().toISOString(), seal: live.head[0].state.find(p => p.port === 21).data, tip, passed: pass, total: rows.length, table }, null, 1));
console.log(`offline proof: ${pass} of ${rows.length} as expected`);
process.exit(pass === rows.length ? 0 : 1);
