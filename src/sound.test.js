import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('sound.js', import.meta.url), 'utf8');
function setup(decode) {
  let context;
  const sources = [];
  class Context {
    constructor() { context = this; this.state = 'suspended'; this.currentTime = 0; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    decodeAudioData(bytes) { this.decodes = (this.decodes || 0) + 1; return decode ? decode(bytes) : Promise.resolve({ duration: 4 }); }
    createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
    createBufferSource() {
      const item = { connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.onended(); } };
      sources.push(item);
      return item;
    }
  }
  class Audio {
    constructor(src) { this.src = src; this.dataset = {}; }
    play() { return Promise.resolve(); }
    pause() {}
    getAttribute() { return this.src; }
  }
  const window = { AudioContext: Context, AdmiralAssets: { blob: () => new Blob([new Uint8Array(6)]) } };
  const backend = new Function('window', 'Audio', source + '\nreturn createGameAudio();')(window, Audio);
  backend.unlock();
  return { backend, sources, context };
}

test('gesture-unlocked audio plays later events from downloaded bytes and reuses decoded clips', async () => {
  const { backend, sources, context } = setup();
  const voice = backend.clip('welcome.mp3');
  await voice.play();
  assert.equal(sources.length, 1);
  assert.equal(sources[0].started, true);
  assert.equal(voice.duration, 4);
  context.currentTime = 2;
  assert.equal(voice.currentTime, 2);
  let ended = 0;
  voice.addEventListener('ended', () => ended++);
  sources[0].onended();
  assert.equal(ended, 1);
  assert.equal(voice.ended, true);
  await backend.clip('welcome.mp3').play();
  assert.equal(context.decodes, 1);
});

test('stopping while decoding prevents a stale voice from starting', async () => {
  let finish;
  const { backend, sources } = setup(() => new Promise((resolve) => { finish = resolve; }));
  const voice = backend.clip('old-event.mp3');
  const playing = voice.play();
  await new Promise((resolve) => setImmediate(resolve));
  voice.pause();
  finish({ duration: 4 });
  await playing;
  assert.equal(sources.length, 0);
  assert.equal(voice.paused, true);
});

test('muting a playing voice stops its source without queuing a stale ended event', async () => {
  const { backend, sources } = setup();
  const voice = backend.clip('event.mp3');
  await voice.play();
  let ended = 0;
  voice.addEventListener('ended', () => ended++);
  voice.pause();
  assert.equal(ended, 0);
  assert.equal(voice.paused, true);
  assert.equal(voice.source, null);
  assert.equal(sources.length, 1);
});
