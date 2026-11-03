#!/usr/bin/env node
/*
 * THE PROGRAM'S DECISIONS (2026-11-03): guardian.mjs driven pass by pass against a fixture node. The node is the live
 * R2T5 seal head and copies (fixtures/r2t5-live-head.json, read from lab node 9305) plus invented requests; the package
 * check is scripted per request. Every transaction the program builds goes through Minima's own script engine
 * (KissRunScaled) with the deployed scripts, as in a real dry run. Nothing reaches a real node.
 *
 *   node test/logic.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGuardian, nodeRpc, verifyLog, loadConfig } from '../guardian.mjs';
import * as core from '../guardian-core.mjs';
import * as offline from '../offline.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const gen = JSON.parse(fs.readFileSync(path.resolve(ROOT, '../../stream_1_app/work/simcard/evidence/R2T5-DEPLOY-03/generation.json'), 'utf8'));
const live = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/r2t5-live-head.json'), 'utf8'));
const C = gen.contracts, W = gen.tokens.Winiwa, T0 = live.tip;
const workDir = path.join(HERE, 'out'); fs.mkdirSync(workDir, { recursive: true });
const clone = x => JSON.parse(JSON.stringify(x));
const setPorts = (coin, over) => { const c = clone(coin); for (const [p, v] of Object.entries(over)) { const s = c.state.find(x => x.port === Number(p)); if (s) s.data = String(v); else c.state.push({ port: Number(p), data: String(v) }); } return c; };

// mmrcreate, offline (Minima's own MMR), cached.
const mmrCache = {};
const mmrRoot = async leaves => { const k = JSON.stringify(leaves); return (mmrCache[k] ??= offline.mmrRoots([leaves], { workDir })[0]); };

let n = 0, passed = 0;
const results = [];
function expect(name, ok, detail = '') { n++; if (ok) passed++; results.push({ name, pass: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : detail); }

// A fixture node: what `coins address:` and `status` answer, and a record of every command it was sent.
function fixtureNode(world) {
  const sent = [];
  const rpc = async cmd => {
    sent.push(cmd.split(' ')[0]);
    if (world.down) throw new Error('connect ECONNREFUSED');
    if (cmd === 'status') return { chain: { block: world.tip } };
    const m = /^coins address:(\S+)$/.exec(cmd);
    if (m) return [world.head, ...world.copies, ...world.requests, ...world.contested].filter(c => c && core.same(c.address, m[1]));
    if (cmd.startsWith('mmrcreate nodes:')) return { root: { data: await mmrRoot(JSON.parse(cmd.slice(16))) } };
    throw new Error('the fixture node does not answer ' + cmd.split(' ')[0]);
  };
  return { rpc, sent };
}
const request = (id, created, extra = {}, address = C.request.address) => ({ coinid: id, address, amount: '0.00000001', tokenamount: '0.00000001', tokenid: W, storestate: true,
  created: String(created), state: Object.entries({ 0: '0x52325445', 10: '0x' + '0F'.repeat(32), 11: '0x5A' + id.slice(4, 66), 12: '10', 13: W, 14: '0x' + 'AB'.repeat(32), 17: '0.00000001', ...extra }).map(([port, data]) => ({ port: Number(port), data })) });

let dirN = 0;
function setup({ world, verdicts = {}, cfgOver = {}, node2 = null }) {
  const dataDir = path.join(workDir, 'g' + (++dirN)); fs.rmSync(dataDir, { recursive: true, force: true });
  const cfg = { ...loadConfig(null), dataDir, seat: 0, publicKey: gen.keys.guardians[0], ...cfgOver };
  const node = fixtureNode(world), alerts = [];
  const checker = id => { const v = verdicts[core.norm(id)]; return typeof v === 'function' ? v(world.tip) : v || { error: true, detail: 'no verdict scripted' }; };
  const G = createGuardian({ cfg, gen, rpc: node.rpc, rpc2: node2, checker, mmrRoot, alertOut: a => alerts.push(a),
    scriptCheck: (spec, o) => offline.scriptCheck(spec, { ...o, contracts: gen.contracts, workDir }) });
  return { G, node, alerts, cfg };
}
// Seat 0 checked in recently, so only the check-in tests check in.
const baseWorld = () => ({ tip: T0, head: setPorts(live.head[0], { 100: T0 - 50 }), copies: clone(live.copies), requests: [], contested: [] });
const approve = { verdict: 'approve', code: 'accepted', coinId: '0x01' };
const forged = { verdict: 'reject', code: 'signature', detail: 'the bundle signature does not verify' };
const ID = k => core.norm('0x' + k.repeat(32));

// 1. A request whose package passes: nothing is done.
{
  const w = baseWorld(); w.requests = [request(ID('A1'), T0 - 5)];
  const { G, alerts } = setup({ world: w, verdicts: { [ID('A1')]: approve } });
  const r = await G.pass();
  expect('a request that passes the package check is left alone', r.actions.length === 0 && G.state.requests[ID('A1')].class === 'good' && !alerts.length, JSON.stringify(r));
}
// 2. A bad request: found bad, checked again confirmBlocks later, then a stop, built and accepted by the scripts offline.
{
  const w = baseWorld(); w.requests = [request(ID('B1'), T0 - 5)];
  const { G, node, alerts, cfg } = setup({ world: w, verdicts: { [ID('B1')]: forged } });
  const r1 = await G.pass();
  expect('a bad request is not stopped on the first verdict', r1.actions.length === 0 && G.state.requests[ID('B1')].class === 'bad');
  w.tip = T0 + 5; const r2 = await G.pass();
  expect('...nor before it is checked again', r2.actions.length === 0);
  w.tip = T0 + cfg.confirmBlocks; const r3 = await G.pass();
  const a = r3.actions[0] || {};
  expect('...and is stopped once found bad twice: built, scripts pass offline, not posted (dry run)', a.stop === ID('B1') && a.scripts === true && a.done === 'would post (dry run)', JSON.stringify(a));
  expect('...the owner hears of the stop', alerts.some(x => x.subject === 'stop ' + ID('B1')));
  expect('a dry run sends the node read commands only', node.sent.every(c => ['status', 'coins', 'mmrcreate'].includes(c)), [...new Set(node.sent)].join(','));
}
// 3. "Too early" verdicts wait.
{
  const w = baseWorld(); w.requests = [request(ID('C1'), T0 - 2)];
  const { G } = setup({ world: w, verdicts: { [ID('C1')]: { verdict: 'reject', code: 'depth', detail: 'deposit has 1 confirmations, needs 3' } } });
  await G.pass(); w.tip += 50; const r = await G.pass();
  expect('a "not final yet" verdict waits, never stops', r.actions.length === 0 && G.state.requests[ID('C1')].class === 'wait');
}
// 4. A request that cannot be checked: the owner hears; close to the fallback, it is stopped (fails closed).
{
  const w = baseWorld(); w.requests = [request(ID('D1'), T0 - 10)];
  const { G, alerts } = setup({ world: w });
  const r = await G.pass();
  expect('a request that cannot be checked goes to the owner, far from its payable time', r.actions.length === 0 && alerts.some(a => a.subject === 'unchecked ' + ID('D1')));
  const w2 = baseWorld(); w2.requests = [request(ID('D2'), T0 - gen.config.fallback.waitBlocks + 100)];
  const s2 = setup({ world: w2 }); const r2 = await s2.G.pass();
  expect('...and is stopped when its fallback is less than failClosedBlocks away', r2.actions[0]?.stop === ID('D2') && r2.actions[0]?.scripts === true, JSON.stringify(r2.actions));
}
// 5. Contested requests: a stopped one is left; a released one found bad is stopped again.
{
  const w = baseWorld();
  w.contested = [request(ID('E1'), T0 - 50, { 51: '0' }, C.contested.address), request(ID('E2'), T0 - 50, { 51: '1' }, C.contested.address)];
  const { G, cfg } = setup({ world: w, verdicts: { [ID('E1')]: forged, [ID('E2')]: forged } });
  await G.pass(); w.tip += cfg.confirmBlocks; const r = await G.pass();
  expect('a contested request already stopped is left; a released one found bad is stopped again (scripts pass)',
    r.actions.length === 1 && r.actions[0].stop === ID('E2') && r.actions[0].scripts === true, JSON.stringify(r.actions));
}
// 6. The sealed lists. The live seal (empty lists) rebuilds; an approval of a bad request raises a freeze for the owner.
{
  const w = baseWorld();
  const { G, alerts } = setup({ world: w });
  await G.pass();
  const s = Object.values(G.state.seals)[0];
  expect('the live seal\'s approved and rejected roots rebuild from the chain', s.approved.matched && s.rejected.matched, JSON.stringify(s));
  expect('...and raise nothing', !alerts.length, JSON.stringify(alerts));
}
{
  const w = baseWorld(); w.requests = [request(ID('F1'), T0 - 300), request(ID('F2'), T0 - 300)];
  const sealNo = Number(core.portsOf(w.head)[21]);
  const root = await mmrRoot([...[ID('F1'), ID('F2')].sort(), core.filler('a', sealNo - 1)]);
  w.head = core.portsOf(w.head) && setPorts(w.head, { 20: root });
  const { G, alerts } = setup({ world: w, verdicts: { [ID('F1')]: approve, [ID('F2')]: forged } });
  const r = await G.pass();
  const a = alerts.find(x => x.level === 'urgent' && x.subject.startsWith('seal'));
  expect('a seal that approves a request found bad: urgent alert, freeze prepared for the owner', !!a && r.actions.some(x => x.freezeProposed) && fs.existsSync(path.join(G.files.state, '..', `freeze-prepared-${sealNo}.json`)), JSON.stringify(alerts));
  const prep = JSON.parse(fs.readFileSync(path.join(G.files.state, '..', `freeze-prepared-${sealNo}.json`), 'utf8'));
  const chk = offline.scriptCheck(prep.spec, { signers: gen.keys.guardians.slice(0, 3), block: w.tip + 1, contracts: C, workDir });
  expect('...the prepared freeze passes the deployed scripts with 3 guardians named', chk.ok, JSON.stringify(chk.inputs));
}
{
  const w = baseWorld(); w.head = setPorts(w.head, { 20: '0x' + '77'.repeat(32) });
  const { G, alerts } = setup({ world: w });
  await G.pass();
  expect('an approved root that cannot be rebuilt goes to the owner', alerts.some(a => a.level === 'important' && /cannot be rebuilt/.test(a.text)));
}
{
  const w = baseWorld(); w.requests = [request(ID('A7'), T0 - 300)];
  const { G, alerts } = setup({ world: w, verdicts: { [ID('A7')]: approve } });
  const r = await G.pass();
  expect('a seal that leaves out a request the guardian passed: a warning, no freeze', alerts.some(a => a.level === 'warning' && a.subject.startsWith('left out')) && !r.actions.some(x => x.freezeProposed), JSON.stringify(alerts));
}
{
  // The refusal gap: the approvers refuse a request this guardian passed. In R2T5 that money stays locked in the vault.
  const w = baseWorld(); w.requests = [request(ID('B8'), T0 - 300)];
  const sealNo = Number(core.portsOf(w.head)[21]);
  w.head = setPorts(w.head, { 26: await mmrRoot([ID('B8'), core.filler('r', sealNo - 1)]) });
  const { G, alerts } = setup({ world: w, verdicts: { [ID('B8')]: approve } });
  const r = await G.pass();
  expect('a seal that refuses a request the guardian passed: urgent alert, no freeze', alerts.some(a => a.level === 'urgent' && a.subject.startsWith('refused good')) && !r.actions.some(x => x.freezeProposed), JSON.stringify(alerts));
}
// 7. Check-ins.
{
  const w = baseWorld(); w.head = setPorts(w.head, { 100: T0 - 13000, 23: T0 - 10 });
  const { G } = setup({ world: w });
  const r = await G.pass();
  const a = r.actions.find(x => x.checkIn === 0) || {};
  expect('a check-in is built when due, scripts pass offline, not posted', a.scripts === true && a.done === 'would post (dry run)', JSON.stringify(a));
  w.tip += 10; const r2 = await G.pass();
  expect('...and not built again inside the head\'s slack', !r2.actions.some(x => x.checkIn != null));
}
{
  const w = baseWorld(); w.head = setPorts(w.head, { 100: T0 - 100 });
  const r = await setup({ world: w }).G.pass();
  expect('no check-in when the last one is recent', !r.actions.some(x => x.checkIn != null));
  const w2 = baseWorld(); w2.head = setPorts(w2.head, { 100: T0 - 13000, 23: T0 - 200 });
  const r2 = await setup({ world: w2 }).G.pass();
  expect('no check-in while the Council is about to seal (it needs every copy)', !r2.actions.some(x => x.checkIn != null));
  const w3 = baseWorld(); w3.head = setPorts(w3.head, { 100: T0 - 13000, 23: T0 - 10 }); w3.copies = w3.copies.slice(1);
  const r3 = await setup({ world: w3 }).G.pass();
  expect('a check-in with a copy busy elsewhere waits for the next pass', r3.actions.some(x => x.checkIn === 0 && x.done === 'waits'), JSON.stringify(r3.actions));
}
// 8. Blind, wrong seat, sources disagree.
{
  const w = baseWorld(); w.down = true;
  const { G, alerts } = setup({ world: w });
  const r = await G.pass();
  expect('a node that cannot be read: the owner hears at once (urgent)', r.blind && alerts.some(a => a.level === 'urgent' && a.subject === 'node'));
}
{
  const { G, alerts } = setup({ world: baseWorld(), cfgOver: { publicKey: '0x' + 'AA'.repeat(32) } });
  await G.pass();
  expect('a seat that no longer holds this guardian\'s key: urgent alert', alerts.some(a => a.subject === 'seat'));
}
{
  const w = baseWorld(), w2 = baseWorld(); w2.requests = [request(ID('G1'), T0 - 5)];
  const { G, alerts } = setup({ world: w, node2: fixtureNode(w2).rpc });
  await G.pass();
  expect('two nodes that disagree on the open requests: urgent alert', alerts.some(a => a.subject === 'sources'));
}
{
  const w = baseWorld();
  w.head = setPorts(w.head, Object.fromEntries(Array.from({ length: 9 }, (_, i) => [100 + i, i < 2 ? T0 - 50 : T0 - 60000])));
  const { G, alerts } = setup({ world: w });
  const r = await G.pass();
  expect('fewer active seats than an election needs: the owner hears', r.activeSeats === 2 && alerts.some(a => a.subject === 'active seats'), JSON.stringify(r.activeSeats));
  const w2 = baseWorld(); w2.head = setPorts(w2.head, Object.fromEntries(Array.from({ length: 9 }, (_, i) => [100 + i, T0 - 50])));
  const s2 = setup({ world: w2 }); await s2.G.pass();
  expect('...and nothing when every seat is active', !s2.alerts.some(a => a.subject === 'active seats'));
}
// 9. The gates: dry-run RPC refuses writes; --post needs the config's allowPost; the log's chain shows a change.
{
  const rpc = nodeRpc('http://127.0.0.1:1');
  let refused = 0;
  for (const c of ['txnpost id:x', 'txnsign id:x publickey:0x01', 'txncreate id:x', 'send amount:1 address:0x01', 'keys action:new']) await rpc(c).catch(e => { if (/refused/.test(e.message)) refused++; });
  expect('in dry run the program refuses to send any write or key command to a node', refused === 5);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'guardian.mjs'), 'status', '--post', '--config', path.join(ROOT, 'guardian.config.example.json')], { encoding: 'utf8' });
  expect('--post without "allowPost": true in the config is refused before anything runs', r.status !== 0 && /allowPost/.test(r.stderr), r.stderr);
}
{
  const { G } = setup({ world: baseWorld() });
  await G.pass(); await G.pass();
  const ok = verifyLog(G.files.log);
  const lines = fs.readFileSync(G.files.log, 'utf8').split('\n'); lines[1] = lines[1].replace('"pass"', '"pas5"'); fs.writeFileSync(G.files.log + '.edited', lines.join('\n'));
  expect('the public log\'s hash chain verifies, and an edited line is found', ok.ok && verifyLog(G.files.log + '.edited').ok === false, JSON.stringify(ok));
}

fs.writeFileSync(path.join(workDir, 'logic-results.json'), JSON.stringify({ at: new Date().toISOString(), passed, total: n, results }, null, 1));
console.log(`program decisions: ${passed} of ${n} as expected`);
process.exit(passed === n ? 0 : 1);
