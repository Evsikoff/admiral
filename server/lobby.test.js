// node --test server/
import test from 'node:test';
import assert from 'node:assert/strict';
import { Lobby, COUNTDOWN_MS, GAME_GRACE_MS, WAIT_GRACE_MS, TURN_MS, BOT_STYLES, checkAction, drawSides, cleanName } from './lobby.js';

// a lobby with a clock and timers under the test's control
function setup(startOnlineParty = async participants => ({
  success: true, partyId: '123', balances: new Map(participants.filter(p => p.user_id).map(p => [p.user_id, 0])),
}), finishOnlineParty = async () => ({ winnings: 40, balance: 40 })) {
  let now = 0, seq = 0, nextUserId = 0;
  const pending = new Map();
  const timers = {
    set: (fn, ms) => { const id = ++seq; pending.set(id, { fn, at: now + ms }); return id; },
    clear: (id) => { pending.delete(id); },
  };
  const lobby = new Lobby({ now: () => now, timers, startOnlineParty, finishOnlineParty });
  const advance = (ms) => {
    const running = [];
    const until = now + ms;
    for (;;) {
      const next = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      pending.delete(next[0]); now = next[1].at; running.push(next[1].fn());
    }
    now = until;
    return Promise.all(running);
  };
  const client = (name, token) => {
    const inbox = [];
    const conn = { send: (m) => inbox.push(m) };
    const account = { userId: ++nextUserId, loginAt: now };
    const p = lobby.hello(conn, { name, token }, account);
    const last = (t) => [...inbox].reverse().find((m) => m.t === t);
    return { p, account, conn, inbox, last, say: (msg) => lobby.message(p, msg) };
  };
  return { lobby, advance, client };
}

test('a table: create, join, ready, countdown, start with sides by lot', async () => {
  const { lobby, advance, client } = setup();
  const a = client('Анна'), b = client('Борис'), w = client('Зритель');
  w.say({ t: 'watch', on: true });
  a.say({ t: 'create', private: false });
  advance(100);
  assert.deepEqual(w.last('tables').list, [{ no: 1, count: 1, bots: 0, private: false, status: 'waiting' }]);
  a.say({ t: 'ready', on: true });
  assert.equal(a.last('table').table.players[0].ready, false, 'alone at a table, nobody can be ready');
  b.say({ t: 'join', no: 1 });
  assert.equal(b.last('table').table.players.length, 2);
  a.say({ t: 'ready', on: true });
  assert.equal(a.last('table').table.status, 'waiting');
  b.say({ t: 'ready', on: true });
  assert.equal(a.last('table').table.status, 'countdown');
  assert.equal(a.last('table').table.startsIn, COUNTDOWN_MS);
  // during the countdown the table can still be joined, and the newcomer plays too
  const c = client('Вера');
  c.say({ t: 'join', no: 1 });
  assert.equal(c.last('table').table.status, 'countdown');
  assert.equal(c.last('table').table.players.length, 3);
  await advance(COUNTDOWN_MS);
  const start = a.last('start');
  assert.ok(start, 'the game has started');
  assert.equal(start.players.length, 3);
  assert.equal(new Set(start.players.map((p) => p.q)).size, 3);
  assert.equal(start.me, a.p.id);
  advance(100);
  assert.deepEqual(w.last('tables').list, [], 'a table in play is not listed');
  // the table cannot be joined any more
  const d = client('Гена');
  d.say({ t: 'join', no: 1 });
  assert.match(d.last('error').text, /уже идёт игра/);
});

