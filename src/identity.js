(function () {
  const DEVICE_KEY = 'admiral.device.id';
  const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const served = location.protocol === 'http:' || location.protocol === 'https:';
  let deviceId = null;

  function externalDeviceId() {
    try { deviceId = localStorage.getItem(DEVICE_KEY); } catch { /* no storage */ }
    if (!DEVICE_ID.test(deviceId || '')) {
      try {
        deviceId = crypto.randomUUID();
        try { localStorage.setItem(DEVICE_KEY, deviceId); } catch { /* no storage */ }
      } catch { deviceId = null; }
    }
    return deviceId;
  }

  const api = { get deviceId() { return deviceId; }, chips: null, ready: null };
  window.AdmiralIdentity = api;
  api.ready = (async () => {
    if (!served) return false;
    await window.AdmiralVK?.ready;
    const vk = window.isVKApp === true;
    const body = vk ? { vk: true, launchParams: location.search } : { vk: false, deviceId: externalDeviceId() };
    if (!vk && !body.deviceId) return false;
    const response = await fetch('/api/users/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(body),
    });
    if (!response.ok) return false;
    const result = await response.json();
    if (result?.ok !== true || !Number.isSafeInteger(result.chips)) return false;
    api.chips = result.chips;
    return true;
  })().catch(() => false);
})();
