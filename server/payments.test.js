import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPaymentsHandler } from './payments.js';

const paymentTest = isBuiltin('node:sqlite') ? test : test.skip;

const appId = '12345';
const appSecret = 'example-secret';
const userId = '50001';
const orderId = '80001';
const publicOrigin = 'https://admiral.example';
const catalog = [
  { id: 'basic', name: 'Базовые корабли', basePriceVk: 0 },
  {
    id: 'super',
    name: 'Суперкорабли',
    iconUrl: '/assets/ship-sets/super.png',
    basePriceVk: 1000,
    winDiscountPercentByPlayerCount: { 2: 30, 3: 40, 4: 50 },
  },
];

function signCallback(fields) {
  const payload = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join('');
  const sig = createHash('md5').update(payload + appSecret).digest('hex');
  return new URLSearchParams({ ...fields, sig });
}

function signLaunchParams(fields) {
  const params = new URLSearchParams(fields);
  const signedKeys = Object.keys(fields).filter((key) => key.startsWith('vk_')).sort();
  const payload = signedKeys.map((key) => `${key}=${encodeURIComponent(fields[key])}`).join('&');
  params.set('sign', createHmac('sha256', appSecret).update(payload).digest('base64url'));
  return params;
}

async function startServer(databasePath, options) {
  const handler = await createPaymentsHandler({ appId, appSecret, databasePath, catalog, publicOrigin, ...options });
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  async function post(endpoint, body) {
    const response = await fetch(origin + endpoint, { method: 'POST', body });
    return { status: response.status, body: await response.json() };
  }

  return {
    post,
    callback(type, fields) {
      const request = signCallback({ app_id: appId, order_id: orderId, user_id: userId, notification_type: type, ...fields });
      return post('/vk/payments', request);
    },
    purchases(user = userId, extraFields) {
      return post('/vk/purchases', signLaunchParams({
        vk_app_id: appId, vk_user_id: user, vk_ts: String(Math.floor(Date.now() / 1000)), ...extraFields,
      }));
    },
    async close() {
      const closed = once(server, 'close');
      server.close();
      await closed;
      await handler.close();
    },
  };
}

