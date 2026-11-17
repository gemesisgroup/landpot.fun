import { botTurn, colors, createGame, maps, neighbors, order, standings, step } from './game.js';

const $ = id => document.getElementById(id);
const board = $('board');
const modes = ['demo', 'free', 'test'];
const palette = player => colors[player] ?? 'hsl(' + (player * 137.508 % 360) + ' 73% 67%)';
const fragments = new Map();
let mode = 'demo';
let game = createGame({ bank: 100 });
let playing = false;
let player = 0;
let selected = null;
let cursor = null;
let layout = [];
let state = null;
let busy = false;
let generation = 0;
let tickMs = 500;
let boardKey = '';
let allyCommand = '';

for (const map of maps) $('map-select').add(new Option(map.title, map.id));
$('troops').addEventListener('input', () => { $('troop-value').value = $('troops').value + '%'; });

function geometry(game, width, height) {
  const radius = Math.min(width / (Math.sqrt(3) * (game.width + 1)), height / (1.5 * game.width + 1.5));
  const size = Math.sqrt(3) * radius;
  const left = (width - size * (game.width + .5)) / 2 + size / 2;
  const top = (height - (1.5 * game.width + .5) * radius) / 2 + radius;
  return game.cells.map(cell => {
    const row = Math.floor(cell.id / game.width);
    return { x: left + ((cell.id % game.width) + (row % 2 ? .5 : 0)) * size, y: top + row * 1.5 * radius, radius };
  });
}

