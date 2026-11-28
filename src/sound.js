// Sound, music, and commentator director.
// Within a game, picks uniformly at random among the least-played files in each folder;
// the call to a player's turn counts its plays over the whole session (the page's lifetime) instead.
// Music has three moods: 'start' — the theme of the main menu, played until a game begins — then 'calm' and 'anxious'.
const MUSIC_MOODS = ['start', 'calm', 'anxious'];
const SESSION_KINDS = new Set(['turn']);
const ATMOSPHERE_FADE = 2; // seconds of overlap between recordings
const ATMOSPHERE_LEVEL = 0.9; // the sea, matched to the loudness of the music track, plays 10% quieter than it

// One gesture-unlocked context plays short clips, including events received over WebSocket.
// Decode on demand with a small cache, rather than retaining all voice clips as PCM audio.
function createGameAudio() {
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) return null;
  let context = null, nextMusic = 0;
  const decoded = new Map(), musicChannels = [], primed = new Set();
  const silence = 'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==';
  function unlock() {
    context ||= new Context();
    if (context.state !== 'running') context.resume().catch(() => {});
    if (!musicChannels.length) {
      for (let i = 0; i < 2; i++) musicChannels.push(new Audio(silence));
    }
    for (const audio of musicChannels) {
      // A touch's pointerdown may be rejected; its subsequent click must retry the same elements.
      if (primed.has(audio) || audio.getAttribute('src') !== silence) continue;
      audio.play()?.then(() => {
        primed.add(audio);
        if (audio.getAttribute('src') === silence) audio.pause();
      }).catch(() => {});
    }
  }
  async function buffer(url) {
    if (decoded.has(url)) {
      const result = decoded.get(url);
      decoded.delete(url); decoded.set(url, result);
      return result;
    }
    const task = (async () => {
      const blob = window.AdmiralAssets?.blob(url);
      const bytes = blob ? await blob.arrayBuffer() : await (await fetch(url)).arrayBuffer();
      return context.decodeAudioData(bytes);
    })();
    decoded.set(url, task);
    while (decoded.size > 12) decoded.delete(decoded.keys().next().value);
    try { return await task; } catch (error) { decoded.delete(url); throw error; }
  }
  class Clip extends EventTarget {
    constructor(url) {
      super();
      this.src = url; this.dataset = {}; this.volume = 1; this.loop = false;
      this.paused = true; this.ended = false; this.duration = 0; this.offset = 0; this.generation = 0;
    }
    get volume() { return this.level; }
    set volume(value) {
      this.level = value;
      if (this.gainNode) this.gainNode.gain.value = value;
    }
    get currentTime() {
      if (!this.source) return this.offset;
      const elapsed = this.offset + context.currentTime - this.started;
      return this.loop && this.duration ? elapsed % this.duration : Math.min(elapsed, this.duration);
    }
    async play() {
      if (!this.paused) return;
      context ||= new Context();
      const generation = ++this.generation;
      this.paused = false; this.ended = false;
      try {
        const audio = await buffer(this.src);
        if (this.paused || generation !== this.generation) return;
        if (context.state !== 'running') throw new DOMException('Tap to enable audio', 'NotAllowedError');
        const gain = context.createGain(), source = context.createBufferSource();
        this.duration = audio.duration;
        source.buffer = audio; source.loop = this.loop; gain.gain.value = this.volume;
        source.connect(gain); gain.connect(context.destination);
        this.source = source; this.gainNode = gain; this.started = context.currentTime;
        source.onended = () => {
          source.disconnect(); gain.disconnect();
          if (generation !== this.generation) return;
          this.source = null; this.gainNode = null; this.offset = this.duration; this.paused = true; this.ended = true;
          this.dispatchEvent(new Event('ended'));
        };
        source.start(0, this.offset);
      } catch (error) {
        if (generation !== this.generation) return;
        this.paused = true;
        if (error.name !== 'NotAllowedError') this.dispatchEvent(new Event('error'));
        throw error;
      }
    }
    pause() {
      this.offset = this.currentTime; this.paused = true; this.generation++;
      if (this.source) { this.source.stop(); this.source = null; this.gainNode = null; }
    }
  }
  return {
    unlock,
    clip: (url) => new Clip(url),
    music(url) {
      const audio = musicChannels.length ? musicChannels[nextMusic++ % musicChannels.length] : new Audio();
      audio.pause(); delete audio.dataset.stopped;
      audio.src = window.AdmiralAssets?.url(url) || url;
      return audio;
    },
  };
}

