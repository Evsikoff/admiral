import { verifyVkLaunch } from './vk-launch.js';

const MAX_BODY_BYTES = 16 * 1024;
const CHIPS_FIELD = 'Количество фишек пользователя';
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
  const enterUrl = enabled ? `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/admiral_user_enter` : '';

  async function enter(params) {
    const response = await fetchImpl(enterUrl, {
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
    const rows = await response.json();
    const chips = Array.isArray(rows) && rows.length === 1 ? rows[0]?.[CHIPS_FIELD] : null;
    if (!Number.isSafeInteger(chips)) throw new Error('Supabase returned an invalid chip balance');
    return chips;
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
      let chips;
      if (body.vk) {
        if (typeof body.launchParams !== 'string') return sendJson(res, 400, { error: 'Invalid user registration' });
        const launch = verifyVkLaunch(new URLSearchParams(body.launchParams), { appId, appSecret, now });
        if (!launch) return sendJson(res, 401, { error: 'Invalid VK launch parameters' });
        chips = await enter({ p_vk_id: String(launch.userId) });
      } else {
        const deviceId = typeof body.deviceId === 'string' ? body.deviceId.toLowerCase() : '';
        if (!DEVICE_ID.test(deviceId)) return sendJson(res, 400, { error: 'Invalid user registration' });
        chips = await enter({ p_device_id: deviceId });
      }
      return sendJson(res, 200, { ok: true, chips });
    } catch (error) {
      console.error('User registration failed:', error.message);
      return sendJson(res, 503, { error: 'User registration is temporarily unavailable' });
    }
  };
}
