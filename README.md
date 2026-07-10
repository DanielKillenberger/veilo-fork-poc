# Veilo tier-2 local-fork PoC: jperp_reissue_notes nullifier-replay double-mint

This proof-of-concept executes the actual on-chain double-mint in Veilo's privacy_pool program on a local Solana validator.
It upgrades the tier-1 PoC (which proved the transaction circuit accepts nonzero real inputs offline) to a full end-to-end on-chain exploit against the real, unmodified program.

Localnet only. This never touches live mainnet and never moves real funds, per the bounty rules ("local fork testing using mainnet state").

## The bug

`transact` (the normal spend path) burns every input nullifier two ways: the nullifier-marker PDA is created with `init` (a second use of the same nullifier aborts at account resolution), and the handler additionally checks `require!(!marker.is_spent)` then sets `is_spent = true`.

`jperp_reissue_notes` feeds user-supplied input nullifiers into the SAME Groth16 transaction proof (same `TRANSACTION_VK`, same 2-in-2-out UTXO circuit) but never checks `is_spent` and never calls `mark_nullifier_spent`.
Its nullifier-marker accounts are declared `init_if_needed` on the exact same global namespace `[b"nullifier_v3", mint, nullifier]`, so a marker that a prior `transact` already burned is silently reused and its `is_spent = true` is ignored.

The circuit only enforces `sum(input_values) + public_amount = sum(output_values)`; it does not force inputs to be dummy/zero when `public_amount > 0`.
So a whitelisted relayer can feed already-spent real notes worth V into reissue with a dust `reissue_amount = P`, move only P into the vault, and mint fresh notes worth V + P out of nothing.

## What this PoC demonstrates

The same nullifier marker `[b"nullifier_v3", mint, nullifier]` is the crux.
After a real `transact` spend burns note A and note B, their markers exist on-chain with `is_spent = true`.
The PoC then:

1. deposits two real notes A and B (genuine tree leaves) into an SPL pool
2. spends A and B via `transact`, burning nullifier(A) and nullifier(B)
3. calls `jperp_reissue_notes` with those SAME already-spent nullifiers as nonzero inputs, a slot the attacker controls, a dust `reissue_amount`, and a freshly generated valid proof, and it SUCCEEDS
4. shows only the dust actually entered the vault while fresh notes worth value(A) + value(B) + dust were minted
5. CONTRAST: a fresh `transact` re-spend of the same nullifier is REJECTED at account resolution (the `init` marker already exists), proving reissue specifically lacks the guard
6. withdraws the re-minted notes via `transact` for real tokens, draining an honest depositor's liquidity from the pool

## Proving artifacts

The PoC uses Veilo's own production proving artifacts (transaction.wasm, transaction_final.zkey, transaction_verification_key.json) carried over from the tier-1 PoC.
The tier-1 report established that this verifying key is byte-for-byte the `TRANSACTION_VK` hardcoded in the deployed program, so proofs these artifacts generate are the same proofs the on-chain verifier accepts.
The proof and note/commitment/nullifier construction reuse the program's own `tests/test-helpers.ts`, the exact harness the Veilo test-suite uses for its passing deposits and transact spends.

## About the jperp_slot

A `jperp_slot` is normally created by `jperp_open_position`, which CPIs Jupiter Perpetuals and therefore needs a full mainnet fork of the Jupiter program plus the JLP pool, custodies, and oracles.
That machinery is entirely orthogonal to this bug.
`jperp_reissue_notes` reads only `jperp_slot.claimant_pubkey` (a `require_keys_eq` against the co-signing claimant) and `jperp_slot.bump`, and mutates `jperp_slot.reissued`; it never reads `slot.amount` and `slot.amount` is not an enforced ceiling ("No profit cap" per the program's own comment).

The audit already establishes that an attacker-relayer can self-create a slot with their own claimant key via `jperp_open_position`.
This PoC models that exact end state by seeding the slot account directly at validator genesis with a claimant we control, which isolates the demonstration to the actually vulnerable instruction instead of dragging in the unrelated and fragile Jupiter-fork machinery.
The seeded slot is behaviorally identical to one `jperp_open_position` would create, because reissue only reads the two fields named above.

## How to run

Prereqs: the program is already built at `veilo/target/deploy/privacy_pool.so` with its IDL at `veilo/target/idl/privacy_pool.json` (anchor 0.32.1 / solana 2.3.0), and node deps are installed (`npm install`).

```
npm install        # once
./run.sh
```

`run.sh` seeds the attacker slot at genesis, boots a local `solana-test-validator` with the program and the seeded slot, and runs `exploit.ts`.
The exploit prints one PASS line per assertion and a final `RESULT: PASS`.

The validator runs on RPC port 18899 by default (override with `RPC_PORT=...`), chosen to avoid a common conflict on 8899.

## Sample output

```
[3] deposited note A (12.000000 USDC) leaf 0, note B (8.000000 USDC) leaf 2
    vault balance = 20.000000 USDC
[4] SPENT A+B via transact -> recipient got 19.899005 USDC
  PASS  nullifier(A) marker exists and is_spent=true after transact
  PASS  nullifier(B) marker exists and is_spent=true after transact
    honest depositor added 30.000000 USDC; vault = 30.001000 USDC
[5] EXPLOIT reissue tx CONFIRMED: 2Kd1FN79JxGLD5ZfxKbYB9rav6...
  PASS  reissue with already-spent nullifiers SUCCEEDS (missing burn confirmed)
  PASS  only dust actually entered the vault on reissue  — vault +0.001000 USDC
  PASS  but fresh notes worth value(A)+value(B)+dust were minted  — minted 20.001000 USDC for 0.001000 USDC in
  PASS  total_tvl bumped by only the dust, not the replayed value  — total_tvl +0.001000 USDC
  PASS  reissue left the spent-markers untouched (never checked/burned)
[6] transact re-spend of nullifier(A) REJECTED
  PASS  transact REJECTS the same already-spent nullifier (init marker guard)
[7] withdrew the re-minted note -> drain recipient got 19.899005 USDC
  PASS  re-minted notes are REAL spendable value (withdrew them for tokens)  — drained 19.899005 USDC of other depositors' funds

=== RESULT: PASS (9 passed, 0 failed) ===
```

The attacker deposited 20 USDC, spent it all back out via a normal withdrawal (nullifiers burned), then replayed those same burned nullifiers through reissue to mint another 20.001 USDC of notes for 0.001 USDC of real input, and withdrew 19.9 USDC of that phantom value out of the pool, taking an honest depositor's liquidity.

To rebuild the program from source:

```
cd veilo
anchor build
anchor idl build -o target/idl/privacy_pool.json
```

Note: the only source change from the audited tree is a single `#[allow(deref_nullptr)]` on a `#[test]` layout-assertion helper in `merkle_tree.rs`, needed because the newer rustc promotes that lint to a hard error during IDL generation.
It is test-only and does not affect the deployed `.so` or any program logic.

## Files

- `exploit.ts` — the end-to-end driver (deposit, spend, reissue-replay, contrast, drain)
- `seed-slot.ts` — writes the genesis account file for the attacker-controlled jperp_slot
- `common.ts` — shared keys, PDA derivations, discriminator
- `test-helpers.ts` — Veilo's own proof and note helpers (copied from the program repo)
- `zk/` — Veilo's production proving artifacts (wasm, zkey, vkey)
- `run.sh` — one-command runner
- `veilo/` — the privacy_pool program source and build artifacts
