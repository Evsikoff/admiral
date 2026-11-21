// ------------------------------------------------------------------ playing online: the club of the tavern
// The connection to the server (server/server.js), the list of tables waiting for players, a table with its
// players and their «Готов», the draw of sides, and then the game itself, which app.js plays: every client runs
// the same game, the server numbers the actions and passes them on (see server/lobby.js).
// Any player at a table may seat bots in its free seats and choose their styles (src/bot-styles.js); in the game
// one of the players' screens plays them (app.js).
// Like intro.js it works before (and without) the 3D map. app.js joins with AdmiralOnline.attach(handler):
//   handler.start(game)      a game begins (or is rejoined): { no, players: [{ id, name, q, bot? }], me, log, presence, turnMs }
//                            (bot: the style of a bot; presence lists the people only)
//   handler.act(msg)         an action of the game: { n, a, from }
//   handler.presence(msg)    { id, state: 'online' | 'offline' | 'left' }
//   handler.voice(msg)       { id, on }: a player switched the commentator on or off (game.voice: { id: on })
//   handler.state(game)      the whole game again, after a lost connection or when asked for (AdmiralOnline.sync())
//   handler.reject(msg)      the server refused an action of this client: { n, have, kind }
(function () {
  const intro = window.AdmiralIntro;
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'admiral.online.token';      // per browser tab: two tabs are two players
  const NAME_KEY = 'admiral.online.name';
  const AUDIO_KEY = 'admiral.audio.v1';          // the sound switches of app.js: is the commentator on here
  const DRAW_MS = 3600;                          // the draw is shown this long before the board opens
  const served = location.protocol === 'http:' || location.protocol === 'https:';
  const NATION = {
    ru: { name: 'Россия', sails: 'синие паруса', color: '#2f6fe4' },
    se: { name: 'Швеция', sails: 'жёлтые паруса', color: '#f5c518' },
    en: { name: 'Англия', sails: 'красные паруса', color: '#e0342b' },
    nl: { name: 'Голландия', sails: 'зелёные паруса', color: '#2fae4e' },
  };
  const FLAG = {
    ru: '<rect width="30" height="20" fill="#fbfbf8"/><path d="M0 0L30 20M30 0L0 20" stroke="#1f4e9c" stroke-width="3.2"/>',
    se: '<rect width="30" height="20" fill="#1f5fa8"/><rect x="9.3" width="3.75" height="20" fill="#f2c230"/><rect y="8" width="30" height="4" fill="#f2c230"/>',
    nl: '<rect width="30" height="20" fill="#21468b"/><rect width="30" height="13.33" fill="#fbfbf8"/><rect width="30" height="6.67" fill="#c8202f"/>',
    en: '<rect width="30" height="20" fill="#1e3f8a"/><path d="M0 0L30 20M30 0L0 20" stroke="#fbfbf8" stroke-width="4"/><path d="M0 0L30 20M30 0L0 20" stroke="#c8202f" stroke-width="1.4"/>'
      + '<path d="M15 0V20M0 10H30" stroke="#fbfbf8" stroke-width="6.8"/><path d="M15 0V20M0 10H30" stroke="#c8202f" stroke-width="4"/>',
  };
  const flagSVG = (q) => `<svg class="ol-flag" viewBox="0 0 30 20" aria-hidden="true">${FLAG[q]}</svg>`;
  // the styles of play of the bots: [{ id, title, tagline, about }]
  const STYLES = window.AdmiralBotStyles || [];
  const styleOf = (id) => STYLES.find((st) => st.id === id) || { id, title: 'Бот', tagline: '', about: '' };
  const LOCK = '<svg class="ol-lock" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7.5" rx="1.5"/><path d="M5.2 7V5.1a2.8 2.8 0 0 1 5.6 0V7"/></svg>';

  const panel = $('online'), menuEl = $('intro-menu');
  const lobbyEl = $('ol-lobby'), tableEl = $('ol-table'), drawEl = $('ol-draw');
  const nameInput = $('ol-name'), msgEl = $('ol-msg'), netEl = $('ol-net');
  const rowsEl = $('ol-rows'), emptyEl = $('ol-empty'), listEl = $('ol-list');
  const findForm = $('ol-find'), findInput = $('ol-q');
  const codeBox = $('ol-codebox'), codeForm = $('ol-codeform'), codeInput = $('ol-code'), codeLabel = $('ol-codelabel');
  const privateBox = $('ol-private'), createBtn = $('ol-create'), backBtn = $('ol-back');
  const tableTitle = $('ol-tabletitle'), tableCode = $('ol-tablecode'), seatsEl = $('ol-seats');
  const tableStatus = $('ol-status'), readyBtn = $('ol-ready'), leaveBtn = $('ol-leave');
  const drawList = $('ol-drawlist'), drawNote = $('ol-drawnote');

  let ws = null, connected = false, wanted = false, retry = 0, retryTimer = 0, replaced = false;
  let me = null, token = null, tables = [], table = null, game = null, handler = null, pendingStart = null;
  let open = false, askingNo = null, countdownTimer = 0, drawTimer = 0, msgTimer = 0;
  try { token = sessionStorage.getItem(TOKEN_KEY); } catch { /* no storage */ }

  function savedName() {
    try {
      const n = localStorage.getItem(NAME_KEY);
      if (n) return n;
      const local = JSON.parse(localStorage.getItem('admiral.setup.v2'));     // the first name of the last local game
      if (Array.isArray(local?.names) && typeof local.names[0] === 'string') return local.names[0].trim();
    } catch { /* no storage */ }
    return '';
  }
  nameInput.value = savedName().slice(0, 20);
  // whether this player hears the commentator: the others' bots play at once when nobody at the table does
  function savedVoiceOn() {
    try { return JSON.parse(localStorage.getItem(AUDIO_KEY))?.commentator !== true; } catch { return true; }
  }
  let commentatorOn = savedVoiceOn();

  // ---- the connection: opened when the club is opened, or at once when this tab was at a table before a reload
  function connect() {
    if (!served || ws || replaced) return;
    clearTimeout(retryTimer);
    netStatus();
    let socket;
    try { socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); }
    catch { scheduleRetry(); return; }
    ws = socket;
    socket.onopen = () => {
      connected = true; retry = 0;
      socket.send(JSON.stringify({ t: 'hello', token, name: nameInput.value.trim(), voice: commentatorOn }));
      if (open && !table && !game) send({ t: 'watch', on: true });
      netStatus();
    };
    socket.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } receive(m); };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null; connected = false;
      netStatus();
      scheduleRetry();
    };
  }
  function scheduleRetry() {
    if (!wanted || replaced) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, Math.min(8000, 600 * 2 ** retry++));
  }
  function send(msg) {
    if (!ws || !connected) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }
  function netStatus() {
    let text = '';
    if (!served) text = 'Онлайн-игра работает, когда игра открыта с сервера (npm start), а не из файла.';
    else if (replaced) text = 'Вы подключились к клубу из другой вкладки. Здесь связь закрыта.';
    else if (!connected) text = retry ? 'Нет связи с сервером. Пробуем снова…' : 'Подключаемся к серверу…';
    netEl.textContent = text;
    netEl.hidden = !text;
    for (const b of [createBtn, findForm.querySelector('button')]) b.disabled = !connected;
  }

  function receive(m) {
    switch (m.t) {
      case 'welcome':
        me = m.id; token = m.token;
        try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* no storage */ }
        if (m.name && m.name !== nameInput.value.trim()) nameInput.value = m.name;
        return;
      case 'tables': tables = m.list; renderList(); return;
      case 'table': {
        const was = table;
        table = m.table;
        if (table && game && game.no !== table.no) game = null;
        if (!table && was && open && !game) { showView('lobby'); send({ t: 'watch', on: true }); }
        if (table) { askingNo = null; codeBox.hidden = true; if (open && !game) showView('table'); }
        renderTable();
        syncResume();
        return;
      }
      case 'need-code': askCode(m.no, m.wrong); return;
      case 'error': note(m.text); return;
      case 'start':
        table = null;
        game = { no: m.no, players: m.players, me: m.me, log: [], turnMs: m.turnMs, voice: m.voice || {},
          presence: Object.fromEntries(m.players.filter((p) => !p.bot).map((p) => [p.id, 'online'])) };
        showDraw();
        return;
      case 'game': {
        const fresh = !game || game.no !== m.no;
        game = { no: m.no, players: m.players, me: m.me, log: m.log, presence: m.presence, turnMs: m.turnMs, voice: m.voice || {} };
        table = null;
        if (pendingStart) { pendingStart = game; deliverStart(); }
        else if (handler && handler.inGame?.()) handler.state(game);
        else if (fresh || intro.stage !== 'online-game') {
          // back after a reload: the game goes on; it opens with the next click (the browser wants one for sound)
          if (intro.stage === 'menu' && open) beginGame();
          else syncResume();
        }
        return;
      }
      case 'act':
        m.a.by = m.a.bot || m.from;
        if (game) game.log[m.n] = m.a;
        handler?.act(m);
        return;
      case 'presence':
        if (game) game.presence[m.id] = m.state;
        handler?.presence(m);
        return;
      case 'voice':
        if (game) game.voice[m.id] = m.on;
        handler?.voice?.(m);
        return;
      case 'reject': handler?.reject(m); return;
      case 'replaced':
        replaced = true; wanted = false;
        if (ws) { const s = ws; ws = null; connected = false; s.close(); }
        netStatus();
        return;
      default:
    }
  }

  // ---- the panel in the tavern: the list of tables, a table, the draw
  function showView(which) {
    lobbyEl.hidden = which !== 'lobby'; tableEl.hidden = which !== 'table'; drawEl.hidden = which !== 'draw';
    backBtn.hidden = which !== 'lobby';
    if (which !== 'table') stopCountdown();
  }
  function openClub() {
    if (open) return;
    open = true; wanted = true;
    menuEl.classList.add('online-open');
    panel.hidden = false;
    connect();
    netStatus();
    if (game) { beginGame(); return; }
    showView(table ? 'table' : 'lobby');
    renderList(); renderTable();
    if (!table) send({ t: 'watch', on: true });
    setTimeout(() => (table ? readyBtn : findInput).focus({ preventScroll: true }), 50);
  }
  function closeClub() {
    if (!open) return;
    open = false;
    send({ t: 'watch', on: false });
    menuEl.classList.remove('online-open');
    panel.hidden = true;
    codeBox.hidden = true; askingNo = null;
    stopCountdown();
  }
  backBtn.addEventListener('click', () => { closeClub(); intro.backFromClub(); });

  function note(text, ms = 4200) {
    msgEl.textContent = text;
    msgEl.classList.add('on');
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => msgEl.classList.remove('on'), ms);
  }

  function renderList() {
    rowsEl.replaceChildren(...tables.map((t) => {
      const tr = document.createElement('tr');
      const people = t.count - (t.bots || 0);              // the bots' seats are marked apart
      const seats = Array.from({ length: 4 }, (_, i) => `<i class="${i < people ? 'on' : i < t.count ? 'on bot' : ''}"></i>`).join('');
      tr.innerHTML = `<td class="ol-no">№&nbsp;${t.no}</td>`
        + `<td><span class="ol-count"><span class="ol-pips" aria-hidden="true">${seats}</span>${t.count}&nbsp;из&nbsp;4`
        + `${t.bots ? `<small class="ol-botcount">${t.bots === 1 ? 'один бот' : `ботов: ${t.bots}`}</small>` : ''}</span></td>`
        + `<td>${t.private ? `<span class="ol-access priv">${LOCK}по коду</span>` : '<span class="ol-access">открытый</span>'}`
        + `${t.status === 'countdown' ? '<span class="ol-soon">начинает</span>' : ''}</td>`
        + '<td class="ol-act"><button type="button" class="ol-sit">Сесть</button></td>';
      tr.querySelector('button').addEventListener('click', () => {
        if (t.private) askCode(t.no, false);
        else send({ t: 'join', no: t.no });
      });
      tr.querySelector('button').setAttribute('aria-label', `Сесть за стол № ${t.no}`);
      return tr;
    }));
    listEl.hidden = !tables.length;
    emptyEl.hidden = !!tables.length;
  }
  function askCode(no, wrong) {
    askingNo = no;
    codeLabel.textContent = wrong ? `Код не подошёл. Код стола № ${no}:` : `Стол № ${no} закрыт. Код из четырёх цифр:`;
    codeBox.hidden = false;
    codeBox.classList.toggle('wrong', !!wrong);
    codeInput.value = '';
    codeInput.focus();
  }
  codeForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const code = codeInput.value.replace(/\D/g, '');
    if (code.length !== 4) { codeInput.focus(); return; }
    send({ t: 'join', no: askingNo, code });
  });
  $('ol-codecancel').addEventListener('click', () => { codeBox.hidden = true; askingNo = null; findInput.focus(); });
  findForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const q = findInput.value.trim();
    if (!q) { findInput.focus(); return; }
    send({ t: 'find', q });
  });
  createBtn.addEventListener('click', () => send({ t: 'create', private: privateBox.checked }));
  let nameTimer = 0;
  function saveName() {
    clearTimeout(nameTimer);
    const name = nameInput.value.replace(/\s+/g, ' ').trim().slice(0, 20);
    try { localStorage.setItem(NAME_KEY, name); } catch { /* no storage */ }
    if (name) send({ t: 'name', name });
  }
  nameInput.addEventListener('input', () => { clearTimeout(nameTimer); nameTimer = setTimeout(saveName, 700); });
  nameInput.addEventListener('change', saveName);
  nameInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); saveName(); nameInput.blur(); } });

  function renderTable() {
    if (!table) return;
    tableTitle.textContent = `Стол № ${table.no}`;
    tableCode.hidden = !table.private;
    if (table.private) tableCode.querySelector('b').textContent = table.code || '····';
    // the people first, then the bots; the first free seat offers a bot
    const bots = table.bots || [], n = table.players.length + bots.length;
    const seated = [...table.players, ...bots.map((b) => ({ ...b, bot: true }))];
    const focused = document.activeElement?.dataset?.key;          // the control in use keeps the focus
    seatsEl.replaceChildren(...Array.from({ length: 4 }, (_, i) => {
      const p = seated[i], li = document.createElement('li');
      if (!p) {
        li.className = 'free';
        li.innerHTML = `<span class="ol-seat">${i + 1}</span><span class="ol-pname">свободное место</span>`;
        if (i === n && STYLES.length) {
          const add = document.createElement('button');
          add.type = 'button'; add.className = 'ol-addbot'; add.dataset.key = 'addbot'; add.textContent = '+ Бот';
          add.title = 'Посадить за стол бота. Его стиль игры можно будет выбрать.';
          add.setAttribute('aria-label', `Посадить бота на место ${i + 1}`);
          add.addEventListener('click', () => send({ t: 'bot-add', style: STYLES[0].id }));
          li.appendChild(add);
        }
        return li;
      }
      if (p.bot) {
        const st = styleOf(p.style);
        li.className = 'bot';
        li.title = st.about;
        li.innerHTML = `<span class="ol-seat">${i + 1}</span>`
          + '<span class="ol-pname"><span class="ol-botname"></span><small class="ol-bottag"></small></span>'
          + '<span class="ol-botctl"><select class="ol-botstyle"></select><button type="button" class="ol-botdel">Убрать</button></span>';
        li.querySelector('.ol-botname').textContent = p.name;
        li.querySelector('.ol-bottag').textContent = `бот · ${st.tagline}`;
        const sel = li.querySelector('select'), del = li.querySelector('button');
        for (const o of STYLES) sel.add(new Option(o.title, o.id, false, o.id === p.style));
        sel.dataset.key = `style:${p.id}`;
        sel.setAttribute('aria-label', `Стиль игры бота «${p.name}»`);
        sel.addEventListener('change', () => send({ t: 'bot-style', id: p.id, style: sel.value }));
        del.dataset.key = `del:${p.id}`;
        del.setAttribute('aria-label', `Убрать бота «${p.name}»`);
        del.addEventListener('click', () => send({ t: 'bot-remove', id: p.id }));
        return li;
      }
      li.className = [p.ready ? 'ready' : '', p.online ? '' : 'away', p.id === me ? 'me' : ''].filter(Boolean).join(' ');
      li.innerHTML = `<span class="ol-seat">${i + 1}</span><span class="ol-pname"></span><span class="ol-pstate"></span>`;
      li.querySelector('.ol-pname').textContent = p.name + (p.id === me ? ' (вы)' : '');
      li.querySelector('.ol-pstate').textContent = !p.online ? 'нет связи' : p.ready ? 'готов' : n > 1 ? 'не готов' : '';
      return li;
    }));
    if (focused) seatsEl.querySelector(`[data-key="${focused}"]`)?.focus({ preventScroll: true });
    const mine = table.players.find((p) => p.id === me);
    readyBtn.disabled = n < 2;
    readyBtn.setAttribute('aria-pressed', String(!!mine?.ready));
    readyBtn.textContent = mine?.ready ? 'Готов ✓' : 'Готов';
    readyBtn.classList.toggle('on', !!mine?.ready);
    stopCountdown();
    if (table.status === 'countdown') {
      const end = performance.now() + table.startsIn;
      const tick = () => {
        const s = Math.max(0, Math.ceil((end - performance.now()) / 1000));
        tableStatus.innerHTML = `<span class="ol-big">Игра начнётся через ${s || '…'}</span>`
          + (n < 4 ? '<small>К столу ещё можно присоединиться</small>' : '');
      };
      tick(); countdownTimer = setInterval(tick, 200);
    } else if (n < 2) {
      tableStatus.innerHTML = (table.private
        ? `Ждём соперников. Пусть друзья введут код <b>${table.code}</b> в поиске столов`
        : `Ждём соперников. Друзья найдут вас по номеру стола: <b>${table.no}</b>`)
        + (STYLES.length ? ' — или посадите за стол бота.' : '.');
    } else {
      const waiting = table.players.filter((p) => !p.ready).length;
      tableStatus.textContent = waiting
        ? `Когда все нажмут «Готов», игра начнётся через 3 секунды. Ждём: ${waiting}.`
        : 'Все готовы.';
    }
  }
  function stopCountdown() { clearInterval(countdownTimer); countdownTimer = 0; }
  readyBtn.addEventListener('click', () => {
    const mine = table?.players.find((p) => p.id === me);
    if (!mine?.ready) intro.enterFullscreen();
    send({ t: 'ready', on: !mine?.ready });
  });
  leaveBtn.addEventListener('click', () => send({ t: 'leave' }));
  $('ol-copy').addEventListener('click', () => {
    const text = table?.code || '';
    try { navigator.clipboard.writeText(text).then(() => note('Код скопирован.'), () => {}); } catch { /* no clipboard */ }
  });

  // ---- the draw, then the board
  function showDraw() {
    if (!open) { openClub(); return; }          // a game started while the club was not on screen: openClub shows it
    showView('draw');
    const players = game.players;
    drawList.innerHTML = players.map((p, i) => `<li class="lot" style="--team:${NATION[p.q].color};--i:${i}">`
      + `<span class="pl-num" aria-hidden="true">${i + 1}</span>`
      + `<span class="lot-name"></span>`
      + `<span class="lot-side">${flagSVG(p.q)}<span><b>${NATION[p.q].name}</b><small>${NATION[p.q].sails}</small></span></span></li>`).join('');
    drawList.querySelectorAll('.lot-name').forEach((el, i) => {
      const p = players[i];
      el.textContent = p.name + (p.id === game.me ? ' (вы)' : '');
      if (p.bot) {
        const tag = document.createElement('small');
        tag.className = 'lot-bot'; tag.textContent = `бот · ${styleOf(p.bot).tagline}`;
        el.appendChild(tag);
      }
    });
    const mine = players.find((p) => p.id === game.me);
    drawNote.textContent = mine ? `Вы играете за ${{ ru: 'Россию', se: 'Швецию', en: 'Англию', nl: 'Голландию' }[mine.q]}. Ходят в этом порядке.` : '';
    clearTimeout(drawTimer);
    drawTimer = setTimeout(beginGame, DRAW_MS);
  }
  function beginGame() {
    clearTimeout(drawTimer);
    if (!game) return;
    intro.enterFullscreen();
    closeClub();
    intro.enterGame('online-game');
    pendingStart = game;
    deliverStart();
  }
  function deliverStart() {
    if (!handler || !pendingStart) return;
    const g = pendingStart; pendingStart = null;
    handler.start(g);
  }

  // after a reload the start screen offers to go back to the table or the game instead of the films
  function syncResume() {
    const label = game ? 'Вернуться в игру' : table ? `Вернуться к столу № ${table.no}` : null;
    intro.setResume(label);
  }
  function resume() {
    if (game) { wanted = true; beginGame(); return true; }
    if (table) { intro.openClubFromStart(); return true; }
    return false;
  }
  if (served && token) { wanted = true; connect(); }

  window.AdmiralOnline = {
    get me() { return game?.me ?? me; },
    get game() { return game; },
    get connected() { return connected; },
    available: served,
    open: openClub,
    close: closeClub,
    resume,
    attach(h) { handler = h; deliverStart(); },
    send: (msg) => send(msg),
    setVoice(on) {
      if (commentatorOn === on) return;
      commentatorOn = on;
      send({ t: 'voice', on });
    },
    act: (n, a) => send({ t: 'act', n, a }),
    sync: () => send({ t: 'sync' }),
    // leaving the game: the seat is given up; the board goes back to the tavern
    leaveGame() {
      send({ t: 'leave' });
      game = null; pendingStart = null;
      syncResume();
    },
  };
})();
