import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { createUserService } from './users.js';

const appId = '12345';
const appSecret = 'example-secret';
const serverSecret = 'server-secret';
const deviceId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '500013627108';
const logPrefix = '[admiral:user-login] ';
const purchasingChips = [{ id: 1, name: '+ 200 фишек', icon: '/assets/menu/chip-x200-square.png', price_vk: 10 }];
const shipSets = [
  {
    id: 1, name: 'Classic', free: true, icon: 'classic.png', owned: true, prices: [],
    models: [{ id: 1, model_type: 'intact', base_model_url: 'https://example.com/ship.glb' }],
  },
  {
    id: 2, name: 'Prestige', free: false, icon: 'prestige.png', owned: false, models: [],
    prices: [
      { id: 3, price: 100, item_id: 'prestige_base', discount: null, number_defeated_opponents: 0 },
      { id: 4, price: 80, item_id: 'prestige_winner_1', discount: 20, number_defeated_opponents: 1 },
    ],
  },
];

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

async function setup(t, { configured = true, chips = 125, upstreamError = null, catalog = shipSets, inventory, chipResult, partyResult, finishResult } = {}) {
  const calls = [], logs = [];
  const captureLog = (...args) => logs.push(args);
  const logger = { info: captureLog, warn: captureLog, error: captureLog };
  async function fetchImpl(url, init = {}) {
    calls.push({ url, init });
    const parsed = new URL(url);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.apikey, serverSecret);
    assert.equal(init.headers.Authorization, `Bearer ${serverSecret}`);
    assert.equal(init.headers['content-type'], 'application/json');
    if (parsed.pathname === '/rest/v1/rpc/admiral_online_party_start') return new Response(await partyResult);
    if (parsed.pathname === '/rest/v1/rpc/admiral_online_party_results') return Response.json(finishResult);
    if (parsed.pathname === '/rest/v1/rpc/admiral_chips_acquisition') return Response.json(chipResult);
    if (parsed.pathname === '/rest/v1/rpc/admiral_inventory_acquisition') {
      return { ok: true, status: 200, json: async () => inventory };
    }
    assert.equal(parsed.pathname, '/rest/v1/rpc/admiral_user_login');
    assert.equal(Object.keys(JSON.parse(init.body)).length, 1);
    if (upstreamError) return { ok: false, status: upstreamError.status, json: async () => upstreamError.body };
    return { ok: true, status: 200, json: async () => [{
      user_id: '20', chips_balance: chips,
      online_party_price: '10',
      ship_sets: catalog,
    }] };
  }
  const service = createUserService({
    supabaseUrl: configured ? 'https://supabase.example' : undefined,
    secretKey: configured ? serverSecret : undefined,
    appId, appSecret, fetchImpl, logger,
  });
  const server = http.createServer(service.handleUsers);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    await closed;
  });
  return {
    calls, logs, ...service,
    async post(body, path = '/api/users/register') {
      const response = await fetch(`${origin}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json(), loginId: response.headers.get('x-admiral-login-id') };
    },
  };
}

function events(logs) {
  return logs.map(([entry, ...extra]) => {
    assert.equal(extra.length, 0);
    assert.ok(entry.startsWith(logPrefix));
    return JSON.parse(entry.slice(logPrefix.length));
  });
}

const acquirePath = '/api/users/ship-sets/acquire';

test('chip purchases credit the device login account and reject VK or altered tickets', async t => {
  const service = await setup(t, { chipResult: [{ balance: '325' }] });
  const device = await service.post({ vk: false, deviceId });
  const vk = await service.post({ vk: true, launchParams: signedLaunch() });
  const path = '/api/users/chips/acquire';
  const purchase = { onlineTicket: device.body.onlineTicket, purchasingChipsId: 1, userId: 999 };
  for (const ticket of [undefined, vk.body.onlineTicket, vk.body.onlineTicket.replace('.vk.', '.device.')]) {
    assert.equal((await service.post({ ...purchase, onlineTicket: ticket }, path)).status, 403);
  }
  assert.equal((await service.post({ ...purchase, purchasingChipsId: null }, path)).status, 400);
  const result = await service.post(purchase, path);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { balance: 325 });
  assert.equal(service.calls.length, 3);
  assert.deepEqual(JSON.parse(service.calls[2].init.body), { user_id: 20, purchasing_chips_id: 1 });
});

test('party results call the named human and bot overloads with the original bigint party id', async t => {
  for (const [winner, winnings, balance] of [
    [{ winner_user_id: 14 }, 20, 0],
    [{ bot_name: 'Корсар' }, 0, null],
  ]) {
    const service = await setup(t, { finishResult: [{ winnings_amount: winnings, winner_user_balance: balance }] });
    const id = '9007199254740993';
    assert.deepEqual(await service.finishOnlineParty(id, winner), { winnings, balance });
    assert.deepEqual(JSON.parse(service.calls[0].init.body), { party_id: id, ...winner });
  }
});

test('party RPC sends one entry per seat and preserves a bigint party ID and zero balances', async t => {
  const service = await setup(t, { partyResult: '{"success":true,"party_id":9007199254740993,"user_balances":[{"user_id":20,"chip_balance":0},{"user_id":20,"chip_balance":0}]}' });
  const participants = [{ user_id: 20 }, { user_id: 20 }, { bot_name: 'Корсар' }];
  const result = await service.startOnlineParty(participants);
  assert.deepEqual(JSON.parse(service.calls[0].init.body), { p_participants: participants });
  assert.deepEqual(result, { success: true, partyId: '9007199254740993', balances: new Map([[20, 0]]) });
});

test('party rejection reads the current price and only the insufficient balances', async t => {
  const service = await setup(t, { partyResult: JSON.stringify({ success: false, error: 'insufficient_chips',
    party_price: 10, insufficient_balance_users: [{ user_id: 20, chip_balance: 0, required_balance: 10 }] }) });
  assert.deepEqual(await service.startOnlineParty([{ user_id: 21 }, { user_id: 20 }]),
    { success: false, price: 10, balances: new Map([[20, 0]]) });
});

test('overlapping starts wait for the preceding charge on a shared account', async t => {
  let release;
  const service = await setup(t, { partyResult: new Promise(resolve => { release = resolve; }) });
  const start = () => service.startOnlineParty([{ user_id: 20 }, { bot_name: 'Корсар' }]);
  const first = start(), second = start();
  await new Promise(setImmediate);
  assert.equal(service.calls.length, 1);
  release('{"success":true,"party_id":1,"user_balances":[{"user_id":20,"chip_balance":15}]}');
  await Promise.all([first, second]);
  assert.equal(service.calls.length, 2);
});

test('a device acquires one paid set for its login user and receives the full inventory', async t => {
  const server = await setup(t, { inventory: { user_ship_sets: [
    { ship_set_id: 2, quantity: 1 }, { ship_set_id: 3, quantity: 2 },
  ] } });
  const response = await server.post({ deviceId, shipSetId: 2, userId: 42, quantity: 9 }, acquirePath);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.ownedShipSetIds, [2, 3]);
  assert.deepEqual(server.calls.map(({ init }) => JSON.parse(init.body)), [
    { p_device_id: deviceId },
    { p_user_id: 20, p_type_inventory: 'ship_set', p_change_type: 'purchase',
      p_inventory_id: 2, p_quantity: 1, p_details: null },
  ]);
});

test('already owned sets, free sets, unknown IDs and VK logins cannot add inventory', async t => {
  const server = await setup(t, { catalog: shipSets.map(set => ({ ...set, owned: true })) });
  const retry = await server.post({ deviceId, shipSetId: 2 }, acquirePath);
  assert.deepEqual(retry.body, { ownedShipSetIds: [2] });
  for (const body of [{ deviceId, shipSetId: 1 }, { deviceId, shipSetId: 99 }, { launchParams: signedLaunch(), shipSetId: 2 }]) {
    assert.equal((await server.post(body, acquirePath)).status, 400);
  }
  assert.ok(server.calls.every(({ url }) => url.endsWith('/admiral_user_login')));
});

function loginEvents(server, { loginId }) {
  assert.ok(loginId);
  return events(server.logs).filter((entry) => entry.loginId === loginId);
}

function assertTerminalEvent(event, response, mode) {
  assert.equal(event.status, response.status);
  if (mode) assert.equal(event.mode, mode);
  assert.ok(Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0);
}

test('an external device receives the numeric balance, online price and ship set catalog', async (t) => {
  const server = await setup(t, { chips: '125' });
  const first = await server.post({ vk: false, deviceId });
  const second = await server.post({ vk: false, deviceId });
  for (const response of [first, second]) {
    assert.equal(response.status, 200);
    const { onlineTicket, ...profile } = response.body;
    assert.equal(server.onlineAccount(onlineTicket).userId, 20);
    assert.equal(server.onlineAccount(onlineTicket.replace(/^20\./, '21.')), null);
    assert.deepEqual(profile, { ok: true, userId: 20, chips: 125, onlinePartyPrice: 10, shipSets, purchasingChips: [] });
    const trail = loginEvents(server, response);
    assert.deepEqual(trail.map((entry) => entry.event), ['rpc_started', 'succeeded']);
    assert.equal(trail[0].mode, 'device');
    assertTerminalEvent(trail[1], response, 'device');
    assert.equal(trail[1].supabaseStatus, 200);
  }
  const config = events(server.logs).find(({ event }) => event === 'configuration');
  assert.deepEqual(config.missingEnv, []);
  assert.equal(config.vkConfigured, true);
  assert.ok(!JSON.stringify(server.logs).includes(deviceId));
  assert.equal(server.calls.length, 2);
  for (const { init } of server.calls) {
    assert.deepEqual(JSON.parse(init.body), { p_device_id: deviceId });
  }
});

test('a VK visit enters by vk_id without sending a device identifier', async (t) => {
  const server = await setup(t, { chips: 80, catalog: { ship_sets: shipSets, purchasing_chips: purchasingChips } });
  const body = { vk: true, launchParams: signedLaunch(), deviceId };
  for (let count = 0; count < 2; count++) {
    const response = await server.post(body);
    assert.equal(response.status, 200);
    const { onlineTicket, ...profile } = response.body;
    assert.equal(server.onlineAccount(onlineTicket).userId, 20);
    assert.deepEqual(profile, { ok: true, userId: 20, chips: 80, onlinePartyPrice: 10, shipSets, purchasingChips });
    const trail = loginEvents(server, response);
    assert.deepEqual(trail.map((entry) => entry.event), ['rpc_started', 'succeeded']);
    assert.equal(trail[0].mode, 'vk');
    assertTerminalEvent(trail[1], response, 'vk');
  }
  for (const sensitive of [appSecret, serverSecret, userId, deviceId, new URLSearchParams(body.launchParams).get('sign')]) {
    assert.ok(!JSON.stringify(server.logs).includes(sensitive));
  }
  assert.equal(server.calls.length, 2);
  for (const { init } of server.calls) {
    assert.deepEqual(JSON.parse(init.body), { p_vk_id: userId });
  }
});

test('concurrent visits are forwarded to the atomic database function', async (t) => {
  const server = await setup(t);
  const results = await Promise.all(Array.from({ length: 5 }, () => server.post({ vk: false, deviceId })));
  assert.ok(results.every(({ status, body }) => status === 200 && body.chips === 125));
  assert.equal(new Set(results.map(({ loginId }) => loginId)).size, results.length);
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
  const config = events(server.logs).find(({ event }) => event === 'configuration');
  assert.deepEqual(new Set(config.missingEnv), new Set(['SUPABASE_URL', 'SUPABASE_SECRET_KEY']));
  assert.equal(config.vkConfigured, true);
  const trail = loginEvents(server, result);
  assert.deepEqual(trail.map((entry) => entry.event), ['failed']);
  assertTerminalEvent(trail[0], result);
  assert.equal(trail[0].reason, 'supabase_not_configured');
});

test('invalid chip values do not produce a successful login response', async (t) => {
  const rawValue = 'private value from the database';
  const server = await setup(t, { chips: rawValue });
  const result = await server.post({ vk: false, deviceId });
  assert.equal(result.status, 503);
  const trail = loginEvents(server, result);
  assert.deepEqual(trail.map((entry) => entry.event), ['rpc_started', 'failed']);
  assertTerminalEvent(trail[1], result, 'device');
  assert.equal(trail[1].reason, 'rpc_validation_failed');
  assert.equal(trail[1].supabaseStatus, 200);
  assert.match(trail[1].validationError, /chip.*balance/i);
  assert.ok(!JSON.stringify(server.logs).includes(rawValue));
});

test('a Supabase HTTP error logs a safe status and code with the response correlation ID', async (t) => {
  const message = `upstream details for ${userId} using ${serverSecret}`;
  const server = await setup(t, {
    upstreamError: { status: 403, body: { code: '42501', message, details: deviceId, hint: appSecret } },
  });
  const result = await server.post({ vk: true, launchParams: signedLaunch() });
  assert.equal(result.status, 503);
  const trail = loginEvents(server, result);
  assert.deepEqual(trail.map((entry) => entry.event), ['rpc_started', 'failed']);
  assertTerminalEvent(trail[1], result, 'vk');
  assert.equal(trail[1].reason, 'rpc_http_error');
  assert.equal(trail[1].supabaseStatus, 403);
  assert.equal(trail[1].supabaseCode, '42501');
  const logged = JSON.stringify(server.logs);
  for (const sensitive of [message, deviceId, userId, appSecret, serverSecret]) {
    assert.ok(!logged.includes(sensitive));
  }
});