function hex(ctx, x, y, r) {
  ctx.beginPath();
  for (let index = 0; index < 6; index++) {
    const angle = Math.PI / 180 * (60 * index - 90);
    const px = x + r * Math.cos(angle);
    const py = y + r * Math.sin(angle);
    if (!index) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function draw(canvas, snapshot, hero = false) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return [];
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#48624d60';
  for (let y = 9; y < height; y += 16) for (let x = 9; x < width; x += 16) ctx.fillRect(x, y, 1, 1);

  const points = geometry(snapshot, width, height);
  const radius = points[0].radius;
  const near = selected === null || hero ? [] : neighbors(selected, snapshot.width);
  for (const cell of snapshot.cells) {
    if (cell.type === 'gap') continue;
    const { x, y } = points[cell.id];
    const tint = cell.owner >= 0 ? palette(cell.owner) : '#8caa8e';
    hex(ctx, x, y, radius * .95);
    ctx.fillStyle = tint;
    ctx.globalAlpha = cell.owner >= 0 ? (hero ? .35 : .31) : .12;
    ctx.fill();
    ctx.globalAlpha = 1;
    const highlight = !hero && (cell.id === selected || cell.id === cursor || near.includes(cell.id));
    ctx.strokeStyle = highlight ? '#f2ffce' : cell.owner >= 0 ? tint : '#3a5141';
    ctx.lineWidth = highlight ? 2 : .8;
    ctx.globalAlpha = highlight ? 1 : .78;
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (cell.type === 'node' || cell.type === 'pool') {
      ctx.fillStyle = tint;
      ctx.font = Math.max(8, radius * .75) + 'px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(cell.type === 'pool' ? '◎' : '◇', x, y - (hero ? 0 : radius * .33));
    }
    if (!hero && radius > 10) {
      ctx.fillStyle = cell.owner >= 0 ? '#f7f5df' : '#a6baa7';
      ctx.font = '600 ' + Math.max(8, radius * .57) + 'px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(cell.units, x, y + (cell.type === 'block' ? 0 : radius * .25));
    }
  }
  return points;
}

const heroGame = createGame({ map: maps[2], players: 4, seed: 589 });
for (let turn = 0; turn < 52; turn++) {
  for (let actor = 0; actor < heroGame.players; actor++) botTurn(heroGame, actor);
  step(heroGame);
}
function renderHero() { draw($('terrain'), heroGame, true); }
new ResizeObserver(renderHero).observe($('terrain'));
new ResizeObserver(() => { layout = draw(board, game); }).observe(board);

function setHint(message) { $('hint').textContent = message; }
function setMode(next) {
  mode = next;
  playing = false;
  selected = null;
  cursor = null;
  for (const target of modes) $(target + '-mode').classList.toggle('active', target === mode);
  $('demo-controls').hidden = mode !== 'demo';
  $('queue-controls').hidden = mode === 'demo';
  $('tier').hidden = mode !== 'test';
  $('tier-label').hidden = mode !== 'test';
  $('diplomacy').hidden = true;
  if (mode === 'demo') resetDemo();
  else renderOnline();
}
function resetDemo(start = false) {
  const map = maps.find(item => item.id === $('map-select').value) ?? maps[0];
  game = createGame({ map, players: 4, bank: 100, seed: start ? Math.floor(Math.random() * 2 ** 30) + 1 : 1 });
  tickMs = 500;
  player = 0;
  selected = null;
  cursor = game.cells.find(cell => cell.owner === player)?.id;
  playing = start;
  setHint('Выбери свой блок, затем соседний.');
  render();
}

function playerName(index) {
  if (index === player) return 'Вы';
  return mode === 'demo' ? 'Бот ' + index : 'Player ' + (index + 1);
}

function render() {
  $('mode-label').textContent = { demo: 'ТРЕНИРОВКА', free: 'БЕСПЛАТНЫЙ МАТЧ', test: 'ТЕСТОВЫЙ БАНК' }[mode];
  $('map-title').textContent = maps.find(map => map.id === game.map).title;
  const seconds = Math.max(0, Math.ceil((game.ticks - game.tick) * tickMs / 1000));
  $('clock').textContent = game.ended ? '00:00' : String(Math.floor(seconds / 60)).padStart(2, '0')
    + ':' + String(seconds % 60).padStart(2, '0');
  $('bank').textContent = String(game.bank);
  $('board-overlay').hidden = playing && !game.ended;
  $('overlay-label').textContent = game.ended ? 'Раунд завершён' : mode === 'demo' ? 'Тренировочный матч' : 'Ожидание соперников';
  $('overlay-action').hidden = mode !== 'demo';
  $('overlay-action').textContent = game.ended ? 'Ещё матч ↗' : 'Начать матч ↗';

  const rankings = standings(game).map(row => ({ ...row, name: playerName(row.player) }));
  const nextKey = JSON.stringify(rankings);
  if (nextKey !== boardKey) {
    boardKey = nextKey;
    $('leaders').replaceChildren(...rankings.map(row => {
      const item = document.createElement('li');
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.setProperty('--player', palette(row.player));
      const name = document.createElement('span');
      name.textContent = row.name;
      const scores = document.createElement('data');
      scores.textContent = row.count + ' / ' + row.payout;
      item.append(swatch, name, scores);
      return item;
    }));
  }
  layout = draw(board, game);
}

function renderOnline() {
  if (!state) return;
  const live = state.match?.mode === mode ? state.match : null;
  if (live) {
    game = live.game;
    player = live.player;
    if (cursor === null) cursor = game.cells.find(cell => cell.owner === player)?.id;
    if (selected !== null && game.cells[selected]?.owner !== player) selected = null;
    if (game.ended) {
      const label = { review: 'В ручной проверке', pending: 'Выплата после проверки', paid: 'Выплачено', refunded: 'Взнос возвращён', free: 'Матч завершён' };
      setHint(label[live.result] ?? 'Матч завершён');
    }
  } else if (!state.queue) {
    game = createGame({ map: mode === 'free' ? maps[3] : maps[0], bank: 0 });
    player = 0;
  } else if (game.ended) {
    game = createGame({ map: mode === 'free' ? maps[3] : maps[0], bank: 0 });
    player = 0;
  }
  playing = Boolean(live);
  tickMs = state.tickMs;
  $('profile').textContent = state.balance + ' тест. токенов · рейтинг ' + state.rating;
  const active = state.match && !state.match.game.ended;
  $('queue-action').disabled = busy || Boolean(active);
  $('queue-action').textContent = state.queue ? 'Выйти из очереди' : 'Встать в очередь';
  $('queue-label').textContent = state.queue ? state.queue.count + ' / ' + state.queue.min + ' в очереди' : '';
  if (!$('tier').options.length) {
    for (const [tier, info] of Object.entries(state.stakes)) {
      $('tier').add(new Option(tier.toUpperCase() + ' · ' + info.stake, tier));
    }
  }
  for (const option of $('tier').options) {
    const { games, rating } = state.stakes[option.value];
    option.disabled = state.games < games || state.rating < rating;
    option.title = games + ' матчей · рейтинг ' + rating;
  }
  renderDiplomacy(live);
  render();
}

function renderDiplomacy(match) {
  $('diplomacy').hidden = match?.mode !== 'free' || match.game.ended;
  if ($('diplomacy').hidden) return;
  const picker = $('ally-player');
  if (picker.dataset.match !== match.id) {
    picker.dataset.match = match.id;
    picker.replaceChildren();
    for (let other = 0; other < match.game.players; other++) {
      if (other !== player) picker.add(new Option(playerName(other), other));
    }
  }
  const target = Number(picker.value);
  const pair = match.diplomacy?.find(item => item.from === target || item.to === target);
  allyCommand = pair?.accepted ? 'break' : pair?.to === player ? 'accept' : pair ? 'break' : 'offer';
  $('ally-action').textContent = pair?.accepted ? 'Разорвать союз' : pair?.to === player ? 'Принять союз'
    : pair ? 'Отменить предложение' : 'Предложить союз';
}

function updateState(next) {
  state = next;
  $('server-status').textContent = 'Сервер онлайн';
  $('free-mode').disabled = false;
  $('test-mode').disabled = false;
  const seasonKey = JSON.stringify(state.season);
  if (seasonKey !== fragments.get('season')) {
    fragments.set('season', seasonKey);
    const rows = state.season.map(row => row.label + ' · ' + row.rating + ' · матчей: ' + row.games);
    $('season-list').replaceChildren(...(rows.length ? rows : ['Рейтинг появится после первого тестового матча.'])
      .map(label => Object.assign(document.createElement('li'), { textContent: label })));
  }
  if (mode !== 'demo') renderOnline();
}

async function request(path, body) {
  const response = await fetch('/api/' + path, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : undefined);
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) throw new Error('Сервер недоступен');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Команда недоступна');
  return data;
}