test('one RPC starts a fixed roster and delivers private balances, including on reconnect', async () => {
  const calls = [];
  let finish;
  const { lobby, client, advance } = setup(participants => {
    calls.push(participants);
    return new Promise(resolve => { finish = resolve; });
  });
  const a = client('A'), b = client('B'), other = client('C');
  a.say({ t: 'create' }); b.say({ t: 'join', no: 1 });
  a.say({ t: 'bot-add', style: 'corsair' });
  a.say({ t: 'ready', on: true }); b.say({ t: 'ready', on: true });
  const started = advance(COUNTDOWN_MS);
  const table = a.p.table;
  assert.deepEqual(calls, [[{ user_id: a.p.userId }, { user_id: b.p.userId }, { bot_name: 'Корсар' }]]);
  a.say({ t: 'leave' }); a.say({ t: 'bot-remove', id: table.bots[0].id });
  other.say({ t: 'join', no: 1 });
  a.say({ t: 'ready', on: true });
  assert.equal(table.status, 'starting');
  assert.equal(table.bots.length, 1);
  assert.equal(other.p.table, null);
  assert.equal(a.last('start'), undefined);
  lobby.disconnect(b.p, b.conn);
  finish({ success: true, partyId: '9007199254740993', balances: new Map([[a.p.userId, 0], [b.p.userId, 15]]) });
  await started;
  assert.equal(table.game.partyId, '9007199254740993');
  assert.equal(a.last('start').players.length, 3);
  assert.deepEqual(a.last('balance'), { t: 'balance', chips: 0 });
  assert.equal(other.last('balance'), undefined);
  assert.equal(b.last('balance'), undefined);
  lobby.hello(b.conn, { token: b.p.token }, b.account);
  assert.deepEqual(b.last('balance'), { t: 'balance', chips: 15 });
  assert.ok(b.last('game'));
  b.say({ t: 'sync' });
  assert.equal(calls.length, 1);
});

test('insufficient chips updates the affected account and cancels the start for everyone', async () => {
  let calls = 0;
  const { client, advance } = setup(async () => {
    calls++;
    return { success: false, balances: new Map([[a.p.userId, 4]]), price: 10 };
  });
  const a = client('A'), b = client('B');
  a.say({ t: 'create' }); b.say({ t: 'join', no: 1 });
  a.say({ t: 'ready', on: true }); b.say({ t: 'ready', on: true });
  await advance(COUNTDOWN_MS);
  assert.equal(a.p.table.game, null);
  assert.equal(b.last('table').table.status, 'waiting');
  assert.ok(b.last('table').table.players.every(p => !p.ready));
  assert.deepEqual(a.last('balance'), { t: 'balance', chips: 4, onlinePartyPrice: 10 });
  assert.equal(b.last('balance'), undefined);
  assert.match(a.last('error').text, /Приобретите/);
  assert.ok(b.last('error'));
  await advance(COUNTDOWN_MS);
  assert.equal(calls, 1);
});

test('a lost RPC response closes the table without replaying a possible charge', async () => {
  let calls = 0;
  const { lobby, client, advance } = setup(async () => { calls++; throw new Error('RPC timed out'); });
  const a = client('A');
  a.say({ t: 'create' }); a.say({ t: 'bot-add', style: 'corsair' });
  a.say({ t: 'ready', on: true });
  await advance(COUNTDOWN_MS);
  assert.equal(lobby.tables.size, 0);
  assert.equal(a.last('table').table, null);
  assert.equal(a.last('start'), undefined);
  assert.match(a.last('error').text, /баланс/);
  a.say({ t: 'ready', on: true });
  await advance(COUNTDOWN_MS);
  assert.equal(calls, 1);
});

test('un-ready or leaving during the countdown stops it', async () => {
  const { advance, client } = setup();
  const a = client('A'), b = client('B');
  a.say({ t: 'create', private: false }); b.say({ t: 'join', no: 1 });
  a.say({ t: 'ready', on: true }); b.say({ t: 'ready', on: true });
  b.say({ t: 'ready', on: false });
  assert.equal(a.last('table').table.status, 'waiting');
  b.say({ t: 'ready', on: true });
  advance(1000);
  b.say({ t: 'leave' });
  assert.equal(a.last('table').table.status, 'waiting');
  assert.equal(a.last('table').table.players.length, 1);
  assert.equal(a.last('table').table.players[0].ready, false);
  await advance(COUNTDOWN_MS);
  assert.equal(a.last('start'), undefined);
});

