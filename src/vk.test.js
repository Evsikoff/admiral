import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('vk.js', import.meta.url), 'utf8');
class Event {
  constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
}
function setup(send) {
  const events = [];
  const window = {
    vkBridge: send ? { send } : undefined,
    dispatchEvent: (event) => events.push(event),
  };
  new Function('window', 'CustomEvent', source)(window, Event);
  return { window, events };
}

test('VK initialization exposes the VK flag and full user name', async () => {
  const calls = [];
  const { window, events } = setup(async (method) => {
    calls.push(method);
    if (method === 'VKWebAppGetUserInfo') return { first_name: '  Иван ', last_name: 'Петров' };
    return {};
  });
  await window.AdmiralVK.ready;
  assert.deepEqual(calls, ['VKWebAppInit', 'VKWebAppGetUserInfo']);
  assert.equal(window.isVKApp, true);
  assert.equal(window.vkUserName, 'Иван Петров');
  assert.equal(window.AdmiralVK.isVK, true);
  assert.equal(window.AdmiralVK.name, 'Иван Петров');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'admiral:vk-user');
  assert.deepEqual(events[0].detail, { name: 'Иван Петров' });
});

test('a refused VK request leaves the usual name controls available', async () => {
  const { window, events } = setup(async () => { throw new Error('not in VK'); });
  await window.AdmiralVK.ready;
  assert.equal(window.isVKApp, false);
  assert.equal(window.vkUserName, '');
  assert.equal(events.length, 0);
});

test('an empty profile name still identifies VK, while a missing Bridge does not', async () => {
  const empty = setup(async () => ({}));
  await empty.window.AdmiralVK.ready;
  assert.equal(empty.window.isVKApp, true);
  assert.equal(empty.window.vkUserName, '');
  const missing = setup();
  await missing.window.AdmiralVK.ready;
  assert.equal(missing.window.isVKApp, false);
});

test('a refused user info request does not undo a successful VK initialization', async () => {
  const { window, events } = setup(async (method) => {
    if (method === 'VKWebAppGetUserInfo') throw new Error('refused');
    return {};
  });
  await window.AdmiralVK.ready;
  assert.equal(window.isVKApp, true);
  assert.equal(window.vkUserName, '');
  assert.equal(events.length, 0);
});
