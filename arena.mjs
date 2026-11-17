import { randomInt, randomUUID } from 'node:crypto';
import { createGame, maps, order, standings, step } from './public/game.js';
import { config } from './config.mjs';

const shuffle = values => {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
};
const sum = values => values.reduce((total, value) => total + value, 0);
const hour = 3_600_000;
const day = 24 * hour;

export function createArena({ load, save, now = Date.now, settings = config }) {
  const state = load() ?? { users: {}, queues: [], matches: {}, treasury: 0, burned: 0, replays: [] };
  const persist = () => save(state);
  const registered = (id) => state.users[id];
  const requireUser = (id) => {
    const user = registered(id);
    if (!user) throw new Error('Откройте игру заново, чтобы получить сессию');
    return user;
  };
  const active = (id) => Object.values(state.matches).find(match => !match.game.ended && match.members.includes(id));

  function register() {
    const id = randomUUID();
    state.users[id] = { balance: settings.startingCredits, rating: 1000, games: 0, daily: {} };
    persist();
    return id;
  }

  function join(id, mode, tier) {
    const user = requireUser(id);
    if (!['free', 'test'].includes(mode)) throw new Error('Неизвестный режим');
    if (mode === 'test' && !Object.hasOwn(settings.stakes, tier)) throw new Error('Неизвестный уровень');
    if (active(id) || state.queues.some(item => item.id === id)) throw new Error('Вы уже в очереди или матче');
    const level = mode === 'test' ? settings.stakes[tier] : { stake: 0, games: 0, rating: 0 };
    if (user.games < level.games || user.rating < level.rating) throw new Error('Уровень пока закрыт');
    if (user.balance < level.stake) throw new Error('Недостаточно тестовых токенов');
    if (level.stake * settings.paidMin > settings.maxPot) throw new Error('Ставка превышает лимит банка');
    user.balance -= level.stake;
    state.queues.push({ id, mode, tier: mode === 'free' ? 'free' : tier, stake: level.stake,
      until: now() + settings.queueSeconds * 1000 });
    persist();
  }

  function leave(id) {
    const user = requireUser(id);
    const index = state.queues.findIndex(item => item.id === id);
    if (index < 0) throw new Error('Вы не в очереди');
    const [entry] = state.queues.splice(index, 1);
    user.balance += entry.stake;
    persist();
  }

  function start(group) {
    const mode = group[0].mode;
    const gross = sum(group.map(entry => entry.stake));
    const burn = Math.floor(gross * settings.burnBps / 10000);
    const treasury = Math.floor(gross * settings.treasuryBps / 10000);
    const map = mode === 'free' ? maps[3] : maps[randomInt(3)];
    const members = shuffle(group.map(entry => entry.id));
    const seed = randomInt(1, 2 ** 31);
    const game = createGame({ map, players: members.length, seed, bank: gross - burn - treasury,
      ticks: Math.ceil(settings.matchSeconds * 1000 / settings.tickMs) });
    const id = randomUUID();
    state.matches[id] = { id, game, mode, members, gross, burn, treasury, stake: group[0].stake,
      commands: [], lastOrder: {}, diplomacy: [], result: mode === 'free' ? 'free' : 'playing', startedAt: now() };
    state.queues = state.queues.filter(entry => !members.includes(entry.id));
  }

  function command(id, { match: matchId, from, to, percent }) {
    requireUser(id);
    const match = state.matches[matchId];
    const player = match?.members.indexOf(id) ?? -1;
    if (player < 0 || match.game.ended) throw new Error('Матч завершён или недоступен');
    const at = now();
    if (at - (match.lastOrder[player] ?? -Infinity) < 260) throw new Error('Слишком много команд');
    const opponent = Number.isInteger(to) ? match.game.cells[to]?.owner : undefined;
    if (opponent >= 0 && player !== opponent && allies(match, player, opponent)) throw new Error('Этот игрок — союзник');
    if (!order(match.game, player, from, to, percent)) throw new Error('Команда недоступна');
    match.lastOrder[player] = at;
    match.commands.push({ tick: match.game.tick, player, from, to, percent, at, opponent });
    persist();
  }

  function allies(match, left, right) {
    return match.diplomacy?.some(pair => pair.accepted
      && (pair.from === left && pair.to === right || pair.from === right && pair.to === left));
  }

  function diplomacy(id, { match: matchId, target, action }) {
    requireUser(id);
    const match = state.matches[matchId];
    const player = match?.members.indexOf(id) ?? -1;
    if (player < 0 || match.mode !== 'free' || match.game.ended || !Number.isInteger(target)
      || target < 0 || target >= match.members.length || target === player) throw new Error('Союз недоступен');
    const pairs = match.diplomacy;
    const pair = pairs.find(item => item.from === player && item.to === target
      || item.to === player && item.from === target);
    if (action === 'break' && pair) pairs.splice(pairs.indexOf(pair), 1);
    else if (action === 'offer' && !pair) pairs.push({ from: player, to: target, accepted: false });
    else if (action === 'accept' && pair && pair.to === player) pair.accepted = true;
    else throw new Error('Команда союза недоступна');
    persist();
  }

  function inspect(match) {
    const flags = [];
    for (let player = 0; player < match.members.length; player++) {
      const times = match.commands.filter(command => command.player === player).map(command => command.at);
      if (times.length < settings.regularTiming) continue;
      const intervals = times.slice(1).map((time, index) => time - times[index]);
      const average = sum(intervals) / intervals.length;
      const variance = sum(intervals.map(interval => (interval - average) ** 2)) / intervals.length;
      if (Math.sqrt(variance) < settings.timingDeviationMs) flags.push({ type: 'regular-timing', player });
    }
    for (let left = 0; left < match.members.length; left++) {
      for (let right = left + 1; right < match.members.length; right++) {
        const previous = state.replays.filter(replay => replay.members.includes(match.members[left])
          && replay.members.includes(match.members[right]));
        if (previous.length < settings.repeatPairs - 1) continue;
        const contested = match.commands.some(command => command.opponent === right && command.player === left
          || command.opponent === left && command.player === right);
        if (!contested && previous.every(replay => !(replay.conflicts ?? []).includes(
          [match.members[left], match.members[right]].sort().join(':')))) {
          flags.push({ type: 'repeated-peaceful-pair', players: [left, right] });
        }
      }
    }
    return flags;
  }

  function finish(match) {
    match.finishedAt = now();
    if (match.mode !== 'test') return;
    match.flags = inspect(match);
    const ranking = standings(match.game);
    const ratings = match.members.map(id => state.users[id].rating);
    for (const row of ranking) {
      const expected = sum(ratings.map((rating, index) => index === row.player ? 0
        : 1 / (1 + 10 ** ((rating - ratings[row.player]) / 400)))) / (ratings.length - 1);
      const actual = sum(ranking.map(other => other.player === row.player ? 0
        : row.count === other.count ? .5 : Number(row.count > other.count))) / (ratings.length - 1);
      const user = state.users[match.members[row.player]];
      user.rating += Math.round(32 * (actual - expected));
      user.games++;
    }
    match.result = match.flags.length ? 'review' : 'pending';
    match.releaseAt = now() + settings.reviewHours * hour;
    const conflicts = [...new Set(match.commands.filter(command => command.opponent >= 0
      && command.opponent !== command.player).map(command => [
      match.members[command.player], match.members[command.opponent],
    ].sort().join(':')))];
    state.replays.push({ id: match.id, members: match.members, map: match.game.map, seed: match.game.seed,
      ticks: match.game.ticks, endTick: match.game.tick, bank: match.game.bank,
      commands: match.commands, conflicts, finishedAt: match.finishedAt, ranking });
  }

  function resolve(id, action) {
    const match = state.matches[id];
    if (!match || match.result !== 'review') throw new Error('Матч не ожидает проверки');
    if (action === 'refund') {
      for (const user of match.members) state.users[user].balance += match.stake;
      match.result = 'refunded';
    } else if (action === 'approve') {
      match.result = 'pending';
      match.reviewed = true;
    } else throw new Error('Неизвестное решение');
    persist();
  }

  function pay(match) {
    const date = new Date(now()).toISOString().slice(0, 10);
    const ranking = standings(match.game);
    if (ranking.some(row => {
      const user = state.users[match.members[row.player]];
      return (user.daily[date] ?? 0) + row.payout > settings.dailyPayout;
    })) {
      match.result = 'review';
      match.flags.push({ type: 'daily-limit' });
      return;
    }
    for (const row of ranking) {
      const user = state.users[match.members[row.player]];
      user.balance += row.payout;
      user.daily = { [date]: (user.daily[date] ?? 0) + row.payout };
    }
    state.burned += match.burn;
    state.treasury += match.treasury;
    match.result = 'paid';
  }

  function cycle() {
    let changed = false;
    const time = now();
    for (const entry of state.queues.filter(item => item.until <= time)) {
      state.users[entry.id].balance += entry.stake;
      changed = true;
    }
    state.queues = state.queues.filter(item => item.until > time);
    for (const tier of ['free', 'low', 'mid', 'high']) {
      const ready = shuffle(state.queues.filter(item => item.tier === tier));
      const min = tier === 'free' ? settings.freeMin : settings.paidMin;
      const max = tier === 'free' ? 70 : Math.min(settings.paidMax, Math.floor(settings.maxPot / settings.stakes[tier].stake));
      while (max >= min && ready.length >= min) {
        const count = Math.min(max, ready.length);
        start(ready.splice(0, count));
        changed = true;
      }
    }
    for (const match of Object.values(state.matches)) {
      if (!match.game.ended) {
        step(match.game);
        if (match.game.ended) finish(match);
        changed = true;
      } else if (match.result === 'pending' && match.releaseAt <= time) {
        pay(match);
        changed = true;
      } else if (['paid', 'refunded', 'free'].includes(match.result)
        && time - match.finishedAt >= settings.replayDays * day) {
        delete state.matches[match.id];
        changed = true;
      }
    }
    const replays = state.replays.filter(replay => time - replay.finishedAt < settings.replayDays * day);
    if (replays.length !== state.replays.length) {
      state.replays = replays;
      changed = true;
    }
    if (changed) persist();
  }

  function view(id) {
    const user = requireUser(id);
    const entry = state.queues.find(item => item.id === id);
    const match = active(id) ?? Object.values(state.matches).filter(item => item.members.includes(id))
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    return {
      balance: user.balance, rating: user.rating, games: user.games, stakes: settings.stakes, tickMs: settings.tickMs,
      queue: entry ? { mode: entry.mode, tier: entry.tier, until: entry.until,
        count: state.queues.filter(item => item.tier === entry.tier).length,
        min: entry.mode === 'free' ? settings.freeMin : settings.paidMin } : null,
      match: match && !entry ? { id: match.id, game: match.game, player: match.members.indexOf(id),
        mode: match.mode, result: match.result, releaseAt: match.releaseAt,
        diplomacy: match.diplomacy?.filter(pair => pair.from === match.members.indexOf(id)
          || pair.to === match.members.indexOf(id)) } : null,
      season: Object.entries(state.users).filter(([, entry]) => entry.games)
        .sort((a, b) => b[1].rating - a[1].rating || b[1].games - a[1].games)
        .slice(0, 10).map(([userId, entry], index) => ({ position: index + 1,
          label: id === userId ? 'Вы' : 'Player ' + (index + 1), rating: entry.rating, games: entry.games })),
    };
  }

  function restart() {
    for (const entry of [...state.queues]) leave(entry.id);
    for (const match of Object.values(state.matches)) {
      if (match.game.ended) continue;
      for (const id of match.members) state.users[id].balance += match.stake;
      match.game.ended = true;
      match.finishedAt = now();
      match.result = 'refunded';
    }
    persist();
  }

  return { register, registered, join, leave, command, diplomacy, cycle, view, resolve, restart,
    review: () => Object.values(state.matches).filter(match => match.result === 'review')
      .map(({ id, flags, releaseAt }) => ({ id, flags, releaseAt })),
    replay: id => state.replays.find(replay => replay.id === id) };
}
