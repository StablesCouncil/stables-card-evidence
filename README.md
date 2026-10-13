# Stables card: how it works, and the on-chain evidence that it works as designed

**[← Start page: open the evidence pages in a browser](https://stablescouncil.org/stables-card-evidence/)**

The Stables card is the part of the Stables payment infrastructure that works like cash on a phone. Money is added to the card from Savings (an on-chain Minima balance), paid from phone to phone by touch without a network, and taken back to Savings. This repository explains the structure, shows who signs each step, and publishes the evidence from Minima mainnet: every card transaction of a test period, read from a node, checked against the design, with the raw transactions and the tools to check them again yourself.

Status: test generation **R2T3**, on Minima mainnet, with **valueless test tokens** (Winiwa). The council that approves withdrawals is a **test council**: its seven keys are held by one operator, the Stables lab. Nothing here is production. See [What this does not prove yet](#what-this-does-not-prove-yet).

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
5. **Proving old deposits.** A receiving phone proves a deposit with its own node, but only while the deposit coin is inside the node's unpruned window. Is there a supported way, with today's commands, to prove an old unspent coin to a node that has pruned it? For example, a coin proof kept with the coin. How long does such a proof stay valid?
6. **Size and cost limits.** An exit carries its whole package in ports 30 to 39, up to 10 × 4,000 bytes. The vault script loops over up to 8 vault inputs. Are we within the limits Minima intends to keep, for state size, transaction size and script instructions?
7. **Address stability.** An address is the hash of the cleaned script. Is that canonical form stable across node versions?

Questions and findings are welcome as issues on this repository.

## Who signs what

| Step | Where | Signed by | What the signature proves |
|---|---|---|---|
| **Add** (Savings to card) | On chain | The person's own Minima wallet key | An ordinary Savings send: 1 atom to the anchor address naming the card's first coin key, and the amount to the vault |
| **Pay by touch** (card to card) | Phone to phone, off chain | The TEE key of each coin spent | The owner of the coin, inside genuine hardware, gave it to the receiver's fresh key. The key is destroyed by the signature |
| **Remove** (card to Savings): exit line | Inside the request, on chain | The TEE key of the coin leaving | The coin's owner asked for this exact amount to go to this exact Savings address. The key is destroyed |
| **Remove**: request | On chain | The person's own Minima wallet key | Posts the exit line and the coin's whole history (the package) to the request address |
| **Approval** (seal) | On chain | 5 of the 7 council keys (MULTISIG) | The council checked the package and puts its approval in a sealed list (a Merkle root) |
| **Payout** | On chain | No signature: the contracts check it | Spends the request, vault coins and a seal copy; pays the amount to the address the TEE-signed exit line named |
| **Fallback** | On chain | No signature | If the council stays silent, the request pays itself after 20 blocks. The contract does not look at the package on this path, so the council must reject a bad request before the wait ends. The council can delay, never confiscate, but it must stay on watch (see [if the Council disappears](#if-the-council-disappears)) |
| **Rejection** | On chain | 5 of the 7 council keys | A refused request is spent with no payout; the request atom goes back |

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
| Pay one coin to two people (only possible with a broken chip) | Two hand-overs signed by one key are a proof that names the device; its family is revoked; the Council refuses the second exit of any coin | Any receiver that sees both; the Council |

Open: today a receiver catches a double payment only when it sees both hand-overs, and the Council checks each exit on its own. The Council keeping every hand-over it has seen, so a broken chip's double payment is caught when the second copy tries to exit, is designed, not built.

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

**Anchor (Add).** One Minima transaction from Savings with exactly one output at the **anchor address** (1 atom of the token; kept state: port 0 the generation tag `0x52325433`, port 1 the hash of the card's first coin key, port 2 the amount, port 3 the token) and one output at the **vault address** holding the amount. The anchor coin stays on chain; the card coin it creates has id `SHA-256("STR2A" | 0x01 | anchor coin id)`.

**Hop (payment).** `"STR2H" | version | token | parents | receiver key | amount | change key | change amount`, signed once by the key of every parent coin. Amounts are conserved exactly. Coin ids of the outputs are hashes of the hop body.

**Bundle.** What a payment carries: the attestation certificate chains of the phones involved, the leaf certificate of every key that signs, the anchors, and the hops in order.

**Key attestation rules.** A key is accepted only if its certificate chain reaches a pinned Google attestation root, and its attestation says: secure hardware (not software), usage count limit 1 in hardware, generated in hardware, EC P-256 signing key, bootloader locked, verified boot with the maker's key or a pinned GrapheneOS key.

**Exit line.** `"STR2E" | version | coin id | token | amount | payout address | nonce`, 126 bytes, signed by the exiting coin's key.

**Exit request.** 1 atom at the **request address**. Kept state: port 0 `0x52325445`, port 10 the SHA-256 of the package, port 11 the exited coin id, ports 12 to 14 amount, token and payout address (equal to the exit line), port 17 the refund atom, ports 30 to 39 the **package**: the exit line plus the coin's full bundle.

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

The Council is needed to make a withdrawal *fast*, never to make it *happen*. If it is gone (switched off, its server lost, its members unreachable, or refusing to sign), this is exactly what happens.

**A withdrawal from the card (Remove) still completes:**

1. The phone signs the exit line and posts the request from Savings, as always. Nobody else's signature is needed for this.
2. Nobody seals it. The request coin waits at the request address.
3. Once the request is **20 blocks old** (about 15 to 20 minutes in this test; about 7 days planned for production), its contract accepts a payout with no Council at all: `IF @COINAGE GTE 20 THEN RETURN TRUE`.
4. Anyone can post that payout, and it carries no signature. While the Stables app is open, it posts the payout for its own Removes, at most once a block. Anyone else can build the same transaction from the two published scripts.
5. The vault's contract still makes the payout exact: the amount in port 12 goes to the Savings address in port 14, which are the values the phone signed in the exit line. Leftover money goes back to the vault. Nobody can redirect it or take a cut.

This happened on mainnet. A phone's Remove of 0.01 at block 2361505 was paid at block 2361527 with no seal; it used the previous test generation, R2T2, whose request contract has the same 20-block rule. In the current generation, R2T3, a lab contract test of 0.005 was paid the same way at block 2361619. A phone's Remove has not yet gone through the R2T3 fallback, because the Council has answered every one. This is the guarantee that a Council cannot hold money back: at worst it delays a withdrawal by the waiting period.

**Everything else keeps working without the Council:** Adds go straight into the vault, and payments between phones are checked by the receiving phone alone. Neither has ever involved the Council.

**What is lost while the Council is gone:**

- **Speed.** Every Remove waits the full period instead of minutes.
- **Its check on false requests.** On the fallback path the contract does not look at the package. Normally the Council rejects a false request before the wait ends (a rejection is proven on mainnet, block 2361608). With nobody there, a request with a false package is paid like a true one, so someone who notices the Council is gone could empty the vault. In this test that exposure is accepted because the tokens have no value (DECISIONS 2a.3). For real funds, the production plan adds a fallback budget written into the contract (a cap per period on what the fallback can pay, whatever the addresses), a wait of about 7 days, and several independent members on separate machines, so that the Council is never down as a whole. None of that is in the R2T3 contracts yet. A limit per payout address was tried in the test Council's checker and removed on 13 October 2026: a new address costs nothing, so it stopped no one, and its rejection lost an honest withdrawal. See the [risk assessment](#the-council).
- **A practical limit of the app today.** The app's own fallback payout spends one vault coin large enough for the amount. If no single vault coin is large enough, the app cannot post it, although the contract would accept a payout that combines up to 8 vault coins, and anyone could build that by hand.

If the Council comes back, it carries on from where it stopped: requests already paid by the fallback are spent and cannot be paid twice.

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
- **Pruning.** A receiver proves a deposit through its own node while the deposit is inside the node's unpruned window. Older anchors need the register planned for a later stage.
- **Trust roots.** Key attestation trusts Google's attestation roots and, for GrapheneOS, the published GrapheneOS boot keys; a revoked-certificate list snapshot is used when present. A broken TEE would break the one-use guarantee; double spends remain detectable (two different hops signed by one key are a proof), but not preventable.
- **The fallback trusts the Council to be on watch.** The fallback that stops a Council holding money back also pays a false request that nobody rejects within the waiting period (20 blocks in this test). In this test that is acceptable because the tokens have no value. For real funds it needs the longer wait and the contract-enforced limits in the production plan. See the [risk assessment](#the-council).
- **Not audited.** The code and contracts have not had an external security audit.

## Risk assessment

The risks that decide whether the card can hold real money: a Council quorum that colludes or loses its keys, a Council offline longer than the fallback wait, a broken phone chip, deposits older than a node can prove, an unaudited contract or app, and a stolen app signing key. Each is named below with what we do about it and what is left; ratings are our judgement (likelihood / impact), not measurements.

### The phone's secure chip

| Risk | What could happen | Likelihood / impact | What we do about it | Left after that |
| --- | --- | --- | --- | --- |
| A family of chips is broken (key extraction or the one-signature limit bypassed) | A cheater signs one coin to two people offline | Low to medium / high | Only chips whose certificate states the hardware limit are accepted; two hand-overs signed by one key are a proof naming the device; its family is revoked; one-touch limit 50 Winiwa; weekly exit limit; Council memory of every hand-over (designed) | Receivers who never meet the second copy cannot see it; losses bounded by the limits until the revocation reaches phones |
| A device attestation key leaks from a factory | Fake certificates make software keys look like chip keys | Low / high | Google's revocation list, checked when present | Open: refreshing the list without a server; a window until phones get it |
| Google's attestation roots change, are withdrawn or are compromised | Certificates stop verifying, or fakes verify | Very low / very high | Roots pinned in the app; existing certificates keep verifying offline; Google is never called during a payment | One root today; other phone makers' roots and the smart-card route are the fallbacks |
| A rooted or modified phone | The app is made to misbehave | Medium / medium | Accepted keys require a locked bootloader and verified boot (or the pinned GrapheneOS keys) | Malware on an unmodified phone can still trick its owner (see the app) but cannot make the chip sign twice |

### Payments between phones

| Risk | What could happen | Likelihood / impact | What we do about it | Left after that |
| --- | --- | --- | --- | --- |
| Lost, broken or wiped phone | Its card money is gone | Medium / low per person | Said plainly in the app ("like cash, keep small amounts"); Savings on chain are untouched | By design, as with cash |
| The app is killed mid-payment | A coin is lost or duplicated | Low / low | Write-ahead journal; tested killed at four points; worst case one coin lost, never duplicated | One signature's window (about 17 ms) |
| Relay attack (a device relays the touch to another receiver) | A payment goes to the wrong request | Low / low to medium | Above the one-touch level the payer sees and confirms the amount; each request is bound to the receiver's fresh key | Small payments under the one-touch level could be redirected by a relay in range |
| Histories outgrow the limits | Old coins cannot be paid or taken back | High over time / medium | Limits enforced; repeat histories named, not sent | Coin refresh is designed, not built |
| Privacy | A coin can be followed back to the Savings address that funded it; a phone may be linkable by its certificate chain | Certain / medium | Fresh one-use keys; no names or numbers in payments | Pseudonymous, not anonymous; untraceability is an open design question |

### Deposits, the chain and the contracts

| Risk | What could happen | Likelihood / impact | What we do about it | Left after that |
| --- | --- | --- | --- | --- |
| A fake deposit (an anchor with no money in the vault) | Coins backed by nothing | Medium / high | Every receiver and the Council check the deposit transaction itself: one anchor, the amount into the vault, no vault input. A fake anchor was refused on mainnet | None known |
| A deposit older than a node's unpruned window | New phones cannot prove it, so its coins are refused | High over time / high | Coin refresh and the Council's register | Not built: the main technical gap for long-lived coins |
| A deep chain reorganisation after a deposit is credited | Coins exist whose deposit vanished | Very low / high | Three confirmations before crediting | A larger wait for large Adds is worth setting |
| A contract bug | Money leaves the vault wrongly | Low to medium / very high | 13 forbidden spends refused on mainnet for R2T2 (R2T2-EXIT-01) and 14 for R2T3 (R2T3-EXIT-02), among them a seal by 4 of 7, a reused approval and a skimmed vault remainder; contracts kept small | No external audit yet |
| The test lab rescue branch | The lab key can take money from the test vault and anchors | Certain in the test / very high | Test only, valueless tokens | Removed in the production generation |
| Transaction size limits (64 KB per transaction, 40 KB of history per exit) | A long history cannot exit | Medium / medium | Refresh before exit | Refresh not built |
| A Minima version change alters contract behaviour | Contracts misbehave after an upgrade | Low / high | Contracts use long-standing primitives; each new node version is tested before use | Depends on testing discipline |

### The Council

| Risk | What could happen | Likelihood / impact | What we do about it | Left after that |
| --- | --- | --- | --- | --- |
| A quorum colludes | Fake exits approved; the vault is drained | Low with independent members / very high | Independent members (7 of 11 proposed); every approval can be rechecked by anyone from the chain (the evidence tools do it); members replaced by governance | The trust assumption of withdrawals: no fewer than the quorum will collude |
| Council keys stolen | Same as collusion | High today (all 7 keys on one server) / very high | Members on separate machines and operators, keys in hardware, rotation by governance | Today's test Council protects nothing against its operator or a server breach |
| The Council censors (refuses to approve good exits) | Exits are delayed | Medium / low | The request pays itself after the waiting period (proven on mainnet) | Up to the waiting period's delay (planned about 7 days in production) |
| **The fallback exposure:** the Council is offline for longer than the waiting period | Anyone can post a request with a false package; if nobody rejects it in time, the fallback pays it from the vault. No broken chip is needed | Medium today (one server, 20-block wait) / very high | The checker watches every block and rejects bad requests (a rejection is proven on mainnet); the test vault holds valueless tokens only. Accepted for the test only (DECISIONS 2a.3) | Production plan, not built: a **fallback budget** written into the contract (a cap on what the vault may pay through the fallback per period, whatever the addresses, kept in a budget coin that every fallback payout spends and re-creates), a wait of about 7 days, and several independent members on separate machines. A limit per payout address would not help: a new address costs nothing. Until then the vault's safety depends on the Council staying online |
| The Council's checker has a bug | A bad package is approved | Low / high | Same checking code as the phones, tested; independent re-verification; audit | No external audit yet |

### The app and operations

| Risk | What could happen | Likelihood / impact | What we do about it | Left after that |
| --- | --- | --- | --- | --- |
| App bugs (wrong figure, stuck row, a step refused) | Confusion; a step to retry | High today / low | Seen and fixed on the phones on 2026-10-12 (stuck rows, a Minima Core Remove, a double count); chain truth is never changed by the display | A longer run without new findings before real money |
| The app's signing key is stolen | A malicious update pays the attacker | Low / very high | Key kept offline and backed up | Reproducible builds and a second signer are not in place |
| Revocation list goes stale | One check weakens | Medium / medium | Any mirror of Google's list in the next app version | Open: refresh without a server |
| Only Android phones with a hardware one-use key | Most people cannot hold card money | Certain / business | Web and MiniDapp verify and receive nothing to hold | Other platforms later |
| Rules for money services | Holding real value may need a licence or limits | Unknown / high | Test tokens have no value | Legal review before real funds |

## Contracts and addresses

Minima mainnet, generation R2T3. The exact scripts as executed are in [`contracts/deployed/`](contracts/deployed/), named by role and address. They are taken from the raw transactions' witnesses, and `R2Addresses` checks that each address is the hash of its script. [`contracts/`](contracts/) has the same contracts as readable templates with placeholders. `contracts/deployed/` also keeps the R2T1 and R2T2 contracts of the earlier test generations, which appear in this period's transactions:

| Contract | Address |
|---|---|
| Anchor | `0x3DC4BD9985D5924FEFB11C8F97A01AAE5C8D88CA4C270F9FD9889DB4CF45EE60` |
| Vault | `0xD7B367D654F20186DA21BE1B82BA1B4DF4FE0103CBDF12A50C7E4A7DC88F22B0` |
| Exit request | `0xB13ADD36D874B2E0640AEB1F06B9AC1B5B37EC784AAD318A1463CC13DF2ED3F7` |
| Seal head (MULTISIG 5 of 7) | `0x0468A9A9A9ABA1C8F42E8C0F084618CD3886E6164A342E232FC1C99FD3C4F2F3` |
| Seal copy | `0xAA222EFD8CC8E87A1616E3F8BAD1936A1363501C88337B53809664EF5E9EDF50` |
| Seal token | `0x0E277A26E58F352BE2967C095E4587A671A28AED7A3EBED31D43093FDA3F2E82` |
| Winiwa (test token) | `0xD4F5DD3546F25D327CBF2B6867E193CE5DB6491AC9C65BBDCECACA1A6688063F` |

The seven council public keys are in [`evidence/council.json`](evidence/council.json).

## Licence

This repository is **free and open-source software** under the [GNU General Public License, version 3 or later](LICENSE). You may use it, study it, change it and pass it on, and sell it too, but whatever you pass on, changed or not, goes with its source code under the same licence. Third-party terms are in [NOTICE](NOTICE).
