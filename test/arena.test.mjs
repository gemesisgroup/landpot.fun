import assert from 'node:assert/strict';
import test from 'node:test';
import { createArena } from '../arena.mjs';
import { config } from '../config.mjs';
import { neighbors } from '../public/game.js';
import { reproduce } from '../scripts/replay.mjs';

function fixture(extra = {}) {
  let snapshot;
  let time = Date.UTC(2026, 0, 1);
  const settings = { ...config, matchSeconds: 2, queueSeconds: 30, paidMin: 8, paidMax: 16, ...extra };
  const options = { load: () => snapshot && structuredClone(snapshot),
    save: value => { snapshot = structuredClone(value); }, now: () => time, settings };
  const arena = createArena(options);
  const makeGroup = (count, mode, tier = 'low') => Array.from({ length: count }, () => {
    const id = arena.register();
    arena.join(id, mode, tier);
    return id;
  });
  return { arena, makeGroup, settings, advance: ms => { time += ms; },
    snapshot: () => snapshot, restart: () => { const service = createArena(options); service.restart(); return service; } };
}

test('paid queue mixes players, verifies orders, preserves money and reproduces a replay', () => {
  const { arena, makeGroup, settings, advance, snapshot } = fixture();
  const group = makeGroup(8, 'test');
  arena.cycle();
  const viewer = arena.view(group[0]);
  assert.equal(viewer.balance, settings.startingCredits - settings.stakes.low.stake);
  assert.equal(viewer.match.game.players, 8);
  assert.equal(viewer.match.diplomacy.length, 0);
  const { id, player, game } = viewer.match;
  const from = game.cells.find(cell => cell.owner === player).id;
  const to = neighbors(from, game.width).find(index => game.cells[index].type !== 'gap');
  arena.command(group[0], { match: id, from, to, percent: 75 });
  assert.throws(() => arena.command(group[0], { match: id, from, to, percent: 75 }), /Слишком много/);
  assert.throws(() => arena.diplomacy(group[0], { match: id, target: (player + 1) % 8, action: 'offer' }), /недоступен/);
  assert.ok(!JSON.stringify(arena.view(group[0])).includes(group[1]));
  for (let index = 0; index < 5; index++) arena.cycle();
  assert.equal(arena.view(group[0]).match.result, 'pending');
  assert.deepEqual(reproduce(arena.replay(id)), arena.replay(id).ranking);
  advance(settings.reviewHours * 3_600_000 + 1);
  arena.cycle();
  assert.equal(arena.view(group[0]).match.result, 'paid');
  const settled = snapshot();
  const balances = group.reduce((sum, playerId) => sum + arena.view(playerId).balance, 0);
  assert.equal(balances + settled.burned + settled.treasury, group.length * settings.startingCredits);
  arena.cycle();
  assert.deepEqual(snapshot(), settled);
});

test('queued and active stakes are returned once on restart, and queue entries expire', () => {
  const { arena, makeGroup, restart, settings, advance } = fixture();
  const expired = makeGroup(1, 'test')[0];
  advance(settings.queueSeconds * 1000);
  arena.cycle();
  assert.equal(arena.view(expired).balance, settings.startingCredits);
  assert.equal(arena.view(expired).queue, null);
  const group = makeGroup(8, 'test');
  arena.cycle();
  const waiting = makeGroup(1, 'test')[0];
  const restored = restart();
  assert.equal(restored.view(waiting).queue, null);
  for (const id of [...group, waiting]) assert.equal(restored.view(id).balance, settings.startingCredits);
  restored.restart();
  assert.equal(restored.view(group[0]).balance, settings.startingCredits);
});

test('free-mode alliances require consent and can be dissolved', () => {
  const { arena, makeGroup } = fixture();
  const [alice, bob] = makeGroup(2, 'free');
  arena.cycle();
  const a = arena.view(alice).match;
  const b = arena.view(bob).match;
  arena.diplomacy(alice, { match: a.id, target: b.player, action: 'offer' });
  assert.equal(arena.view(bob).match.diplomacy[0].accepted, false);
  assert.throws(() => arena.diplomacy(alice, { match: a.id, target: b.player, action: 'accept' }));
  arena.diplomacy(bob, { match: b.id, target: a.player, action: 'accept' });
  assert.equal(arena.view(alice).match.diplomacy[0].accepted, true);
  arena.diplomacy(alice, { match: a.id, target: b.player, action: 'break' });
  assert.deepEqual(arena.view(bob).match.diplomacy, []);
});

test('a payout over the daily cap goes to review and can be refunded', () => {
  const { arena, makeGroup, settings, advance } = fixture({ dailyPayout: 1 });
  const group = makeGroup(8, 'test');
  for (let index = 0; index < 5; index++) arena.cycle();
  advance(settings.reviewHours * 3_600_000 + 1);
  arena.cycle();
  const [entry] = arena.review();
  assert.ok(entry.flags.some(flag => flag.type === 'daily-limit'));
  arena.resolve(entry.id, 'refund');
  for (const id of group) assert.equal(arena.view(id).balance, settings.startingCredits);
  assert.throws(() => arena.resolve(entry.id, 'refund'));
});

test('repeated peaceful pairs freeze a test payout until manually approved', () => {
  const { arena, makeGroup, advance, settings } = fixture({ repeatPairs: 2 });
  const group = makeGroup(8, 'test');
  for (let index = 0; index < 5; index++) arena.cycle();
  advance(1000);
  for (const id of group) arena.join(id, 'test', 'low');
  for (let index = 0; index < 5; index++) arena.cycle();
  const [match] = arena.review();
  assert.ok(match.flags.every(flag => flag.type === 'repeated-peaceful-pair'));
  advance(settings.reviewHours * 3_600_000 + 1);
  arena.cycle();
  assert.equal(arena.view(group[0]).match.result, 'review');
  arena.resolve(match.id, 'approve');
  arena.cycle();
  assert.equal(arena.view(group[0]).match.result, 'paid');
});
