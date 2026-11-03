/* run.mjs: what the guardian container runs. Opens the door to the node, waits until the node answers, then runs the
 * guardian's watch loop (dry run: the config has "allowPost": false and the box passes no --post). If the program
 * stops, the container stops and Docker starts it again (restart: unless-stopped). */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDoor } from './door.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
startDoor();
for (let i = 0; ; i++) {
  try {
    const r = await (await fetch('http://127.0.0.1:9005/status')).json();
    if (r.status) { console.log(`node up: block ${r.response.chain.block}`); break; }
  } catch { /* node starting */ }
  if (i % 12 === 0) console.log('waiting for the node...');
  await new Promise(r => setTimeout(r, 5000));
}
const child = spawn(process.execPath, [path.join(HERE, '..', 'guardian.mjs'), 'watch', '--config', path.join(HERE, '..', 'guardian.config.json')], { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
