import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { ContractFactory, JsonRpcProvider, Signature, Wallet, id } from 'ethers';
import solc from 'solc';

async function startChain(t) {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const service = spawn('node_modules/.bin/anvil', ['--host', '127.0.0.1', '--port', String(port), '--silent']);
  t.after(() => service.kill());
  let error;
  service.once('error', failure => { error = failure; });
  const url = 'http://127.0.0.1:' + port;
  for (let attempts = 0; attempts < 60; attempts++) {
    if (error) throw error;
    try {
      await fetch(url);
      const provider = new JsonRpcProvider(url, undefined, { cacheTimeout: -1 });
      t.after(() => provider.destroy());
      return provider;
    } catch { await setTimeout(100); }
  }
  throw new Error('Anvil did not start');
}

async function compiler() {
  const names = ['contracts/LandpotEscrow.sol', 'test/fixtures/TestToken.sol'];
  const sources = Object.fromEntries(await Promise.all(names.map(async file => [file,
    { content: await readFile(file, 'utf8') }])));
  const result = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  } })));
  assert.deepEqual((result.errors ?? []).filter(item => item.severity === 'error'), []);
  return result.contracts;
}

test('EVM resolves signed results, review, daily caps and timeout refunds', { timeout: 90000 }, async t => {
  const [provider, contracts] = await Promise.all([startChain(t), compiler()]);
  const signers = await provider.listAccounts();
  const [guardian, reserve, ...players] = signers;
  const oracle = Wallet.createRandom();
  const tokenInfo = contracts['test/fixtures/TestToken.sol'].TestToken;
  const escrowInfo = contracts['contracts/LandpotEscrow.sol'].LandpotEscrow;
  const deploy = (info, args) => new ContractFactory(info.abi, '0x' + info.evm.bytecode.object, guardian).deploy(...args);
  const token = await deploy(tokenInfo, []);
  const stake = 100;
  const day = 86400;
  const escrow = await deploy(escrowInfo, [await token.getAddress(), guardian.address, oracle.address,
    reserve.address, 200, 300, day, 1600, 500]);
  await escrow.waitForDeployment();
  const address = await escrow.getAddress();
  const round = id('test-round');
  const refund = id('refund-round');
  const abandoned = id('abandoned-round');
  const current = async () => (await provider.getBlock('latest')).timestamp;
  const tx = async promise => { await (await promise).wait(); };
  const travel = async seconds => {
    await provider.send('evm_increaseTime', [seconds]);
    await provider.send('evm_mine', []);
  };

  const start = await current();
  await tx(escrow.open(round, stake, 8, 8, start + 300, start + 600));
  for (const player of players) {
    await tx(token.mint(player.address, 300));
    await tx(token.connect(player).approve(address, 300));
    await tx(escrow.connect(player).deposit(round));
  }
  await assert.rejects(escrow.connect(players[0]).deposit.staticCall(round));
  await tx(escrow.start(round));
  await tx(escrow.open(abandoned, stake, 8, 8, start + 300, start + 600));
  for (const player of players) await tx(escrow.connect(player).deposit(abandoned));
  await tx(escrow.start(abandoned));
  const result = [760, 0, 0, 0, 0, 0, 0, 0];
  const replayHash = id('valid replay');
  const digest = await escrow.digest(round, result, replayHash);
  const { v, r, s } = Signature.from(oracle.signingKey.sign(digest));
  await assert.rejects(escrow.propose.staticCall(round, [759, 1, 0, 0, 0, 0, 0, 0], replayHash, v, r, s));
  await tx(escrow.propose(round, result, replayHash, v, r, s));
  await assert.rejects(escrow.propose.staticCall(round, result, replayHash, v, r, s));
  await tx(escrow.review(round, true));
  await tx(escrow.open(refund, stake, 8, 8, start + 300, start + 600));
  await tx(escrow.connect(players[0]).deposit(refund));
  await travel(day + 5);
  await assert.rejects(escrow.finalize.staticCall(round));
  await tx(escrow.review(round, false));
  await tx(escrow.finalize(round));
  const winner = escrow.connect(players[0]);
  await tx(winner.claim(round));
  assert.equal(await escrow.payouts(round, players[0].address), 260n);
  assert.equal(await token.balanceOf(reserve.address), 24n);
  await assert.rejects(winner.claim.staticCall(round));
  await tx(escrow.connect(players[1]).cancel(refund));
  await tx(winner.claim(refund));
  await assert.rejects(winner.claim.staticCall(refund));
  await tx(escrow.connect(players[1]).cancel(abandoned));
  await tx(winner.claim(abandoned));
  await travel(day + 5);
  await tx(winner.claim(round));
  assert.equal(await token.balanceOf(players[0].address), 960n);
  assert.equal(await escrow.payouts(round, players[0].address), 0n);
});
