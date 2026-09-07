# Veilo nullifier-replay PoC — historical disclosure

This repository preserves my July 10, 2026 submission to the [Veilo Superteam bounty](https://superteam.fun/earn/listing/veilo-bounty), with publication context added on September 8, 2026.

The report describes how a whitelisted relayer controlling a valid claimant slot could reuse already-spent notes through `jperp_reissue_notes`, mint unbacked private notes, and withdraw pooled tokens. Upstream subsequently added the exact spent-status checks and nullifier consumption described in the report.

**My submission was received at 21:00 Zurich on July 10. The matching upstream fix has a commit timestamp 3 hours 22 minutes later.** The receipt and repository metadata support this chronology. They do not establish that my report caused the fix, that I was the first reporter, or when the fix was deployed.

## Timeline and evidence

| Event | UTC | Zurich (UTC+2) | Evidence |
| --- | --- | --- | --- |
| GitHub repository created | July 10, 18:01:48 | July 10, 20:01:48 | [GitHub metadata captured before publication changes](PUBLICATION-EVIDENCE.json) |
| Last push before publication preparation | July 10, 18:59:09 | July 10, 20:59:09 | Same metadata; original HEAD `2273599e93fea3ba8e138825629631d9a386322a` |
| Superteam submission received | July 10, 19:00 | July 10, 21:00 | [Receipt](evidence/submission-received.png), [expanded email details](evidence/submission-details-redacted.png) |
| Matching upstream fix committed | July 10, 22:22 | July 11, 00:22 | [`af9dc7f9092e43a7ee1fea89863dcf07d25901ad`](https://github.com/VeiloSolana/privacy-program/commit/af9dc7f9092e43a7ee1fea89863dcf07d25901ad) |

All dates above are in **2026**. The screenshots show the receipt for the named Veilo bounty and July 10, 2026 at 9:00 PM. The timezone interpretation is mine: Gmail was displaying Zurich time. The screenshots do not display the submitted repository URL; my identification of this repository as the submitted PoC is accompanied by its original history and pre-publication GitHub metadata. Repository metadata is not a per-commit push attestation, and Git timestamps alone are not proof of submission.

The receipt body is unchanged. The expanded-details screenshot has only the recipient email address covered with a solid pixel redaction; image metadata was stripped. No generative image editing was used. I retain the original email privately.

## What upstream fixed

The historical reissue handler verified a transaction proof but did not check or consume its input nullifiers. Its marker accounts used `init_if_needed`, allowing an existing spent marker to be reused. The normal `transact` path did enforce spent status.

The fix adds `require!(!marker.is_spent, ...)` for both inputs and calls `mark_nullifier_spent` in `jperp_reissue_notes` and `jperp_recover_native`. The PoC deliberately supplies markers already marked spent, so those checks directly reject the described replay.

[Upstream's audit context](https://github.com/VeiloSolana/privacy-program/blob/4958a2a60f147e5bfb519f0ceeaaefc76c7a262e/AUDIT.md) lists this as a historical fund-loss bug fixed and verified live. This publication does **not** claim a current mainnet exploit. The publication review checked the source patch, not current deployed bytecode.

## Original submission materials

- [Report](REPORT.md) — historical body preserved with a publication notice.
- [Original README](archive/README-original.md) — original claims and reproduction instructions, retained as an archive; read the limitations below first.
- [PoC driver](exploit.ts) and [recorded original output](EXPLOIT-RUN-OUTPUT.txt).
- [Original submission revision](https://github.com/DanielKillenberger/veilo-fork-poc/tree/2273599e93fea3ba8e138825629631d9a386322a).
- [AI-assisted source review](REVIEW.md) — subsequent source comparison and harness limitations, not a separately reproduced test run or third-party audit.

The three original commits are preserved without rewriting. Publication documentation and receipt files are later additions. The original PoC driver, helper code, and recorded output have not been altered to improve the historical result.

## Reproduction limits

**This is an archival PoC, not a self-contained runnable checkout.** The transaction WASM and zkey proving artifacts are absent. The built program, IDL, and program keypair under `veilo/target/` are also absent. Installing npm dependencies alone will not make it runnable. The original report records artifact hashes, but the publication review could not verify the missing files or their provenance.

The test starts a fresh local Solana validator with a compiled historical program and a genesis-seeded claimant slot. It does not import mainnet state. It uses a local token mint and program ID; the bounty's mainnet program is `GYy4kM6GHhpgLCUscuABbzkD2ZbJ2fneYryaZ6Ch7fFU`. Slot creation through Jupiter is modeled, not executed. A whitelisted relayer, input-note secrets, a claimant-controlled slot, and sufficient pool liquidity are preconditions.

The committed run output is the author's recorded result. No fresh end-to-end reproduction was completed during publication preparation. The included verification-key JSON was compared successfully against every corresponding bundled Rust constant; that does not independently prove circuit behavior or mainnet equivalence.

Known harness weaknesses are disclosed rather than hidden: the minted-value assertion is unconditional; the negative control accepts any exception; transaction confirmation results are not checked for `value.err`; and the final withdrawal checks a positive balance rather than the exact expected balance change. See [the review](REVIEW.md). Also, the archived `run.sh` broadly kills matching `solana-test-validator` processes; inspect it before use. The direct driver accepts `ANCHOR_PROVIDER_URL`; use only a disposable local validator.

## Test fixtures

`keys/claimant.json` and `keys/mint.json` are exposed keypairs used as local test fixtures by the PoC and its genesis seeding. Treat them as public and disposable; never fund or reuse them for real assets or authority. Their presence does not establish control of any mainnet program. The repository-history scan found no additional common credential-pattern matches, but was not an exhaustive secret audit.

The bundled `veilo/AUDIT-REPORT-TO-VERIFY.md` also contains historical working notes on a separate prefunding issue. Its corresponding source fix is `1768b9c`, not the nullifier fix used in this timeline.
