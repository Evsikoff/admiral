// Playback uses the exact bytes counted by the loading screen, without a second network request.
// Keep compressed blobs; decoding every voice at once would exhaust an iPad's memory.
(function () {
  const files = new Map(), urls = new Map(), received = new Map();
  let loading = null;
  const api = { load, blob: (url) => files.get(url), url: (url) => urls.get(url) || url };
  window.AdmiralAssets = api;

  function load(onProgress = () => {}) {
    if (loading) return loading;
    loading = download(onProgress).finally(() => { loading = null; });
    return loading;
  }

  async function download(onProgress) {
    // Browsers cannot fetch file: URLs. Directly opened local games keep using their local media paths.
    if (location.protocol === 'file:') return;
    const entries = window.ADMIRAL.preload;
    const total = entries.reduce((sum, entry) => sum + entry.size, 0);
    let completed = entries.filter((entry) => files.has(entry.url)).length;
    const progress = () => onProgress({
      loaded: entries.reduce((sum, entry) => sum + Math.min(entry.size, received.get(entry.url) || 0), 0),
      total, completed, count: entries.length,
    });
    const pending = entries.filter((entry) => !files.has(entry.url));
    const errors = [];
    progress();
    async function worker() {
      while (pending.length) {
        const entry = pending.shift();
        const controller = new AbortController();
        let timer;
        const active = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), 30000); };
        try {
          received.set(entry.url, 0);
          active();
          const response = await fetch(entry.url + (entry.url.includes('?') ? '&' : '?') + 'v=' + entry.hash,
            { signal: controller.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const chunks = [];
          let size = 0;
          if (response.body?.getReader) {
            const reader = response.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value); size += value.byteLength;
              received.set(entry.url, size); active(); progress();
            }
          } else {
            const bytes = await response.arrayBuffer();
            chunks.push(bytes); size = bytes.byteLength;
          }
          if (size !== entry.size) throw new Error('Неполный файл');
          const blob = new Blob(chunks, { type: response.headers.get('content-type') || entry.type });
          const objectURL = URL.createObjectURL(blob);
          try {
            if (entry.type.startsWith('image/')) {
              const image = new Image();
              image.src = objectURL;
              await image.decode();
            }
          } catch (error) { URL.revokeObjectURL(objectURL); throw error; }
          files.set(entry.url, blob); urls.set(entry.url, objectURL);
          received.set(entry.url, entry.size); completed++; progress();
        } catch (error) {
          received.set(entry.url, 0);
          errors.push(entry.url);
          console.warn('Asset download failed:', entry.url, error);
        } finally { clearTimeout(timer); }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
    if (errors.length) throw new Error(`Не удалось загрузить файлов: ${errors.length}. Проверьте соединение и повторите.`, { cause: errors });
    for (const [name, path] of Object.entries({ plank: 'assets/menu/plank.webp', tavern: 'assets/menu/tavern.webp',
      'tavern-portrait': 'assets/menu/tavern_portrait.webp', parchment: 'assets/menu/parchment.webp' })) {
      document.documentElement.style.setProperty('--asset-' + name, `url("${api.url(path)}")`);
    }
  }
})();
