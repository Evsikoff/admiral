// The briefing runs before the 3D modules load, just like the two opening films.
window.AdmiralRules = (function () {
  const data = /*__RULES_DATA__*/ null;
  const $ = (id) => document.getElementById(`rules-${id}`);
  const dialog = $('film'), audio = $('audio'), nav = $('chapters');
  const chapterLabel = $('chapter'), title = $('title'), example = $('example'), caption = $('caption');
  const sound = $('sound'), play = $('play'), previous = $('prev'), next = $('next');
  const draw = createRulesChart($('chart'), data);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let end = 0, index = 0;
  const chapters = data.script.map((entry) => ({
    ...entry,
    start: end,
    cues: entry.cues.map((text) => {
      const start = end;
      end = data.ends[index] ?? start + Math.max(4, text.length / 15);
      return { text, start, end, voiced: data.voiced[index++] !== false };
    }),
    end,
  }));
  const duration = end;
  const buttons = chapters.map((chapter, i) => {
    const button = document.createElement('button');
    const number = document.createElement('span'), name = document.createElement('span');
    button.type = 'button';
    button.title = chapter.title;
    button.setAttribute('aria-label', chapter.short);
    number.className = 'rules-chapter-number';
    number.textContent = i + 1;
    name.className = 'rules-chapter-name';
    name.textContent = chapter.short;
    button.append(number, name);
    button.addEventListener('click', () => jump(i));
    nav.append(button);
    return button;
  });
  let chapter = -1, cue = -1, time = 0, running = false, muted = false;
  let clockOnly = false, clockStart = 0, lastAdvance = 0, raf = 0, attempt = 0, onClose = null;

  function syncControls() {
    const hasVoice = Boolean(data.audio && !audio.error);
    const audible = hasVoice && !clockOnly && !muted;
    sound.disabled = !hasVoice;
    sound.setAttribute('aria-pressed', String(audible));
    sound.querySelector('span').textContent = !hasVoice ? 'Без озвучки' : audible ? 'Звук' : 'Без звука';
    play.textContent = running ? 'Пауза' : time >= duration ? 'Сначала' : 'Продолжить';
    previous.disabled = chapter === 0;
    next.disabled = chapter >= chapters.length - 1;
    const item = chapters[chapter]?.cues[cue];
    caption.textContent = audible && item?.voiced ? '' : item?.text ?? '';
  }
  function display() {
    const ch = chapters.findIndex((entry, i) => time < entry.end || i === chapters.length - 1);
    const entry = chapters[ch];
    const line = entry.cues.findIndex((item, i) => time < item.end || i === entry.cues.length - 1);
    if (ch !== chapter) {
      dialog.dataset.scene = entry.id;
      chapterLabel.textContent = `${ch + 1} / ${chapters.length} · ${entry.short}`;
      title.textContent = entry.title;
      buttons.forEach((button, i) => {
        if (ch === i) button.setAttribute('aria-current', 'step');
        else button.removeAttribute('aria-current');
        button.style.setProperty('--chapter-fill', i < ch ? '100%' : '0%');
      });
    }
    if (ch !== chapter || line !== cue) {
      chapter = ch;
      cue = line;
      example.textContent = data.examples[entry.id][cue];
      syncControls();
    }
    const fraction = (time - entry.start) / (entry.end - entry.start);
    buttons[ch].style.setProperty('--chapter-fill', `${fraction * 100}%`);
    const item = entry.cues[line];
    const progress = reduceMotion.matches ? 1 : (time - item.start) / (item.end - item.start);
    dialog.style.setProperty('--rules-drift', time / duration);
    draw(entry.id, line, progress);
  }
  function useClock() {
    audio.pause();
    clockOnly = true;
    clockStart = performance.now() - time * 1000;
    syncControls();
  }
  function playAudio() {
    const request = ++attempt;
    audio.play().catch(() => {
      if (running && request === attempt) useClock();
    });
  }
  function tick(now) {
    if (!running) return;
    if (clockOnly) time = Math.min(duration, (now - clockStart) / 1000);
    else if (audio.currentTime !== time) {
      time = Math.min(duration, audio.currentTime);
      lastAdvance = now;
    } else if (document.hidden) lastAdvance = now;
    else if (now - lastAdvance > 4500) useClock();
    if (time >= duration || (!clockOnly && audio.ended)) {
      time = duration;
      pause();
    }
    display();
    if (running) raf = requestAnimationFrame(tick);
  }
  function start() {
    if (running) return;
    running = true;
    lastAdvance = performance.now();
    clockStart = lastAdvance - time * 1000;
    if (!clockOnly) playAudio();
    syncControls();
    raf = requestAnimationFrame(tick);
  }
  function pause() {
    running = false;
    attempt++;
    audio.pause();
    cancelAnimationFrame(raf);
    syncControls();
  }
  function jump(i) {
    if (!chapters[i]) return;
    const wasRunning = running || time >= duration;
    time = chapters[i].start;
    if (data.audio && !audio.error) audio.currentTime = time;
    lastAdvance = performance.now();
    clockStart = lastAdvance - time * 1000;
    display();
    if (wasRunning) start();
  }
  function open({ silent, closed }) {
    if (dialog.open) return;
    time = 0;
    chapter = cue = -1;
    muted = silent;
    onClose = closed;
    if (data.audio && !audio.getAttribute('src')) audio.src = window.AdmiralAssets?.url(data.audio) || data.audio;
    if (data.audio && !audio.error) audio.currentTime = 0;
    audio.muted = muted;
    clockOnly = !data.audio || Boolean(audio.error);
    dialog.showModal();
    dialog.scrollTop = 0;
    display();
    start();
  }
  $('close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    pause();
    onClose?.();
    onClose = null;
  });
  sound.addEventListener('click', () => {
    muted = clockOnly ? false : !muted;
    audio.muted = muted;
    if (clockOnly && data.audio && !audio.error) {
      audio.currentTime = time;
      clockOnly = false;
      lastAdvance = performance.now();
      if (running) playAudio();
    }
    syncControls();
  });
  audio.addEventListener('error', () => { if (dialog.open) useClock(); });
  function togglePlayback() {
    if (running) pause();
    else if (time >= duration) jump(0);
    else start();
  }
  play.addEventListener('click', togglePlayback);
  previous.addEventListener('click', () => jump(chapter - 1));
  next.addEventListener('click', () => jump(chapter + 1));
  dialog.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowLeft') jump(chapter - 1);
    else if (event.key === 'ArrowRight') jump(chapter + 1);
    else if (event.code === 'Space' && !event.target.closest('button')) togglePlayback();
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  return { open };
})();
