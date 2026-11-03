#!/usr/bin/env node
// Every guardian test, offline: the program's decisions (test/logic.mjs) and the real-signature proof
// (test/offline-proof.mjs), and publishing the log (test/publish.mjs). Prints one summary line: "guardian tests: N of N".
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, total = 0;
for (const t of ['logic.mjs', 'offline-proof.mjs', 'publish.mjs', 'wots.mjs']) {
  const r = spawnSync(process.execPath, [path.join(HERE, t)], { encoding: 'utf8', maxBuffer: 1 << 26 });
  process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  const m = /(\d+) of (\d+) as expected/.exec(r.stdout.trim().split('\n').pop() || '');
  if (!m) { console.log(`${t}: no summary (exit ${r.status})`); total += 1; continue; }
  pass += Number(m[1]); total += Number(m[2]);
}
console.log(`guardian tests: ${pass} of ${total}`);
process.exit(pass === total ? 0 : 1);
