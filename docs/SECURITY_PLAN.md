# Security plan: the card's approvers and guardians

**Status, stated plainly (3 November 2026).** The card runs on Minima mainnet with **valueless test tokens**. Today the
Stables lab holds every approver key and every guardian key, so the rules below are enforced on chain but are not yet
spread across independent people. This plan says what has to change before any real money, and in what order. Nothing
here has had an external audit.

Related: [GUARDIANS.md](GUARDIANS.md) (what guardians are and the rules), [the programs](../programs/) (the code that
holds the keys), [R2T5 design](R2T5_DESIGN.md).

## Contents

1. [What holds power over the vault](#what-holds-power-over-the-vault)
2. [What an attacker gets, by number of keys](#what-an-attacker-gets-by-number-of-keys)
3. [Today and in production](#today-and-in-production)
4. [The requirements](#the-requirements)
5. [Gates before real money](#gates-before-real-money)
6. [Open questions](#open-questions)

## What holds power over the vault

The vault is a script on Minima with **no owner key**. When it was created, a fingerprint (the seal head,
`0xD6462FFC684A99C146D0FFE4D1681FF61BD7DB99122ECBDD64E7F702AF425561`) fixed in it the public keys below and the rules.
The vault accepts a transaction only when it carries enough valid signatures from those keys, and only for what the
rules allow.

| | Keys | What the keys can do | The program that uses them |
|---|---|---|---|
| **Approvers** | 11, 7 sign a seal | Approve or refuse exit requests; send the heartbeat (every 6 hours) | [`programs/approvers/`](../programs/approvers/) |
| **Guardians** | 9 seats | 1 stops a request, 3 freeze all payouts, 5 lift a freeze or a stop, 6 replace silent approvers, each checks in | [`programs/guardian/`](../programs/guardian/) |

Neither group can send money where it likes. The vault pays only an approved request after its wait (144 blocks,
about 2 hours), or a request left unanswered for 3 days while the approvers' heartbeat is fresh.

Both groups sign with Minima's one-time-signature keys, which can sign only a limited number of times. Each program
signs through a journal that counts every key's uses, so guarding a key also means guarding its journal: restoring an
old copy of a journal could let a key be used twice at the same count.

## What an attacker gets, by number of keys

| Keys controlled | Effect | Limit on the damage |
|---|---|---|
| 1 to 6 approver keys | Nothing | |
| **7 approver keys** | Approve a false request | Any **one** honest guardian stops it during the 2-hour wait; 3 freeze everything |
| 7 approver keys | Refuse valid requests | Today that money stays locked (see [the refusal gap](#r5-guardians-can-overrule-a-refusal)) |
| 7 approver keys | Stay silent | Payouts pause; after 3 days, 6 guardians install new approvers |
| 5 approver keys lost | No seal possible | Treated as silence: 6 guardians install new approvers |
| 1 guardian key | Stop requests | Delay only; 5 guardians release |
| 3 guardian keys | Freeze everything | Delay only; 5 guardians release |
| 5 guardian keys | Lift freezes and stops | Harmful only with dishonest approvers |
| **6 guardian keys** | After 3 days of approver silence or 7 days frozen, install approvers of their own | The 2-hour wait and daily caps slow it; 3 honest guardians can freeze. Removed by [R4](#r4-handover-only-to-backup-approvers) |
| **7 approver keys and 6 guardian keys** | Full control of payouts | None. This is the situation today, as the lab holds both |

So the security of the vault depends less on how well each single key is guarded than on **no one ever reaching a
threshold**: 7 approver keys, or 6 guardian keys, or both groups together.

## Today and in production

| | Test (today) | Production (before real money) |
|---|---|---|
| Approver keys | All 11 on one node, on one server held by the Stables lab | Spread so that no machine and no person holds 7 |
| Guardian keys | All 9 held by the Stables lab | Each seat run by a different person, on their own machine |
| Approvers and guardians | Same organisation | Never the same machine or the same person |
| Handover to new approvers | 6 guardians choose them | Only to backup approvers fixed at the start, after a 7-day public wait |
| Wrongful refusal | Money locked; the lab pays it back by hand | 5 guardians overrule it |
| Tokens | Valueless test tokens | Real value, only after the gates below |

## The requirements

### R1. No machine and no person holds 7 approver keys

The 11 keys are spread across at least three machines, in different places and run by different people, for example
4, 4 and 3. A seal is then signed in turns: one machine builds it, each signs with its own keys, and it is posted once
7 signatures are in. **To build:** the approvers' program signs today on one node; it needs that multi-machine signing.

### R2. Approvers and guardians never share a machine or a person

Otherwise one break-in, or one person under pressure, reaches both thresholds. The first three guardian programs
already run away from the approvers' server (a phone, a personal computer and a separate server).

### R3. No one holds 6 guardian seats

Each seat is run by a different person with their own key, program and Minima node. Seats held by one person on
different devices protect against one device being broken into, not against that person being coerced, so real
independence needs other people. Seats are filled by election once a seat has been silent for 60 days, and in the
next vault are fixed from the start.

### R4. Handover only to backup approvers

Next vault. Guardians can no longer install approvers of their own choosing: they can only announce a handover to backup
approvers fixed when the vault is created. Anyone carries it out after a 7-day public wait, and working approvers or a
guardian release cancel it. Six captured guardians then cannot take control. Replacing a silent guardian is also
announced, waits 7 days in public and needs a majority of all nine seats; the current holder voids it by checking in.

### R5. Guardians can overrule a refusal

Next vault. Today an explicit refusal destroys the request, and the card coin, already signed over to the exit, stays
locked in the vault. On 13 October 2026 a 166.1 Winiwa exit was wrongly refused and the lab paid it back by hand. The
fix: a refusal leaves a refused request, which 5 of the 9 guardians can overrule, sending it to the 3-day fallback with
its usual wait and caps. Until then, every guardian raises an urgent alert when the approvers refuse a request it found
good, and the lab pays any wrongful refusal back by hand.

### R6. Each key holder guards their key and its journal

The key stays in the holder's own Minima node; the journal that counts its uses is never rolled back. One lost key is
survivable: an election refills a guardian seat, and the approvers have 4 keys to spare.

### R7. No central point in the software

Each guardian reads its own node, never the approvers' server; publishes its log to its own repository; and alerts its
owner over Parlons! without a company's server. The approvers' and guardians' code is public ([`programs/`](../programs/)).

### R8. Everyone can see who is awake

Guardians check in on chain every 7 days and publish a status every hour. The
[Card Guardians page](https://stablescouncil.org/guardians.html) shows each seat and flags a guardian silent for more
than 2 hours.

## Gates before real money

All of these, in this order where they depend on each other:

1. R1 built and in place: the approver keys spread over at least three machines and people.
2. R2 and R3: at least six guardian seats run by people independent of the approvers and of each other.
3. A new vault generation with R4 and R5, tested offline and on mainnet with test tokens.
4. Guardian programs running continuously, publishing their logs, with alerts tested live.
5. An external review of the vault scripts, the verifier and both programs.
6. The decision to go to real value taken by the Stables Council, the community.

## Open questions

- Who should hold the backup approvers' keys, and how should they be stored?
- How do you keep guardians independent and awake for years, without paying them in a way that makes them a target?
- Is a 2-hour wait (today) or 3-hour wait (next vault) the right balance between paying fast and giving guardians time?

Send questions and findings as issues on this repository.
