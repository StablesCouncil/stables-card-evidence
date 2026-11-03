# The approvers' program

`r2t5-council.mjs` is the program behind the card's approvers for vault generation R2T5. Older documents and the code
call the approvers "the Council"; that word is now kept for decisions taken by the Stables community.

It runs beside a Minima node that holds the approvers' 11 keys, and makes one pass every 30 seconds:

1. checks every new exit request with the card's own verifier ([`checker/R2Checker.java`](checker/R2Checker.java),
   compiled with the card's Route 2 sources, of which [`verifier/java/`](../../verifier/java/) is a copy);
2. seals when an approval or a refusal is new, and at least every 6 hours as a heartbeat. The vault's 3-day fallback
   only works while the heartbeat is under a day old, so silent approvers pause payouts instead of opening the vault;
3. posts the refusals listed in the seal;
4. pays approved requests once the seal's wait (144 blocks, about 2 hours) is over, and records each paid card coin
   in the exit records;
5. publishes the exit lists, from which anyone can rebuild every exit record.

Next to that, it answers phones' requests for fresh deposit proofs (no key needed).

```
node r2t5-council.mjs watch [--once]
node r2t5-council.mjs check <request coin id>
node r2t5-council.mjs proofs [--loop]
```

Settings come from environment variables (`R2T5_NODE`, `R2T5_GENERATION`, `R2T5_GUARD`, `R2T5_MINIMA_JAR`, and so
on; see the top of the file). Every signature goes through a journal that counts each one-time key's uses
(`R2T5_GUARD`), so a key is never used past its limit.

## Today, and what changes for real money

- **Today:** all 11 keys sit on one node, on one server held by the Stables lab. That server is a single point: whoever
  controls it controls all 7 signatures a seal needs.
- **Before real money:** the 11 keys are spread so that no machine and no person holds 7. That needs a way to sign one
  seal across several machines, which this program does not have yet. See [SECURITY_PLAN.md](../../docs/SECURITY_PLAN.md).

This copy is the lab repository's version of 3 November 2026. It has not yet been compared byte for byte with the copy
running on the server.
