import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createArena } from './arena.mjs';
import { config } from './config.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/game.js', ['game.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const files = new Map([...assets].map(([url, [name, type]]) => [
  url, { type, content: readFileSync(new URL('./public/' + name, import.meta.url)) },
]));
const hash = value => createHash('sha256').update(value).digest();

export function startServer({
  port = Number(process.env.PORT ?? 3000),
  host = process.env.HOST ?? '127.0.0.1',
  database = process.env.LANDPOT_DB ?? 'data/landpot.db',
  admin = process.env.LANDPOT_ADMIN_TOKEN ?? '',
  settings = config,
} = {}) {
  if (database !== ':memory:') mkdirSync(dirname(resolve(database)), { recursive: true });
  const db = new DatabaseSync(database);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS arena (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)');
  const read = db.prepare('SELECT data FROM arena WHERE id = 1');
  const write = db.prepare('INSERT INTO arena VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data');
  const arena = createArena({
    load: () => JSON.parse(read.get()?.data ?? 'null'),
    save: data => write.run(JSON.stringify(data)),
    settings,
  });
  arena.restart();
  const loop = setInterval(() => {
    try { arena.cycle(); }
    catch (error) {
      console.error('Arena persistence failed:', error);
      // Restart from the last committed state instead of accepting further commands.
      process.exitCode = 1;
      clearInterval(loop);
      server.close();
    }
  }, settings.tickMs);
  const server = createServer(async (req, res) => {
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'");
    const path = (req.url ?? '/').split('?')[0];
    try {
      const file = files.get(path);
      if (file && req.method === 'GET') {
        res.writeHead(200, { 'content-type': file.type });
        res.end(file.content);
        return;
      }
      if (!path.startsWith('/api/')) return json(404, { error: 'Страница не найдена' });
      const adminRoute = path.startsWith('/api/admin/');
      if (adminRoute && (!admin || !timingSafeEqual(hash(req.headers.authorization ?? ''), hash('Bearer ' + admin)))) {
        return json(403, { error: 'Доступ закрыт' });
      }
      if (req.method === 'POST' && req.headers['sec-fetch-site'] === 'cross-site') {
        return json(403, { error: 'Запрос недоступен с другого сайта' });
      }
      let id = /(?:^|;\s*)landpot=([\da-f-]{36})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
      if (path === '/api/state' && req.method === 'GET') {
        if (!id || !arena.registered(id)) {
          id = arena.register();
          const tls = process.env.LANDPOT_SECURE_COOKIE === '1' || req.socket.encrypted;
          res.setHeader('set-cookie', 'landpot=' + id + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000' + (tls ? '; Secure' : ''));
        }
        return json(200, arena.view(id));
      }
      if (path === '/api/admin/review' && req.method === 'GET') return json(200, arena.review());
      if (path.startsWith('/api/admin/replay/') && req.method === 'GET') {
        const replay = arena.replay(path.split('/').at(-1));
        return replay ? json(200, replay) : json(404, { error: 'Реплей не найден' });
      }
      if (req.method !== 'POST') return json(404, { error: 'Команда не найдена' });
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return json(415, { error: 'Ожидается JSON' });
      }
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 4096) return json(413, { error: 'Запрос слишком большой' });
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'Ожидается объект' });
      if (path === '/api/join') arena.join(id, body.mode, body.tier);
      else if (path === '/api/leave') arena.leave(id);
      else if (path === '/api/order') arena.command(id, body);
      else if (path === '/api/diplomacy') arena.diplomacy(id, body);
      else if (path === '/api/admin/review') {
        arena.resolve(body.id, body.action);
        return json(200, { ok: true });
      } else return json(404, { error: 'Команда не найдена' });
      return json(200, arena.view(id));
    } catch (error) {
      return json(400, { error: error instanceof SyntaxError ? 'Некорректный JSON' : error.message });
    }
  });
  server.on('close', () => { clearInterval(loop); db.close(); });
  server.listen(port, host, () => console.log('Landpot listening on ' + host + ':' + server.address().port));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { values } = parseArgs({ options: {
    host: { type: 'string' }, port: { type: 'string' }, strictPort: { type: 'boolean' },
  } });
  startServer({ host: values.host, port: values.port === undefined ? undefined : Number(values.port) });
}
