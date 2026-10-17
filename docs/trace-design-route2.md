# Stables card byte formats and checks (Route 2)

This is section 13 of the Stables card design ("trace design"), published with the evidence. It fixes the formats every phone and the council use. The generation in the evidence is **R2T3**: the same formats as R2T2 below, with the anchor tag `0x52325433`, its own anchor, vault and request addresses, the council on a server, and payouts that may spend up to eight vault coins at once. The section's history notes refer to internal test runs and builds of the app.

## Coins held by one-use TEE keys

### 13.1 What changes

| Card (sections 2 to 7) | Route 2 |
|---|---|
| A piece belongs to a card; the card's long-lived key signs | A **coin** is `(amount, public key, trace)`. Whoever can sign with the coin's one-use TEE key owns it |
| Anchor: a load into card C's account, counter `k` | Anchor: a deposit coin at the `R2T1` test vault whose kept state names the first coin key `K0` |
| Receiver binding: ticket nonce `m` | Receiver binding: a fresh attested one-use key `Kr`, created by the receiver for this payment |
| Hop signed by the payer card | Hop signed once by **each spent coin's own key**; the TEE then destroys that key |
| Signer must be a registered card | Signer's key must carry a valid key attestation (13.6) |
| Double spend needs a tampered card | Double spend needs a broken TEE or a restored key file (untested, needs root, shows as unlocked boot); detection kept anyway |

The coin store, seen set and hop journal live in the Android app. Web and MiniDapp verify and receive only; they hold no coins (Android-only holding, founder 2026-10-11).

### 13.2 Encoding rules

- All integers are unsigned big-endian: `u8`, `u16`, `u64`.
- Public keys are uncompressed SEC1 P-256 points, 65 bytes (`0x04 || X || Y`).
- `keyHash(K) = SHA-256(K)` over those 65 bytes.
- Amounts are `u64` **atoms**: 1 atom = 10^-8 of the token (Winiwa and xWiniwa have 8 decimals). Zero is never a valid coin amount.
- Token ids are 32 bytes. Native Minima (`0x00`) is never a coin token.
- Signatures are ECDSA P-256 over SHA-256 of the signed bytes, DER encoded as the Android keystore returns them (70 to 72 bytes).
- Identities are computed over unsigned bytes only, so a re-encoded signature never changes a coin id.

### 13.3 Anchor (on chain)

A deposit is a coin sent to the `R2T1` vault address with these kept-state ports:

| Port | Value |
|---|---|
| 0 | `0x52325431` (`R2T1`, generation tag) |
| 1 | `keyHash(K0)`, 32 bytes hex |
| 2 | amount in token units, equal to the coin's token amount |
| 3 | token id, equal to the coin's token |

Root coin id: `SHA-256("STR2A" || 0x01 || anchorCoinId)`, where `anchorCoinId` is the Minima coin id of the deposit. The root coin is `(amount, K0)`.

A receiver checks an anchor with its own node: the coin exists unspent at the vault address, token and amount match ports 2 and 3 and the bundle's anchor record, port 0 is the generation tag, port 1 is `keyHash(K0)`, and it has at least the confirmation depth (default 3). If the node does not see it, the payer may carry the coin's export proof; the receiver imports it into its own node (visibility only) and checks again. A coin that is spent (rescued, later exited) or unknown is refused. Stage 1 has no register; register proofs (section 3, path 1) arrive with Stage 3.

### 13.4 Hop line

Signed body:

```
"STR2H" | ver=0x01 | token(32) | n u8 (1..4) | parent[1..n] (32 each)
        | recvPub(65) | recvAmount u64
        | hasChange u8 (0|1) | [changePub(65) | changeAmount u64]
```

- Parents are distinct, same token, and `sum(parents) = recvAmount + changeAmount` (change 0 when absent).
- `recvAmount > 0`; `changeAmount > 0` when present; `recvPub != changePub`; neither equals a parent key.
- One signature per parent, in parent order, each by that parent's owner key.
- Child ids: received coin `SHA-256(body || 0x01)`, change coin `SHA-256(body || 0x02)`.

