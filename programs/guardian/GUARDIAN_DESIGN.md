# The Stables guardian: design (first version, 2026-11-03)

Status: built and tested **offline**, dry run only. Nothing posted, no real seat, no key made for one. Report:
`REPORT_2026-11-03.md`. Spec: section 5 of `The bay/Bay-app/docs/SPEC-SHARED-VAULT-NEXT-2026-11-01.md`.

## What a guardian is for

The Council approves card exits; the guardians make sure a wrong approval, a forged request or a silent Council can
never quietly empty the vault. A guardian is a small program with its own key, on a machine its owner controls, far
from the Council's server. It needs nothing from the Council to do its job.

## What it watches

Only the chain, through its own Minima node (and, if given, a second independent node to compare with):

| What | Where (R2T5) | Read with |
|---|---|---|
| The seal head and its 6 copies: the Council's sealed lists, heartbeat, payable-from block, frozen flag, the 9 guardian keys and their last check-ins | head and copy addresses | `coins address:` |
| Every open exit request | request address | `coins address:` |
| Every stopped (contested) request | contested address | `coins address:` |
| Each request's package, anchors and deposits | as the Council's checker reads them | the checker's own reads |
| The chain tip | | `status` |

The node must follow the R2T5 scripts (`newscript trackall:true`, once). The lab node 9305 already does, which is how
tonight's live dry run read the real seal.

## How it decides

