import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { startServer } from '../server.mjs';
import { config } from '../config.mjs';

test('HTTP serves the game and accepts a cookie-authenticated test queue flow', async t => {
  const server = startServer({ port: 0, database: ':memory:', settings: { ...config, tickMs: 1000 } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const home = await fetch(base);
  assert.match(await home.text(), /Landpot/);
  const register = await fetch(base + '/api/state');
  const cookie = register.headers.get('set-cookie').split(';')[0];
  const baseline = await register.json();
  const post = (path, body, headers = {}) => fetch(base + '/api/' + path, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const anonymous = await fetch(base + '/api/admin/review');
  assert.equal(anonymous.status, 403);
  assert.equal((await post('join', { mode: 'test', tier: 'low' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  const joined = await post('join', { mode: 'test', tier: 'low' });
  assert.equal(joined.status, 200);
  const state = await joined.json();
  assert.equal(state.queue.count, 1);
  assert.equal(state.balance, baseline.balance - baseline.stakes.low.stake);
  const left = await post('leave', {});
  assert.equal((await left.json()).balance, baseline.balance);
});