Wire record: `bodyLen u16 | body | n × (sigLen u8 | sigDER)`.

Size: one parent with change is 218 bytes of body plus one signature of about 72 bytes, about 295 bytes on the wire. Four parents: 314 bytes of body plus four signatures, about 610 bytes.

### 13.5 Bundle (what a payment carries)

```
"STR2B" | ver=0x01
nChains u8   { nCerts u8 { certLen u16 | certDER } }      certificates above the leaf, leaf issuer first, root last
nKeys  u16   { chainIndex u8 | leafLen u16 | leafDER }    one per key that signs a hop in this bundle
nAnchors u8  { anchorCoinId(32) | token(32) | amount u64 | K0(65) | proofLen u16 | coinExport }
nHops  u16   { hop wire record }                          topological order: every parent before its use
```

- The key of a leaf certificate is read from its SubjectPublicKeyInfo; `keyHash` is computed, never sent.
- A phone's chain is shared by all its keys, so a bundle carries each phone's chain once. A receiver may cache chains it has verified, by `chainId = SHA-256` of the chain's encoded certificates.
- A payment bundle holds exactly the ancestry of the coins it spends plus the new hop. The paid coin is the new hop's received coin.
- The receiver's own key `Kr` needs no attestation in this bundle: it is the receiver's. It is attested when the receiver later spends it.
- Stage 1 hard limits: bundle at most 64 KB, 64 hops, 16 anchors, 128 keys, 8 chains. A trace deeper than 10 hops (section 9 default) is accepted and marks the coin for re-anchoring once that exists (Stage 3).

Size estimate: a phone's chain is about 2 to 3 KB, a leaf about 0.7 to 1 KB. A coin two hops from its anchor, between two phones: two chains, three leaves and two hops, about 8 to 9 KB. Measured sizes go in PROGRESS.md.

### 13.6 Key attestation rules

A key is accepted only if its leaf certificate and chain satisfy all of:

1. Every certificate is signed by the next; the last is, or is signed by, a pinned Google attestation root (compared by SubjectPublicKeyInfo SHA-256). Validity dates are not enforced: coins must stay checkable for their whole life, and attestation intermediates are short-lived. Serials on a cached copy of Google's attestation status list are refused when a copy is present.
2. The KeyDescription extension (OID 1.3.6.1.4.1.11129.2.1.17): attestation security level and KeyMint security level are equal and not Software.
3. In `hardwareEnforced`: purpose includes SIGN; algorithm EC; curve P-256; **usage count limit 1**; **origin GENERATED** (not imported); **root of trust** with device locked, and verified boot state Verified, or SelfSigned with a verified-boot key on the explicit allowlist (GrapheneOS, published key hash per device model).
4. A usage count limit only in `softwareEnforced` is refused (this is how StrongBox appears on the Pixel 7 Pro, `ROUTE2-KEYSTORE-01`).

The attestation challenge is `SHA-256("STR2-coin-key-v1" || 16 random bytes)`; receivers do not rely on it. The application id (tag 709) is recorded, not enforced.

Coin keys are always generated in the TEE (`setIsStrongBoxBacked(false)`, `setMaxUsageCount(1)`), never imported. A key may also require a strong biometric for its one use (hardware-enforced, `ROUTE2-KEYSTORE-02`); Stage 1 creates keys without it and keeps it as a per-key option for the PIN thresholds.

### 13.7 Request and acknowledgement

Request, receiver to payer (127 bytes, fits a QR):

```
"STR2Q" | ver=0x01 | token(32) | amount u64 | recvPub(65) | requestNonce(16)
```

