# cosign: approvers signing across several machines

| File | What |
|---|---|
| `DESIGN.md` | Why and how: roles, the six checks a signer makes before signing, spreading the 11 keys, transport, steps |
| `cosign.mjs` | One approver machine's side: `checkProposal` (the checks against its own node, verdicts and settings) and `signWith` (its own keys, each through its WOTS journal) |
| `cosign.mjs` (transport) | `serveSigner` (a signer machine's HTTP service; one signature per seal number) and `collectSignatures` (the proposer passes the seal from signer to signer until 7 signatures; a peer can only add signatures) |
| `../r2t5-council.mjs` | Wired in behind `R2T5_COSIGN` (a settings file: role proposer or signer, this node's keys, peers or listen port, planned key changes). Without it, unchanged |
| `test/lab-transport.mjs` | The service and the collector between two lab nodes: signed; a second seal for the same number refused; a peer sending back another transaction discarded; a peer down skipped |
| `test/lab-two-nodes.mjs` | Two lab nodes, throwaway keys, nothing posted: an agreeing proposal is signed on both nodes; nine kinds of bad proposal are refused |

```
node test/lab-two-nodes.mjs      # needs lab nodes 9205 and 9305 up; 12 of 12 on 2026-11-03
node test/lab-transport.mjs      # same nodes; 4 of 4 on 2026-11-03
```
