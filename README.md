# Stables card: how it works, and the on-chain evidence that it works as designed

**[← Start page: open the evidence pages in a browser](https://stablescouncil.org/stables-card-evidence/)**

The Stables card is the part of the Stables payment infrastructure that works like cash on a phone. Money is added to the card from Savings (an on-chain Minima balance), paid from phone to phone by touch without a network, and taken back to Savings. This repository explains the structure, shows who signs each step, and publishes the evidence from Minima mainnet: every card transaction of a test period, read from a node, checked against the design, with the raw transactions and the tools to check them again yourself.

Status: on Minima mainnet with **valueless test tokens** (Winiwa). Since 17 October 2026 the card's next vault generation, **R2T5**, is deployed: no lab key anywhere, a Council heartbeat without which the fallback pauses, community guardians who can stop, freeze and replace the Council and renew themselves, and an exit record that makes the chain refuse a second payout of the same coin (see [if the Council disappears](#if-the-council-disappears)). The evidence set below (11 to 12 October) is from the earlier test generation R2T3. Every Council and guardian key is held by the Stables lab for now. Nothing here is production. See [What this does not prove yet](#what-this-does-not-prove-yet).

## Contents

1. [The idea in one paragraph](#the-idea-in-one-paragraph)
2. [For reviewers](#for-reviewers)
3. [Who signs what](#who-signs-what)
4. [One coin through many hands, off chain](#one-coin-through-many-hands-off-chain)
5. [See it](#see-it)
6. [The structure](#the-structure)
7. [The evidence (11 to 12 October 2026)](#the-evidence-11-to-12-october-2026)
8. [Check it yourself](#check-it-yourself)
9. [What this does not prove yet](#what-this-does-not-prove-yet)
10. [Risk assessment](#risk-assessment) (and [if the Council disappears](#if-the-council-disappears))
11. [Contracts and addresses](#contracts-and-addresses)
12. [Licence](#licence)

## The idea in one paragraph

Money on the card is a set of **coins**, each owned by a key that lives in the phone's secure hardware (the TEE, the trusted execution environment of the phone's processor). Each key can sign **exactly once**: the hardware enforces a usage limit of 1 and destroys the key after its signature. To pay, the phone signs a **hop** that gives the coin to a fresh key made by the receiving phone; the paying key is gone, so the same coin cannot be signed away twice. The receiving phone checks the whole history of the coin before it accepts it: every signature, and a certificate chain proving that every key that ever signed was made inside genuine secure hardware (Android key attestation, rooted in Google's attestation roots). Money enters the card through an on-chain deposit and leaves it through an on-chain request that carries the coin's complete history, so the chain records, at exit, every TEE signature the money went through.

## For reviewers

Everything here runs on Minima as it is today, with standard KISS script and node commands. Nothing in this design needs a change to Minima.

**Open in a browser:** https://stablescouncil.org/stables-card-evidence/ (the walkthrough and the viewer below, served from this repository by GitHub Pages; GitHub itself shows `.html` files as source).

**Where to start (about an hour):**

1. [`evidence/2026-10-12/signature-walkthrough.html`](evidence/2026-10-12/signature-walkthrough.html): one real Remove followed from start to finish. It shows the phone's signature inside the transaction's state, byte by byte, and checks it in your browser. Then come the Council seal (5 of 7 keys) and the payout, with the contract lines that allow each step. Every transaction links to the Minima explorer.
2. [`contracts/deployed/`](contracts/deployed/): the exact scripts as executed on mainnet, one file per contract, named by role and address. `R2Addresses` recomputes each address from its script with Minima's own `Address` class (all 18 scripts in the preserved transactions match). [`contracts/`](contracts/) holds the same contracts as readable templates.
3. [Check it yourself](#check-it-yourself): build the verifier and rerun every check from the preserved raw transactions. The report it writes matches [`EVIDENCE.md`](evidence/2026-10-12/EVIDENCE.md) line for line.

**What we would most like checked, on the Minima side:**

1. **Transaction-level state shared across inputs.** The payout's request coin reads `STATE(20)` (the approvals root) and `STATE(25)` (its proof). The seal copy's script ties port 20 to the root the Council sealed (`SAMESTATE(20 22)` against its own previous state). Is relying on one transaction state, seen by every input script, sound and stable?
2. **`PROOF` over a root built with `mmrcreate`.** The leaf is the request coin id, with value 0. The Council adds one filler leaf so a tree always has at least two. Is this the intended use? Can a proof for an internal node be passed off as a proof for a leaf?
3. **`MULTISIG` with wallet key trees.** The Council's seven keys are wallet root keys, and each seal spends one-use keys under them. How many seals can one key tree sign before it runs out, and what is the safe way to rotate a Council key?
4. **The `@COINAGE` fallback.** A request pays itself after `@COINAGE GTE` the waiting period (20 blocks in this test), so a silent Council cannot hold money back. Is there any re-organisation or timing case that would let it pay early, or block it?
5. **Proving old deposits.** Since 17 October 2026 (R2T4, [deposits that prove themselves](#deposits-that-prove-themselves-at-any-age-r2t4)) the answer rests on two readings of Minima's source: a coin's id is `hash(first input coin id, output index)` (`TxBlock`), and a coin imported with `coinimport ... track:true` or tracked with `cointrack` is kept up to date by the node like its own coins, so `coinexport` keeps giving a proof another node accepts. Are both guaranteed to hold in future node versions, and is there any case (a re-organisation, a resync from a MegaMMR snapshot) where a tracked coin's proof is lost?
6. **Size and cost limits.** An exit carries its whole package in ports 30 to 39, up to 10 × 4,000 bytes. The vault script loops over up to 8 vault inputs. Are we within the limits Minima intends to keep, for state size, transaction size and script instructions?
7. **Address stability.** An address is the hash of the cleaned script. Is that canonical form stable across node versions?
8. **Exclusion proofs with `PROOF` (R2T5 exit record).** A paid coin's key goes into a sorted list kept as a fixed-depth Merkle tree built with Minima's own MMR hashing: a leaf is `CONCAT(key, next key)`, an empty slot is `0x00`. The record script proves the key lies strictly between a leaf's two keys, and the insertion with four `PROOF` checks (old root, middle root, empty slot, new root), keys compared as two 8-byte numbers because KISS numbers stop at 2^64 ([`contracts/r2t5/contracts/record.kiss`](contracts/r2t5/contracts/record.kiss), study in [`contracts/r2t5/study/`](contracts/r2t5/study/)). Is this sound, and is a fixed proof length (`LEN`) enough to rule out a proof of an inner node?
9. **Limits we met on mainnet.** A TxPoW may be at most 65,536 bytes (block magic); a node relays no transaction with more than 10 outputs, nor one whose state size times its kept-state outputs passes 64 KB (`RelayPolicy`); `PROOF` throws on a proof it cannot read instead of returning false; a token's id is only final once its creation is mined. Are these stable, and are there others a covenant designer should know?

Questions and findings are welcome as issues on this repository.

## Who signs what

| Step | Where | Signed by | What the signature proves |
|---|---|---|---|
| **Add** (Savings to card) | On chain | The person's own Minima wallet key | Since R2T4: a transaction whose first input is a lane coin of the deposit gate; the gate's script requires the marker (1 atom at the anchor address naming the card's first coin key) and the amount into the vault, in that same transaction |
| **Pay by touch** (card to card) | Phone to phone, off chain | The TEE key of each coin spent | The owner of the coin, inside genuine hardware, gave it to the receiver's fresh key. The key is destroyed by the signature |
| **Remove** (card to Savings): exit line | Inside the request, on chain | The TEE key of the coin leaving | The coin's owner asked for this exact amount to go to this exact Savings address. The key is destroyed |
| **Remove**: request | On chain | The person's own Minima wallet key | Posts the exit line and the coin's whole history (the package) to the request address |
| **Approval** (seal) | On chain | 5 of the 7 council keys (MULTISIG) | The council checked the package and puts its approval in a sealed list (a Merkle root) |
| **Payout** | On chain | No signature: the contracts check it | Spends the request, vault coins and a seal copy; pays the amount to the address the TEE-signed exit line named |
| **Fallback** | On chain | No signature | If the council stays silent, the request pays itself after 20 blocks. The contract does not look at the package on this path, so the council must reject a bad request before the wait ends. The council can delay, never confiscate, but it must stay on watch (see [if the Council disappears](#if-the-council-disappears)) |
| **Rejection** | On chain | 5 of the 7 council keys | A refused request is spent with no payout; the request atom goes back |
| **Refusal** (a payment the receiver never got) | The receiver's phone; on chain inside a refund request | The TEE key of the receiver's own request | The receiver never credited that request and never will: it marked the request refused before signing, and the key is destroyed by the signature. The refusal names the Savings address the payer gave at first contact |
| **Refund** | On chain | The payer's own Minima wallet key posts it; 5 of the 7 council keys approve it | The refusal and the payer's signed bundle go through the same request contract as a Remove; the amount goes back to the payer's Savings |

The TEE signatures of the payments themselves are made between phones, off chain. They reach the chain at exit: the exit request carries the coin's full history, so every hop signature and every key attestation the money went through is on chain from then on.

## One coin through many hands, off chain

A coin received by touch can be paid onward at once, phone to phone, again and again, with no network and nothing written on chain; only the Add and the Remove touch the chain.

1. Each hand-over creates a new coin under the receiver's fresh one-use key, and the payer's key is destroyed by its one signature.
2. The new coin carries its whole history: every earlier hand-over, every key certificate, back to the vault deposit. The receiver checks all of it before crediting.
3. To pay onward, the receiver signs with its own key: the history grows by one hand-over.

Seen on chain on 2026-10-12: the 0.0298 Winiwa the Pixel 7 took back to Savings had come from 3 Adds and passed through 6 hand-overs between the two phones, back and forth, before its exit. Its exit request carries all 6 signatures and 10 key certificates.

### How far a coin can travel

| Limit | Value | At the limit |
| --- | --- | --- |
| Hand-overs carried by one payment | 64 | Refused; the coin must be refreshed first |
| Size of one payment | 64 KB | Refused. Measured: 2.2 KB fresh, 4.2 KB after an afternoon of back and forth |
| History depth before a refresh is due | 10 hand-overs | Still accepted; the coin is marked for refresh |
| Deposits merged in one coin's history | 16 | Refused |
| Phones in one coin's history | 8 | Refused |
| Coins spent by one payment | 4 | The payer refreshes or combines first |
| History an exit can carry | 40 KB (10 kept values of 4 KB) | A longer history is refreshed before it can leave the card. Measured: 14.9 KB for 6 hand-overs from 3 deposits |
| Contact time | About 1 s at 4 KB | Grows with size; repeat payments between the same phones send about a third, because histories the receiver already holds are named, not sent |

### How fraud is stopped along the way

| Attempt | What stops it | Who checks |
| --- | --- | --- |
| Sign the same coin away twice | The chip allows one signature per key and destroys it; the certificate proves that limit is in hardware | The chip; every receiver reads the certificate |
| Create money from nothing | Every history starts at a real deposit into the vault, read on chain; amounts add up at every hand-over | Every receiver, from its own node |
| Use a copied or software key | Certificate chain to Google's hardware root: made inside the chip, one signature, locked and verified boot | Every receiver; the Council at exit |
| Replay a payment | A payment is accepted only for the receiver's own open request, once | The receiver |
| Exit a coin already paid away | Its key is gone, so no exit line can be signed | The chip |
| Exit the same coin twice | The Council refuses a second exit of a coin; the request is spent once | The Council and the contract |
| Exit two copies of a coin paid to two people | The Council keeps every hand-over it has approved; a second, different hand-over of the same coin is refused as a double spend | The Council |
| Pay one coin to two people (only possible with a broken chip) | Two hand-overs signed by one key are a proof that names the device; its family is revoked; the Council refuses the second exit of any coin | Any receiver that sees both; the Council |

Since 17 October 2026 the Council keeps every hand-over in every package it approves (`R2Checker --seen`). A broken chip's double payment is therefore caught at the latest when the second copy tries to exit: that package holds another hand-over of a coin the Council has already seen spent, and it is refused as a double spend, with both signed hand-overs as the proof that names the device. Before an exit, a receiver still catches it only when it sees both hand-overs itself.

### When a touch breaks off

A payment is signed and handed over in one touch. The paying phone checks that the other phone is still there before each coin key signs, so a touch that ends early leaves nothing signed and nothing owed. If the touch breaks after the signatures but before the receiver confirms, the payer holds a signed payment that the receiver may or may not have. It is settled without guessing:

1. After 2 minutes the payer's phone asks the receiver over the Minima network, with a plain transaction that carries the question in its kept state (no server, no messaging service). It asks again after 2, 4, 8, 16, 32 and 64 minutes.
2. A receiver that has the payment answers so, and the payer's row becomes Sent.
3. A receiver that never got it first marks that request refused for good, so the payment is refused if its bytes ever arrive later. Then it signs a refusal (`"STR2N" | version | request key hash | payout | nonce`) with the request's own one-use key, which the chip destroys in the signature. The payout is the Savings address the payer gave at first contact, so the refusal refunds only that payer, whoever reads it.
4. The payer posts a refund request: `"STR2F" | version | refusal | the payer's bundle`, through the same request contract as a Remove. The Council checks it as below and pays the amount back to the payer's Savings.

**The refund rule** (`R2Receiver.checkRefund`, run by the Council's `R2Checker`): the refusing key passes the key attestation rules, is the refused request's key and signed the refusal; the bundle is valid and holds no double spend; exactly one coin in it is paid to that request's key; that coin is not spent inside the bundle, was never seen paid away, and has not exited or been refunded before; and the request's ports 11 to 14 are that coin, its amount, its token and the payout the refusal names. A coin therefore leaves the card once, by a Remove from its owner or by a refund to its payer, never both: the receiver's key that could have spent it no longer exists.

Seen on mainnet on 16 October 2026: a 0.33 Winiwa payment whose touch broke before the receiver had it was asked about and refused over the network 2 minutes later, and refunded to the payer's Savings by the Council about 4 minutes after the touch (refund request in block 2,369,988, seal in block 2,369,990, payout in block 2,369,992, transaction `0x0000006547DA33B4445A15EA70770CDD0949787449FAAF164DFF142E1995EE59`).

### Deposits that prove themselves at any age (R2T4)

A card coin's history starts at a deposit, and a receiving phone accepts the coin only if that deposit really put the money in the vault. Until 17 October 2026 (R2T2, R2T3) the deposit left a 1-atom marker at the anchor address, and the phone proved the money by reading the deposit transaction from its own node. Nodes forget transactions after their unpruned window (about a day), so older card money could not be proven by a phone that had not seen the deposit. The marker alone proved nothing: anyone can send 1 atom with any state to an address.

R2T4 makes the marker impossible to fake, so its existence is the proof:

1. **The deposit gate.** Every Add spends one lane coin of the gate (`0x084B1E93...`, script in [`contracts/deployed/`](contracts/deployed/)) as its **first input**. The gate's script requires, in that same transaction: output 0 the next lane coin, output 1 the marker at the anchor address, output 2 the amount into the vault, and the deposit number (port 5) one above the lane coin's own. A broken shape (the vault paid one atom short, the gate not first, a skipped number, no marker) fails the script; checked on mainnet with `txncheck`.
2. **Ids that can be computed.** Minima derives a new coin's id from the first input's coin id and the output index. A lane coin is spent once, so each lane is one chain of ids from its published genesis coin: `L(lane, n) = hash(L(lane, n-1), 0)`, and the marker of deposit n is `hash(L(lane, n-1), 1)`. A receiver checks that the marker's id is exactly that for the lane and number in its ports 6 and 5 (`R2Deposits`). A coin anyone sends to the anchor address has another id and is refused. No old transaction is read, no server, no register.
3. **Proofs the phones keep.** Each phone's node tracks the markers behind the coins it holds, so their proofs stay current; a payment carries a fresh export of each (about 900 bytes), and a receiving phone whose node no longer sees the marker imports that proof with tracking and checks the marker as in 2.

Seen on mainnet on 17 October 2026: the gate's 8 lanes (blocks 2,371,091 and 2,371,093), and its first deposit (block 2,371,103), whose three outputs had exactly the ids computed in advance from lane 1's genesis coin (marker `0x1506D2E561AE970D7B4A8B3C12E5AF7E5F4FF7496C73E608AAC084325691585F`).

Card money resting on an R2T3 deposit moves onto gate deposits by coin refresh (a Remove and an Add of the same coin), one coin at a time.

### Why it scales

- The chain carries only Adds, Removes and refreshes. Payments in between use no block space, so how many payments happen is set by phones, not by blocks.
- A payment's size grows with its coin's history, not with the number of people using Stables, and the limits above bound it.
- Coin refresh (designed, not built) takes long histories back through the vault in the background, which starts a short history again.
- A receiver checks a deposit with its own node once and remembers it, so a touch needs no node read.

## See it

Both pages open in a browser at https://stablescouncil.org/stables-card-evidence/.

[`evidence/2026-10-12/signature-walkthrough.html`](evidence/2026-10-12/signature-walkthrough.html) follows one Remove step by step. It starts from the phone's signature in the transaction's state, goes through the Council seal, and ends with the payout, checking the signatures and comparisons in your browser. It is generated by `verifier/scripts/walkthrough.mjs --tx <txpowid> --standalone`.

Each transaction can also be opened on the public explorer, `https://explorer.minima.global/transactions/<txpowid>`, which shows its inputs, outputs, scripts and state variables. The explorer only has a transaction while Minima keeps it; the copies preserved here are the long-term record.

[`evidence/2026-10-12/viewer.html`](evidence/2026-10-12/viewer.html) shows this set of card transactions (blocks 2361500 to 2362925, 11 to 12 October 2026) in a browser: each coin's journey drawn from its exit package, every TEE signature with the key that made it and that key's certificate chain, which Council keys signed each seal, and the checking code quoted line by line with what it does. It is generated from the evidence by `verifier/scripts/viewer.mjs`.

## The structure

The byte formats are fixed in the design ([trace-design section 13](docs/trace-design-route2.md)); the summary:

**Coin.** `(amount, public key, history)`. Keys are P-256, generated in the TEE, never imported, usage count limit 1 enforced by the hardware.

**Anchor (Add).** One Minima transaction from Savings with exactly one output at the **anchor address** (1 atom of the token; kept state: port 0 the generation tag `0x52325433`, port 1 the hash of the card's first coin key, port 2 the amount, port 3 the token) and one output at the **vault address** holding the amount. The anchor coin stays on chain; the card coin it creates has id `SHA-256("STR2A" | 0x01 | anchor coin id)`. **R2T4:** the same anchor and vault, the transaction's first input a lane coin of the deposit gate, port 0 `0x52325434`, port 5 the deposit number on that lane, port 6 the lane; the marker is genuine when its coin id is `hash(L(lane, n-1), 1)` ([above](#deposits-that-prove-themselves-at-any-age-r2t4)).

**Hop (payment).** `"STR2H" | version | token | parents | receiver key | amount | change key | change amount`, signed once by the key of every parent coin. Amounts are conserved exactly. Coin ids of the outputs are hashes of the hop body.

**Bundle.** What a payment carries: the attestation certificate chains of the phones involved, the leaf certificate of every key that signs, the anchors, and the hops in order.

**Key attestation rules.** A key is accepted only if its certificate chain reaches a pinned Google attestation root, and its attestation says: secure hardware (not software), usage count limit 1 in hardware, generated in hardware, EC P-256 signing key, bootloader locked, verified boot with the maker's key or a pinned GrapheneOS key. Since 15 October 2026 (phones and Council alike) it must also name the Stables app (package `org.stablescouncil.stables` and the Stables release signing certificate). Keys made from that date carry a fixed Stables attestation challenge, SHA-256 of `STR2-coin-key-v2`; for those keys the checker also requires that they cannot sign while the phone is locked. Older keys keep the earlier rules, so money already on cards stays valid. No certificate in the chain may be on Google's revocation list, which the phones refresh daily when online and the Council keeps current.

These rules read the Android key attestation record that the phone's secure hardware writes into each key's certificate. Android documents the record, its fields and Google's roots in [Verify hardware-backed key pairs with key attestation](https://developer.android.com/privacy-and-security/security-key-attestation); Google's own verifier library is [android/keyattestation](https://github.com/android/keyattestation). The Stables card does not use that library: `verifier/java/` checks the same record with its own code, so anyone can read exactly which fields are required.

**Why TEE one-use keys, not StrongBox.** The card's protection against paying the same coin twice is that each coin's key can sign exactly once, and that the phone's hardware, not the app, enforces that limit. The attestation record says where the limit is enforced, and receivers accept a key only if it sits in the hardware-enforced list. On the Pixel 7 Pro, a StrongBox key reports its one-use limit as enforced by software, so it would fail that rule, while the TEE (the processor's trusted execution environment) enforces it in hardware. (Measured on 10 October 2026 on one Pixel 7 Pro, Android 17: the StrongBox key lists the limit under `softwareEnforced`, the TEE key under `hardwareEnforced`; both refused a second signature.) The card therefore makes its keys in the TEE. A StrongBox key would be acceptable on any phone whose StrongBox enforces the one-use limit itself; the rule is the same either way. A single long-lived StrongBox key that signs every payment, as some payment designs use, would not protect against double spending: it could sign the same coin to two people offline.

**Exit line.** `"STR2E" | version | coin id | token | amount | payout address | nonce`, 126 bytes, signed by the exiting coin's key.

**Exit request.** 1 atom at the **request address**. Kept state: port 0 `0x52325445`, port 10 the SHA-256 of the package, port 11 the exited coin id, ports 12 to 14 amount, token and payout address (equal to the exit line), port 17 the refund atom, ports 30 to 39 the **package**: the exit line plus the coin's full bundle.

**Package carriers.** An exit package of more than 25,500 bytes kept inline would make a payout too large for a Minima block. Such a package is posted in up to 4 carrier coins at the **package address**, whose script is `RETURN FALSE`, so carriers are never spent. Carrier ports: 0 the tag `0x5232504B`, 1 the package hash, 2 the part index, 3 to 8 the data (at most 24,000 bytes a carrier). The request then keeps the package hash in port 10, the hashes of the parts in port 18, and nothing in ports 30 on, so its payout stays small. The Council assembles the package from the carriers and checks every part against port 18 and the whole against port 10. A request whose inline package is over the limit is never approved (it could not be paid) and the phone posts it again in carriers.

**Refund request.** The same request contract and ports as an exit; its package starts with `STR2F` (see [when a touch breaks off](#when-a-touch-breaks-off)).

**Council.** Checks the package exactly as a receiving phone checks a payment, then signs a seal: the seal head (MULTISIG 5 of 7) moves with its copies and records a Merkle root of approved requests. A payout proves its request is in that root (`PROOF`) by spending a seal copy.

## The evidence (11 to 12 October 2026)

[`evidence/2026-10-12/EVIDENCE.md`](evidence/2026-10-12/EVIDENCE.md) lists **every** Minima mainnet transaction that touched a card contract between blocks 2361500 and 2362925 (about 20 hours), 28 transactions, each checked against the design. It is one dated set: card transactions after block 2362925 are not in it, and later sets will be added as their own dated folders under `evidence/`. Nothing is selected by hand: the collector walks every block and keeps every transaction that touches a card address or the council's seal token.

| Kind | Count | Result |
|---|---|---|
| Add | 7 | all pass |
| Exit request (Remove) | 7 (4 from phones, 3 lab contract tests) | all pass |
| Council seal | 5 (1 genesis, 4 approvals) | all pass; each approval signed by 5 of the 7 published council keys |
| Payout | 6 (4 approved by seal, 2 by fallback) | all pass |
| Council rejection | 1 | pass |
| Migration of the first test vault, lab rescue | 2 | described |

### One coin's journey, on chain

The Remove of 0.0298 Winiwa at block 2362849 (12 October, 16:42 UTC) is the clearest case. Its package, read from the chain and checked offline, shows:

- **3 deposit anchors** (Adds of 0.05, 0.03 and 0.05 Winiwa), each creating a card coin owned by a TEE key;
- **6 payment hops**, each signed by the TEE key of every coin it spends (ECDSA P-256), amounts conserved at every step;
- **10 keys on 2 devices**, every one attested: device A runs stock Android (verified boot with the maker's key), device B runs GrapheneOS on a Pixel 7 (its boot key is the published GrapheneOS key). Every chain reaches a pinned Google root; every key has a hardware usage limit of 1;
- the **exit line**, signed by the exited coin's own TEE key.

The money travelled from one phone to the other and back by touch, then left the card, and every signature on the way is now on chain and checkable. Its council seal (period 4) is signed by 5 of the 7 council keys, and the payout at block 2362855 pays 0.0298 to the address the TEE-signed exit line named.

### If the Council disappears

**Since 17 October 2026 (generation R2T5): when the Council disappears, money freezes. It never flows, and the community can take over.** Removing the Council was the easiest way to empty the earlier test vault (R2T3, below): its fallback paid any request nobody rejected within 20 blocks. R2T5 closes that, on chain, with nothing left to trust a server for. Design: [`docs/R2T5_DESIGN.md`](docs/R2T5_DESIGN.md); every number is in one configuration file, [`contracts/r2t5/r2t5.config.json`](contracts/r2t5/r2t5.config.json), and the contracts are generated from it.

**What the chain enforces in R2T5:**

1. **The fallback only works while the Council is alive.** The Council (7 of 11 keys) seals at least every 6 hours (a heartbeat: its seal records the block it was made in). A request pays without the Council only when it is 3 days old **and** the Council's last heartbeat is less than a day old. A Council that is switched off, attacked, or kept out of blocks pauses the fallback instead of opening it. A Council that is alive but refuses an honest exit still loses to the fallback after 3 days.
2. **The chain remembers every paid card coin (the exit record).** Each payout inserts the paid coin into a sorted list kept as a Merkle tree, and proves on chain that the coin was not in it before (`PROOF`, four checks per payout). A coin that was paid once can never be paid again, by the Council or by the fallback, even if the Council forgot. The list is split in 8 shards per token (by the first byte of the coin id), each holding 16.7 million exits; with the 6 seal copies, up to 6 payouts per block.
3. **Caps written into the contracts.** The record coin of each shard also meters what it paid in the current day, separately for Council payouts and for the fallback, and refuses a payout over the cap. Even if every other defence failed, a day's loss is bounded.
4. **Approved payouts wait.** An approval becomes payable 144 blocks (about 2 hours) after its seal. During that time any 3 guardians can freeze.
5. **Guardians.** Nine community guardians are recorded in the seal's state. **Any one** stops a request (it becomes contested: the Council can still approve or reject it, the fallback only reopens after 5 guardians release it). **Three** freeze all payouts; the Council cannot lift a freeze, **five** can. **Six** install a new Council after 3 days of Council silence or 7 days frozen; the new Council starts with empty lists and must seal before anything pays. A dishonest guardian can delay, never pay.
6. **Guardians renew themselves.** A guardian checks in on chain now and then. A seat whose guardian has not checked in for 60 days is open: anyone can propose themselves by publishing a key, and takes the seat when they sign together with more than half of the guardians active in the last 30 days (at least 3). Inactive guardians do not vote; a candidate cannot hold two seats; an election changes nothing else.
7. **No back door.** No contract has a lab key. The marker anchor's script is `RETURN FALSE`: a marker can never be spent.

**Proven so far** (offline on 176 whole transactions with Minima's own `Contract` class (every contract input's script), and on mainnet as listed below): the valid paths pass, and among others a replay of a paid coin, a forged record root, a key in another shard, a payout over the cap, a meter reset inside its day, a fallback while the Council is silent or the vault frozen, a rejection that grabs vault coins, short signature sets, a Council lifting its own freeze, a succession while the Council is alive or one that approves a list itself, and every broken election are refused.

<!-- R2T5-MAINNET -->
**On Minima mainnet** (run R2T5-DEPLOY-03, 17 and 18 October 2026, test tokens; every step below was checked with `txncheck` before it was posted, and each refusal was a complete, correctly signed transaction that the contracts refused):

- The seal head and its 6 copies: block 2,371,855 [`0x000088FAFB1E98367154B4615691714A50B13C678B499D7CA72578A9B628270A`](https://explorer.minima.global/transactions/0x000088FAFB1E98367154B4615691714A50B13C678B499D7CA72578A9B628270A). The 16 exit records (8 shards for each of 2 tokens): blocks 2,371,858 to 2,371,872. The 16 deposit lanes: blocks 2,371,875 to 2,371,876.
- Two deposits through the gate (5 and 3 Winiwa into the vault): block 2,371,880 [`0x00000D2DBFB99C74DD3A362BB84F1FEE96547F5793C1AD63899E2264DA60BE84`](https://explorer.minima.global/transactions/0x00000D2DBFB99C74DD3A362BB84F1FEE96547F5793C1AD63899E2264DA60BE84) and block 2,371,884 [`0x000076F203EC14E3CAE70C089C51FD54144B752BF81CDE8EBB6B662001313233`](https://explorer.minima.global/transactions/0x000076F203EC14E3CAE70C089C51FD54144B752BF81CDE8EBB6B662001313233). A receiving phone credits them by their marker's coin id alone (`R2DepositsTest`).
- A Council seal signed by 7 of the 11 keys, approving two requests and rejecting one, with its heartbeat: block 2,371,913 [`0x0000363165DDF657C4760327D1088AB046E650B1B6D34C8D8BADA2F693C54336`](https://explorer.minima.global/transactions/0x0000363165DDF657C4760327D1088AB046E650B1B6D34C8D8BADA2F693C54336) (53,635 bytes).
- The rejection, posted with no signature at all (the proof in the sealed list is enough): block 2,371,918 [`0x00003E9A76CD511351B8B6D19ACABDA389B2B2658809357100A52A19338893C4`](https://explorer.minima.global/transactions/0x00003E9A76CD511351B8B6D19ACABDA389B2B2658809357100A52A19338893C4).
- One guardian stops a request: block 2,371,923 [`0x00007AE3473F52CEA992207C514CEF1DC7AC7DAC48658CE0D89EE158AEC77DE2`](https://explorer.minima.global/transactions/0x00007AE3473F52CEA992207C514CEF1DC7AC7DAC48658CE0D89EE158AEC77DE2). Five guardians release it: block 2,371,929 [`0x00006194CE78B6A6A34F47919B643AFC6BE204D7D4D7FB3EF3C27FD5DD430674`](https://explorer.minima.global/transactions/0x00006194CE78B6A6A34F47919B643AFC6BE204D7D4D7FB3EF3C27FD5DD430674).
- Three guardians freeze the head and every copy: block 2,371,934 [`0x000085E8DACFB06A99E947ED996CA2B3AF405DCBB4E2F43F32051DEB7DAF1DE6`](https://explorer.minima.global/transactions/0x000085E8DACFB06A99E947ED996CA2B3AF405DCBB4E2F43F32051DEB7DAF1DE6). While frozen, the Council (7 of 11) signing a seal that lifts the freeze is refused, so is a release by 4 guardians, and so is the approved payout once its delay has passed. Five guardians release: block 2,372,055 [`0x000052B87EB7D6A134491CE12423FF0C4F7CDCD4467D4410C97D98FAD908A5F1`](https://explorer.minima.global/transactions/0x000052B87EB7D6A134491CE12423FF0C4F7CDCD4467D4410C97D98FAD908A5F1).
- Guardians check in: block 2,372,059 [`0x0000077815D0701F9EDC55C3BE0EE8C2514C0195B079880CF231ED93266EC95D`](https://explorer.minima.global/transactions/0x0000077815D0701F9EDC55C3BE0EE8C2514C0195B079880CF231ED93266EC95D) and block 2,372,064 [`0x0000175B5042C9A3750D0A92414E9EDAF69297E8E2048C19A2A7494E261F8E8E`](https://explorer.minima.global/transactions/0x0000175B5042C9A3750D0A92414E9EDAF69297E8E2048C19A2A7494E261F8E8E).
- **The approved payout, inserting the paid coin into its exit record:** block 2,372,068 [`0x00004117B2C27FE47BE66D24746033A7D559D5F1C3E0B898307CDFAB3513190E`](https://explorer.minima.global/transactions/0x00004117B2C27FE47BE66D24746033A7D559D5F1C3E0B898307CDFAB3513190E).
- **The replay:** a second request for the same card coin, approved by the Council in the same sealed list, cannot be paid. A proof built honestly is impossible (the coin is already in the list), and a stale proof from before the first payout is refused by the record contract.
- The R2T5 Council runs on the Stables server since 18 October 2026: it checks every R2T5 exit with the same code as the phones, seals at least every 6 hours, and publishes the exit lists from which anyone rebuilds every record root.
<!-- /R2T5-MAINNET -->

**The trust that remains:** six of nine guardians acting together could install a Council of their own after a long silence or freeze, and that Council would still face the delay, the caps and a freeze by any three others. In this test the Council's eleven keys and the guardians' nine are held by the founding team; dispersing them to independent people is the next step.

#### Before R2T5 (R2T3 and R2T4)

In R2T3 the Council was needed to make a withdrawal *fast*, never to make it *happen*: a request 20 blocks old paid itself, without looking at the package. This happened on mainnet (a phone's Remove of 0.01 at block 2361505 paid at 2361527 with no seal, R2T2; a lab test of 0.005 at 2361619, R2T3). The same rule meant that with the Council gone, a false request nobody rejected was paid like a true one, so someone who noticed the Council was gone could empty the vault. That exposure was accepted for valueless test tokens only; R2T5 above is the answer. Money still resting in the R2T3 vault moves to R2T5 by coin refresh, one coin at a time.

## Check it yourself

Everything needed is in this repository:

- `evidence/2026-10-12/raw/`: the raw transactions (`txpow-<id>.json`) and the blocks that include them (`block-<n>.json`, whose `txnlist` names each transaction), as a Minima node returned them. Minima prunes old transaction bodies and no public explorer keeps them, so they are preserved here.
- `evidence/2026-10-12/package-*.hex`: each exit request's package, taken from its ports 30 to 39.
- `evidence/2026-10-12/card-ledger.json`, `evidence.json`: the collected ledger and the full machine-readable findings.
- `verifier/`: the tools. `java/` is the Stables card's own checking code (bundle, hop, exit line, attestation rules, Google roots) plus `R2Evidence.java`, which decodes a package; `scripts/` collects a ledger from a node, preserves the raw transactions and writes the report.

```sh
# Build the verifier (JDK 11 or newer, and minima.jar from https://github.com/minima-global/Minima/releases)
MINIMA_JAR=/path/to/minima.jar ./verifier/build.sh

# Check that every contract address is the hash of the exact script executed (Minima's own Address class)
java -cp "verifier/build:$MINIMA_JAR" org.stablescouncil.stables.route2.R2Addresses \
  --raw evidence/2026-10-12/raw --out contracts/deployed

# Check one package offline: every key attestation, every hop signature, the exit line
java -cp "verifier/build:$MINIMA_JAR" org.stablescouncil.stables.route2.R2Evidence \
  --pkg evidence/2026-10-12/package-000026397395.hex

# Regenerate the whole report from the preserved data
node verifier/scripts/report.mjs --ledger evidence/2026-10-12/card-ledger.json \
  --raw evidence/2026-10-12/raw --council evidence/council.json \
  --cp "verifier/build:$MINIMA_JAR" --out /tmp/stables-evidence

# Collect a fresh ledger from your own Minima node (RPC enabled), then preserve and report it
node verifier/scripts/collect.mjs --rpc <rpc port> --from <block> --to <block> --out card-ledger.json
node verifier/scripts/preserve.mjs --rpc <rpc port> --ledger card-ledger.json --out raw
```

Run `java` 11 or newer (`build.sh` compiles for 11). On Windows, separate class path entries with `;` instead of `:` and use a full path to `verifier/build`.

The package checks need no node and trust nothing we say: the signatures and certificate chains verify from the bytes alone. The anchor and payout checks read the transactions, which a Minima node with these blocks returns as preserved here.

## What this does not prove yet

- **The council is a test council.** Its seven keys are held by one operator, the Stables lab, on one server. The evidence shows the mechanism (5 of 7 signatures enforced by the contract, a sealed list, payouts proven against it, a fallback when it is silent), not independent governance.
- **Test tokens.** Winiwa has no value. The amounts are small on purpose.
- **Payments are seen when they exit.** A payment between phones is off chain; its signatures reach the chain when the coin leaves the card. Coins still on cards are not on chain.
- **Pruning.** An R2T3 deposit can be proven only inside a node's unpruned window. R2T4 deposits are proven at any age by their marker's id and the proof the payer's node keeps; that a tracked coin's proof stays exportable past the window is read from Minima's source and is being measured on a lab node.
- **Trust roots.** Key attestation trusts Google's attestation roots and, for GrapheneOS, the published GrapheneOS boot keys; a revoked-certificate list snapshot is used when present. A broken TEE would break the one-use guarantee; double spends remain detectable (two different hops signed by one key are a proof), but not preventable.
- **R2T5 is new.** Its contracts are proven on 176 whole transactions offline and on mainnet as listed in [if the Council disappears](#if-the-council-disappears); the phones move their money to it by coin refresh from the next app build. Elections and successions take weeks or days to become possible, so they are proven offline only so far. In R2T3 the fallback paid a false request that nobody rejected within 20 blocks; that exposure is closed in R2T5 and remains only for money not yet moved over.
- **Not audited.** The code and contracts have not had an external security audit.

## Risk assessment

The risks that decide whether the card can hold real money: a Council quorum that colludes or loses its keys, a Council offline longer than the fallback wait, a broken phone chip, deposits older than a node can prove, an unaudited contract or app, and a stolen app signing key. Each is named below with what we do about it and what is left; ratings are our judgement (likelihood / impact), not measurements.

### The phone's secure chip

| Risk | What could happen | Likelihood / impact | What we do about it | Left after that |
| --- | --- | --- | --- | --- |
| A family of chips is broken (key extraction or the one-signature limit bypassed) | A cheater signs one coin to two people offline | Low to medium / high | Only chips whose certificate states the hardware limit are accepted; two hand-overs signed by one key are a proof naming the device; its family is revoked; one-touch limit 50 Winiwa; Council memory of every hand-over (designed) | Receivers who never meet the second copy cannot see it; losses bounded by the limits until the revocation reaches phones |
| A device attestation key leaks from a factory | Fake certificates make software keys look like chip keys | Low / high | Google's revocation list, checked when present | Open: refreshing the list without a server; a window until phones get it |
| Google's attestation roots change, are withdrawn or are compromised | Certificates stop verifying, or fakes verify | Very low / very high | Roots pinned in the app; existing certificates keep verifying offline; Google is never called during a payment | One root today; other phone makers' roots and the smart-card route are the fallbacks |
| A rooted or modified phone | The app is made to misbehave | Medium / medium | Accepted keys require a locked bootloader and verified boot (or the pinned GrapheneOS keys) | Malware on an unmodified phone can still trick its owner (see the app) but cannot make the chip sign twice |

### Payments between phones

| Risk | What could happen | Likelihood / impact | What we do about it | Left after that |
| --- | --- | --- | --- | --- |
| Lost, broken or wiped phone | Its card money is gone | Medium / low per person | Said plainly in the app ("like cash, keep small amounts"); Savings on chain are untouched | By design, as with cash |
| The app is killed mid-payment | A coin is lost or duplicated | Low / low | Write-ahead journal; tested killed at four points; worst case one coin lost, never duplicated | One signature's window (about 17 ms) |
| Relay attack (a device relays the touch to another receiver) | A payment goes to the wrong request | Low / low to medium | Above the one-touch level the payer sees and confirms the amount; each request is bound to the receiver's fresh key | Small payments under the one-touch level could be redirected by a relay in range |
| Histories outgrow the limits | Old coins cannot be paid or taken back | High over time / medium | Limits enforced; repeat histories named, not sent; coin refresh (built 16 October 2026): a coin whose history passes 3,000 bytes goes back through the vault and returns as a fresh coin, automatically or only when charging, as the person chooses; histories over 25,500 bytes leave in package carriers | Each refresh is a Remove and an Add on chain |
| A touch breaks off mid-payment | The payer cannot tell whether the receiver has the money | High / low | Nothing is signed once the touch has ended; a signed payment is settled over the network after 2 minutes: Sent, or refused by the receiver and refunded to the payer's Savings | Settling needs both phones online at some point; until then the payment stays Not confirmed |
| Privacy | A coin can be followed back to the Savings address that funded it; a phone may be linkable by its certificate chain | Certain / medium | Fresh one-use keys; no names or numbers in payments | Pseudonymous, not anonymous; untraceability is an open design question |

### Deposits, the chain and the contracts

| Risk | What could happen | Likelihood / impact | What we do about it | Left after that |
| --- | --- | --- | --- | --- |
| A fake deposit (an anchor with no money in the vault) | Coins backed by nothing | Medium / high | Every receiver and the Council check the deposit transaction itself: one anchor, the amount into the vault, no vault input. A fake anchor was refused on mainnet | None known |
| A deposit older than a node's unpruned window | New phones cannot prove it, so its coins are refused | High over time / high | R2T4 (built 17 October 2026): a marker that cannot be faked, its proof kept fresh by each holder's node and carried with every payment; R2T3 money moved over by coin refresh | Rests on node tracking (being measured past the window); a phone that loses its node's data keeps only the proofs it last stored |
| A deep chain reorganisation after a deposit is credited | Coins exist whose deposit vanished | Very low / high | Three confirmations before crediting | A larger wait for large Adds is worth setting |
| A contract bug | Money leaves the vault wrongly | Low to medium / very high | 13 forbidden spends refused on mainnet for R2T2 (R2T2-EXIT-01) and 14 for R2T3 (R2T3-EXIT-02), among them a seal by 4 of 7, a reused approval and a skimmed vault remainder; contracts kept small | No external audit yet |
| The test lab rescue branch | The lab key can take money from the R2T3 test vault and anchors | Certain in R2T3 / very high | Test only, valueless tokens | **Gone in R2T5**: no contract has a lab key, and a marker can never be spent |
| Transaction size limits (64 KB per transaction, 40 KB of history per exit) | A long history cannot exit | Medium / medium | Refresh before exit | Refresh not built |
| A Minima version change alters contract behaviour | Contracts misbehave after an upgrade | Low / high | Contracts use long-standing primitives; each new node version is tested before use | Depends on testing discipline |

### The Council

| Risk | What could happen | Likelihood / impact | What we do about it | Left after that |
| --- | --- | --- | --- | --- |
| A quorum colludes | Fake exits approved; the vault is drained | Low with independent members / very high | Independent members (7 of 11 proposed); every approval can be rechecked by anyone from the chain (the evidence tools do it); members replaced by governance | The trust assumption of withdrawals: no fewer than the quorum will collude |
| Council keys stolen | Same as collusion | High today (all 7 keys on one server) / very high | Members on separate machines and operators, keys in hardware, rotation by governance | Today's test Council protects nothing against its operator or a server breach |
| The Council censors (refuses to approve good exits) | Exits are delayed | Medium / low | The request pays itself after the waiting period (proven on mainnet) | Up to the waiting period's delay (planned about 7 days in production) |
| **The fallback exposure (R2T3):** the Council is offline for longer than the waiting period | Anyone can post a request with a false package; if nobody rejects it in time, the fallback pays it from the vault. No broken chip is needed | Medium today (one server, 20-block wait) / very high | The checker watches every block and rejects bad requests (a rejection is proven on mainnet); the test vault holds valueless tokens only. Accepted for the test only (DECISIONS 2a.3) | Production plan, not built: a **fallback budget** written into the contract (a cap on what the vault may pay through the fallback per period, whatever the addresses, kept in a budget coin that every fallback payout spends and re-creates), a wait of about 7 days, and several independent members on separate machines. A limit per payout address would not help: a new address costs nothing. Until then the vault's safety depends on the Council staying online |
| The Council's checker has a bug | A bad package is approved | Low / high | Same checking code as the phones, tested; independent re-verification; audit; in R2T5 a 2-hour delay before an approval pays, during which any 3 guardians freeze, and a daily cap | No external audit yet |
| **R2T5:** the Council disappears, is attacked or kept out of blocks | The vault is emptied through the fallback | **Closed by contract** / very high | The fallback works only while the Council's heartbeat is under a day old; a paid coin can never be paid twice (exit record); daily caps per shard; any one guardian stops a request; 6 guardians install a new Council after 3 days of silence | Exits wait while a Council is replaced (founder decision: nothing to steal means fewer attacks) |
| **R2T5:** guardians collude | They install a Council of their own | Low with independent guardians / high | Only after 3 days of Council silence or 7 days frozen; the new Council still faces the delay, the caps and a freeze by any three others | The trust assumption of R2T5: no six of nine guardians collude; today all nine keys are the lab's |

### The app and operations

| Risk | What could happen | Likelihood / impact | What we do about it | Left after that |
| --- | --- | --- | --- | --- |
| App bugs (wrong figure, stuck row, a step refused) | Confusion; a step to retry | High today / low | Seen and fixed on the phones on 2026-10-12 (stuck rows, a Minima Core Remove, a double count); chain truth is never changed by the display | A longer run without new findings before real money |
| The app's signing key is stolen | A malicious update pays the attacker | Low / very high | Key kept offline and backed up | Reproducible builds and a second signer are not in place |
| Revocation list goes stale | One check weakens | Medium / medium | Any mirror of Google's list in the next app version | Open: refresh without a server |
| Only Android phones with a hardware one-use key | Most people cannot hold card money | Certain / business | Web and MiniDapp verify and receive nothing to hold | Other platforms later |
| Rules for money services | Holding real value may need a licence or limits | Unknown / high | Test tokens have no value | Legal review before real funds |

## Contracts and addresses

Minima mainnet, generation **R2T5** (run R2T5-DEPLOY-03, 17 October 2026). The scripts as registered are in [`contracts/deployed/`](contracts/deployed/) (`r2t5_*`), generated from [`contracts/r2t5/`](contracts/r2t5/) by `r2t5-generate.mjs` with the configuration [`r2t5.config.json`](contracts/r2t5/r2t5.config.json):

| Contract | Address |
|---|---|
| Seal head (Council 7 of 11 keys, guardians, heartbeat) | `0xD6462FFC684A99C146D0FFE4D1681FF61BD7DB99122ECBDD64E7F702AF425561` |
| Seal copy (6) | `0xE37B73AA83186B7CCEBF306699A5D87CF6721071059B621F599B8A6856E47896` |
| Exit request | `0x5BFE17B989A7053037A3E565C42696481952295E20F2EE7128F61713176F907B` |
| Contested request (stopped by a guardian) | `0x092183C5904C71124646E339E33C003DD2FF0F3AE250BE752C8CC34C2200164A` |
| Vault | `0x5E2497EC163480AEC7C15B43A62FDBED9595FA38ED1DE2ACC4A0A4F0E1287791` |
| Exit record (8 shards per token) | `0xD06AD1ACCCC6AB8F61ADEA5F17EA2058A4B8998DC81517F2D1EC89B3C6D0B704` |
| Deposit gate | `0x9454F9DEC8C03CBA54179F2808934A3D65B281C42124B5BA567322F2497CE9A6` |
| Marker anchor (`RETURN FALSE`) | `0x8E5DA67BE5D0E8E6E58238702B725F2BDBE982D3B264A55D8FC4A8D648E7071D` |
| Seal token (supply 8) | `0x3079FF7DF1077EC9755F98C7A042A0553BDD27B9C49E08F1CE7D86982D8AB7BC` |
| Exit-record token (supply 16) | `0x4F422DFFB35256B15525E5C0022B0AFA73392DB6CE70B846764982FA861A17EE` |

The eleven Council and nine guardian public keys, the 16 deposit lanes, and every deployment step with its block and transaction are in [`evidence/r2t5/`](evidence/r2t5/). Two earlier runs (R2T5-DEPLOY-01 and 02) stopped on findings described in [`docs/R2T5_DESIGN.md`](docs/R2T5_DESIGN.md); their coins stay on chain unused.

Generation R2T3 (still holding money that has not moved over yet). The exact scripts as executed are in [`contracts/deployed/`](contracts/deployed/), named by role and address. They are taken from the raw transactions' witnesses, and `R2Addresses` checks that each address is the hash of its script. The package carriers' script, `RETURN FALSE`, is never executed (carriers are never spent), so no witness holds it: it is added by hand, and its address is Minima's hash of those 12 characters. [`contracts/`](contracts/) has the same contracts as readable templates with placeholders. `contracts/deployed/` also keeps the R2T1 and R2T2 contracts of the earlier test generations, which appear in this period's transactions:

| Contract | Address |
|---|---|
| Anchor | `0x3DC4BD9985D5924FEFB11C8F97A01AAE5C8D88CA4C270F9FD9889DB4CF45EE60` |
| Vault | `0xD7B367D654F20186DA21BE1B82BA1B4DF4FE0103CBDF12A50C7E4A7DC88F22B0` |
| Exit request | `0xB13ADD36D874B2E0640AEB1F06B9AC1B5B37EC784AAD318A1463CC13DF2ED3F7` |
| Seal head (MULTISIG 5 of 7) | `0x0468A9A9A9ABA1C8F42E8C0F084618CD3886E6164A342E232FC1C99FD3C4F2F3` |
| Seal copy | `0xAA222EFD8CC8E87A1616E3F8BAD1936A1363501C88337B53809664EF5E9EDF50` |
| Seal token | `0x0E277A26E58F352BE2967C095E4587A671A28AED7A3EBED31D43093FDA3F2E82` |
| Package carriers (`RETURN FALSE`) | `0xABA005476D2B3CD7F251B9783E64C124C9670BB358695F04D91B2057BB64CB49` |
| Deposit gate (R2T4) | `0x084B1E939F497E46EA5107D3B29CB82E8E547FED26EDE45984FC3890352B7CC3` |

The gate's 8 lanes start at these genesis coins (port 5 = 0, port 6 = the lane), lanes 1 to 8 in order:
`0xEDD47A48D22EE92992D9D3BF6FD0761E6272417C0DEEE4FE640DF3A875890167`, `0xB30C91D504B80D39E5E34C286C6F6DB64176C96D994796FF80D93C487C574CE4`,
`0x6DA136F11EBA61F1D04669AD4087B60B7E1193A310A5998F674EC51248371679`, `0x494D8AFF5F7DB3A82A8589C7FBA97082FC9F212BD8388081A720B99DBB54CDCF`,
`0xD09FD59919CB708A674A5DA2724F985D93F209A199C8309D46245048FD7A76D7`, `0x81730FA814DB79B1C749659969C2E532EFF90513FEB95C88DF1F9E5226BF55CF`,
`0x40AFA8EBD249FD810A59E322CB193BF6376D141D3AC9A6D454E495936E5AC934`, `0xE3D39D739A1844C0D54FA0CF0550B7A0EE21980D366F80BAA133FD07C2E45C38`.
| Winiwa (test token) | `0xD4F5DD3546F25D327CBF2B6867E193CE5DB6491AC9C65BBDCECACA1A6688063F` |

The seven council public keys are in [`evidence/council.json`](evidence/council.json).

## Licence

This repository is **free and open-source software** under the [GNU General Public License, version 3 or later](LICENSE). You may use it, study it, change it and pass it on, and sell it too, but whatever you pass on, changed or not, goes with its source code under the same licence. Third-party terms are in [NOTICE](NOTICE).
