# Changelog: the guardian and approvers' programs

Versions ending in `-test` belong to the testing phase: they run the card with valueless test tokens and will change
before any real money. Each version is tagged in git as `programs-v<version>`.

## 0.2.0-test (9 November 2026)

For vault generation R2T6, which runs beside R2T5.

- **Approvers' program** (`approvers/r2t6/`): the same work for R2T6, signed in turns across three machines
  (`approvers/cosign/`). Each machine checks every request on its own node before it signs, and a seal carries exactly
  the 7 signatures it needs. A seal is warned about from 90% of the size limit and held for a person above 92%.
- **Guardian program:** the R2T6 rules (`guardian-r2t6.mjs`): stops that hold an approval until five release them,
  overruling a refusal, and the 3-day fallback payout, first paid on 9 November 2026 in block 2,410,567.
- **Three faults found by the rehearsal and fixed:** the package check misread a contested coin, so the checker's
  inline-package rule was corrected (the phone had the same rule); the guardian program's long commands now go by POST;
  the guardian program's check of port 41 was corrected.

One monitoring check in `r2t6-approvers.mjs` is left out of the published copy until the fault named in
[SECURITY_PLAN.md](../docs/SECURITY_PLAN.md) is fixed. Everything else in that file is as deployed.

## 0.1.0-test (3 November 2026)

First publication, for vault generation R2T5.

- **Guardian program:** re-checks every exit request and every seal from its own node, stops what it finds wrong,
  checks in every 7 days, keeps a hash-chained log and can publish it to its own repository. Alerts over Parlons!.
  Read only unless posting is switched on twice. Signs only through a journal that counts each one-time key's uses.
  65 of 65 tests pass. First real transaction: a check-in for seat 1, block 2,400,643.
- **Approvers' program:** checks each exit request, seals approvals and refusals, sends the heartbeat every 6 hours,
  pays approved requests after their wait and publishes the exit lists. Signs with all 11 keys on one node.

Known limits, planned for later versions: signing a seal across several machines (approvers); a standalone build and
tests runnable from this repository; the refusal overrule and the handover to backup approvers, which need the next
vault. See [SECURITY_PLAN.md](../docs/SECURITY_PLAN.md).
