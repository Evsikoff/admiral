import assert from 'node:assert/strict';
import test from 'node:test';
import { diceStats, throwRate } from './match-stats.js';

const players = [{ q: 'nl' }, { q: 'se' }];
const t = (player, dice, counted = true) => ({ player, q: players[player].q, dice, counted });

test('counts the throws that counted and those that did not, per player and in all', () => {
  const s = diceStats([t(0, [1, 2]), t(0, [3, 4], false), t(0, [5, 1]), t(1, [2, 2], false)], players);
  assert.deepEqual([s.players[0].counted, s.players[0].missed], [2, 1]);
  assert.deepEqual([s.players[1].counted, s.players[1].missed], [0, 1]);
  assert.deepEqual([s.total.counted, s.total.missed], [2, 2]);
  assert.equal(throwRate(s.players[0]), 2 / 3);
  assert.equal(throwRate(s.players[1]), 0);
  assert.equal(throwRate(s.total), 0.5);
});

test('a six on one die, doubles and 6 / 6 are told apart', () => {
  const s = diceStats([t(0, [6, 2]), t(0, [3, 6]), t(0, [6, 6]), t(0, [4, 4]), t(1, [6, 6]), t(1, [1, 5])], players);
  assert.deepEqual(s.players[0], { counted: 4, missed: 0, oneSix: 2, doubles: 2, sixSix: 1 });
  assert.deepEqual(s.players[1], { counted: 2, missed: 0, oneSix: 0, doubles: 1, sixSix: 1 });
  assert.deepEqual(s.total, { counted: 6, missed: 0, oneSix: 2, doubles: 3, sixSix: 2 });
});

test('the faces of a throw that did not count are not played and not counted', () => {
  const s = diceStats([t(0, [6, 6], false), t(0, [6, 1], false), t(0, [3, 3], false)], players);
  assert.deepEqual(s.players[0], { counted: 0, missed: 3, oneSix: 0, doubles: 0, sixSix: 0 });
});

test('before the first throw there is no rate', () => {
  const s = diceStats([], players);
  assert.equal(throwRate(s.total), null);
  assert.deepEqual(s.players.map((p) => p.counted + p.missed), [0, 0]);
});
