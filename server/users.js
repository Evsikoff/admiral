import { randomUUID } from 'node:crypto';
import { verifyVkLaunch } from './vk-launch.js';

const MAX_BODY_BYTES = 16 * 1024;
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUPABASE_ERROR_CODE = /^(?:PGRST\d{3}|[0-9A-Z]{5})$/;

class LoginPayloadError extends Error {}

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
    throw new LoginPayloadError(`Invalid ${field}`);
  }
  return number;
}

function readText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new LoginPayloadError(`Invalid ${field}`);
  return value;
}

function readShipModel(model) {
  return {
    id: readInteger(model?.id, 'ship_sets.models.id'),
    model_type: readText(model.model_type, 'ship_sets.models.model_type'),
    base_model_url: readText(model.base_model_url, 'ship_sets.models.base_model_url'),
  };
}

function readShipPrice(price) {
  return {
    id: readInteger(price?.id, 'ship_sets.prices.id'),
    price: readInteger(price.price, 'ship_sets.prices.price'),
    item_id: readText(price.item_id, 'ship_sets.prices.item_id'),
    discount: price.discount === null ? null : readInteger(price.discount, 'ship_sets.prices.discount'),
    number_defeated_opponents: readInteger(price.number_defeated_opponents, 'ship_sets.prices.number_defeated_opponents'),
  };
}

function readShipSet(set) {
  if (typeof set?.free !== 'boolean') throw new LoginPayloadError('Invalid ship_sets.free');
  if (typeof set.owned !== 'boolean') throw new LoginPayloadError('Invalid ship_sets.owned');
  if (!Array.isArray(set.models)) throw new LoginPayloadError('Invalid ship_sets.models');
  if (!Array.isArray(set.prices)) throw new LoginPayloadError('Invalid ship_sets.prices');
  const prices = set.prices.map(readShipPrice);
  if (!set.free && !set.owned && !prices.some(price => price.number_defeated_opponents === 0)) {
    throw new LoginPayloadError('Missing base price in ship_sets.prices');
  }
  return {
    id: readInteger(set.id, 'ship_sets.id'),
    free: set.free,
    owned: set.owned,
    icon: readText(set.icon, 'ship_sets.icon'),
    name: readText(set.name, 'ship_sets.name'),
    models: set.models.map(readShipModel),
    prices,
  };
}

function readLogin(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) throw new LoginPayloadError('Expected one login row');
  const [row] = rows;
  if (!Array.isArray(row?.ship_sets)) throw new LoginPayloadError('Invalid ship_sets');
  return {
    chips: readInteger(row.chips_balance, 'chips_balance', Number.MIN_SAFE_INTEGER),
    onlinePartyPrice: readInteger(row.online_party_price, 'online_party_price'),
    shipSets: row.ship_sets.map(readShipSet),
  };
}

async function readSupabaseErrorCode(response) {
  try {
    const code = (await response.json())?.code;
    if (typeof code === 'string' && SUPABASE_ERROR_CODE.test(code)) return code;
  } catch { /* a non-JSON error still has an HTTP status */ }
}

export function createUsersHandler({ supabaseUrl, secretKey, appId, appSecret, fetchImpl = fetch, now, logger = console } = {}) {
  const missingEnv = [];
  if (!supabaseUrl) missingEnv.push('SUPABASE_URL');
  if (!secretKey) missingEnv.push('SUPABASE_SECRET_KEY');
  const enabled = missingEnv.length === 0;
  const vkConfigured = Boolean(appId && appSecret);
  const loginUrl = enabled ? `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/admiral_user_login` : '';
  const log = (level, event, fields) => logger[level](`[admiral:user-login] ${JSON.stringify({ event, ...fields })}`);
  log(enabled ? 'info' : 'warn', 'configuration', { missingEnv, vkConfigured });

  async function login(params) {
    return fetchImpl(loginUrl, {
      method: 'POST',
      headers: {
        apikey: secretKey,
        Authorization: `Bearer ${secretKey}`,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify(params),
    });
  }

  return async function handleUsers(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' }, { allow: 'POST' });
    const loginId = randomUUID();
    const startedAt = performance.now();
    let mode, supabaseStatus;
    let stage = 'request';
    res.setHeader('x-admiral-login-id', loginId);
    const trace = (level, event, fields) => log(level, event, {
      loginId, mode, elapsedMs: Math.round(performance.now() - startedAt), supabaseStatus, ...fields,
    });
    function fail(status, reason, message, details) {
      trace(status >= 500 ? 'error' : 'warn', 'failed', { status, reason, ...details });
      return sendJson(res, status, { error: message });
    }
    if (!enabled) {
      req.resume();
      return fail(503, 'supabase_not_configured', 'User registration is not configured', { missingEnv });
    }
    try {
      const body = await readJson(req);
      if (typeof body?.vk !== 'boolean') return fail(400, 'invalid_request', 'Invalid user registration');
      mode = body.vk ? 'vk' : 'device';
      let params;
      if (body.vk) {
        if (typeof body.launchParams !== 'string') return fail(400, 'invalid_request', 'Invalid user registration');
        const launch = verifyVkLaunch(new URLSearchParams(body.launchParams), { appId, appSecret, now });
        const reason = vkConfigured ? 'invalid_vk_launch' : 'vk_not_configured';
        if (!launch) return fail(401, reason, 'Invalid VK launch parameters');
        params = { p_vk_id: String(launch.userId) };
      } else {
        const deviceId = typeof body.deviceId === 'string' ? body.deviceId.toLowerCase() : '';
        if (!DEVICE_ID.test(deviceId)) return fail(400, 'invalid_device_id', 'Invalid user registration');
        params = { p_device_id: deviceId };
      }
      stage = 'rpc_fetch';
      trace('info', 'rpc_started', { rpc: 'public.admiral_user_login' });
      const response = await login(params);
      supabaseStatus = response.status;
      if (!response.ok) {
        const supabaseCode = await readSupabaseErrorCode(response);
        return fail(503, 'rpc_http_error', 'User registration is temporarily unavailable', { supabaseCode });
      }
      stage = 'rpc_json';
      const rows = await response.json();
      stage = 'rpc_validation';
      const user = readLogin(rows);
      trace('info', 'succeeded', { status: 200, shipSetCount: user.shipSets.length });
      return sendJson(res, 200, { ok: true, ...user });
    } catch (error) {
      const reason = error?.name === 'TimeoutError' ? 'rpc_timeout' : `${stage}_failed`;
      const validationError = error instanceof LoginPayloadError ? error.message : undefined;
      return fail(503, reason, 'User registration is temporarily unavailable', { validationError });
    }
  };
}
