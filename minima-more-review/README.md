# minima-more against the Java Minima node: a script conformance check

Stables Council, 21 October 2026. A constructive report for the author of [Totem-Edge/minima-more](https://github.com/Totem-Edge/minima-more) and for the Minima community.

minima-more is a C++ port of the Minima node. Its memory and disk savings are real: on a fresh node with no peers we measured **19 MB of memory against 155 to 340 MB** for the Java node, at half the CPU. Because Stables runs a Minima node inside its Android app, a lighter node matters to us, so we checked the one thing that decides whether a node can be trusted with money: **does it judge contract scripts exactly like Minima?** Every node must reach the same yes or no on every transaction, or it leaves the network's chain.

**Result: 368 of 381 cases agree, including every case of our own card vault contracts. Three differences are serious: one can split the chain, one gives different contract addresses, and one crashes the node.** Each is easy to reproduce below, and we expect each to be a small fix.

## What we tested

- **minima-more** commit [`c2e57b5`](https://github.com/Totem-Edge/minima-more/commit/c2e57b5) ("Minima More 0.2.0", 2026-10-21). The 4 commits since (analytics, archive import, sync cooldown) touch none of the code involved.
- **Reference:** Minima's own Java classes from `minima.jar` 1.0.45.15, run offline.
- **381 cases**, each run through both and compared field by field:
  - 230 whole-transaction cases, the path the chain uses to check a spend. They include the 176 cases of the Stables card's R2T5 vault battery and 9 new cases for its deposit gate and marker anchor, all from our public [contracts](../contracts/r2t5/).
  - 151 `runscript` cases: number precision and rounding to 44 decimals, MOD, POW, SQRT, shifts and bitwise operations, the 2^64 edges, HEX and number casts, string functions, SHA2/SHA3/ADDRESS, PROOF with real MMR proofs, CHECKSIG with real Winternitz signatures, MULTISIG, IF/WHILE/ASSERT/EXEC/FUNCTION, the instruction and stack limits, and parse errors.
- minima-more was built from source with GCC 11.4 on Ubuntu (WSL) and run with no network access. No key, wallet or private data was involved.

## What agrees

Everything below gave identical results, including the instruction counts:
- all 185 Stables vault cases: payouts, fallbacks, Council and guardian paths, tampering, wrong signers, proofs;
- number maths, division by zero, MOD, POW, SQRT and rounding;
- SHA2, SHA3, ADDRESS and every PROOF case;
- every CHECKSIG case with real Winternitz signatures, MULTISIG and SIGNEDBY;
- VERIFYOUT, VERIFYIN and all globals;
- the 1,024 instruction limit, the stack depth limit and every parse error.

That is an impressive translation. The differences below are narrow, which is why they deserve fixing before anyone relies on the node.

## The findings

### 1. `HEX()` of a number differs: a chain-split risk

```
runscript script:"RETURN HEX(255) EQ 0xFF"
```
Java: `TRUE`. minima-more: `FALSE`. Inside a whole transaction too.

minima-more returns `0x00FF` for `HEX(255)` and `0x0080` for `HEX(128)`; Java returns `0xFF` and `0x80`. The values 0, 1, 127 and 256 agree. Any contract that turns a number into bytes this way and then compares, hashes (`SHA3(HEX(n))`) or concatenates the result is judged differently, so a transaction valid on Java nodes is invalid on minima-more, or the reverse.

Likely cause: `kissvm/functions/cast/h_e_x.cpp` builds the value from two's-complement bytes (with a sign byte); Java's `MiniData(BigInteger)` drops it.

### 2. Script cleaning differs, so contract addresses differ

```
runscript script:"LET a=1/3 RETURN TRUE"
```
Java's clean script: `LET a=1/3 RETURN TRUE`. minima-more's: `LET a = 1 / 3 RETURN TRUE`.

minima-more adds spaces around `=` and operators when it cleans a script, so the clean text, and therefore the clean address, differs for 118 of the 151 `runscript` cases. The address of the raw script is identical, so validating a transaction that carries its script still agrees. But `newscript` uses the clean form (`system/commands/scripts/newscript.cpp`), so a wallet on minima-more registers and watches **different addresses** from the ones contracts actually live at.

For Stables this is decisive: all 8 deployed card vault contracts get a different address, so a phone on minima-more would never see its vault coins.

| Contract | Address on chain (Java) | minima-more's address |
|---|---|---|
| anchor | `0x8E5DA67BE5D0E8E6E58238702B725F2BDBE982D3B264A55D8FC4A8D648E7071D` | `0xAD73D010C0FE56B664308CC0685A39E42D65159418DF9B493B266FABC15A04EB` |
| contested | `0x092183C5904C71124646E339E33C003DD2FF0F3AE250BE752C8CC34C2200164A` | `0xFE9C124163B329039D5D2CCF654F9CA0C23008B1BFB56A52013BAAD5993646D1` |
| copy | `0xE37B73AA83186B7CCEBF306699A5D87CF6721071059B621F599B8A6856E47896` | `0xAD7A426ADD59F0EDEB688DE2E88FDDFCE03FC664E71696F421323C8002B734DD` |
| gate | `0x9454F9DEC8C03CBA54179F2808934A3D65B281C42124B5BA567322F2497CE9A6` | `0xCEEE3677B8671B9BBB921B0F0F4B3EFE1756D5FAE2E5416EED1EEC630A2AD526` |
| head | `0xD6462FFC684A99C146D0FFE4D1681FF61BD7DB99122ECBDD64E7F702AF425561` | `0xE459C809EDB35581A843CA8F99A563453B499F4F71E25FEE94C71957D98D62B3` |
| record | `0xD06AD1ACCCC6AB8F61ADEA5F17EA2058A4B8998DC81517F2D1EC89B3C6D0B704` | `0x22BE5904E12092D30D3E64F2C677901CA509F2669FC9E15A8678D4E1ECB7ABCE` |
| request | `0x5BFE17B989A7053037A3E565C42696481952295E20F2EE7128F61713176F907B` | `0x9DD369741C6FE1E8CB99FE4C6A19B634BFF08ED50695F709B68C488A21549706` |
| vault | `0x5E2497EC163480AEC7C15B43A62FDBED9595FA38ED1DE2ACC4A0A4F0E1287791` | `0x7E5A76CA8397A353F344DEAAA7FFEF51CD501B95F6E721E4B62714C359E7FFF2` |

The scripts are in [`contracts/deployed/`](../contracts/deployed/) and the transactions that created them are listed in the [main README](../README.md#contracts-and-addresses).

### 3. A long hex value crashes the node: a remote denial of service

```
runscript script:"LET a=0x<12,000 zero bytes> RETURN TRUE"
```
Java: `TRUE`. minima-more: the process dies with a segmentation fault (exit 139), in `runscript` and in whole-transaction checking alike.

Sizes up to about 11,000 bytes pass; from about 11,500 bytes the parser crashes. With a larger stack (`ulimit -s 65536`) every size passes, so it is stack exhaustion, most likely the recursive `std::regex_match` used in `kissvm/tokens/script_tokenizer.cpp`. A transaction carrying such a script is valid to Java nodes and fits a TxPoW, so any peer could use one to crash minima-more nodes. We reproduced it in the script tools; we did not send such a transaction to a live node.

### 4. Smaller points

- **Number range outside scripts.** minima-more widens its general number type to plus or minus 2^256-1, where Java's limit is 2^64-1. Inside scripts it restores the 2^64 limit and every script case agreed; but amounts and sums elsewhere now accept values Java refuses, which we did not test. Worth an explicit parity check.
- **`runscript` refuses JSON parameters.** Passing `state`, `prevstate`, `globals` or `signatures` fails ("param 'state' is not a JSONObject", "Invalid JSONArray parameter"). The same 10 cases rerun as whole transactions agree, so the engine is fine; only the command layer needs fixing. Until then `runscript` cannot test contracts that use state or signatures.
- **Cosmetic:** one exception message is worded differently, array variable names show different spacing (`( 1  )` against `( 1 )`, results equal), and traces print differently. None changes a result.

## Licence

The repository has no licence file, so as published nobody may use or redistribute it. It is ported from Minima's Java code ([minima-global/Minima](https://github.com/minima-global/Minima), Apache-2.0), whose licence requires the licence and NOTICE files to be kept. Adding Apache-2.0 would settle both.

## Suggestions

1. Fix findings 1 to 3. Each looks contained to one file.
2. Add a differential test that runs the same scripts through the Java classes and the C++ engine and compares every field. The project's own tests check the code against vectors frozen from the C++ code itself, which is how these differences went unnoticed. We are happy to share our 381-case bench.
3. Add a licence.

If these are fixed, we will gladly rerun the full comparison and publish the result here.

Contact: Stables Council, https://stablescouncil.org/links.html
