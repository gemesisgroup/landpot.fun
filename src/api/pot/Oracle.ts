import {
  concat,
  encodeAbiParameters,
  keccak256,
  parseSignature,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { sign } from "viem/accounts";

/**
 * The oracle's result signature, exactly as LandpotEscrow.digest() builds it:
 *
 *   domain = keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("LandpotEscrow"),
 *                                 keccak256("1"), chainId, escrow))
 *   result = keccak256(abi.encode(RESULT_TYPEHASH, roundId,
 *                                 keccak256(abi.encode(players)),
 *                                 keccak256(abi.encode(amounts)), replayHash))
 *   digest = keccak256(0x1901 ‖ domain ‖ result)
 *
 * tests/api/pot checks this against the contract on a local chain.
 */

const DOMAIN_TYPEHASH = keccak256(
  toBytes(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
  ),
);
const RESULT_TYPEHASH = keccak256(
  toBytes(
    "Result(bytes32 roundId,bytes32 playersHash,bytes32 payoutsHash,bytes32 replayHash)",
  ),
);

/** A round's id on the contract: keccak256 of the game id. */
export function roundIdOf(gameID: string): Hex {
  return keccak256(toBytes(gameID));
}

export function resultDigest(opts: {
  chainId: bigint;
  escrow: Address;
  roundId: Hex;
  players: readonly Address[];
  amounts: readonly bigint[];
  replayHash: Hex;
}): Hex {
  const domain = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        DOMAIN_TYPEHASH,
        keccak256(toBytes("LandpotEscrow")),
        keccak256(toBytes("1")),
        opts.chainId,
        opts.escrow,
      ],
    ),
  );
  const result = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        RESULT_TYPEHASH,
        opts.roundId,
        keccak256(
          encodeAbiParameters([{ type: "address[]" }], [[...opts.players]]),
        ),
        keccak256(
          encodeAbiParameters([{ type: "uint256[]" }], [[...opts.amounts]]),
        ),
        opts.replayHash,
      ],
    ),
  );
  return keccak256(concat(["0x1901", domain, result]));
}

export interface OracleSignature {
  v: number;
  r: Hex;
  s: Hex;
}

/** Sign a digest with the oracle key. viem signs low-s, as the contract requires. */
export async function signDigest(
  privateKey: Hex,
  digest: Hex,
): Promise<OracleSignature> {
  const sig = parseSignature(
    await sign({ hash: digest, privateKey, to: "hex" }),
  );
  const v = sig.v !== undefined ? Number(sig.v) : 27 + sig.yParity;
  return { v, r: sig.r, s: sig.s };
}
