---
title: Veilo privacy-pool security audit — critical fund-loss findings
date: 2026-07-10
tags: [security, audit, veilo, bounty]
---

# Veilo privacy-pool security audit

## Verdict

Yes. There is a submittable critical fund-loss bug.
The strongest, cleanest submission is the reissue/recover missing-nullifier double-spend: `jperp_reissue_notes` and `jperp_recover_native` feed input nullifiers into the Groth16 transaction proof but never mark them spent and never check `is_spent`, so a real in-tree note can be replayed to mint value out of nothing and drain the shared pool.
A second, independent critical also survived refutation: `fund_native_jperp_open` debits an unbounded vault amount that is never bound to the ZK-proven deposit in the paired `jperp_open_position`, letting a single relayer over-fund an executor ATA from the vault and recycle the excess into a fresh backed note.
Both require the actor to be an admin-whitelisted relayer, which is the standard adversary model for a non-custodial privacy pool (a relayer must never be able to mint or move principal), so both are in scope as critical fund-loss. Pick finding 1 as the headline submission; it is the more surgical, more obviously catastrophic proof.

---

## Finding 1 — reissue/recover never mark or check input nullifiers → double-spend / over-mint drains the pool

Severity: critical (relayer-gated)

Location:
- `programs/privacy-pool/src/perps.rs:1039-1293` — `jperp_reissue_notes`
- `programs/privacy-pool/src/perps.rs:1307-1489` — `jperp_recover_native`
- account contexts: `programs/privacy-pool/src/lib.rs:2760-2854` (`JperpReissueNotes`) and `lib.rs:2875-2919` (`JperpRecoverNative`)

Root cause:
`jperp_reissue_notes` builds `input_nullifiers = [input_nullifier_0, input_nullifier_1]` and passes them into `verify_transaction_groth16` as public inputs (perps.rs ~1090 onward).
It checks only that the two nullifiers are not equal to each other (`DuplicateNullifiers`). It never checks `is_spent`, never requires the nullifier to be nonzero/dummy, and never calls `mark_nullifier_spent`.
Confirmed by grep: the only `mark_nullifier_spent` calls in perps.rs are at lines 367 and 375, both inside `jperp_open_position`; the reissue and recover bodies contain none.
The verifier uses the single shared `TRANSACTION_VK` — the same 2-in-2-out UTXO circuit that `transact` uses. That circuit only enforces `sum(input_note_values) + public_amount = sum(output_values)`. It does not force inputs to be dummy/zero when `public_amount > 0`.
So an input note of real value V, combined with `reissue_amount = P`, satisfies the proof for outputs worth `V + P`, while only P tokens actually move executor ATA to vault.
Worse, the account context declares `nullifier_marker_0` / `nullifier_marker_1` as `init_if_needed` on the same global `nullifier_v3` namespace (lib.rs:2795, 2804 and 2911). A marker that already exists is silently reused, and since nothing ever sets `is_spent = true` on this path, the marker stays `is_spent = false` forever. The nullifier can be replayed across unlimited reissue calls.

Contrast that proves intent: `transact` (lib.rs ~3630-3649) marks `is_spent` on all paths and uses `init` markers (lib.rs:769, 782), which fail if the PDA already exists. The reissue/recover paths deliberately diverge from that safe pattern and lose both guards.
The `is_known_root` check on the input tree does not help — it actively helps the attacker, because their real note lives in a known root.

Step-by-step exploit:
1. Attacker is an authorized relayer and legitimately holds a private note C worth V (nullifier N) in the pool tree.
2. Open any minimal jperp position so an executor and `jperp_slot` exist and the executor collateral ATA holds a tiny balance P greater than zero.
3. Call `jperp_reissue_notes` with `input_nullifier_0 = N` (the real note C, not a dummy), `reissue_amount = P`, and output commitments summing to `V + P`.
4. The proof verifies (C is in a known root and the attacker knows its secret). The executor ATA has P, so P is moved to the vault. Notes worth `V + P` are minted. Nullifier N is never marked spent.
5. The attacker now holds fresh notes worth `V + P` having deposited only P, and still holds unspent note C worth V.
6. Withdraw the extra value via `transact`; note C remains spendable for another V. Repeat to drain the vault.

`jperp_recover_native` (perps.rs:1307-1489, missing-nullifier logic around 1381-1414) has the identical defect on the native-SOL path.

