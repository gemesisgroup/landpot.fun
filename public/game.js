// The board and all calculations use integer cell and token counts.
const card = (id, title, size, seed, players) => ({ id, title, size, seed, players });
export const maps = [
  card('relay', 'Разлом', 13, 71, 16),
  card('pools', 'Три пула', 15, 112, 16),
  card('outer', 'Внешнее кольцо', 15, 209, 16),
  card('mesh', 'Большая сеть', 27, 570, 70),
];
export const colors = [
  '#61e8ab', '#ff866f', '#85a8ff', '#ffd15a', '#ee92ef', '#59d9ee',
  '#ed9f49', '#b5a1ff', '#def063', '#ec729b', '#82b5a6', '#c8a778',
  '#8ab9de', '#f5c1b4', '#c6c6d3', '#a1c46e',
];

export function random(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
}

export function neighbors(id, width) {
  const row = Math.floor(id / width);
  const col = id % width;
  const diagonal = row % 2 ? col + 1 : col - 1;
  return [[row, col - 1], [row, col + 1], [row - 1, col], [row + 1, col],
    [row - 1, diagonal], [row + 1, diagonal]]
    .filter(([y, x]) => x >= 0 && x < width && y >= 0 && y < width)
    .map(([y, x]) => y * width + x);
}

export function createGame({ map = maps[0], players = 4, seed = 1, ticks = 360, bank = 0 } = {}) {
  if (!Number.isInteger(players) || players < 2 || players > map.players) throw new Error('Invalid player count');
  const rng = random(seed ^ map.seed);
  const terrain = random(map.seed);
  const cells = Array.from({ length: map.size ** 2 }, (_, id) => {
    const row = Math.floor(id / map.size);
    const col = id % map.size;
    const center = (map.size - 1) / 2;
    const distance = Math.hypot(row - center, col - center);
    const typeRoll = terrain();
    const outerEdge = center * (1.16 + terrain() * .17);
    const broken = row % 4 === 1 && col % 3 === 1 && terrain() < .56;
    const ring = map.id === 'outer' && distance < center * .39;
    const rift = map.id === 'relay' && col === center && (row < 4 || row > map.size - 4);
    const isPool = map.id === 'pools'
      ? [[3, 5], [8, 11], [11, 4]].some(([y, x]) => y === row && x === col)
      : typeRoll < .08;
    const gap = !(map.id === 'pools' && isPool) && (distance > outerEdge || broken || ring || rift);
    return { id, type: gap ? 'gap' : isPool ? 'pool' : typeRoll < .16 ? 'node' : 'block',
      owner: -1, units: gap ? 0 : 3 + Math.floor(terrain() * 4) };
  });
  // A noisy coastline may leave isolated cells. Keep only the largest connected field.
  const unvisited = new Set(cells.filter(cell => cell.type !== 'gap').map(cell => cell.id));
  let connected = new Set();
  for (const first of unvisited) {
    const area = new Set([first]);
    unvisited.delete(first);
    for (const id of area) {
      for (const adjacent of neighbors(id, map.size)) {
        if (unvisited.delete(adjacent)) area.add(adjacent);
      }
    }
    if (area.size > connected.size) connected = area;
  }
  for (const cell of cells) {
    if (!connected.has(cell.id)) { cell.type = 'gap'; cell.units = 0; }
  }
  // Spread starting points by repeatedly choosing the most distant available cell.
  const starts = [];
  const playable = cells.filter(cell => cell.type !== 'gap');
  let candidates = [...playable];
  for (let index = 0; index < players; index++) {
    const rank = candidates.map(cell => {
      const range = starts.length ? Math.min(...starts.map(start => Math.hypot(
        Math.floor(cell.id / map.size) - Math.floor(start / map.size),
        cell.id % map.size - start % map.size,
      ))) : -Math.abs(Math.hypot(Math.floor(cell.id / map.size) - (map.size - 1) / 2,
        cell.id % map.size - (map.size - 1) / 2) - map.size * .38);
      return { cell, score: range + rng() * .8 };
    }).sort((a, b) => b.score - a.score);
    const start = rank[0].cell;
    start.owner = index;
    start.units = 44;
    starts.push(start.id);
    candidates = candidates.filter(cell => cell.id !== start.id);
  }
  return { map: map.id, width: map.size, cells, players, bank, tick: 0, ticks, ended: false, seed };
}

export function order(game, player, from, to, percent) {
  if (game.ended || !Number.isInteger(player) || player < 0 || player >= game.players
    || !Number.isInteger(from) || !Number.isInteger(to)
    || !Number.isInteger(percent) || percent < 10 || percent > 95) return false;
  const source = game.cells[from];
  const target = game.cells[to];
  if (!source || !target || source.owner !== player || target.type === 'gap'
    || !neighbors(from, game.width).includes(to)) return false;
  const amount = Math.min(source.units - 1, Math.floor(source.units * percent / 100));
  if (amount < 1) return false;
  source.units -= amount;
  if (target.owner === player) target.units = Math.min(199, target.units + amount);
  else if (amount > target.units) {
    target.owner = player;
    target.units = amount - target.units;
  } else {
    target.units = Math.max(1, target.units - amount);
  }
  return true;
}

export function standings(game) {
  const land = Array(game.players).fill(0);
  for (const cell of game.cells) if (cell.owner >= 0) land[cell.owner]++;
  const occupied = land.reduce((sum, count) => sum + count, 0);
  const rows = land.map((count, player) => {
    const weighted = count * game.bank;
    return { player, count, share: occupied ? count / occupied : 0,
      payout: occupied ? Math.floor(weighted / occupied) : 0, remainder: occupied ? weighted % occupied : 0 };
  });
  const unallocated = game.bank - rows.reduce((sum, row) => sum + row.payout, 0);
  if (occupied) rows.filter(row => row.count).sort((a, b) => b.remainder - a.remainder || a.player - b.player)
    .slice(0, unallocated).forEach(row => row.payout++);
  return rows.sort((a, b) => b.count - a.count || a.player - b.player);
}

export function step(game) {
  if (game.ended) return;
  game.tick++;
  if (game.tick % 2 === 0) {
    for (const cell of game.cells) {
      if (cell.owner < 0) continue;
      const supplied = neighbors(cell.id, game.width).some(id => {
        const neighbor = game.cells[id];
        return neighbor.type === 'node' && neighbor.owner === cell.owner;
      });
      cell.units = Math.min(199, cell.units + (cell.type === 'pool' ? 3 : 1) + Number(supplied));
    }
  }
  const ranking = standings(game);
  game.ended = game.tick >= game.ticks || ranking[1].count === 0
    || ranking[0].count >= Math.ceil(game.cells.filter(cell => cell.type !== 'gap').length * .85);
}

export function botTurn(game, player) {
  const rng = random(game.seed ^ (game.tick * 983 + player * 4099));
  const options = [];
  for (const source of game.cells) {
    if (source.owner !== player || source.units < 10) continue;
    for (const to of neighbors(source.id, game.width)) {
      const target = game.cells[to];
      if (target.type === 'gap' || target.owner === player || source.units * .7 <= target.units) continue;
      options.push({ from: source.id, to, score: rng() * 20 + (target.type === 'pool' ? 8 : 0)
        + (target.type === 'node' ? 4 : 0) + (target.owner < 0 ? 6 : 0) - target.units / 3 });
    }
  }
  options.sort((a, b) => b.score - a.score);
  const choice = options[0];
  if (choice) order(game, player, choice.from, choice.to, 72);
}
