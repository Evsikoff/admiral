import { createHmac, timingSafeEqual } from 'node:crypto';

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

export function verifyVkLaunch(params, { appId, appSecret, now = () => Date.now() } = {}) {
  appId = positiveInteger(appId);
  if (!appId || !appSecret || !(params instanceof URLSearchParams)) return null;
  if (params.size !== new Set(params.keys()).size) return null;
  const userId = positiveInteger(params.get('vk_user_id'));
  const timestamp = positiveInteger(params.get('vk_ts'));
  const current = Math.floor(now() / 1000);
  if (positiveInteger(params.get('vk_app_id')) !== appId || !userId || !timestamp ||
      timestamp > current + 60 || current - timestamp > MAX_LAUNCH_AGE) return null;
  params.sort();
  const signedFields = Array.from(params).filter(([key]) => key.startsWith('vk_'))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
  const expected = createHmac('sha256', appSecret).update(signedFields).digest('base64url');
  return signaturesMatch(params.get('sign'), expected) ? { appId, userId } : null;
}