Impact:
Direct theft of principal from the shared vault. The minted notes are backed by other depositors' funds, not by the attacker's deposit. A single malicious or compromised whitelisted relayer drains the entire pool (both the SPL and native-SOL vaults) while burning nothing.
Who loses: every other depositor in the pool. `slot.reissued` has no ceiling (the code comment at perps.rs:1084-1086 explicitly states "No profit cap"), so the drain is unbounded.

Minimal fix direction:
On both reissue and recover paths, treat input nullifiers exactly as `transact` does: require `!nullifier_marker.is_spent` before proof verification, and call `mark_nullifier_spent` for every non-dummy input nullifier after the proof passes.
Change the marker accounts from `init_if_needed` to `init` so a pre-existing marker aborts the transaction. Additionally reject the case where a nonzero input nullifier coexists with a positive `reissue_amount` unless the note is provably a dummy, or better, forbid real value-bearing inputs on the reissue/recover circuit entirely by using a dedicated verifying key that constrains inputs to zero.

---

## Finding 2 — fund_native_jperp_open debits an unbounded vault amount not bound to the ZK-proven deposit in jperp_open_position

Severity: critical (relayer-gated)

Location:
- `programs/privacy-pool/src/perps.rs:169-216` — `fund_native_jperp_open`
- `programs/privacy-pool/src/perps.rs:222-497` — `jperp_open_position` (the paired consumer)
- reissue recycling: `perps.rs:1148-1175` (native reissue close-and-mint)

Root cause:
In the native-SOL flow the only vault debit is `fund_native_jperp_open`, which subtracts an arbitrary `deposit_amount` X from the vault into the executor WSOL ATA:
```
**vault_info.try_borrow_mut_lamports()? -= deposit_amount;
**ctx.accounts.executor_wsol_ata.to_account_info().try_borrow_mut_lamports()? += deposit_amount;
```
X is bounded only by `vault.lamports() >= deposit_amount + rent_exempt_min` (perps.rs:207-210), i.e. essentially the whole vault.
The instruction is gated by `is_relayer` plus a pairing guard (perps.rs:183-195). The guard verifies the next instruction is `jperp_open_position` (correct program id and `JPERP_OPEN_POSITION_DISC`) and that its executor at `accounts[10]` matches. It never decodes or compares the next instruction's own `deposit_amount` field (at data offset 44). So X is completely free.
`jperp_open_position` on the native path does not transfer from the vault at all (fund_native already did). It only `sync_natives` the pre-funded WSOL ATA and checks `wsol.amount >= deposit_amount` (perps.rs ~474-478), a `>=` and not an `==`. Its ZK proof authorizes withdrawal of only its own `deposit_amount + fee` (call it Y). Jupiter's increase-request pulls only `collateral_token_delta = Y` into escrow (perps.rs:267), leaving the residual `X - Y` sitting as WSOL in the executor ATA. `slot.amount = Y` is recorded (perps.rs:617) but never enforced as a reissue ceiling, and `total_tvl` only drops by `Y + fee` (perps.rs:621).
X (vault debit) and Y (ZK-authorized deposit) are therefore independent. Over-funding by `X - Y` is an unauthorized vault debit that no proof ever backed.

Step-by-step exploit:
1. Attacker (authorized relayer) submits a two-instruction transaction: `fund_native_jperp_open` with `deposit_amount = X` (near the entire native vault balance), followed immediately by `jperp_open_position` with `deposit_amount = Y` (minimal, backed by a tiny real note burn of `Y + fee`).
2. `fund_native` debits X from the vault into the executor WSOL ATA. The pairing guard passes (correct discriminator and executor).
3. `jperp_open_position` sync_natives the ATA (balance X is greater than or equal to Y, so it passes) and opens a minimal position. Jupiter escrows only Y, leaving `X - Y` WSOL in the executor ATA.
4. Attacker calls `jperp_reissue_notes` on the native path with `reissue_amount = X - Y` (perps.rs:1148-1175). `executor_wsol_data.amount >= reissue_amount` passes, `close_account` sends the entire ATA balance back to the vault, and a private note worth `X - Y` is minted (public_amount = +(X - Y), total_tvl += X - Y). The claimant co-sign is satisfied because the attacker is the claimant they chose.
5. Net effect: the `X - Y` returned to the vault was the vault's own money, not Jupiter proceeds. Returning it while also minting a note double-counts. Pool liabilities (TVL and notes) rise by roughly `X - Y` with no matching asset. The attacker withdraws the fresh note and drains the native-SOL pool, having burned only `Y + fee`.

