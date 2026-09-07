# AI-assisted source and evidence review

Source reviewed 2026-09-07; publication context updated 2026-09-08. Prepared with Codex, not a third-party security audit. PoC commit: `2273599e93fea3ba8e138825629631d9a386322a`.
Upstream inspected: `VeiloSolana/privacy-program`, commit `4958a2a60f147e5bfb519f0ceeaaefc76c7a262e`.

## Verdict

Credible PoC for a real historical nullifier-replay vulnerability. It does not establish an exploitable vulnerability in today's deployed mainnet program. Upstream has fixed the exact missing checks and publicly acknowledges this historical bug. The checkout is not sufficient to independently reproduce its claimed successful execution.

## Evidence checked

- Bundled `perps.rs:1039` (`jperp_reissue_notes`) and `perps.rs:1307` (`jperp_recover_native`) verify transaction proofs but neither check nor consume their input nullifiers. `lib.rs:2794` and `lib.rs:2910` allow reuse of the marker accounts through `init_if_needed`. Normal `transact` checks spent status and consumes nullifiers at `lib.rs:3630`.
- Reissue transfers only the public reissue amount into the vault. If its transaction circuit accepts nonzero already-spent inputs, output liabilities can exceed this backing. That circuit acceptance remains untested in this review because the proving artifacts are absent.
- All included verification-key fields match the bundled Rust constants: alpha, beta, gamma, delta, and all nine IC points. This establishes internal consistency, not correspondence with deployed bytecode or the claimed browser-extension artifacts.
- The copied `test-helpers.ts` is byte-identical to `veilo/tests/test-helpers.ts`.
- Bundled `perps.rs` exactly matches upstream revision `55d792f4250d81b5a4590a03a3df80a1e478ab7d`. Bundled `lib.rs`, after replacing the local program ID with the mainnet ID, matches its version at upstream `67196aa55eac7ac31301616e73b71eedc044a8b9`.
- Upstream fix `af9dc7f` adds spent-status checks and calls to `mark_nullifier_spent` for both inputs in both affected handlers. Current source retains these checks. This directly blocks the described replay; retaining `init_if_needed` is not by itself a vulnerability when these checks exist.

## Historical timing and bounty scope

The PoC's first Git author timestamp is July 10, 2026, 20:01:48 +02:00. The upstream fix's author timestamp is July 10, 2026, 23:22:00 +01:00 (July 11, 00:22 +02:00). The PoC's recorded creation therefore precedes the fix. Git timestamps do not prove submission time, discovery priority, or that the fix resulted from this report.

The receipt screenshots show the Veilo bounty and July 10, 2026 at 9:00 PM. The author identifies the display timezone as Zurich, giving 19:00 UTC. The matching fix has a Git timestamp of 22:22 UTC, 3 hours 22 minutes later. The screenshots do not identify the submitted repository URL. GitHub metadata captured before publication records repository creation at 18:01:48 UTC and last push at 18:59:09 UTC. This corroborates prior activity, not the submission contents or causation of the fix. See [README](README.md).

This is a historical disclosure. A subsequent fix does not invalidate an earlier report; first-reporter status and bounty adjudication cannot be established from this material alone.

Upstream `AUDIT.md` says the historical reissue nullifier bug was fixed and verified live, and records a July 30 deployment assessment. I verified the source fix, but did not independently inspect today's mainnet executable or verify the deployment claims.

## Reproduction and evidence limitations

1. `.wasm` and `.zkey` proving artifacts are excluded by `.gitignore` and absent. The built program, IDL, and program keypair under `veilo/target/` are absent too. Solana validator and Anchor commands were not available on PATH. No fresh end-to-end run was performed.
2. `run.sh` starts a fresh local validator with a locally built program and a genesis-seeded slot. It does not clone mainnet accounts. This is a synthetic local reproduction, not evidence of equivalence to current mainnet state. Its local program ID differs from the bounty target.
3. A malicious/compromised whitelisted relayer, known input-note secrets, and a claimant-controlled valid slot are preconditions. The slot seeding is reasonable for isolating the instruction bug, but does not demonstrate the complete Jupiter slot-creation path.
4. `exploit.ts:347` uses an unconditional `true` for its minted-value assertion. `exploit.ts:385` counts any exception, including proof-generation or infrastructure failures, as a successful replay-rejection control. Its `markerCollision` diagnostic is not asserted.
5. `sendV0` ignores `confirmTransaction(...).value.err`. Preflight provides some protection, and subsequent balance checks provide additional evidence, but successful confirmation alone is not a success assertion.
6. The final withdrawal check reads an actual recipient token balance, which is stronger evidence than the unconditional mint assertion. However, it checks only a positive balance, not the exact expected withdrawal and corresponding vault decrease. The committed output remains author-provided evidence, not an independently reproduced result.
7. `run.sh` includes a broad `pkill -f solana-test-validator`; running it would stop unrelated validators. I did not execute it.

## Sources

- Bounty: https://superteam.fun/earn/listing/veilo-bounty (full description read from page data).
- Fix: https://github.com/VeiloSolana/privacy-program/commit/af9dc7f (inspected through cloned Git history).
- Upstream deployment and historical-bug statements: https://github.com/VeiloSolana/privacy-program/blob/4958a2a60f147e5bfb519f0ceeaaefc76c7a262e/AUDIT.md

No transactions were submitted to mainnet and no live funds were moved. Review consisted of source/history comparison, local verification-key comparison, and public document retrieval. Original exploit code and recorded output were left unchanged; publication documentation was added later.
