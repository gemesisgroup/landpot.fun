import { readFile, mkdir, writeFile } from 'node:fs/promises';
import solc from 'solc';

const name = 'LandpotEscrow.sol';
const content = await readFile(new URL('../contracts/' + name, import.meta.url), 'utf8');
const result = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: { [name]: { content } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
})));
for (const issue of result.errors ?? []) {
  if (issue.severity === 'error') throw new Error(issue.formattedMessage);
  console.warn(issue.formattedMessage);
}
const { abi, evm } = result.contracts[name].LandpotEscrow;
const output = new URL('../dist/contracts/', import.meta.url);
await mkdir(output, { recursive: true });
await writeFile(new URL('LandpotEscrow.json', output), JSON.stringify({ abi, bytecode: '0x' + evm.bytecode.object }, null, 2));
console.log('LandpotEscrow compiled with ' + solc.version());