Impact:
Direct theft of principal from the native-SOL vault. Because X is bounded only by vault balance, a single malicious relayer drains essentially the whole native-SOL pool while burning a negligible position.
Who loses: every native-SOL depositor. The same-transaction lamport sweep only touches the executor's native lamports, not the WSOL token account, so the residual persists long enough to be recycled.

Minimal fix direction:
Bind the vault debit to the proven deposit. In the pairing guard, decode the next instruction's `deposit_amount` (data offset 44) and require it to equal `fund_native`'s `deposit_amount` exactly. Alternatively, remove the standalone vault debit entirely and have `jperp_open_position` perform the vault-to-ATA transfer of exactly its ZK-authorized amount under its own proof, so there is only one amount and one authorization. Independently, cap native reissue at `slot.amount - slot.reissued` so an executor ATA can never return more than the position actually deposited.

---

## Checked and clean

These money-moving areas were examined and held up against attempted refutation:
- `transact` (lib.rs ~3630-3649): marks `is_spent` on all paths and uses `init` (not `init_if_needed`) nullifier markers (lib.rs:769, 782), so the standard withdrawal path is not double-spendable. This is the correct pattern the reissue/recover paths fail to copy.
- The shared Groth16 verifier (`verify_transaction_groth16`, zk.rs:169) and `TRANSACTION_VK` (zk.rs:224) correctly enforce the UTXO sum constraint. The bug is not in the circuit; it is that the reissue/recover callers omit the nullifier bookkeeping the circuit assumes the program will do.
- Fee bounds and ext_data hashing are enforced consistently across paths and do not constrain input note value, so they are not a mitigation for either finding but they are not themselves broken.
- The `is_known_root` root check functions as designed for validity; it is not a vulnerability (it only becomes attacker-favorable in combination with the missing nullifier check in finding 1).
- The relayer whitelist (`add_relayer` / `ConfigAdmin`, lib.rs:3281) and `is_relayer` gates are enforced everywhere expected. They correctly restrict who can call the affected instructions, which is why both findings are relayer-gated rather than permissionless. They do not prevent the drains because a relayer is exactly the adversary a non-custodial pool must contain.

---

## Submission draft

Title: Missing nullifier spend-check in `jperp_reissue_notes` / `jperp_recover_native` allows unbounded double-spend and drain of the shared pool

Summary:
`jperp_reissue_notes` (`programs/privacy-pool/src/perps.rs:1039-1293`) and `jperp_recover_native` (`perps.rs:1307-1489`) pass user-supplied input nullifiers into the shared Groth16 transaction proof but never check `is_spent` and never call `mark_nullifier_spent`. The nullifier-marker accounts are declared `init_if_needed` on the global nullifier namespace, so a pre-existing marker is silently reused and `is_spent` stays false forever. The verifying key is the same 2-in-2-out UTXO circuit as `transact`, which only enforces `sum(inputs) + public_amount = sum(outputs)` and does not force inputs to be dummy when `public_amount > 0`.

Impact:
An authorized relayer can supply a real, in-tree note of value V as a proof input while moving only a tiny `reissue_amount = P` from an executor ATA to the vault, and mint output notes worth `V + P`. The input note is never burned, so it remains spendable, and the same nullifier can be replayed across unlimited calls. This is direct, unbounded theft of principal from the shared vault (both SPL and native-SOL paths) at the expense of all other depositors. `slot.reissued` has no cap (code comment: "No profit cap"). In a non-custodial privacy pool a relayer must never be able to mint or move principal; this lets a single whitelisted relayer drain the entire pool.

PoC sketch:
1. As an authorized relayer, hold a legitimate private note C worth V (nullifier N) in the pool tree.
2. Open any minimal jperp position so an executor and `jperp_slot` exist and the executor ATA holds a tiny balance P > 0.
3. Call `jperp_reissue_notes` with `input_nullifier_0 = N`, `reissue_amount = P`, and output commitments summing to `V + P`. The proof verifies, P moves to the vault, notes worth `V + P` are minted, and N is never marked spent.
4. Withdraw the extra value via `transact`. Note C is still unspent and worth V; reuse it. Repeat to drain the vault. `jperp_recover_native` has the identical defect on the native-SOL path.

Remediation:
On both the reissue and recover paths, require `!nullifier_marker.is_spent` before verification and call `mark_nullifier_spent` for every non-dummy input nullifier after the proof passes, exactly as `transact` does (lib.rs ~3630-3649). Change the nullifier-marker accounts from `init_if_needed` to `init` so a pre-existing marker aborts the transaction. Ideally, use a dedicated verifying key for reissue/recover that constrains input notes to zero so real value-bearing notes can never be consumed on these paths.
