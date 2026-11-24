(function () {
  const DEVICE_KEY = 'admiral.device.id';
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const served = location.protocol === 'http:' || location.protocol === 'https:';
  let deviceId = null;

  function externalDeviceId() {
    try { deviceId = localStorage.getItem(DEVICE_KEY); } catch { /* no storage */ }
    if (!UUID_V4.test(deviceId || '')) {
      try {
        deviceId = crypto.randomUUID();
        try { localStorage.setItem(DEVICE_KEY, deviceId); } catch { /* no storage */ }
      } catch { deviceId = null; }
    }
    return deviceId;
  }

  function logLogin(level, message, response) {
    const label = `[admiral:user-login] ${message}`;
    if (!response) {
      console[level](label);
      return;
    }
    const details = { status: response.status };
    const loginId = response.headers?.get('x-admiral-login-id');
    if (UUID_V4.test(loginId || '')) details.loginId = loginId;
    console[level](label, details);
  }

  async function acquireShipSet(shipSetId) {
    if (!deviceId || !api.shipSets) throw new Error('Device login required');
    const response = await fetch('/api/users/ship-sets/acquire', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId, shipSetId }),
    });
    if (!response.ok) throw new Error('Ship set acquisition failed');
    const { ownedShipSetIds } = await response.json();
    if (!Array.isArray(ownedShipSetIds) || !ownedShipSetIds.every(Number.isSafeInteger)) {
      throw new Error('Invalid inventory');
    }
    const owned = new Set(ownedShipSetIds);
    for (const set of api.shipSets) {
      if (!set.free) set.owned = owned.has(set.id);
    }
  }

  const api = {
    get deviceId() { return deviceId; },
    userId: null, chips: null, onlinePartyPrice: null, shipSets: null, ready: null, acquireShipSet,
  };
  window.AdmiralIdentity = api;
  api.ready = (async () => {
    if (!served) {
      logLogin('info', 'Login skipped because the game is outside HTTP(S)');
      return false;
    }
    let response;
    try {
      // The server verifies VK launch parameters. Bridge initialization and profile loading run independently.
      const launchParams = location.search;
      const params = new URLSearchParams(launchParams);
      const vk = params.has('vk_app_id') && params.has('vk_user_id') && params.has('sign');
      const body = vk ? { vk: true, launchParams } : { vk: false, deviceId: externalDeviceId() };
      if (!vk && !body.deviceId) {
        logLogin('info', 'Login skipped because a device identifier is unavailable');
        return false;
      }
      response = await fetch('/api/users/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        logLogin('warn', 'Registration endpoint returned an error', response);
        return false;
      }
      const result = await response.json();
      if (result?.ok !== true || !Number.isSafeInteger(result.userId) || result.userId < 1 || !Number.isSafeInteger(result.chips) ||
          !Number.isSafeInteger(result.onlinePartyPrice) || result.onlinePartyPrice < 0 ||
          !Array.isArray(result.shipSets)) {
        logLogin('warn', 'Login response did not match the expected format', response);
        return false;
      }
      api.userId = result.userId;
      api.chips = result.chips;
      api.onlinePartyPrice = result.onlinePartyPrice;
      api.shipSets = result.shipSets;
      logLogin('info', 'Login response accepted', response);
      return true;
    } catch {
      logLogin('warn', response ? 'Could not read the login response' : 'Could not complete the login request', response);
      return false;
    }
  })();
})();
