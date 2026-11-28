// ------------------------------------------------------------------ bots: computer players and their styles of play
// A bot plays by the same rules as everyone and through the same menu: app.js asks the brain what to do and performs
// it. The brain has its own model of the rules over the board's cells (the very slot objects of app.js), so it can
// look ahead without touching the ships on screen. For a decision it tries every way to spend the dice still unused —
// a ship sailing by one die, by the other or by both together, a repair or a ransom with a six — scores where the
// fleet would stand once the throw is spent, and takes the first step of the best plan. A style is a set of weights
// for that score (BOT_PARAMS); its name and description are in bot-styles.js. The tests (src/bot.test.js) play whole
// games with the brain, without the 3D map.

const BOT_NATIONS = ['ru', 'se', 'en', 'nl'];
const BOT_NEXT = { ru: 'nl', nl: 'en', en: 'se', se: 'ru' };   // as NEXT in app.js
const BOT_REACH = 12;                                            // the farthest one throw can take a ship

// What a position is worth and what a style cares about:
//   yard, harbor       a wreck on the shipyard; a ship in the harbour, ready to sail
//   prog, lead         per cell sailed along the route; extra for ships far along (squared), so the leader goes first
//   parade             extra for a ship on the parade: it is home and nobody can catch it there
//   enemy              how much the worth of the enemy ships counts against us (a capture takes all of it away)
//   risk               the expected loss of ships an enemy can catch before our next turn
//   threat             the chance of catching an enemy ship on our next turn
//   capture, restore   for every ship captured; for a repair or a ransom
//   crowd, crowdLimit  for every ship on open water beyond the limit (bays, the harbour and the parade do not count)
//   bay, bayChase      for a ship lying in a bay; less once an enemy has passed it and can be chased
//   convoy             for a ship with another of ours one to three cells behind it, covering it
//   noise              randomness added to every plan: a little for variety, a lot for the novice
const BOT_BASE = {
  yard: 14, harbor: 30, prog: 1, lead: 0, parade: 25, enemy: 0.5, risk: 1, threat: 0.3, capture: 25, restore: 20,
  crowd: 0, crowdLimit: 5, bay: 0, bayChase: 0, convoy: 0, noise: 0.6,
};
const BOT_PARAMS = {
  // restores first, few ships on open water except in bays, waits in bays, captures, hurries to the parade
  // (and pushes its leading ship on: a game of self-play showed that fewer ships at sea are worth more that way)
  careful: { ...BOT_BASE, lead: 1.5, restore: 60, capture: 30, crowd: 14, crowdLimit: 2, bay: 25, bayChase: 6, threat: 0.35 },
  // hunts: many ships out, chases enemies within a throw, captures before repairing, little fear
  corsair: { ...BOT_BASE, prog: 0.8, lead: 0.5, parade: 12, enemy: 0.9, risk: 0.45, threat: 1, capture: 45, restore: 10, bay: 2 },
  // races: the leading ship first, no chases, captures only on the way
  racer: { ...BOT_BASE, prog: 1.6, lead: 1.2, parade: 35, enemy: 0.15, risk: 0.7, threat: 0, capture: 5, restore: 6 },
  // a close column: the rear ship covers the others, danger counts most
  convoy: { ...BOT_BASE, lead: 1, risk: 1.1, threat: 0.25, restore: 30, crowd: 8, crowdLimit: 3, bay: 3, convoy: 5 },
  // nearly at random
  novice: { ...BOT_BASE, enemy: 0.3, risk: 0.25, threat: 0, capture: 12, restore: 12, noise: 30 },
};
const BOT_DEFAULT = 'careful';
const botStyleOf = (id) => (Object.hasOwn(BOT_PARAMS, id) ? id : BOT_DEFAULT);

