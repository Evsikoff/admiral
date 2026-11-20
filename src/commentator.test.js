import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// The build joins these files into one browser module.
const source = ['sound.js', 'commentator.js'].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
const loadDirectors = new Function('Audio', 'window', `${source}\nreturn { createSoundDirector, createCommentator };`);

function setup(buckets, play = () => Promise.resolve()) {
  const clips = [], captions = [];
  const window = new EventTarget();
  class TestAudio extends EventTarget {
    constructor(src) {
      super();
      this.src = src;
      this.dataset = {};
      this.paused = true;
      this.ended = false;
      clips.push(this);
    }
    play() {
      this.paused = false;
      return play(this.src);
    }
    pause() { this.paused = true; }
    end() {
      this.paused = true;
      this.ended = true;
      this.dispatchEvent(new Event('ended'));
    }
  }
  const url = (bucket) => `${bucket}/01.mp3`;
  const { createSoundDirector, createCommentator } = loadDirectors(TestAudio, window);
  const sound = createSoundDirector({ commentator: Object.fromEntries(buckets.map((b) => [b, [url(b)]])) });
  const lines = Object.fromEntries(buckets.map((bucket) => [bucket, [bucket]]));
  const announcer = createCommentator({ sound, say: (html) => captions.push(html), lines, swatch: () => '', DIE_TWO: { 2: 'two twos' } });
  return { sound, announcer, clips, captions, window, url };
}

test('commentator finishes the current clip and speaks again only on a fresh event', () => {
  const buckets = ['game_start_ru', 'turn_first_ru', 'roll_double_ru', 'no_move_empty_ru', 'double_bonus_ru', 'repair_ru'];
  const { sound, announcer, clips, captions, url } = setup(buckets);
  const doubleThrow = { q: 'ru', first: true, dice: [2, 2], o: { acts: new Map() } };
  announcer.gameStart('ru', 'Captain');
  announcer.turnStart('ru', 'Captain', true);
  announcer.afterRollOrStep(doubleThrow);
  announcer.doubleBonus('ru');

  assert.equal(clips.length, 1);
  assert.equal(clips[0].paused, false);
  assert.equal(sound.currentVoice, url('game_start_ru'));
  assert.match(captions[2], /roll_double_ru.*no_move_empty_ru/);
  clips[0].end();
  assert.equal(sound.currentVoice, null);
  assert.equal(clips.length, 1);

  announcer.afterRollOrStep(doubleThrow);
  assert.equal(sound.currentVoice, url('roll_double_ru'));
  clips[1].end();
  assert.equal(sound.currentVoice, null);
  assert.equal(clips.length, 2);

  announcer.repair('ru');
  assert.equal(sound.currentVoice, url('repair_ru'));
});

test('the opening turn waits for the welcome, while later turns follow the usual rule', () => {
  const { sound, announcer, clips, url } = setup(['game_start_ru', 'turn_first_ru', 'turn_first_en']);
  announcer.gameStart('ru', 'Captain');
  announcer.turnStart('ru', 'Captain', true, { opening: true });
  assert.equal(clips.length, 1);
  assert.equal(clips[0].paused, false);
  assert.equal(sound.currentVoice, url('game_start_ru'));

  clips[0].end();
  assert.equal(sound.currentVoice, url('turn_first_ru'));
  announcer.turnStart('en', 'Admiral', true);
  clips[1].end();
  assert.equal(sound.currentVoice, null);
  assert.equal(clips.length, 2);
});

test('bay entries wait for playback in order, including a route from the harbor', () => {
  const { sound, announcer, clips, captions, url } = setup(['repair_ru', 'harbor_ru', 'move_bay_ru', 'move_bay_en', 'turn_ru']);
  announcer.repair('ru');
  announcer.shipMove({ q: 'ru', fromHarbor: true, toBay: true, route: 'harbor to bay' });
  announcer.shipMove({ q: 'en', toBay: true, route: 'open water to bay' });
  announcer.turnStart('ru', 'Captain', false);
  assert.equal(clips.length, 1);
  assert.equal(clips[0].paused, false);
  assert.match(captions[1], /move_bay_ru/);

  clips[0].end();
  assert.equal(sound.currentVoice, url('move_bay_ru'));
  clips[1].end();
  assert.equal(sound.currentVoice, url('move_bay_en'));
  clips[2].end();
  assert.equal(sound.currentVoice, null);
  assert.equal(clips.length, 3);
});

test('muting clears waiting clips and silent replay leaves live playback alone', () => {
  const { sound, announcer, clips, url } = setup(['game_start_ru', 'turn_first_ru', 'repair_ru']);
  announcer.gameStart('ru', 'Captain');
  sound.setQuiet(true);
  announcer.turnStart('ru', 'Captain', true, { opening: true });
  sound.setQuiet(false);
  assert.equal(clips[0].paused, false);
  clips[0].end();
  assert.equal(sound.currentVoice, null);

  announcer.gameStart('ru', 'Captain');
  announcer.turnStart('ru', 'Captain', true, { opening: true });
  sound.setMuted('commentator', true);
  assert.equal(clips[1].paused, true);
  announcer.repair('ru');
  sound.setMuted('commentator', false);
  clips[1].end();
  assert.equal(sound.currentVoice, null);
  assert.equal(clips.length, 2);

  announcer.repair('ru');
  assert.equal(sound.currentVoice, url('repair_ru'));
});

test('an autoplay-blocked clip is dropped and a later event can play', async () => {
  const attempts = [];
  const { sound, announcer, clips, window, url } = setup(['game_start_ru', 'repair_ru'], (src) => {
    attempts.push(src);
    if (src === 'game_start_ru/01.mp3') {
      return Promise.reject(new DOMException('Playback unavailable', 'NotAllowedError'));
    }
    return Promise.resolve();
  });
  announcer.gameStart('ru', 'Captain');
  announcer.repair('ru');
  await Promise.resolve();
  assert.equal(sound.currentVoice, null);
  assert.equal(clips.length, 1);

  window.dispatchEvent(new Event('click'));
  assert.deepEqual(attempts, [url('game_start_ru')]);
  assert.equal(sound.currentVoice, null);

  announcer.repair('ru');
  assert.equal(sound.currentVoice, url('repair_ru'));
  assert.equal(clips.length, 2);
});
