import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import solc from "solc";

const srcPath = path.resolve("bsc/contracts/LandpotEscrow.sol");
const source = readFileSync(srcPath, "utf8");

const input = {
  language: "Solidity",
  sources: {
    "LandpotEscrow.sol": { content: source },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "paris",
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object"],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors ?? []) as { severity: string; formattedMessage: string }[];
for (const e of errors) {
  if (e.severity === "error") {
    console.error(e.formattedMessage);
    process.exit(1);
  } else {
    console.warn(e.formattedMessage);
  }
}

const contract = output.contracts["LandpotEscrow.sol"]["LandpotEscrow"];
mkdirSync(path.resolve("bsc/artifacts"), { recursive: true });
const artifact = {
  contractName: "LandpotEscrow",
  abi: contract.abi,
  bytecode: ("0x" + contract.evm.bytecode.object) as `0x${string}`,
};
writeFileSync(
  path.resolve("bsc/artifacts/LandpotEscrow.json"),
  JSON.stringify(artifact, null, 2) + "\n",
);
writeFileSync(
  path.resolve("src/api/pot/LandpotEscrowAbi.ts"),
  `export const LANDPOT_ESCROW_ABI = ${JSON.stringify(contract.abi, null, 2)} as const;\n`,
);
console.log(
  `Compiled LandpotEscrow.sol -> bsc/artifacts/LandpotEscrow.json (${contract.evm.bytecode.object.length / 2} bytes)`,
);
