import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('assets.js', import.meta.url), 'utf8');
function setup(entries, fetch) {
  const window = { ADMIRAL: { preload: entries } };
  const properties = new Map();
  const document = { documentElement: { style: { setProperty: (key, value) => properties.set(key, value) } } };
  new Function('window', 'location', 'fetch', 'document', 'URL', source)(window,
    { protocol: 'https:' }, fetch, document, { createObjectURL: () => 'blob:' + Math.random(), revokeObjectURL() {} });
  return window.AdmiralAssets;
}
const entry = (url) => ({ url, size: 6, hash: 'abc123', type: 'audio/mpeg' });
const response = () => new Response(new ReadableStream({ start(controller) {
  controller.enqueue(new Uint8Array([1, 2, 3]));
  controller.enqueue(new Uint8Array([4, 5, 6]));
  controller.close();
} }), { headers: { 'content-type': 'audio/mpeg' } });

test('loading counts received bytes and retains the exact media for playback', async () => {
  const requests = [], progress = [];
  const assets = setup([entry('voice.mp3')], async (url) => { requests.push(url); return response(); });
  await assets.load((state) => progress.push(state));
  assert.deepEqual(requests, ['voice.mp3?v=abc123']);
  assert.ok(progress.some((state) => state.loaded === 3 && state.completed === 0));
  assert.deepEqual(progress.at(-1), { loaded: 6, total: 6, completed: 1, count: 1 });
  assert.deepEqual([...new Uint8Array(await assets.blob('voice.mp3').arrayBuffer())], [1, 2, 3, 4, 5, 6]);
  assert.match(assets.url('voice.mp3'), /^blob:/);
  assert.equal(assets.url('unknown.mp3'), 'unknown.mp3');
  await assets.load();
  assert.equal(requests.length, 1);
});

test('a failed file prevents readiness and retry downloads only missing files', async () => {
  const requests = [];
  let failing = true;
  const assets = setup([entry('good.mp3'), entry('bad.mp3?version=1')], async (url) => {
    requests.push(url);
    return failing && url.startsWith('bad') ? new Response('', { status: 404 }) : response();
  });
  await assert.rejects(assets.load(), /Не удалось загрузить файлов: 1/);
  assert.ok(assets.blob('good.mp3'));
  assert.equal(assets.blob('bad.mp3?version=1'), undefined);
  failing = false;
  await assets.load();
  assert.deepEqual(requests, ['good.mp3?v=abc123', 'bad.mp3?version=1&v=abc123', 'bad.mp3?version=1&v=abc123']);
});

test('films form a separate first group; the remaining files load without fetching them again', async () => {
  const entries = [
    { ...entry('studio.mp4'), type: 'video/mp4' },
    { ...entry('voice.mp3') },
    { ...entry('intro.mp4'), type: 'video/mp4' },
  ];
  const requests = [];
  const assets = setup(entries, async (url) => { requests.push(url); return response(); });
  await assets.loadFilms();
  assert.deepEqual(requests, ['studio.mp4?v=abc123', 'intro.mp4?v=abc123']);
  assert.equal(assets.filmsReady(), true);
  assert.equal(assets.isReady(), false);
  await assets.load();
  assert.deepEqual(requests, ['studio.mp4?v=abc123', 'intro.mp4?v=abc123', 'voice.mp3?v=abc123']);
  assert.equal(assets.isReady(), true);
});

test('concurrent groups share downloads and progress subscriptions see the final state', async () => {
  let respond;
  const requests = [], states = [];
  const assets = setup([entry('voice.mp3')], async (url) => {
    requests.push(url);
    return new Promise((resolve) => { respond = () => resolve(response()); });
  });
  const unsubscribe = assets.subscribe((state) => states.push(state));
  const first = assets.load(), second = assets.load();
  assert.equal(requests.length, 1);
  respond();
  await Promise.all([first, second]);
  assert.deepEqual(states.at(-1), { loaded: 6, total: 6, completed: 1, count: 1 });
  unsubscribe();
});

test('truncated media is rejected and downloads are limited to four at a time', async () => {
  const entries = Array.from({ length: 9 }, (_, i) => entry(`${i}.mp3`));
  let active = 0, peak = 0;
  const assets = setup(entries, async () => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return response();
  });
  await assets.load();
  assert.equal(peak, 4);
  const truncated = setup([entry('short.mp3')], async () => new Response(new Uint8Array(2)));
  await assert.rejects(truncated.load(), /Не удалось загрузить файлов: 1/);
  assert.equal(truncated.blob('short.mp3'), undefined);
});