test('the draw and a rejoin keep each captain’s ship set from the menu', async () => {
  const { lobby, advance, client } = setup();
  const a = client('A'), b = client('B');
  lobby.hello(a.conn, { token: a.p.token, shipSetId: 7 }, a.account);
  b.say({ t: 'ship-set', id: 8 });
  a.say({ t: 'create' }); b.say({ t: 'join', no: 1 });
  a.say({ t: 'ready', on: true }); b.say({ t: 'ready', on: true });
  await advance(COUNTDOWN_MS);
  const players = a.last('start').players;
  assert.equal(players.find(p => p.id === a.p.id).shipSetId, 7);
  assert.equal(players.find(p => p.id === b.p.id).shipSetId, 8);
  assert.deepEqual(b.last('start').players, players);
  lobby.disconnect(a.p, a.conn);
  lobby.hello(a.conn, { token: a.p.token, shipSetId: 8 }, a.account);
  assert.deepEqual(a.last('game').players, players);
});

test('asset progress is visible at the table and the countdown waits for every player', async () => {
  const { lobby, advance, client } = setup();
  const a = client('Анна'), b = client('Борис'), watcher = client('Вера');
  watcher.say({ t: 'watch', on: true });
  a.say({ t: 'create', private: false }); b.say({ t: 'join', no: 1 });
  a.say({ t: 'assets', progress: 42 });
  assert.equal(b.last('table').table.players[0].assets, 42);
  a.say({ t: 'ready', on: true }); b.say({ t: 'ready', on: true });
  assert.equal(a.last('table').table.status, 'waiting');
  await advance(COUNTDOWN_MS);
  assert.equal(a.last('start'), undefined);
  a.say({ t: 'assets', progress: 100 });
  assert.equal(a.last('table').table.status, 'countdown');
  advance(60);
  assert.equal(watcher.last('tables').list[0].status, 'countdown');
  b.say({ t: 'assets', progress: 99 });
  assert.equal(a.last('table').table.status, 'waiting', 'loading again cancels the countdown');
  advance(60);
  assert.equal(watcher.last('tables').list[0].status, 'waiting');
  b.say({ t: 'assets', progress: 101 });
  assert.equal(a.last('table').table.players[1].assets, 99, 'invalid progress is ignored');
  b.say({ t: 'assets', progress: 100 });
  await advance(COUNTDOWN_MS);
  assert.deepEqual(a.last('start').assets, { [a.p.id]: 100, [b.p.id]: 100 });
  a.say({ t: 'assets', progress: 80 });
  assert.deepEqual(b.last('assets'), { t: 'assets', id: a.p.id, progress: 80 });
  lobby.disconnect(b.p, b.conn);
  const inbox = [];
  lobby.hello({ send: (m) => inbox.push(m) }, { token: b.p.token, assets: 100 }, b.account);
  assert.equal(inbox.find((m) => m.t === 'game').assets[a.p.id], 80, 'a rejoined player gets the latest progress');
});

test('a full table leaves the list at once', () => {
  const { advance, client } = setup();
  const w = client('W'); w.say({ t: 'watch', on: true });
  const players = ['A', 'B', 'C', 'D'].map((n) => client(n));
  players[0].say({ t: 'create', private: false });
  for (const p of players.slice(1, 3)) p.say({ t: 'join', no: 1 });
  advance(100);
  assert.equal(w.last('tables').list[0].count, 3);
  players[3].say({ t: 'join', no: 1 });
  advance(100);
  assert.deepEqual(w.last('tables').list, []);
  const e = client('E'); e.say({ t: 'join', no: 1 });
  assert.match(e.last('error').text, /все четыре места заняты/);
});

