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

function director(manifest) {
  const clips = [];
  class Audio {
    constructor(src) { this.src = src; this.dataset = {}; this.paused = true; clips.push(this); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    addEventListener() {}
  }
  const window = { addEventListener() {} };                 // no AudioContext: plain audio elements
  const make = new Function('window', 'Audio', source + '\nreturn createSoundDirector;')(window, Audio);
  return { sound: make(manifest), clips };
}

test('the call to a turn plays the least-played sound of the session, across games, and stops when answered', () => {
  const { sound, clips } = director({ effects: { turn: ['a.mp3', 'b.mp3', 'c.mp3'], dice: ['d.mp3'] } });
  const plays = () => sound.counts('turn').map((c) => c.plays);
  const first = [sound.callTurn(), sound.callTurn(), sound.callTurn()];
  assert.deepEqual([...first].sort(), ['a.mp3', 'b.mp3', 'c.mp3']);
  sound.effect('dice');
  sound.resetGame();                                         // a new game: other effects start afresh, the call does not
  assert.deepEqual(plays(), [1, 1, 1]);
  assert.deepEqual(sound.counts('dice').map((c) => c.plays), [0]);
  sound.callTurn();
  sound.callTurn();
  assert.deepEqual(plays().sort(), [1, 2, 2]);
  sound.callTurn();                                          // the one still played once
  assert.deepEqual(plays(), [2, 2, 2]);
  const playing = clips.at(-1);
  assert.equal(playing.paused, false);
  sound.stopTurnCall();
  assert.equal(playing.paused, true);
  assert.equal(playing.dataset.stopped, '1');
  sound.setMuted('effects', true);
  assert.equal(sound.callTurn(), null);
  assert.deepEqual(plays(), [2, 2, 2]);
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
