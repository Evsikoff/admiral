import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const MAX_FORM_BYTES = 16 * 1024;
const MAX_LAUNCH_AGE = 24 * 60 * 60;

function positiveInteger(value) {
  const number = Number(value);
  return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(number) ? number : null;
}

function signaturesMatch(actual, expected) {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

async function readForm(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
    req.resume();
    return null;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_FORM_BYTES) break;
    chunks.push(chunk);
  }
  if (size > MAX_FORM_BYTES) {
    req.resume();
    return null;
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  return form.size === new Set(form.keys()).size ? form : null;
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function vkError(error_code, error_msg, critical = true) {
  return { error: { error_code, error_msg, critical } };
}

function shipOffers(catalog, publicOrigin) {
  const shipSet = catalog.find(({ id }) => id === 'super');
  if (!shipSet || !Number.isSafeInteger(shipSet.basePriceVk) || shipSet.basePriceVk <= 0) {
    throw new Error('Missing or invalid VK price for super');
  }
  const offers = new Map([['super_regular', shipSet.basePriceVk]]);
  for (const count of [2, 3, 4]) {
    const discount = shipSet.winDiscountPercentByPlayerCount?.[count];
    if (!Number.isInteger(discount) || discount < 0 || discount >= 100) {
      throw new Error(`Invalid VK discount for super with ${count} players`);
    }
    offers.set(`super_win_${count}`, Math.max(1, Math.round(shipSet.basePriceVk * (100 - discount) / 100)));
  }
  const photoUrl = publicOrigin && shipSet.iconUrl ? new URL(shipSet.iconUrl, publicOrigin).href : null;
  return { shipSet, offers, photoUrl };
}

export async function createPaymentsHandler({ appId, appSecret, databasePath, catalog, publicOrigin } = {}) {
  const enabled = Boolean(appId && appSecret && databasePath);
  let database;
  let callback;
  let getPurchases;
  if (enabled) {
    appId = positiveInteger(appId);
    if (!appId || databasePath === ':memory:') throw new Error('Invalid VK payment configuration');
    const { shipSet, offers, photoUrl } = shipOffers(catalog, publicOrigin);

    // Keep the rest of the game runnable without SQLite when payments are disabled.
    const { DatabaseSync } = await import('node:sqlite');
    database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        PRAGMA busy_timeout = 2000;
        CREATE TABLE IF NOT EXISTS vk_orders (
          app_order_id INTEGER PRIMARY KEY,
          app_id INTEGER NOT NULL,
          is_test INTEGER NOT NULL,
          order_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          offer_id TEXT NOT NULL,
          ship_set_id TEXT NOT NULL,
          title TEXT NOT NULL,
          price INTEGER NOT NULL,
          photo_url TEXT,
          status TEXT NOT NULL DEFAULT 'quoted',
          UNIQUE (app_id, is_test, order_id)
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS vk_orders_purchases ON vk_orders (app_id, user_id, ship_set_id)
          WHERE is_test = 0 AND status = 'chargeable';
      `);
    } catch (error) {
      database.close();
      throw error;
    }

    const insertQuote = database.prepare(`
      INSERT INTO vk_orders (app_id, is_test, order_id, user_id, offer_id, ship_set_id, title, price, photo_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (app_id, is_test, order_id) DO NOTHING
    `);
    const findOrder = database.prepare('SELECT * FROM vk_orders WHERE app_id = ? AND is_test = ? AND order_id = ?');
    const chargeOrder = database.prepare(`
      UPDATE OR IGNORE vk_orders SET status = 'chargeable' WHERE app_order_id = ? AND status = 'quoted'
    `);
    const refundOrder = database.prepare(`
      UPDATE vk_orders SET status = 'refunded' WHERE app_order_id = ? AND status IN ('quoted', 'chargeable')
    `);
    const listOwned = database.prepare(`
      SELECT DISTINCT ship_set_id FROM vk_orders
      WHERE app_id = ? AND user_id = ? AND is_test = 0 AND status = 'chargeable'
      ORDER BY ship_set_id
    `);

    callback = (form) => {
      const signature = form.get('sig');
      form.delete('sig');
      form.sort();
      const signedFields = Array.from(form, ([key, value]) => `${key}=${value}`).join('');
      const expected = createHash('md5').update(signedFields).update(appSecret).digest('hex');
      if (!signaturesMatch(signature, expected)) return vkError(10, 'Invalid signature');

      const userId = positiveInteger(form.get('user_id'));
      const orderId = positiveInteger(form.get('order_id'));
      const notification = form.get('notification_type') || '';
      const isTest = Number(notification.endsWith('_test'));
      const type = isTest ? notification.slice(0, -5) : notification;
      if (positiveInteger(form.get('app_id')) !== appId || !userId || !orderId) {
        return vkError(11, 'Invalid app, user or order ID');
      }

      if (type === 'get_item') {
        const offerId = form.get('item');
        if (!offers.has(offerId)) return vkError(20, 'Unknown item');
        if (!findOrder.get(appId, isTest, orderId)) {
          if (!isTest && listOwned.get(appId, userId)) return vkError(100, 'Ship set already purchased');
          insertQuote.run(appId, isTest, orderId, userId, offerId, shipSet.id, shipSet.name, offers.get(offerId), photoUrl);
        }
        const order = findOrder.get(appId, isTest, orderId);
        if (order.user_id !== userId || order.offer_id !== offerId) return vkError(100, 'Order does not match quote');
        const response = { title: order.title, price: order.price, item_id: order.offer_id, expiration: 0 };
        if (order.photo_url) response.photo_url = order.photo_url;
        return { response };
      }

      if (type !== 'order_status_change') return vkError(11, 'Unsupported notification');
      const status = form.get('status');
      if (status !== 'chargeable' && status !== 'refunded') return vkError(11, 'Unsupported order status');
      const order = findOrder.get(appId, isTest, orderId);
      const offerId = form.get('item_id') || form.get('item');
      const price = positiveInteger(form.get('item_price'));
      if (!order || order.user_id !== userId || order.offer_id !== offerId || order.price !== price) {
        return vkError(100, 'Order does not match quote');
      }

      // Only the first charge can grant access. Retries after a refund keep the same acknowledgement.
      if (status === 'chargeable') {
        chargeOrder.run(order.app_order_id);
        if (findOrder.get(appId, isTest, orderId).status === 'quoted') return vkError(100, 'Ship set already purchased');
      } else {
        refundOrder.run(order.app_order_id);
      }
      return { response: { order_id: order.order_id, app_order_id: order.app_order_id } };
    };

    getPurchases = (form) => {
      const userId = positiveInteger(form.get('vk_user_id'));
      const timestamp = positiveInteger(form.get('vk_ts'));
      const now = Math.floor(Date.now() / 1000);
      if (positiveInteger(form.get('vk_app_id')) !== appId || !userId || !timestamp ||
          timestamp > now + 60 || now - timestamp > MAX_LAUNCH_AGE) return null;
      form.sort();
      const signedFields = Array.from(form).filter(([key]) => key.startsWith('vk_'))
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
      const expected = createHmac('sha256', appSecret).update(signedFields).digest('base64url');
      if (!signaturesMatch(form.get('sign'), expected)) return null;
      return { shipSets: listOwned.all(appId, userId).map((row) => row.ship_set_id) };
    };
  }

  async function handle(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' }, { allow: 'POST' });
    const isCallback = req.url.split('?')[0] === '/vk/payments';
    const unavailable = vkError(2, 'Payments temporarily unavailable', false);
    if (!enabled) {
      req.resume();
      return sendJson(res, 503, unavailable);
    }
    try {
      const form = await readForm(req);
      if (isCallback) return sendJson(res, 200, form ? callback(form) : vkError(11, 'Invalid form'));
      const purchases = form && getPurchases(form);
      return purchases ? sendJson(res, 200, purchases) : sendJson(res, 401, { error: 'Invalid VK launch parameters' });
    } catch (error) {
      console.error('VK payment request failed:', error.message);
      return sendJson(res, isCallback ? 200 : 503, unavailable);
    }
  }
  handle.close = () => database?.close();
  return handle;
}
