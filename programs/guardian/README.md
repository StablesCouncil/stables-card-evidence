# The guardian program

A guardian is two things: a **key** in one of the vault's nine seats, and this **program**, installed on the guardian's
own machine next to its own Minima node, which watches the vault and signs with that key. What guardians are and the
rules they follow: [GUARDIANS.md](../../docs/GUARDIANS.md).

| File | What |
|---|---|
| `guardian.mjs` | The program: `watch [--once]`, `status`, `verify-log`. Read only unless `--post` and `"allowPost": true` are both set |
| `guardian-core.mjs` | The rules and the shapes of its transactions (stop, check-in, freeze), as pure functions |
| `wots-guard.mjs` | Signs only through a journal that counts each one-time key's uses |
| `publish-log.mjs` | Every hour: the public log and a `status.json` to the guardian's own git repository (off by default) |
| `alert-parlons.mjs` | Alerts to the owner as chats in Parlons!, over Minima's Maxima network, with no central chat server |
| `offline.mjs` | Minima's own checks, offline: dry runs of the vault scripts and real signature checks |
| `guardian.config.example.json` | Copy to `guardian.config.json` |
| `GUARDIAN_DESIGN.md` | The design |
| `box/` | The guardian box: Docker Compose with its own Minima node, the guardian and a Parlons account |
| `service/` | A systemd unit and a Windows scheduled task |
| `android/` | Guardian mode in the Stables app: design and skeleton, not compiled |
| `test/` | The tests (`node test/run-all.mjs`) and a fixture read from mainnet |

What it does on each pass (every 5 minutes):

- re-checks every open exit request with the same verifier as the approvers
  ([`../approvers/checker/R2Checker.java`](../approvers/checker/R2Checker.java)). A request found bad is checked again 20 blocks later before it is stopped;
- rebuilds every seal's approved and refused lists from the chain and compares them with its own verdicts. A seal that
  approves a request it found bad raises an urgent alert with a freeze prepared; a seal that refuses a request it found
  good raises an urgent alert too;
- checks in on chain every 7 days;
- writes each decision to a hash-chained log (an edited or removed line shows), and publishes it hourly to its own
  repository, which the [Card Guardians page](https://stablescouncil.org/guardians.html) reads.

Freezes, releases and replacing the approvers are prepared for the owner to sign, not signed alone.

Needs Node.js 20+, JDK 17 and Minima's `minima.jar`. The tests run inside the Stables lab repository (they read the
deployed generation file and the compiled verifier from there); a standalone build is next.

**Status (3 November 2026):** passes its tests offline (65 of 65). Its first real transaction, a check-in for seat 1,
was mined in block 2,400,643. It does not yet run continuously, and all nine seat keys are still the Stables lab's.
