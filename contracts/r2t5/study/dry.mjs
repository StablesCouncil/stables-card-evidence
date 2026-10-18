// Dry-run of the exit-record check on a dev node's KISS engine (runscript), 2026-10-17 study.
import fs from "fs";
const v = Object.fromEntries(fs.readFileSync(process.argv[2], "utf8").trim().split(/\r?\n/).map(l => l.split("=")));
// lt(a,b) on 32-byte ids, compared as two exact 16-byte halves (KISS numbers keep 64 digits).
const S = `LET x=STATE(1) LET lo=STATE(2) LET nx=STATE(3) LET pa=STATE(4) LET pb=STATE(5) LET rold=STATE(6) LET rmid=STATE(7) LET rnew=STATE(8)
LET xh=NUMBER(SUBSET(0 8 x)) LET xl=NUMBER(SUBSET(8 16 x))
LET lh=NUMBER(SUBSET(0 8 lo)) LET ll=NUMBER(SUBSET(8 16 lo))
LET nh=NUMBER(SUBSET(0 8 nx)) LET nl=NUMBER(SUBSET(8 16 nx))
ASSERT (lh LT xh) OR ((lh EQ xh) AND (ll LT xl))
ASSERT (xh LT nh) OR ((xh EQ nh) AND (xl LT nl))
ASSERT PROOF(CONCAT(lo nx) 0 rold 0 pa)
ASSERT PROOF(CONCAT(lo x) 0 rmid 0 pa)
ASSERT PROOF(0x00 0 rmid 0 pb)
RETURN PROOF(CONCAT(x nx) 0 rnew 0 pb)`.replace(/\n/g, " ");
const base = { 1: v.x, 2: v.lo, 3: v.nx, 4: v.p1, 5: v.p2, 6: v.old, 7: v.mid, 8: v.new };
const cases = {
  "valid insertion": base,
  "x already the low key": { ...base, 1: v.lo },
  "x outside the gap": { ...base, 2: "0x" + "FF".repeat(15) + "FE" },
  "forged new root": { ...base, 8: "0x" + "AB".repeat(32) },
  "append over a filled slot": { ...base, 5: v.p1 },
  "forged mid root": { ...base, 7: "0x" + "CD".repeat(32) },
};
for (const [name, st] of Object.entries(cases)) {
  const cmd = `runscript script:"${S}" state:${JSON.stringify(st)}`;
  const j = await (await fetch("http://127.0.0.1:9205/" + encodeURIComponent(cmd))).json();
  const r = j.response || {};
  const why = String(r.trace || "").split("\n").filter(l => /ASSERT|RETURN|Error/.test(l)).slice(-1)[0] || "";
  const bad = String(r.trace || "").split(String.fromCharCode(10)).filter(l => /ASSERT|RETURN|rror/.test(l)).slice(-2).join(" | ");
  console.log(name.padEnd(28), "parse", r.parseok, "success", r.success, j.error || "", r.success ? "" : bad.slice(0, 260));
}
console.log("script bytes", S.length);
