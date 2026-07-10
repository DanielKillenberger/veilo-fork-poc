// common.ts
//
// Shared constants, key loading, and PDA derivations for the Veilo tier-2
// reissue-replay double-mint PoC. Everything here is deterministic so the
// jperp_slot PDA can be computed BEFORE the validator starts (it is seeded at
// genesis, see seed-slot.ts and README).

import { PublicKey, Keypair } from "@solana/web3.js";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";

export const HERE = __dirname;
export const KEYS_DIR = path.join(HERE, "keys");

// Program keypair produced by `anchor build` / `anchor keys sync`. The program
// id is derived from it so we never hardcode a stale value.
export function loadProgramId(): PublicKey {
  const kpPath = path.join(HERE, "veilo", "target", "deploy", "privacy_pool-keypair.json");
  const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(kpPath, "utf8"))));
  return kp.publicKey;
}

// A fixed, deterministic keypair persisted to ./keys so its pubkey is stable
// across the genesis-seed step and the runtime exploit.
export function loadOrCreateKeypair(name: string): Keypair {
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  const p = path.join(KEYS_DIR, `${name}.json`);
  if (fs.existsSync(p)) {
    return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, "utf8"))));
  }
  const kp = Keypair.generate();
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

// Fixed withdrawal_id ties the executor + slot PDAs together. Any fixed value works.
export const WITHDRAWAL_ID = new Uint8Array(32).fill(0x11);

// Anchor 8-byte account discriminator = sha256("account:<Name>")[..8].
export function accountDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

export function slotPDA(programId: PublicKey, mint: PublicKey, withdrawalId: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("jperp_slot_v1"), mint.toBuffer(), Buffer.from(withdrawalId)],
    programId,
  );
}

export function executorPDA(programId: PublicKey, mint: PublicKey, claimant: PublicKey, withdrawalId: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("jperp_executor"), mint.toBuffer(), claimant.toBuffer(), Buffer.from(withdrawalId)],
    programId,
  );
}

export function nullifierMarkerPDA(programId: PublicKey, mint: PublicKey, nullifier: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier_v3"), mint.toBuffer(), Buffer.from(nullifier)],
    programId,
  )[0];
}
