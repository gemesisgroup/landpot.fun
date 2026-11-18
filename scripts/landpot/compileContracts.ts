import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

/**
 * Compiles contracts/ with solc-js (pinned in devDependencies, so no native
 * compiler or network is needed) and, run as a script, writes the escrow's
 * ABI and bytecode to src/api/pot/LandpotEscrow.json for the API to load.
 *
 *   npm run contracts:build
 *
 * tests/api/pot checks the committed artifact still matches the source.
 */

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const ARTIFACT = path.join(ROOT, "src/api/pot/LandpotEscrow.json");

// paris: no PUSH0 or transient storage, so the bytecode runs on any EVM
// chain we might pick, rollups included.
const SETTINGS = {
  optimizer: { enabled: true, runs: 200 },
  evmVersion: "paris",
  outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
} as const;

export interface Compiled {
  abi: unknown[];
  bytecode: `0x${string}`;
}

export function compileContracts(
  files = ["contracts/LandpotEscrow.sol", "contracts/LandpotToken.sol"],
): Record<string, Compiled> {
  const sources = Object.fromEntries(
    files.map((f) => [
      f,
      { content: readFileSync(path.join(ROOT, f), "utf8") },
    ]),
  );
  const out = JSON.parse(
    solc.compile(
      JSON.stringify({ language: "Solidity", sources, settings: SETTINGS }),
    ),
  ) as {
    errors?: { severity: string; formattedMessage: string }[];
    contracts: Record<
      string,
      Record<string, { abi: unknown[]; evm: { bytecode: { object: string } } }>
    >;
  };
  const errors = (out.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length > 0) {
    throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  }
  const result: Record<string, Compiled> = {};
  for (const file of Object.values(out.contracts)) {
    for (const [name, c] of Object.entries(file)) {
      result[name] = { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
    }
  }
  return result;
}

/** The artifact as it is written to disk. */
export function escrowArtifactJson(): string {
  const { abi, bytecode } = compileContracts([
    "contracts/LandpotEscrow.sol",
  ]).LandpotEscrow;
  return (
    JSON.stringify(
      {
        contract: "LandpotEscrow",
        compiler: `solc ${solc.version()}`,
        abi,
        bytecode,
      },
      null,
      2,
    ) + "\n"
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  writeFileSync(ARTIFACT, escrowArtifactJson());
  console.log(`wrote ${path.relative(ROOT, ARTIFACT)}`);
}
