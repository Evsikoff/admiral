// VK Bridge is optional: outside VK the game keeps its usual editable player names.
(function () {
  window.isVKApp = false;
  window.vkUserName = '';

  const bridge = window.vkBridge;
  const api = {
    get isVK() { return window.isVKApp; },
    get name() { return window.vkUserName; },
    ready: null,
  };
  window.AdmiralVK = api;

  api.ready = (async () => {
    if (!bridge) return;
    try {
      await bridge.send('VKWebAppInit');
      const user = await bridge.send('VKWebAppGetUserInfo');
      const name = `${user?.first_name || ''} ${user?.last_name || ''}`.replace(/\s+/g, ' ').trim().slice(0, 20);
      if (!name) return;
      window.isVKApp = true;
      window.vkUserName = name;
      window.dispatchEvent(new CustomEvent('admiral:vk-user', { detail: { name } }));
    } catch { /* Bridge is unavailable or the user data request was refused. */ }
  })();
})();
