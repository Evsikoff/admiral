import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { createUsersHandler } from './users.js';

const appId = '12345';
const appSecret = 'example-secret';
const deviceId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '50001';

function signedLaunch(user = userId) {
  const params = new URLSearchParams({
    vk_app_id: appId,
    vk_user_id: user,
    vk_ts: String(Math.floor(Date.now() / 1000)),
  });
  params.sort();
  const payload = Array.from(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  params.set('sign', createHmac('sha256', appSecret).update(payload).digest('base64url'));
  return `?${params}`;
}

async function setup(t, { initialRows = [], configured = true } = {}) {
  const rows = initialRows.map((row) => ({ ...row }));
  const calls = [];
  let nextId = 1;
  async function fetchImpl(url, init = {}) {
    calls.push({ url, init });
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/rest/v1/admiral_users');
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      rows.push({ id: nextId++, ...body });
      return { ok: true, status: 201 };
    }
    const field = ['device_id', 'vk_id'].find((key) => parsed.searchParams.has(key));
    assert.ok(field);
    const value = parsed.searchParams.get(field).slice(3);
    const matches = rows.filter((row) => row[field] === value).slice(0, Number(parsed.searchParams.get('limit')));
    return { ok: true, status: 200, json: async () => matches.map(({ id }) => ({ id })) };
  }
  const handler = createUsersHandler({
    supabaseUrl: configured ? 'https://supabase.example' : undefined,
    secretKey: configured ? 'server-secret' : undefined,
    appId, appSecret, fetchImpl,
  });
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    await closed;
  });
  return {
    rows, calls,
    async post(body) {
      const response = await fetch(`${origin}/api/users/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

test('an external device is inserted once and later visits do nothing', async (t) => {
  const server = await setup(t);
  const first = await server.post({ vk: false, deviceId });
  const second = await server.post({ vk: false, deviceId });
  assert.deepEqual(first, { status: 200, body: { ok: true } });
  assert.deepEqual(second, first);
  assert.equal(server.rows.length, 1);
  assert.equal(server.rows[0].device_id, deviceId);
  assert.equal(server.rows[0].vk_id, undefined);
  assert.equal(server.calls.filter(({ init }) => init.method === 'POST').length, 1);
});

test('a VK account is inserted once by vk_id without a device identifier', async (t) => {
  const server = await setup(t);
  const body = { vk: true, launchParams: signedLaunch(), deviceId };
  assert.equal((await server.post(body)).status, 200);
  assert.equal((await server.post(body)).status, 200);
  assert.equal(server.rows.length, 1);
  assert.equal(server.rows[0].vk_id, userId);
  assert.equal(server.rows[0].device_id, undefined);
  assert.equal(server.calls.filter(({ init }) => init.method === 'POST').length, 1);
});

test('concurrent first visits cannot duplicate a device in the single server process', async (t) => {
  const server = await setup(t);
  const results = await Promise.all(Array.from({ length: 5 }, () => server.post({ vk: false, deviceId })));
  assert.ok(results.every(({ status }) => status === 200));
  assert.equal(server.rows.length, 1);
});

test('invalid devices and tampered VK launch parameters never reach Supabase', async (t) => {
  const server = await setup(t);
  assert.equal((await server.post({ vk: false, deviceId: 'not-a-device' })).status, 400);
  const tampered = new URLSearchParams(signedLaunch());
  tampered.set('vk_user_id', '50002');
  assert.equal((await server.post({ vk: true, launchParams: `?${tampered}` })).status, 401);
  assert.equal(server.rows.length, 0);
  assert.equal(server.calls.length, 0);
});

test('registration can be disabled without affecting other server features', async (t) => {
  const server = await setup(t, { configured: false });
  const result = await server.post({ vk: false, deviceId });
  assert.equal(result.status, 503);
  assert.equal(server.calls.length, 0);
});
