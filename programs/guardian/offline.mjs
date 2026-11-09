/*
 * Minima's own checks, offline (no node, no wallet, nothing posted). Two tools already in the tree:
 *   KissRunScaled (simcard/measure/java)  runs each input's script with the public keys NAMED as signers. The dry run
 *                                         uses it: it proves the guardian's real key would pass the scripts without
 *                                         the key signing anything.
 *   R2T5Offline signed (r2t5/tools)       makes real test keys from seeds, signs the transaction id, and runs the
 *                                         node's TxPoWChecker.checkSignatures and checkTxPoWScripts. The proof uses it.
 * Paths: GUARDIAN_JDK (the JDK's bin folder), GUARDIAN_MINIMA_JAR, or the config's java/jar.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { portsOf, amountOf, same } from './guardian-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOV = path.resolve(HERE, '..');
export const TOOLS = {
  kissRun: path.resolve(GOV, '../stream_1_app/work/simcard/measure/java/KissRunScaled.java'),
  r2t5Offline: path.join(GOV, 'task_route2_tee_payments/r2t5/tools/R2T5Offline.java'),
};
const WIN = process.platform === 'win32';
export function javaPaths(cfg = {}) {
  const jdk = process.env.GUARDIAN_JDK || cfg.jdk || (WIN ? 'C:/Program Files/Eclipse Adoptium/jdk-17.0.18.8-hotspot/bin' : '');
  const exe = n => (jdk ? path.join(jdk, WIN ? n + '.exe' : n) : n);
  return { java: exe('java'), javac: exe('javac'), jar: process.env.GUARDIAN_MINIMA_JAR || cfg.jar || '<lab>/Minima/Nodes/DevNodesSet/9101/minima.jar' };
}

const built = {};
function compiled(tool, cls, jp, workDir) {
  const out = path.join(workDir, 'offline-runtime');
  if (built[out + cls]) return out;
  if (!fs.existsSync(path.join(out, cls + '.class'))) {
    fs.mkdirSync(out, { recursive: true });
    const c = spawnSync(jp.javac, ['-cp', jp.jar, '-d', out, tool], { encoding: 'utf8' });
    if (c.status !== 0) throw new Error(`compiling ${cls}: ${c.stderr}`);
  }
  built[out + cls] = true;
  return out;
}

/** A live coin (node JSON) as the offline tools read it: token amounts in token units, with the token's own scale. */
export function caseCoin(c) {
  const scale = c.scale ?? (c.token && c.token.scale != null ? Number(c.token.scale) : undefined);
  return { coinid: c.coinid, address: c.address, amount: amountOf(c), tokenid: c.tokenid, storestate: c.storestate !== false && !!c.state,
    ...(c.state ? { state: portsOf(c) } : {}), created: Number(c.created), ...(scale != null ? { scale } : {}) };
}
/** A spec's outputs; a token output takes the scale of an input in the same token (the seal token is 44, not 36). */
function caseOutputs(spec) {
  return spec.outputs.map(o => {
    const twin = spec.inputs.find(i => same(i.tokenid, o.tokenid));
    const sc = twin ? caseCoin(twin).scale : undefined;
    return { ...o, ...(sc != null ? { scale: sc } : {}) };
  });
}

/**
 * Dry-run check: every contract input's script, with `signers` (public keys) named. Returns
 * { ok, inputs: [{ input, contract, success, exception }] }.
 */
export function scriptCheck(spec, { signers, block, contracts, cfg = {}, workDir }) {
  const jp = javaPaths(cfg);
  const rt = compiled(TOOLS.kissRun, 'KissRunScaled', jp, workDir);
  const byAddr = Object.fromEntries(Object.entries(contracts).map(([k, v]) => [v.address.toUpperCase(), k]));
  const base = { block, inputs: spec.inputs.map(caseCoin), outputs: caseOutputs(spec), state: spec.state, signatures: signers,
    ...(spec.witnessScripts ? { witnessScripts: spec.witnessScripts } : {}) };   // R2T6's rare head acts carry their MAST branch
  const cases = spec.inputs.map((c, i) => ({ c, i, k: byAddr[String(c.address).toUpperCase()] })).filter(x => x.k)
    .map(({ i, k }) => ({ ...base, name: `${spec.kind} input ${i} (${k})`, script: contracts[k].script, input: i }));
  const f = path.join(workDir, `check-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify(cases));
  try {
    const r = spawnSync(jp.java, ['-cp', jp.jar + path.delimiter + rt, 'KissRunScaled', f], { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (r.status !== 0) throw new Error('KissRunScaled: ' + r.stderr.slice(0, 400));
    const res = JSON.parse(r.stdout.slice(r.stdout.indexOf('[')));
    const inputs = res.map((x, j) => ({ input: cases[j].input, contract: cases[j].name.replace(/^.*\((.*)\)$/, '$1'), success: x.success, exception: x.exception || null }));
    return { ok: inputs.length > 0 && inputs.every(x => x.success), inputs };
  } finally { fs.rmSync(f, { force: true }); }
}

/**
 * Real signatures: each case is a spec plus { name, block, signers: [seed], scripts: [script], tamper?, signOther? },
 * seeds as "0x..", and "$KEY:<seed>" in any state replaced by that test key's public key. Returns R2T5Offline's rows.
 */
export function signedCheck(cases, { cfg = {}, workDir }) {
  const jp = javaPaths(cfg);
  const rt = compiled(TOOLS.r2t5Offline, 'R2T5Offline', jp, workDir);
  const rows = cases.map(c => ({ name: c.name, block: c.block, inputs: c.spec.inputs.map(caseCoin), outputs: caseOutputs(c.spec), state: c.spec.state,
    signers: c.signers, scripts: c.scripts, ...(c.tamper ? { tamper: c.tamper } : {}), ...(c.signOther ? { signOther: true } : {}) }));
  const f = path.join(workDir, `signed-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify(rows));
  try {
    const r = spawnSync(jp.java, ['-cp', jp.jar + path.delimiter + rt, 'R2T5Offline', 'signed', f], { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (r.status !== 0) throw new Error('R2T5Offline: ' + r.stderr.slice(0, 400));
    return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
  } finally { fs.rmSync(f, { force: true }); }
}

/** mmrcreate without a node (R2T5Offline mmr: the same MMR, leaf value 0). Returns the root of each leaf list. */
export function mmrRoots(lists, { cfg = {}, workDir }) {
  const jp = javaPaths(cfg);
  const rt = compiled(TOOLS.r2t5Offline, 'R2T5Offline', jp, workDir);
  const r = spawnSync(jp.java, ['-cp', jp.jar + path.delimiter + rt, 'R2T5Offline', 'mmr'], { input: JSON.stringify(lists), encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error('R2T5Offline mmr: ' + r.stderr.slice(0, 400));
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop()).map(x => x.root.data);
}

/** As mmrRoots, with each leaf's proof: one list of proofs per leaf list (R2T6's ring slots name a proof per request). */
export function mmrProofs(lists, { cfg = {}, workDir }) {
  const jp = javaPaths(cfg);
  const rt = compiled(TOOLS.r2t5Offline, 'R2T5Offline', jp, workDir);
  const r = spawnSync(jp.java, ['-cp', jp.jar + path.delimiter + rt, 'R2T5Offline', 'mmr'], { input: JSON.stringify(lists), encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error('R2T5Offline mmr: ' + r.stderr.slice(0, 400));
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop()).map(x => x.nodes.map(n => n.proof));
}