The receiver creates `Kr` and stores the request before showing it. Acknowledgement, receiver to payer, optional: `"STR2K" | ver=0x01 | receivedCoinId(32)`. The payer keeps the signed hop until acknowledged and can deliver it again; delivery is idempotent.

### 13.8 What the receiver checks (replaces section 6 for Route 2)

Before crediting, in order, refusing with nothing stored on the first failure:

1. Parse within the limits of 13.5.
2. Every chain and every key against 13.6.
3. Every anchor against 13.3.
4. Every hop in order: each parent is a root coin of an anchor or a child of an earlier hop; token and amounts conserve; each signature verifies with the parent's owner key; that key has an accepted attestation.
5. The new hop's received coin is owned by one of the receiver's own outstanding request keys, with the requested token and amount; that key has not been credited before.
6. **Seen set:** no parent is spent by two different hop bodies, inside the bundle or against hops the receiver has already seen. A conflict is refused and both hops are kept as a double-spend proof (section 7: same parent, two different bodies, both signed by its key).
7. Commit atomically: the coin with its bundle, the request marked used, every hop body hash added to the seen set. Then acknowledge.

### 13.9 Paying, and crash safety

1. Choose parents (smallest first, at most 4), create a fresh TEE key for change if needed, fix the hop body, and commit an intent `{body, parents}` durably. Parents become `spending`.
2. Sign with each parent's key in turn and commit each signature durably at once. The TEE destroys each key at its signature.
3. When all signatures are stored, the hop is final: parents `spent`, change coin `held` with its bundle, outgoing payment `undelivered` until acknowledged.

After a restart, an intent whose parent key still exists continues at step 2 with the same body. A parent whose key is gone with no stored signature means the process died between the signature and its commit: that coin is lost (never duplicated) and shown as such. The window is one signature, about 17 ms (`ROUTE2-KEYSTORE-02`), plus the commit.

### 13.9a Changes after the first two-phone campaign (R2-CAMPAIGN-04, build .100)

- **Open amount.** A request with amount 0 accepts any amount: the payer chooses it, and a load into it takes the deposit's amount. Every receive code on a coin phone carries a request, so a code without an amount can still be paid with coins.
- **Chain references.** In a bundle, a chain entry with certificate count 0 is followed by the chain's 32-byte id instead of its certificates. The receiver resolves it from chains it already holds (its own keys' and every chain of a bundle it accepted, at most 16) and refuses an id it does not hold (`chain-unknown`). A receive code lists up to four held chain ids on a `Coin chains:` line; the payer leaves those out. Each phone's chain is about 2.6 KB, so a repeat payment between two phones drops to roughly a third. Stored bundles always carry every chain, so a coin can be paid onward to a phone that knows nothing.
- **NFC.** Payment blocks of 250 bytes, or up to 4 KB in extended-length APDUs when the reader link allows them and the receiver's SELECT answer sets flag bit 1. The founder's contact budget (payer page 600 ms plus receiver answer 600 ms) is unchanged.
- **Receiver speed.** An anchor seen unspent and deep enough is remembered for five minutes, the tip for twenty seconds: through Minima Core each node read costs about 0.5 s.
- **Coins only.** On a phone that holds coins, the old card money is set aside (founder 2026-10-11): the card shows coins, every payment is paid with coins, and an old-style payment is refused.

### 13.11 Stage 2 (R2T2): separated anchors and the exit line

Added 2026-10-11 night, before coding (STAGE2_PLAN.md sections 2a and 5; contracts in COUNCIL_ATTESTATION_DESIGN.md 6c).

**Deposit (Add) in R2T2.** One transaction with, among its outputs:

- exactly one **anchor coin** at the R2T2 anchor address, holding 1 atom of the deposit's token, kept state ports 0 = `0x52325432` (`R2T2`), 1 = keyHash(K0), 2 = amount, 3 = token;
- the **value**: an output at the R2T2 vault address with token = port 3 and token amount = port 2 (it may keep state: the phone's single `send multi` keeps state on every output, and nothing reads a vault coin's state).

