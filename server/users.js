import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { parse as parseLossless } from 'lossless-json';
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
  // Older logins returned the ship set array directly in this column.
  const catalog = Array.isArray(row?.ship_sets) ? row : row?.ship_sets;
  if (!Array.isArray(catalog?.ship_sets)) throw new LoginPayloadError('Invalid ship_sets');
  const offers = catalog.purchasing_chips ?? [];
  if (!Array.isArray(offers)) throw new LoginPayloadError('Invalid purchasing_chips');
  return {
    userId: readInteger(row.user_id, 'user_id', 1),
    chips: readInteger(row.chips_balance, 'chips_balance', Number.MIN_SAFE_INTEGER),
    onlinePartyPrice: readInteger(row.online_party_price, 'online_party_price'),
    shipSets: catalog.ship_sets.map(readShipSet),
    purchasingChips: offers.map(offer => ({
      id: readInteger(offer?.id, 'purchasing_chips.id'),
      name: readText(offer.name, 'purchasing_chips.name'),
      icon: readText(offer.icon, 'purchasing_chips.icon'),
      price_vk: readInteger(offer.price_vk, 'purchasing_chips.price_vk'),
    })),
  };
}

async function readSupabaseErrorCode(response) {
  try {
    const code = (await response.json())?.code;
    if (typeof code === 'string' && SUPABASE_ERROR_CODE.test(code)) return code;
  } catch { /* a non-JSON error still has an HTTP status */ }
}

