# Security plan: the card's approvers and guardians

**Status, stated plainly (9 November 2026).** The card runs on Minima mainnet with **valueless test tokens**, in the vault
generation **R2T6** (created 4 November 2026). The approver keys are spread over three machines, but the Stables lab
still holds all three and every guardian key, so the rules below are enforced on chain but are not yet spread across
independent people. This plan says what has to change before any real money, and in what order. Nothing here has had
an external audit.

A fault found on 7 November 2026 lets anyone stop the card vault for good. R2T6 holds test tokens only and takes no real money until the next generation fixes it.

Related: [GUARDIANS.md](GUARDIANS.md) (what guardians are and the rules), [the programs](../programs/) (the code that
holds the keys), [`evidence/r2t6/`](../evidence/r2t6/) (the scripts and every deployment step).

## Contents

1. [What holds power over the vault](#what-holds-power-over-the-vault)
2. [What an attacker gets, by number of keys](#what-an-attacker-gets-by-number-of-keys)
3. [Today and in production](#today-and-in-production)
4. [The requirements](#the-requirements)
5. [Gates before real money](#gates-before-real-money)
6. [Open questions](#open-questions)

## What holds power over the vault

The vault is a set of scripts on Minima with **no owner key**. When it was created, its seal head
(`0x2EF19A1992254D658332085AAAEA09AEC0245D711F4A9756C3F12E107723E88D`) fixed in it the public keys below and the rules.
The vault accepts a transaction only when it carries enough valid signatures from those keys, and only for what the
rules allow.

| | Keys | What the keys can do | The program that uses them |
|---|---|---|---|
| **Approvers** | 11, 7 sign a seal; on three machines (4, 4, 3) | Approve or refuse exit requests; send the heartbeat (every 3 hours) | [`programs/approvers/`](../programs/approvers/) |
| **Guardians** | 9 seats | 1 stops a request, 3 freeze all payouts, 5 release a freeze or a contested coin, 6 announce a handover to backup approvers, each checks in | [`programs/guardian/`](../programs/guardian/) |
| **Backup approvers** | 3 sets of 11, fixed at creation | Nothing until a handover installs the next set, after 7 days in public | none yet |

Neither group can send money where it likes: a payout always goes to the address the card's own key signed. The vault
pays only an approved request after its wait (at least 216 blocks, about 3 hours, after its seal is mined), a contested
coin with 5 guardian signatures, or a request left unanswered for 3 days while the approvers' heartbeat is under a day
old. Each kind of payout has a daily cap per record shard: 2,500 for the approvers, 125 for the fallback.

Both groups sign with Minima's one-time-signature keys, which can sign only a limited number of times. Each program
signs through a journal that counts every key's uses, so guarding a key also means guarding its journal: restoring an
old copy of a journal could let a key be used twice at the same count.

## What an attacker gets, by number of keys

| Keys controlled | Effect | Limit on the damage |
|---|---|---|
| 1 to 6 approver keys | Nothing | |
| **7 approver keys** | Approve a false request | Any **one** honest guardian stops it during the wait, and a stop holds even an approval; 3 freeze everything |
| 7 approver keys | Refuse valid requests | The request becomes a contested coin; 5 guardians overrule it from 3 days on, before the rejection turns final at 7 days |
| 7 approver keys | Stay silent | Payouts pause; after 3 days, 6 guardians announce a handover to the next backup set, carried out after 7 days in public |
| 5 approver keys lost | No seal possible | Treated as silence: handover to the next backup set |
| 1 guardian key | Stop requests | Delay only; 5 guardians release |
| 3 guardian keys | Freeze everything | Delay only; 5 guardians release |
| 5 guardian keys | Release stops and freezes, overrule refusals | Overruled payouts only through the 3-day fallback path and its cap (125 per shard per day) |
| 6 guardian keys | Announce a handover | Only to a backup set fixed at creation, after 7 days in public; working approvers or a guardian release cancel it |
| **7 approver keys and 5 guardian keys** | Pay false requests: approve, then release any stop and lift any freeze | The daily caps (2,500 per shard per day). This is the situation today, as the lab holds both |

So the security of the vault depends less on how well each single key is guarded than on **no one ever reaching a
threshold**: 7 approver keys together with 5 guardian keys above all.

## Today and in production

| | Test (today) | Production (before real money) |
|---|---|---|
| Approver keys | On three machines in different places (4, 4, 3), all held by the Stables lab | The three machines held by different operators, chosen by the Stables Council, so that no one holds 7 |
| Guardian keys | All 9 held by the Stables lab | Each seat run by a different operator, chosen by the Stables Council, on its own machine |
| Approvers and guardians | Same organisation, different machines | Never the same machine or the same person |
| Handover to new approvers | Only to one of 3 backup sets fixed at creation, after 7 days in public (in place) | The backup sets' keys held by people independent of the approvers |
| Wrongful refusal | 5 guardians overrule it (in place) | The same, with independent guardians |
| Fallback payout (3 days, no approver) | Built into the guardian program; the first on R2T6 was paid on 9 November, block 2,410,567 | Every guardian program posts it from the paid-coin lists it keeps itself |
| Lanes and deposit proofs for phones | Answered by two approver machines | Also answered by phones and guardians |
| Tokens | Valueless test tokens | Real value, only after the gates below |

## The requirements

### R1. No machine and no person holds 7 approver keys

**Built for machines (R2T6):** the 11 keys are on three machines (4, 4, 3) in different places. A seal is signed in
turns: one machine builds it, each checks every request on its own node before signing with its own keys, and it is
posted once 7 signatures are in. On 6 November a seal was signed with one machine switched off. **Still to do:** the
three machines held by three different people.

### R2. Approvers and guardians never share a machine or a person

Otherwise one break-in, or one person under pressure, reaches both thresholds. The first guardians already run away
from the approvers' machines.

### R3. No one holds 5 guardian seats

Each seat is run by a different operator (a person or an organisation) with its own key, program and Minima node. The Stables Council decides who operates each seat, by bidding and for a fixed term. Seats held by one person on
different devices protect against one device being broken into, not against that person being coerced, so real
independence needs other people. Seats change hands by a public swap: announced, 7 days in public, and the holder voids
an election just by checking in.

### R4. Handover only to backup approvers

**In place (R2T6).** Guardians can no longer install approvers of their own choosing: 6 of them can only announce a
handover to the next of three backup sets fixed when the vault was created. Anyone carries it out after a 7-day public
wait, and working approvers or a guardian release cancel it. **Still to do:** the backup sets' keys held by people
independent of the approvers.

### R5. Guardians can overrule a refusal

**In place (R2T6), and rehearsed.** A refusal turns the request into a contested coin. Five guardians can pay it from
3 days after the refusal, through the fallback's wait and cap; the approvers' rejection becomes final only once the coin
is 7 days old. A guardian's stop works the same way and holds even an approval until five release it (done on mainnet
on 6 November 2026).

### R6. Each key holder guards their key and its journal

The key stays in the holder's own Minima node; the journal that counts its uses is never rolled back. One lost key is
survivable: a guardian seat is refilled by election, and the approvers have 4 keys to spare.

### R7. No central point in the software

Each guardian reads its own node, never an approvers' machine; keeps its own paid-coin lists; publishes its log to its
own repository; and alerts its owner over Parlons! without a company's server. Phones get the gate's lanes and fresh
deposit proofs from more than one machine. The approvers' and guardians' code is public ([`programs/`](../programs/)).

### R8. Everyone can see who is awake

Guardians check in on chain every 7 days and publish a status every hour. The
[Card Guardians page](https://stablescouncil.org/guardians.html) shows each seat and flags a guardian silent for more
than 2 hours.

## Gates before real money

All of these, in this order where they depend on each other:

1. R1 finished: the three approver machines held by three different people. (Machines: done.)
2. R2 and R3: at least six guardian seats run by people independent of the approvers and of each other.
3. A vault generation with R4 and R5, tested offline and on mainnet with test tokens. (R2T6: done, the fallback
   rehearsal paid on 9 November 2026.)
4. Guardian programs running continuously, publishing their logs, with alerts tested live.
5. The backup approver sets' keys held by independent people.
6. An external review of the vault scripts, the verifier and both programs.
7. The decision to go to real value taken by the Stables Council, the community.

## Open questions

- Who should hold the three backup approver sets' keys, and how should they be stored?
- How do you keep guardians independent and awake for years, without paying them in a way that makes them a target?
- Is a wait of 3 to 4 hours the right balance between paying fast and giving guardians time?
- Are the daily caps (2,500 per shard for the approvers, 125 for the fallback) the right size for real money?

Send questions and findings as issues on this repository.
