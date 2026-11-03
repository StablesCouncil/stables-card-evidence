# Guardian mode in the Stables app: design and skeleton

Status 2026-11-03: design and skeleton only (`GuardianMode.java` here, not in the app tree, not compiled, no APK).

## Where it plugs in

| Step | Reuses | New |
|---|---|---|
| Keep running | The built-in node's foreground service (`MinimaService`, already `startForeground`) | One daemon thread started after `NodeBoot.isStartUpComplete()`; no second service or notification |
| When | `R2Engine.charging()` and `R2Engine.unmetered()`, as "Help other phones" (0.0.14.081) | A setting: guardian mode off by default; "only while charging on Wi-Fi" or "always" (for a phone that lives on its charger) |
| Read the chain | `R2Engine.commands(context, INTERNAL, null)` (30 s per read, `internalRead`) | The guardian reads `status` and `coins address:` of the head, copies, request and contested addresses |
| Package check | The app's own `R2Receiver`, `R2Attestation`, `R2Anchors` (what `R2Checker` wraps for the Council) | Lift `R2Checker.main`'s body into one method in `route2/`, so the Council, the PC guardian and the phone run one code path |
| Decide | | `GuardianRules.java`, a line-for-line copy of `guardian-core.mjs`, checked against the same fixtures |
| Act | The built-in node's `txncreate`, `txnbasics`, `txnsign publickey:`, `txncheck`, `txnpost` | The guardian's own key, made in the built-in node (`keys action:new`), never one of the person's payment keys; a write-ahead WOTS journal in `getNoBackupFilesDir()` |
| Log and alert | `StablesLog`, the existing notification channel, an Activity row | The public log file, shareable from the card's page |
| Page | The card's settings page ("Help other phones" sits there) | A "Guardian" section: seat, last check-in, last pass, alerts, the log |

**Built-in node only, in this version.** Through a node app (MinimaCore, BlackBear, PandaBear), Stables holds no key it
controls, and `CommandPolicy` keeps signing commands out on purpose. A guardian whose key sits in a node app would
widen that policy; not proposed.

## Battery (estimated, not measured)

- **A pass with nothing open:** 5 node reads and a small hash; well under a second of CPU, every 5 minutes. Next to
  the built-in node itself (always running when the app is on the built-in node), this is noise.
- **A new request:** one package check, the same work a receiver does in a tap (tens of milliseconds to a few seconds,
  with the anchor reads).
- **A check-in, once a week:** a 25 KB transaction (head and 6 copies, one signature) and its proof of work. A phone
  mines its own TxPoW more slowly than a server (seen 2026-11-02 with the proof answers); seconds to a minute of CPU.
- **A stop:** about 10 KB, rare.
- **Charging-only means not always on.** A guardian must check at least once an hour, and in R2T5 the guaranteed time
  between a seal being mined and its approvals paying is only 72 blocks (1 hour). A phone that is off its charger for
  the day is not a guardian for that day. That is why the first phone guardian is the spare, which stays plugged in,
  with "always".

## What it takes to build

1. `GuardianRules.java` and its JVM test over `test/fixtures` (no phone).
2. The checker method shared with `R2Checker`.
3. The thread, the setting, the page section; a release build; logcat `[STABLES-GUARDIAN]` on the spare, in dry run.
4. Posting only after the founder's go, with a seat the founder assigns.