test('private tables: a code to sit down, found by the code or by the number', () => {
  const { advance, client } = setup();
  const a = client('A'), b = client('B'), c = client('C'), w = client('W');
  w.say({ t: 'watch', on: true });
  a.say({ t: 'create', private: true });
  const code = a.last('table').table.code;
  assert.match(code, /^\d{4}$/);
  advance(100);
  assert.deepEqual(w.last('tables').list, [{ no: 1, count: 1, bots: 0, private: true, status: 'waiting' }], 'the list shows no code');
  b.say({ t: 'join', no: 1 });
  assert.deepEqual(b.last('need-code'), { t: 'need-code', no: 1, wrong: false });
  b.say({ t: 'join', no: 1, code: '0000' === code ? '1111' : '0000' });
  assert.equal(b.last('need-code').wrong, true);
  assert.equal(b.last('table')?.table ?? null, null);
  b.say({ t: 'find', q: '1' });
  assert.equal(b.last('need-code').no, 1, 'the number of a private table asks for its code');
  c.say({ t: 'find', q: code });
  assert.equal(c.last('table').table.no, 1, 'the code alone opens the table');
  assert.equal(c.last('table').table.code, code);
  b.say({ t: 'join', no: 1, code });
  assert.equal(b.last('table').table.players.length, 3);
  const d = client('D'); d.say({ t: 'find', q: '42' });
  assert.match(d.last('error').text, /№ 42 нет/);
  d.say({ t: 'find', q: 'abc' });
  assert.match(d.last('error').text, /номер стола или/);
});

test('table numbers are reused, the lowest free first', () => {
  const { client } = setup();
  const a = client('A'), b = client('B'), c = client('C');
  a.say({ t: 'create', private: false }); b.say({ t: 'create', private: false });
  assert.equal(b.last('table').table.no, 2);
  a.say({ t: 'leave' });
  c.say({ t: 'create', private: false });
  assert.equal(c.last('table').table.no, 1);
});

async function startedGame(n = 2) {
  const s = setup();
  const cs = Array.from({ length: n }, (_, i) => s.client(`P${i}`));
  cs[0].say({ t: 'create', private: false });
  for (const c of cs.slice(1)) c.say({ t: 'join', no: 1 });
  for (const c of cs) c.say({ t: 'ready', on: true });
  await s.advance(COUNTDOWN_MS);
  return { ...s, cs };
}
const act = (k = 0) => ({ kind: 'act', ship: 'ru1', k });

test('actions are numbered, passed on to everyone and kept for a player who comes back', async () => {
  const { lobby, cs } = await startedGame(2);
  const [a, b] = cs;
  a.say({ t: 'act', n: 0, a: act(0) });
  assert.deepEqual(b.last('act'), { t: 'act', n: 0, a: act(0), from: a.p.id });
  assert.equal(a.last('act').n, 0, 'the sender gets its own action back too');
  a.say({ t: 'act', n: 0, a: act(1) });
  assert.equal(a.last('reject').have, 1, 'an action out of order is refused');
  a.say({ t: 'act', n: 1, a: { kind: 'throw', frames: [NaN], res: [] } });
  assert.equal(a.last('reject').kind, 'bad', 'a malformed action is refused, and the client asks for the game again');
  a.say({ t: 'act', n: 1, a: { kind: 'throw', frames: new Array(28).fill(0.5), land: 0.3,
    res: [{ v: 6, tilt: 2, out: false, cocked: false, moving: false, ship: null }, { v: 2, tilt: 1, ship: 'en3' }] } });
  assert.equal(b.last('act').a.frames.length, 28, 'the others see the flight of the dice');
  // b reloads the page: the same token, the whole game so far, without the flights
  lobby.disconnect(b.p, b.conn);
  assert.equal(a.last('presence').state, 'offline');
  const inbox = [];
  lobby.hello({ send: (m) => inbox.push(m) }, { token: b.p.token }, b.account);
  const state = inbox.find((m) => m.t === 'game');
  assert.equal(state.log.length, 2);
  assert.equal(state.log[1].frames, null);
  assert.equal(state.log[1].res[0].v, 6);
  assert.equal(state.log[0].by, a.p.id, 'each action in the log says whose decision it was');
  assert.equal(state.log[1].by, a.p.id);
  assert.equal(state.me, b.p.id);
  assert.equal(a.last('presence').state, 'online');
});

