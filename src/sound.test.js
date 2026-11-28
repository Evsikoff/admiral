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
      const item = { connect(node) { this.output = node; }, disconnect() {}, start() { this.started = true; }, stop() { this.onended(); } };
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
  voice.volume = 0.37;
  assert.equal(sources[0].output.gain.value, 0.37);
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

test('channel levels apply to playing clips, new clips, and both sides of a music crossfade', () => {
  const { sound, clips } = director({
    music: { start: ['menu'], calm: ['game'] },
    effects: { dice: ['dice'], swimming: ['swim'] },
    commentator: { welcome: ['voice'] },
  });
  sound.setMood('start');
  sound.tick(1);
  sound.setMood('calm');
  sound.effect('dice');
  sound.startSwimming();
  sound.speak('welcome');
  const [menu, game, dice, swim, voice] = clips;
  sound.setVolume('music', 0.5);
  assert.equal(menu.volume, 0.55 * 0.5);
  assert.equal(game.volume, 0.02 * 0.5);
  sound.tick(2);
  assert.equal(menu.paused, true);
  assert.equal(game.volume, 0.3 * 0.5);
  sound.setVolume('effects', 0.25);
  assert.equal(dice.volume, 0.25);
  assert.equal(swim.volume, 0.25);
  assert.equal(voice.volume, 1);
  sound.setVolume('commentator', 0.7);
  assert.equal(voice.volume, 0.7);
  sound.effect('dice');
  assert.equal(clips.at(-1).volume, 0.25);
});

test('sea recordings rotate in game, crossfade and follow the effects fader', () => {
  const { sound, clips } = director({ effects: { atmosphere: ['sea1', 'sea2', 'sea3', 'sea4'] } });
  sound.setMood('start');
  sound.tick(1);
  assert.equal(clips.length, 0);
  sound.setMood('calm');
  sound.tick(1);
  const first = clips[0];
  first.duration = 30;
  first.currentTime = 10;
  sound.tick(1);
  const full = 0.3 * 1.1;
  assert.equal(first.volume, full);
  sound.setMuted('music', true);
  sound.setMood('anxious');
  first.currentTime = 28;
  sound.tick(1);
  const second = clips[1];
  assert.notEqual(first.src, second.src);
  assert.equal(second.volume, 0);
  first.currentTime = 29;
  second.duration = 30;
  second.currentTime = 1;
  sound.tick(1);
  sound.setVolume('effects', 0.5);
  assert.equal(first.volume, full / 4);
  assert.equal(second.volume, full / 4);
  sound.setQuiet(true);
  assert.equal(first.volume + second.volume, 0);
  sound.setQuiet(false);
  assert.equal(first.volume + second.volume, full / 2);
  sound.setMuted('effects', true);
  assert.ok(first.paused && second.paused);
  sound.tick(1);
  assert.equal(clips.length, 2);
  sound.setMuted('effects', false);
  sound.tick(1);
  const third = clips[2];
  third.duration = 30;
  third.currentTime = 29;
  sound.tick(1);
  assert.equal(new Set(clips.map(audio => audio.src)).size, 4);
  sound.setMood('start');
  assert.ok(clips.every(audio => audio.paused));
});

test('sea level follows the mastering of the current music independently of its fader', () => {
  const { sound, clips } = director({
    music: { calm: ['calm-song'], anxious: ['louder-song'] },
    atmosphereTrim: { 'calm-song': 1, 'louder-song': 1.5 },
    effects: { atmosphere: ['sea'] },
  });
  sound.setMood('calm');
  sound.tick(1);
  const sea = clips[1];
  sea.duration = 30;
  sea.currentTime = 10;
  sound.setMood('anxious');
  sound.setVolume('music', 0.2);
  sound.tick(1);
  assert.equal(sea.volume, 0.3 * 1.5 * 1.1);
});

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