// board: { cells: { q: { f: [null, field 1…13], b: bay, s: [parade place 1…5] } }, harbors, shipyards, prisons } —
// slot objects with .q and .field (1…13 or 'b'), .star (1…5) or .prison, as app.js builds them (makeBotBoard
// builds bare ones for the tests). A ship is { id: 'ru3', q, n, slot }.
function createBotBrain({ cells, harbors, shipyards, prisons }) {
  // ---- the rules
  // The route of each side in play: its harbour, fields 1…6 of its own side, then 7…13 and 1…6 of every side after it
  // in play, its own 7…13 and the five places of the parade (nextCell in app.js). A bay stands where field 2 of its
  // side is: from a bay a ship sails on to field 3.
  const models = new Map();
  function model(sides) {
    const key = BOT_NATIONS.filter((q) => sides.has(q)).join();
    let M = models.get(key);
    if (M) return M;
    const next = (x) => { let y = BOT_NEXT[x]; while (!sides.has(y)) y = BOT_NEXT[y]; return y; };
    const route = {}, at = {};
    for (const q of BOT_NATIONS) {
      if (!sides.has(q)) continue;
      const r = [harbors[q]];
      for (let i = 1; i <= 6; i++) r.push(cells[q].f[i]);
      for (let x = next(q); x !== q; x = next(x)) {
        for (let i = 7; i <= 13; i++) r.push(cells[x].f[i]);
        for (let i = 1; i <= 6; i++) r.push(cells[x].f[i]);
      }
      for (let i = 7; i <= 13; i++) r.push(cells[q].f[i]);
      r.push(...cells[q].s);
      const m = new Map(r.map((c, i) => [c, i]));
      for (const x of BOT_NATIONS) if (sides.has(x)) m.set(cells[x].b, m.get(cells[x].f[2]));
      route[q] = r; at[q] = m;
    }
    M = { sides, route, at };
    models.set(key, M);
    return M;
  }
  const isOpen = (c) => typeof c.field === 'number';          // a numbered field: a ship there can be caught
  const canSail = (s) => s.slot === harbors[s.q] || s.slot.field != null || (s.slot.star != null && s.slot.star < 5);
  const won = (ships, q) => ships.every((s) => s.q !== q || s.slot.star);
  function occupancy(ships) {
    const m = new Map();
    for (const s of ships) { const l = m.get(s.slot); if (l) l.push(s); else m.set(s.slot, [s]); }
    return m;
  }
  // the routes of exactly len cells for ship s (routes() in app.js): a route ending on field 2 may stop in the empty
  // bay beside it instead; one of the side's own ships anywhere on a route closes it, so does any ship before its end
  function paths(M, s, len, occ) {
    const r = M.route[s.q], i0 = M.at[s.q].get(s.slot);
    if (i0 == null || i0 + len >= r.length) return [];
    const path = r.slice(i0 + 1, i0 + len + 1), last = path[len - 1], all = [path];
    if (last.field === 2 && !occ.get(cells[last.q].b)) all.push([...path.slice(0, -1), cells[last.q].b]);
    return all.filter((p) => p.every((c, i) => {
      const here = occ.get(c);
      return !here || (i === p.length - 1 && !here.some((o) => o.q === s.q));
    }));
  }
  // everything side q may do with the dice not used yet (options() in app.js): sail by one die or by both together,
  // and with a six repair a ship or buy one out of a prison. A ship that has captured this turn may not sail again.
  // movesOnly: the jailer's six steps after a ransom. A repair or a ransom is listed once (once per prison).
  function options(M, ships, q, dice, captured = new Set(), movesOnly = false) {
    const occ = occupancy(ships), free = [];
    dice.forEach((d, i) => { if (!d.used) free.push(i); });
    const lens = [];
    for (const i of free) if (!lens.some((l) => l.use.length === 1 && l.len === dice[i].v)) lens.push({ len: dice[i].v, use: [i] });
    if (free.length === 2) lens.push({ len: dice[free[0]].v + dice[free[1]].v, use: free });
    let out = [];
    for (const s of ships) {
      if (s.q !== q || !canSail(s) || captured.has(s.id)) continue;
      for (const L of lens) for (const path of paths(M, s, L.len, occ)) {
        const slot = path[path.length - 1];
        out.push({ kind: 'move', ship: s.id, slot, len: L.len, use: L.use,
          victims: (occ.get(slot) || []).filter((o) => o.q !== q).map((o) => o.id) });
      }
    }
    if (lens.length === 3 && out.every(move => move.ship === out[0].ship)) out = singleMoverRoutes(out);
    const six = movesOnly ? -1 : free.find((i) => dice[i].v === 6) ?? -1;
    if (six >= 0) {
      const wreck = ships.find((s) => s.q === q && s.slot === shipyards[q]);
      if (wreck) out.push({ kind: 'repair', ship: wreck.id, slot: harbors[q], use: [six], victims: [] });
      const seen = new Set();
      for (const s of ships) {
        if (s.q !== q || !s.slot.prison || seen.has(s.slot)) continue;
        seen.add(s.slot);
        out.push({ kind: 'ransom', ship: s.id, slot: shipyards[q], from: s.slot.q, use: [six], victims: [] });
      }
    }
    return out;
  }
  // the fleets after action a of side q: the ship goes where it was sent, its victims to q's prison
  function apply(ships, a, q) {
    const victims = new Set(a.victims);
    return ships.map((s) => (s.id === a.ship ? { ...s, slot: a.slot } : victims.has(s.id) ? { ...s, slot: prisons[q] } : s));
  }

  // ---- the score of a position for side me
  // what a ship is worth to its own side, by the weights P
  function worth(M, s, P) {
    const c = s.slot;
    if (c.prison) return 0;
    if (c === shipyards[s.q]) return P.yard;
    const i = M.at[s.q].get(c) ?? 0, L = M.route[s.q].length - 1;
    return P.harbor + P.prog * i + (P.lead * i * i) / L + (c.star ? P.parade : 0);
  }
  // the chance that one throw lets a ship sail one of these distances (bit d of mask): by one die, the other, or both
  const chances = new Map();
  function hitChance(mask) {
    if (!mask) return 0;
    let p = chances.get(mask);
    if (p === undefined) {
      let n = 0;
      for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) if ((mask >> a) & 1 || (mask >> b) & 1 || (mask >> (a + b)) & 1) n++;
      chances.set(mask, (p = n / 36));
    }
    return p;
  }
  // who can catch whom: for every ship that can sail (not on the parade), the first ship ahead of it within a throw,
  // when that ship is another side's and stands on a numbered field. Nobody can sail past a ship.
  function reach(M, ships, occ) {
    const out = [];
    for (const h of ships) {
      if (h.slot !== harbors[h.q] && h.slot.field == null) continue;
      const r = M.route[h.q], i0 = M.at[h.q].get(h.slot);
      for (let d = 1; d <= BOT_REACH && i0 + d < r.length; d++) {
        const here = occ.get(r[i0 + d]);
        if (!here) continue;
        if (here[0].q !== h.q && isOpen(r[i0 + d])) out.push({ h, p: here[0], d });
        break;
      }
    }
    return out;
  }
  function evaluate(M, ships, me, P) {
    const occ = occupancy(ships), hunts = reach(M, ships, occ), mine = [];
    let score = 0, open = 0;
    for (const s of ships) {
      if (s.q === me) { score += worth(M, s, P); mine.push(s); if (isOpen(s.slot)) open++; }
      else score -= P.enemy * worth(M, s, BOT_BASE);
    }
    // every other side throws before our next turn: each may catch a ship of ours it reaches; we may catch theirs
    const danger = new Map(), prey = new Map();
    for (const { h, p, d } of hunts) {
      if (p.q === me) {
        let bySide = danger.get(p);
        if (!bySide) danger.set(p, (bySide = new Map()));
        bySide.set(h.q, (bySide.get(h.q) || 0) | (1 << d));
      } else if (h.q === me) prey.set(p, (prey.get(p) || 0) | (1 << d));
    }
    for (const [s, bySide] of danger) {
      let safe = 1;
      for (const mask of bySide.values()) safe *= 1 - hitChance(mask);
      score -= P.risk * (1 - safe) * worth(M, s, P);
    }
    for (const [s, mask] of prey) score += P.threat * hitChance(mask) * (P.enemy * worth(M, s, BOT_BASE) + P.capture);
    score -= P.crowd * Math.max(0, open - P.crowdLimit);
    if (P.bay) for (const s of mine) if (s.slot.field === 'b') score += hunts.some((x) => x.h === s) ? P.bayChase : P.bay;
    if (P.convoy) {
      const r = M.route[me];
      for (const s of mine) {
        if (!isOpen(s.slot)) continue;
        const i = M.at[me].get(s.slot);
        for (let k = 1; k <= 3 && i - k > 0; k++) {
          const c = r[i - k], o = occ.get(c);
          if (o && isOpen(c) && o[0].q === me) { score += P.convoy; break; }
        }
      }
    }
    return score;
  }

  // ---- planning the throw
  const bonus = (a, P) => (a.kind === 'move' ? a.victims.length * P.capture : P.restore);
  // after a ransom the jailer sails six steps: the reply that hurts side me most is assumed
  function jailerReply(M, ships, me, X, P) {
    let worst = ships, low = Infinity;
    for (const a of options(M, ships, X, [{ v: 6, used: false }], new Set(), true)) {
      const next = apply(ships, a, X), v = evaluate(M, next, me, P);
      if (v < low) { low = v; worst = next; }
    }
    return worst;
  }
  // the score of taking action a, then making the best of the dice left
  function step(M, ships, me, dice, captured, P, a) {
    let next = apply(ships, a, me);
    if (won(next, me)) return 1e6;
    if (a.kind === 'ransom') next = jailerReply(M, next, me, a.from, P);
    const rest = dice.map((d, i) => (a.use.includes(i) ? { ...d, used: true } : d));
    const held = a.victims.length ? new Set([...captured, a.ship]) : captured;
    return bonus(a, P) + plan(M, next, me, rest, held, P);
  }
  function plan(M, ships, me, dice, captured, P) {
    const opts = options(M, ships, me, dice, captured);
    if (!opts.length) return evaluate(M, ships, me, P);
    let best = -Infinity;
    for (const a of opts) best = Math.max(best, step(M, ships, me, dice, captured, P, a));
    return best;
  }
  // view: { sides, ships, me, dice: [{ v, used }], captured: [ship ids], comp } — comp: the jailer's six steps (any
  // of the jailer's ships may sail them). Returns one of the options (as options() lists them) or null.
  function decide(view, style, rng = Math.random) {
    const P = BOT_PARAMS[botStyleOf(style)];
    const M = model(view.sides instanceof Set ? view.sides : new Set(view.sides));
    const dice = view.comp ? [{ v: 6, used: false }] : view.dice;
    const captured = new Set(view.comp ? [] : view.captured || []);
    const opts = options(M, view.ships, view.me, dice, captured, !!view.comp);
    if (opts.length < 2) return opts[0] || null;
    let best = null, top = -Infinity;
    for (const a of opts) {
      const v = step(M, view.ships, view.me, dice, captured, P, a) + rng() * P.noise;
      if (v > top) { top = v; best = a; }
    }
    return best;
  }

  // ---- a whole game without the map (the tests): the sides in turn order, a style for each, dice from rng
  function playGame({ sides: order, styles, rng = Math.random, maxThrows = 6000 }) {
    const sides = new Set(order);
    let ships = order.flatMap((q) => [1, 2, 3, 4, 5].map((n) => ({ id: `${q}${n}`, q, n, slot: shipyards[q] })));
    const tally = () => Object.fromEntries(order.map((q) => [q, 0]));
    const stats = { throws: 0, captures: tally(), repairs: tally(), ransoms: tally() };
    const roll = () => 1 + Math.floor(rng() * 6);
    let turn = 0;
    const did = (q, a) => {
      ships = apply(ships, a, q);
      stats.captures[q] += a.victims.length;
      if (a.kind === 'repair') stats.repairs[q]++;
      if (a.kind === 'ransom') stats.ransoms[q]++;
      return won(ships, q);
    };
    while (stats.throws < maxThrows) {
      const q = order[turn], a = roll(), b = roll(), dice = [{ v: a, used: false }, { v: b, used: false }], captured = new Set();
      stats.throws++;
      for (;;) {
        const act = decide({ sides, ships, me: q, dice, captured: [...captured] }, styles[q], rng);
        if (!act) break;
        for (const i of act.use) dice[i].used = true;
        if (act.victims.length) captured.add(act.ship);
        if (did(q, act)) return { winner: q, ships, stats };
        if (act.kind === 'ransom') {
          const reply = decide({ sides, ships, me: act.from, comp: true }, styles[act.from], rng);
          if (reply && did(act.from, reply)) return { winner: act.from, ships, stats };
        }
      }
      if (a !== b) turn = (turn + 1) % order.length;
    }
    return { winner: null, ships, stats };
  }

  return { model, options, apply, evaluate, decide, playGame, won };
}