async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'admiral-payments-'));
  const databasePath = path.join(dir, 'payments.sqlite');
  let server;
  t.after(async () => {
    try { await server?.close(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
  return async (options) => {
    const previous = server;
    server = undefined;
    await previous?.close();
    server = await startServer(databasePath, options);
    return server;
  };
}

paymentTest('VK test quotes return the configured offer prices and reject unknown items', async (t) => {
  const start = await setup(t);
  const { callback } = await start();
  const offers = [
    ['super_regular', 1000],
    ['super_win_2', 700],
    ['super_win_3', 600],
    ['super_win_4', 500],
  ];
  for (const [index, [item, price]] of offers.entries()) {
    const result = await callback('get_item_test', { order_id: String(80010 + index), item });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.response, {
      title: 'Суперкорабли',
      item_id: item,
      price,
      expiration: 0,
      photo_url: publicOrigin + '/assets/ship-sets/super.png',
    });
  }
  const unknown = await callback('get_item_test', { item: 'basic' });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.error.error_code, 20);
});

paymentTest('VK callback rejects tampered, duplicate and wrong-application form parameters', async (t) => {
  const start = await setup(t);
  const { callback, post } = await start();
  const signed = signCallback({
    app_id: appId, order_id: orderId, user_id: userId, notification_type: 'get_item', item: 'super_regular',
  });
  signed.set('item', 'super_win_4');
  const tampered = await post('/vk/payments', signed);
  assert.equal(tampered.body.error.error_code, 10);
  const duplicate = signCallback({
    app_id: appId, order_id: orderId, user_id: userId, notification_type: 'get_item', item: 'super_win_4',
  });
  duplicate.append('item', 'super_win_4');
  const repeatedField = await post('/vk/payments', duplicate);
  assert.ok(repeatedField.body.error);
  const wrongApp = await callback('get_item', { app_id: '99999', item: 'super_win_4' });
  assert.ok(wrongApp.body.error);
});

paymentTest('orders preserve their quoted price, survive restart, isolate tests and revoke refunded purchases', async (t) => {
  const start = await setup(t);
  let server = await start();
  const charge = { item_id: 'super_win_4', item_price: '500', status: 'chargeable' };

  const unquoted = await server.callback('order_status_change', charge);
  assert.equal(unquoted.body.error.error_code, 100);
  const testQuote = await server.callback('get_item_test', { item: 'super_win_4' });
  assert.equal(testQuote.body.response.price, 500);
  const testCharge = await server.callback('order_status_change_test', charge);
  assert.equal(testCharge.body.response.order_id, Number(orderId));
  assert.deepEqual(await server.purchases(), { status: 200, body: { shipSets: [] } });

  const liveQuote = await server.callback('get_item', { item: 'super_win_4' });
  assert.equal(liveQuote.body.response.price, 500);
  const otherOrder = { order_id: '80002' };
  const otherQuote = await server.callback('get_item', { ...otherOrder, item: 'super_regular' });
  assert.equal(otherQuote.body.response.price, 1000);
  server = await start({ catalog: catalog.map((set) => set.id === 'super' ? { ...set, basePriceVk: 2000 } : set) });
  const quoteRetry = await server.callback('get_item', { item: 'super_win_4' });
  assert.deepEqual(quoteRetry, liveQuote);
  const wrongAmount = await server.callback('order_status_change', { ...charge, item_price: '1000' });
  assert.equal(wrongAmount.body.error.error_code, 100);
  const wrongUser = await server.callback('order_status_change', { ...charge, user_id: '50002' });
  assert.equal(wrongUser.body.error.error_code, 100);
  assert.deepEqual(await server.purchases(), { status: 200, body: { shipSets: [] } });

  const charges = await Promise.all([
    server.callback('order_status_change', charge),
    server.callback('order_status_change', charge),
  ]);
  assert.deepEqual(charges[0], charges[1]);
  assert.equal(charges[0].body.response.order_id, Number(orderId));
  assert.ok(charges[0].body.response.app_order_id);
  assert.deepEqual(await server.purchases(), { status: 200, body: { shipSets: ['super'] } });
  assert.deepEqual(await server.purchases('50002'), { status: 200, body: { shipSets: [] } });
  const secondPurchase = await server.callback('order_status_change', {
    ...otherOrder, item: 'super_regular', item_price: '1000', status: 'chargeable',
  });
  assert.equal(secondPurchase.body.error.error_code, 100);

  server = await start();
  assert.deepEqual(await server.callback('order_status_change', charge), charges[0]);
  assert.deepEqual(await server.purchases(), { status: 200, body: { shipSets: ['super'] } });
  const refunded = await server.callback('order_status_change', { ...charge, status: 'refunded' });
  assert.deepEqual(refunded, charges[0]);
  assert.deepEqual(await server.callback('order_status_change', charge), charges[0]);
  assert.deepEqual(await server.purchases(), { status: 200, body: { shipSets: [] } });
});

paymentTest('purchase lookup only accepts valid, recent launch parameters for this app', async (t) => {
  const start = await setup(t);
  const { post, purchases } = await start();
  assert.deepEqual(await purchases(userId, { vk_ref: 'Тест ~ 1' }), {
    status: 200, body: { shipSets: [] },
  });
  const signed = signLaunchParams({
    vk_app_id: appId, vk_user_id: userId, vk_ts: String(Math.floor(Date.now() / 1000)),
  });
  signed.set('vk_user_id', '50002');
  const tampered = await post('/vk/purchases', signed);
  assert.ok(tampered.status >= 400);
  const wrongApp = await purchases(userId, { vk_app_id: '99999' });
  assert.ok(wrongApp.status >= 400);
  const stale = await purchases(userId, { vk_ts: '1' });
  assert.ok(stale.status >= 400);
});
