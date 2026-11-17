import { readFile } from 'node:fs/promises';
import { createGame, maps, order, standings, step } from '../public/game.js';

export function reproduce(replay) {
  const map = maps.find(item => item.id === replay.map);
  if (!map) throw new Error('Unknown replay map');
  const game = createGame({ map, players: replay.members.length, seed: replay.seed,
    ticks: replay.ticks, bank: replay.bank });
  let index = 0;
  while (!game.ended && game.tick < replay.endTick) {
    while (replay.commands[index]?.tick === game.tick) {
      const { player, from, to, percent } = replay.commands[index++];
      if (!order(game, player, from, to, percent)) throw new Error('Invalid replay command ' + index);
    }
    step(game);
  }
  const ranking = standings(game);
  if (index !== replay.commands.length || game.tick !== replay.endTick
    || JSON.stringify(ranking) !== JSON.stringify(replay.ranking)) throw new Error('Replay does not match the recorded result');
  return ranking;
}

if (process.argv[1]?.endsWith('/replay.mjs')) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/replay.mjs match.json');
  console.log(JSON.stringify(reproduce(JSON.parse(await readFile(process.argv[2], 'utf8'))), null, 2));
}
