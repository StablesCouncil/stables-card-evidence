#!/usr/bin/env node
/*
 * R2T5 generator (DRAFT 2026-10-17): fills the contract templates in contracts/ from r2t5.config.json and a keys file,
 * in address order (seal copy -> head, contested -> request -> vault -> gate), asks a node's KISS engine to parse each
 * one (runscript, read only: nothing is registered or sent) and writes out/ with the clean scripts, their addresses,
 * sizes and the genesis state of every coin.
 *
 *   node r2t5-generate.mjs [--keys keys.json] [--node http://127.0.0.1:9205]
 *
 * keys.json: { "council": [11 keys], "guardians": [9 keys], "sealToken": "0x..", "recordToken": "0x..",
 *              "anchorAddress": "0x.." }. Without it, obvious placeholder keys are used and every output says DRAFT.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const cfg = JSON.parse(fs.readFileSync(path.join(here, 'r2t5.config.json'), 'utf8'));
const NODE = arg('--node', 'http://127.0.0.1:9205');
const keysFile = arg('--keys');
const OUT = path.resolve(here, arg('--out', 'out'));
const fake = (tag, i) => '0x' + (tag + String(i).padStart(2, '0')).padEnd(64, '0');
const keys = keysFile ? JSON.parse(fs.readFileSync(keysFile, 'utf8')) : {
  council: Array.from({ length: cfg.council.size }, (_, i) => fake('C0', i + 1)),
  guardians: Array.from({ length: cfg.guardians.size }, (_, i) => fake('9A', i + 1)),
  sealToken: fake('5E', 0), recordToken: fake('7E', 0),
};
const DRAFT = !keysFile;

// Checks the config holds together before anything is generated.
const c = cfg.council, g = cfg.guardians, r = cfg.exitRecord;
const must = (ok, msg) => { if (!ok) throw new Error('config: ' + msg); };
must(keys.council.length === c.size && keys.guardians.length === g.size, 'key counts differ from the sizes');
must(c.quorum > c.size / 2 && c.quorum <= c.size, 'Council quorum must be a majority');
must(g.stop >= 1 && g.stop <= g.freeze && g.freeze <= g.release && g.release <= g.succession && g.succession <= g.size, 'guardian thresholds must rise: stop <= freeze <= release <= succession <= size');
must(g.release > g.size / 2 && g.succession * 3 >= g.size * 2, 'release needs a majority and succession two thirds');
must(256 % r.shardsPerToken === 0, 'shards must divide 256');
must(r.keyBytes === 16, 'the record compares keys as two 8-byte numbers: keyBytes must be 16');
// Minima relays no transaction with more than 10 outputs, nor one whose state size times its kept-state outputs passes
// 64 KB (RelayPolicy, MAX_RELAY_OUTPUTCOINS 10, MAX_RELAY_STORESTATESIZE 65536). A seal makes the head and every copy.
must(1 + c.sealCopies <= 10, "the head and its copies are one transaction: at most 9 copies (10 outputs)");
{ const sealState = 8 * 40 + (c.size + 2 * g.size) * 40;          // ports 20 to 29, the Council keys, the guardians and their check-ins
  must(sealState * (1 + c.sealCopies) <= 65536, "a seal state of about " + sealState + " bytes times " + (1 + c.sealCopies) + " kept outputs passes 64 KB");
  const payState = 2 * (6 + 40 * r.depth) + 40 * r.depth + 2000;   // two record proofs, the approval proof, everything else
  must(payState * 2 <= 65536, "a payout state of about " + payState + " bytes times 2 kept outputs passes 64 KB"); }
must(c.heartbeatEveryBlocks * 2 <= cfg.fallback.heartbeatMaxAgeBlocks, 'the Council must beat at least twice inside the fallback window');
must(cfg.fallback.heartbeatMaxAgeBlocks < cfg.succession.afterSilenceBlocks, 'the fallback must pause before succession can start');
must(c.payoutDelayBlocks >= 2 * c.heartbeatSlackBlocks, 'the payout delay must leave the guardians time to freeze');
must(c.size <= 20, 'Council keys sit in ports 60 to 79');
must(g.size <= 20, 'guardian keys sit in ports 80 to 99, their check-ins in 100 to 119');
must(g.electMin >= 2 && g.electMin <= g.size && g.inactiveAfterBlocks > g.activeWindowBlocks, 'election: electMin 2..size, inactive after more than the active window');

// One MMR proof chunk: 1 byte side + the sibling (32-byte hash, MiniNumber sum 0) as Minima serialises it; measured 966 at depth 24.
const proofLen = d => 6 + 40 * d;
must(proofLen(4) === 166 && proofLen(24) === 966, 'proof length formula no longer matches the measured sizes');

const list = a => a.join(' ');
const councilPrev = Array.from({ length: c.size }, (_, i) => `PREVSTATE(${60 + i})`).join(' ');
const copyOuts = Array.from({ length: c.sealCopies }, (_, i) => `ASSERT VERIFYOUT(${i + 1} copyaddr 1 sealtok TRUE)`).join('\n');
const G0 = 80, S0 = 100, gi = Array.from({ length: g.size }, (_, i) => i);
const checkIn = gi.map(i => `  IF SIGNEDBY(PREVSTATE(${G0 + i})) THEN ASSERT (STATE(${S0 + i}) LTE @BLOCK) AND (STATE(${S0 + i}) GTE (@BLOCK - ${c.heartbeatSlackBlocks})) LET n = n + 1 ELSE ASSERT SAMESTATE(${S0 + i} ${S0 + i}) ENDIF`).join(' ');
const elect = gi.map(i => `  IF (@BLOCK - PREVSTATE(${S0 + i})) LTE ${g.activeWindowBlocks} THEN LET a = a + 1 IF SIGNEDBY(PREVSTATE(${G0 + i})) THEN LET s = s + 1 ENDIF ENDIF ` +
  `ASSERT (j EQ ${i}) OR (SAMESTATE(${G0 + i} ${G0 + i}) AND SAMESTATE(${S0 + i} ${S0 + i}) AND (cand NEQ PREVSTATE(${G0 + i})))`).join(' ');
const vars = {
  GEN: cfg.generation.tag, SEALTOK: keys.sealToken, RECTOK: keys.recordToken,
  CQUORUM: c.quorum, COUNCILPREV: councilPrev, COUNCILFIRST: 60, COUNCILLAST: 59 + c.size, COPYOUTS: copyOuts,
  HBSLACK: c.heartbeatSlackBlocks, PAYDELAY: c.payoutDelayBlocks,
  GUARDPREV: gi.map(i => `PREVSTATE(${G0 + i})`).join(' '), GUARDSTATE: gi.map(i => `STATE(${G0 + i})`).join(' '),
  GUARDSAME: `SAMESTATE(${G0} ${G0 + g.size - 1}) AND SAMESTATE(${S0} ${S0 + g.size - 1})`, GUARDFIRST: G0, GUARDLAST: G0 + g.size - 1,
  CHECKIN: checkIn, ELECT: elect, GSIZE: g.size, ACTIVE: g.activeWindowBlocks, INACTIVE: g.inactiveAfterBlocks, ELECTMIN: g.electMin,
  GSTOP: g.stop, GFREEZE: g.freeze, GRELEASE: g.release, GSUCCESSION: g.succession,
  FALLBACKWAIT: cfg.fallback.waitBlocks, HBMAXAGE: cfg.fallback.heartbeatMaxAgeBlocks,
  SUCCSILENCE: cfg.succession.afterSilenceBlocks, SUCCFROZEN: cfg.succession.afterFrozenBlocks,
  SHARDWIDTH: 256 / r.shardsPerToken, PROOFLEN: proofLen(r.depth), PERIOD: cfg.meter.periodBlocks,
  MAXVAULTIN: cfg.vault.maxVaultCoinsPerPayout,
};

const fill = name => {
  let s = fs.readFileSync(path.join(here, 'contracts', name + '.kiss'), 'utf8');
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');                                   // comments stay in the templates, not on chain
  s = s.replace(/\$([A-Z]+)/g, (m, k) => { if (!(k in vars)) throw new Error(`${name}: no value for $${k}`); return String(vars[k]); });
  return s.replace(/\s+/g, ' ').trim();
};
async function kiss(script) {
  const cmd = `runscript script:"${script}"`;
  const j = await (await fetch(NODE + '/' + encodeURIComponent(cmd))).json();
  if (!j.status) throw new Error('runscript: ' + (j.error || 'failed'));
  return j.response;
}

const out = {};
async function make(name) {
  const script = fill(name);
  const res = await kiss(script);
  const parse = /Script token parse OK/.test(res.trace) && !/PARSE ERROR/.test(res.trace);
  const err = String(res.trace).split('\n').find(l => /PARSE ERROR|Incorrect Token/.test(l));
  out[name] = { address: res.clean.address, bytes: res.clean.script.length, parse, script: res.clean.script, ...(err ? { error: err.trim() } : {}) };
  return res.clean.address;
}

vars.COPYADDR = await make('copy');
await make('head');
// The exit record reads the request and contested addresses from its genesis state (37, 38), so its own address
// comes first and the request script can name it.
vars.RECADDR = await make('record');
vars.CONTADDR = await make('contested');
vars.REQADDR = await make('request');
vars.VAULTADDR = await make('vault');
vars.ANCHORADDR = await make('anchor');
await make('gate');

// Every transaction that moves the seal must fit Minima's TxPoW limit (65,536 bytes, block magic) with a margin.
// Measured 2026-10-17 on the first R2T5 seal: a signature is about 4,125 bytes, and every seal coin carries the whole
// seal state twice (as an input and in its coin proof) plus about 600 bytes of proof and coin.
{
  const SIG = 4200, LIMIT = 65536 * 0.9;
  // 36 bytes a key port, 12 a block-number port (the first seal measured 946 bytes for 11 + 9 keys and 9 check-ins).
  const sealState = 8 * 36 + (c.size + g.size) * 36 + g.size * 12;
  const base = (1 + c.sealCopies) * (2 * sealState + 600) + out.head.bytes + out.copy.bytes + sealState + 600;
  const acts = { seal: c.quorum, freeze: g.freeze, release: g.release, succession: g.succession,
    election: 1 + Math.floor((g.size - 1) / 2) + 1, 'check-in (all guardians)': g.size };
  for (const [act, sigs] of Object.entries(acts)) {
    const bytes = Math.round(base + sigs * SIG);
    if (act.startsWith('check-in') && bytes > LIMIT) { console.log(`note: a check-in by all ${g.size} guardians would be about ${bytes} bytes; guardians check in a few at a time`); continue; }
    must(bytes <= LIMIT, `a ${act} with ${sigs} signatures would be about ${bytes} bytes, over 90% of Minima's 65,536-byte TxPoW limit`);
  }
}

// Genesis: every seal-token and record-token unit placed, nothing left over (a stray unit could forge a seal or a record).
const empty = '0x' + '00'.repeat(16), full = '0x' + 'FF'.repeat(16);
const genesis = {
  sealToken: { supply: 2 + c.sealCopies, head: { address: out.head.address, amount: 2 }, copies: { address: out.copy.address, count: c.sealCopies, amount: 1 } },
  sealState: { 20: '0x00', 21: 0, 22: cfg.generation.tag, 23: '<genesis block>', 24: `<genesis block + ${c.payoutDelayBlocks}>`, 26: '0x00', 27: 0, 28: 0,
    ...Object.fromEntries(keys.council.map((k, i) => [60 + i, k])), ...Object.fromEntries(keys.guardians.map((k, i) => [80 + i, k])),
    ...Object.fromEntries(keys.guardians.map((k, i) => [100 + i, '<genesis block>'])) },
  recordToken: { supply: Object.keys(cfg.meter.tokens).length * r.shardsPerToken },
  records: Object.entries(cfg.meter.tokens).flatMap(([token, caps]) => Array.from({ length: r.shardsPerToken }, (_, s) => ({
    token, shard: s, keyFirstByte: [s * 256 / r.shardsPerToken, (s + 1) * 256 / r.shardsPerToken - 1], address: out.record.address,
    state: { 35: caps.councilCapPerPeriod / r.shardsPerToken, 36: caps.fallbackCapPerPeriod / r.shardsPerToken, 37: out.request.address,
      38: out.contested.address, 39: `<${token} token id>`, 40: '<root: one leaf (' + empty + ', ' + full + ') at slot 0, depth ' + r.depth + '>',
      41: '<genesis block>', 42: 0, 43: 0, 44: s } }))),
  depositLanes: cfg.deposits.lanes,
};
const throughput = {
  depositsPerBlockPerToken: cfg.deposits.lanes,
  exitsPerBlockPerToken: Math.min(c.sealCopies, r.shardsPerToken) + ' at most (one per seal copy and one per record shard; two exits in the same shard wait a block)',
  rejectionsPerBlock: c.sealCopies + ' (they share the seal copies with payouts)',
  guardianStopsPerBlock: 'no limit (a stop touches only its own request)',
  exitRecordCapacityPerShard: 2 ** r.depth,
  exitRecordProofBytes: 2 * proofLen(r.depth),
};

fs.mkdirSync(OUT, { recursive: true });
const report = { draft: DRAFT, keys, generated: new Date().toISOString(), node: NODE, contracts: out, genesis, throughput };
fs.writeFileSync(path.join(OUT, 'r2t5-contracts.json'), JSON.stringify(report, null, 2) + '\n');
for (const [n, o] of Object.entries(out)) fs.writeFileSync(path.join(OUT, `r2t5_${n}.kiss`), o.script + '\n');
for (const [n, o] of Object.entries(out)) console.log(n.padEnd(10), o.parse ? 'parse OK' : 'PARSE FAILED', String(o.bytes).padStart(5), 'bytes', o.address, o.error || '');
console.log(DRAFT ? 'DRAFT: placeholder keys and tokens, the addresses are not the real ones.' : 'Keys from ' + keysFile);
console.log(JSON.stringify(throughput, null, 1));
if (Object.values(out).some(o => !o.parse)) process.exit(1);
