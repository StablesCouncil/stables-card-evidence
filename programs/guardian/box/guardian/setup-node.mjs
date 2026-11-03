/* setup-node.mjs: once, after the box's first start. Tells the guardian's node to follow the R2T5 scripts (and the
 * package address the checker reads), so it keeps their coins. Goes to the node directly with its password: newscript
 * is not a guardian read command, so the door would refuse it. Changes nothing on chain.
 *
 *   docker compose -p stables-guardian exec guardian node box/setup-node.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../guardian.mjs';
import { minimaRpc } from './door.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_SCRIPT = 'RETURN FALSE';   // R2Exit.PACKAGE_ADDRESS 0xABA00547...CB49: the carriers of exit packages

const pw = fs.readFileSync('/secrets/node-rpc-password', 'utf8').trim();
const rpc = async cmd => JSON.parse(await minimaRpc(cmd, { password: pw }));

const cfg = loadConfig(path.join(HERE, '..', 'guardian.config.json'));
const gen = JSON.parse(fs.readFileSync(cfg.generation, 'utf8'));
const scripts = [...Object.entries(gen.contracts).map(([k, v]) => [k, v.script, v.address]), ['package', PACKAGE_SCRIPT, '0xABA005476D2B3CD7F251B9783E64C124C9670BB358695F04D91B2057BB64CB49']];
for (const [name, script, address] of scripts) {
  const r = await rpc(`newscript trackall:true script:${JSON.stringify(script)}`);
  const got = r.status ? r.response.address : null;
  console.log(`${name.padEnd(10)} ${got === address ? 'tracked' : 'MISMATCH'} ${got || r.error}`);
  if (got !== address) process.exitCode = 1;
}
const s = await rpc('status');
console.log(`node at block ${s.response.chain.block}, ${s.response.chain.time}`);
