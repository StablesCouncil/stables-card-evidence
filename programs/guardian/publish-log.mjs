/*
 * Publishing a guardian's own log (2026-11-03). Each guardian publishes to ITS OWN public git repository, never to a
 * StablesCouncil one and never through the approvers' server, so no single host holds every guardian's record.
 *
 * Every publish (default once an hour) writes into a local clone of that repository:
 *   - guardian-log.jsonl   the whole public log, as it is (hash-chained lines: an edited or removed line shows);
 *   - status.json          a short summary the Card Guardians page reads (schema stables-guardian-status/v1);
 *   - README.md            once, what the repository is;
 * then commits, and pushes when "push" is true. Nothing is committed when nothing changed. A publish is never
 * written into the log itself (it would change the log on every publish); it is kept in state.json.
 *
 * The push uses the clone's own git setup: on a guardian machine, a deploy key that can write to that one repository
 * only. No token is stored here.
 *
 * Config (guardian.config.json):
 *   "publish": { "repoDir": "../guardian-lantern-log", "everyMinutes": 60, "push": true,
 *                "name": "Lantern", "repoUrl": "https://github.com/<owner>/<repo>" }
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyLog } from './guardian.mjs';

export const STATUS_SCHEMA = 'stables-guardian-status/v1';

/** The summary the page reads: only chain facts and counts, no secret. */
export function buildStatus({ cfg, st, logFile, now = new Date() }) {
  const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const count = (event, f = () => true) => lines.filter(l => l.event === event && f(l)).length;
  const v = fs.existsSync(logFile) ? verifyLog(logFile) : { ok: true, lines: 0 };
  const h = st.head || {};
  // The money it looked at, per token (amounts of different tokens are never added together).
  const amounts = {};
  for (const r of Object.values(st.requests || {})) {
    if (!r.amount || !r.token) continue;
    const t = (amounts[r.token] ??= { token: r.token, checked: 0, passed: 0, foundBad: 0, stopped: 0 });
    const x = Number(r.amount);
    t.checked += x; if (r.class === 'good') t.passed += x; if (r.class === 'bad') t.foundBad += x; if (r.stopped) t.stopped += x;
  }
  const round = x => Math.round(x * 1e8) / 1e8;
  return {
    schema: STATUS_SCHEMA,
    name: cfg.publish?.name || null,
    seat: cfg.seat,
    publicKey: cfg.publicKey || null,
    mode: cfg.publicKey && cfg.seat != null ? (cfg.allowPost ? 'seated, may post' : 'seated, dry run') : 'watch only',
    updated: now.toISOString(),
    lastPass: st.lastPass ? { at: st.lastPass.at, block: st.lastPass.tip, openRequests: st.lastPass.open } : null,
    seal: h.seal ?? null,
    frozen: h.frozen ?? null,
    activeSeats: h.activeSeats ?? null,
    seatLastCheckInBlock: h.seatCheckIn ?? null,
    watching: { since: st.firstPass || null, passes: st.passes || 0 },
    amounts: Object.values(amounts).map(t => ({ token: t.token, checked: round(t.checked), passed: round(t.passed), foundBad: round(t.foundBad), stopped: round(t.stopped) })),
    counts: {
      requestsChecked: Object.keys(st.requests || {}).length,
      requestsPassed: Object.values(st.requests || {}).filter(r => r.class === 'good').length,
      requestsFoundBad: Object.values(st.requests || {}).filter(r => r.class === 'bad').length,
      sealsChecked: Object.keys(st.seals || {}).length,
      sealsMatched: Object.values(st.seals || {}).filter(s => s.approved?.matched && s.rejected?.matched).length,
      stopsPosted: count('stop', l => l.done === 'posted' && l.posted),
      stopsBuilt: count('stop'),
      checkInsPosted: count('check-in', l => l.done === 'posted' && l.posted),
      alerts: count('alert'),
    },
    log: { file: 'guardian-log.jsonl', lines: v.lines ?? lines.length, intact: v.ok, head: lines.length ? lines.at(-1).hash : null },
    repo: cfg.publish?.repoUrl || null,
  };
}

