"use strict";

const $ = (selector, scope = document) => scope.querySelector(selector);
const audio = $("#audio");
const content = $("#content");
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, ch =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const iconPaths = {
  anchor: '<circle cx="12" cy="5" r="2.5"/><path d="M12 7.5v13M8.5 10h7M3 13v4l2-1c1.7 3.2 4.1 4.5 7 5 2.9-.5 5.3-1.8 7-5l2 1v-4"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.8"/><path d="m16 16 4.5 4.5"/>',
  stack: '<path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  library: '<path d="M3 5v15M7 5v15M12 7v13m3-15 5 14"/>',
  sliders: '<path d="M4 7h6m4 0h6M4 17h10m4 0h2"/><circle cx="12" cy="7" r="2"/><circle cx="16" cy="17" r="2"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  wave: '<path d="M3 10v4m4-8v12m5-15v18m5-14v10m4-7v4"/>',
  start: '<path d="M5 21V4m1 1c5-4 8 3 14-1v9c-6 4-9-3-14 1"/>',
  dice: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M8 8h.02M12 12h.02M16 16h.02" stroke-width="3"/>',
  ship: '<path d="M12 3v13M5 13l5-8v8H5Zm9-8 5 8h-5V5ZM3 16l9 2 9-2-3 5H6l-3-5Z"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m16.5 7.5-3 6-6 3 3-6 6-3Z"/>',
  mic: '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5.5 11.5v.5a6.5 6.5 0 0 0 13 0v-.5M12 18.5V22m-4 0h8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="M7 4.5 20 12 7 19.5V4.5Z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 5v14m10-14v14" stroke-width="4"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  edit: '<path d="m5 15 10-10 4 4L9 19l-5 1 1-5Zm8-8 4 4"/>',
  refresh: '<path d="M20 6v5h-5M4 18v-5h5"/><path d="M5.4 8A7.5 7.5 0 0 1 18 6l2 3M4 15l2 3a7.5 7.5 0 0 0 12.6-2"/>',
  volume: '<path d="M3 9h4l5-4v14l-5-4H3V9Zm12-1c2.4 2.2 2.4 5.8 0 8m3-11c3.9 3.8 3.9 10.2 0 14"/>',
};
function icon(name, extra = "") {
  return `<svg class="ico ${extra}" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${iconPaths[name] || ""}</svg>`;
}
document.querySelectorAll("[data-icon]").forEach(el => { el.innerHTML = icon(el.dataset.icon); });

const descriptions = {
  style: "Стиль исполнения", profile: "Образ комментатора", scene: "Сцена",
  performance: "Манера исполнения", context: "Контекст", mood: "Настроение события",
};
const stateLabels = {
  ready: ["check", "Озвучена"], stale: ["refresh", "Нужна переозвучка"],
  missing: ["mic", "Без озвучки"], dirty: ["edit", "Есть правки"],
};
let catalog, eventId, nationId, activeId, settingsOpen = false, profileMode = false;
let pending = null, noticeTimer, playingUrl = "", playAttempt = 0, renderCount = 0, waveContext;
const drafts = new Map(), profileDrafts = new Map(), closedGroups = new Set(), waveCache = new Map();
const searchBox = $("#search");
const eventList = $("#event-list");
const currentEvent = () => catalog.events.find(item => item.id === eventId);
const currentNation = () => catalog.nations.find(item => item.id === nationId);
const rowsFor = (ev, na) => catalog.lines.filter(item => item.event === ev && (!na || item.nation === na));
const newId = () => `new-${eventId}-${nationId}`;
const newRow = () => ({ id: newId(), event: eventId, nation: nationId, text:"", overrides:{}, status:"missing",
  variant: Math.max(0, ...rowsFor(eventId, nationId).map(line => line.variant)) + 1 });