test('a decision not taken in time may be skipped by anyone at the table', async () => {
  const { advance, cs } = await startedGame(2);
  const [a, b] = cs;
  assert.equal(b.last('start').turnMs, TURN_MS, 'the players know the time for a turn');
  a.say({ t: 'act', n: 0, a: act(0) });
  advance(TURN_MS - 10000);
  a.say({ t: 'act', n: 1, a: { kind: 'skip', id: b.p.id } });
  assert.equal(a.last('reject').kind, 'skip', 'not while the time is running');
  advance(10000);
  a.say({ t: 'act', n: 1, a: { kind: 'skip', id: b.p.id } });
  assert.deepEqual(b.last('act'), { t: 'act', n: 1, a: { kind: 'skip', id: b.p.id }, from: a.p.id });
  a.say({ t: 'act', n: 2, a: { kind: 'skip', id: b.p.id } });
  assert.equal(a.last('reject').have, 2, 'the clock starts again with every action');
});

test('a player who is gone too long has left; only their turns may be skipped', async () => {
  const { lobby, advance, cs } = await startedGame(3);
  const [a, b, c] = cs;
  a.say({ t: 'act', n: 0, a: { kind: 'skip', id: b.p.id } });
  assert.equal(a.last('reject').kind, 'skip', 'a player who is here cannot be skipped');
  lobby.disconnect(b.p, b.conn);
  advance(GAME_GRACE_MS - 1);
  assert.equal(c.last('presence').state, 'offline');
  advance(1);
  assert.equal(c.last('presence').state, 'left');
  a.say({ t: 'act', n: 0, a: { kind: 'skip', id: b.p.id } });
  assert.equal(c.last('act').a.kind, 'skip');
  c.say({ t: 'act', n: 0, a: { kind: 'skip', id: b.p.id } });
  assert.equal(c.last('reject').have, 1, 'a second skip of the same turn is refused');
  // a player who leaves on purpose is gone at once; when everyone has gone the table is closed
  c.say({ t: 'leave' });
  assert.equal(a.last('presence').state, 'left');
  assert.equal(c.last('table').table, null);
  a.say({ t: 'leave' });
  assert.equal(lobby.tables.size, 0);
});

test('a player who loses the connection at a waiting table keeps the seat for a while', () => {
  const { lobby, advance, client } = setup();
  const a = client('A'), b = client('B');
  a.say({ t: 'create', private: false }); b.say({ t: 'join', no: 1 });
  lobby.disconnect(b.p, b.conn);
  assert.equal(a.last('table').table.players[1].online, false);
  advance(WAIT_GRACE_MS - 10);
  lobby.hello({ send: () => {} }, { token: b.p.token }, b.account);
  assert.equal(a.last('table').table.players[1].online, true);
  lobby.disconnect(b.p, lobby.players.get(b.p.token).conn);
  advance(WAIT_GRACE_MS);
  assert.equal(a.last('table').table.players.length, 1);
});

test('helpers: sides, names, actions', () => {
  for (let i = 0; i < 50; i++) {
    const two = drawSides(2).sort().join();
    assert.ok(two === 'en,ru' || two === 'nl,se', two);
    assert.equal(new Set(drawSides(4)).size, 4);
  }
  assert.equal(cleanName('  Капитан\u0000  Немо  ‮ '), 'Капитан Немо');
  assert.equal(cleanName('x'.repeat(40)).length, 20);
  assert.equal(checkAction({ kind: 'act', ship: 'xx1', k: 0 }), null);
  assert.equal(checkAction({ kind: 'throw', frames: [1, 2], res: [] }), null);
  assert.equal(checkAction({ kind: 'nope' }), null);
});