1. **Each request: the package check.** The same check the Council runs (`R2Checker`, the app's own Java verifier):
   the bundle's signatures, the coin's history back to a real deposit, the amount, the token, the payout address.
2. **Found bad:** it checks again 20 blocks later (a node a little behind can mislead once), then **stops** it.
3. **"Not final yet"** (a deposit short of confirmations, the package parts not all mined): it waits.
4. **Cannot check at all** (its node or the checker fails): its owner hears; and if the request could pay within
   720 blocks (10 hours) it is stopped anyway. A wrong stop only delays; a missed one can pay.
5. **Each new Council seal:** it rebuilds the sealed approved and rejected lists from what it saw on chain (the lists
   are a Merkle root of the request ids; tonight it rebuilt the live seal 104 exactly). If the Council approved a
   request the guardian found bad, or the list cannot be rebuilt, the owner is told at once, with a freeze prepared.
   If the Council left out a request the guardian passed, the owner gets a warning (that delays, it moves no money).
6. **The Council silent** for more than two heartbeats: the owner hears (succession opens after 3 days).

## What it can do, and what it leaves to people

| Act | Signatures the chain needs | Who decides |
|---|---|---|
| **Stop** a request (it goes to the contested address) | 1 guardian | The program, on a failed check |
| **Check in** (its seat stays its own) | 1 | The program, every 7 days |
| **Freeze** the vault | 3 | The owner: the program prepares it and says why |
| **Release** a freeze or a stopped request | 5 | People |
| **Succession** (new Council keys) | 6 | People |

**Important about R2T5 (the live card vault):** a stop there blocks only the slow fallback path (a request nobody acted
on for 3 days). The Council can still approve a stopped request. So against a wrong Council approval, the only defence
in R2T5 is a **freeze by 3 guardians before the payable-from block**, and R2T5 guarantees only **72 blocks (1 hour)**
between a seal being mined and its approvals paying (the 144-block window comes with vault-shared). The next generation
fixes both: a stopped request pays only after 5 guardians release it, and the window is 144 blocks.

## Where its key lives, and how it is backed up

The key never leaves a Minima node the owner runs. The program names only the public key and asks its node to sign
(`txnsign publickey:`), as the Council service does.

| Platform | Key | Backup |
|---|---|---|
| Founder's personal Linux server | its own Minima node, RPC on 127.0.0.1 only | the node's 24 words, on paper, offline |
| Founder's Windows PC | its own Minima node (not a lab node shared with tests) | the same |
| The spare phone | the Stables app's built-in node: a key made for the guardian, never a payment key | the app's 24 words |

**One-time signatures.** Minima keys can sign a limited number of times and must never reuse a step. A node restored
from an old copy would reuse steps and leak the key. So the program writes a journal entry before every signature (as
the Council does), and a restore must start the key's count above the journal's figure. Never restore a guardian node
from an old file copy. For the same reason, never put one guardian key on two machines unless they are proven to use
different steps of it (founder 2026-11-09, an operator may run several machines: master reference, "Who operates each role").

## How it stays alive

- **Linux:** a systemd user service (`service/stables-guardian.service`), restarts on failure, alerts if it stops.
- **Windows:** a scheduled task at log-on that restarts on failure (`service/install-windows-task.ps1`). A laptop that
  sleeps checks nothing: set "sleep: never" while plugged in.
- **Android:** a thread inside the built-in node's existing foreground service, while charging on Wi-Fi or always
  (`android/README.md`). The spare stays on its charger, so it can be "always".
- **How often:** every 5 minutes by default, never less than once an hour. In R2T5, with 1 guaranteed hour, every
  5 minutes matters: 3 owners must be reached and sign inside that hour.

## What it logs publicly

Every decision is one JSON line in `data/guardian-log.jsonl`: each check, each verdict, each stop, each seal checked,
each check-in, each alert. Each line carries the hash of the line before it, so a line removed or changed later shows
(`node guardian.mjs verify-log`). It holds only chain facts and verdicts, nothing secret. Proposed: each guardian
publishes its log hourly to a public place of its own (a public git repository or a static page), so no single host
holds all of them.

## How it alerts its owner

Three levels: **urgent** (a bad approval, the program blind, its seat lost), **important** (a stop made, a seal it
cannot rebuild, the Council silent), **warning** (a request it cannot check, a request left out). Each goes to
`data/alerts.jsonl` and to any command the owner sets.

**The channel (founder 2026-11-03): Parlons!, not a company's server.**
- **How it works:** each guardian machine runs its own Parlons account, and the guardian sends through that account's
  local API on `127.0.0.1:9587` (`chat.send`). The message travels over Maxima, through community relays, end to end
  encrypted, and a relay holds it while the owner's phone is offline. The founder reads alerts in Parlons! like any
  other chat.
- **Status:** not built (see the report).
- **A second channel on another network** (SimpleX) is kept as an option, so an attack on the Minima network cannot
  silence the alarm.
- **Telegram** stays optional only.
- **Not StablesAgent:** it runs on the Council's server, and a guardian must not depend on it.

## Sharing the head with the Council

A check-in spends the seal head and all 6 copies, which the Council's seals also need. The program checks in only
right after a Council seal (never in the last 30 blocks before the next heartbeat), not again inside 72 blocks, and only
when all 6 copies are free. A stop takes one copy and leaves the others to payouts.

## When vault-shared replaces R2T5

The program reads its numbers from the generation file, so most of it carries over. What changes:
- **The stop becomes the main defence** (C3): a stopped request pays only after 5 guardians sign its payout. Failing
  closed then matters more, and so does a second node.
- **The ring of seals** (C1): each slot's root (ports 120 on) and sealed-at (130 on) is rebuilt, not only port 20.
- **Pending key and limit changes** (C4, C5, ports 54 to 57): checked against the Council's public decision; a mismatch
  is a cancel the owner signs (3 guardians).
- **5 copies**, a 144-block guaranteed window, and the two flags decided 2026-11-03 for real money
  (`successionToBackup`, `guardianSwapPublic`): a scheduled succession or guardian swap is always reported to the owner,
  and a guardian named in an election only has to check in to void it.
- The checker's generation tag and addresses come from the new generation file.

## R2T6, built (2026-11-05, R2T6_PLAN step 6)

`guardian-r2t6.mjs`, loaded when `generation` names an R2T6 file (`simcard/evidence/R2T6-DEPLOY-01/generation.json`).
Dry run as before; tests `test/r2t6.mjs` (18 of 18) and `simcard/route2/r2t6/test/r2t6-tx.test.mjs` (the shapes
through the deployed scripts, 99 of 99).
- **Stop:** the request script's guardian path (one signature, 51 = 0). A contested coin is never stopped again.
- **A Council approval it did not pass is stopped at once**, bad or unchecked alike (from the approved list it rebuilt
  for that seal, kept per ring slot): the stop holds it until 5 guardians release it.
- **Release and overrule:** a contested coin it passes gets its payout prepared, path 1 (a ring slot the Council
  approved it in, sealed after the stop) or path 2 (3 days after it became contested), checked with five guardian keys
  named, in `release-prepared-<id>.json`, with the block from which the Council's final rejection is possible. The
  owner hears; urgent in the last day. `guardian.mjs sign-release <file> --post`: each guardian in turn signs it only
  when it is exactly the payout it builds itself (`sameRelease`), writes `release-<id>-<n>of5.json` for the next, and the
  fifth posts it. The files go from owner to owner by hand (no secret in them).
- **Paid-coin lists (card review F5):** followed from the record coins (port 11 names each new key), taken from a
  published `exit-lists.json` (`r2t6.listSources` in the config: the approvers', other guardians') only when it
  rebuilds the chain's root, published with the log.
- **Fallback (register row 36):** a request it passes that nobody paid or refused for 3 days is paid by request path 2,
  unsigned, while the Council's heartbeat is under a day old and the vault is not frozen; one per shard per pass.
- **Not yet:** the R2Checker does not know R2T6 (step 7), so today every R2T6 request would be "unchecked" and,
  approved by the Council, stopped (the checker with R2T6, 84055e4e, is built into the box image and runs on the
  approvers' machines); the freeze is MAST branch act 2 in R2T6 (prepared as a spec, not checked offline).
- **Live dry run (2026-11-05):** `test/live-dry-run-r2t6.config.json` against lab node 9305 read seal 7 and followed the
  paid-coin list of the first R2T6 payout from the chain (Winiwa shard 1). A seal can approve a request paid before
  the guardian's next pass, so requests it saw close since a seal's heartbeat stay candidates for that seal. The box
  image carries R2T6 (built as `stables-guardian-r2t6build`, R2T6 tests 18 of 18 inside); the running box stays R2T5
  until the owner switches its config.

## R2T6 rehearsal (2026-11-05 and 06, R2T6_PLAN step 8)

Lab seats 0 to 4 on lab node 9205 (`test/lab-r2t6-seat*.config.json`), the lab guardian WOTS journal, test tokens.
- **Commands by hand:** `stop <request> --post` (any open request, whatever the check said), `sign-release <file>
  --post` (one seat's turn on a prepared release or overrule), `fallback <request> --post` (R2T6 request path 2,
  unsigned, refused before its 3 days).
- **A stop:** a 5 Winiwa Remove from the spare, stopped by seat 0 (2026-11-06 08:5x UTC). The first try was built on a
  copy a seal replaced at the same moment; the node's check refused it and nothing was posted (the program now says
  "not posted" in that case). The approvers then rejected the stopped coin: the checker read its seal-copy ports 30
  and 31 as an inline package (fixed, ff58e8f0; the phone had the same rule, fixed in app 089). After the fix, seal 15
  approved it; seats 0 to 4 release it once that slot pays.
- **A refusal** (a lab request with no package): refused into a contested coin within 2 minutes; the second guardian
  box found it bad on its own.
- **To come:** a fallback (a Remove the proposer leaves undecided, `R2T6_IGNORE`), from block 2,410,539.

## What the Bridge's guardians need on top (Ethereum)

Design only; no Ethereum code here. The Bridge session already has its guardian (`The bay/Bridge/p4/guardian/`), and
this program uses the same Minima transaction shapes, so they can become one program with two modules.
- **Reads:** two independent Ethereum providers, compared (finding 8 of the Bridge review), plus two Minima nodes.
- **Checks:** each Minima release request against a pending Ethereum deposit; each Ethereum release against ETHx
  returned on Minima; refunds against the proven exit and cancelled lists.
- **Acts:** an Ethereum `stop` signed by a dedicated guardian address holding only a little ETH for gas (its key in a
  hardware wallet or the guardian machine's own keystore); Minima stops as here.
- **Alerts:** the same three levels, plus the guardian's gas balance running low.
