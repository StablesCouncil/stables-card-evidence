# The programs that look after the card's vault

The vault itself is a script on Minima with no owner key ([contracts](../contracts/r2t5/)). Around it, two kinds of
program hold keys the vault recognises:

| | Keys in the vault | Program | Where it runs today | Folder |
|---|---|---|---|---|
| **The approvers** | 11, of which 7 sign a seal | `r2t5-council.mjs`: checks each exit request, seals approvals and refusals, sends the heartbeat, pays approved requests after their wait | One server held by the Stables lab, beside the Minima node that holds the 11 keys | [`approvers/`](approvers/) |
| **A guardian** | 1 per seat, 9 seats | `guardian.mjs`: re-checks every request and every seal from its own node, stops what is wrong, checks in, logs and publishes its decisions | Not running continuously yet; all nine keys are held by the Stables lab | [`guardian/`](guardian/) |

Both use the same package check: [`approvers/checker/R2Checker.java`](approvers/checker/R2Checker.java), compiled with
the card's own Route 2 sources, of which [`verifier/java/`](../verifier/java/) is a copy. The `R2Checker.java` in
`verifier/java/` is an older version without R2T5 support; it is being brought up to date.

What each group can and cannot do, and the plan to make them independent: [GUARDIANS.md](../docs/GUARDIANS.md) and
[SECURITY_PLAN.md](../docs/SECURITY_PLAN.md).

## What is and is not here

- The code is copied from the Stables lab repository. Local folder paths in a few default settings are replaced with
  `<lab>`; nothing else is changed. [`MANIFEST.json`](MANIFEST.json) lists every file with its SHA-256.
- No key, password or server address is published. The keys live in each program's own Minima node. The scripts
  that deploy the approvers to the lab server are not published, because they hold the server's address and login.
- These are test versions, running with valueless test tokens. Nothing here has had an external audit.
