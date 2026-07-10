// seed-slot.ts
//
// Emits a solana-test-validator genesis account file for a JupiterPerpSlot PDA
// that the attacker controls (claimant_pubkey = our claimant key).
//
// WHY GENESIS-SEED: a jperp_slot is normally created by jperp_open_position,
// which CPIs Jupiter Perps and therefore needs a full mainnet fork of the
// Jupiter program + JLP pool + custodies + oracles. That machinery is entirely
// orthogonal to the bug: jperp_reissue_notes reads ONLY slot.claimant_pubkey
// (a require_keys_eq) and slot.bump, and mutates slot.reissued. The audit
// already establishes that an attacker-relayer can self-create a slot with
// their own claimant key via jperp_open_position. Seeding the slot directly
// models that exact end state while isolating the demonstration to the actually
// vulnerable instruction. slot.amount is NOT an enforced ceiling on reissue
// ("No profit cap" per the program's own comment), so its value is irrelevant.

import { PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { loadProgramId, loadOrCreateKeypair, WITHDRAWAL_ID, accountDiscriminator, slotPDA } from "./common";

const programId = loadProgramId();
const mint = loadOrCreateKeypair("mint").publicKey;
const claimant = loadOrCreateKeypair("claimant").publicKey;

const [slot, bump] = slotPDA(programId, mint, WITHDRAWAL_ID);

// JupiterPerpSlot layout: disc(8) | amount:u64 | reissued:u64 | claimant:Pubkey(32) | bump:u8
const data = Buffer.alloc(8 + 8 + 8 + 32 + 1);
accountDiscriminator("JupiterPerpSlot").copy(data, 0);
data.writeBigUInt64LE(1_000_000n, 8);   // amount (audit counter origin; unused by reissue)
data.writeBigUInt64LE(0n, 16);          // reissued
claimant.toBuffer().copy(data, 24);     // claimant_pubkey
data.writeUInt8(bump, 56);              // canonical bump

const acct = {
  pubkey: slot.toBase58(),
  account: {
    lamports: 2_000_000,
    data: [data.toString("base64"), "base64"],
    owner: programId.toBase58(),
    executable: false,
    rentEpoch: 0,
  },
};

const out = path.join(__dirname, "slot-account.json");
fs.writeFileSync(out, JSON.stringify(acct, null, 2));
fs.writeFileSync(path.join(__dirname, "slot-address.txt"), slot.toBase58());
console.log(`programId  ${programId.toBase58()}`);
console.log(`mint       ${mint.toBase58()}`);
console.log(`claimant   ${claimant.toBase58()}`);
console.log(`slot PDA   ${slot.toBase58()}  (bump ${bump})`);
console.log(`wrote      ${out}`);
