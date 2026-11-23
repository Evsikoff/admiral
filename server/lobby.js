// The online club: players, tables waiting for players, games in progress.
// The server does not know the rules of the game. Every client runs the same game; the server keeps the order:
// it numbers the actions of a game, keeps them (a player who comes back replays them) and passes them on.
// It draws the sides, and it knows who is still at the table: a player who has gone may have their turns skipped,
// and so may a player who takes longer than the time for a turn. A countdown waits for every player's assets to reach 100%.
// A table may have bots in its free seats. A bot has no connection: one of the players' screens plays it (app.js)
// and sends its decisions with the bot's id; the server only checks that the bot plays in that game.
// After a victory, a rematch request moves everyone still seated, and the bots, to a fresh waiting table.
import { randomBytes, randomInt } from 'node:crypto';

export const NATIONS = ['ru', 'se', 'en', 'nl'];
const OPPOSITE_PAIRS = [['en', 'ru'], ['se', 'nl']];       // two players sit facing each other, as in a local game
export const SEATS = 4;
export const COUNTDOWN_MS = 3000;          // everyone is ready → the game starts this much later
export const WAIT_GRACE_MS = 15000;        // a player who lost the connection at a waiting table keeps the seat this long
export const GAME_GRACE_MS = 60000;        // …and in a game this long; then their turns are skipped
export const TURN_MS = 60000;              // a decision not taken in this time may be skipped by anyone at the table
// the players' clocks start when the decision comes up on their screens, after the server has taken the last action
const TURN_SLACK_MS = 5000;
const FORGET_MS = 10 * 60000;              // a player with no connection and no table is forgotten after this
const NAME_MAX = 20;
const SHIP_ID = /^(ru|se|en|nl)[1-5]$/;
const MAX_FRAMES = 400;                    // a recorded throw: up to this many frames of two dice, 7 numbers each
// the styles of play of the bots: the same ids as src/bot-styles.js (a test checks), with the names bots get
export const BOT_STYLES = { careful: 'Осмотрительный', corsair: 'Корсар', racer: 'Скороход', convoy: 'Конвой', novice: 'Юнга' };
const BOT_ID = /^bot[0-9a-f]{5}$/;
const isStyle = (x) => typeof x === 'string' && Object.hasOwn(BOT_STYLES, x);
// every seat taken at a table: its players and its bots
const seats = (table) => table.players.length + table.bots.length;

