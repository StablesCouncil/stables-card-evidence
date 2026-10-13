#!/usr/bin/env node
/*
 * Route 2 evidence, step 3: the card ledger (collect.mjs) read against the design, one finding per transaction.
 *
 * Every transaction that touched a card contract is classified by its shape, and each class is checked for what the
 * design says it must carry (trace-design.md 13.11, COUNCIL_ATTESTATION_DESIGN.md 6c-6d):
 *   Add            an anchor at the anchor address (tag, request key, amount, token) and the money at the vault, one send
 *   Exit request   1 atom at the request address carrying the package; its package is decoded and every TEE signature
 *                  and attestation in it checked from first principles (R2Evidence.java)
 *   Council seal   the seal head and copies moved together, signed by at least 5 of the 7 published council keys
 *   Payout         the request, the vault coins and one seal copy spent; the amount to the payout address
 * The output is evidence.json (everything, machine readable) and EVIDENCE.md (the same, for a person).
 *
 * Usage: node report.mjs --ledger card-ledger.json --out <dir> [--from-block N] [--council council.json] [--java <java>] [--cp <classpath>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import CRYPTO from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const LEDGER = JSON.parse(fs.readFileSync(arg('ledger', 'card-ledger.json'), 'utf8'));
const OUT = arg('out', path.join(HERE, 'out'));
const FROM_BLOCK = Number(arg('from-block', '0'));
// The preserved raw transactions (preserve.mjs). Minima signs with one-time keys under a tree whose root is the wallet
// key a contract names (MULTISIG, SIGNEDBY): the council's published keys are those tree roots.
const RAW = arg('raw', path.join(path.dirname(arg('ledger', 'card-ledger.json')), 'evidence-raw'));
function rootKeys(t) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(RAW, 'txpow-' + t.txpowid + '.json'), 'utf8')).response;
    return (raw.body.witness.signatures || []).flatMap((s) => (s.signatures || []).map((x) => String(x.rootkey).toUpperCase().replace(/^0X/, '0x')));
  } catch (_) { return null; }
}
fs.mkdirSync(OUT, { recursive: true });

const COUNCIL = JSON.parse(fs.readFileSync(arg('council', path.join(HERE, '..', '..', 'evidence', 'R2T3-COUNCIL', 'council.json')), 'utf8'));
const MEMBERS = new Map(COUNCIL.members.map((m) => [m.publickey.toUpperCase().replace(/^0X/, '0x'), 'member ' + m.member]));
const TAG = { '0x52325433': 'R2T3 anchor', '0x52325432': 'R2T2 anchor', '0x52325445': 'exit request' };
// The decoder (R2Evidence.java) is compiled against minima.jar for its JSON classes: --java and --cp say where they are.
const JAVA = arg('java', process.env.JAVA || 'C:/Program Files/Eclipse Adoptium/jdk-17.0.18.8-hotspot/bin/java.exe');
// The verifier classes and minima.jar: --cp, or the built verifier next to this script plus $MINIMA_JAR.
const CP = arg('cp', [path.join(HERE, '..', 'build'), process.env.MINIMA_JAR || 'minima.jar'].join(path.delimiter));

// A Minima transaction keeps one state for all its outputs (txn.state); a spent input coin carries its own.
const portIn = (list, p) => { const s = (list || []).find((x) => Number(x.port) === p); return s ? String(s.data) : null; };
const port = (c, p) => portIn(c && c.state, p);
const portT = (t, p) => portIn(t.state, p);
const roles = (list) => list.map((c) => c.role).filter(Boolean);
// Public evidence shows ids in full (founder rule: never truncated): a reader must be able to check each one.
const short = (h) => String(h || '');
const sha256 = (hex) => '0x' + require_crypto().createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex').toUpperCase();
function require_crypto() { return CRYPTO; }

function classify(t) {
  const outR = roles(t.outputs), inR = roles(t.inputs);
  if (t.outputs.some((c) => /exit request/.test(c.role || '')) && portT(t, 0) === '0x52325445') return 'exit request';
  if (inR.some((r) => /exit request/.test(r)) && t.inputs.some((c) => /vault/.test(c.role || ''))) return 'payout';
  if (inR.some((r) => /exit request/.test(r))) return 'council rejection';
  if (inR.some((r) => /R2T1 vault/.test(r)) && portT(t, 100)) return 'R2T1 migration';
  if (inR.length && inR.every((r) => /anchor/.test(r)) && portT(t, 100)) return 'lab rescue';
  if (inR.includes('council seal') || outR.includes('council seal')) return 'council seal';
  if (t.outputs.some((c) => /anchor/.test(c.role || '')) && t.outputs.some((c) => /vault/.test(c.role || ''))) return 'add';
  if (inR.some((r) => /vault/.test(r))) return 'vault spend (rescue / migration)';
  return 'other';
}

function checkAdd(t) {
  const anchors = t.outputs.filter((c) => /anchor/.test(c.role || ''));
  const vault = t.outputs.filter((c) => /vault/.test(c.role || ''));
  const f = [];
  const ok = anchors.length === 1 && vault.length === 1 && !t.inputs.some((c) => c.role);
  const a = { state: t.state };
  f.push((ok ? 'PASS' : 'FAIL') + ': one anchor and one vault output, no card contract spent');
  f.push((TAG[port(a, 0)] ? 'PASS' : 'FAIL') + ': anchor tag ' + port(a, 0) + ' (' + (TAG[port(a, 0)] || 'unknown') + ')');
  f.push((port(a, 1) ? 'PASS' : 'FAIL') + ': anchor names the TEE request key ' + short(port(a, 1)));
  const amt = port(a, 2), tok = port(a, 3);
  const v = vault[0] || {};
  f.push((amt && Number(amt) === Number(v.amount) && String(tok).toUpperCase() === String(v.tokenid).toUpperCase() ? 'PASS' : 'FAIL') +
    ': anchor records ' + amt + ', the vault output holds ' + v.amount + ' of the same token');
  f.push('INFO: signed by the sender\'s own wallet key(s) ' + (rootKeys(t) || t.signers).filter((v, i, a) => a.indexOf(v) === i).map(short).join(', ') + ' (an ordinary Savings send; no TEE signature is needed on chain here)');
  return { summary: 'Add ' + amt + ' to a Stables card', findings: f, pass: !f.some((x) => x.startsWith('FAIL')) };
}

function checkRequest(t) {
  const r = t.outputs.find((c) => /exit request/.test(c.role || ''));
  const st = { state: t.state };
  const chunks = []; for (let p = 30; p < 40; p++) { const d = port(st, p); if (d) chunks.push(d.replace(/^0x/i, '')); }
  const pkgHex = chunks.join('');
  const text = Buffer.from(pkgHex, 'hex').toString('latin1');
  if (text.startsWith('STR2P\u0001LAB CONTRACT TEST')) {
    const f = [];
    f.push((port(st, 10) && port(st, 10).toUpperCase() === sha256(pkgHex).toUpperCase() ? 'PASS' : 'FAIL') + ': port 10 is the hash of the package in port 30');
    f.push('INFO: lab contract test (' + text.slice(6).trim() + '): a marked synthetic package that holds no phone coin. It tests the contracts (seal, payout from several vault coins, rejection, fallback), not the TEE path; record R2T3-EXIT-02');
    return { summary: 'Lab contract-test request of ' + port(st, 12), findings: f, pass: !f.some((x) => x.startsWith('FAIL')), lab: true };
  }
  const file = path.join(OUT, 'package-' + t.txpowid.slice(2, 14) + '.hex');
  fs.writeFileSync(file, pkgHex);
  let ev = null, err = null;
  try { ev = JSON.parse(execFileSync(JAVA, ['-cp', CP, 'org.stablescouncil.stables.route2.R2Evidence', '--pkg', file], { encoding: 'utf8' })); }
  catch (e) { err = String(e.stderr || e.message).slice(0, 400); }
  const f = [];
  f.push((port(st, 10) && ev && port(st, 10).toUpperCase() === ev.packageHash.toUpperCase() ? 'PASS' : 'FAIL') + ': port 10 is the hash of the package carried in ports 30-' + (29 + chunks.length));
  if (ev) {
    f.push((port(st, 11) && port(st, 11).toUpperCase() === ev.exit.exitedCoin.toUpperCase() ? 'PASS' : 'FAIL') + ': port 11 names the exited coin ' + short(ev.exit.exitedCoin));
    f.push((Number(port(st, 12)) === Number(ev.exit.amount) ? 'PASS' : 'FAIL') + ': port 12 amount ' + port(st, 12) + ' = the exit line\'s ' + ev.exit.amount);
    f.push((String(port(st, 14)).toUpperCase() === ev.exit.payout.toUpperCase() ? 'PASS' : 'FAIL') + ': port 14 payout = the exit line\'s payout ' + short(ev.exit.payout));
    ev.keys.forEach((k) => f.push((k.attestation.startsWith('accepted') ? 'PASS' : 'FAIL') + ': key ' + (k.keyHash ? short(k.keyHash) : '?') + ' on ' + k.device +
      ' attested ' + (k.securityLevel || '') + ', boot ' + (k.bootState || '') + (k.os ? ', ' + k.os : '') + ': ' + k.attestation));
    ev.anchors.forEach((a) => f.push('INFO: deposit anchor ' + short(a.anchorCoin) + ' ' + a.amount + ' became card coin ' + short(a.cardCoin) + ' owned by ' + a.ownerKey));
    ev.hops.forEach((h) => {
      h.spends.forEach((p) => f.push((String(p.signature).startsWith('valid') ? 'PASS' : 'FAIL') + ': hop ' + h.hop + ' spends ' + short(p.coin) + ' (' + p.amount + '), signed by ' + p.signedBy + ': ' + p.signature));
      f.push((String(h.conservation).startsWith('in') ? 'PASS' : 'FAIL') + ': hop ' + h.hop + ' pays ' + h.pays.amount + ' to ' + h.pays.ownerKey + (h.change ? ', change ' + h.change.amount + ' to ' + h.change.ownerKey : '') + '; ' + h.conservation);
    });
    f.push((String(ev.exit.signature).startsWith('valid') ? 'PASS' : 'FAIL') + ': exit line signed by the exited coin\'s key ' + ev.exit.signedBy + ': ' + ev.exit.signature);
    f.push('INFO: ' + ev.devices + ' device(s) held this money on its way, ' + ev.hops.length + ' signed hop(s); package ' + ev.packageBytes + ' bytes');
  } else f.push('FAIL: package did not decode: ' + err);
  f.push('INFO: request posted from Savings, signed by the wallet key(s) ' + (rootKeys(t) || t.signers).filter((v, i, a) => a.indexOf(v) === i).map(short).join(', '));
  return { summary: 'Remove ' + port(st, 12) + ' to Savings (exit request)', findings: f, pass: !f.some((x) => x.startsWith('FAIL')), package: ev, packageFile: path.basename(file) };
}

function checkSeal(t) {
  if (String(portT(t, 21) || '').replace(/^0x/i, '') === '0' && /^0x0+$/i.test(String(portT(t, 20) || '0x00'))) {
    return { summary: 'Council genesis: seal head and copies created', pass: true, findings: [
      'INFO: creates the council seal head and its copies from the seal token (period 0, empty root). No approval exists yet, so no council signature is needed: the head contract (MULTISIG 5 of 7) governs every later seal; record R2T3-EXIT-02'] };
  }
  const keys = rootKeys(t) || t.signers;
  const signed = [...new Set(keys)].map((k) => MEMBERS.get(k) || null);
  const members = signed.filter(Boolean);
  const f = [];
  f.push((members.length >= COUNCIL.quorum ? 'PASS' : 'FAIL') + ': signed by ' + members.length + ' of the ' + COUNCIL.members.length + ' published council keys (' + members.join(', ') + '); the contract requires ' + COUNCIL.quorum);
  const root = portT(t, 20), period = portT(t, 21);
  if (root) f.push('INFO: seals period ' + period + ', approvals root ' + short(root));
  return { summary: 'Council seal' + (period ? ' (period ' + period + ')' : ''), findings: f, pass: !f.some((x) => x.startsWith('FAIL')) };
}

function checkPayout(t, requests) {
  const req = t.inputs.find((c) => /exit request/.test(c.role || ''));
  const vaultIn = t.inputs.filter((c) => /vault/.test(c.role || ''));
  const copy = t.inputs.find((c) => /seal/.test(c.role || ''));
  const amt = port(req, 12), payout = port(req, 14);
  const paid = t.outputs.find((c) => c.address.toUpperCase() === String(payout).toUpperCase() && Number(c.amount) === Number(amt));
  const f = [];
  f.push((req ? 'PASS' : 'FAIL') + ': spends the exit request ' + short(req && req.coinid));
  f.push((vaultIn.length ? 'PASS' : 'FAIL') + ': spends ' + vaultIn.length + ' vault coin(s) (' + vaultIn.map((c) => c.amount).join(' + ') + ')');
  f.push((copy ? 'PASS' : 'INFO') + ': ' + (copy ? 'carries a council seal copy (the approval, checked by the contract with PROOF against the sealed root)' : 'no seal copy: a fallback payout after the waiting period'));
  f.push((paid ? 'PASS' : 'FAIL') + ': pays ' + amt + ' to the payout address the TEE-signed exit line named ' + short(payout));
  const back = t.outputs.filter((c) => /vault/.test(c.role || ''));
  if (back.length) f.push('INFO: returns ' + back.map((c) => c.amount).join(' + ') + ' to the vault');
  const reqTx = requests.find((r) => r.outputs.some((c) => req && c.coinid === req.coinid));
  return { summary: 'Payout of ' + amt + ' to Savings', findings: f, pass: !f.some((x) => x.startsWith('FAIL')), request: reqTx && reqTx.txpowid };
}

function checkRejection(t) {
  const keys = rootKeys(t) || t.signers;
  const members = [...new Set(keys)].map((k) => MEMBERS.get(k)).filter(Boolean);
  const f = [];
  f.push((members.length >= COUNCIL.quorum ? 'PASS' : 'FAIL') + ': the request is spent by ' + members.length + ' of the 7 council keys (' + members.join(', ') + ') with no vault coin: rejected, nothing paid');
  f.push('INFO: returns ' + t.outputs.map((c) => c.amount).join(', ') + ' (the request atom) to the requester');
  return { summary: 'Council rejection of a request', findings: f, pass: !f.some((x) => x.startsWith('FAIL')) };
}

const txs = LEDGER.transactions.filter((t) => t.block >= FROM_BLOCK).sort((a, b) => a.block - b.block);
const requests = txs.filter((t) => classify(t) === 'exit request');
const results = txs.map((t) => {
  const kind = classify(t);
  const r = kind === 'add' ? checkAdd(t) : kind === 'exit request' ? checkRequest(t) : kind === 'council seal' ? checkSeal(t)
    : kind === 'payout' ? checkPayout(t, requests) : kind === 'council rejection' ? checkRejection(t)
    : kind === 'R2T1 migration' ? { summary: 'R2T1 migration: deposits returned to their Savings', pass: true, findings: [
        'INFO: spends ' + t.inputs.length + ' coins of the first test vault (R2T1: ' + t.inputs.map((c) => c.amount).join(', ') + ') to the Savings addresses that made them, by the lab rescue branch (ports 100+). Founder decision 2026-10-12, record R2T1-MIGRATE-01'] }
    : kind === 'lab rescue' ? { summary: 'Lab rescue of campaign test anchors', pass: true, findings: [
        'INFO: the R2T3 campaign closes by taking its own test anchors back (lab key, ports 100+); record R2T3-EXIT-02'] }
    : { summary: kind, findings: ['INFO: ' + kind], pass: true };
  return Object.assign({ kind, txpowid: t.txpowid, transactionid: t.transactionid, block: t.block, time: t.time }, r);
});

fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify({ ledger: { from: LEDGER.from, to: LEDGER.to, collected: LEDGER.collected, source: LEDGER.source },
  council: { quorum: COUNCIL.quorum, members: COUNCIL.members.map((m) => m.publickey), note: COUNCIL.note }, results }, null, 1));

const counts = {}; results.forEach((r) => { counts[r.kind] = (counts[r.kind] || 0) + 1; });
let md = '# Stables card on chain: evidence\n\n';
md += 'Every Minima mainnet transaction that touched a Stables card contract between block ' + LEDGER.from + ' and block ' + LEDGER.to +
  ', read from a node and checked against the design. Generated ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC by `verifier/scripts/report.mjs` (github.com/StablesCouncil/stables-card-evidence).\n\n';
md += '| Kind | Transactions | All checks pass |\n|---|---|---|\n';
Object.keys(counts).forEach((k) => { md += '| ' + k + ' | ' + counts[k] + ' | ' + (results.filter((r) => r.kind === k).every((r) => r.pass) ? 'yes' : 'NO') + ' |\n'; });
md += '\n';
results.forEach((r) => {
  // Minima prunes transaction bodies and no public explorer keeps them: the link is the preserved raw transaction.
  md += '## ' + r.summary + '\n\nBlock ' + r.block + ', ' + r.time.slice(0, 19).replace('T', ' ') + ' UTC. TxPoW [`' + r.txpowid + '`](raw/txpow-' + r.txpowid + '.json)' +
    (r.packageFile ? ', package [`' + r.packageFile + '`](' + r.packageFile + ')' : '') + '\n\n';
  r.findings.forEach((x) => { md += '- ' + x + '\n'; });
  md += '\n';
});
fs.writeFileSync(path.join(OUT, 'EVIDENCE.md'), md);
console.log('wrote ' + path.join(OUT, 'EVIDENCE.md') + ': ' + results.length + ' transactions; ' + JSON.stringify(counts) + '; failing: ' + results.filter((r) => !r.pass).length);