let offline = false;
async function refresh() {
  if (offline) return;
  if (busy) { setTimeout(refresh, 700); return; }
  const requestGeneration = generation;
  try {
    const next = await request('state');
    if (requestGeneration === generation) updateState(next);
  } catch {
    if (requestGeneration === generation) {
      if (!state) offline = true;
      $('server-status').textContent = 'Локальное демо';
    }
  }
  if (!offline) setTimeout(refresh, 700);
}

async function post(path, body) {
  if (busy) return;
  busy = true;
  generation++;
  try { updateState(await request(path, body)); }
  catch (error) { setHint(error.message); }
  finally {
    busy = false;
    if (mode !== 'demo') renderOnline();
  }
}

function choose(id) {
  if (!playing || game.ended) return;
  const cell = game.cells[id];
  if (!cell || cell.type === 'gap') return;
  if (selected === null || !neighbors(selected, game.width).includes(id)) {
    if (cell.owner !== player) { setHint('Сначала выбери свой блок.'); return; }
    selected = id;
    setHint('Теперь выбери соседний блок.');
    render();
    return;
  }
  const from = selected;
  const percent = Number($('troops').value);
  if (mode !== 'demo' && busy) { setHint('Повтори команду после обновления карты.'); return; }
  selected = cell.owner === player ? id : null;
  setHint('Выбери следующий блок для манёвра.');
  if (mode === 'demo') {
    if (!order(game, player, from, id, percent)) setHint('Для этой команды недостаточно войск.');
    else if (cell.owner === player) selected = id;
    render();
  } else if (state?.match) {
    void post('order', { match: state.match.id, from, to: id, percent });
    render();
  }
}

board.addEventListener('pointerup', event => {
  const rect = board.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  let nearest = -1;
  let best = Infinity;
  for (const [id, spot] of layout.entries()) {
    if (game.cells[id].type === 'gap') continue;
    const distance = Math.hypot(spot.x - x, spot.y - y);
    if (distance <= spot.radius && distance < best) { nearest = id; best = distance; }
  }
  if (nearest >= 0) { cursor = nearest; choose(nearest); }
});
board.addEventListener('keydown', event => {
  if (!playing || game.ended) return;
  if (event.key === 'Escape') { selected = null; render(); return; }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    choose(cursor);
    return;
  }
  const directions = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  const vector = directions[event.key];
  if (!vector) return;
  event.preventDefault();
  if (cursor === null) cursor = game.cells.find(cell => cell.owner === player)?.id;
  if (cursor === null || cursor === undefined) return;
  const origin = layout[cursor];
  const options = layout.map((point, id) => {
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    const direction = dx * vector[0] + dy * vector[1];
    return { id, direction, score: Math.hypot(dx, dy) + 2 * Math.abs(dx * vector[1] - dy * vector[0]) };
  }).filter(option => option.direction > 1 && game.cells[option.id].type !== 'gap')
    .sort((a, b) => a.score - b.score);
  cursor = options[0]?.id ?? cursor;
  render();
});
for (const target of modes) $(target + '-mode').addEventListener('click', () => setMode(target));
$('map-select').addEventListener('change', () => resetDemo());
$('overlay-action').addEventListener('click', () => { resetDemo(true); board.focus(); });
$('ally-player').addEventListener('change', () => renderDiplomacy(state?.match));
$('ally-action').addEventListener('click', () => {
  if (state?.match) void post('diplomacy', { match: state.match.id, target: Number($('ally-player').value), action: allyCommand });
});
$('queue-action').addEventListener('click', () => {
  if (state?.queue) void post('leave', {});
  else void post('join', { mode, tier: $('tier').value });
});
setInterval(() => {
  if (mode !== 'demo' || !playing || game.ended) return;
  if (game.tick % 3 === 0) {
    for (let actor = 1; actor < game.players; actor++) botTurn(game, actor);
  }
  step(game);
  if (game.ended) setHint('Твоя доля: ' + standings(game).find(row => row.player === player).payout + ' тестовых токенов.');
  render();
}, 500);
resetDemo();
void refresh();
