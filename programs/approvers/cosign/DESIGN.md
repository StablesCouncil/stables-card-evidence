# Approvers signing across several machines (design, 2026-11-03)

Security plan R1 (`stables-card-evidence/docs/SECURITY_PLAN.md`): no machine and no person may hold 7 of the 11
approver keys. Today `r2t5-council.mjs` signs every seal with keys 1 to 7 on one node, on one server. This folder is the
way out: one seal transaction, built once, signed on several machines that each hold only their own keys.

## Seen working (2026-11-03, lab nodes 9205 and 9305, throwaway keys, nothing posted)

A transaction built on 9205 and signed there with a 9205 key, exported (`txnexport`), imported on 9305
(`txnimport`), signed there with a 9305 key, exported and imported back on 9205: `txncheck` shows 2 signatures, both
valid, and the transaction id unchanged. So Minima carries signatures from one node to another; no key leaves its node.

## What needs the approvers' signatures

Only the seal (head act 1: the approved and rejected lists, the heartbeat). Payouts and posted rejections need no
approver key (the scripts check the proofs), so any approver machine, or anyone, can post them.

## Roles

- **Each approver machine** runs its own Minima node holding its own keys, its own WOTS journal, and its own package
  check (`R2Checker`) on every exit request. It keeps its own verdicts. No machine trusts another's verdicts.
- **A proposer** (any approver machine; in practice the one whose turn it is) builds the seal transaction exactly as
  `r2t5-council.mjs` does today, signs it with its own keys, and sends the exported transaction with its two lists.
- **Each signer** imports it and signs only if all of these hold:
  1. it spends the head and seal copies the signer itself sees unspent, and gives them back to the head and copy
     addresses with the seal token;
  2. the approved list holds only requests the signer's own check approved, the rejected list only requests it
     rejected, both sorted (omitting a request is allowed: that only delays it, and the fallback still applies);
  3. the roots in ports 20 and 26 are the signer's own `mmrcreate` of those lists with the usual filler;
  4. the heartbeat (port 23) is at most a few blocks old on the signer's node, the seal number (21) is the head's + 1,
     and payable-from (24) is heartbeat + the payout delay;
  5. the transaction stays under the TxPoW limit with the signatures still to come;
  6. the approver keys (ports 60 to 70) are unchanged, unless the change is exactly one the signer's owner listed in
     its own settings beforehand. In R2T5 a seal may replace the approver keys at once (head act 1), so without this
     check a proposer could slip its own keys into an ordinary seal.
  Then it signs with its own keys through its own WOTS journal and sends the export back.
- **The proposer** posts once 7 signatures are on the transaction. Any signer can post it too.

A signer that disagrees refuses and alerts its owner; with no 7 agreeing keys there is no seal, and the vault's own
rules take over (unanswered requests pay after 3 days while the heartbeat is fresh; a silent approver set lets the
guardians act). The heartbeat seal with unchanged lists is checked the same way.

## Spreading the 11 keys

Example: three machines with 4, 4 and 3 keys, in different places, run by different people. No machine reaches 7;
any two together do (4+3 or 4+4), so one machine can be down or refuse without stopping the seals.

A key cannot be split off a node (a node's keys come from its one seed). So the new holders create new keys on their
own machines, and the approver keys in the seal head are replaced by the existing key-change rules. In R2T5 a seal
signed by 7 current keys may write new keys into ports 60 on at once (checked in the live head script, act 1); in R2T6
with pendingChanges a change is announced and takes effect after a delay. The old one-server keys then sign nothing
more. Each signer accepts that change only if its owner listed it in advance (check 6).

## Transport

The transaction export is about 4 KB plus 4.25 KB per signature, so a full seal is up to about 60 KB. For the first
version, a plain exchange between named machines; for production, Maxima (as the guardians' Parlons alerts), so no
central server carries it. The signer's checks above do not depend on the transport: a forged message cannot make a
signer sign something its own node and checker do not agree with.

## Build steps

1. `cosign.mjs`: the signer's checks and the guarded signing (done, 2026-11-03).
2. Lab tests with two nodes and throwaway keys (done: 12 of 12, 4 of 4).
3. The proposer and signer roles in `r2t5-council.mjs` behind `R2T5_COSIGN` (done; without it, unchanged). Also: a
   signer signs one transaction per seal number, and a peer can only add signatures (the proposer checks the id).
4. Between machines over the internet: HTTP through SSH tunnels for the rehearsal; Maxima for production.
5. End to end on mainnet with test tokens: the R2T6 vault created with its 11 approver keys already spread over three
   machines (founder 2026-11-03: finish this, then create R2T6), seals signed across them for some days.