const README = name => `# ${name ? name + ', a' : 'A'} Stables card guardian: public log

This repository is written by a guardian program of the Stables card, once an hour. It holds no secret.

- \`guardian-log.jsonl\`: every decision the guardian made, one JSON line each. Each line carries the hash of the line
  before it, so a line changed or removed later shows. Check it with \`node guardian.mjs verify-log\`, or by hand:
  each line's \`hash\` is the SHA-256 of the line without its \`hash\` field, and its \`prev\` is the previous line's hash.
- \`status.json\`: a short summary read by https://stablescouncil.org/guardians.html.

What a guardian is and the rules it follows: https://github.com/StablesCouncil/stables-card-evidence/blob/main/docs/GUARDIANS.md
`;

const git = (dir, args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 120000 });

/** Due when the last publish is older than everyMinutes (default 60). */
export function publishDue(st, cfg, now = Date.now()) {
  if (!cfg.publish?.repoDir) return false;
  const every = Math.max(5, Number(cfg.publish.everyMinutes) || 60) * 60e3;
  return !st.lastPublish || now - Date.parse(st.lastPublish.at) >= every;
}

/** Writes the files into the clone, commits when anything changed, pushes when asked. Returns what happened. */
export function publishLog({ cfg, st, logFile, now = new Date() }) {
  const p = cfg.publish;
  if (!p?.repoDir) return { done: 'off' };
  const dir = p.repoDir;
  if (!fs.existsSync(path.join(dir, '.git'))) return { done: 'failed', why: `${dir} is not a git clone of the guardian's log repository` };
  const v = fs.existsSync(logFile) ? verifyLog(logFile) : { ok: true, lines: 0 };
  // A broken chain is never published over a good one: the owner must look first.
  if (!v.ok) return { done: 'refused', why: `the local log's hash chain breaks at line ${v.line}` };
  if (fs.existsSync(logFile)) fs.copyFileSync(logFile, path.join(dir, 'guardian-log.jsonl'));
  const status = buildStatus({ cfg, st, logFile, now });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(status, null, 1) + '\n');
  if (!fs.existsSync(path.join(dir, 'README.md'))) fs.writeFileSync(path.join(dir, 'README.md'), README(p.name));
  // Byte for byte: git on Windows would otherwise turn the log's line ends into CRLF for anyone who clones it.
  if (!fs.existsSync(path.join(dir, '.gitattributes'))) fs.writeFileSync(path.join(dir, '.gitattributes'), '* -text\n');
  git(dir, ['add', '.gitattributes', 'guardian-log.jsonl', 'status.json', 'README.md']);
  // status.json changes every hour (its time); commit only when the log itself or the counts moved, or once a day.
  const changed = git(dir, ['diff', '--cached', '--name-only']).stdout.split('\n').filter(Boolean);
  const lastCommit = Number(git(dir, ['log', '-1', '--format=%ct']).stdout.trim() || 0) * 1000;
  const onlyTime = changed.length === 1 && changed[0] === 'status.json' && onlyUpdatedMoved(dir);
  if (!changed.length || (onlyTime && now.getTime() - lastCommit < 23 * 3600e3)) {
    git(dir, ['reset', '-q']); git(dir, ['checkout', '-q', '--', 'status.json']);
    return { done: 'nothing new', lines: status.log.lines };
  }
  const c = git(dir, ['-c', 'user.name=' + (p.name || 'Stables guardian'), '-c', 'user.email=guardian@invalid', 'commit', '-q', '-m', `Log to block ${status.lastPass?.block ?? '?'}: ${status.log.lines} lines`]);
  if (c.status !== 0) return { done: 'failed', why: 'commit: ' + (c.stderr || c.stdout).trim().slice(0, 300) };
  if (!p.push) return { done: 'committed', lines: status.log.lines, head: status.log.head };
  const r = git(dir, ['push', '-q', 'origin', 'HEAD']);
  if (r.status !== 0) return { done: 'committed, not pushed', why: (r.stderr || '').trim().slice(0, 300), lines: status.log.lines };
  return { done: 'pushed', lines: status.log.lines, head: status.log.head };
}

// True when the staged status.json differs from the last commit only in its "updated" time.
function onlyUpdatedMoved(dir) {
  const strip = s => { try { const j = JSON.parse(s); delete j.updated; return JSON.stringify(j); } catch { return s; } };
  const before = git(dir, ['show', 'HEAD:status.json']), after = git(dir, ['show', ':status.json']);
  return before.status === 0 && strip(before.stdout) === strip(after.stdout);
}
