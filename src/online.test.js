import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('online.js', import.meta.url), 'utf8');

function element() {
  const events = new Map(), children = new Map();
  return {
    value: '', classList: { add() {}, remove() {}, toggle() {} },
    addEventListener: (type, listener) => events.set(type, listener),
    click: () => events.get('click')(),
    querySelector(selector) {
      if (!children.has(selector)) children.set(selector, element());
      return children.get(selector);
    },
    setAttribute() {}, replaceChildren() {},
  };
}

function setup() {
  const sent = [], entered = [];
  let socket, finishLoading;
  const loading = new Promise((resolve) => { finishLoading = resolve; });
  const intro = {
    stage: 'menu', enterFullscreen() {}, setResume() {},
    prepareGame: () => loading,
    enterGame: (stage) => entered.push(stage),
    showMenu() { this.stage = 'menu'; },
  };
  const root = element();
  const window = { AdmiralIntro: intro, addEventListener() {} };
  const document = { getElementById: root.querySelector, createElement: element };
  const storage = { getItem: () => null, setItem() {} };
  class WebSocket {
    constructor() { socket = this; }
    send(message) { sent.push(JSON.parse(message)); }
  }
  runInNewContext(source, {
    window, document, WebSocket, location: { protocol: 'https:', host: 'example.test' },
    sessionStorage: storage, localStorage: storage, setTimeout() {}, clearTimeout() {}, clearInterval() {},
  });
  const online = window.AdmiralOnline;
  online.open(); socket.onopen();
  const receive = (message) => socket.onmessage({ data: JSON.stringify(message) });
  receive({ t: 'welcome', id: 'a', token: 'token' });
  return { online, receive, finishLoading, sent, entered, intro, document, ready: document.getElementById('ol-ready') };
}

test('ready click survives table updates while the game assets are loading', async () => {
  const { receive, finishLoading, sent, ready } = setup();
  const sendTable = (assets) => receive({ t: 'table', table: {
    no: 1, status: 'waiting', players: [
      { id: 'a', name: 'Анна', online: true, ready: false, assets },
      { id: 'b', name: 'Борис', online: true, ready: true, assets: 100 },
    ],
  } });
  sendTable(30);
  const click = ready.click();
  sendTable(60);
  assert.equal(ready.disabled, true);
  sendTable(100);
  assert.equal(sent.some(({ t }) => t === 'ready'), false);
  finishLoading();
  await click;
  assert.equal(ready.disabled, false);
  assert.deepEqual(sent.at(-1), { t: 'ready', on: true });
});

test('a rematch opens the new table instead of leaving it', () => {
  const { online, receive, sent, intro, document } = setup();
  const returned = [];
  online.attach({ inGame: () => true, state() {}, table: (table) => returned.push(table.no) });
  intro.stage = 'online-game';
  receive({ t: 'game', no: 1, me: 'a', players: [{ id: 'a', name: 'Анна', q: 'ru' }], presence: {}, log: [] });
  online.close();
  online.rematch();
  assert.deepEqual(sent.at(-1), { t: 'rematch' });
  receive({ t: 'table', table: {
    no: 2, private: false, status: 'waiting',
    players: [{ id: 'a', name: 'Анна', online: true, ready: false, assets: 100 }], bots: [],
  } });
  assert.deepEqual(returned, [2]);
  assert.equal(online.game, null);
  assert.equal(intro.stage, 'online');
  assert.equal(document.getElementById('online').hidden, false);
  assert.equal(document.getElementById('ol-table').hidden, false);
  assert.equal(document.getElementById('ol-lobby').hidden, true);
  assert.equal(sent.some(({ t }) => t === 'leave'), false, 'the new seat is not given up while opening it');
});

test('opening a game after loading uses the newest server snapshot', async () => {
  const { online, receive, finishLoading, entered } = setup();
  const started = [];
  online.attach({ inGame: () => false, start: (game) => started.push(game) });
  const sendGame = (log) => receive({ t: 'game', no: 1, me: 'a', players: [], presence: {}, log });
  sendGame([]);
  sendGame([{ kind: 'throw' }]);
  finishLoading();
  await new Promise(setImmediate);
  assert.deepEqual(entered, ['online-game']);
  assert.equal(started.length, 1);
  assert.equal(started[0].log[0].kind, 'throw');
});