const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
export function drawSides(n) {
  if (n === 2) return shuffle([...OPPOSITE_PAIRS[randomInt(OPPOSITE_PAIRS.length)]]);
  return shuffle([...NATIONS]).slice(0, n);
}
// control characters, zero-width and direction marks: a name must look like what it is
const INVISIBLE = new RegExp('[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]', 'g');
export function cleanName(name) {
  return String(name ?? '').replace(INVISIBLE, '')
    .replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isInt = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;

// a game action as it may be passed on; anything else is refused. A bot's throw or move names the bot
const bot = (a) => (typeof a.bot === 'string' && BOT_ID.test(a.bot) ? { bot: a.bot } : {});
export function checkAction(a) {
  if (!a || typeof a !== 'object') return null;
  if (a.kind === 'throw') {
    const { frames, res, land } = a;
    if (!Array.isArray(frames) || frames.length % 14 || frames.length > MAX_FRAMES * 14 || !frames.every(isNum)) return null;
    if (!Array.isArray(res) || res.length !== 2) return null;
    const dice = res.map((r) => (r && isInt(r.v, 1, 6) && isNum(r.tilt) ? {
      v: r.v, tilt: r.tilt, out: !!r.out, cocked: !!r.cocked, moving: !!r.moving,
      ship: typeof r.ship === 'string' && SHIP_ID.test(r.ship) ? r.ship : null,
    } : null));
    if (dice.includes(null)) return null;
    return { kind: 'throw', frames, res: dice, land: isNum(land) ? land : -1, ...bot(a) };
  }
  if (a.kind === 'act') {
    if (typeof a.ship !== 'string' || !SHIP_ID.test(a.ship) || !isInt(a.k, 0, 63)) return null;
    return { kind: 'act', ship: a.ship, k: a.k, ...bot(a) };
  }
  if (a.kind === 'skip') return typeof a.id === 'string' && a.id.length <= 16 ? { kind: 'skip', id: a.id } : null;
  return null;
}

export class Lobby {
  constructor({ now = () => Date.now(), timers = { set: setTimeout, clear: clearTimeout }, turnMs = TURN_MS } = {}) {
    this.now = now; this.timers = timers; this.turnMs = turnMs;
    this.players = new Map();       // token → player
    this.byId = new Map();          // id → player
    this.tables = new Map();        // number → table
    this.listTimer = null;
  }

  // ---- connections
  // conn: { send(object) }. The token comes back from the browser tab: the same player, at the same table.
  hello(conn, msg = {}) {
    let p = typeof msg.token === 'string' ? this.players.get(msg.token) : null;
    if (p) {
      if (p.conn && p.conn !== conn) p.conn.send({ t: 'replaced' });
      this.timers.clear(p.forget); p.forget = null;
    } else {
      let id; do id = randomBytes(4).toString('hex'); while (this.byId.has(id));
      p = { id, token: randomBytes(16).toString('hex'), name: '', conn: null, table: null, ready: false, watching: false, forget: null,
        voice: true, assets: 100 };
      this.players.set(p.token, p); this.byId.set(id, p);
    }
    p.conn = conn;
    if (typeof msg.voice === 'boolean') this.setVoice(p, msg.voice);
    if (isInt(msg.assets, 0, 100)) this.setAssets(p, msg.assets);
    const name = cleanName(msg.name);
    if (name && !(p.table && p.table.status === 'playing')) p.name = name;
    if (!p.name) p.name = `Капитан ${p.id.slice(0, 3).toUpperCase()}`;
    conn.send({ t: 'welcome', id: p.id, token: p.token, name: p.name });
    const table = p.table;
    if (table) {
      this.timers.clear(p.away); p.away = null;
      if (table.status === 'playing') {
        this.setPresence(table, p, 'online');
        conn.send(this.gameState(table, p));
      } else {
        p.online = true;
        this.sendTable(table);
        this.listChanged();
      }
    } else conn.send({ t: 'table', table: null });
    return p;
  }

  disconnect(p, conn) {
    if (!p || p.conn !== conn) return;
    p.conn = null; p.watching = false;
    const table = p.table;
    if (table && table.status === 'playing') {
      this.setPresence(table, p, 'offline');
      p.away = this.timers.set(() => { p.away = null; if (p.table === table && !p.conn) this.setPresence(table, p, 'left'); }, GAME_GRACE_MS);
    } else if (table) {
      p.online = false; p.ready = false;
      this.cancelCountdown(table);
      this.sendTable(table); this.listChanged();
      p.away = this.timers.set(() => { p.away = null; if (p.table === table && !p.conn) this.leaveTable(p); }, WAIT_GRACE_MS);
    }
    this.scheduleForget(p);
  }
  scheduleForget(p) {
    this.timers.clear(p.forget);
    p.forget = this.timers.set(() => {
      if (p.conn) return;
      if (p.table) { this.scheduleForget(p); return; }
      this.players.delete(p.token); this.byId.delete(p.id);
    }, FORGET_MS);
  }

  message(p, msg) {
    if (!msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'name': {
        const name = cleanName(msg.name);
        if (!name) return;
        p.name = name;
        p.conn?.send({ t: 'welcome', id: p.id, token: p.token, name: p.name });
        if (p.table && p.table.status !== 'playing') this.sendTable(p.table);
        return;
      }
      case 'watch': p.watching = !!msg.on; if (p.watching) p.conn?.send(this.listMessage()); return;
      case 'create': return this.create(p, !!msg.private);
      case 'join': return this.join(p, msg.no, msg.code);
      case 'find': return this.find(p, msg.q);
      case 'ready': return this.ready(p, !!msg.on);
      case 'bot-add': return this.addBot(p, msg.style);
      case 'bot-style': return this.setBotStyle(p, msg.id, msg.style);
      case 'bot-remove': return this.removeBot(p, msg.id);
      case 'leave': return this.leaveTable(p, true);
      case 'rematch': return this.rematch(p);
      case 'act': return this.act(p, msg);
      case 'sync': if (p.table?.status === 'playing') p.conn?.send(this.gameState(p.table, p)); return;
      case 'voice': return this.setVoice(p, !!msg.on);
      case 'assets': return this.setAssets(p, msg.progress);
      default:
    }
  }

  // ---- the list of tables waiting for players: a table is in it until it is full or its game has begun
  listMessage() {
    const list = [...this.tables.values()]
      .filter((t) => t.status !== 'playing' && seats(t) < SEATS)
      .sort((a, b) => a.no - b.no)
      .map((t) => ({ no: t.no, count: seats(t), bots: t.bots.length, private: t.private, status: t.status }));
    return { t: 'tables', list };
  }
  listChanged() {
    if (this.listTimer) return;
    this.listTimer = this.timers.set(() => {
      this.listTimer = null;
      const msg = this.listMessage();
      for (const p of this.players.values()) if (p.watching && p.conn) p.conn.send(msg);
    }, 60);
  }

  // ---- tables
  freeNumber() { let n = 1; while (this.tables.has(n)) n++; return n; }
  freeCode() {
    const used = new Set([...this.tables.values()].map((t) => t.code).filter(Boolean));
    let code; do code = String(randomInt(1000, 10000)); while (used.has(code));
    return code;
  }
  create(p, isPrivate) {
    if (!this.canMove(p)) return;
    const table = { no: this.freeNumber(), private: isPrivate, code: isPrivate ? this.freeCode() : null,
      status: 'waiting', players: [], bots: [], timer: null, startsAt: 0, game: null, created: this.now() };
    this.tables.set(table.no, table);
    this.seat(p, table);
  }
  // a player at a waiting table may move to another; a player in a game has to leave it first
  canMove(p) {
    if (p.table && p.table.status === 'playing') { p.conn?.send({ t: 'error', text: 'Сначала покиньте текущую игру.' }); return false; }
    return true;
  }
  join(p, no, code) {
    const table = this.tables.get(Number(no));
    if (!table) { p.conn?.send({ t: 'error', text: 'Такого стола нет. Возможно, за ним уже начали игру.' }); return; }
    if (p.table === table) { this.sendTable(table); return; }
    if (!this.canMove(p)) return;
    if (table.status === 'playing') { p.conn?.send({ t: 'error', text: `За столом № ${table.no} уже идёт игра.` }); return; }
    if (seats(table) >= SEATS) { p.conn?.send({ t: 'error', text: `За столом № ${table.no} все четыре места заняты.` }); return; }
    if (table.private && String(code ?? '') !== table.code) {
      p.conn?.send({ t: 'need-code', no: table.no, wrong: code != null && code !== '' });
      return;
    }
    this.seat(p, table);
  }
  // quick search: four digits are a secret code first; otherwise (or with no such code) a table number
  find(p, q) {
    const s = String(q ?? '').replace(/[\s№#]/g, '');
    if (!/^\d{1,4}$/.test(s)) { p.conn?.send({ t: 'error', text: 'Введите номер стола или четырёхзначный код.' }); return; }
    if (s.length === 4) {
      const byCode = [...this.tables.values()].find((t) => t.private && t.code === s);
      if (byCode) { this.join(p, byCode.no, s); return; }
    }
    if (!this.tables.has(Number(s))) {
      p.conn?.send({ t: 'error', text: s.length === 4 ? 'Стола с таким кодом или номером нет.' : `Стола № ${Number(s)} нет.` });
      return;
    }
    this.join(p, Number(s));
  }
  seat(p, table) {
    if (p.table && p.table !== table) this.leaveTable(p);
    p.table = table; p.online = !!p.conn;
    // a player who sits down during the countdown plays too, once their assets are ready
    p.ready = table.status === 'countdown' && p.assets === 100;
    if (table.status === 'countdown' && p.assets < 100) this.cancelCountdown(table);
    if (!table.players.includes(p)) table.players.push(p);
    this.sendTable(table); this.listChanged();
  }
  ready(p, on) {
    const table = p.table;
    if (!table || table.status === 'playing') return;
    p.ready = on && seats(table) > 1;
    if (!p.ready) this.cancelCountdown(table);
    this.checkStart(table);
    this.sendTable(table); this.listChanged();
  }
  checkStart(table) {
    if (table.status !== 'waiting' || seats(table) < 2) return;
    if (!table.players.every((p) => p.ready && p.conn && p.assets === 100)) return;
    table.status = 'countdown';
    table.startsAt = this.now() + COUNTDOWN_MS;
    table.timer = this.timers.set(() => { table.timer = null; this.begin(table); }, COUNTDOWN_MS);
  }
  cancelCountdown(table) {
    if (table.status !== 'countdown') return;
    this.timers.clear(table.timer); table.timer = null;
    table.status = 'waiting';
  }
  leaveTable(p, asked = false) {
    const table = p.table;
    if (!table) { if (asked) p.conn?.send({ t: 'table', table: null }); return; }
    this.timers.clear(p.away); p.away = null;
    p.table = null; p.ready = false;
    if (table.status === 'playing') {
      this.setPresence(table, p, 'left');
    } else {
      table.players = table.players.filter((o) => o !== p);
      if (seats(table) < 2) for (const o of table.players) o.ready = false;
      this.cancelCountdown(table);
      if (!table.players.length) this.tables.delete(table.no);          // bots alone do not keep a table
      else this.sendTable(table);
      this.listChanged();
    }
    p.conn?.send({ t: 'table', table: null });
    if (!p.conn) this.scheduleForget(p);
  }
  tableView(table, viewer) {
    return {
      no: table.no, private: table.private, code: table.players.includes(viewer) ? table.code : null,
      status: table.status, startsIn: table.status === 'countdown' ? Math.max(0, table.startsAt - this.now()) : 0,
      players: table.players.map((o) => ({ id: o.id, name: o.name, ready: o.ready, online: !!o.conn, assets: o.assets })),
      bots: table.bots.map((b) => ({ id: b.id, name: b.name, style: b.style })),
    };
  }
  // ---- bots: any player at a waiting table may seat one in a free seat, change its style or take it away.
  // A change of the table starts the countdown again (if everyone is still ready), so nobody is surprised by it
  botTable(p) {
    const table = p.table;
    return table && table.status !== 'playing' ? table : null;
  }
  addBot(p, style) {
    const table = this.botTable(p);
    if (!table || !isStyle(style)) return;
    if (seats(table) >= SEATS) { p.conn?.send({ t: 'error', text: 'Свободных мест за столом нет.' }); return; }
    let id; do id = `bot${randomBytes(3).toString('hex').slice(0, 5)}`; while (table.bots.some((b) => b.id === id));
    const b = { id, style, name: '' };
    table.bots.push(b);
    b.name = this.botName(table, b);
    this.botsChanged(table);
  }
  setBotStyle(p, id, style) {
    const table = this.botTable(p), b = table?.bots.find((o) => o.id === id);
    if (!b || !isStyle(style) || b.style === style) return;
    b.style = style; b.name = this.botName(table, b);
    this.botsChanged(table);
  }
  removeBot(p, id) {
    const table = this.botTable(p);
    if (!table || !table.bots.some((o) => o.id === id)) return;
    table.bots = table.bots.filter((o) => o.id !== id);
    if (seats(table) < 2) for (const o of table.players) o.ready = false;
    this.botsChanged(table);
  }
  // a bot is called by its style; a second bot of the same style at the table gets a number: «Корсар 2»
  botName(table, b) {
    const base = BOT_STYLES[b.style], taken = new Set(table.bots.filter((o) => o !== b).map((o) => o.name));
    let name = base;
    for (let k = 2; taken.has(name); k++) name = `${base} ${k}`;
    return name;
  }
  botsChanged(table) {
    this.cancelCountdown(table);
    this.checkStart(table);
    this.sendTable(table); this.listChanged();
  }
  sendTable(table) {
    for (const p of table.players) p.conn?.send({ t: 'table', table: this.tableView(table, p) });
  }

  // ---- the game: sides by lot, turn order by lot, then the actions in the order they came
  begin(table) {
    if (table.status !== 'countdown') return;
    // the players and the bots take their places by lot; a bot is known in the game by its style
    const seated = shuffle([...table.players, ...table.bots]);
    const sides = drawSides(seated.length);
    table.status = 'playing';
    table.game = {
      players: seated.map((p, i) => ({ id: p.id, name: p.name, q: sides[i], ...(p.style ? { bot: p.style } : {}) })),
      log: [], presence: new Map(table.players.map((p) => [p.id, p.conn ? 'online' : 'offline'])), started: this.now(),
      lastAt: this.now(), bots: new Set(table.bots.map((b) => b.id)),
    };
    for (const p of table.players) p.ready = false;
    const voice = this.voiceOf(table), assets = this.assetsOf(table);
    for (const p of table.players) p.conn?.send({ t: 'start', no: table.no, players: table.game.players, me: p.id, turnMs: this.turnMs, voice, assets });
    this.listChanged();
  }
  // The clients detect victory. The first player returning to the table moves the whole company to a fresh one;
  // later requests find a waiting table and do nothing. Nobody is ready automatically: the next game is confirmed again.
  rematch(p) {
    const old = p.table;
    if (!old || old.status !== 'playing') return;
    const table = { no: this.freeNumber(), private: old.private, code: old.private ? this.freeCode() : null,
      status: 'waiting', players: [], bots: old.bots, timer: null, startsAt: 0, game: null, created: this.now() };
    this.tables.set(table.no, table);
    for (const o of old.players) {
      if (o.table !== old) continue;             // a player who deliberately left is not brought back
      this.timers.clear(o.away);
      o.table = table; o.ready = false; o.online = !!o.conn; o.away = null;
      table.players.push(o);
      if (!o.conn) o.away = this.timers.set(() => {
        o.away = null; if (o.table === table && !o.conn) this.leaveTable(o);
      }, WAIT_GRACE_MS);
    }
    this.timers.clear(old.timer); old.timer = null;
    this.tables.delete(old.no);
    this.sendTable(table); this.listChanged();
  }
  gameState(table, p) {
    const g = table.game;
    return { t: 'game', no: table.no, players: g.players, log: g.log, presence: Object.fromEntries(g.presence), me: p.id,
      turnMs: this.turnMs, voice: this.voiceOf(table), assets: this.assetsOf(table) };
  }
  setAssets(p, progress) {
    if (!isInt(progress, 0, 100) || p.assets === progress) return;
    p.assets = progress;
    const table = p.table;
    if (!table) return;
    if (table.status === 'playing') {
      if (table.game.presence.has(p.id)) this.toGame(table, { t: 'assets', id: p.id, progress });
    } else {
      const status = table.status;
      if (progress < 100) this.cancelCountdown(table);
      this.checkStart(table);
      this.sendTable(table);
      if (status !== table.status) this.listChanged();
    }
  }
  assetsOf(table) {
    return Object.fromEntries([...table.game.presence.keys()].map((id) => [id, this.byId.get(id)?.assets ?? 100]));
  }
  // whether a player hears the commentator: the screen that plays the bots makes them wait for him only if somebody does
  setVoice(p, on) {
    if (p.voice === on) return;
    p.voice = on;
    const table = p.table;
    if (table?.status === 'playing' && table.game.presence.has(p.id)) this.toGame(table, { t: 'voice', id: p.id, on });
  }
  voiceOf(table) {
    return Object.fromEntries([...table.game.presence.keys()].map((id) => [id, this.byId.get(id)?.voice !== false]));
  }
  setPresence(table, p, state) {
    const g = table.game;
    if (!g || !g.presence.has(p.id) || g.presence.get(p.id) === state) return;
    g.presence.set(p.id, state);
    this.toGame(table, { t: 'presence', id: p.id, state });
    if ([...g.presence.values()].every((s) => s === 'left')) {
      this.timers.clear(table.timer);
      this.tables.delete(table.no);
      for (const o of table.players) if (o.table === table) o.table = null;
    }
  }
  toGame(table, msg) {
    for (const o of table.players) if (o.table === table && o.conn) o.conn.send(msg);
  }
  act(p, msg) {
    const table = p.table, g = table?.game;
    if (!g || table.status !== 'playing' || g.presence.get(p.id) === 'left') return;
    const a = checkAction(msg.a);
    // a malformed action is refused like one out of order: the client takes the game from the server again
    if (!a) { p.conn?.send({ t: 'reject', n: msg.n, have: g.log.length, kind: msg.a?.kind === 'skip' ? 'skip' : 'bad' }); return; }
    if (msg.n !== g.log.length) { p.conn?.send({ t: 'reject', n: msg.n, have: g.log.length, kind: a.kind }); return; }
    // a bot's decision comes from a player's screen; the bot must play in this game
    if (a.bot && !g.bots.has(a.bot)) { p.conn?.send({ t: 'reject', n: msg.n, have: g.log.length, kind: 'bad' }); return; }
    // only the turns of a player who has gone, or who has let the time for a turn run out, may be skipped
    if (a.kind === 'skip' && g.presence.get(a.id) !== 'left' && this.now() - g.lastAt < this.turnMs - TURN_SLACK_MS) {
      p.conn?.send({ t: 'reject', n: msg.n, have: g.log.length, kind: a.kind }); return;
    }
    // the log is the game for whoever comes back to it: who decided, and the dice — not their flight
    g.log.push({ ...a, ...(a.kind === 'throw' ? { frames: null } : {}), by: a.bot ?? p.id });
    g.lastAt = this.now();
    this.toGame(table, { t: 'act', n: msg.n, a, from: p.id });
  }

  stats() {
    let playing = 0; for (const t of this.tables.values()) if (t.status === 'playing') playing++;
    return { players: this.players.size, online: [...this.players.values()].filter((p) => p.conn).length, tables: this.tables.size, playing };
  }
}
