# R2T5: the next card vault generation

> In this repository the files named below are in [`contracts/r2t5/`](../contracts/r2t5/) (configuration, generator, battery, contract templates, `tools/`, `study/`), the scripts as registered in [`contracts/deployed/`](../contracts/deployed/) (`r2t5_*`), and the deployment record in [`evidence/r2t5/`](../evidence/r2t5/). Paths such as `simcard/evidence/...` refer to the Stables development tree.

Status 2026-10-17: **deploying on Minima mainnet with test tokens** (founder: "you can go with the onchain deployment
when you are ready"). Contracts generated from one config file, parsed by a dev node's KISS engine, and run on 83 whole
transactions offline with Minima's own Contract class: 176 of 176 (every input's script) behave as expected. On-chain steps and their blocks:
`simcard/evidence/R2T5-DEPLOY-01/` (campaign `simcard/route2/r2t5-campaign.mjs`).

Founder's asks, 2026-10-17: "One configuration file is good"; "it seems to me the chain itself should remember";
"nobody can drain the vault by removing the Council"; "can we have multiple exits and deposits per block?"; "draft the
next vault generation with all of this, the configuration file included". Background: the threat review (summarised in the README's risk assessment).

## Files

| File | What |
|---|---|
| `r2t5.config.json` | **Every number of the generation**: Council size and quorum, seal copies, guardian count and thresholds, waits, caps, shards, depth, deposit lanes |
| `contracts/*.kiss` | The seven contract templates, commented (comments are stripped before going on chain) |
| `r2t5-generate.mjs` | Checks the config holds together, fills the templates in address order, has a node parse each one (read only), writes `out/` (scripts, addresses, sizes, genesis plan, throughput) |
| `r2t5-cases.mjs` | The offline battery (66 transactions), results in `out/r2t5-cases-results.json` |
| `study/` | The exit-record study: `ExitSet.java` (sparse Merkle tree with Minima's own hashing), `dry.mjs` (node dry-run), `d24.txt` (a depth-24 insertion) |

Changing a number: edit the config, run `node r2t5-generate.mjs && node r2t5-cases.mjs`. A deployed contract never
changes (its address is its script), so a changed number is a new generation; card money moves to it by itself through
the card refresh, as it did from R2T3 to R2T4.

## The seven contracts

| Contract | Holds | Who moves it, and how |
|---|---|---|
| **Seal head** | 2 seal-token units; the Council's keys, the guardians' keys and their last check-ins in its state | Port 29 names the action. **1 seal** (7 of the 11 Council keys): new approved and rejected lists plus a heartbeat (block number, at most 72 blocks old), payable 144 blocks later; it may change its own keys, never lift a freeze or touch the guardians. **2 freeze** (3 guardians). **3 release** (5 guardians). **4 succession** (6 guardians, only after 3 days of Council silence or 7 days frozen): new Council keys, empty lists, the old heartbeat kept, so nothing pays until the new Council seals. **5 check-in** (any guardians): each signer's last-seen block moves to now. **6 election**: a seat whose guardian has not checked in for 60 days goes to a candidate who signs (it holds the key), chosen by more than half of the guardians active in the last 30 days, at least 3 |
| **Seal copy** (6) | 1 seal-token unit each, carrying the seal | One payout or rejection per copy per block, given back unchanged. 3 guardians can freeze one copy alone (when the chain is too busy to take them all with the head) |
| **Exit request** | 1 atom; the exit's details | **Any one guardian** stops it (it becomes contested). **Rejection** (port 50 = 0): proven in the Council's rejected list, posted by anyone, may touch no vault coin. **Approval** (50 = 1): proven in the approved list, after the delay, not frozen. **Fallback** (50 = 2): 3 days old, Council heartbeat under 1 day old, not frozen |
| **Contested request** | A stopped request | The Council still approves or rejects it. Its fallback opens only after 5 guardians release it; any one guardian can stop it again |
| **Vault** | The card money | **No lab key, no other way out**: only a paying exit (request or contested at input 0, with the exit record of its shard) spends it; the change comes back |
| **Exit record** (8 per token) | 1 record-token unit; the tree of paid coins; the period meters | Moves only inside a payout: the paid card coin is inserted (the chain proves it was not there), and the payout is counted against the shard's cap for its path (Council or fallback) |
| **Deposit gate** | The R2T4 gate, pointed at the new vault | Unchanged mechanics |

Port map (transaction state): 0 tag; 10 to 17 the exit; 20 approved root, 21 seal number, 22 generation, 23 heartbeat,
24 payable from, 25 the proof for this exit, 26 rejected root, 27 frozen, 28 frozen since, 29 head action; 35 to 49 the
exit record; 50 path; 51 contested released; 52 the seat in an election; 60 on the Council keys; 80 on the guardian keys;
100 on each guardian's last check-in block. Seal copies carry the guardians too, so a stop or a release reads them from a
copy (one copy per guardian act).

## "The chain itself remembers": the exit record

Every paid card coin goes into a sorted list kept as a Merkle tree; the record coin holds only the root (32 bytes).
To pay, the payout proves the coin's key falls in a gap of the list (so it was never paid) and that the new root is
the same list with the key added: four `PROOF` checks and two comparisons, about 240 instructions of the 1,024 allowed.

- Key = the first 16 bytes of the card coin id. KISS numbers stop at 2^64 (found today), so keys compare as two 8-byte
  halves; 16 bytes leaves a random clash at about 1 in 10^24 for ten million coins, and a clash can only refuse an
  exit, never pay one twice.
- Depth 24: 16.7 million exits per shard, two proofs of 966 bytes each per payout.
- Proven so far: the dry-run on node 9205 (depth 4 and 24) accepts the insertion and refuses five forgeries (a key
  already present, a key outside the gap, a forged new root, writing over a filled slot, a forged middle root); the
  battery refuses a replay of an already recorded coin.
- What it closes: **a paid card coin can never be paid again, by any path**, even if the Council lost its memory or
  every guardian slept. What it does not close: a coin paid onward on the card and also exited by its old holder (two
  different coin ids). That stays the Council's job at exit (it keeps every hand-over), as today.

## Multiple exits and deposits per block (your question)

Yes. With the config as drafted, per block and per token:

| | Per block | What sets it |
|---|---|---|
| Deposits (Adds) | 16 | Deposit lanes (`deposits.lanes`) |
| Exits paid | up to 6 | One per seal copy (6) and one per record shard (8 per token); two exits in the same shard wait one block |
| Rejections | up to 6 | They use a seal copy too |
| Guardian stops | no limit | A stop touches only its own request |

All three are config numbers. Raising copies and shards raises exits per block; the limit after that is block space
(a payout is about 8 KB with both tree proofs).

**Minima's own limits shape these numbers** (found on mainnet, 2026-10-17). A TxPoW may be at most 65,536 bytes (the
block's "magic"), a node relays no transaction with more than 10 outputs, nor one whose state size times its kept-state
outputs passes 64 KB. A Council signature is about 4,125 bytes and every seal coin carries the whole seal state, so the
first R2T5 seal (8 signatures, 9 coins) was 66,174 bytes and was never mined. The generation now has a quorum of 7 of
11 and 6 seal copies, a head script of 2,981 bytes (loops instead of unrolled code), and the generator refuses any
configuration whose seal, freeze, release, succession or election would pass 90% of the limit. Guardians check in a few
at a time. The first deployment (R2T5-DEPLOY-01) stays on chain unused: its seal can never be posted, so its 8 test
Winiwa and 5 lab requests stay where they are.

**Every input's script, every time** (run 02, 2026-10-17). A guardian majority's release of a contested request was
refused on mainnet: the seal copy in that transaction saw five guardian signatures and took its own "freeze this copy"
branch. A copy now freezes alone only when it is the transaction's first input. The battery missed it because each
case ran one script; it now runs the script of every contract input of every accepted transaction (176 cases), and it
fails on the old copy. Run 02 stays on chain unused, like run 01; run 03 carries the fix.

## What each attack meets now

| Attack (threat review) | In R2T5 |
|---|---|
| A1 forged exit, Council away | Fallback **paused** without a heartbeat under 1 day old |
| A2 Council made late | Same: the fallback cannot start; succession after 3 days |
| A3 Council server down | Same; exits wait for a Council (founder decision 3) |
| A4 Council keys stolen | Approvals pay only 144 blocks after the seal; 3 guardians freeze in that window; caps per day per shard; the thieves cannot lift a freeze; 6 guardians replace them after 7 days frozen |
| A5 replay | **Refused by the chain** (exit record) |
| A6 lab backdoor | None in any contract |
| A7 wrong approval | Delay plus guardian freeze plus caps |
| A8 censoring Council | Long fallback while it is alive (3 days, capped); succession if it goes silent |
| A9 legacy deposits | Not carried over: R2T5 starts with deposits through its own gate only |
| Forged request created straight at the contested address | Any one guardian stops it again |
| Rejection used to take vault coins | Refused by the request (no vault input) and by the vault (no exit record) |

## Open points (my calls, flagged for you)

1. **The guardian set renews itself (founder 2026-10-17: "proven active guardians can create new ones if some are not
   showing up").** Guardians check in on chain (one transaction, any number of signers). A seat whose guardian has not
   checked in for 60 days is open: anyone can propose themselves by publishing a key, and the candidate takes the seat
   when it signs together with more than half of the guardians active in the last 30 days (at least 3). Inactive
   guardians do not vote. A candidate cannot take a second seat, and an election changes nothing else. Removing an
   active guardian who misbehaves is not possible by this path; it would be a new generation.
2. **Six guardians can install a new Council**, but only after 3 days of silence or 7 days frozen, and that Council
   still faces the delay, the caps and the freeze. The guardian set is the last line of trust.
3. **The exit list must be kept.** The chain holds only the root; to pay the next exit someone needs the whole list.
   It can be rebuilt from the payouts on chain only inside the node's history window. Plan: the Council and every
   guardian keep it, and it is published (like the order book) so anyone can check it against the roots.
4. **Caps are fixed amounts per token** (20,000 Council and 1,000 fallback per day, split over 8 shards), because a
   contract cannot see the vault's total. Set to the test economy; to revisit before real money.
5. Every seal-token and record-token unit must be placed at genesis; a stray unit could forge a seal or a record.
   The generator writes the genesis plan; the genesis transaction must be checked against it.

## What building it means

- Council software: seal every 6 hours (heartbeat), paths and port 50, the copy and record inputs, keep and publish
  the exit list, build the tree proofs.
- Guardian software: the open-source checker plus stop / freeze / release, run by each guardian on its own machine.
- App: payouts and refunds name the path, pick the shard's record coin, carry the record proofs (built by the Council
  or any guardian); the refresh moves R2T4 money to R2T5 as it moved R2T3 money.
- On chain: a test deployment on mainnet with test tokens, the battery replayed with `txncheck`, then real payouts.