The anchor coin is never spent (lab rescue only, test). Payouts spend value coins only, so every other coin of a deposit stays valid after an exit.

**What a receiver checks for an R2T2 anchor** (in addition to 13.3 with the R2T2 tag and the anchor address in place of the vault): the anchor's **creating transaction** proves the money went in. It must have exactly one output at the anchor address (this coin), an output at the vault address with the anchor's token and amount, and no input from the vault or anchor address (so a payout cannot mint an anchor out of its own remainder). The receiver finds that transaction once with `txpow address:<anchor address>` (all deposits in one read) or `txpow block:<created>`, both inside the node's unpruned window, and remembers the verdict per anchor coin id. An anchor whose deposit is not proven is refused (`anchor-deposit`). Older anchors than the unpruned window cannot be proven this way; that is the known pruning-window limit (the register, Stage 3).

R2T1 anchors stay valid as before: coin unspent at the R2T1 vault, amount equal to port 2.

**Exit line** (the request to take a coin back to Savings), signed once by the coin's own key, which the TEE then destroys:

```
"STR2E" | ver=0x01 | coinId(32) | token(32) | amount u64 | payoutAddress(32) | requestNonce(16)
```

126 bytes. One coin per exit: a smaller or combined amount is first a self-hop (pay to the phone's own fresh key, with change), then that coin exits. Wire: `bodyLen u16 | body | sigLen u8 | sigDER`.

**Exit package**: `"STR2P" | ver=0x01 | exitWire (var16) | bundle (the coin's full bundle, every chain carried)`. Its SHA-256 is request port 10; the bytes ride in request ports 30 to 39.

**What the council checks** (council design 3.1 step 2): the bundle by 13.8 steps 1 to 4 and 6; the exited coin is a coin of the bundle that no hop in it spends; the exit line is signed by that coin's key, which has an accepted attestation; token and amount equal the coin's; the request's ports 11 to 14 equal the exit line (coin id, amount, token, payout address); port 10 is the package hash; no earlier exit of this coin (the council's seen set); the weekly limit of the payout address.

### 13.12 R2T4: deposits through the gate (17 October 2026)

Replaces the register planned for old deposits (13.3, 13.11). Design and reasoning: `DEPOSIT_PROOF_DESIGN.md`.

**Deposit (Add) in R2T4.** One transaction whose **first input** is a lane coin of the deposit gate
(`0x084B1E939F497E46EA5107D3B29CB82E8E547FED26EDE45984FC3890352B7CC3`). The gate's script requires: output 0 the next
lane coin (same amount and token, kept state), output 1 the marker at the R2T3 anchor address (1 atom of the token in
port 3, kept state), output 2 the amount of port 2 in that token at the R2T3 vault (no kept state), port 0 `0x52325434`,
port 2 above 0, port 5 one above the spent lane coin's port 5, port 6 equal to it. Port 1 is keyHash(K0) as before.

**Lanes.** Eight genesis coins, port 5 = 0 and port 6 = the lane (README, Contracts and addresses). Minima's coin id of
output i is `hash(first input coin id, i)`, so `L(lane, 0)` is the genesis id, `L(lane, n) = hash(L(lane, n-1), 0)`, and
the marker of deposit n is `hash(L(lane, n-1), 1)`.

**What a receiver checks for an R2T4 anchor**: 13.3 with the R2T4 tag at the R2T3 anchor address, then that port 6 names a
published lane, port 5 is between 1 and 10,000,000, and the marker's coin id equals `hash(L(lane, n-1), 1)`. No deposit
transaction is read. If its node does not see the marker, it imports the bundle's anchor proof with `track:true`.

**Proofs.** The holder's node tracks every R2T4 marker behind its coins (`cointrack`, or the import above) and exports a
fresh proof every 100 blocks; payments, exits and refunds carry the freshest export in the anchor record's proof field.
