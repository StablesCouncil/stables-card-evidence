/* door.mjs: the only way into the node from the guardian's side of the box.
 *
 * Listens on 127.0.0.1:9005 (the address the program and the Council's checker expect), adds the node's RPC password,
 * and passes a command on to the node (127.0.0.1:9015) only when its first word is one the guardian reads with:
 * status, coins, txpow, mmrcreate. Everything else is refused here, before the node sees it. The transaction commands
 * pass only when the box is started for posting (GUARDIAN_DOOR_POSTING=1), which nobody sets today.
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';

const READS = new Set(['status', 'coins', 'txpow', 'mmrcreate']);
const WRITES = new Set(['txncreate', 'txninput', 'txnoutput', 'txnstate', 'txnbasics', 'txnsign', 'txncheck', 'txnpost', 'txndelete']);

export function allowed(cmd, posting = false) {
  const verb = String(cmd).trim().split(/\s/)[0].toLowerCase();
  if (READS.has(verb)) return true;
  if (posting && WRITES.has(verb)) return !/publickey:auto/i.test(cmd);
  return false;
}

/* One command to Minima's RPC, as the lab's campaign scripts send it (r2t5-campaign.mjs rpc()): a raw socket, header and
   body in one write, "Connection: close", the reply read to the end. Node's HTTP client got "socket hang up" on long
   bodies (a 3 KB newscript). Minima matches "Authorization:" and "Content-Length:" with this exact case. */
export function minimaRpc(command, { port = 9015, password, timeoutMs = 180000 } = {}) {
  const body = Buffer.from(command);
  const auth = password ? `Authorization: Basic ${Buffer.from('minima:' + password).toString('base64')}\r\n` : '';
  const head = `POST / HTTP/1.1\r\nHost: 127.0.0.1\r\n${auth}Content-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port }), chunks = [];
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('node timeout')); }, timeoutMs);
    sock.on('connect', () => sock.end(Buffer.concat([Buffer.from(head), body])));
    sock.on('data', c => chunks.push(c));
    sock.on('error', e => { clearTimeout(timer); reject(e); });
    sock.on('close', () => {
      clearTimeout(timer);
      const t = Buffer.concat(chunks).toString('utf8'), i = t.indexOf('{');
      if (i < 0) return reject(new Error('node sent no JSON' + (t ? ': ' + t.slice(0, 80) : '')));
      resolve(t.slice(i).trim());
    });
  });
}

export function startDoor({ listen = 9005, node = 9015, passwordFile = '/secrets/node-rpc-password', posting = process.env.GUARDIAN_DOOR_POSTING === '1', log = console.log } = {}) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let cmd = body;
      if (!body) { try { cmd = decodeURIComponent(req.url.replace(/^\//, '')); } catch { cmd = ''; } }
      const reply = text => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(text); };
      const refuse = why => reply(JSON.stringify({ status: false, error: why }));
      if (!cmd.trim()) return refuse('door: empty command');
      if (!allowed(cmd, posting)) { log(`door: refused ${cmd.trim().split(/\s/)[0]}`); return refuse('door: not a guardian read command'); }
      try { reply(await minimaRpc(cmd, { port: node, password: fs.readFileSync(passwordFile, 'utf8').trim() })); }
      catch (e) { refuse('door: node unreachable: ' + e.message); }
    });
  });
  server.listen(listen, '127.0.0.1');
  return server;
}
