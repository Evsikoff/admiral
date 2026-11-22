// Playback uses the exact bytes counted by the loading screen, without a second network request.
// Keep compressed blobs; decoding every voice at once would exhaust an iPad's memory.
(function () {
  const entries = window.ADMIRAL.preload;
  const films = entries.filter((entry) => entry.type.startsWith('video/'));
  const files = new Map(), urls = new Map(), received = new Map(), tasks = new Map(), listeners = new Set();
  const queue = [];
  const local = location.protocol === 'file:';
  let active = 0;
  const api = {
    load, loadFilms, subscribe: (onProgress) => subscribe(onProgress, entries),
    isReady: () => local || entries.every((entry) => files.has(entry.url)),
    filmsReady: () => local || films.every((entry) => files.has(entry.url)),
    blob: (url) => files.get(url), url: (url) => urls.get(url) || url,
  };
  window.AdmiralAssets = api;

  function load(onProgress = () => {}) { return loadGroup(entries, onProgress); }
  function loadFilms(onProgress = () => {}) { return loadGroup(films, onProgress); }
  function loadGroup(group, onProgress) {
    const unsubscribe = subscribe(onProgress, group);
    return request(group).finally(unsubscribe);
  }
  function subscribe(onProgress, group) {
    const listener = { onProgress, group };
    listeners.add(listener);
    onProgress(snapshot(group));
    return () => listeners.delete(listener);
  }
  function snapshot(group) {
    const total = group.reduce((sum, entry) => sum + entry.size, 0);
    const completed = group.filter((entry) => files.has(entry.url)).length;
    const loaded = group.reduce((sum, entry) => sum + (files.has(entry.url)
      ? entry.size : Math.min(entry.size, received.get(entry.url) || 0)), 0);
    // A directly opened local game uses its media paths; browsers cannot fetch file: URLs.
    return local ? { loaded: total, total, completed: group.length, count: group.length }
      : { loaded, total, completed, count: group.length };
  }
  function progress() { for (const listener of [...listeners]) listener.onProgress(snapshot(listener.group)); }

  async function request(group) {
    if (local) return;
    const results = await Promise.allSettled(group.map(schedule));
    const errors = results.flatMap((result, i) => result.status === 'rejected' ? [group[i].url] : []);
    if (errors.length) throw new Error(`Не удалось загрузить файлов: ${errors.length}. Проверьте соединение и повторите.`, { cause: errors });
  }
  function schedule(entry) {
    if (files.has(entry.url)) return Promise.resolve();
    if (tasks.has(entry.url)) return tasks.get(entry.url).promise;
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const task = { entry, promise, resolve, reject };
    tasks.set(entry.url, task); queue.push(task); pump();
    return promise;
  }
  function pump() {
    while (active < 4 && queue.length) {
      const task = queue.shift();
      active++;
      download(task.entry).then(task.resolve).catch((error) => {
        tasks.delete(task.entry.url);
        received.set(task.entry.url, 0); progress();
        console.warn('Asset download failed:', task.entry.url, error);
        task.reject(error);
      }).finally(() => { active--; pump(); });
    }
  }

  async function download(entry) {
    const controller = new AbortController();
    let timer;
    const activeTimeout = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), 30000); };
    try {
      received.set(entry.url, 0); activeTimeout(); progress();
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
          received.set(entry.url, size); activeTimeout(); progress();
        }
      } else {
        const bytes = await response.arrayBuffer();
        chunks.push(bytes); size = bytes.byteLength;
        received.set(entry.url, size);
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
      received.set(entry.url, entry.size); setStyle(entry.url, objectURL); progress();
    } finally { clearTimeout(timer); }
  }
  function setStyle(path, url) {
    const names = { 'assets/menu/plank.webp': 'plank', 'assets/menu/tavern.webp': 'tavern',
      'assets/menu/tavern_portrait.webp': 'tavern-portrait', 'assets/menu/parchment.webp': 'parchment' };
    if (names[path]) document.documentElement.style.setProperty('--asset-' + names[path], `url("${url}")`);
  }
})();
