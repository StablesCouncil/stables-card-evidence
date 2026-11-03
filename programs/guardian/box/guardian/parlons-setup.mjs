/* parlons-setup.mjs: the guardian's Parlons account, from the guardian container.
 *
 *   node box/parlons-setup.mjs whoami                 this guardian's Parlons address (to add in the owner's Parlons!)
 *   node box/parlons-setup.mjs owner <address>        who receives the alerts (the owner's Parlons address)
 *   node box/parlons-setup.mjs contacts               the account's contacts
 *   node box/parlons-setup.mjs test                   one test alert to the owner
 *
 * Run with: docker compose -p stables-guardian exec guardian node box/parlons-setup.mjs <command>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../guardian.mjs';
import { parlonsSender, alertText } from '../alert-parlons.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig(path.join(HERE, '..', 'guardian.config.json'));
const p = cfg.alert.parlons;
const P = parlonsSender({ ...p, sessionFile: path.join(cfg.dataDir, 'parlons-session.txt') });
const [cmd, arg] = process.argv.slice(2);

if (cmd === 'whoami') {
  const r = await P.api('invite');
  console.log(JSON.stringify({ address: r.address }, null, 1));
} else if (cmd === 'owner') {
  if (!arg) throw new Error('give the owner\'s Parlons address');
  fs.mkdirSync(path.dirname(p.toFile), { recursive: true });
  fs.writeFileSync(p.toFile, arg.trim() + '\n');
  const c = await P.ownerContact();
  console.log(c ? `owner is a contact: ${c.name || c.key}` : 'owner introduced; the contact completes when both accounts are online');
} else if (cmd === 'contacts') {
  console.log(JSON.stringify((await P.contacts()).map(c => ({ name: c.name, key: c.key, address: c.address })), null, 1));
} else if (cmd === 'test') {
  const a = { at: new Date().toISOString(), level: 'warning', subject: 'test', text: 'test alert from the guardian box. Nothing is wrong; this checks that alerts reach you.' };
  console.log(JSON.stringify(await P.send(alertText(a))));
} else {
  console.log('commands: whoami | owner <address> | contacts | test');
}
