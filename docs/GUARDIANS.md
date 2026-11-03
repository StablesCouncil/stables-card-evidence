# The Stables card's guardians

**Status, stated plainly (3 November 2026).** The card runs on Minima mainnet with **valueless test tokens** (Winiwa,
xWiniwa). The guardian rules are part of the deployed vault generation **R2T5** and have been exercised on mainnet. All
nine guardian keys are still held by the Stables lab. A first guardian program exists and passes its tests offline; no
guardian program runs continuously yet. Nothing here has had an external audit.

Live page: [stablescouncil.org/guardians.html](https://stablescouncil.org/guardians.html). Card figures:
[stablescouncil.org/test-dashboard.html#card](https://stablescouncil.org/test-dashboard.html#card). The code:
[`programs/`](../programs/). What must change before real money: [SECURITY_PLAN.md](SECURITY_PLAN.md).

## Contents

1. [What a guardian is](#what-a-guardian-is)
2. [The rules](#the-rules)
3. [The nine seats](#the-nine-seats)
4. [The guardian program](#the-guardian-program)
5. [What has been proven](#what-has-been-proven)
6. [What does not work yet](#what-does-not-work-yet)
7. [Decisions taken](#decisions-taken)
8. [Before any real money](#before-any-real-money)
9. [Check it yourself](#check-it-yourself)
10. [Questions we want feedback on](#questions-we-want-feedback-on)

## What a guardian is

Two separate groups look after the card's vault:

- **The approvers:** 11 keys, of which 7 must sign (a "seal") before money goes back from a card to Savings. Today they
  run on one server held by the Stables lab. Older documents, the contracts and the code call them "the Council"; the
  word Council is now kept for decisions taken by the Stables community.
- **The guardians:** 9 seats, each a program run by a different person with their own key, that watch the approvers.

The approvers are not needed for the money to come back:

- **Paying needs no one.** Card money moves from phone to phone by touch, offline, with no server.
- **If the approvers do not answer, your money still comes back.** An exit request they neither approve nor refuse
  pays itself after 3 days with no approver key (the fallback), as long as the approvers' heartbeat is fresh.
- **If the approvers disappear, nobody can steal through their absence.** If their heartbeat stops, the fallback pauses
  instead of opening, so nobody can slip a false request through. After 3 days of silence, 6 guardians install new
  approvers, and payouts resume.
- **Known limit, fix designed:** if the approvers explicitly refuse a valid request, the request is destroyed and the
  card coin, already signed over to the exit, cannot be spent or requested again: that money stays locked in the vault.
  On 13 October 2026 the approvers wrongly refused a 166.1 Winiwa exit and the lab paid it back by hand, as it will for
  any wrongful refusal until the fix. The fix, for the next vault: a refusal leaves a "refused request" that 5 of the 9
  guardians can overrule, sending it to the 3-day fallback with its usual wait and caps.

Approvers can also be wrong, hacked or captured. Guardians are the check on them.

A guardian is a small program, run by one person with their own key, next to its own Minima node. It:

- re-checks every exit request with the same package check the approvers use (every signature on the coin's path, and
  the hardware certificates behind every key);
- rebuilds every seal's lists of approved and rejected requests from the chain, and compares them with what it
  found itself;
- stops a request it finds wrong, and tells its owner when a person needs to act;
- checks in on chain regularly, to show it is alive;
- writes every decision to a log it publishes.

**A guardian can never pay anyone.** It can only stop, freeze, release and, together with others, replace the approvers.
The worst a dishonest guardian can do is delay.

## The rules

These are enforced by the vault's own script on chain, not by any server. Details:
[R2T5 design](R2T5_DESIGN.md) and the repository's [README](../README.md#if-the-council-disappears).

| Action | Who | Effect |
|---|---|---|
| Stop | **Any 1** guardian | The request becomes contested. The approvers can still approve or reject it; the fallback reopens only after 5 guardians release it. |
| Freeze | **3** guardians | All payouts stop. The approvers cannot lift a freeze. |
| Release | **5** guardians | A freeze is lifted, or a contested request released. |
| New approvers | **6** guardians | Only after 3 days of silence from the approvers or 7 days frozen. The new approvers start with empty lists and still faces the delay, the caps and a freeze by any 3 others. |
| Check-in | Each guardian | Shows the seat is alive. A seat counts as active for 30 days after a check-in. |
| Election | A candidate, plus more than half of the active guardians (at least 3) | Only for a seat whose guardian has not checked in for 60 days. A candidate cannot hold two seats. |

An approved payout waits **144 blocks (about 2 hours)** after its seal before it can be paid. That is the window in
which guardians act.

## The nine seats

Each seat has a name, so people can follow a guardian over time. "Active" means checked in within 30 days.

| Seat | Name | Tagline | Key held by | Guardian program | Last check-in |
|---|---|---|---|---|---|
| 0 | Farrier | Checks every shoe | Stables lab | none yet | 24 Oct 2026 |
| 1 | Bridle | Holds the reins | Stables lab | none yet | 3 Nov 2026 |
| 2 | Paddock | Fenced ground | Stables lab | none yet | 18 Oct 2026 |
| 3 | Halter | Leads, never rides | Stables lab | none yet | 18 Oct 2026 |
| 4 | Stirrup | Steady footing | Stables lab | none yet | 18 Oct 2026 |
| 5 | Tackroom | Everything in its place | Stables lab | none yet | 18 Oct 2026 |
| 6 | Lantern | Night watch | Stables lab | planned: a phone | 18 Oct 2026 |
| 7 | Hayloft | The high view | Stables lab | planned: a personal computer | 18 Oct 2026 |
| 8 | Gatepost | Stands at the gate | Stables lab | planned: a separate server | 18 Oct 2026 |

Check-in dates as read from mainnet on 3 November 2026. Seats 2 to 8 become open to election from about 17 December
2026 unless they check in again.

**Who runs the first guardians.** Lantern, Hayloft and Gatepost will be run by the project's founder, on a phone, a
personal computer and a personal server, none of them the approvers' server. That separates the guardians from the
approvers' machine, not yet from the people behind Stables. Independence comes when other people take seats.

## The guardian program

A first version was written on 3 November 2026, for personal computers and servers (Node.js), with a design for a
guardian mode inside the Stables Android app.

- **Read only by default.** It builds and checks every transaction, and never posts unless two separate switches are
  set on purpose.
- **Its own node.** It reads a Minima node on the same machine, never the approvers' server.
- **A pass every 5 minutes.** A request found bad is checked again 20 blocks later before it is stopped. A request it
  cannot check goes to its owner, and is stopped once it could pay within 10 hours.
- **Check-in every 7 days.** It never checks in during the 30 blocks before an approvers' heartbeat seal, so it does not
  get in their way.
- **Freeze, release and succession are prepared for the owner, not signed alone,** because people decide those.
- **A tamper-evident log.** Each line carries the hash of the line before, so an edited line is found.
- **Alerts** to its owner over Parlons!, an open-source messenger on Minima's Maxima network, with no central chat
  server.

The code of the guardian program and of the approvers' program is published in [`programs/`](../programs/).

## What has been proven

All with test keys in the program's own offline copy of Minima's transaction checker, against the deployed R2T5
scripts, plus one read-only pass on mainnet. Result: **65 of 65 tests pass** (3 November 2026), among them:

- **Its transactions, with real signatures (13 of 13).** A stop signed by a seated guardian is accepted. It is refused
  when signed by a key with no seat, when it sends the request elsewhere, when it is changed after signing, or when it
  reuses a signature from another transaction. A check-in is accepted, and refused when signed by a stranger, when one
  seat writes another's check-in, or when it is too old. A freeze is accepted with 3 guardians and refused with 2.
- **Its decisions (29 of 29).** A good request is left alone; a bad one is stopped only after a second bad verdict; a
  seal that approves a bad request raises an urgent alert with a freeze prepared; a blind node, a lost seat or two nodes
  that disagree raise alerts; in read-only mode the node receives only read commands.
- **One real pass on mainnet, read only** (2 November 2026, block 2,399,448). It read the live seal 104 and rebuilt its
  approved and rejected lists exactly from the chain. Anyone can check a seal without the approvers' server.

The guardian rules themselves were exercised on mainnet at deployment, with the transactions linked in
[Check it yourself](#check-it-yourself).

## What does not work yet

1. The package check has not yet run inside the program on a real open exit request (none was open). The check itself
   is the approvers' own code.
2. Posting has run once: one real check-in for seat 1 on 3 November 2026 (block 2,400,643), signed through the
   journal that counts each one-time key use. Stops and freezes have not been posted by the program.
3. No independent person holds a seat; all nine keys are the lab's.
4. The program can publish its log to its own repository, but no guardian publishes yet.
5. Alerts are written, not yet tested live.
6. Guardians do not yet keep their own copy of the exit list (the paid coins behind each exit record). The approvers' server
   publishes it today.
7. The Android guardian mode is a design only.

## Decisions taken

- **No central point.** The approvers' server must never be needed for safety. Guardians use their own nodes, publish
  their own logs, and send alerts without a company's server.
- **The first three guardians** run away from the approvers' server: on a phone, a personal computer and a personal
  server.
- **Seats.** The three keys will be elected into seats 6, 7 and 8 once those seats open (a rehearsal of an election on
  mainnet, at no cost), and set in place from the start in the next vault.
- **Check-in every 7 days**, far inside the 60-day limit.
- **Logs.** Each guardian publishes its own log every hour to its own public repository, so no single host holds them
  all.
- **Freezes stay a human decision** in R2T5. For the next vault, one narrow automatic case is under study: a seal that
  provably approves a request the guardian found bad.
- **The phone guardian** runs always, not only while charging.

## Before any real money

The full list, with the order and the gates, is in [SECURITY_PLAN.md](SECURITY_PLAN.md). In short: in production the
approvers and every guardian run on independent machines held by different people, so that no one reaches 7 approver
keys or 6 guardian seats. Two rules from the next vault design go on for the card before any real money, and as early
as possible:

- **Handover to backup approvers.** Guardians can only announce a handover to backup approvers fixed at the start;
  anyone carries it out after a 7-day public wait, and working approvers or a guardian release cancel it. Six captured
  guardians could no longer install approvers of their own.
- **Public guardian swap.** Replacing a silent guardian is announced, waits 7 days in public and needs a majority of
  all nine seats; the current holder voids it just by checking in.

The next vault also gives guardians more time: payouts wait 216 blocks (about 3 hours), with at least 144 blocks
guaranteed to guardians.

## Check it yourself

- Seal head (approver keys, guardian seats, heartbeat):
  `0xD6462FFC684A99C146D0FFE4D1681FF61BD7DB99122ECBDD64E7F702AF425561`. The nine guardian public keys and every
  deployment step are in [`evidence/r2t5/`](../evidence/r2t5/).
- One guardian stops a request: block 2,371,923
  [`0x00007AE3…AEC77DE2`](https://explorer.minima.global/transactions/0x00007AE3473F52CEA992207C514CEF1DC7AC7DAC48658CE0D89EE158AEC77DE2).
  Five release it: block 2,371,929
  [`0x00006194…DD430674`](https://explorer.minima.global/transactions/0x00006194CE78B6A6A34F47919B643AFC6BE204D7D4D7FB3EF3C27FD5DD430674).
- Three guardians freeze everything: block 2,371,934
  [`0x000085E8…7DAF1DE6`](https://explorer.minima.global/transactions/0x000085E8DACFB06A99E947ED996CA2B3AF405DCBB4E2F43F32051DEB7DAF1DE6).
  Five release: block 2,372,055
  [`0x000052B8…D908A5F1`](https://explorer.minima.global/transactions/0x000052B87EB7D6A134491CE12423FF0C4F7CDCD4467D4410C97D98FAD908A5F1).
- Guardians check in: block 2,372,059
  [`0x00000778…266EC95D`](https://explorer.minima.global/transactions/0x0000077815D0701F9EDC55C3BE0EE8C2514C0195B079880CF231ED93266EC95D)
  and block 2,372,064
  [`0x0000175B…261F8E8E`](https://explorer.minima.global/transactions/0x0000175B5042C9A3750D0A92414E9EDAF69297E8E2048C19A2A7494E261F8E8E).

## Questions we want feedback on

- Is about 2 hours (today) or 3 hours (next vault) the right wait before a payout? Shorter pays people faster but asks
  more of guardians.
- How do you keep guardians independent and awake over years, without paying them in a way that makes them a target?
- Is a phone a reasonable home for a guardian, given that Android can stop background apps?
- Who should hold the backup approvers' keys, and how should they be stored?
- What would you want to see on the guardians page to trust a guardian you have never met?

Send questions and findings as issues on this repository.
