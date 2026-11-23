// ------------------------------------------------------------------ the way into the game
// A start screen (the logo and «Запустить»), then two films that cannot be skipped or paused, then the main menu:
// a sailors' tavern with its own theme. Nothing here needs the 3D map, so it works while the map is still being
// built. The films download first, immediately; everything else continues in the background after them.
// app.js listens for its events on window:
//   'admiral:menu'        the main menu has opened: its music starts
//   'admiral:play-local'  «Играть локально»: the setup screen of a game at one computer opens
// and brings the menu back with AdmiralIntro.showMenu() (the setup screen's «В меню», leaving an online game).
// «Играть онлайн» opens the club of the tavern (src/online.js) over the menu; a game found there leaves the menu
// with enterGame('online-game'). After a reload in the middle of an online game the start screen offers to go
// back to it, without the films.
(function () {
  const FILMS = ['assets/video/studio.mp4', 'assets/video/game_intro.mp4'];
  const FADE = 600;           // ms; the fades of the layers are set from here
  const FILM_GAP = 350;       // ms of black between the films
  const STALL = 12000;        // a film that shows nothing new for this long is given up, so nobody is left on black

  const $ = (id) => document.getElementById(id);
  const startEl = $('intro-start'), filmsEl = $('intro-films'), menuEl = $('intro-menu');
  const video = $('intro-video'), launchBtn = $('intro-launch');
  const loadEl = $('intro-loading'), progressEl = $('intro-progress'), percentEl = $('intro-percent');
  const loadStatus = $('intro-load-status'), loadDetail = $('intro-load-detail'), retryBtn = $('intro-continue');
  const gameLoadEl = $('game-loading'), gameProgress = $('game-progress'), gamePercent = $('game-percent');
  const gameLoadStatus = $('game-load-status'), gameLoadDetail = $('game-load-detail'), gameRetry = $('game-retry');
  const filmStatus = $('intro-film-status'), filmMessage = $('intro-film-message'), filmPlay = $('intro-film-play');
  const localBtn = $('menu-local'), onlineBtn = $('menu-online'), noteEl = $('menu-note');
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  let selectedShipSet = null;

  // stage: start → loading → films → menu ⇄ local; menu ⇄ online (the club) → online-game
  const api = {
    stage: 'start', showMenu, enterGame, enterFullscreen, backFromClub, setResume, openClubFromStart, prepareGame,
    get shipSet() { return selectedShipSet; },
  };
  window.AdmiralIntro = api;
  function enterFullscreen() {
    if (document.fullscreenElement || !document.documentElement.requestFullscreen) return;
    try {
      const request = document.documentElement.requestFullscreen();
      request?.catch?.(() => {});
    } catch { /* the game still starts if fullscreen is unavailable */ }
  }
  const emit = (name) => window.dispatchEvent(new CustomEvent(name));

  // ---- layers: shown and hidden by fading; a hidden layer is out of the page (and of the keyboard's way)
  function show(el, ms = FADE) {
    clearTimeout(el.fadeTimer);
    el.hidden = false;
    el.style.transitionDuration = ms + 'ms';
    void el.offsetWidth;                            // start the fade from the transparent state
    el.classList.add('on');
  }
  function hide(el, ms = FADE) {
    clearTimeout(el.fadeTimer);
    el.style.transitionDuration = ms + 'ms';
    el.classList.remove('on');
    el.fadeTimer = setTimeout(() => { el.hidden = true; }, ms);
  }
  // while a layer covers the whole screen the 3D map behind it is not drawn (app.js checks this class)
  const cover = (on) => document.body.classList.toggle('intro-open', on);

  // Start with the films on the start screen; the rest follows while they play and in the menu.
  video.preload = 'auto';
  launchBtn.addEventListener('click', startFilms);
  function preload(onProgress) {
    const loading = window.AdmiralAssets.loadFilms(onProgress);
    loading.then(() => { window.AdmiralAssets.load().catch(() => {}); }, () => {});
    return loading;
  }
  preload();
  const launchTitle = launchBtn.querySelector('.plank-title'), startHint = startEl.querySelector('.start-hint');
  const LAUNCH = launchTitle.textContent, HINT = startHint.textContent;
  // a tab that was at a table or in a game before a reload: «Запустить» becomes the way back to it
  function setResume(label) {
    launchTitle.textContent = label || LAUNCH;
    startHint.textContent = label ? 'Игра по сети продолжается' : HINT;
  }

  // ---- the films: no controls, no seeking, no pausing; only their end (or a broken file) moves on
  let film = -1, switching = false, watchdog = 0, lastTime = -1, lastProgress = 0;
  let preparing = false, waitingForTap = false;
  async function startFilms() {
    if (preparing || !['start', 'loading'].includes(api.stage)) return;
    emit('admiral:unlock-audio');                    // synchronous with the original tap, before any await
    if (window.AdmiralAssets.filmsReady()) {
      if (!window.AdmiralOnline?.resume()) beginFilms();
      return;
    }
    preparing = true;
    api.stage = 'loading';
    launchBtn.hidden = true; startHint.hidden = true; loadEl.hidden = false; retryBtn.hidden = true;
    loadStatus.textContent = 'Загружаем вступительные видео';
    try {
      await preload(({ loaded, total, completed, count }) => {
        const percent = total ? Math.floor(loaded / total * 100) : 100;
        progressEl.value = percent; percentEl.textContent = percent + '%';
        loadDetail.textContent = `${(loaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} МБ · ${completed} / ${count} файлов`;
      });
      api.stage = 'start';
      if (!window.AdmiralOnline?.resume()) beginFilms();
    } catch (error) {
      loadStatus.textContent = error.message;
      retryBtn.hidden = false;
      retryBtn.focus({ preventScroll: true });
    } finally { preparing = false; }
  }
  retryBtn.addEventListener('click', startFilms);

  let gamePreparation = null, finishPreparation = null, preparingGame = false;
  function prepareGame() {
    if (window.AdmiralAssets.isReady() && window.__admiralReady) return Promise.resolve();
    if (!gamePreparation) {
      gamePreparation = new Promise((resolve) => { finishPreparation = resolve; });
      show(gameLoadEl, 0);
      loadForGame();
    }
    return gamePreparation;
  }
  async function loadForGame() {
    if (preparingGame) return;
    preparingGame = true; gameRetry.hidden = true;
    gameLoadStatus.textContent = 'Загружаем ресурсы игры';
    try {
      await window.AdmiralAssets.load(({ loaded, total, completed, count }) => {
        const percent = total ? Math.floor(loaded / total * 100) : 100;
        gameProgress.value = percent; gamePercent.textContent = percent + '%';
        gameLoadDetail.textContent = `${(loaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} МБ · ${completed} / ${count} файлов`;
      });
      gameProgress.value = 100; gamePercent.textContent = '100%';
      gameLoadStatus.textContent = 'Подготавливаем 3D-карту…';
      await waitForMap();
      hide(gameLoadEl, 300);
      const done = finishPreparation;
      gamePreparation = null; finishPreparation = null;
      done();
    } catch (error) {
      gameLoadStatus.textContent = error.message;
      gameRetry.hidden = false;
      gameRetry.focus({ preventScroll: true });
    } finally { preparingGame = false; }
  }
  gameRetry.addEventListener('click', loadForGame);
  function waitForMap() {
    if (window.__admiralReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener('admiral:ready', ready);
        reject(new Error('Не удалось подготовить 3D-карту. Обновите страницу и проверьте поддержку WebGL.'));
      }, 60000);
      function ready() { clearTimeout(timer); resolve(); }
      window.addEventListener('admiral:ready', ready, { once: true });
    });
  }
  function beginFilms() {
    api.stage = 'films';
    guardMedia(true);
    show(filmsEl, 0);                               // black at once under the start screen, which then fades away
    hide(startEl, 450);
    playFilm(0);
    watchdog = setInterval(checkStall, 1000);
  }
  function playFilm(i) {
    film = i;
    if (i >= FILMS.length) { endFilms(); return; }
    video.src = window.AdmiralAssets.url(FILMS[i]);  // reuse the fully downloaded bytes and the same video element
    video.muted = false;
    waitingForTap = false; filmStatus.hidden = false; filmPlay.hidden = true;
    filmMessage.textContent = 'Подготавливаем видео…';
    lastTime = -1; lastProgress = performance.now();
    tryPlay();
  }
  function tryPlay() {
    let p;
    try { p = video.play(); } catch (error) { playbackFailed(error); return; }
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        if (api.stage !== 'films' || !err) return;
        playbackFailed(err);
      });
    }
  }
  function playbackFailed(error) {
    if (api.stage !== 'films') return;
    if (error.name === 'NotSupportedError') { nextFilm(); return; }
    if (error.name === 'AbortError') return;
    waitingForTap = true; filmStatus.hidden = false; filmPlay.hidden = false;
    filmMessage.textContent = 'Нажмите, чтобы продолжить видео со звуком';
  }
  filmPlay.addEventListener('click', () => {
    emit('admiral:unlock-audio');
    waitingForTap = false; lastProgress = performance.now();
    filmPlay.hidden = true; tryPlay();
  });
  function nextFilm() {
    if (api.stage !== 'films' || switching || waitingForTap) return;
    switching = true;
    video.classList.remove('lit');
    setTimeout(() => { switching = false; playFilm(film + 1); }, FILM_GAP);
  }
  function checkStall() {
    if (api.stage !== 'films' || switching || waitingForTap) return;
    if (document.hidden) { lastProgress = performance.now(); return; }
    if (performance.now() - lastProgress > STALL) nextFilm();
  }
  function endFilms() {
    clearInterval(watchdog);
    guardMedia(false);
    video.removeAttribute('src');                   // let go of the films
    video.load();
    openMenu(true);
  }
  video.addEventListener('playing', () => {
    video.classList.add('lit'); filmStatus.hidden = true; waitingForTap = false;
    lastProgress = performance.now();
  });
  video.addEventListener('waiting', () => {
    if (api.stage === 'films' && !switching && !waitingForTap) {
      filmStatus.hidden = false; filmMessage.textContent = 'Подготавливаем видео…';
    }
  });
  video.addEventListener('ended', nextFilm);
  video.addEventListener('error', () => { if (video.getAttribute('src')) nextFilm(); });
  video.addEventListener('timeupdate', () => {
    if (video.currentTime !== lastTime) { lastTime = video.currentTime; lastProgress = performance.now(); }
  });
  // nothing may pause a film: not a media key, not the browser's media controls; a hidden tab resumes when shown
  video.addEventListener('pause', () => {
    if (api.stage === 'films' && !switching && !waitingForTap && !video.ended && !document.hidden) tryPlay();
  });
  document.addEventListener('visibilitychange', () => {
    if (api.stage === 'films' && !document.hidden && !switching && video.paused && !video.ended) tryPlay();
  });
  const MEDIA_ACTIONS = ['play', 'pause', 'stop', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack', 'skipad'];
  function guardMedia(on) {
    const session = navigator.mediaSession;
    if (!session || !session.setActionHandler) return;
    for (const action of MEDIA_ACTIONS) {
      try { session.setActionHandler(action, on ? () => {} : null); } catch { /* action not supported */ }
    }
  }
  window.addEventListener('keydown', (ev) => {
    if (api.stage === 'films') {
      if (ev.target.closest?.('#intro-film-play') && (ev.key === 'Enter' || ev.key === ' ')) return;
      // keys do nothing during the films (browser shortcuts with Ctrl/Alt/⌘ and F-keys still work)
      if (ev.ctrlKey || ev.metaKey || ev.altKey || /^F\d+$/.test(ev.key)) return;
      ev.preventDefault(); ev.stopImmediatePropagation();
    } else if (api.stage === 'start' && (ev.key === 'Enter' || ev.key === ' ') && !ev.target.closest?.('button')) {
      ev.preventDefault(); startFilms();
    } else if (api.stage === 'online' && ev.key === 'Escape' && !document.getElementById('ol-back').hidden) {
      ev.preventDefault(); document.getElementById('ol-back').click();
    }
  }, true);
  filmsEl.addEventListener('contextmenu', (ev) => ev.preventDefault());

  // ---- the main menu
  const shipSetsEl = $('menu-ship-sets'), shipSummary = shipSetsEl.querySelector('summary');
  const shipName = $('menu-ship-name'), shipIcon = $('menu-ship-icon'), shipOptions = $('menu-ship-options');
  const shipButtons = new Map();
  const SHIP_SET_KEY = 'admiral.ship-set.v1';
  const chipNumber = new Intl.NumberFormat('ru');
  const chipPlural = new Intl.PluralRules('ru');
  const identity = window.AdmiralIdentity;
  identity?.ready.then((valid) => {
    if (!valid) return;
    $('menu-chip-balance').textContent = chipNumber.format(identity.chips);
    const price = $('menu-online-price');
    price.lastElementChild.textContent = `${chipAmount(identity.onlinePartyPrice)} за партию`;
    price.hidden = false;
    const sets = identity.shipSets;
    if (sets.length) {
      shipOptions.replaceChildren(...sets.map(shipOption));
      let saved = null;
      try { saved = localStorage.getItem(SHIP_SET_KEY); } catch { /* no storage */ }
      const available = sets.filter((set) => set.free || set.owned);
      const initial = available.find((set) => String(set.id) === saved) || available.find((set) => set.free) || available[0];
      if (initial) selectShipSet(initial);
      else shipName.textContent = 'Посмотреть наборы';
      shipSetsEl.hidden = false;
    }
    $('menu-account').hidden = false;
  });
  function chipAmount(amount) {
    const units = { one: 'фишка', few: 'фишки', many: 'фишек' };
    return `${chipNumber.format(amount)} ${units[chipPlural.select(amount)]}`;
  }
  function shipOption(set) {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    const icon = document.createElement('img');
    icon.alt = '';
    icon.className = 'menu-ship-icon';
    icon.loading = 'lazy';
    icon.src = set.icon;
    const label = document.createElement('span');
    label.className = 'menu-ship-option-name';
    label.textContent = set.name;
    button.append(icon, label);
    if (set.free || set.owned) {
      const check = document.createElement('span');
      check.className = 'menu-ship-selected';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = '✓';
      check.hidden = true;
      button.append(check);
      button.setAttribute('aria-pressed', 'false');
      shipButtons.set(set, button);
      button.addEventListener('click', () => {
        selectShipSet(set);
        try { localStorage.setItem(SHIP_SET_KEY, String(set.id)); } catch { /* no storage */ }
        closeShipSets(true);
      });
    } else {
      button.disabled = true;
      const price = document.createElement('span');
      price.className = 'menu-ship-option-price';
      const amount = set.prices.find((tier) => tier.number_defeated_opponents === 0).price;
      price.textContent = chipAmount(amount);
      button.append(price);
    }
    row.append(button);
    return row;
  }
  function selectShipSet(set) {
    if (set === selectedShipSet) return;
    const previous = shipButtons.get(selectedShipSet);
    if (previous) {
      previous.setAttribute('aria-pressed', 'false');
      previous.lastElementChild.hidden = true;
    }
    selectedShipSet = set;
    const button = shipButtons.get(set);
    button.setAttribute('aria-pressed', 'true');
    button.lastElementChild.hidden = false;
    shipName.textContent = set.name;
    shipIcon.src = set.icon;
    shipIcon.hidden = false;
    emit('admiral:ship-set');
  }
  function closeShipSets(restoreFocus = false) {
    shipSetsEl.open = false;
    if (restoreFocus) shipSummary.focus({ preventScroll: true });
  }
  shipSetsEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !shipSetsEl.open) return;
    event.preventDefault();
    event.stopPropagation();
    closeShipSets(true);
  });
  shipSetsEl.addEventListener('focusout', (event) => {
    if (event.relatedTarget && !shipSetsEl.contains(event.relatedTarget)) closeShipSets();
  });
  document.addEventListener('pointerdown', (event) => {
    if (shipSetsEl.open && !shipSetsEl.contains(event.target)) closeShipSets();
  });

  function openMenu(afterFilms) {
    api.stage = 'menu';
    cover(true);
    if (afterFilms) { show(menuEl, 0); hide(filmsEl, 1200); }     // the tavern comes out of the black
    else show(menuEl, 500);
    startAmbience();
    emit('admiral:menu');
    setTimeout(() => { if (api.stage === 'menu' && !document.activeElement?.closest?.('#intro-menu')) localBtn.focus({ preventScroll: true }); }, afterFilms ? 1200 : 500);
  }
  function showMenu() {
    if (['menu', 'online', 'start', 'loading', 'films'].includes(api.stage)) return;
    openMenu(false);
  }
  // from the menu (or straight from the start screen, back into an online game) to the map
  function enterGame(kind) {
    const from = api.stage;
    api.stage = kind;
    closeShipSets();
    clearNote();
    cover(false);                                    // the map is drawn again while the menu fades away
    if (from === 'start') { hide(startEl, 450); dropFilms(); }
    hide(menuEl, 500);
    setTimeout(() => { if (api.stage !== 'menu' && api.stage !== 'online') stopAmbience(); }, 500);
  }
  localBtn.addEventListener('click', () => {
    if (api.stage !== 'menu') return;
    enterGame('local');
    emit('admiral:play-local');
  });
  let noteTimer = 0;
  onlineBtn.addEventListener('click', () => {
    if (api.stage !== 'menu') return;
    if (!window.AdmiralOnline) { showNote('Онлайн-игра недоступна в этой сборке.'); return; }
    closeShipSets();
    clearNote();
    api.stage = 'online';
    window.AdmiralOnline.open();
  });
  const rulesBtn = $('menu-rules');
  rulesBtn.addEventListener('click', () => {
    if (api.stage !== 'menu') return;
    closeShipSets();
    let audioOff;
    try { audioOff = JSON.parse(localStorage.getItem('admiral.audio.v1')); } catch { /* no storage */ }
    clearNote();
    api.stage = 'rules';
    stopAmbience();
    emit('admiral:rules-open');
    window.AdmiralRules.open({
      silent: audioOff?.music === true || audioOff?.commentator === true,
      closed() {
        api.stage = 'menu';
        startAmbience();
        emit('admiral:rules-close');
        rulesBtn.focus({ preventScroll: true });
      },
    });
  });
  function backFromClub() {
    if (api.stage !== 'online') return;
    api.stage = 'menu';
    onlineBtn.focus({ preventScroll: true });
  }
  // after a reload at a waiting table: the tavern at once, with the club open
  function openClubFromStart() {
    if (api.stage !== 'start') return;
    hide(startEl, 450); dropFilms();
    openMenu(false);
    api.stage = 'online';
    window.AdmiralOnline.open();
  }
  function dropFilms() { video.removeAttribute('src'); video.load(); }
  function showNote(text) {
    noteEl.textContent = text;
    noteEl.classList.add('on');
    clearTimeout(noteTimer);
    noteTimer = setTimeout(clearNote, 4500);
  }
  function clearNote() {
    clearTimeout(noteTimer);
    noteEl.classList.remove('on');
    noteTimer = setTimeout(() => { noteEl.textContent = ''; }, 400);
  }

  // ---- the tavern breathes: firelight and lanterns flicker, dust drifts in their light, the room follows the mouse
  // per frame only opacity and transform change, on the elements themselves: the compositor moves them
  // without repainting the big picture
  const scene = menuEl.querySelector('.tavern');
  const fireGlows = [...scene.querySelectorAll('.glow.fire')], candleGlows = [...scene.querySelectorAll('.glow.candle')];
  const lampGlows = [...scene.querySelectorAll('.glow.lamp')];
  let shownPx = NaN, shownPy = NaN;
  const motes = menuEl.querySelector('.tavern-motes');
  const ctx = motes.getContext('2d');
  let raf = 0, lastT = 0, fire = 0.85, fireTo = 0.85, lamp = 0.9, lampTo = 0.9;
  let px = 0, py = 0, pxTo = 0, pyTo = 0, dust = [];
  function startAmbience() {
    if (raf) return;
    sizeMotes();
    lastT = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stopAmbience() {
    cancelAnimationFrame(raf); raf = 0;
    ctx.clearRect(0, 0, motes.width, motes.height);
  }
  function sizeMotes() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    motes.width = Math.round(innerWidth * dpr); motes.height = Math.round(innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round(Math.min(70, innerWidth * innerHeight / 26000));
    dust = Array.from({ length: n }, () => newMote(Math.random() * innerHeight));
  }
  function newMote(y) {
    return {
      x: Math.random() * innerWidth, y, r: 0.5 + Math.random() * 1.4,
      vx: (Math.random() - 0.5) * 6, vy: -(2 + Math.random() * 7),
      a: 0.08 + Math.random() * 0.3, ph: Math.random() * 6.28, sp: 0.4 + Math.random() * 1.2,
    };
  }
  function frame(t) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (t - lastT) / 1000); lastT = t;
    const still = calm.matches;
    // firelight: a new brightness now and then, approached quickly; the lanterns slower and steadier
    if (!still) {
      if (Math.random() < dt * 9) fireTo = 0.6 + Math.random() * 0.4;
      if (Math.random() < dt * 3) lampTo = 0.8 + Math.random() * 0.2;
    }
    fire += (fireTo - fire) * Math.min(1, dt * 14);
    lamp += (lampTo - lamp) * Math.min(1, dt * 5);
    px += (pxTo - px) * Math.min(1, dt * 3); py += (pyTo - py) * Math.min(1, dt * 3);
    for (const g of fireGlows) g.style.opacity = fire.toFixed(3);
    for (const g of candleGlows) g.style.opacity = (fire * 0.8 + 0.1).toFixed(3);
    for (const g of lampGlows) g.style.opacity = lamp.toFixed(3);
    if (Math.abs(px - shownPx) > 0.05 || Math.abs(py - shownPy) > 0.05) {
      shownPx = px; shownPy = py;
      scene.style.transform = `translate(-50%, -50%) translate(${px.toFixed(2)}px, ${py.toFixed(2)}px) scale(1.045)`;
    }
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (still) return;
    const time = t / 1000;
    for (const m of dust) {
      m.x += (m.vx + Math.sin(time * m.sp + m.ph) * 5) * dt;
      m.y += m.vy * dt;
      if (m.y < -4 || m.x < -4 || m.x > innerWidth + 4) Object.assign(m, newMote(innerHeight + 4));
      const alpha = m.a * (0.6 + 0.4 * Math.sin(time * m.sp * 2 + m.ph));
      ctx.fillStyle = `rgba(255, 214, 150, ${alpha.toFixed(3)})`;
      ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, 6.2832); ctx.fill();
    }
  }
  menuEl.addEventListener('pointermove', (ev) => {
    if (ev.pointerType !== 'mouse' || calm.matches) return;
    pxTo = (ev.clientX / innerWidth - 0.5) * -22;
    pyTo = (ev.clientY / innerHeight - 0.5) * -14;
  });
  menuEl.addEventListener('pointerleave', () => { pxTo = 0; pyTo = 0; });
  window.addEventListener('resize', () => { if (raf) sizeMotes(); });
})();
