/* alert-parlons.mjs: the guardian's alerts as chats in the owner's Parlons! (founder 2026-11-03: "one account per
 * guardian", "alerts in your chats").
 *
 * The guardian has its own Parlons account (Parlons Cloud, Eurobuddha) on its own machine. This module talks to that
 * account's local panel API (ParlonsLocal, github.com/eurobuddha/maxima at 6c71fbf): a session from the one-time
 * ticket in panel-ticket.txt (GET /open?ticket=, which sets the parlons_session cookie), then POST /api/<name> with
 * JSON. The panel accepts only Host 127.0.0.1:9587, so that Host is sent even when it is reached through the box.
 *
 *   contacts.list {}                 -> { ok, contacts: [{ key, name, address, share }] }
 *   contacts.add  { address }        the owner's Parlons address (MAX#... or Mx...@host:port); the handshake is async
 *   chat.send     { peer, body }     peer = the contact's key; -> { ok, state: "queued" }
 *
 * The API is Eurobuddha's own, not a published interface: a Parlons update can change it. Messages travel over Maxima,
 * through community relays, encrypted end to end; a relay holds them while the owner's phone is offline.
 */
import http from 'node:http';
import fs from 'node:fs';

export function parlonsSender({ url, ticketFile, to = null, toFile = null, sessionFile = null, panelHost = '127.0.0.1:9587' }) {
  const u = new URL(url);
  let cookie = sessionFile && fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, 'utf8').trim() : null;

  function request(method, path, body = null, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const data = body == null ? null : Buffer.from(JSON.stringify(body));
      const headers = { host: panelHost };
      if (cookie) headers.cookie = 'parlons_session=' + cookie;
      if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = data.length; }
      const req = http.request({ host: u.hostname, port: u.port, method, path, headers }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null; try { json = JSON.parse(text); } catch { /* html or empty */ }
          resolve({ code: res.statusCode, headers: res.headers, json, text });
        });
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Parlons panel timeout')));
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  async function open() {
    if (!fs.existsSync(ticketFile)) throw new Error('no Parlons ticket yet (is the account running?)');
    const m = /[?&]ticket=([^&\s]+)/.exec(fs.readFileSync(ticketFile, 'utf8'));
    if (!m) throw new Error('the Parlons ticket file holds no ticket');
    cookie = null;
    const r = await request('GET', '/open?ticket=' + m[1]);
    const set = [].concat(r.headers['set-cookie'] || []).map(s => /parlons_session=([^;]+)/.exec(s)).find(Boolean);
    if (r.code !== 302 || !set) throw new Error(`Parlons refused the ticket (${r.code})`);
    cookie = set[1];
    if (sessionFile) fs.writeFileSync(sessionFile, cookie, { mode: 0o600 });
  }

  async function api(name, body = {}, timeoutMs = 30000) {
    if (!cookie) await open();
    let r = await request('POST', '/api/' + name, body, timeoutMs);
    if (r.code === 401) { await open(); r = await request('POST', '/api/' + name, body, timeoutMs); }
    if (r.code !== 200 || !r.json) throw new Error(`Parlons ${name}: ${r.code} ${(r.json && r.json.error) || r.text.slice(0, 200)}`);
    if (r.json.ok === false) throw new Error(`Parlons ${name}: ${r.json.error}`);
    return r.json;
  }

  const owner = () => (to || (toFile && fs.existsSync(toFile) ? fs.readFileSync(toFile, 'utf8').trim() : '') || null);
  // An address is Mx...@host:port or MAX#...#Mx...@host:port; the host part can change, the Mx identity part does not.
  const ident = a => String(a || '').split('#').pop().split('@')[0].toLowerCase();
  const matches = (c, who) => [c.key, c.address, c.share].some(x => x && (x.toLowerCase() === who.toLowerCase() || ident(x) === ident(who)));

  async function contacts() {
    const all = [];
    for (let offset = 0; ;) {
      const r = await api('contacts.list', { offset });
      all.push(...(r.contacts || []));
      if (!r.more) return all;
      offset = r.next;
    }
  }

  // The owner as a contact: found by key or address, else introduced (the owner then sees the guardian appear).
  async function ownerContact() {
    const who = owner();
    if (!who) throw new Error('no owner set: write the owner\'s Parlons address in ' + (toFile || 'the config'));
    const c = (await contacts()).find(x => matches(x, who));
    if (c) return c;
    // Parlons connects to the address before it answers: allow it two and a half minutes.
    await api('contacts.add', { address: who }, 150000);
    return null;
  }

  async function send(text) {
    const c = await ownerContact();
    if (!c) throw new Error('the owner is not a contact yet (introduced now; it completes when both accounts are online)');
    const r = await api('chat.send', { peer: c.key, body: text });
    return { state: r.state || 'sent', to: c.name || c.key };
  }

  return { open, api, contacts, ownerContact, send, owner };
}

/** One alert as a chat message: level first, so a glance at the notification says how urgent it is. */
export function alertText(a) {
  const head = { urgent: 'URGENT', important: 'Important', warning: 'Warning' }[a.level] || a.level;
  return `Stables guardian, ${head}: ${a.text}\n(${a.subject}, ${a.at})`;
}
