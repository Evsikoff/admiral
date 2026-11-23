import { verifyVkLaunch } from './vk-launch.js';

const MAX_BODY_BYTES = 16 * 1024;
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    req.resume();
    return null;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) break;
    chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) {
    req.resume();
    return null;
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readInteger(value, field, minimum = 0) {
  const number = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`Supabase returned an invalid ${field}`);
  }
  return number;
}

function readText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Supabase returned an invalid ${field}`);
  return value;
}

function readShipModel(model) {
  return {
    id: readInteger(model?.id, 'ship model id'),
    model_type: readText(model.model_type, 'ship model type'),
    base_model_url: readText(model.base_model_url, 'ship model URL'),
  };
}

function readShipPrice(price) {
  return {
    id: readInteger(price?.id, 'ship set price id'),
    price: readInteger(price.price, 'ship set price'),
    item_id: readText(price.item_id, 'ship set price item id'),
    discount: price.discount === null ? null : readInteger(price.discount, 'ship set discount'),
    number_defeated_opponents: readInteger(price.number_defeated_opponents, 'defeated opponents count'),
  };
}

function readShipSet(set) {
  if (typeof set?.free !== 'boolean' || typeof set.owned !== 'boolean' ||
      !Array.isArray(set.models) || !Array.isArray(set.prices)) {
    throw new Error('Supabase returned an invalid ship set');
  }
  const prices = set.prices.map(readShipPrice);
  if (!set.free && !set.owned && !prices.some(price => price.number_defeated_opponents === 0)) {
    throw new Error('Supabase returned a locked ship set without a base price');
  }
  return {
    id: readInteger(set.id, 'ship set id'),
    free: set.free,
    owned: set.owned,
    icon: readText(set.icon, 'ship set icon'),
    name: readText(set.name, 'ship set name'),
    models: set.models.map(readShipModel),
    prices,
  };
}

function readLogin(rows) {
  const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
  if (!Array.isArray(row?.ship_sets)) throw new Error('Supabase returned an invalid ship set catalog');
  return {
    chips: readInteger(row.chips_balance, 'chip balance', Number.MIN_SAFE_INTEGER),
    onlinePartyPrice: readInteger(row.online_party_price, 'online party price'),
    shipSets: row.ship_sets.map(readShipSet),
  };
}

export function createUsersHandler({ supabaseUrl, secretKey, appId, appSecret, fetchImpl = fetch, now } = {}) {
  const enabled = Boolean(supabaseUrl && secretKey);
  const loginUrl = enabled ? `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/admiral_user_login` : '';

  async function login(params) {
    const response = await fetchImpl(loginUrl, {
      method: 'POST',
      headers: {
        apikey: secretKey,
        Authorization: `Bearer ${secretKey}`,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify(params),
    });
    if (!response.ok) throw new Error(`Supabase request failed with status ${response.status}`);
    return readLogin(await response.json());
  }

  return async function handleUsers(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' }, { allow: 'POST' });
    if (!enabled) {
      req.resume();
      return sendJson(res, 503, { error: 'User registration is not configured' });
    }
    try {
      const body = await readJson(req);
      if (typeof body?.vk !== 'boolean') return sendJson(res, 400, { error: 'Invalid user registration' });
      let user;
      if (body.vk) {
        if (typeof body.launchParams !== 'string') return sendJson(res, 400, { error: 'Invalid user registration' });
        const launch = verifyVkLaunch(new URLSearchParams(body.launchParams), { appId, appSecret, now });
        if (!launch) return sendJson(res, 401, { error: 'Invalid VK launch parameters' });
        user = await login({ p_vk_id: String(launch.userId) });
      } else {
        const deviceId = typeof body.deviceId === 'string' ? body.deviceId.toLowerCase() : '';
        if (!DEVICE_ID.test(deviceId)) return sendJson(res, 400, { error: 'Invalid user registration' });
        user = await login({ p_device_id: deviceId });
      }
      return sendJson(res, 200, { ok: true, ...user });
    } catch (error) {
      console.error('User registration failed:', error.message);
      return sendJson(res, 503, { error: 'User registration is temporarily unavailable' });
    }
  };
}
