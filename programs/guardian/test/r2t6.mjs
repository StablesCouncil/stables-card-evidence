#!/usr/bin/env node
/*
 * THE PROGRAM'S R2T6 DECISIONS (R2T6_PLAN step 6, 2026-11-05): guardian.mjs with guardian-r2t6.mjs, pass by pass,
 * against a fixture node. The node is the live R2T6 seal head, its 5 copies and the 16 exit-record coins
 * (fixtures/r2t6-live.json, read from the PC approver node 9705 and lab node 9305 at seal 4), plus an invented vault
 * coin and invented requests; the package check is scripted per request. Every transaction goes through Minima's own
 * script engine (KissRunScaled) with the deployed R2T6 scripts. Nothing reaches a real node.
 *
 *   node test/r2t6.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardian, loadConfig } from '../guardian.mjs';
import * as core from '../guardian-core.mjs';
import * as offline from '../offline.mjs';
import * as r6 from '../guardian-r2t6.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const gen = JSON.parse(fs.readFileSync(path.resolve(ROOT, '../../stream_1_app/work/simcard/evidence/R2T6-DEPLOY-01/generation.json'), 'utf8'));
const live = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/r2t6-live.json'), 'utf8'));
const C = gen.contracts, g = gen.config, W = gen.tokens.Winiwa, T0 = live.tip;
const workDir = path.join(HERE, 'out', 'r2t6'); fs.mkdirSync(workDir, { recursive: true });
const clone = x => JSON.parse(JSON.stringify(x));
const setPorts = (coin, over) => { const c = clone(coin); for (const [p, v] of Object.entries(over)) { const s = c.state.find(x => x.port === Number(p)); if (s) s.data = String(v); else c.state.push({ port: Number(p), data: String(v) }); } return c; };
const jp = offline.javaPaths();
const recordTree = r6.recordTreeTool({ ...jp, workDir });
const mmrCache = {};
const mmrRoot = async leaves => { const k = JSON.stringify(leaves); return (mmrCache[k] ??= offline.mmrRoots([leaves], { workDir })[0]); };
const mmrProofs = async leaves => offline.mmrProofs([leaves], { workDir })[0];

let n = 0, passed = 0;
function expect(name, ok, detail = '') { n++; if (ok) passed++; console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : detail); }

function fixtureNode(world) {
  const sent = [];
  const rpc = async cmd => {
    sent.push(cmd.split(' ')[0]);
    if (cmd === 'status') return { chain: { block: world.tip } };
    const m = /^coins address:(\S+)$/.exec(cmd);
    if (m) return [world.head, ...world.copies, ...world.records, ...world.vault, ...world.requests, ...world.contested].filter(c => c && core.same(c.address, m[1]));
    if (cmd.startsWith('mmrcreate nodes:')) return { root: { data: await mmrRoot(JSON.parse(cmd.slice(16))) } };
    throw new Error('the fixture node does not answer ' + cmd.split(' ')[0]);
  };
  return { rpc, sent };
}
// A card coin whose first byte puts it in shard 2 of 8.
const card = k => '0x5A' + k.repeat(31);
const request = (id, created, extra = {}, address = C.request.address) => ({ coinid: id, address, amount: '0.00000001', tokenamount: '0.00000001', tokenid: W, storestate: true,
  created: String(created), state: Object.entries({ 0: g.generation.tag, 10: '0x' + '0F'.repeat(32), 11: card(id.slice(4, 6)), 12: '10', 13: W, 14: '0x' + 'AB'.repeat(32), 17: '0.00000001', 51: '0', ...extra })
    .map(([port, data]) => ({ port: Number(port), data })) });
const vaultCoin = { coinid: '0x' + '22'.repeat(32), address: C.vault.address, amount: '500', tokenamount: '500', tokenid: W, storestate: false, created: String(T0 - 9000) };
// The live head's heartbeat stands for "the Council is alive"; seat 0 checked in recently.
const baseWorld = () => ({ tip: T0, head: setPorts(live.head[0], { 100: T0 - 50 }), copies: clone(live.copy), records: clone(live.record), vault: [clone(vaultCoin)], requests: [], contested: [] });
const hb = Number(core.portsOf(live.head[0])[23]);
const approve = { verdict: 'approve', code: 'accepted', coinId: '0x01' };
const forged = { verdict: 'reject', code: 'signature', detail: 'the bundle signature does not verify' };
const ID = k => core.norm('0x' + k.repeat(32));

let dirN = 0;
function setup({ world, verdicts = {}, cfgOver = {} }) {
  const dataDir = path.join(workDir, 'g' + (++dirN)); fs.rmSync(dataDir, { recursive: true, force: true });
  const cfg = { ...loadConfig(null), dataDir, seat: 0, publicKey: gen.keys.guardians[0], ...cfgOver };
  const node = fixtureNode(world), alerts = [];
  const checker = id => verdicts[core.norm(id)] || { error: true, detail: 'no verdict scripted' };
  const G = createGuardian({ cfg, gen, rpc: node.rpc, checker, mmrRoot, alertOut: a => alerts.push(a), r6, recordTree, mmrProofs,
    scriptCheck: (spec, o) => offline.scriptCheck(spec, { ...o, contracts: gen.contracts, workDir }) });
  return { G, node, alerts, cfg, dataDir };
}

// 1. The paid-coin lists: the live records (nothing paid yet) are in step from the start, and published.
{
  const w = baseWorld();
  const { G, alerts, dataDir } = setup({ world: w });
  await G.pass();
  const pub = JSON.parse(fs.readFileSync(path.join(dataDir, 'exit-lists.json'), 'utf8'));
  const shards = Object.values(pub.lists).reduce((s, t) => s + Object.keys(t).length, 0);
  expect('the 16 live record coins rebuild from empty lists, published as exit-lists.json', shards === 16 && !alerts.some(a => a.subject === 'exit lists'), JSON.stringify(alerts));
  // A payout inserts a key: the record coin then carries it in port 11, and the guardian follows.
  const rc = w.records.find(c => core.portsOf(c)[39].toUpperCase() === W.toUpperCase() && core.portsOf(c)[44] === '2');
  const k1 = r6.keyOf(card('A1')), k2 = r6.keyOf(card('A2'));
  const after1 = recordTree({ depth: g.exitRecord.depth, keys: [k1] }).root, after2 = recordTree({ depth: g.exitRecord.depth, keys: [k1, k2] }).root;
  w.records = w.records.map(c => c === rc ? setPorts(c, { 40: after1, 11: card('A1') }) : c);
  await G.pass();
  expect('...one payout later: the key named in port 11 is added (the root rebuilds)', G.state.records.Winiwa['2'].keys.length === 1);
  // Two payouts between passes: out of step; a published list that rebuilds is taken, one that does not is refused.
  w.records = w.records.map(c => core.portsOf(c)[44] === '2' && core.portsOf(c)[39].toUpperCase() === W.toUpperCase() ? setPorts(c, { 40: after2, 11: card('A2') }) : c);
  const k3 = r6.keyOf(card('A3'));
  w.records = w.records.map(c => core.portsOf(c)[44] === '2' && core.portsOf(c)[39].toUpperCase() === W.toUpperCase()
    ? setPorts(c, { 40: recordTree({ depth: g.exitRecord.depth, keys: [k1, k2, k3] }).root, 11: card('A3') }) : c);
  const wrong = path.join(workDir, 'lists-wrong.json'), right = path.join(workDir, 'lists-right.json');
  fs.writeFileSync(wrong, JSON.stringify({ lists: { Winiwa: { 2: [k1, k3, k2] } } }));
  fs.writeFileSync(right, JSON.stringify({ lists: { Winiwa: { 2: [k1, k2, k3] } } }));
  const s2 = setup({ world: w, cfgOver: { r2t6: { listSources: [wrong] } } });
  await s2.G.pass();
  expect('...a list in the wrong order (another root) is refused and the owner hears', s2.alerts.some(a => a.subject === 'exit lists') && !(s2.G.state.records.Winiwa?.['2']?.keys.length), JSON.stringify(s2.alerts.map(a => a.text)));
  const s3 = setup({ world: w, cfgOver: { r2t6: { listSources: [wrong, right] } } });
  await s3.G.pass();
  expect('...the next source, whose list rebuilds the root, is taken', s3.G.state.records.Winiwa['2'].keys.length === 3 && !s3.alerts.some(a => a.subject === 'exit lists'));
}
// 2. A bad request, found bad twice: the R2T6 stop, accepted by the request and copy scripts with this seat's key.
{
  const w = baseWorld(); w.requests = [request(ID('B1'), T0 - 5)];
  const { G, cfg, node } = setup({ world: w, verdicts: { [ID('B1')]: forged } });
  await G.pass(); w.tip = T0 + cfg.confirmBlocks; const r = await G.pass();
  const a = r.actions.find(x => x.stop) || {};
  expect('a bad request is stopped: R2T6 stop built, scripts pass offline, not posted (dry run)', a.stop === ID('B1') && a.scripts === true && a.done === 'would post (dry run)', JSON.stringify(r.actions));
  expect('a dry run sends the node read commands only', node.sent.every(c => ['status', 'coins', 'mmrcreate'].includes(c)), [...new Set(node.sent)].join(','));
}
// 3. The Council approves a request this guardian cannot check: it is stopped at once (no wait for a second verdict).
{
  const w = baseWorld(), id = ID('C1'), hp = core.portsOf(w.head), nseal = Number(hp[21]) + 1;
  w.requests = [request(id, T0 - 30)];
  const aRoot = await mmrRoot([id, core.filler('a', nseal - 1, 'R2T6 filler ')]), rRoot = await mmrRoot([core.filler('r', nseal - 1, 'R2T6 filler ')]);
  w.head = setPorts(w.head, { 20: aRoot, 120: aRoot, 121: hp[120], 122: hp[121], 130: T0 - 10, 131: hp[130], 132: hp[131], 21: nseal, 23: T0 - 10, 24: T0 - 10 + 216, 26: rRoot });
  const { G } = setup({ world: w });
  const r = await G.pass();
  const a = r.actions.find(x => x.stop) || {};
  expect('a Council approval of a request this guardian could not check is stopped in the same pass (scripts pass)', a.stop === id && a.scripts === true, JSON.stringify(r.actions));
  expect('...the approved list was rebuilt and kept for its ring slot', G.state.ring[aRoot.toUpperCase()]?.ids.includes(id));
}
// 4. A contested coin this guardian passes: the overrule (path 2) is prepared once it is 3 days old, and the deployed
// scripts accept it with five guardian keys named.
{
  const w = baseWorld(), id = ID('D1');
  w.contested = [request(id, T0 - g.fallback.waitBlocks + 3, {}, C.contested.address)];
  const { G, alerts, dataDir } = setup({ world: w, verdicts: { [id]: approve } });
  const r1 = await G.pass();
  expect('a contested coin it passes waits for its 3 days', !r1.actions.some(x => x.releasePrepared) && G.state.release[id]?.waits === T0 + 3);
  w.tip = T0 + 3; const r2 = await G.pass();
  const a = r2.actions.find(x => x.releasePrepared) || {};
  expect('...then the overrule is prepared: path 2, scripts pass with 5 guardian keys', a.releasePrepared === id && a.path === 2 && a.scripts === true, JSON.stringify(r2.actions));
  const f = JSON.parse(fs.readFileSync(path.join(dataDir, `release-prepared-${id.slice(2, 10)}.json`), 'utf8'));
  expect('...the file names the final-rejection block, and the owner hears', f.finalRejectionFrom === Number(w.contested[0].created) + g.hardening.refusalOverrule && alerts.some(x => x.subject === 'release ' + id));
  const four = offline.scriptCheck(f.spec, { signers: gen.keys.guardians.slice(0, 4), block: w.tip + 1, contracts: gen.contracts, workDir });
  expect('...and the scripts refuse the same payout with 4 guardians', !four.ok);
  // Signing across guardians: the transaction as a node lists it is signed only when it is the payout this guardian builds.
  const asNode = sp => ({ inputs: sp.inputs.map(c => ({ coinid: c.coinid, address: c.address, tokenid: c.tokenid })),
    outputs: sp.outputs.map(o => ({ address: o.address, tokenid: o.tokenid, tokenamount: o.amount, storestate: o.storestate })),
    state: Object.entries(sp.state).map(([port, data]) => ({ port: Number(port), data })) });
  expect('sign-release: the same payout is signed', r6.sameRelease(asNode(f.spec), f.spec, gen).ok);
  const t1 = asNode(f.spec); t1.outputs[0].address = '0x' + 'CD'.repeat(32);
  const t2 = asNode(f.spec); t2.state.find(x => x.port === 14).data = '0x' + 'CD'.repeat(32);
  const t3 = asNode(f.spec); t3.inputs[1].address = C.contested.address;
  expect('...a payout to another address, another port 14 or a non-vault input is refused',
    !r6.sameRelease(t1, f.spec, gen).ok && !r6.sameRelease(t2, f.spec, gen).ok && !r6.sameRelease(t3, f.spec, gen).ok);
}
// 5. A request it passes that nobody paid or refused for 3 days: the fallback payout, no signature.
{
  const w = baseWorld(), id = ID('E1');
  w.tip = hb + 100; w.head = setPorts(w.head, { 100: w.tip - 50 });
  w.requests = [request(id, w.tip - g.fallback.waitBlocks)];
  const { G } = setup({ world: w, verdicts: { [id]: approve } });
  const r = await G.pass();
  const a = r.actions.find(x => x.fallback) || {};
  expect('a request passed here, 3 days without payout or refusal: the fallback, scripts pass with no signer', a.fallback === id && a.scripts === true && a.done === 'would post (dry run)', JSON.stringify(r.actions));
  const w2 = baseWorld(); w2.tip = hb + g.fallback.heartbeatMaxAgeBlocks + 5; w2.head = setPorts(w2.head, { 100: w2.tip - 50 });
  w2.requests = [request(id, w2.tip - g.fallback.waitBlocks)];
  const s2 = setup({ world: w2, verdicts: { [id]: approve } });
  const r2 = await s2.G.pass();
  expect('...not while the Council has been silent for a day (the scripts would refuse it)', !r2.actions.some(x => x.fallback));
  const w3 = baseWorld(); w3.tip = hb + 100; w3.head = setPorts(w3.head, { 100: w3.tip - 50 });
  w3.requests = [request(id, w3.tip - g.fallback.waitBlocks + 1)];
  const s3 = setup({ world: w3, verdicts: { [id]: approve } });
  expect('...nor one block before its 3 days', !(await s3.G.pass()).actions.some(x => x.fallback));
  const w4 = baseWorld(); w4.tip = hb + 100; w4.head = setPorts(w4.head, { 100: w4.tip - 50 });
  w4.requests = [request(id, w4.tip - g.fallback.waitBlocks)];
  const s4 = setup({ world: w4, verdicts: { [id]: forged } });
  expect('...nor for a request it found bad', !(await s4.G.pass()).actions.some(x => x.fallback));
}

// 6. Head acts by hand (the rehearsal's check-in, freeze and release): through the deployed head and copy scripts, the
// freeze and its release with their MAST branch in the witness.
{
  const w = baseWorld();
  const { G } = setup({ world: w });
  const ci = await G.headActByHand('checkin', [0, 1, 2, 3, 4]);
  expect('a check-in of seats 0 to 4 in one transaction passes the scripts (no branch needed)', ci.scripts === true && ci.branch === null, JSON.stringify(ci.detail));
  const fz = await G.headActByHand('freeze', [0, 1, 2]);
  expect('a freeze by 3 guardians passes, carrying the act 2 branch', fz.scripts === true && fz.branch === gen.branches.act2.address, JSON.stringify(fz.detail));
  expect('...by 2 guardians it is refused', (await G.headActByHand('freeze', [0, 1])).scripts === false);
  const hp = core.portsOf(w.head), spec = core.freezeSpec({ head: w.head, copies: w.copy || w.copies, block: T0, sealCopies: g.council.sealCopies });
  const noBranch = offline.scriptCheck(spec, { signers: gen.keys.guardians.slice(0, 3), block: T0 + 1, contracts: gen.contracts, workDir });
  expect('...and without its branch in the witness it is refused', !noBranch.ok);
  expect('unfreeze is refused while not frozen', (await G.headActByHand('unfreeze', [0, 1, 2, 3, 4])).done === 'refused');
  w.head = setPorts(w.head, { 27: 1, 28: T0 - 10 }); w.copies = w.copies.map(c => setPorts(c, { 27: 1, 28: T0 - 10 }));
  const uf = await G.headActByHand('unfreeze', [0, 1, 2, 3, 4]);
  expect('a frozen vault released by 5 guardians passes, carrying the act 3 branch', uf.scripts === true && uf.branch === gen.branches.act3.address, JSON.stringify(uf.detail));
  expect('...by 4 it is refused', (await G.headActByHand('unfreeze', [0, 1, 2, 3])).scripts === false);
  void hp;
}

console.log(`${passed} of ${n} as expected`);
process.exit(passed === n ? 0 : 1);