function createSoundDirector(manifest = {}) {
  const backend = createGameAudio();
  const clip = (url) => backend && window.AdmiralAssets?.blob(url)
    ? backend.clip(url) : new Audio(window.AdmiralAssets?.url(url) || url);
  const volumes = { music: 1, effects: 1, commentator: 1 };
  // in the main menu the music is all there is to hear; in a game it stays under the commentator
  const musicLevel = () => mood === 'start' ? 0.55 : 0.3;
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

  const liveEffects = new Set(), fading = new Map(), blocked = new Set();
  const history = [], voiceHistory = [];
  const pendingVoice = [];                         // only clips explicitly allowed to wait
  let mood = null, music = null, musicGain = 0, currentTrack = null, musicPaused = false;
  let swim = null, swimmingWanted = false, voice = null, hadGame = false, turnCall = null;
  // switched off by the player: nothing of that kind is played (captions still pick their variants)
  const muted = { music: false, effects: false, commentator: false };
  // quiet: a game being caught up at once (an online game rejoined) makes no sound at all; captions still pick variants
  let quiet = false;

  function safePlay(a, onError) {
    const failed = (err) => {
      if (a.dataset.stopped) return;
      if (onError) onError();
      else if (err?.name === 'NotAllowedError') blocked.add(a);
    };
    try {
      a.play()?.catch(failed);
    } catch (err) { failed(err); }
  }

  function unlock() {
    backend?.unlock();
    if (!blocked.size) return;
    for (const a of [...blocked]) {
      blocked.delete(a);
      if (!a.dataset.stopped) safePlay(a);
    }
  }
  for (const ev of ['pointerdown', 'keydown', 'click']) {
    window.addEventListener(ev, unlock, { capture: true, passive: true });
  }
  window.addEventListener('admiral:unlock-audio', unlock);

  function stopAudio(a) {
    if (!a) return;
    a.dataset.stopped = '1';
    blocked.delete(a);
    try { a.pause(); } catch { /* ignore */ }
  }

  function pick(kind, list = pools.get(kind)) {
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

  let atmosphere = null, previousAtmosphere = null;
  let atmosphereTrim = 1;
  const failedAtmosphere = new Set();

  function stopAtmosphere() {
    stopAudio(atmosphere?.audio);
    stopAudio(previousAtmosphere?.audio);
    atmosphere = previousAtmosphere = null;
  }

  function nextAtmosphere() {
    const available = pools.get('atmosphere').filter(entry => !failedAtmosphere.has(entry.url));
    const choices = available.length > 1 ? available.filter(entry => entry.url !== atmosphere?.url) : available;
    const entry = pick('atmosphere', choices);
    if (!entry) return;
    const audio = clip(entry.url);
    previousAtmosphere = atmosphere;
    atmosphere = { audio, url: entry.url };
    audio.volume = 0;
    audio.addEventListener('error', () => failedAtmosphere.add(entry.url));
    safePlay(audio);
  }

  function mixAtmosphere(track) {
    if (!track) return;
    const { audio } = track;
    if (!(audio.duration > 0)) return;
    const fade = Math.min(ATMOSPHERE_FADE, audio.duration / 2);
    const time = audio.currentTime;
    const envelope = Math.max(0, Math.min(1, time / fade, (audio.duration - time) / fade));
    audio.volume = quiet ? 0 : Math.min(1, envelope * musicLevel() * atmosphereTrim * ATMOSPHERE_LEVEL * volumes.effects);
  }

  function tickAtmosphere() {
    if (!pools.get('atmosphere')?.length || !mood || mood === 'start' || muted.effects || musicPaused || quiet) return;
    if (previousAtmosphere && (previousAtmosphere.audio.ended || failedAtmosphere.has(previousAtmosphere.url))) {
      stopAudio(previousAtmosphere.audio);
      previousAtmosphere = null;
    }
    if (atmosphere && failedAtmosphere.has(atmosphere.url)) {
      stopAudio(atmosphere.audio);
      atmosphere = previousAtmosphere;
      previousAtmosphere = null;
    }
    const current = atmosphere?.audio;
    if (!previousAtmosphere && (!current || current.ended ||
        (current.duration > 0 && current.duration - current.currentTime <= Math.min(ATMOSPHERE_FADE, current.duration / 2)))) {
      nextAtmosphere();
    }
    mixAtmosphere(previousAtmosphere);
    mixAtmosphere(atmosphere);
  }

  function playMusicTrack(kind, crossfade) {
    if (muted.music || musicPaused) return;
    const entry = pick(kind);
    if (!entry) return;
    atmosphereTrim = manifest.atmosphereTrim?.[entry.url] ?? 1;
    const a = backend ? backend.music(entry.url) : new Audio(window.AdmiralAssets?.url(entry.url) || entry.url);
    fading.delete(a);
    a.preload = 'auto';
    musicGain = crossfade ? 0.02 : musicLevel();
    a.volume = musicGain * volumes.music;
    a.onended = () => {
      if (music !== a) return;
      music = null; currentTrack = null;
      if (mood) playMusicTrack(mood, false);
    };
    a.onerror = () => {
      if (music !== a) return;
      music = null; currentTrack = null;
    };
    music = a;
    currentTrack = entry;
    safePlay(a);
  }

  function setMood(nextMood) {
    if (!MUSIC_MOODS.includes(nextMood)) return;
    if (mood === nextMood && music) return;
    const crossfade = Boolean(music);
    if (music) {
      fading.set(music, musicGain);
      music = null; currentTrack = null;
    }
    mood = nextMood;
    if (mood === 'start') stopAtmosphere();
    playMusicTrack(nextMood, crossfade || nextMood === 'start');   // the menu theme rises out of silence
  }

  function setMusicPaused(on) {
    if (musicPaused === on) return;
    musicPaused = on;
    if (on) {
      stopAtmosphere();
      for (const old of fading.keys()) stopAudio(old);
      fading.clear();
      if (music) { music.pause(); blocked.delete(music); }
    } else if (music) safePlay(music);
    else if (mood) playMusicTrack(mood, true);
  }

  function startEffect(kind) {
    if (muted.effects || quiet) return null;
    const entry = pick(kind);
    if (!entry) return null;
    const a = clip(entry.url);
    a.volume = volumes.effects;
    liveEffects.add(a);
    const done = () => { liveEffects.delete(a); if (turnCall === a) turnCall = null; };
    a.addEventListener('ended', done);
    a.addEventListener('error', done);
    safePlay(a);
    return { url: entry.url, a };
  }

  function effect(kind) { return startEffect(kind)?.url ?? null; }

  // «Ваш ход!»: the sound that calls a player to their turn, cut short once the player answers
  function callTurn() {
    stopTurnCall();
    const started = startEffect('turn');
    turnCall = started?.a ?? null;
    return started?.url ?? null;
  }

  function stopTurnCall() {
    if (!turnCall) return;
    liveEffects.delete(turnCall);
    stopAudio(turnCall);
    turnCall = null;
  }

  function startSwimming() {
    swimmingWanted = !quiet;
    if (swim || muted.effects || quiet) return;
    const entry = pick('swimming');
    if (!entry) return;
    const a = clip(entry.url);
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
    pendingVoice.length = 0;
    if (!voice) return;
    stopAudio(voice);
    voice = null;
  }

  function playVoice(url) {
    const a = clip(url);
    a.volume = volumes.commentator;
    voice = a;
    const done = () => {
      if (voice !== a) return;
      voice = null;
      if (pendingVoice.length) playVoice(pendingVoice.shift());
    };
    a.addEventListener('ended', done);
    a.addEventListener('error', done);
    // A blocked clip is dropped so a later gesture cannot replay an old event.
    safePlay(a, done);
  }

  function speak(bucket, variantCount = 0, { queueIfBusy = false } = {}) {
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

    if (chosen.url && !muted.commentator && !quiet) {
      if ((!voice || voice.ended) && !pendingVoice.length) playVoice(chosen.url);
      else if (queueIfBusy) pendingVoice.push(chosen.url);
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
        for (const old of fading.keys()) stopAudio(old);
        fading.clear();
        if (music) { stopAudio(music); music = null; currentTrack = null; }
      } else if (mood && !music) playMusicTrack(mood, true);
    } else if (kind === 'effects') {
      if (on) {
        stopAtmosphere();
        for (const a of liveEffects) stopAudio(a);
        liveEffects.clear();
        turnCall = null;
        if (swim) { stopAudio(swim); swim = null; }
      } else if (swimmingWanted && !swim) startSwimming();
    } else if (on) stopVoice();
  }

  function setQuiet(on) {
    quiet = Boolean(on);
    mixAtmosphere(atmosphere);
    mixAtmosphere(previousAtmosphere);
  }

  function setVolume(kind, value) {
    if (!Object.hasOwn(volumes, kind) || !Number.isFinite(value)) return;
    const level = Math.min(1, Math.max(0, value));
    volumes[kind] = level;
    if (kind === 'music') {
      if (music) music.volume = musicGain * level;
      for (const [old, gain] of fading) old.volume = gain * level;
    } else if (kind === 'effects') {
      mixAtmosphere(atmosphere);
      mixAtmosphere(previousAtmosphere);
      for (const effect of liveEffects) effect.volume = level;
      if (swim) swim.volume = level;
    } else if (voice) voice.volume = level;
  }

  function resetGame() {
    stopAtmosphere();
    failedAtmosphere.clear();
    stopSwimming();
    stopVoice();
    stopTurnCall();
    for (const [kind, list] of pools) if (!SESSION_KINDS.has(kind)) for (const item of list) item.plays = 0;
    for (const list of voicePools.values()) for (const item of list) item.plays = 0;
    history.length = 0;
    voiceHistory.length = 0;
    if (!hadGame && mood === 'calm' && music && currentTrack) {
      currentTrack.plays = 1;
      history.push({ kind: 'calm', url: currentTrack.url, plays: 1 });
    } else if (music) {
      fading.set(music, musicGain);
      music = null; currentTrack = null; mood = null;
    }
    hadGame = true;
  }

  function tick(dt) {
    tickAtmosphere();
    const level = musicLevel();
    if (music && musicGain < level) {
      musicGain = Math.min(level, musicGain + (dt / 0.9) * level);
      music.volume = musicGain * volumes.music;
    }
    for (const [old, gain] of fading) {
      const nextV = gain - (dt / 0.9) * 0.3;
      if (nextV <= 0.005) {
        fading.delete(old);
        stopAudio(old);
      } else {
        fading.set(old, nextV);
        old.volume = nextV * volumes.music;
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
    setMusicPaused,
    effect,
    callTurn,
    stopTurnCall,
    startSwimming,
    stopSwimming,
    speak,
    stopVoice,
    setMuted,
    setVolume,
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
    get speaking() { return Boolean(voice && !voice.ended); },
    // how much of the line being spoken has been said, 0…1; null while he is silent
    get voiceProgress() {
      if (!voice || voice.ended) return null;
      return voice.duration > 0 ? Math.min(1, voice.currentTime / voice.duration) : 0;
    },
    get currentVoice() { return voice && !voice.ended ? voice.src : null; },
    get currentMusic() { return currentTrack ? currentTrack.url : null; },
    get musicVolume() { return music ? music.volume : 0; },
  };
}
