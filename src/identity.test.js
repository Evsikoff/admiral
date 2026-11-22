import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('identity.js', import.meta.url), 'utf8');
const generatedId = '123e4567-e89b-42d3-a456-426614174000';
const savedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function setup({ vk = false, stored = null, search = '', protocol = 'https:', ok = true } = {}) {
  const values = new Map();
  if (stored) values.set('admiral.device.id', stored);
  const requests = [];
  let generated = 0;
  const window = { isVKApp: vk, AdmiralVK: { ready: Promise.resolve() } };
  const location = { protocol, search };
  const localStorage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  const crypto = { randomUUID: () => { generated++; return generatedId; } };
  async function fetch(url, init) {
    requests.push({ url, init });
    return { ok };
  }
  new Function('window', 'location', 'localStorage', 'crypto', 'fetch', source)(window, location, localStorage, crypto, fetch);
  return { window, values, requests, generated: () => generated };
}

test('an external visit keeps a random device id in local storage and registers it', async () => {
  const context = setup();
  assert.equal(await context.window.AdmiralIdentity.ready, true);
  assert.equal(context.values.get('admiral.device.id'), generatedId);
  assert.equal(context.requests.length, 1);
  assert.equal(context.requests[0].url, '/api/users/register');
  assert.deepEqual(JSON.parse(context.requests[0].init.body), { vk: false, deviceId: generatedId });
});

test('an existing external device id is reused', async () => {
  const context = setup({ stored: savedId });
  assert.equal(await context.window.AdmiralIdentity.ready, true);
  assert.equal(context.generated(), 0);
  assert.deepEqual(JSON.parse(context.requests[0].init.body), { vk: false, deviceId: savedId });
});

test('a VK visit sends only signed launch parameters, not a device id', async () => {
  const search = '?vk_user_id=50001&sign=signed';
  const context = setup({ vk: true, search });
  assert.equal(await context.window.AdmiralIdentity.ready, true);
  assert.equal(context.generated(), 0);
  assert.equal(context.values.has('admiral.device.id'), false);
  assert.equal(context.window.AdmiralIdentity.deviceId, null);
  assert.deepEqual(JSON.parse(context.requests[0].init.body), { vk: true, launchParams: search });
});

test('registration failure or opening from a file does not reject initialization', async () => {
  const failed = setup({ ok: false });
  assert.equal(await failed.window.AdmiralIdentity.ready, false);
  const file = setup({ protocol: 'file:' });
  assert.equal(await file.window.AdmiralIdentity.ready, false);
  assert.equal(file.requests.length, 0);
});
