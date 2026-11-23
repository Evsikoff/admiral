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
const chipsField = 'chips_balance';
const loginExtras = {
  online_party_price: 10,
  ship_sets: [{
    id: 1, name: 'Classic', free: true, icon: 'classic.png', owned: true, prices: [],
    models: [{ id: 1, model_type: 'ship', base_model_url: 'https://example.com/ship.glb' }],
  }],
};

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

async function setup(t, { configured = true, chips = 125 } = {}) {
  const calls = [];
  async function fetchImpl(url, init = {}) {
    calls.push({ url, init });
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/rest/v1/rpc/admiral_user_login');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.apikey, 'server-secret');
    assert.equal(init.headers.Authorization, 'Bearer server-secret');
    assert.equal(init.headers['content-type'], 'application/json');
    assert.equal(Object.keys(JSON.parse(init.body)).length, 1);
    // The login row also carries the online party price and the ship set catalog;
    // they are accepted but not used yet.
    return { ok: true, status: 200, json: async () => [{ [chipsField]: chips, ...loginExtras }] };
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
    calls,
    async post(body) {
      const response = await fetch(`${origin}/api/users/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

test('an external device enters through the database function and receives its chips', async (t) => {
  const server = await setup(t);
  const first = await server.post({ vk: false, deviceId });
  const second = await server.post({ vk: false, deviceId });
  assert.deepEqual(first, { status: 200, body: { ok: true, chips: 125 } });
  assert.deepEqual(second, first);
  assert.equal(server.calls.length, 2);
  for (const { init } of server.calls) {
    assert.deepEqual(JSON.parse(init.body), { p_device_id: deviceId });
  }
});

test('a VK visit enters by vk_id without sending a device identifier', async (t) => {
  const server = await setup(t, { chips: 80 });
  const body = { vk: true, launchParams: signedLaunch(), deviceId };
  assert.deepEqual(await server.post(body), { status: 200, body: { ok: true, chips: 80 } });
  assert.deepEqual(await server.post(body), { status: 200, body: { ok: true, chips: 80 } });
  assert.equal(server.calls.length, 2);
  for (const { init } of server.calls) {
    assert.deepEqual(JSON.parse(init.body), { p_vk_id: userId });
  }
});

test('concurrent visits are forwarded to the atomic database function', async (t) => {
  const server = await setup(t);
  const results = await Promise.all(Array.from({ length: 5 }, () => server.post({ vk: false, deviceId })));
  assert.ok(results.every(({ status, body }) => status === 200 && body.chips === 125));
  assert.equal(server.calls.length, 5);
});

test('invalid devices and tampered VK launch parameters never reach Supabase', async (t) => {
  const server = await setup(t);
  assert.equal((await server.post({ vk: false, deviceId: 'not-a-device' })).status, 400);
  const tampered = new URLSearchParams(signedLaunch());
  tampered.set('vk_user_id', '50002');
  assert.equal((await server.post({ vk: true, launchParams: `?${tampered}` })).status, 401);
  assert.equal(server.calls.length, 0);
});

test('user entry can be disabled without affecting other server features', async (t) => {
  const server = await setup(t, { configured: false });
  const result = await server.post({ vk: false, deviceId });
  assert.equal(result.status, 503);
  assert.equal(server.calls.length, 0);
});