export function createUserService({ supabaseUrl, secretKey, appId, appSecret, fetchImpl = fetch, now, logger = console } = {}) {
  const missingEnv = [];
  if (!supabaseUrl) missingEnv.push('SUPABASE_URL');
  if (!secretKey) missingEnv.push('SUPABASE_SECRET_KEY');
  const enabled = missingEnv.length === 0;
  const vkConfigured = Boolean(appId && appSecret);
  const rpcUrl = enabled ? `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc` : '';
  const acquiringDevices = new Set();
  const pendingParties = new Map();
  const ticketKey = randomBytes(32);
  const sign = claims => createHmac('sha256', ticketKey).update(claims).digest('base64url');
  function onlineAccount(ticket) {
    if (typeof ticket !== 'string') return null;
    const match = /^([1-9]\d{0,15})\.(\d{1,16})\.(device|vk)\.([\w-]{43})$/.exec(ticket);
    if (!match || !timingSafeEqual(Buffer.from(match[4]), Buffer.from(sign(`${match[1]}.${match[2]}.${match[3]}`)))) return null;
    return { userId: Number(match[1]), loginAt: Number(match[2]), mode: match[3] };
  }
  const log = (level, event, fields) => logger[level](`[admiral:user-login] ${JSON.stringify({ event, ...fields })}`);
  log(enabled ? 'info' : 'warn', 'configuration', { missingEnv, vkConfigured });

  async function rpc(name, params) {
    return fetchImpl(`${rpcUrl}/${name}`, {
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

  async function registerParty(participants, users) {
    if (!enabled) throw new Error('Online parties are not configured');
    const response = await rpc('admiral_online_party_start', { p_participants: participants });
    if (!response.ok) throw new Error(`Party RPC returned HTTP ${response.status}`);
    // PostgreSQL bigint party IDs can exceed the precision of a JavaScript number.
    const result = parseLossless(await response.text(), null, { parseNumber: digits => digits });
    const success = result?.success === true;
    if (!success && !(result?.success === false && result.error === 'insufficient_chips')) {
      throw new Error('Invalid party result');
    }
    const balances = new Map();
    for (const row of success ? result.user_balances : result.insufficient_balance_users) {
      const id = readInteger(row.user_id, 'user_id', 1);
      if (!users.has(id)) throw new Error('Unexpected account in party result');
      balances.set(id, readInteger(row.chip_balance, 'chip_balance', Number.MIN_SAFE_INTEGER));
    }
    if (!success && balances.size) return { success, balances, price: readInteger(result.party_price, 'party_price') };
    if (!success || balances.size !== users.size || typeof result.party_id !== 'string' || !/^[1-9]\d*$/.test(result.party_id)) {
      throw new Error('Incomplete party result');
    }
    return { success, partyId: result.party_id, balances };
  }

  // Two tables can contain the same account. Deliver charges and payouts in order.
  async function withPartyAccounts(users, operation) {
    const previous = [...users].map(id => pendingParties.get(id)).filter(Boolean);
    const started = Promise.allSettled(previous).then(operation);
    for (const id of users) pendingParties.set(id, started);
    try {
      return await started;
    } finally {
      for (const id of users) if (pendingParties.get(id) === started) pendingParties.delete(id);
    }
  }

  function startOnlineParty(participants) {
    const users = new Set(participants.filter(p => p.user_id != null).map(p => p.user_id));
    return withPartyAccounts(users, () => registerParty(participants, users));
  }

  function finishOnlineParty(partyId, winner) {
    const botWon = winner.bot_name !== undefined;
    return withPartyAccounts(botWon ? [] : [winner.winner_user_id], async () => {
      const response = await rpc('admiral_online_party_results', {
        party_id: partyId, ...winner,
      });
      if (!response.ok) {
        const error = new Error(`Party results RPC returned HTTP ${response.status}`);
        error.retryable = response.status >= 500 || [408, 429].includes(response.status);
        throw error;
      }
      const rows = parseLossless(await response.text(), null, { parseNumber: digits => digits });
      if (!Array.isArray(rows) || rows.length !== 1) throw new LoginPayloadError('Expected one party results row');
      return {
        winnings: readInteger(rows[0]?.winnings_amount, 'winnings_amount'),
        balance: botWon && rows[0].winner_user_balance === null ? null
          : readInteger(rows[0].winner_user_balance, 'winner_user_balance', Number.MIN_SAFE_INTEGER),
      };
    });
  }

  async function acquireShipSet(req, res) {
    if (!enabled) return sendJson(res, 503, { error: 'Inventory is unavailable' });
    const body = await readJson(req).catch(() => null);
    const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.toLowerCase() : '';
    if (!DEVICE_ID.test(deviceId) || !Number.isSafeInteger(body.shipSetId)) {
      return sendJson(res, 400, { error: 'Invalid ship set request' });
    }
    if (acquiringDevices.has(deviceId)) return sendJson(res, 409, { error: 'Acquisition in progress' });
    acquiringDevices.add(deviceId);
    try {
      // Resolve the account and current ownership server-side, including on retries.
      const login = await rpc('admiral_user_login', { p_device_id: deviceId });
      if (!login.ok) throw new Error('Login failed');
      const user = readLogin(await login.json());
      const set = user.shipSets.find(set => set.id === body.shipSetId);
      if (!set || set.free) return sendJson(res, 400, { error: 'Expected a paid ship set' });
      let ownedShipSetIds;
      if (set.owned) {
        ownedShipSetIds = user.shipSets.filter(set => !set.free && set.owned).map(set => set.id);
      } else {
        const response = await rpc('admiral_inventory_acquisition', {
          p_user_id: user.userId, p_change_type: 'purchase', p_type_inventory: 'ship_set',
          p_inventory_id: set.id, p_quantity: 1, p_details: null,
        });
        if (!response.ok) throw new Error('Acquisition failed');
        const inventory = await response.json();
        if (!Array.isArray(inventory?.user_ship_sets)) throw new Error('Invalid inventory');
        ownedShipSetIds = inventory.user_ship_sets.map(entry => {
          readInteger(entry?.quantity, 'quantity', 1);
          return readInteger(entry.ship_set_id, 'ship_set_id');
        });
      }
      return sendJson(res, 200, { ownedShipSetIds });
    } catch {
      return sendJson(res, 503, { error: 'Inventory is temporarily unavailable' });
    } finally {
      acquiringDevices.delete(deviceId);
    }
  }

  async function acquireChips(req, res) {
    if (!enabled) return sendJson(res, 503, { error: 'Chip purchases are unavailable' });
    const body = await readJson(req).catch(() => null);
    const account = onlineAccount(body?.onlineTicket);
    if (account?.mode !== 'device') return sendJson(res, 403, { error: 'Device login required' });
    if (!Number.isSafeInteger(body.purchasingChipsId) || body.purchasingChipsId < 1) {
      return sendJson(res, 400, { error: 'Invalid chip package' });
    }
    try {
      const response = await rpc('admiral_chips_acquisition', {
        user_id: account.userId, purchasing_chips_id: body.purchasingChipsId,
      });
      if (!response.ok) throw new Error('Chip acquisition failed');
      const rows = await response.json();
      if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Expected one balance row');
      const balance = readInteger(rows[0]?.balance, 'balance', Number.MIN_SAFE_INTEGER);
      return sendJson(res, 200, { balance });
    } catch {
      return sendJson(res, 503, { error: 'Could not confirm chip balance' });
    }
  }

  async function handleUsers(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' }, { allow: 'POST' });
    if (req.url.split('?')[0] === '/api/users/ship-sets/acquire') return acquireShipSet(req, res);
    if (req.url.split('?')[0] === '/api/users/chips/acquire') return acquireChips(req, res);
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
      const loginAt = Date.now();
      trace('info', 'rpc_started', { rpc: 'public.admiral_user_login' });
      const response = await rpc('admiral_user_login', params);
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
      const claims = `${user.userId}.${loginAt}.${mode}`;
      return sendJson(res, 200, { ok: true, ...user, onlineTicket: `${claims}.${sign(claims)}` });
    } catch (error) {
      const reason = error?.name === 'TimeoutError' ? 'rpc_timeout' : `${stage}_failed`;
      const validationError = error instanceof LoginPayloadError ? error.message : undefined;
      return fail(503, reason, 'User registration is temporarily unavailable', { validationError });
    }
  }
  return { handleUsers, onlineAccount, startOnlineParty, finishOnlineParty };
}
