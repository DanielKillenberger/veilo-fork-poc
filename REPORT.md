> **Historical submission report (July 10, 2026).** Published with context on September 8, 2026. The original body below is preserved; its present-tense deployment and reproduction claims describe the original report, not a new verification. See [README](README.md) for the matching fix, receipt evidence, and limitations. The original submitted revision is `2273599e93fea3ba8e138825629631d9a386322a`.

> **Publication corrections:** This checkout contains historical source and author-recorded local-validator output, not a mainnet-state fork. Verification-key equality with source does not establish deployed-bytecode equivalence. The WASM/zkey, tier-1 scripts (`vkey-onchain-match.js`, `npm run poc`), and generated build outputs mentioned below are absent here. The original run has not been independently reproduced in this review. References to a private repository describe its status at submission.

# Critical: Nullifier replay in jperp_reissue_notes / jperp_recover_native enables re-minting of already-spent notes (pool drain)

## Summary

The normal spend path `transact` burns each input nullifier with two independent guards. The `jperp_reissue_notes` and `jperp_recover_native` instructions verify proofs for the same transaction Groth16 circuit (same verifying key) over input nullifiers but omit both guards: they neither mark nor check the nullifier as spent, and their marker accounts use `init_if_needed` instead of `init`. Because the transaction circuit accepts real, nonzero input notes (confirmed against Veilo's own production proving artifacts), a relayer can feed already-spent real notes into these paths and re-mint their value into fresh output notes. Repeating this drains the pool of value that was already withdrawn.

## Impact

Loss of funds. An attacker who can call the reissue/recover instructions re-mints notes backed by value that has already left the pool, so the pool's outstanding note liabilities exceed its actual reserves. Iterated, this withdraws more than was ever deposited, draining pooled user funds.

## Adversary model (disclosed up front)

The attacker must satisfy several preconditions, disclosed here in full:
- Be, or control, a whitelisted relayer: `require!(cfg.is_relayer(&ctx.accounts.relayer.key()), PrivacyError::RelayerNotAllowed)` and `relayer.key() == ext_data.relayer`.
- Present a `jperp_slot` whose `claimant_pubkey` matches a `claimant` that co-signs the transaction (`claimant: Signer`, `claimant.key() == jperp_slot.claimant_pubkey`). The local PoC seeds this slot directly; in production it requires a valid JPerp slot/claimant pair, normally obtained through `jperp_open_position`, which an attacker-relayer can create and hold the claim key for.
- Fund the executor ATA with a dust balance to cover `reissue_amount` plus any nonzero relayer fee (the handler transfers gross_outflow = reissue_amount + ext_data.fee from the executor ATA to the vault; `reissue_amount > 0` is required; the PoC uses a dust reissue amount).
So the exploit is not permissionless: it requires a whitelisted relayer who sets up their own JPerp slot/claimant and funds dust into the executor. For a non-custodial privacy pool this is still a critical failure: the relayer is explicitly a gas-abstraction role and must never be able to mint or move principal, and here an approved relayer can drain pooled funds. We flag these access conditions plainly; the severity call on the relayer model is the sponsor's, but the underlying missing-nullifier-burn defect is unconditional.

## Why this is a bug and not intended behavior

The code and docs confirm the missing burn is an unenforced assumption, not a feature:
- The program README states nullifiers exist for exactly this purpose: "PDA-based nullifiers, double-spend protection." Double-spending is what the system claims to prevent.
- The reissue handler's own comment states the intended invariant: "each reissue is backed by the executor-ATA to vault transfer + matching TVL bump, so winning positions reissue fully." Every reissued note is meant to be backed by real proceeds moving into the vault. The exploit mints notes backed by nothing (already-spent notes, only dust entering the vault), violating this stated invariant.
- Most tellingly, the same comment asserts a guard that does not hold: "The ATA balance check blocks double-mint." The developers believe double-mint is already prevented by the executor-ATA balance bound. But that bound only limits `reissue_amount` (the public deposit), not the value of the private input notes. So a documented security assumption ("double-mint is blocked") is false in the presence of nonzero already-spent inputs. A stated-but-unenforced guard is the definition of a vulnerability, not a design choice.
- The public product documentation (docs.veilo.network) describes notes only as ordinary cash-like spend-and-change; it contains no notion of reissuing or re-minting from already-spent notes, so nothing frames this as intended user behavior.

## Root cause

In `transact`, each input nullifier is burned two ways:
- The nullifier marker PDA is created with `init`, so a second use of the same nullifier fails at account resolution (the PDA already exists). The code comments state this is the intended double-spend guard.
- The handler additionally checks `require!(!ctx.accounts.nullifier_marker_0.is_spent, ...)` and then sets `is_spent = true` (and mirror for marker 1).

In `jperp_reissue_notes` and `jperp_recover_native` (programs/privacy-pool/src/perps.rs):
- The nullifier marker PDAs are declared with `init_if_needed` (JperpReissueNotes / JperpRecoverNative contexts in lib.rs), so reusing an existing nullifier marker does NOT fail at account resolution.
- The handler bodies contain no read of `is_spent` and no write of `is_spent = true`. They call `verify_transaction_groth16(proof, &public_inputs)` with the same 8-input `TransactionPublicInputs` (root, public_amount, ext_data_hash, mint_address, input_nullifiers[2], output_commitments[2]) as `transact`, and check the input tree root is a known historical root, but never burn the nullifiers.

The design assumption is that these paths are only ever invoked with dummy zero-value inputs (a deposit-style call), whose nullifiers are meaningless. Nothing enforces that assumption. The transaction circuit does not force input amounts to zero, so a caller can supply real, nonzero, already-spent notes.

## Why the circuit permits real inputs (evidence)

There is a single transaction verifying key (`TRANSACTION_VK`) used by both `transact` and the reissue/recover paths (both call `verify_transaction_groth16` with the same 8-signal `TransactionPublicInputs` shape). A Groth16 proof is bound to its exact public inputs, so a withdrawal proof is not literally replayed as a reissue proof; rather, the same circuit relation is enforced on both paths, so the attacker generates a NEW proof for the reissue public inputs using already-spent notes as private inputs. Because `transact` demonstrably accepts nonzero real input notes against this circuit (that is what a withdrawal is), the identical circuit accepts the same nonzero real inputs when a reissue proof is generated over them.

Established by offline analysis of Veilo's own production circuit: Veilo's proving artifacts were extracted from the released Veilo Wallet browser extension (Chrome Web Store id embiakcfieonjgmbhhcbbdfogfffgahb, packaged version 1.3.4.0) and analyzed. Artifacts (sha256): transaction_final.zkey 3009250d5ae87ca76102f8686c26e2d58d5775162e368ff9877d7c2db85f1454; transaction.wasm 3f14fb74a4415af75c437bdc4821f9a237d052039707cb03b0fe8245c277b1ab; plus transaction.r1cs, transaction.sym, transaction_verification_key.json (groth16/bn128, 8 public inputs). Findings from transaction.sym and the verification key:
- Input note amounts are free witness signals with no zero constraint and no range constraint (only OUTPUT amounts are range-checked).
- Merkle membership for an input is enforced only when the input amount is nonzero (`enabled <== inAmount`, a ForceEqualIfEnabled construction). So a nonzero input must be a genuine member of the commitment tree.
- The circuit has no notion of spent status; it computes the nullifier and binds it to the public input but cannot check whether that nullifier was already consumed. Spent-status is purely an on-chain concern, which is exactly what reissue/recover omit.

An already-spent note is never removed from the append-only commitment tree, so it still satisfies membership. The circuit is fully satisfiable with a real, already-spent, nonzero input note.

## Exploit (step by step)

1. As a whitelisted relayer, take two real notes that have already been spent through `transact` (their nullifiers are already burned in the transact nullifier set, and the notes remain in the commitment tree).
2. Construct a `jperp_reissue_notes` (or `jperp_recover_native`) call with those two notes as inputs, a known historical root, `reissue_amount` set to a dust value (the instruction requires `reissue_amount > 0`), and two fresh output commitments whose value equals the inputs plus the dust amount. The balance constraint `sumIns + publicAmount = sumOuts` holds.
3. Generate the Groth16 proof with the transaction proving key. It verifies (the notes are real tree members, amounts balance).
4. Submit. The handler verifies the proof, confirms the root is known, and appends the fresh output note commitments (increasing private note liabilities). It does not check or burn the input nullifiers (init_if_needed marker, no is_spent logic).
5. The on-chain handler backs only `reissue_amount`: it transfers `reissue_amount` from the executor ATA into the vault and bumps `cfg.total_tvl += reissue_amount`. The spent-note value being replayed is NOT backed by any transfer. So the attacker now holds fresh output notes worth the replayed spent-note value plus dust, while the vault received only dust, despite having already withdrawn that value through the original `transact`.
6. The attacker later withdraws the fresh notes via `transact`, extracting value already withdrawn once. Repeat to drain the pool.

## Remediation

Mirror the `transact` guards in `jperp_reissue_notes` and `jperp_recover_native`:
- Use `init` (not `init_if_needed`) for the input nullifier marker PDAs so a reused nullifier fails at account resolution, and/or
- In the handler, `require!(!marker.is_spent)` and set `marker.is_spent = true` for each input nullifier before minting outputs.

Either guard alone closes the replay; matching transact and using both is the safe fix. If these paths are genuinely intended to only ever consume dummy zero-value inputs, the zero-input assumption must be ENFORCED rather than assumed. Input amounts are private witnesses, so they cannot be constrained on-chain directly; use a dedicated deposit/reissue circuit that constrains inputs to zero, or expose and enforce a public zero-input mode. Mirroring the `transact` nullifier guards (above) is the simpler and sufficient fix.

## Proof of concept, part 1: circuit acceptance (verifies against the DEPLOYED program's verifying key)

A runnable offline PoC is provided. It proves the exploit precondition: that the transaction circuit accepts nonzero private input amounts on the reissue/deposit public-input shape, so the reissue/recover instructions cannot be relying on the circuit to enforce dummy zero inputs.

Artifact provenance is pinned two ways so this is not "verified against a local file":
- The proving/verifying artifacts were extracted from Veilo's released Veilo Wallet browser extension; their SHA-256 are pinned (transaction_final.zkey 3009250d5ae87ca76102f8686c26e2d58d5775162e368ff9877d7c2db85f1454, transaction.wasm 3f14fb74a4415af75c437bdc4821f9a237d052039707cb03b0fe8245c277b1ab).
- The extension's verifying key EQUALS the verifying key hardcoded in the deployed mainnet program. We compared the extension's transaction_verification_key.json against `TRANSACTION_VK` hardcoded in the mainnet program source (vk_constants.rs, the source repository listed for the deployed program). The check compares EVERY field: alpha (G1), beta, gamma, delta (all G2), and all 9 IC entries (G1); every field matches byte-for-byte (curve bn128, protocol groth16, 8 public inputs). The vkey-onchain-match.js script in the repo reproduces this. So the key the PoC verifies against is the program's hardcoded verifying key, not a locally regenerated one.

What the PoC does: using Veilo's real wasm + zkey, it generates a Groth16 proof for a reissue-shaped statement with TWO NONZERO input notes (amounts 5,000,000 and 3,000,000) that have valid Merkle membership against the supplied root, a positive public amount (1,000,000), and balanced outputs (9,000,000), then verifies that proof against the deployed verifying key. The nonzero-input proof VERIFIES. A contrast run with dummy zero inputs (the design-intended shape) also verifies, showing the circuit does not distinguish the two shapes.

Controls that keep the result honest:
- A nonzero input with a corrupted Merkle path is REJECTED at witness generation, so the membership check is genuinely enforced (the acceptance is not because membership is a no-op).
- Outputs inflated by one unit are REJECTED, so value conservation is genuinely enforced (the circuit is not vacuously accepting everything).

Narrow, accurate claim: using Veilo's deployed verifying key and its proving artifacts, the circuit accepts a proof with nonzero private input amounts and valid membership paths under the reissue public-input shape. This establishes that the circuit itself does not enforce dummy zero inputs. The complete on-chain drain additionally requires (a) the reissue/recover instruction to accept the same public-input vector and skip the nullifier burn (established above by static analysis of perps.rs / lib.rs: init_if_needed markers, no is_spent check or set, same TRANSACTION_VK), and (b) the input note commitments to be genuine leaves of Veilo's current on-chain tree, which holds in the real attack because the attacker's already-spent notes were genuinely deposited and remain in the append-only tree. Step (b) against live chain state is not executed here, per the no-mainnet rule.

Run with `npm i && npm run poc`; expected output ends `RESULT: PASS`. The on-chain vkey-equality check is `node vkey-onchain-match.js`. The full PoC repo (scripts, README, Veilo's artifacts, the vkey-match script) is included as the linked private repository, accessible to the Veilo team.

## Tier-2 proof of concept: the exploit EXECUTES end-to-end on-chain (local validator)

Beyond the offline circuit proof, the full double-mint was executed against the real, unmodified privacy_pool program on a local Solana validator (local validator testing with the real, unmodified privacy_pool program; no live mainnet state or funds were touched, consistent with the rules' allowance for local fork/validator testing). Verified run, RESULT: PASS, 9 of 9 assertions:

- Deposited two real notes (12 and 8 USDC) as genuine tree leaves; spent both via `transact`; confirmed on-chain that nullifier(A) and nullifier(B) markers now have is_spent = true.
- An honest depositor added 30 USDC to the pool.
- EXPLOIT: called `jperp_reissue_notes` with those SAME already-spent nullifiers as nonzero inputs, a dust reissue_amount, and a freshly generated valid proof. The transaction SUCCEEDED (confirmed localnet signature 5oJ3NZz1QCb8e75A9EQmAZjQWJfymgNiSPqQMGNxRq2VhJxTWitBko9wDkMLWvpY5EbWy8cuN6vF42rh7HLWhBHE). Fresh notes worth 20.001 USDC were minted while only 0.001 USDC (dust) entered the vault; total_tvl bumped only by the dust; the spent-markers were left untouched (never checked or burned).
- CONTRAST: a `transact` re-spend of the same nullifier(A) was REJECTED (the `init` marker guard fires, custom program error), proving the guard exists on transact and is specifically absent on reissue.
- REALIZED LOSS: the re-minted notes were then withdrawn via `transact`, draining 19.899005 USDC (rounded to 19.899) of the honest depositor's funds out of the pool.

This demonstrates a realized localnet token drain executing against the real program logic, not just a satisfiable circuit. The test relayer was whitelisted in the local pool configuration, matching the disclosed whitelisted-relayer precondition. The jperp_slot (normally created by `jperp_open_position`, which CPIs Jupiter Perpetuals) was seeded directly at genesis on the local validator, since that machinery is orthogonal to the nullifier-burn defect. The runnable exploit, its output (EXPLOIT-RUN-OUTPUT.txt), and instructions are in the linked private repository (github.com/DanielKillenberger/veilo-fork-poc; the offline circuit PoC is at github.com/DanielKillenberger/veilo-poc).

## Proof method and safety confirmation

This report is established by static analysis of the deployed mainnet program (an accepted proof method per the bounty: mainnet contract analysis) plus offline analysis of Veilo's own extracted proving artifacts. No live funds were moved, no mainnet exploit was executed, and no mainnet or live user balances were touched. (The tier-2 validator PoC intentionally manipulates local test balances only.) A runnable off-chain proof-of-concept (generating a reissue-shaped Groth16 proof over nonzero already-spent notes and verifying it against Veilo's own verification key) is included in the linked private repository (scripts + Veilo's artifacts); it verifies a malicious reissue proof against Veilo's own verification key.

## Affected code

- programs/privacy-pool/src/perps.rs: `jperp_reissue_notes`, `jperp_recover_native` handlers (no is_spent check/set).
- programs/privacy-pool/src/lib.rs: `JperpReissueNotes`, `JperpRecoverNative` account contexts (init_if_needed nullifier markers); contrast with the `transact` context (init markers) and the transact handler (is_spent check + set).