// ---- bots at the tables
test('bots: seated in free seats, named by style, counted as players; their table needs a person', () => {
  const { lobby, advance, client } = setup();
  const w = client('W'); w.say({ t: 'watch', on: true });
  const a = client('A');
  a.say({ t: 'create', private: false });
  a.say({ t: 'bot-add', style: 'corsair' });
  a.say({ t: 'bot-add', style: 'corsair' });
  a.say({ t: 'bot-add', style: 'nonsense' });
  let view = a.last('table').table;
  assert.deepEqual(view.bots.map((b) => b.name), ['Корсар', 'Корсар 2'], 'a second bot of a style gets a number');
  assert.ok(view.bots.every((b) => /^bot[0-9a-f]{5}$/.test(b.id)));
  advance(100);
  assert.deepEqual(w.last('tables').list, [{ no: 1, count: 3, bots: 2, private: false, status: 'waiting' }]);
  // a style changed: the bot is named after it
  a.say({ t: 'bot-style', id: view.bots[0].id, style: 'racer' });
  view = a.last('table').table;
  assert.deepEqual(view.bots.map((b) => [b.style, b.name]), [['racer', 'Скороход'], ['corsair', 'Корсар 2']]);
  // the fourth seat: a bot or a person, not both
  a.say({ t: 'bot-add', style: 'novice' });
  const e = client('E'); e.say({ t: 'join', no: 1 });
  assert.match(e.last('error').text, /все четыре места заняты/);
  a.say({ t: 'bot-add', style: 'novice' });
  assert.match(a.last('error').text, /Свободных мест/);
  a.say({ t: 'bot-remove', id: a.last('table').table.bots[2].id });
  assert.equal(a.last('table').table.bots.length, 2);
  e.say({ t: 'join', no: 1 });
  assert.equal(e.last('table').table.players.length, 2);
  // the people leave: the bots do not keep the table
  a.say({ t: 'leave' }); e.say({ t: 'leave' });
  assert.equal(lobby.tables.size, 0);
});

test('bots: one person and a bot play; a change of bots restarts the countdown', async () => {
  const { advance, client } = setup();
  const a = client('A');
  a.say({ t: 'create', private: false });
  a.say({ t: 'ready', on: true });
  assert.equal(a.last('table').table.players[0].ready, false, 'alone: not ready');
  a.say({ t: 'bot-add', style: 'careful' });
  a.say({ t: 'ready', on: true });
  assert.equal(a.last('table').table.status, 'countdown');
  advance(COUNTDOWN_MS - 500);
  a.say({ t: 'bot-add', style: 'convoy' });
  assert.equal(a.last('table').table.status, 'countdown', 'still ready: the countdown starts again');
  assert.equal(a.last('table').table.startsIn, COUNTDOWN_MS);
  advance(COUNTDOWN_MS - 500);
  assert.equal(a.last('start'), undefined);
  const removing = a.last('table').table.bots[1].id;
  a.say({ t: 'bot-remove', id: removing });
  await advance(COUNTDOWN_MS);
  const start = a.last('start');
  assert.ok(start, 'the game has begun');
  assert.equal(start.players.length, 2);
  const bot = start.players.find((p) => p.bot);
  assert.equal(bot.bot, 'careful');
  assert.equal(bot.name, 'Осмотрительный');
  assert.deepEqual(start.players.find((p) => !p.bot), { id: a.p.id, name: 'A', q: start.players.find((p) => !p.bot).q });
});

test('bots: a player\'s screen sends the bot\'s decisions; the log says they were the bot\'s', async () => {
  const { lobby, advance, client } = setup();
  const a = client('A'), b = client('B');
  a.say({ t: 'create', private: false }); b.say({ t: 'join', no: 1 });
  a.say({ t: 'bot-add', style: 'novice' });
  a.say({ t: 'ready', on: true }); b.say({ t: 'ready', on: true });
  await advance(COUNTDOWN_MS);
  const botId = a.last('start').players.find((p) => p.bot).id;
  a.say({ t: 'act', n: 0, a: { ...act(0), bot: botId } });
  assert.deepEqual(b.last('act'), { t: 'act', n: 0, a: { ...act(0), bot: botId }, from: a.p.id });
  b.say({ t: 'act', n: 1, a: { ...act(1), bot: 'bot00000' } });
  assert.equal(b.last('reject').kind, 'bad', 'a bot that does not play here');
  b.say({ t: 'act', n: 1, a: { ...act(1), bot: 'Корсар' } });
  assert.deepEqual(b.last('act').a, act(1), 'a malformed bot id is dropped: the action is the player\'s own');
  const inbox = [];
  lobby.disconnect(b.p, b.conn);
  lobby.hello({ send: (m) => inbox.push(m) }, { token: b.p.token }, b.account);
  const state = inbox.find((m) => m.t === 'game');
  assert.equal(state.log[0].by, botId);
  assert.equal(state.log[1].by, b.p.id);
  assert.deepEqual(Object.keys(state.presence).sort(), [a.p.id, b.p.id].sort(), 'presence: the people only');
  // everyone gone: the game ends though its bot is still "there"
  a.say({ t: 'leave' }); b.say({ t: 'leave' });
  assert.equal(lobby.tables.size, 0);
});

