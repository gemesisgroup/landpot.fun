import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, maps, neighbors, order, standings, step } from '../public/game.js';

test('maps are connected and support their advertised player count', () => {
  for (const map of maps) {
    const game = createGame({ map, players: map.players, seed: 24 });
    assert.equal(new Set(game.cells.filter(cell => cell.owner >= 0).map(cell => cell.owner)).size, map.players);
    const valid = game.cells.filter(cell => cell.type !== 'gap');
    const seen = new Set([valid[0].id]);
    for (const id of seen) {
      for (const adjacent of neighbors(id, game.width)) {
        assert.ok(neighbors(adjacent, game.width).includes(id));
        if (game.cells[adjacent].type !== 'gap') seen.add(adjacent);
      }
    }
    assert.equal(seen.size, valid.length, map.id);
  }
});

test('valid capture changes both projected payouts and preserves the bank', () => {
  const game = createGame({ players: 3, bank: 101 });
  for (const cell of game.cells) { cell.owner = -1; cell.units = 5; }
  const source = game.cells.find(cell => cell.type !== 'gap'
    && neighbors(cell.id, game.width).filter(id => game.cells[id].type !== 'gap').length >= 3);
  const [target, enemy, third] = neighbors(source.id, game.width).filter(id => game.cells[id].type !== 'gap');
  source.owner = 0;
  source.units = 30;
  game.cells[target].owner = 1;
  game.cells[enemy].owner = 1;
  game.cells[third].owner = 2;
  assert.equal(order(game, 2, source.id, target, 75), false);
  assert.equal(order(game, 0, source.id, source.id, 75), false);
  const before = Object.fromEntries(standings(game).map(row => [row.player, row.payout]));
  assert.equal(order(game, 0, source.id, target, 75), true);
  const after = Object.fromEntries(standings(game).map(row => [row.player, row.payout]));
  assert.ok(after[0] > before[0]);
  assert.ok(after[1] < before[1]);
  assert.equal(Object.values(after).reduce((sum, award) => sum + award), 101);
});

test('pools and allied nodes add reinforcements deterministically', () => {
  const game = createGame({ ticks: 2, bank: 100 });
  const pool = game.cells.find(cell => cell.type === 'pool' && neighbors(cell.id, game.width).length > 0);
  const node = game.cells[neighbors(pool.id, game.width)[0]];
  node.type = 'node';
  node.owner = pool.owner = 0;
  pool.units = node.units = 20;
  step(game);
  assert.equal(pool.units, 20);
  step(game);
  assert.equal(pool.units, 24);
  assert.equal(game.ended, true);
});
