# Card deposits that prove themselves at any age (generation R2T4)

Founder decision 2026-10-17: "proofs the phone keeps itself", then "please build everything".
Replaces the "Council register" planned for old deposits (trace-design 13.3 and 13.11, Stage 3).

## The problem

A card coin's history starts at a deposit (an Add). A receiving phone accepts the coin only if that deposit really put
the money in the vault. Today (R2T2, R2T3) the deposit leaves a 1-atom marker at the anchor address, and the phone proves
the money by reading the deposit transaction from its own node. Nodes forget transactions after their unpruned window
(about 2,100 blocks, roughly a day), so a phone that did not see the deposit refuses older card money. The marker alone
proves nothing: anyone can send 1 atom with any state to the anchor address.

## Two facts from Minima (read in its source, checked on mainnet data)

1. **A new coin's id is `hash(first input coin id, output index)`** (`TxBlock.java`, `Transaction.calculateCoinID`).
   Checked on the 1,561.8 Winiwa Add of 2026-10-16 (block 2,369,917): its three output ids recompute exactly from its
   first input `0x866608E1...` with Minima's own class.
2. **A node keeps the coins it tracks up to date**, its own and any it was told to track: `coinimport ... track:true`
   (a proof from another node) and `cointrack enable:true coinid:` (a coin it can still see) add the coin to the node's
   relevant coins. `coinexport` then gives a proof against the block 256 behind the tip, which another node imports while
   that block is in its window. Measured: a marker's proof is 919 bytes. A lab probe measures whether a tracked coin's
   proof stays exportable after the coin's block has left the window (two lab nodes, one tracking, one not).

## The design

### 1. A deposit gate: markers that cannot be faked

A covenant, the **gate**, holds a few chain coins (lanes). Every R2T4 deposit spends one lane coin as its **first input**,
and the gate enforces, by consensus, the whole shape of that transaction:

```
LET gen=0x52325434
LET anchoraddr=<R2T3 anchor address, unchanged>
LET vaultaddr=<R2T3 vault address, unchanged>
ASSERT @INPUT EQ 0                                   the lane coin is the first input
ASSERT STATE(0) EQ gen
ASSERT STATE(2) GT 0
ASSERT STATE(5) EQ PREVSTATE(5)+1                    the deposit number on this lane
ASSERT STATE(6) EQ PREVSTATE(6)                      the lane
ASSERT VERIFYOUT(0 @ADDRESS @AMOUNT @TOKENID TRUE)   output 0: the next lane coin
ASSERT VERIFYOUT(1 anchoraddr 0.00000001 STATE(3) TRUE)   output 1: the marker
RETURN VERIFYOUT(2 vaultaddr STATE(2) STATE(3) FALSE)     output 2: the money, into the vault
```

Kept state of the deposit (on the next lane coin and on the marker): 0 `R2T4`, 1 keyHash(K0), 2 amount, 3 token,
5 deposit number n, 6 lane. A lane coin is spent once, so each lane is a single chain of deposits:

- `L(lane, 0)` = the lane's genesis coin id (published, fixed);
- deposit n spends `L(lane, n-1)` and creates `L(lane, n) = hash(L(lane, n-1), 0)` and the marker `hash(L(lane, n-1), 1)`.

**A marker is genuine exactly when its coin id equals `hash(L(lane, n-1), 1)`** for the lane and n in its own ports 6
and 5. Any phone computes that from the published genesis ids, n hashes per lane (cached). A coin anyone sends to the
anchor address has a different id and is refused. The money into the vault was enforced when the deposit was made: no
old transaction is read, no server, no Council.

Contention: every deposit spends its lane's coin, so one deposit per lane per block. Eight lanes; the phone picks a free
lane at random and tries another one if its transaction is refused.

The vault, exit request, seal and package contracts are unchanged: an R2T4 deposit's money is an ordinary vault coin,
paid out exactly as today.

### 2. Proofs the phone keeps itself

- The depositing phone tracks its marker (`cointrack`), so its node keeps the marker's proof fresh.
- Each phone keeps a fresh proof (`coinexport`) of every marker behind the coins it holds, refreshed in the background
  every 100 blocks (never in a touch).
- A payment carries, for each deposit in the bundle, that fresh proof (the bundle's existing anchor proof field).
- The receiver checks the marker with its own node; if its node does not see it (older than its window), it imports the
  carried proof with `track:true` and checks again. After crediting, it tracks every marker behind the coins it now holds.
- A phone that no longer holds any coin from a deposit may stop tracking its marker.

### 3. What a receiver checks for an R2T4 deposit

As for R2T3 (13.11): the marker is unspent at the anchor address, holds 1 atom, ports 1 to 3 match the bundle's deposit
record, at least 3 confirmations. Then, instead of reading the deposit transaction: port 6 names a published lane, port 5
is at least 1, and the marker's coin id equals `hash(L(lane, n-1), 1)`. The Council's checker applies the same rule.

### 4. Moving card money over

R2T3 coins stay valid while their deposits are within a node's window. Coin refresh (a Remove and an Add of the same
coin, one "Card refresh" row) now makes R2T4 deposits, and a coin whose history holds an R2T3 deposit is due for refresh
when R2T4 is live. The Add makes only R2T4 deposits from that build on.

### 5. Gate coins for a phone that has never seen them

A depositing phone tracks the gate address. Lanes are spent with every deposit, so a busy lane is always recent. For a
phone installed after a quiet period, the book snapshot that already carries faucet and vault proofs carries the gate's
lane coins too (follow-up).

## Evidence and gates

- Lab: the tracked-coin probe; then a deposit through each lane on mainnet; a forged marker (1 atom sent to the anchor
  address with R2T4 state) refused by a phone and by the Council.
- Unit: marker id derivation against Minima's own `calculateCoinID`; forged, wrong-lane and wrong-number markers refused.
- Phone: an Add, a payment, and a receiving phone that never saw the deposit crediting it from the carried proof.