// Play through the normal relay: repair each ship on a double six, sail six
// cells, then use double ones to fill the parade from the farthest berth back.
async function playParade(client, advance, winner) {
  const g = client.p.table.game;
  const act = a => client.say({ t: 'act', n: g.log.length, a });
  for (const seat of g.players) {
    if (seat.id === winner.id) break;
    await advance(TURN_MS);
    act({ kind: 'skip', id: seat.id });
  }
  const bot = winner.bot ? { bot: winner.id } : {};
  const roll = v => act({ kind: 'throw', frames: [], res: [{ v, tilt: 0 }, { v, tilt: 0 }], ...bot });
  let final;
  for (let n = 1; n <= 5; n++) {
    const sail = () => act({ kind: 'act', ship: winner.q + n, k: 0, ...bot });
    roll(6); sail(); sail();
    const distance = 13 * g.players.length + 6 - n;
    for (let pos = 6; pos < distance; pos++) {
      if (pos % 2 === 0) roll(1);
      final = sail();
    }
  }
  await final;
}

test('rematch: a fresh table gathers the remaining players and bots, with nobody ready yet', async () => {
  const { lobby, advance, client } = setup();
  const a = client('A'), b = client('B'), c = client('C');
  a.say({ t: 'create', private: true });
  const code = a.last('table').table.code;
  b.say({ t: 'join', no: 1, code }); c.say({ t: 'join', no: 1, code });
  a.say({ t: 'bot-add', style: 'corsair' });
  const botId = a.last('table').table.bots[0].id;
  for (const p of [a, b, c]) p.say({ t: 'ready', on: true });
  await advance(COUNTDOWN_MS);
  c.say({ t: 'leave' });
  a.say({ t: 'rematch' });
  assert.equal(a.p.table.no, 1, 'an unfinished game keeps its table');
  await playParade(a, advance, a.last('start').players.find(p => p.id === a.p.id));
  a.say({ t: 'rematch' });
  const view = a.last('table').table;
  assert.equal(view.no, 2, 'a new table, not the finished game reset in place');
  assert.equal(view.private, true);
  assert.equal(view.status, 'waiting');
  assert.deepEqual(view.players.map((p) => p.id), [a.p.id, b.p.id], 'a player who deliberately left stays out');
  assert.ok(view.players.every((p) => !p.ready && p.online));
  assert.deepEqual(view.bots.map((bot) => [bot.id, bot.style]), [[botId, 'corsair']]);
  assert.deepEqual(b.last('table').table, view, 'the whole company is shown the same new table');
  assert.equal(lobby.tables.size, 1, 'the finished table is closed');
  assert.equal(lobby.tables.has(1), false);
  const starts = a.inbox.filter((m) => m.t === 'start').length;
  b.say({ t: 'rematch' });
  assert.equal(lobby.tables.size, 1, 'another request at the waiting table does not create a third table');
  await advance(COUNTDOWN_MS);
  assert.equal(a.inbox.filter((m) => m.t === 'start').length, starts, 'everybody confirms the next game again');
});

