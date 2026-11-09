# The Stables card's guardians

**Status, stated plainly (9 November 2026).** The card runs on Minima mainnet with **valueless test tokens** (Winiwa,
xWiniwa). Its vault is now generation **R2T6**, created on 4 November 2026; card money moves over from the previous
vault (R2T5) one coin at a time. The guardian rules are part of R2T6's own scripts and have been exercised on mainnet
with real phones: a refusal, a stop by one guardian, and its release by five. All nine guardian keys are still held by
the Stables lab. The guardian program runs, read only, on the founder's computer. Nothing here has had an external audit.

Live page: [stablescouncil.org/guardians.html](https://stablescouncil.org/guardians.html). Card figures:
[stablescouncil.org/test-dashboard.html#card](https://stablescouncil.org/test-dashboard.html#card). The code:
[`programs/`](../programs/). What must change before real money: [SECURITY_PLAN.md](SECURITY_PLAN.md).

## Contents

1. [What a guardian is](#what-a-guardian-is)
2. [The rules](#the-rules)
3. [The nine seats](#the-nine-seats)
4. [The guardian program](#the-guardian-program)
5. [What has been proven](#what-has-been-proven)
6. [What comes next](#what-comes-next)
7. [Decisions taken](#decisions-taken)
8. [Before any real money](#before-any-real-money)
9. [Check it yourself](#check-it-yourself)
10. [Questions we want feedback on](#questions-we-want-feedback-on)

## What a guardian is

Two separate groups look after the card's vault:

- **The approvers:** 11 keys, of which 7 must sign (a "seal") before money goes back from a card to Savings. In R2T6 the
  keys are spread over three machines in different places (4, 4 and 3), and each machine checks every request itself
  before it signs. Older documents, the contracts and the code call them "the Council"; the word Council is now kept
  for decisions taken by the Stables community.
- **The guardians:** 9 seats, each a program run by a different operator (a person or an organisation) with its own key, that watch the approvers.

The approvers are not needed for the money to come back:

- **Paying needs no one.** Card money moves from phone to phone by touch, offline, with no server.
- **If the approvers do not answer, the vault still lets your money come back.** An exit request they neither approve
  nor refuse can be paid after 3 days with no key at all (the fallback), as long as the approvers' heartbeat is under a
  day old and the vault is not frozen. The guardian program builds that payout from its own copy of the paid-coin
  lists and posts it.
- **If the approvers go quiet, the money stays safe.** If their heartbeat stops, the fallback pauses
  instead of opening, so nobody can slip a false request through. After 3 days of silence, 6 guardians can announce a
  handover, and after 7 more days in public anyone carries it out: only to one of three backup approver sets fixed when
  the vault was created.
- **A wrongful refusal can be undone.** In R2T5 an explicit refusal destroyed the request and locked the money (on
  13 October 2026 the lab paid such a refusal back by hand). In R2T6 a refusal only turns the request into a contested
  coin. Five of the nine guardians can overrule it from 3 days after the refusal; the approvers' rejection becomes
  final only once the contested coin is 7 days old.

Approvers can also be wrong, hacked or captured. Guardians are the check on them.

A guardian is a small program, run by one operator with its own key, next to its own Minima node. It:

- re-checks every exit request with the same package check the approvers use (every signature on the coin's path, and
  the hardware certificates behind every key);
- rebuilds every seal's lists of approved and rejected requests from the chain, and compares them with what it
  found itself;
- **stops at once any request the approvers approved that it did not pass**, and tells its owner when a person needs
  to act;
- keeps its own copy of the paid-coin lists, rebuilt from the chain, and publishes it;
- checks in on chain regularly, to show it is alive;
- writes every decision to a log it publishes.

**A guardian can never send money anywhere it chooses.** A payout always goes to the address the card's own key
signed. A guardian can stop, freeze, release, and together with others overrule a refusal or announce a handover. The
worst a dishonest guardian can do is delay.

## The rules

These are enforced by the vault's own scripts on chain, not by any server. The scripts and every deployment step are in
[`evidence/r2t6/`](../evidence/r2t6/).

| Action | Who | Effect |
|---|---|---|
| Stop | **Any 1** guardian | The request becomes a contested coin. It is paid only with 5 guardian signatures: after the approvers approve it again, or after 3 days. **An approval does not get past a stop.** |
| Freeze | **3** guardians | All payouts stop, the fallback included. The approvers cannot lift a freeze. |
| Release | **5** guardians | A freeze is lifted, or a contested coin paid (a released stop, or an overruled refusal). |
| Handover | **6** guardians announce, anyone carries out | Only after 3 days of approver silence or 7 days frozen, and only to one of the 3 backup approver sets fixed at creation, after a 7-day public wait. Working approvers or a guardian release cancel it. |
| Check-in | Each guardian | Shows the seat is alive. A seat counts as active for 30 days after a check-in. |
| Guardian swap | Announced, then 7 days in public | An election needs a majority of all nine seats (at least 3), against a seat 60 days without a check-in; the seat holder voids it just by checking in. Removing a guardian needs 6 of 9. One swap at a time. |

**The wait before a payout.** An approved request is paid from its seal's heartbeat plus 288 blocks: at least
216 blocks (about 3 hours) after the seal is mined, usually close to 4 hours. That is the window in which a guardian
acts; one stop in that window holds the payout until five guardians release it.

**Caps.** The approvers can pay at most 2,500 of a token per record shard per day (8 shards per token). The 3-day
fallback can pay at most 125 per shard per day. A payout goes through one shard, so one request is at most 2,500.

## The nine seats

Each seat has a name, so people can follow a guardian over time. "Active" means checked in within 30 days. R2T6 kept
R2T5's nine guardian keys.

| Seat | Name | Tagline | Key held by | Guardian program | Last check-in (R2T6) |
|---|---|---|---|---|---|
| 0 | Farrier | Checks every shoe | Stables lab | lab rehearsal | 7 Nov 2026 |
| 1 | Bridle | Holds the reins | Stables lab | lab rehearsal | 7 Nov 2026 |
| 2 | Paddock | Fenced ground | Stables lab | lab rehearsal | 7 Nov 2026 |
| 3 | Halter | Leads, never rides | Stables lab | lab rehearsal | 7 Nov 2026 |
| 4 | Stirrup | Steady footing | Stables lab | lab rehearsal | 7 Nov 2026 |
| 5 | Tackroom | Everything in its place | Stables lab | none yet | 4 Nov 2026 (creation) |
| 6 | Lantern | Night watch | Stables lab | planned: a phone | 4 Nov 2026 (creation) |
| 7 | Hayloft | The high view | Stables lab | planned: a personal computer | 4 Nov 2026 (creation) |
| 8 | Gatepost | Stands at the gate | Stables lab | planned: a separate server | 4 Nov 2026 (creation) |

Read from mainnet on 7 November 2026. Seats 0 to 4 checked in together that day (block 2,407,067), the first check-in on
R2T6: active until about 7 December 2026. Seats 5 to 8 have not checked in since the vault was created: active until
about 4 December 2026, open to election from about 3 January 2027 unless they check in.

"Lab rehearsal": the seat's key signed the stop, the releases or the freeze of the November rehearsal. A guardian with no seat
already watches R2T6 read only, in its own box on the founder's computer.

**Who runs the first guardians.** Lantern, Hayloft and Gatepost will be run by the project's founder, on a phone, a
personal computer and a personal server, none of them an approvers' machine. That separates the guardians from the
approvers' machines, not yet from the team behind Stables. Independence comes when other operators take seats.

**Who will operate each seat.** The development team operates every approver and guardian role today. The Stables
Council, the community, will decide who operates each one, by bidding and for a fixed term, with pay that rises with the
quality of the service. The Council holds the mandate; each operator keeps its own key and runs its own program. Each
role passes to its operators step by step.

## The guardian program

Written on 3 November 2026 and extended for R2T6 on 5 and 6 November, for personal computers and servers (Node.js),
with a design for a guardian mode inside the Stables Android app.

- **Read only by default.** It builds and checks every transaction, and never posts unless two separate switches are
  set on purpose.
- **Its own node.** It reads a Minima node on the same machine, never an approvers' server. In the guardian box (Docker)
  the node, the program and its alert account are separate containers.
- **A pass every 5 minutes.** A request found bad is checked again 20 blocks later before it is stopped; one the
  approvers approved without its pass is stopped at once.
- **Releases signed in turn.** A release or overrule is prepared by one guardian and handed to the next; each signs only
  if it is exactly the payout it would build itself, and the fifth posts it.
- **Its own paid-coin lists**, followed from the chain; a list from anyone else is taken only if it rebuilds the root
  the chain shows.
- **Check-in every 7 days**, never in the 30 blocks before an approvers' heartbeat seal.
- **Freezes and handovers are prepared for the owner, not signed alone,** because people decide those.
- **A tamper-evident log.** Each line carries the hash of the line before, so an edited line is found.
- **Alerts** to its owner over Parlons!, an open-source messenger on Minima's Maxima network, with no central chat
  server.

The guardian program's code is published in [`programs/`](../programs/), for R2T6. The approvers' program published there is the R2T5 version; the R2T6 version follows.

## What has been proven

**On mainnet, with test tokens, with real phones (5 and 6 November 2026):**

- **A full round trip through R2T6.** 10 Winiwa in through the gate from a phone, the exit checked on all three approver
  machines, sealed by two of them (seal 6), paid about 4 hours later (transaction
  `0x41787156…2767`), and seen by the phone.
- **A seal with one approver machine down** (seal 11): signed by the two others.
- **A refusal** (seal 9): a request with no valid package, refused into a contested coin within two minutes; the
  read-only guardian found it bad on its own.
- **A stop and its release.** A real 5 Winiwa exit from a phone was stopped by one guardian
  (`0x3EEC77D9…25D2`), approved again by the approvers, then released by five guardians signing in turn
  (`0x45C53FBF…C65A`); the money reached the phone's Savings.
- **A check-in** (7 November 2026, seal 23): seats 0 to 4 checked in together in one transaction (`0xDF46242A…DAF2`).
- **A freeze and its release** (7 November 2026): three guardians froze the vault right after an approvers' seal
  (`0x9FDB9555…ED28`, seal 25). A new exit from a phone arrived during the freeze: the approvers checked and sealed it
  (seal 26) but paid nothing while frozen. Five guardians then lifted the freeze (`0x8CEBAA29…FA9E`, seal 27), and the
  approvers paid that exit after it (`0x4B7DDF6C…D45F`).
- **A payout with no approver** (9 November 2026, block 2,410,567): the approvers left a 3 Winiwa exit undecided on
  purpose, and 3 days after it was made it was paid by the 3-day fallback, with no signature
  (`0x00003BA5DAF29EA6B63E067BF566C794B92685DA12815FBA9E3720D5C1747B35`). It was posted by hand with the guardian program.

**Offline**, with test keys in Minima's own transaction checker against the deployed R2T6 scripts: the R2T6
transactions of both programs (99 of 99, each with broken versions that must be refused), and the guardian program's
decisions (83 of 83).

The rehearsal also found and fixed three faults before any real money: the package check misread a contested coin (the
phone had the same rule), and two in the guardian program's signing path. Each is described in the programs' changelog.

## What comes next

1. Independent operators take the seats; today all nine keys are the lab's. Seats 5 to 8 have not checked in on R2T6 yet.
2. The approver keys are on three machines, but all three are held by the lab.
3. The guardian program runs read only; posting has been done by hand for the rehearsal.
4. No guardian publishes its log yet, and alerts are not yet tested live.
5. Phones get the gate's lanes and deposit proofs from two approver machines; a phone cannot yet confirm an approval by
   itself, so the app does not claim one until the payout lands.
6. The Android guardian mode is a design only.

## Decisions taken

- **No central point.** No approvers' machine must ever be needed for safety. Guardians use their own nodes, publish
  their own logs and lists, and send alerts without a company's server.
- **The approver keys are spread from creation:** 4 on the first server, 4 on a personal computer, 3 on a newly rented
  server in another city; each checks every request before it signs.
- **Every protection is on in R2T6**, so each can be relied on when the time comes: handover only to backup approvers,
  the public guardian swap, and the overrule of a refusal.
- **The first three guardians** run away from the approvers' machines: on a phone, a personal computer and a personal
  server.
- **Check-in every 7 days**, far inside the 60-day limit.
- **Logs.** Each guardian publishes its own log every hour to its own public repository, so no single host holds them
  all.
- **The phone guardian** runs always, not only while charging.

## Before any real money

The full list, with the order and the gates, is in [SECURITY_PLAN.md](SECURITY_PLAN.md). In short: the approvers' three
machines and the nine guardian seats must be held by different operators, so that no one reaches 7 approver keys or
6 guardian seats; the guardian programs must run continuously and publish; and the scripts and both programs need an
external review.

## Check it yourself

- R2T6 seal head address: `0x2EF19A1992254D658332085AAAEA09AEC0245D711F4A9756C3F12E107723E88D`. Its state holds the
  approver keys (ports 60 on), the nine guardian keys (80 on), their last check-ins (100 on) and the ring of the last
  three approved lists (120 on). Created at block 2,402,474. Every deployment step and the scripts are in
  [`evidence/r2t6/`](../evidence/r2t6/).
- First seal across machines (seal 1): `0xC8F6CFCAF08287FB647EC692D76C9D0ADF753D32BE31B134A8BB3C4728DD5CFD`.
- A refusal (seal 9 and the refusal itself): `0x50DFE827B716FE4A1DB10546BDBDFE4ADD0ECC5CD1B44AF392F55B967153AF2E`,
  `0x8CDC1CA8CDD522C477C25FA6ADEA087A59F7EFD5CA32D968DB5D8C06F1566252`.
- A seal with one machine down (seal 11): `0x832B46BC684765737E0D117D29100096A0A870EE9CAF61914F236E8AD4936B7F`.
- One guardian stops a request: `0x3EEC77D9D892ED363C688CCECC39EA7F39B342F8F00B064CFE836E38E56525D2`. The approvers
  approve it again (seal 15): `0xBA09D7837CC341BCBFC4CEC21C2790F92DDD8F6136A334201F5FBC0382F2D211`. Five guardians
  release it: `0x45C53FBF55122A199E8C10F1D92F9CC7C1B3AED74AB518A684862A28759EC65A`.
- Five guardians check in (seal 23): `0xDF46242AB91F99E4C593493778BB8B8C79B9A08A8847CBC727FE96878F2ADAF2`.
- The R2T5 rules were exercised on mainnet at its deployment (October 2026); those transactions are kept in
  [`evidence/r2t5/`](../evidence/r2t5/).

## Questions we want feedback on

- Is a wait of 3 to 4 hours before a payout right? Shorter pays people faster but asks more of guardians.
- How do you keep guardians independent and awake over years, without paying them in a way that makes them a target?
- Is a phone a reasonable home for a guardian, given that Android can stop background apps?
- Who should hold the three backup approver sets' keys, and how should they be stored?
- What would you want to see on the guardians page to trust a guardian you have never met?

Send questions and findings as issues on this repository.
