import { keccak_256 } from "@noble/hashes/sha3";

export type Hex = `0x${string}`;

/** A round's id in the escrow: keccak256 of the game id, 32 bytes. */
export function roundIdOf(gameID: string): Hex {
  return toHex(keccak_256(new TextEncoder().encode(gameID)));
}

export function toHex(bytes: Uint8Array): Hex {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

export function fromHex(hex: Hex): Uint8Array {
  return new Uint8Array(Buffer.from(hex.slice(2), "hex"));
}

/** keccak256 of exactly these bytes: the replay hash the oracle commits to. */
export function keccakHex(bytes: Uint8Array): Hex {
  return toHex(keccak_256(bytes));
}
