// The menu can open before the 3D game and its sound director are ready.
window.AdmiralAudioControls = (() => {
  const key = 'admiral.audio.v1';
  const channels = [
    ['music', 'Музыка', 'музыку'],
    ['effects', 'Эффекты', 'звуковые эффекты'],
    ['commentator', 'Комментатор', 'комментатора'],
  ];
  let saved;
  try { saved = JSON.parse(localStorage.getItem(key)); } catch { /* storage unavailable */ }
  const muted = {}, levels = {};
  const panel = document.getElementById('audio-panel');
  const triggers = [...document.querySelectorAll('button[data-audio]')];
  const menuButton = document.querySelector('.menu-snd');
  const rows = new Map();
  let opener = null, director = null;

  function render() {
    for (const [kind, row] of rows) {
      const value = muted[kind] ? 0 : levels[kind];
      row.slider.value = value;
      row.slider.setAttribute('aria-valuetext', value + '%');
      row.value.textContent = value + '%';
      row.toggle.classList.toggle('is-muted', muted[kind]);
      row.toggle.title = (muted[kind] ? 'Включить ' : 'Выключить ') + row.object;
      row.toggle.setAttribute('aria-label', row.toggle.title);
      row.trigger.classList.toggle('is-muted', muted[kind]);
      row.trigger.title = row.label + ' · ' + value + '%';
      row.trigger.setAttribute('aria-label', row.trigger.title);
    }
    menuButton.classList.toggle('is-muted', Object.values(muted).every(Boolean));
  }

  function change(kind, value) {
    const wasMuted = muted[kind];
    muted[kind] = value === 0;
    if (value > 0) levels[kind] = value;
    director?.setVolume(kind, levels[kind] / 100);
    director?.setMuted(kind, muted[kind]);
    // Existing menu and online code read the three top-level mute flags.
    try { localStorage.setItem(key, JSON.stringify({ ...muted, levels })); } catch { /* storage unavailable */ }
    if (kind === 'commentator' && wasMuted !== muted[kind]) window.AdmiralOnline?.setVoice(!muted[kind]);
    render();
  }

  for (const [kind, label, object] of channels) {
    muted[kind] = saved?.[kind] === true;
    const level = saved?.levels?.[kind];
    levels[kind] = Number.isInteger(level) && level > 0 && level <= 100 ? level : 100;
    const row = document.getElementById('audio-row').content.firstElementChild.cloneNode(true);
    const slider = row.querySelector('input'), toggle = row.querySelector('button');
    slider.id = 'volume-' + kind;
    const caption = row.querySelector('label');
    caption.htmlFor = slider.id;
    caption.textContent = label;
    toggle.append(menuButton.querySelector('svg').cloneNode(true));
    slider.addEventListener('input', () => change(kind, slider.valueAsNumber));
    toggle.addEventListener('click', () => change(kind, muted[kind] ? levels[kind] : 0));
    const trigger = triggers.find(button => button.dataset.audio === kind);
    rows.set(kind, { row, label, object, trigger, slider, toggle, value: row.querySelector('.audio-value') });
    panel.append(row);
  }
  render();

  function close() {
    if (!opener) return;
    opener.setAttribute('aria-expanded', 'false');
    panel.hidden = true;
    opener = null;
  }
  for (const button of triggers) button.addEventListener('click', () => {
    const alreadyOpen = opener === button;
    close();
    if (alreadyOpen) return;
    const channel = button.dataset.audio;
    for (const [kind, { row }] of rows) row.hidden = channel !== 'all' && channel !== kind;
    button.parentElement.append(panel);
    opener = button;
    opener.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
    panel.querySelector('.audio-row:not([hidden]) input').focus({ preventScroll: true });
  });
  function dismissOutside(event) {
    if (opener && !opener.contains(event.target) && !panel.contains(event.target)) close();
  }
  document.addEventListener('pointerdown', dismissOutside, true);
  document.addEventListener('focusin', dismissOutside);
  document.addEventListener('keydown', (event) => {
    if (opener && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      const button = opener;
      close();
      button.focus();
    }
  }, true);
  window.addEventListener('admiral:menu', close);

  return {
    connect(sound) {
      director = sound;
      for (const [kind] of channels) {
        sound.setVolume(kind, levels[kind] / 100);
        sound.setMuted(kind, muted[kind]);
      }
      window.AdmiralOnline?.setVoice(!muted.commentator);
    },
  };
})();
