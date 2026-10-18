#!/usr/bin/env node
/*
 * R2T5 offline battery (DRAFT 2026-10-17): runs the generated contracts (out/r2t5-contracts.json) on whole
 * transactions with the node's own Contract class (KissRunScaled, Minima's jar, real token scaling). Nothing is
 * posted. Exit-record data: study/d24.txt (ExitSet, depth 24). Approval and rejection lists: mmrcreate on a dev node.
 *
 *   node r2t5-generate.mjs && node r2t5-cases.mjs [--node http://127.0.0.1:9205]
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const NODE = (i => i > 0 ? process.argv[i + 1] : 'http://127.0.0.1:9205')(process.argv.indexOf('--node'));
// Override for another machine: R2T5_JDK (the bin folder), R2T5_MINIMA_JAR, R2T5_RUNNER.
const JDK = process.env.R2T5_JDK || 'C:/Program Files/Eclipse Adoptium/jdk-17.0.18.8-hotspot/bin';
const JAR = process.env.R2T5_MINIMA_JAR || 'C:/Users/Charles/Documents/Crypto/Minima/Nodes/DevNodesSet/9101/minima.jar';
const RUNNER = process.env.R2T5_RUNNER || (fs.existsSync(path.join(here, 'tools', 'KissRunScaled.java')) ? path.join(here, 'tools', 'KissRunScaled.java')
  : path.resolve(here, '../../../stream_1_app/work/simcard/measure/java/KissRunScaled.java'));
const cfg = JSON.parse(fs.readFileSync(path.join(here, 'r2t5.config.json'), 'utf8'));
const OUT = path.resolve(here, (i => i > 0 ? process.argv[i + 1] : 'out')(process.argv.indexOf('--out')));
const gen = JSON.parse(fs.readFileSync(path.join(OUT, 'r2t5-contracts.json'), 'utf8'));
const S = Object.fromEntries(Object.entries(gen.contracts).map(([k, v]) => [k, v]));
const tree = Object.fromEntries(fs.readFileSync(path.join(here, 'study', 'd24.txt'), 'utf8').trim().split(/\r?\n/).map(l => l.split('=')));
const rpc = async cmd => (await (await fetch(NODE + '/' + encodeURIComponent(cmd))).json()).response;

// The draft's placeholder keys, as r2t5-generate.mjs makes them.
const fake = (tag, i) => '0x' + (tag + String(i).padStart(2, '0')).padEnd(64, '0');
// With real keys (out-real), signatures in KissRunScaled are just the public keys named, so the same cases apply.
const council = gen.keys.council, guardians = gen.keys.guardians;
const SEAL = gen.keys.sealToken, REC = gen.keys.recordToken, W = '0x' + 'EE'.repeat(32), X = '0x' + 'EF'.repeat(32);
const ATOM = '0.00000001', PAYEE = '0x' + 'AB'.repeat(32), STRANGER = '0x' + 'CD'.repeat(32);
const G = cfg.guardians, C = cfg.council, F = cfg.fallback;

// The card coin whose key (first 16 bytes) is the study's x: shard 2 of 8 (first byte 0x5A = 90).
const CARD = tree.x + '00112233445566778899AABBCCDDEEFF';
const reqId = '0x' + '11'.repeat(32), rejId = '0x' + '12'.repeat(32);
const appr = await rpc(`mmrcreate nodes:["${reqId}","0x${'99'.repeat(32)}"]`);
const rej = await rpc(`mmrcreate nodes:["${rejId}","0x${'98'.repeat(32)}"]`);

const B0 = 2400000;                                  // the seal's heartbeat block
const guardState = Object.fromEntries(guardians.flatMap((k, i) => [[80 + i, k], [100 + i, String(B0 - 10)]]));
const seal = { 20: appr.root.data, 21: '7', 22: cfg.generation.tag, 23: String(B0), 24: String(B0 + C.payoutDelayBlocks), 26: rej.root.data, 27: '0', 28: '0', ...guardState };
const recState = { 35: String(cfg.meter.tokens.Winiwa.councilCapPerPeriod / 8), 36: String(cfg.meter.tokens.Winiwa.fallbackCapPerPeriod / 8),
  37: S.request.address, 38: S.contested.address, 39: W, 40: tree.old, 41: String(B0 - 100), 42: '0', 43: '0', 44: '2' };
const reqState = { 0: cfg.generation.tag, 10: '0x' + '0F'.repeat(32), 11: CARD, 12: '10', 13: W, 14: PAYEE, 17: ATOM };

const coin = (coinid, address, amount, tokenid, state, created, scale) => ({ coinid, address, amount, tokenid, storestate: !!state, ...(state ? { state } : {}), created, ...(scale ? { scale } : {}) });
const request = (st = reqState, created = B0, address = S.request.address, id = reqId) => coin(id, address, ATOM, W, st, created);
const vaultCoin = (amt = '25', id = '0x' + '22'.repeat(32)) => coin(id, S.vault.address, amt, W, null, B0 - 5000);
const copy = (st = seal) => coin('0x' + '33'.repeat(32), S.copy.address, '1', SEAL, st, B0, 44);
const record = (st = recState) => coin('0x' + '44'.repeat(32), S.record.address, '1', REC, st, B0 - 50, 44);
const out = (address, amount, tokenid = W, storestate = false, scale) => ({ address, amount, tokenid, storestate, ...(scale ? { scale } : {}) });

// A Council payout: 10 Winiwa from one 25 Winiwa vault coin, record insertion of the card coin's key.
const insert = { 45: tree.lo, 46: tree.nx, 47: tree.p1, 48: tree.p2, 49: tree.mid, 40: tree.new };
const meterC = { 41: recState[41], 42: '10', 43: '0' };
const payState = { ...reqState, ...seal, ...recState, ...insert, ...meterC, 15: '15', 16: '1', 19: '3', 25: appr.nodes[0].proof, 50: '1' };
const payOuts = [out(PAYEE, '10'), out(PAYEE, ATOM), out(S.vault.address, '15'), out(S.copy.address, '1', SEAL, true, 44), out(S.record.address, '1', REC, true, 44)];
const pay = { block: B0 + C.payoutDelayBlocks + 1, inputs: [request(), vaultCoin(), copy(), record()], outputs: payOuts, state: payState, signatures: [] };
// The fallback: no approval, the request old enough, the heartbeat fresh.
const fbBlock = B0 + F.waitBlocks + 10;
const fbSeal = { ...seal, 23: String(fbBlock - 100), 24: String(fbBlock - 100 + C.payoutDelayBlocks) };
const fbState = { ...payState, ...fbSeal, 25: '0x00', 50: '2', 41: String(fbBlock - 200), 42: '0', 43: '10' };
const fb = { ...pay, block: fbBlock, inputs: [request(), vaultCoin(), copy(fbSeal), record({ ...recState, 41: String(fbBlock - 200) })], state: fbState };

const cases = [];
const T = (name, script, input, base, over, expect) => cases.push({ name, script: S[script].script, input, expect, ...base, ...over });
const all = (name, base, expect) => ['request', 'vault', 'copy', 'record'].forEach((k, i) => T(`${name} [${k}]`, k, i, base, {}, expect));

all('Council payout, approved and past the delay', pay, true);
all('fallback payout, old request, live Council', fb, true);
T('payout before the approval delay ends', 'request', 0, pay, { block: B0 + 10 }, false);
T('payout while the seal copy is frozen', 'request', 0, pay, { inputs: [request(), vaultCoin(), copy({ ...seal, 27: '1' }), record()], state: { ...payState, 27: '1' } }, false);
T('approved payout labelled fallback (request too young)', 'request', 0, pay, { state: { ...payState, 50: '2' } }, false);
T('approval label with no valid approval', 'request', 0, fb, { state: { ...fbState, 50: '1', 42: '10', 43: '0', 25: appr.nodes[1].proof } }, false);
T('payout without the exit record', 'request', 0, pay, { inputs: [request(), vaultCoin(), copy(), coin('0x55', STRANGER, '1', W, null, B0)] }, false);
T('vault without the exit record', 'vault', 1, pay, { inputs: [request(), vaultCoin(), copy(), coin('0x55', STRANGER, '1', W, null, B0)] }, false);
T('replay: the card coin is already in the record', 'record', 3, pay, { inputs: [request(), vaultCoin(), copy(), record({ ...recState, 40: tree.new })],
  state: { ...payState, 45: tree.x, 47: tree.p2 } }, false);
T('record: forged new root', 'record', 3, pay, { state: { ...payState, 40: '0x' + 'AB'.repeat(32) } }, false);
T('record: key in another shard', 'record', 3, pay, { inputs: [request(), vaultCoin(), copy(), record({ ...recState, 44: '3' })], state: { ...payState, 44: '3' } }, false);
T('record: other token', 'record', 3, pay, { state: { ...payState, 13: X } }, false);
T('record: Council cap passed', 'record', 3, pay, { state: { ...payState, 12: '2600', 42: '2600' } }, false);
T('record: meter not counted', 'record', 3, pay, { state: { ...payState, 42: '0' } }, false);
T('record: new period, meter restarts', 'record', 3, pay, { block: B0 + 2000, inputs: [request(), vaultCoin(), copy(), record({ ...recState, 42: '2495' })], state: { ...payState, 41: String(B0 + 1990), 42: '10' } }, true);
T('record: restart claimed inside the period', 'record', 3, pay, { state: { ...payState, 41: String(B0 + 140), 42: '10' } }, false);
T('record: spent with no exit at input 0', 'record', 3, pay, { inputs: [coin(reqId, STRANGER, ATOM, W, reqState, B0), vaultCoin(), copy(), record()] }, false);
T('fallback before its wait', 'request', 0, fb, { inputs: [request(reqState, fbBlock - 100), vaultCoin(), copy(fbSeal), record()] }, false);
T('fallback with the Council silent (old heartbeat)', 'request', 0, fb, { state: { ...fbState, 23: String(fbBlock - F.heartbeatMaxAgeBlocks - 1) } }, false);
T('fallback while frozen', 'request', 0, fb, { state: { ...fbState, 27: '1' } }, false);
T('fallback over its cap', 'record', 3, fb, { state: { ...fbState, 12: '200', 43: '200' } }, false);
T('fallback counted as a Council payout', 'record', 3, fb, { state: { ...fbState, 50: '1', 42: '10', 43: '0' }, alone: true }, true);
T('  ...but the request refuses that label', 'request', 0, fb, { state: { ...fbState, 50: '1', 42: '10', 43: '0' } }, false);
const rejTxn0 = () => ({ ...rejTxn, inputs: [request(), copy()] });
const rejTxn = { block: B0 + 5, inputs: [request(reqState, B0, S.request.address, rejId), copy()], outputs: [out(S.copy.address, '1', SEAL, true, 44), out(STRANGER, ATOM)],
  state: { ...reqState, ...seal, 16: '0', 19: '0', 25: rej.nodes[0].proof, 50: '0' }, signatures: [] };
T('Council rejection, posted by anyone', 'request', 0, rejTxn, {}, true);
T('  the copy given back', 'copy', 1, rejTxn, {}, true);
T('rejection that also takes a vault coin', 'request', 0, rejTxn, { inputs: [request(reqState, B0, S.request.address, rejId), vaultCoin(), copy()], state: { ...rejTxn.state, 16: '1' } }, false);
T('vault coin in a rejection', 'vault', 1, rejTxn, { inputs: [request(reqState, B0, S.request.address, rejId), vaultCoin(), copy()], state: { ...rejTxn.state, 16: '1', 15: '15' } }, false);
T('rejection label on a request not rejected', 'request', 0, rejTxn0(), {}, false);
T('rejection proof used for another request', 'request', 0, rejTxn, { inputs: [request(), copy()] }, false);
const copyOut = out(S.copy.address, '1', SEAL, true, 44);
const stopState = { ...reqState, ...seal, 16: '0', 19: '1' };
const stop = { block: B0 + 5, inputs: [request(), copy()], outputs: [out(S.contested.address, ATOM, W, true), copyOut], state: stopState, signatures: [guardians[4]] };
T('one guardian stops a request', 'request', 0, stop, {}, true);
T('stop sending the request elsewhere', 'request', 0, stop, { outputs: [out(STRANGER, ATOM, W, true), copyOut] }, false);
T('stop by a key that is not a guardian', 'request', 0, stop, { signatures: [STRANGER] }, false);
T('  the copy given back after a stop', 'copy', 1, stop, {}, true);
T('stop that also takes a vault coin', 'request', 0, stop, { inputs: [request(), vaultCoin(), copy()], state: { ...stopState, 16: '1' } }, false);
const cont = (st51, created = B0) => coin(reqId, S.contested.address, ATOM, W, { ...reqState, 51: st51 }, created);
T('contested: fallback before release', 'contested', 0, fb, { inputs: [cont('0', B0), vaultCoin(), copy(fbSeal), record()] }, false);
T('contested: fallback after release', 'contested', 0, fb, { inputs: [cont('1', B0), vaultCoin(), copy(fbSeal), record()] }, true);
T('contested: released by a guardian majority', 'contested', 0, stop, { inputs: [cont('0'), copy()], outputs: [out(S.contested.address, ATOM, W, true), copyOut], state: { ...stopState, 51: '1' }, signatures: guardians.slice(0, G.release) }, true);
T('contested: released by too few', 'contested', 0, stop, { inputs: [cont('0'), copy()], outputs: [out(S.contested.address, ATOM, W, true), copyOut], state: { ...stopState, 51: '1' }, signatures: guardians.slice(0, G.release - 1) }, false);
T('contested: one guardian stops it again', 'contested', 0, stop, { inputs: [cont('1'), copy()], outputs: [out(S.contested.address, ATOM, W, true), copyOut], state: { ...stopState, 51: '0' } }, true);
T('contested: Council approval still pays', 'contested', 0, pay, { inputs: [cont('0'), vaultCoin(), copy(), record()] }, true);

// The seal head: Council seals, guardian freeze, release, succession.
const keysAt = ks => Object.fromEntries(ks.map((k, i) => [60 + i, k]));
const headState = { ...seal, ...keysAt(council) };
const headCoin = (st = headState) => coin('0x' + '66'.repeat(32), S.head.address, '2', SEAL, st, B0, 44);
const copies = Array.from({ length: C.sealCopies }, (_, i) => coin('0x' + (0x70 + i).toString(16).toUpperCase().repeat(32), S.copy.address, '1', SEAL, seal, B0, 44));
const headOuts = [out(S.head.address, '2', SEAL, true, 44), ...copies.map(() => out(S.copy.address, '1', SEAL, true, 44))];
const B1 = B0 + 400;
const reseal = { block: B1, inputs: [headCoin(), ...copies], outputs: headOuts,
  state: { ...headState, 21: '8', 23: String(B1), 24: String(B1 + C.payoutDelayBlocks), 29: '1' }, signatures: council.slice(0, C.quorum) };
T('Council seals with its quorum', 'head', 0, reseal, {}, true);
T('  each copy follows the head', 'copy', 3, reseal, {}, true);
T('Council seals one key short', 'head', 0, reseal, { signatures: council.slice(0, C.quorum - 1) }, false);
T('Council seals with one copy missing', 'head', 0, reseal, { outputs: headOuts.slice(0, -1) }, false);
T('Council seal backdates its heartbeat', 'head', 0, reseal, { state: { ...reseal.state, 23: String(B1 - 500), 24: String(B1 - 500 + C.payoutDelayBlocks) } }, false);
T('Council seal shortens the payout delay', 'head', 0, reseal, { state: { ...reseal.state, 24: String(B1 + 1) } }, false);
const frozenHead = { ...headState, 27: '1', 28: String(B0) };
T('Council lifts a freeze itself', 'head', 0, reseal, { inputs: [headCoin(frozenHead), ...copies], state: { ...reseal.state, 27: '0', 28: String(B0) } }, false);
const freeze = { ...reseal, state: { ...headState, 21: '8', 27: '1', 28: String(B1), 29: '2' }, signatures: guardians.slice(0, G.freeze) };
T('guardians freeze', 'head', 0, freeze, {}, true);
T('freeze one guardian short', 'head', 0, freeze, { signatures: guardians.slice(0, G.freeze - 1) }, false);
T('freeze that also swaps the approved list', 'head', 0, freeze, { state: { ...freeze.state, 20: '0x' + '77'.repeat(32) } }, false);
T('freeze that also swaps a Council key', 'head', 0, freeze, { state: { ...freeze.state, 61: STRANGER } }, false);
T('one copy frozen on its own', 'copy', 0, { block: B1, inputs: [copy()], outputs: [out(S.copy.address, '1', SEAL, true, 44)], state: { ...seal, 27: '1', 19: '0' }, signatures: guardians.slice(0, G.freeze) }, {}, true);
T('one copy frozen by too few', 'copy', 0, { block: B1, inputs: [copy()], outputs: [out(S.copy.address, '1', SEAL, true, 44)], state: { ...seal, 27: '1', 19: '0', 16: '-1' }, signatures: guardians.slice(0, G.freeze - 1) }, {}, false);
T('one copy unfrozen on its own', 'copy', 0, { block: B1, inputs: [copy({ ...seal, 27: '1' })], outputs: [out(S.copy.address, '1', SEAL, true, 44)], state: { ...seal, 27: '0', 16: '-1', 19: '0' }, signatures: [] }, {}, false);
const release = { ...reseal, inputs: [headCoin(frozenHead), ...copies], state: { ...frozenHead, 21: '8', 27: '0', 29: '3' }, signatures: guardians.slice(0, G.release) };
T('guardian majority releases', 'head', 0, release, {}, true);
T('release one short', 'head', 0, release, { signatures: guardians.slice(0, G.release - 1) }, false);
const newCouncil = council.map((_, i) => fake('D1', i + 1));
const SB = B0 + cfg.succession.afterSilenceBlocks + 1;
const succ = { block: SB, inputs: [headCoin(), ...copies], outputs: headOuts,
  state: { ...headState, ...keysAt(newCouncil), 20: '0x00', 26: '0x00', 21: '8', 24: String(B0 + C.payoutDelayBlocks), 27: '0', 29: '4' }, signatures: guardians.slice(0, G.succession) };
T('succession after a long silence', 'head', 0, succ, {}, true);
T('succession while the Council is alive', 'head', 0, succ, { block: B0 + 1000 }, false);
T('succession one guardian short', 'head', 0, succ, { signatures: guardians.slice(0, G.succession - 1) }, false);
T('succession that approves a list itself', 'head', 0, succ, { state: { ...succ.state, 20: appr.root.data } }, false);
T('succession that fakes a fresh heartbeat', 'head', 0, succ, { state: { ...succ.state, 23: String(SB), 24: String(SB + C.payoutDelayBlocks) } }, false);
const FB2 = B0 + cfg.succession.afterFrozenBlocks + 1;
T('succession after a long freeze, Council still beating', 'head', 0, succ, { block: FB2, inputs: [headCoin({ ...frozenHead, 23: String(FB2 - 10) }), ...copies],
  state: { ...succ.state, 23: String(FB2 - 10), 24: String(FB2 - 10 + C.payoutDelayBlocks), 28: String(B0) } }, true);
T('a copy alone cannot become a head', 'copy', 0, reseal, { inputs: [copy(), ...copies.slice(1)], signatures: [] }, false);

// Guardian renewal: check-ins and the election of a candidate into an inactive guardian's seat.
const checkin = { ...reseal, state: { ...headState, 21: '8', 29: '5', 102: String(B1) }, signatures: [guardians[2]] };
T('a guardian checks in', 'head', 0, checkin, {}, true);
T('check-in that moves another guardian time', 'head', 0, checkin, { state: { ...checkin.state, 103: String(B1) } }, false);
T('check-in with no guardian signing', 'head', 0, checkin, { signatures: [STRANGER] }, false);
T('check-in that changes a guardian key', 'head', 0, checkin, { state: { ...checkin.state, 84: STRANGER } }, false);
const EB = B0 + 200000, CAND = fake('CA', 1);
const seen = (old) => Object.fromEntries(guardians.map((_, i) => [100 + i, String(old.includes(i) ? EB - G.inactiveAfterBlocks - 5 : EB - 100)]));
const electHead = (old) => ({ ...headState, ...seen(old), 23: String(EB - 50), 24: String(EB - 50 + C.payoutDelayBlocks) });
const elect = (old, signers, over = {}) => ({ ...reseal, block: EB, inputs: [headCoin(electHead(old)), ...copies],
  state: { ...electHead(old), 21: '8', 29: '6', 52: '4', 84: CAND, 104: String(EB), ...over }, signatures: [CAND, ...signers] });
const others = guardians.filter((_, i) => i !== 4);
T('election: candidate in seat 4, 5 of 8 active guardians', 'head', 0, elect([4], others.slice(0, 5)), {}, true);
T('election: 4 of 8 active is not a majority', 'head', 0, elect([4], others.slice(0, 4)), {}, false);
T('election: the candidate did not sign', 'head', 0, { ...elect([4], others.slice(0, 5)), signatures: others.slice(0, 5) }, {}, false);
T('election: the seat holder is still active', 'head', 0, elect([], others.slice(0, 6)), {}, false);
T('election: the candidate already holds a seat', 'head', 0, elect([4], others.slice(0, 5), { 84: guardians[1] }), { signatures: [guardians[1], guardians[0], guardians[2], guardians[3], guardians[5], guardians[6]] }, false);
T('election: another seat changed too', 'head', 0, elect([4], others.slice(0, 5), { 85: STRANGER }), {}, false);
T('election: also swaps a Council key', 'head', 0, elect([4], others.slice(0, 5), { 61: STRANGER }), {}, false);
T('election: inactive guardians do not count as voters', 'head', 0, elect([0, 1, 2, 3, 4, 5], [guardians[0], guardians[1], guardians[2], guardians[6], guardians[7]]), {}, false);
T('election: 3 active guardians left, all 3 sign', 'head', 0, elect([0, 1, 2, 3, 4, 5], [guardians[6], guardians[7], guardians[8]]), {}, true);
T('election: 3 active guardians left, 2 sign', 'head', 0, elect([0, 1, 2, 3, 4, 5], [guardians[6], guardians[7]]), {}, false);

// WHOLE TRANSACTIONS (2026-10-17, after release-R3 failed on mainnet: five guardian signatures made the seal copy read a
// freeze). An accepted transaction must pass the script of EVERY contract input, not only the one a case names.
const byAddress = Object.fromEntries(Object.entries(S).map(([k, v]) => [v.address.toUpperCase(), k]));
for (const c of [...cases]) {
  if (!c.expect || c.alone) continue;
  (c.inputs || []).forEach((inp, j) => {
    const k = byAddress[String(inp.address).toUpperCase()];
    if (!k || j === c.input) return;
    cases.push({ ...c, name: c.name + ' / input ' + j + ' (' + k + ')', script: S[k].script, input: j, expect: true });
  });
}
for (const c of cases) delete c.alone;

// Run.
const dir = path.join(OUT, 'cases'); fs.mkdirSync(path.join(dir, 'runtime'), { recursive: true });
const cc = spawnSync(path.join(JDK, process.platform === 'win32' ? 'javac.exe' : 'javac'), ['-cp', JAR, '-d', path.join(dir, 'runtime'), RUNNER], { encoding: 'utf8' });
if (cc.status !== 0) throw new Error(cc.stderr);
fs.writeFileSync(path.join(dir, 'cases.json'), JSON.stringify(cases.map(({ expect, ...x }) => x)));
const run = spawnSync(path.join(JDK, process.platform === 'win32' ? 'java.exe' : 'java'), ['-cp', JAR + path.delimiter + path.join(dir, 'runtime'), 'KissRunScaled', path.join(dir, 'cases.json')], { encoding: 'utf8', maxBuffer: 1 << 26 });
if (run.status !== 0) throw new Error(run.stderr);
const res = JSON.parse(run.stdout.slice(run.stdout.indexOf('[')));
let bad = 0;
const table = res.map((r, i) => { const pass = r.success === cases[i].expect; if (!pass) bad++; return { name: r.name, expect: cases[i].expect, success: r.success, pass, instructions: r.instructions, exception: r.exception || null }; });
for (const t of table) console.log(t.pass ? 'PASS' : 'FAIL', (t.expect ? 'accept' : 'refuse').padEnd(7), String(t.instructions).padStart(4), t.name, t.pass ? '' : (t.exception || ''));
fs.writeFileSync(path.join(OUT, 'r2t5-cases-results.json'), JSON.stringify({ draft: gen.draft, at: new Date().toISOString(), passed: table.length - bad, total: table.length, table }, null, 2) + '\n');
console.log(`${table.length - bad} of ${table.length} as expected`);
process.exit(bad ? 1 : 0);