test('a human win pays the registered account once and snapshots the other starting balances', async () => {
  const calls = [];
  let release;
  const { client, advance } = setup(async () => ({
    success: true, partyId: '9007199254740993', balances: new Map([[1, 25], [2, 0]]),
  }), (...args) => { calls.push(args); return new Promise(resolve => { release = resolve; }); });
  const a = client('A'), b = client('B');
  a.say({ t: 'create' }); b.say({ t: 'join', no: 1 });
  for (const player of [a, b]) player.say({ t: 'ready', on: true });
  await advance(COUNTDOWN_MS);
  const game = a.p.table.game;
  const done = playParade(a, advance, game.players.find(p => p.id === a.p.id));
  await new Promise(setImmediate);
  assert.deepEqual(calls, [['9007199254740993', { winner_user_id: 1 }]]);
  assert.equal(b.last('result').result.status, 'pending');
  assert.deepEqual(b.last('result').result.balances, { [b.p.id]: 0 });
  a.say({ t: 'rematch' }); b.say({ t: 'retry-result' });
  const count = game.log.length;
  a.say({ t: 'act', n: count, a: game.log.at(-1) });
  assert.equal(game.log.length, count);
  b.say({ t: 'leave' });
  release({ winnings: 20, balance: 45 });
  await done;
  a.say({ t: 'sync' });
  assert.deepEqual(a.last('game').result, { winnerId: a.p.id, status: 'paid', winnings: 20,
    balances: { [a.p.id]: 45, [b.p.id]: 0 } });
  assert.equal(a.last('balance').chips, 45);
  assert.equal(calls.length, 1);
});

test('a bot win retries with the registered bot name and never credits a human account', async () => {
  const calls = [];
  const { client, advance } = setup(undefined, async (...args) => {
    calls.push(args);
    if (calls.length === 1) throw new TypeError('connection lost');
    return { winnings: 0, balance: null };
  });
  const a = client('A');
  a.say({ t: 'create' }); a.say({ t: 'bot-add', style: 'corsair' }); a.say({ t: 'ready', on: true });
  await advance(COUNTDOWN_MS);
  const bot = a.p.table.game.players.find(p => p.bot);
  await playParade(a, advance, bot);
  assert.equal(a.last('result').result.status, 'retrying');
  await advance(2000);
  assert.deepEqual(calls, Array(2).fill(['123', { bot_name: bot.name }]));
  assert.deepEqual(a.last('result').result, { winnerId: bot.id, status: 'bot', balances: { [a.p.id]: 0 } });
  assert.equal(a.inbox.filter(m => m.t === 'balance').length, 1);
});

test('bots: the styles of the server are those of the game', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/bot-styles.js', import.meta.url), 'utf8');
  const window = {};
  new Function('window', src)(window);
  assert.deepEqual(Object.fromEntries(window.AdmiralBotStyles.map((s) => [s.id, s.title])), BOT_STYLES);
});

test('bots: the table learns who hears the commentator (bots wait for him only if somebody does)', async () => {
  const { lobby, advance, client } = setup();
  const a = client('A'), b = client('B');
  lobby.message(b.p, { t: 'voice', on: false });             // switched off before the game: it is remembered
  a.say({ t: 'create', private: false }); b.say({ t: 'join', no: 1 });
  a.say({ t: 'bot-add', style: 'racer' });
  a.say({ t: 'ready', on: true }); b.say({ t: 'ready', on: true });
  await advance(COUNTDOWN_MS);
  assert.deepEqual(a.last('start').voice, { [a.p.id]: true, [b.p.id]: false }, 'the people only');
  a.say({ t: 'voice', on: false });
  assert.deepEqual(b.last('voice'), { t: 'voice', id: a.p.id, on: false });
  b.say({ t: 'voice', on: true });
  assert.deepEqual(a.last('voice'), { t: 'voice', id: b.p.id, on: true });
  // a player back after a reload says it again in the greeting; the game state has it
  lobby.disconnect(a.p, a.conn);
  const inbox = [];
  lobby.hello({ send: (m) => inbox.push(m) }, { token: a.p.token, voice: true }, a.account);
  assert.deepEqual(inbox.find((m) => m.t === 'game').voice, { [a.p.id]: true, [b.p.id]: true });
  assert.deepEqual(b.last('voice'), { t: 'voice', id: a.p.id, on: true });
});