const currentLine = () => catalog.lines.find(item => item.id === activeId) || newRow();
const draftFor = line => drafts.get(line.id) || {text: line.text, overrides: {...line.overrides}};
const profileFor = nation => profileDrafts.get(nation.id) || {...nation.settings};
const sameSettings = (a, b) => Object.keys({...a, ...b}).every(k => a[k] === b[k]);
const dirtyLine = line => drafts.has(line.id) && (line.id.startsWith("new-") || line.text !== draftFor(line).text || !sameSettings(line.overrides, draftFor(line).overrides));
const dirtyProfile = nation => !sameSettings(nation.settings, profileFor(nation));
const hasChanges = () => (catalog?.lines.some(dirtyLine) || [...drafts].some(([id, d]) => id.startsWith("new-") && (d.text.trim() || Object.keys(d.overrides).length)) || catalog?.nations.some(dirtyProfile));
const modelName = value => value === "gemini-3.8-flash-tts" ? "Gemini 3.8 Flash TTS" : value === "gemini-3.1-flash-tts-preview" ? "Gemini 3.1 Flash TTS" : value;
const normal = value => String(value ?? "").toLocaleLowerCase("ru").replace(/ё/g,"е");
const plural = (n, one, few, many) => n % 10 === 1 && n % 100 !== 11 ? one : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) ? few : many;
const lineCount = n => `${n} ${plural(n, "реплика", "реплики", "реплик")}`;
const statusLabel = status => { const [i, label] = stateLabels[status] || stateLabels.missing; return `<span class="status s-${escapeHtml(status)}">${icon(i)}${label}</span>`; };
function eventIcon(id) {
  if (id.startsWith("turn") || id === "game_start" || id === "victory") return "start";
  if (/^(roll|double|foul|unspent|no_move|opt)/.test(id)) return "dice";
  if (id.startsWith("chase")) return "compass";
  return "ship";
}
function matchesEvent(ev, query) {
  return normal([ev.name, ev.id, ev.group].join(" ")).includes(query);
}
function matchesLine(line, query) {
  const nation = catalog.nations.find(n => n.id === line.nation);
  return normal([line.text, line.id, nation.name, nation.persona].join(" ")).includes(query);
}
function renderNav() {
  const query = normal(searchBox.value.trim());
  const groups = new Map();
  let total = 0;
  catalog.events.forEach(ev => {
    if (query && !matchesEvent(ev, query) && !rowsFor(ev.id).some(line => matchesLine(line, query))) return;
    if (!groups.has(ev.group)) groups.set(ev.group, []);
    groups.get(ev.group).push(ev);
    total++;
  });
  $("#event-count").textContent = total;
  eventList.innerHTML = [...groups].map(([group, events]) =>
    `<details class="event-group" ${query || !closedGroups.has(group) ? "open" : ""}><summary data-group="${escapeHtml(group)}">${escapeHtml(group)}${icon("chevron")}</summary>` +
    events.map(ev => `<button class="event" data-event="${escapeHtml(ev.id)}" aria-current="${ev.id === eventId && !profileMode}">${icon(eventIcon(ev.id))}<span>${escapeHtml(ev.name)}</span></button>`).join("") + "</details>"
  ).join("") || '<p class="no-events">Совпадений нет. Попробуйте другое слово или код события.</p>';
}
function setSidebar(open) {
  document.body.classList.toggle("nav-open", open);
  $("#shade").hidden = !open;
  const mobile = matchMedia("(max-width: 840px)").matches;
  $("#sidebar").inert = mobile && !open;
  $("#workspace").inert = mobile && open;
  if (open) searchBox.focus();
  else if (mobile) $("#open-sidebar").focus();
}
function chooseEvent(id) {
  stopAudio();
  eventId = id;
  profileMode = false;
  const query = normal(searchBox.value.trim());
  const match = query && !matchesEvent(currentEvent(), query) && rowsFor(id).find(line => matchesLine(line, query));
  if (match) nationId = match.nation;
  activeId = match?.id || rowsFor(id, nationId)[0]?.id || null;
  settingsOpen = false;
  setSidebar(false);
  render();
  window.scrollTo(0, 0);
}
function tabButtons() {
  return `<div class="nation-bar" role="group" aria-label="Игровая нация">${catalog.nations.map(nation =>
    `<button class="nation-btn" data-nation="${escapeHtml(nation.id)}" aria-pressed="${nation.id === nationId}"><span class="flag flag-${escapeHtml(nation.id)}" aria-hidden="true"></span>${escapeHtml(nation.name)}</button>`).join("")}</div>`;
}
function hero() {
  const evt = currentEvent(), total = rowsFor(eventId).length, fleets = catalog.nations.length;
  return `<header class="hero"><div class="hero-info"><div class="hero-code">${icon(profileMode ? "mic" : eventIcon(evt.id))}${escapeHtml(profileMode ? "Gemini TTS" : evt.id)}</div>
    <h1>${escapeHtml(profileMode ? "Голоса наций" : evt.name)}</h1><p>${profileMode ? "Профили комментаторов и актёрские задания" : `${lineCount(total)} · ${fleets} ${plural(fleets, "нация", "нации", "наций")}`}</p></div></header>`;
}
function selectField(key, list, local, base) {
  const options = [];
  if (base) options.push(["", `Из профиля · ${key === "model" ? modelName(base[key]) : base[key]}`]);
  const values = [...new Set([...list, local[key], base?.[key]].filter(Boolean))];
  values.forEach(value => options.push([value, key === "model" ? modelName(value) : value]));
  return `<div class="setting"><label for="field-${key}">${key === "model" ? "Модель" : "Голос"}</label><select id="field-${key}" data-setting="${key}" ${pending ? "disabled" : ""}>
    ${options.map(([value, name]) => `<option value="${escapeHtml(value)}" ${(local[key] || "") === value ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}</select></div>`;
}
function directionField(key, local, base) {
  const inherited = base && !(key in local);
  const fixed = base ? `<label class="override"><input type="checkbox" data-override="${key}" ${inherited ? "" : "checked"} ${pending ? "disabled" : ""}>Своё задание</label>` : "";
  return `<div class="setting setting-wide"><div class="setting-head"><label for="field-${key}">${descriptions[key]}</label>${fixed}</div>
    <textarea id="field-${key}" data-setting="${key}" rows="${key === "performance" ? 3 : 2}" ${inherited || pending ? "readonly" : ""}>${escapeHtml(local[key] ?? base?.[key])}</textarea></div>`;
}
function voiceSettings(local, base = null) {
  const model = local.model || base?.model;
  const directionKeys = model.includes("3.8") ? ["style"] : ["profile","scene","performance","context"];
  return `<div class="settings"><div class="settings-grid">${selectField("model", catalog.models, local, base)}${selectField("voice", catalog.voices, local, base)}</div>
    <h3>Актёрское задание</h3><div class="settings-grid">${directionKeys.map(key => directionField(key, local, base)).join("")}
    ${base ? directionField("mood", local, {mood:currentEvent().mood || ""}) : ""}</div></div>`;
}
function player(line) {
  if (!line.audioUrl || line.status === "missing") return "";
  return `<div class="player"><button class="play" data-play="${escapeHtml(line.id)}" aria-label="Воспроизвести реплику">${icon("play")}</button>
    <label class="seek"><canvas aria-hidden="true"></canvas><input id="seek" type="range" min="0" max="${Number(line.seconds) || 0}" step="0.01" value="0" aria-label="Позиция воспроизведения"></label><span class="timing"></span></div>`;
}
function lineCard(line) {
  const active = line.id === activeId, isNew = line.id.startsWith("new-"), draft = draftFor(line);
  const variant = String(line.variant).padStart(2, "0");
  const clipAction = line.status === "missing" ? "Озвучить" : "Переозвучить";
  const working = pending?.id === line.id && pending.action === "generate";
  const lineLabel = isNew ? "Новая реплика" : `Реплика ${variant}`;
  return `<article class="card ${active ? "active" : ""}" data-line="${escapeHtml(line.id)}"><div class="card-bar">
    <button class="variant-toggle" data-open="${escapeHtml(line.id)}" aria-expanded="${active}">${icon("wave")}<span class="variant-num">${lineLabel}</span>${active ? "" : `<span class="variant-snippet">${escapeHtml(draft.text)}</span>`}</button>
    <span class="card-status">${statusLabel(dirtyLine(line) && !isNew ? "dirty" : line.status)}</span>
    ${!active && line.audioUrl ? `<button class="icon-button" data-play="${escapeHtml(line.id)}" aria-label="Воспроизвести реплику ${variant}">${icon("play")}</button>` : ""}</div>
    ${active ? `<div class="card-body"><label class="field-title" for="transcript">Текст реплики</label>
      <textarea class="transcript" id="transcript" rows="2" placeholder="Введите текст, который произнесёт комментатор…" ${pending ? "readonly" : ""}>${escapeHtml(draft.text)}</textarea>
      ${player(line)}
      <div class="card-actions"><button class="button button-quiet settings-toggle" data-act="settings" aria-expanded="${settingsOpen}">${icon("sliders")}Настройки озвучки</button>
      ${isNew ? '<button class="button button-quiet" data-act="cancel-new">Отмена</button>' : ""}
      <button class="button button-outline" data-act="save">Сохранить</button>
      <button class="button button-primary" data-act="generate">${icon(working ? "refresh" : "mic", working ? "spin" : "")}<span>${working ? "Озвучивание…" : clipAction}</span></button></div>
      ${settingsOpen ? voiceSettings(draft.overrides, currentNation().settings) : ""}</div>` : ""}</article>`;
}
function profiles() {
  const nation = currentNation();
  return `<div class="section-head"><div><h2>${escapeHtml(nation.persona)}</h2><p>Настройки для реплик нации «${escapeHtml(nation.name)}»</p></div></div>
    <section class="card profile-body">${voiceSettings(profileFor(nation))}<div class="profile-actions"><button class="button button-quiet" data-act="undo-profile">Сбросить правки</button>
    <button class="button button-primary" data-act="save-profile">Сохранить профиль</button></div></section>`;
}
function render(updateNav = true) {
  if (!catalog) return;
  const nation = currentNation(), ev = currentEvent();
  if (updateNav) renderNav();
  $("#crumb-current").textContent = profileMode ? "Голоса наций" : ev.group;
  $("#mode").innerHTML = icon(profileMode ? "stack" : "sliders") + (profileMode ? "К репликам" : "Голоса наций");
  $("#mode").disabled = false;
  $("#library-info").innerHTML = icon("library") + `<span>${lineCount(catalog.lines.length)} в каталоге</span>`;
  const lines = rowsFor(eventId, nationId);
  if (drafts.has(newId())) lines.push(newRow());
  const title = `<div class="section-head"><div><h2>Реплики комментатора</h2><p>${escapeHtml(nation.persona)} · ${escapeHtml(nation.name)}</p></div><button class="button button-outline" data-act="add">${icon("plus")}Добавить реплику</button></div>`;
  if (activeId == null && lines.length) activeId = lines[0].id;
  content.innerHTML = hero() + tabButtons() + (profileMode ? profiles() : title + `<div class="cards">${lines.map(lineCard).join("") || '<div class="card empty">Для этой нации ещё нет реплик.</div>'}</div>`);
  content.setAttribute("aria-busy","false");
  syncControls();
  updatePlayback();
  const ticket = ++renderCount;
  if (!profileMode && $("#seek") && currentLine().audioUrl) showWaveform(currentLine().audioUrl, ticket);
}
function syncControls() {
  if (!catalog) return;
  if (profileMode) {
    const changed = dirtyProfile(currentNation());
    $('[data-act="save-profile"]').disabled = !changed || !!pending;
    $('[data-act="undo-profile"]').disabled = !changed || !!pending;
    return;
  }
  const line = currentLine(), changed = dirtyLine(line), draft = draftFor(line), isNew = line.id.startsWith("new-");
  const save = $('[data-act="save"]'), generate = $('[data-act="generate"]');
  if (save && generate) {
    save.disabled = !changed || !draft.text.trim() || !!pending;
    const working = pending?.id === line.id && pending.action === "generate";
    generate.disabled = !draft.text.trim() || !!pending;
    if (!working) $("span", generate).textContent = changed && draft.text.trim() ? "Сохранить и озвучить" : line.status === "missing" ? "Озвучить" : "Переозвучить";
    $(".card.active .card-status").innerHTML = statusLabel(changed && !isNew ? "dirty" : line.status);
  }
  for (const btn of content.querySelectorAll('[data-act="add"], [data-act="cancel-new"]')) btn.disabled = !!pending;
}
function notice(message, error = false, refresh = false) {
  clearTimeout(noticeTimer);
  const el = $("#notice");
  el.hidden = false;
  el.classList.toggle("error", error);
  el.innerHTML = `<span>${escapeHtml(message)}</span>${refresh ? '<button data-reload>Обновить</button>' : ""}<button aria-label="Закрыть сообщение" data-dismiss>×</button>`;
  if (!error) noticeTimer = setTimeout(() => { el.hidden = true; }, 4600);
}
async function request(path, body) {
  const response = await fetch(path, body ? {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)} : {cache:"no-store"});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error || `Ошибка сервера (${response.status}).`);
    err.status = response.status;
    throw err;
  }
  return data;
}
async function load() {
  try {
    catalog = await request("/api/catalog");
    if (!catalog.events.some(ev => ev.id === eventId)) eventId = catalog.events[0].id;
    if (!catalog.nations.some(n => n.id === nationId)) nationId = catalog.nations[0].id;
    if (!catalog.lines.some(line => line.id === activeId) && activeId !== newId()) activeId = rowsFor(eventId,nationId)[0]?.id || null;
    $("#notice").hidden = true;
    render();
  } catch (error) {
    content.setAttribute("aria-busy","false");
    if (!catalog) content.innerHTML = '<p>Не удалось загрузить каталог реплик.</p><button class="button button-outline" data-act="reload">Повторить</button>';
    notice(error.message, true, true);
  }
}
async function commit(action) {
  if (pending) return;
  const line = currentLine(), nation = currentNation();
  const isNew = line.id.startsWith("new-");
  const draft = draftFor(line);
  let id = line.id;
  pending = {id, action};
  render(false);
  try {
    if (action === "save-profile") {
      catalog = await request("/api/nation", {revision:catalog.revision, nation:nation.id, settings:profileFor(nation)});
      profileDrafts.delete(nation.id);
      notice("Профиль комментатора сохранён.");
    } else {
      if (isNew || dirtyLine(line)) {
        const updated = await request("/api/line", {revision:catalog.revision, event:line.event, nation:line.nation, id:isNew ? null : id, text:draft.text, overrides:draft.overrides});
        catalog = updated;
        if (isNew) id = updated.selectedId || rowsFor(line.event, line.nation).at(-1).id;
        drafts.delete(line.id);
        if (activeId === line.id) activeId = id;
      }
      if (action === "generate") {
        pending.id = id;
        render(false);
        catalog = await request("/api/generate", {revision:catalog.revision, event:line.event, nation:line.nation, id});
        stopAudio();
        notice("Новая озвучка сохранена. Можно прослушать реплику.");
      } else {
        notice("Реплика сохранена.");
      }
    }
  } catch (error) {
    notice(error.status === 409 ? `${error.message} Обновите каталог и проверьте свои правки.` : error.message, true, error.status === 409);
  } finally {
    pending = null;
    render();
  }
}

function formatTime(seconds) {
  const ticks = Math.max(0, Math.floor(Number(seconds) || 0));
  return Math.floor(ticks / 60) + ":" + String(ticks % 60).padStart(2, "0");
}
function stopAudio() {
  playAttempt++;
  audio.pause();
  audio.removeAttribute("src");
  playingUrl = "";
  audio.load();
}
async function play(line, seekTo) {
  if (!line?.audioUrl) return;
  const url = line.audioUrl, toggle = typeof seekTo !== "number";
  if (playingUrl === url && !audio.paused && toggle) {
    audio.pause();
    return;
  }
  const attempt = ++playAttempt;
  if (playingUrl !== url) {
    audio.pause();
    playingUrl = url;
    audio.src = url;
  }
  if (!toggle) {
    const setTime = () => { if (playingUrl === url && attempt === playAttempt) { audio.currentTime = Math.min(seekTo, Number.isFinite(audio.duration) ? audio.duration : seekTo); updatePlayback(); } };
    if (audio.readyState) setTime();
    else audio.addEventListener("loadedmetadata", setTime, {once:true});
    return;
  }
  if (audio.ended) audio.currentTime = 0;
  try { await audio.play(); }
  catch (error) { if (attempt === playAttempt && error.name !== "AbortError") notice("Не удалось воспроизвести запись. Проверьте аудиофайл.", true); }
  updatePlayback();
}
function updatePlayback() {
  if (!catalog) return;
  content.querySelectorAll("[data-play]").forEach(button => {
    const line = catalog.lines.find(it => it.id === button.dataset.play);
    const playing = line?.audioUrl === playingUrl && !audio.paused;
    const label = (playing ? "Приостановить" : "Воспроизвести") + " реплику " + (line?.variant ?? "");
    if (button.getAttribute("aria-label") !== label) {
      button.innerHTML = icon(playing ? "pause" : "play");
      button.setAttribute("aria-label",label);
      button.title = label;
    }
  });
  const slider = $("#seek");
  if (!slider) return;
  const line = currentLine();
  const selected = line.audioUrl === playingUrl;
  const duration = (selected && Number.isFinite(audio.duration) ? audio.duration : line.seconds) || 0;
  const now = selected ? audio.currentTime : 0;
  slider.max = duration;
  slider.value = now;
  const time = formatTime(now) + " / " + formatTime(duration);
  slider.setAttribute("aria-valuetext",time);
  $(".timing").textContent = time;
  const wave = waveCache.get(line.audioUrl);
  if (Array.isArray(wave)) drawWave(wave, duration ? now / duration : 0);
}
// Draw only decoded samples from the selected recording. The native slider is
// always usable, including while its waveform is being decoded.
async function showWaveform(url, ticket) {
  try {
    let wave = waveCache.get(url);
    if (!wave) {
      wave = (async () => {
        waveContext ||= new OfflineAudioContext(1,1,24000);
        const res = await fetch(url);
        if (!res.ok) throw new Error("audio");
        const buf = await waveContext.decodeAudioData(await res.arrayBuffer());
        const samples = buf.getChannelData(0), bins = 320;
        const peaks = Array.from({length:bins}, (_, i) => {
          let maximum = 0;
          const until = Math.floor((i+1) * samples.length / bins);
          for (let j = Math.floor(i * samples.length / bins); j < until; j += 3) maximum = Math.max(maximum, Math.abs(samples[j]));
          return maximum;
        });
        const top = Math.max(...peaks, .01);
        return peaks.map(n => n / top);
      })();
      waveCache.set(url,wave);
    }
    const peaks = await wave;
    waveCache.set(url,peaks);
    if (ticket === renderCount && $("#seek") && currentLine().audioUrl === url) updatePlayback();
  } catch { waveCache.delete(url); }
}
function drawWave(peaks, position) {
  const canvas = $(".seek canvas");
  if (!canvas) return;
  const width = Math.round(canvas.clientWidth), height = 30;
  if (!width) return;
  const ratio = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== height * ratio) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio,0,0,ratio,0,0);
  ctx.clearRect(0,0,width,height);
  const bars = Math.max(1, Math.floor(width / 4));
  for (let i=0; i<bars; i++) {
    const start = Math.floor(i * peaks.length / bars);
    const end = Math.max(start + 1, Math.floor((i+1) * peaks.length / bars));
    const amplitude = Math.max(...peaks.slice(start,end));
    const barHeight = Math.max(2, Math.sqrt(amplitude) * (height-3));
    ctx.fillStyle = i / bars <= position ? "#226e64" : "#91b1a3";
    ctx.fillRect(i * width / bars, (height-barHeight)/2, 2.5, barHeight);
  }
  canvas.parentElement.classList.add("has-wave");
}
function editSetting(key, value, remove = false) {
  if (profileMode) {
    const nation = currentNation();
    const settings = profileFor(nation);
    settings[key] = value;
    profileDrafts.set(nation.id,settings);
  } else {
    const line = currentLine();
    const draft = draftFor(line);
    if (remove) delete draft.overrides[key];
    else draft.overrides[key] = value;
    drafts.set(line.id,draft);
  }
  syncControls();
}
content.addEventListener("input", e => {
  if (e.target.id === "seek") { play(currentLine(), Number(e.target.value)); return; }
  if (pending) return;
  if (e.target.id === "transcript") {
    const line = currentLine(), draft = draftFor(line);
    draft.text = e.target.value;
    drafts.set(line.id,draft);
    syncControls();
  } else if (e.target.matches("textarea[data-setting]") && !e.target.readOnly) {
    editSetting(e.target.dataset.setting,e.target.value);
  }
});
content.addEventListener("change", e => {
  if (pending) return;
  if (e.target.matches("[data-override]")) {
    const key = e.target.dataset.override;
    const base = key === "mood" ? currentEvent().mood : currentNation().settings[key];
    editSetting(key,base ?? "",!e.target.checked);
    render(false);
    const box = $(`[data-override="${key}"]`);
    if (box?.checked) $(`#field-${key}`).focus();
    else box?.focus();
  } else if (e.target.matches("select[data-setting]")) {
    const key = e.target.dataset.setting;
    editSetting(key, e.target.value, !profileMode && !e.target.value);
    if (key === "model") { render(false); $("#field-model").focus(); }
  }
});
content.addEventListener("click", e => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const {nation, open, act} = btn.dataset;
  if (act === "reload") { load(); return; }
  if (!catalog) return;
  if (nation && nation !== nationId) {
    stopAudio();
    nationId = nation;
    activeId = rowsFor(eventId,nationId)[0]?.id || null;
    settingsOpen = false;
    render(false);
    $(`[data-nation="${nation}"]`).focus({preventScroll:true});
  } else if (open) {
    if (activeId !== open) {
      stopAudio();
      activeId = open;
      settingsOpen = false;
    } else {
      stopAudio();
      activeId = "";
    }
    render(false);
  } else if (btn.dataset.play) {
    play(catalog.lines.find(line => line.id === btn.dataset.play));
  } else if (act === "settings") {
    settingsOpen = !settingsOpen;
    render(false);
    $('[data-act="settings"]').focus({preventScroll:true});
  } else if (act === "add" && !pending) {
    stopAudio();
    const key = newId();
    if (!drafts.has(key)) drafts.set(key,{text:"",overrides:{}});
    activeId = key;
    settingsOpen = false;
    render(false);
    $("#transcript").focus();
  } else if (act === "cancel-new" && !pending) {
    drafts.delete(newId());
    activeId = rowsFor(eventId,nationId)[0]?.id || null;
    render(false);
  } else if (act === "undo-profile" && !pending) {
    profileDrafts.delete(nationId);
    render(false);
  } else if (["save","generate","save-profile"].includes(act)) {
    commit(act);
  }
});
searchBox.addEventListener("input", () => { if (catalog) renderNav(); });
eventList.addEventListener("click", e => {
  const summary = e.target.closest("summary");
  if (summary && !searchBox.value.trim()) {
    const group = summary.dataset.group;
    if (summary.parentElement.open) closedGroups.add(group);
    else closedGroups.delete(group);
  }
  const button = e.target.closest("[data-event]");
  if (button) chooseEvent(button.dataset.event);
});
$("#open-sidebar").addEventListener("click", () => setSidebar(true));
$("#close-sidebar").addEventListener("click", () => setSidebar(false));
$("#shade").addEventListener("click", () => setSidebar(false));
$("#mode").addEventListener("click", () => {
  stopAudio();
  profileMode = !profileMode;
  render();
  window.scrollTo(0,0);
});
$("#notice").addEventListener("click", e => {
  if (e.target.closest("[data-reload]")) { if (!pending) load(); }
  else if (e.target.closest("[data-dismiss]")) $("#notice").hidden = true;
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && document.body.classList.contains("nav-open")) { setSidebar(false); return; }
  if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.target.closest("input,textarea,select")) {
    e.preventDefault();
    if (matchMedia("(max-width: 840px)").matches) setSidebar(true);
    else searchBox.focus();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && catalog) {
    e.preventDefault();
    const save = $(profileMode ? '[data-act="save-profile"]' : '[data-act="save"]');
    if (save && !save.disabled) save.click();
  }
});
window.addEventListener("beforeunload", e => { if (hasChanges() || pending) { e.preventDefault(); e.returnValue = ""; } });
window.addEventListener("resize",updatePlayback);
const narrow = matchMedia("(max-width: 840px)");
$("#sidebar").inert = narrow.matches;
narrow.addEventListener("change", () => setSidebar(false));
["play","pause","timeupdate","ended","loadedmetadata","seeked"].forEach(name => audio.addEventListener(name,updatePlayback));
load();
