#!/usr/bin/env node
/*
 * PUBLISHING THE LOG (2026-11-03): publish-log.mjs against a throwaway repository on this machine (a bare repository
 * stands in for the guardian's GitHub repository). Nothing leaves the machine.
 *
 *   node test/publish.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { publishLog, publishDue, buildStatus, STATUS_SCHEMA } from '../publish-log.mjs';
import { verifyLog } from '../guardian.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const W = path.join(HERE, 'out', 'publish-' + Date.now());
fs.mkdirSync(W, { recursive: true });
const git = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
const sha = x => createHash('sha256').update(x).digest('hex');

let n = 0, passed = 0;
const results = [];
function expect(name, ok, detail = '') { n++; if (ok) passed++; results.push({ name, pass: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : detail); }

// The guardian's repository (bare, as on GitHub) and the guardian's clone of it.
const bare = path.join(W, 'remote.git'), clone = path.join(W, 'clone');
spawnSync('git', ['init', '-q', '--bare', bare]);
spawnSync('git', ['clone', '-q', bare, clone]);
const commits = () => Number(git(bare, 'rev-list', '--count', '--all').stdout.trim() || 0);

// A log written the way guardian.mjs writes it.
const logFile = path.join(W, 'guardian-log.jsonl');
let prev = '0'.repeat(64);
function logLine(event, data = {}) {
  const body = { at: new Date().toISOString(), guardian: 'watch-only', seat: 6, event, ...data, prev };
  body.hash = sha(JSON.stringify(body)); prev = body.hash;
  fs.appendFileSync(logFile, JSON.stringify(body) + '\n');
}
logLine('seal checked', { seal: '104', approvedRebuilt: true, rejectedRebuilt: true });
logLine('pass', { tip: 2399448, seal: '104', open: 0 });

const cfg = { seat: 6, publicKey: null, allowPost: false, publish: { repoDir: clone, everyMinutes: 60, push: true, name: 'Lantern', repoUrl: 'https://example.invalid/lantern-log' } };
const st = { requests: {}, seals: { a: { approved: { matched: true }, rejected: { matched: true } } }, lastPass: { tip: 2399448, at: '2026-11-02T22:03:58Z', open: 0 },
  head: { seal: 104, frozen: false, activeSeats: 9, seatCheckIn: 2372064 } };

// 1. First publish: pushed, with the log, the status and a README.
let r = publishLog({ cfg, st, logFile });
expect('first publish is pushed', r.done === 'pushed' && commits() === 1, JSON.stringify(r));
const pub = path.join(W, 'check');
spawnSync('git', ['clone', '-q', bare, pub]);
expect('the published log is the local log, and its hash chain holds', fs.readFileSync(path.join(pub, 'guardian-log.jsonl'), 'utf8') === fs.readFileSync(logFile, 'utf8') && verifyLog(path.join(pub, 'guardian-log.jsonl')).ok);
const status = JSON.parse(fs.readFileSync(path.join(pub, 'status.json'), 'utf8'));
expect('status.json says who, where it stands and what it counted', status.schema === STATUS_SCHEMA && status.name === 'Lantern' && status.seat === 6
  && status.seatLastCheckInBlock === 2372064 && status.counts.sealsChecked === 1 && status.counts.sealsMatched === 1 && status.log.lines === 2 && status.log.intact && status.log.head === prev, JSON.stringify(status));
expect('a README explains the repository', fs.readFileSync(path.join(pub, 'README.md'), 'utf8').includes('hash of the line'));
const allowed = ['schema', 'name', 'seat', 'publicKey', 'mode', 'updated', 'lastPass', 'seal', 'frozen', 'activeSeats', 'seatLastCheckInBlock', 'watching', 'amounts', 'counts', 'log', 'repo'];
expect('status.json holds nothing beyond its listed fields (no secret, no path)', Object.keys(status).every(k => allowed.includes(k)) && !JSON.stringify(status).includes(W.replaceAll('\\', '\\\\')));

// 2. Nothing new: no commit, even though the status's time moved.
r = publishLog({ cfg, st, logFile, now: new Date(Date.now() + 3600e3) });
expect('nothing new: nothing is committed', r.done === 'nothing new' && commits() === 1, JSON.stringify(r));

// 3. A new decision: published.
logLine('pass', { tip: 2399453, seal: '104', open: 0 });
r = publishLog({ cfg, st, logFile });
expect('a new log line is published', r.done === 'pushed' && commits() === 2, JSON.stringify(r));

// 4. A day with nothing new still gets one commit, so the page sees the guardian is alive.
r = publishLog({ cfg, st, logFile, now: new Date(Date.now() + 24 * 3600e3) });
expect('after a day with nothing new, one commit shows it is alive', r.done === 'pushed' && commits() === 3, JSON.stringify(r));

// 5. A broken local log is never published over a good one.
const good = fs.readFileSync(logFile, 'utf8');
fs.writeFileSync(logFile, good.replace('"open":0', '"open":7'));
r = publishLog({ cfg, st, logFile });
expect('a log whose chain breaks is refused, the repository untouched', r.done === 'refused' && commits() === 3, JSON.stringify(r));
fs.writeFileSync(logFile, good);

// 6. No push: committed locally only.
logLine('pass', { tip: 2399460, seal: '104', open: 0 });
r = publishLog({ cfg: { ...cfg, publish: { ...cfg.publish, push: false } }, st, logFile });
expect('"push": false commits without pushing', r.done === 'committed' && commits() === 3, JSON.stringify(r));

// 7. Not a clone: it says so.
r = publishLog({ cfg: { ...cfg, publish: { ...cfg.publish, repoDir: path.join(W, 'nowhere') } }, st, logFile });
expect('a folder that is not a clone fails with a reason', r.done === 'failed' && /not a git clone/.test(r.why), JSON.stringify(r));

// 8. Timing.
expect('publishing is off without a repoDir', publishDue({}, {}) === false);
expect('due at first, not again within the hour, due after it', publishDue({}, cfg) === true
  && publishDue({ lastPublish: { at: new Date().toISOString() } }, cfg) === false
  && publishDue({ lastPublish: { at: new Date(Date.now() - 61 * 60e3).toISOString() } }, cfg) === true);

// 9. Its cumulative work: money looked at per token, never added across tokens.
const work = buildStatus({ cfg, logFile, st: { ...st, passes: 288, firstPass: '2026-11-02T22:03:58Z', requests: {
  a: { class: 'good', amount: '10.5', token: 'Winiwa' }, b: { class: 'good', amount: '0.25', token: 'Winiwa' },
  c: { class: 'bad', amount: '3', token: 'Winiwa', stopped: 2399500 }, d: { class: 'good', amount: '7', token: 'xWiniwa' }, e: { class: 'wait' } } } });
const win = work.amounts.find(t => t.token === 'Winiwa'), xw = work.amounts.find(t => t.token === 'xWiniwa');
expect('cumulative work: amounts per token, passes and since when', work.amounts.length === 2 && win.checked === 13.75 && win.passed === 10.75 && win.foundBad === 3 && win.stopped === 3
  && xw.checked === 7 && work.watching.passes === 288 && work.watching.since === '2026-11-02T22:03:58Z'
  && work.counts.requestsChecked === 5 && work.counts.requestsPassed === 3 && work.counts.requestsFoundBad === 1, JSON.stringify(work.amounts));

// 10. A watch-only guardian (no seat) still publishes a usable status.
const wo = buildStatus({ cfg: { seat: null, publish: { name: 'Hayloft' } }, st: { requests: {}, seals: {} }, logFile });
expect('a watch-only guardian publishes a status too', wo.mode === 'watch only' && wo.seatLastCheckInBlock === null && wo.name === 'Hayloft');

fs.writeFileSync(path.join(HERE, 'out', 'publish-results.json'), JSON.stringify(results, null, 1));
console.log(`publish: ${passed} of ${n} as expected`);
process.exit(passed === n ? 0 : 1);
