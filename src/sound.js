// Sound, music, and commentator director.
// Within a game, picks uniformly at random among the least-played files in each folder.
// Music has three moods: 'start' — the theme of the main menu, played until a game begins — then 'calm' and 'anxious'.
const MUSIC_MOODS = ['start', 'calm', 'anxious'];
function createSoundDirector(manifest = {}) {
  const volumes = { music: 0.3, effects: 1.0, commentator: 1.0 };
  // in the main menu the music is all there is to hear; in a game it stays under the commentator
  const moodVolume = { start: 0.55 };
  const musicLevel = () => moodVolume[mood] ?? volumes.music;
  const pools = new Map();
  for (const group of [manifest.music, manifest.effects]) {
    if (!group) continue;
    for (const [kind, urls] of Object.entries(group)) {
      pools.set(kind, urls.map((url) => ({ url, plays: 0 })));
    }
  }
  // a clip's variant comes from its file name (03.mp3 is variant 2), so the caption matches the voice
  // even while some variants of a bucket are not voiced yet
  const voicePools = new Map();
  for (const [bucket, urls] of Object.entries(manifest.commentator || {})) {
    voicePools.set(bucket, urls.map((url, i) => {
      const m = /(\d+)\.[a-z0-9]+$/i.exec(url);
      return { url, idx: m ? Number(m[1]) - 1 : i, plays: 0 };
    }));
  }

  const liveEffects = new Set(), fading = new Set(), blocked = new Set();
  const history = [], voiceHistory = [], voiceQueue = [];
  let mood = null, music = null, musicGain = 0, currentTrack = null;
  let swim = null, swimmingWanted = false, voice = null, hadGame = false;
  // switched off by the player: nothing of that kind is played (captions still pick their variants)
  const muted = { music: false, effects: false, commentator: false };
  // quiet: a game being caught up at once (an online game rejoined) makes no sound at all; captions still pick variants
  let quiet = false;

  function safePlay(a) {
    try {
      const p = a.play();
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          if (a.dataset.stopped) return;
          if (err && err.name === 'NotAllowedError') blocked.add(a);
        });
      }
    } catch { /* audio unavailable */ }
  }

  function unlock() {
    if (!blocked.size) return;
    for (const a of [...blocked]) {
      blocked.delete(a);
      if (!a.dataset.stopped) safePlay(a);
    }
  }
  for (const ev of ['pointerdown', 'keydown', 'click']) {
    window.addEventListener(ev, unlock, { capture: true, passive: true });
  }

  function stopAudio(a) {
    if (!a) return;
    a.dataset.stopped = '1';
    blocked.delete(a);
    try { a.pause(); } catch { /* ignore */ }
  }

  function pick(kind) {
    const list = pools.get(kind);
    if (!list || !list.length) return null;
    let min = Infinity;
    for (const item of list) if (item.plays < min) min = item.plays;
    const candidates = list.filter((item) => item.plays === min);
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    chosen.plays++;
    history.push({ kind, url: chosen.url, plays: chosen.plays });
    if (history.length > 300) history.shift();
    return chosen;
  }

  function playMusicTrack(kind, crossfade) {
    if (muted.music) return;
    const entry = pick(kind);
    if (!entry) return;
    const a = new Audio(entry.url);
    a.preload = 'auto';
    musicGain = crossfade ? 0.02 : musicLevel();
    a.volume = musicGain;
    a.addEventListener('ended', () => {
      if (music !== a) return;
      music = null; currentTrack = null;
      if (mood) playMusicTrack(mood, false);
    });
    a.addEventListener('error', () => {
      if (music !== a) return;
      music = null; currentTrack = null;
    });
    music = a;
    currentTrack = entry;
    safePlay(a);
  }

  function setMood(nextMood) {
    if (!MUSIC_MOODS.includes(nextMood)) return;
    if (mood === nextMood && music) return;
    const crossfade = Boolean(music);
    if (music) {
      fading.add(music);
      music = null; currentTrack = null;
    }
    mood = nextMood;
    playMusicTrack(nextMood, crossfade || nextMood === 'start');   // the menu theme rises out of silence
  }

  function effect(kind) {
    if (muted.effects || quiet) return null;
    const entry = pick(kind);
    if (!entry) return null;
    const a = new Audio(entry.url);
    a.volume = volumes.effects;
    liveEffects.add(a);
    const done = () => liveEffects.delete(a);
    a.addEventListener('ended', done);
    a.addEventListener('error', done);
    safePlay(a);
    return entry.url;
  }

  function startSwimming() {
    swimmingWanted = !quiet;
    if (swim || muted.effects || quiet) return;
    const entry = pick('swimming');
    if (!entry) return;
    const a = new Audio(entry.url);
    a.loop = true;
    a.volume = volumes.effects;
    swim = a;
    safePlay(a);
  }

  function stopSwimming() {
    swimmingWanted = false;
    if (!swim) return;
    stopAudio(swim);
    swim = null;
  }

  function stopVoice() {
    voiceQueue.length = 0;
    if (!voice) return;
    stopAudio(voice);
    voice = null;
  }

  function playNextVoice() {
    if (voice || !voiceQueue.length) return;
    const url = voiceQueue.shift();
    const a = new Audio(url);
    a.volume = volumes.commentator;
    voice = a;
    const next = () => {
      if (voice !== a) return;
      voice = null;
      playNextVoice();
    };
    a.addEventListener('ended', next);
    a.addEventListener('error', next);
    safePlay(a);
  }

  function speak(bucket, variantCount = 0, { interrupt = false } = {}) {
    let list = voicePools.get(bucket);
    if ((!list || !list.length) && variantCount > 0) {
      list = Array.from({ length: variantCount }, (_, idx) => ({ url: null, idx, plays: 0 }));
      voicePools.set(bucket, list);
    }
    if (!list || !list.length) return 0;
    let min = Infinity;
    for (const item of list) if (item.plays < min) min = item.plays;
    const candidates = list.filter((item) => item.plays === min);
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    chosen.plays++;
    voiceHistory.push({ bucket, idx: chosen.idx, url: chosen.url, plays: chosen.plays });
    if (voiceHistory.length > 300) voiceHistory.shift();

    if (interrupt) stopVoice();
    if (chosen.url && !muted.commentator && !quiet) {
      while (voiceQueue.length >= 2) voiceQueue.shift();
      voiceQueue.push(chosen.url);
      playNextVoice();
    }
    return chosen.idx;
  }

  // Switching off silences what is playing now; switching music back on starts a track for the current mood,
  // and the sound of a ship under way comes back if a ship is still sailing.
  function setMuted(kind, on) {
    if (!(kind in muted) || muted[kind] === Boolean(on)) return;
    muted[kind] = Boolean(on);
    if (kind === 'music') {
      if (on) {
        for (const old of fading) stopAudio(old);
        fading.clear();
        if (music) { stopAudio(music); music = null; currentTrack = null; }
      } else if (mood && !music) playMusicTrack(mood, true);
    } else if (kind === 'effects') {
      if (on) {
        for (const a of liveEffects) stopAudio(a);
        liveEffects.clear();
        if (swim) { stopAudio(swim); swim = null; }
      } else if (swimmingWanted && !swim) startSwimming();
    } else if (on) stopVoice();
  }

  function setQuiet(on) { quiet = Boolean(on); }

  function resetGame() {
    stopSwimming();
    stopVoice();
    for (const list of pools.values()) for (const item of list) item.plays = 0;
    for (const list of voicePools.values()) for (const item of list) item.plays = 0;
    history.length = 0;
    voiceHistory.length = 0;
    if (!hadGame && mood === 'calm' && music && currentTrack) {
      currentTrack.plays = 1;
      history.push({ kind: 'calm', url: currentTrack.url, plays: 1 });
    } else if (music) {
      fading.add(music);
      music = null; currentTrack = null; mood = null;
    }
    hadGame = true;
  }

  function tick(dt) {
    const level = musicLevel();
    if (music && musicGain < level) {
      musicGain = Math.min(level, musicGain + (dt / 0.9) * level);
      music.volume = musicGain;
    }
    for (const old of [...fading]) {
      const nextV = old.volume - (dt / 0.9) * volumes.music;
      if (nextV <= 0.005) {
        fading.delete(old);
        stopAudio(old);
      } else {
        old.volume = nextV;
      }
    }
  }

  function counts(kind) {
    const list = pools.get(kind) || [];
    return list.map(({ url, plays }) => ({ url, plays }));
  }

  function voiceCounts(bucket) {
    const list = voicePools.get(bucket) || [];
    return list.map(({ url, idx, plays }) => ({ url, idx, plays }));
  }

  return {
    volumes,
    setMood,
    effect,
    startSwimming,
    stopSwimming,
    speak,
    stopVoice,
    setMuted,
    setQuiet,
    resetGame,
    tick,
    counts,
    voiceCounts,
    history,
    voiceHistory,
    get mood() { return mood; },
    get muted() { return { ...muted }; },
    get swimming() { return swimmingWanted && Boolean(swim); },
    get speaking() { return Boolean(voice); },
    get currentVoice() { return voice ? voice.src : null; },
    get currentMusic() { return currentTrack ? currentTrack.url : null; },
    get musicVolume() { return music ? music.volume : 0; },
  };
}
