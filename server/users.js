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

export function createUsersHandler({ supabaseUrl, secretKey, appId, appSecret, fetchImpl = fetch, now } = {}) {
  const enabled = Boolean(supabaseUrl && secretKey);
  const tableUrl = enabled ? `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/admiral_users` : '';
  const pending = new Map();

  async function request(query, init = {}) {
    const response = await fetchImpl(tableUrl + query, {
      ...init,
      headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}`, ...init.headers },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Supabase request failed with status ${response.status}`);
    return response;
  }

  async function findUser(field, value) {
    const query = new URLSearchParams({ [field]: `eq.${value}`, select: 'id', limit: '1' });
    const rows = await request(`?${query}`).then((response) => response.json());
    if (!Array.isArray(rows)) throw new Error('Supabase returned an invalid user lookup');
    return rows[0] || null;
  }

  async function registerNow(field, value) {
    if (await findUser(field, value)) return;
    await request('', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ [field]: value }),
    });
  }

  function register(key, field, value) {
    const previous = pending.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => registerNow(field, value));
    pending.set(key, operation);
    return operation.finally(() => {
      if (pending.get(key) === operation) pending.delete(key);
    });
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
      if (body.vk) {
        if (typeof body.launchParams !== 'string') return sendJson(res, 400, { error: 'Invalid user registration' });
        const launch = verifyVkLaunch(new URLSearchParams(body.launchParams), { appId, appSecret, now });
        if (!launch) return sendJson(res, 401, { error: 'Invalid VK launch parameters' });
        const vkId = String(launch.userId);
        await register(`vk:${vkId}`, 'vk_id', vkId);
      } else {
        const deviceId = typeof body.deviceId === 'string' ? body.deviceId.toLowerCase() : '';
        if (!DEVICE_ID.test(deviceId)) return sendJson(res, 400, { error: 'Invalid user registration' });
        await register(`device:${deviceId}`, 'device_id', deviceId);
      }
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      console.error('User registration failed:', error.message);
      return sendJson(res, 503, { error: 'User registration is temporarily unavailable' });
    }
  };
}
