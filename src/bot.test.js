// node --test src/ — the brain of the bots (src/bot.js) on a bare board, without the map
import test from 'node:test';
import { makeBotBoard } from './fleet-rules.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// bot.js is a part of the game's module (tools/build.py joins the files); here it is loaded on its own
const code = readFileSync(new URL('./bot.js', import.meta.url), 'utf8');
const { createBotBrain, BOT_PARAMS, BOT_DEFAULT, botStyleOf } = new Function(
  `${code}\nreturn { createBotBrain, BOT_PARAMS, BOT_DEFAULT, botStyleOf };`)();
const board = makeBotBoard();
const brain = createBotBrain(board);
const { cells, harbors, shipyards, prisons } = board;

// a repeatable rng
const seeded = (s) => () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
const STYLE_IDS = (() => {
  const window = {};
  new Function('window', readFileSync(new URL('./bot-styles.js', import.meta.url), 'utf8'))(window);
  return window.AdmiralBotStyles.map((s) => s.id);
})();

// a position: { id: slot } for the ships named; every other ship of the sides waits at its shipyard
function position(sides, at) {
  return sides.flatMap((q) => [1, 2, 3, 4, 5].map((n) => {
    const id = `${q}${n}`;
    return { id, q, n, slot: at[id] ?? shipyards[q] };
  }));
}
const dice = (a, b) => [{ v: a, used: false }, { v: b, used: false }];
const decide = (ships, d, style = 'careful', extra = {}) =>
  brain.decide({ sides: new Set(['ru', 'en']), ships, me: 'ru', dice: d, captured: [], ...extra }, style, seeded(7));
// the whole throw of the Russian side, as the bot plays it (it plans every die before the first move): its actions
function playThrow(ships, d, style = 'careful') {
  const done = [], captured = [];
  for (;;) {
    const a = brain.decide({ sides: new Set(['ru', 'en']), ships, me: 'ru', dice: d, captured }, style, seeded(7));
    if (!a) return done;
    done.push(a);
    for (const i of a.use) d[i].used = true;
    if (a.victims.length) captured.push(a.ship);
    ships = brain.apply(ships, a, 'ru');
  }
}

test('every style of the game has its weights, and an unknown one plays the default', () => {
  assert.deepEqual(STYLE_IDS.slice().sort(), Object.keys(BOT_PARAMS).sort());
  assert.equal(STYLE_IDS[0], BOT_DEFAULT, 'the first style in the list is the one a new bot gets');
  assert.equal(botStyleOf('nonsense'), BOT_DEFAULT);
  assert.equal(botStyleOf('toString'), BOT_DEFAULT);
});

test('the careful bot repairs and buys back its ships with a six', () => {
  const R = cells.ru;
  // a ship at sea could sail; a wreck waits at the shipyard
  let ships = position(['ru', 'en'], { ru1: R.f[3], ru3: R.s[4], ru4: R.s[3], ru5: R.s[2], en1: harbors.en });
  assert.ok(playThrow(ships, dice(6, 2)).some((a) => a.kind === 'repair'));
  // a ship in the English prison
  ships = position(['ru', 'en'], { ru1: R.f[3], ru2: prisons.en, ru3: R.s[4], ru4: R.s[3], ru5: R.s[2], en1: harbors.en });
  const moves = playThrow(ships, dice(6, 3));
  assert.ok(moves.some((a) => a.kind === 'ransom' && a.from === 'en'), moves.map((a) => a.kind).join());
});

test('a bot takes an enemy ship it can reach', () => {
  const R = cells.ru;
  const ships = position(['ru', 'en'], { ru1: R.f[3], ru2: harbors.ru, ru3: R.s[4], ru4: R.s[3], ru5: R.s[2], en1: R.f[5], en2: harbors.en });
  for (const style of ['careful', 'corsair', 'convoy']) {
    const a = decide(ships, dice(2, 5), style);
    assert.deepEqual(a.victims, ['en1'], style);
  }
});

test('a bot sails into the parade, where its ship cannot be taken', () => {
  const R = cells.ru;
  const ships = position(['ru', 'en'], { ru1: R.f[12], ru2: harbors.ru, ru3: R.s[4], ru4: R.s[3], en1: harbors.en });
  for (const style of ['careful', 'racer', 'convoy']) {
    const moves = playThrow(ships, dice(4, 1), style);
    assert.ok(moves.some((a) => a.ship === 'ru1' && a.slot.star), `${style}: ${moves.map((a) => a.ship)}`);
  }
});

test('the careful bot keeps a ship in a bay while another can sail, and leaves it to chase', () => {
  const R = cells.ru, E = cells.en;
  // a Russian ship lies in the English bay; nothing has sailed past it yet
  let ships = position(['ru', 'en'], { ru1: E.b, ru2: R.f[4], en1: harbors.en, en2: shipyards.en });
  const waiting = playThrow(ships, dice(1, 3));
  assert.ok(waiting.length && waiting.every((a) => a.ship !== 'ru1'), 'it waits in the bay');
  // an English ship has sailed past it: the chase begins, and the prey is taken
  ships = position(['ru', 'en'], { ru1: E.b, ru2: R.f[4], en1: E.f[5] });
  const chase = playThrow(ships, dice(3, 1));
  assert.ok(chase.some((a) => a.ship === 'ru1' && a.victims.includes('en1')), chase.map((a) => a.ship).join());
});

test('the jailer\'s six steps are a move of six cells', () => {
  const R = cells.ru;
  const ships = position(['ru', 'en'], { ru1: R.f[1], ru2: harbors.ru, en1: harbors.en });
  const a = brain.decide({ sides: new Set(['ru', 'en']), ships, me: 'ru', comp: true }, 'careful', seeded(3));
  assert.equal(a.kind, 'move');
  assert.equal(a.len, 6);
  assert.deepEqual(a.use, [0]);
});

test('games between the styles come to an end, two and four sides', () => {
  const rng = seeded(11);
  const pick = (k) => STYLE_IDS[k % STYLE_IDS.length];
  for (let g = 0; g < 10; g++) {
    const order = g % 2 ? ['ru', 'en'] : ['se', 'nl'];
    const r = brain.playGame({ sides: order, styles: { [order[0]]: pick(g), [order[1]]: pick(g + 1 + (g >> 1)) }, rng });
    assert.ok(r.winner, `game ${g}: no winner in ${r.stats.throws} throws`);
    assert.ok(brain.won(r.ships, r.winner));
  }
  for (let g = 0; g < 3; g++) {
    const order = ['ru', 'se', 'en', 'nl'];
    const r = brain.playGame({ sides: order, styles: Object.fromEntries(order.map((q, i) => [q, pick(g + i)])), rng });
    assert.ok(r.winner, `four sides, game ${g}: no winner in ${r.stats.throws} throws`);
  }
});

test('the careful bot beats the novice more often than not', () => {
  const rng = seeded(21);
  let wins = 0;
  const N = 40;
  for (let g = 0; g < N; g++) {
    const order = g % 2 ? ['ru', 'en'] : ['en', 'ru'];
    const r = brain.playGame({ sides: order, styles: { ru: 'careful', en: 'novice' }, rng });
    if (r.winner === 'ru') wins++;
  }
  assert.ok(wins > N / 2, `careful won ${wins} of ${N}`);
});
