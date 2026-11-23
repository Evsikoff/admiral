import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('identity.js', import.meta.url), 'utf8');
const generatedId = '123e4567-e89b-42d3-a456-426614174000';
const savedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const correlationId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const shipSets = [{ id: 1, free: true, owned: true, icon: 'classic.png', name: 'Classic', models: [], prices: [] }];
const pendingBridge = new Promise(() => {});

function setup({ bridgeReady = Promise.resolve(), stored = null, search = '', protocol = 'https:', ok = true, chips = 125,
                 onlinePartyPrice = 10, responseBody, loginId = correlationId, requestError, jsonError } = {}) {
  const values = new Map();
  if (stored) values.set('admiral.device.id', stored);
  const requests = [];
  const logs = [];
  const console = {
    info: (...args) => logs.push(['info', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
  };
  let generated = 0;
  const window = { isVKApp: false, AdmiralVK: { ready: bridgeReady } };
  const location = { protocol, search };
  const localStorage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  const crypto = { randomUUID: () => { generated++; return generatedId; } };
  async function fetch(url, init) {
    requests.push({ url, init });
    if (requestError) throw requestError;
    const headers = new Headers(loginId ? { 'x-admiral-login-id': loginId } : {});
    return {
      ok, status: ok ? 200 : 503, headers,
      async json() {
        if (jsonError) throw jsonError;
        return responseBody === undefined ? { ok, chips, onlinePartyPrice, shipSets } : responseBody;
      },
    };
  }
  new Function('window', 'location', 'localStorage', 'crypto', 'fetch', 'console', source)(
    window, location, localStorage, crypto, fetch, console,
  );
  return { window, values, requests, logs, generated: () => generated };
}

test('an external visit registers its device even if VK Bridge is still pending', async () => {
  const context = setup({ bridgeReady: pendingBridge });
  assert.equal(context.requests.length, 1);
  assert.equal(await context.window.AdmiralIdentity.ready, true);
  assert.equal(context.window.AdmiralIdentity.chips, 125);
  assert.equal(context.window.AdmiralIdentity.onlinePartyPrice, 10);
  assert.deepEqual(context.window.AdmiralIdentity.shipSets, shipSets);
  assert.equal(context.values.get('admiral.device.id'), generatedId);
  assert.equal(context.requests[0].url, '/api/users/register');
  assert.deepEqual(JSON.parse(context.requests[0].init.body), { vk: false, deviceId: generatedId });
  assert.deepEqual(context.logs, [
    ['info', '[admiral:user-login] Login response accepted', { status: 200, loginId: correlationId }],
  ]);
});

test('an existing external device id is reused and zero values are accepted', async () => {
  const context = setup({ stored: savedId, chips: 0, onlinePartyPrice: 0 });
  assert.equal(await context.window.AdmiralIdentity.ready, true);
  assert.equal(context.window.AdmiralIdentity.chips, 0);
  assert.equal(context.window.AdmiralIdentity.onlinePartyPrice, 0);
  assert.equal(context.generated(), 0);
  assert.deepEqual(JSON.parse(context.requests[0].init.body), { vk: false, deviceId: savedId });
});

test('a VK visit uses signed launch parameters even if VK Bridge is still pending', async () => {
  const search = '?vk_app_id=12345&vk_user_id=50001&vk_ts=1700000000&sign=signed';
  const context = setup({ bridgeReady: pendingBridge, search });
  assert.equal(context.requests.length, 1);
  assert.equal(await context.window.AdmiralIdentity.ready, true);
  assert.equal(context.window.AdmiralIdentity.chips, 125);
  assert.equal(context.generated(), 0);
  assert.equal(context.values.has('admiral.device.id'), false);
  assert.equal(context.window.AdmiralIdentity.deviceId, null);
  assert.deepEqual(JSON.parse(context.requests[0].init.body), { vk: true, launchParams: search });
});

test('entry failure, an invalid balance or opening from a file does not reject initialization', async () => {
  const failed = setup({ ok: false });
  assert.equal(await failed.window.AdmiralIdentity.ready, false);
  assert.equal(failed.window.AdmiralIdentity.chips, null);
  assert.deepEqual(failed.logs, [
    ['warn', '[admiral:user-login] Registration endpoint returned an error', { status: 503, loginId: correlationId }],
  ]);
  const malformed = setup({ responseBody: { ok: true, onlinePartyPrice: 10, shipSets } });
  assert.equal(await malformed.window.AdmiralIdentity.ready, false);
  assert.equal(malformed.window.AdmiralIdentity.chips, null);
  assert.deepEqual(malformed.logs, [
    ['warn', '[admiral:user-login] Login response did not match the expected format', { status: 200, loginId: correlationId }],
  ]);
  const file = setup({ protocol: 'file:' });
  assert.equal(await file.window.AdmiralIdentity.ready, false);
  assert.equal(file.requests.length, 0);
  assert.deepEqual(file.logs, [['info', '[admiral:user-login] Login skipped because the game is outside HTTP(S)']]);
});

test('incomplete login data leaves the menu identity unavailable', async () => {
  const { window } = setup({ responseBody: { ok: true, chips: 125, onlinePartyPrice: 10 } });
  assert.equal(await window.AdmiralIdentity.ready, false);
  assert.equal(window.AdmiralIdentity.chips, null);
  assert.equal(window.AdmiralIdentity.onlinePartyPrice, null);
  assert.equal(window.AdmiralIdentity.shipSets, null);
});

test('the console reports failures without raw error details or untrusted correlation values', async () => {
  const request = setup({ requestError: new Error('sensitive request details') });
  assert.equal(await request.window.AdmiralIdentity.ready, false);
  assert.deepEqual(request.logs, [['warn', '[admiral:user-login] Could not complete the login request']]);

  const response = setup({ jsonError: new Error('sensitive response details'), loginId: 'untrusted header' });
  assert.equal(await response.window.AdmiralIdentity.ready, false);
  assert.deepEqual(response.logs, [['warn', '[admiral:user-login] Could not read the login response', { status: 200 }]]);
});
