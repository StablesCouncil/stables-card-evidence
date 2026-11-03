# Changelog: the guardian and approvers' programs

Versions ending in `-test` belong to the testing phase: they run the card with valueless test tokens and will change
before any real money. Each version is tagged in git as `programs-v<version>`.

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
