export const NEXT = { ru: 'nl', nl: 'en', en: 'se', se: 'ru' };                  // 6 → 7 of this neighbour

export function singleMoverRoutes(moves) {
  // Count distances so the optional bay landing is not mistaken for another die choice.
  const distances = new Set(moves.map(move => move.len));
  return distances.size === 3 ? moves.filter(move => move.use.length === 2) : moves;
}

// ------------------------------------------------------------------ rules: where a ship may sail
// A ship leaves its harbour for field 1 of its own side and sails round the board through every side in
// play: 1…6, then field 7 of the next side (past a side out of the game along the ring round the wheel),
// 7…13, on that side 13 → 1, and so on. Back on its own side, from field 13 it enters the parade: five
// places, the fifth a dead end. Beside field 2 of every side is a bay, between fields 1 and 3.
export function createFleetRules({ cells, harbors, shipyards, ships }, sideActive) {
  const nextSide = (x) => { let y = NEXT[x]; while (!sideActive(y)) y = NEXT[y]; return y; };
  function nextCell(q, c) {                                    // the next cell for a ship of side q; null past the parade
    if (c === harbors[q]) return cells[q].f[1];
    if (c.star) return c.star < 5 ? cells[q].s[c.star] : null;
    const k = c.field;
    if (k === 'b') return cells[c.q].f[3];
    if (k === 6) return cells[nextSide(c.q)].f[7];
    if (k === 13) return c.q === q ? cells[q].s[0] : cells[c.q].f[1];
    return cells[c.q].f[k + 1];
  }
  // ships that may sail: in the harbour, in a bay, on a numbered field, on the first four places of the parade
  const atSea = (s) => s.slot === harbors[s.q] || s.slot.field != null || (s.slot.star != null && s.slot.star < 5);
  function occupancy() {
    const m = new Map();
    for (const s of ships) { if (!m.has(s.slot)) m.set(s.slot, []); m.get(s.slot).push(s); }
    return m;
  }
  // the routes of exactly len cells for ship s. A route ending on field 2 may stop in the empty bay beside
  // it instead. A route is closed if the board ends before it does, if one of the player's own ships stands
  // anywhere on it (its last cell too), or if an enemy ship stands on it before the last cell.
  function routes(s, len, occ) {
    const path = [];
    for (let c = s.slot, i = 0; i < len; i++) { c = nextCell(s.q, c); if (!c) return []; path.push(c); }
    const all = [path], last = path[len - 1];
    if (last.field === 2 && !(occ.get(cells[last.q].b) || []).length) all.push([...path.slice(0, -1), cells[last.q].b]);
    return all.filter((p) => p.every((c, i) => {
      const here = occ.get(c) || [];
      if (here.some((o) => o.q === s.q)) return false;
      return i === p.length - 1 || !here.length;
    }));
  }
  // everything side q may do with the dice not used yet: sail by one die or by both together, and with a six
  // repair a ship (shipyard → harbour) or buy one back from an enemy prison (→ own shipyard).
  // A ship that has already captured an enemy ship during the current turn may not sail again in it.
  function options(q, dice, movesOnly = false, blocked = null) {
    const occ = occupancy();
    const free = dice.map((d, i) => i).filter((i) => !dice[i].used);
    const lens = [];
    for (const i of free) if (!lens.some((l) => l.use.length === 1 && l.len === dice[i].v)) lens.push({ len: dice[i].v, use: [i] });
    if (free.length === 2) lens.push({ len: dice[free[0]].v + dice[free[1]].v, use: free });
    const acts = new Map(), add = (s, t) => { if (!acts.has(s)) acts.set(s, []); acts.get(s).push(t); };
    const mine = ships.filter((s) => s.q === q);
    const held = mine.filter((s) => atSea(s) && blocked?.has(s));
    for (const s of mine) if (atSea(s) && !blocked?.has(s)) for (const L of lens) for (const path of routes(s, L.len, occ)) {
      const slot = path[path.length - 1];
      add(s, { kind: 'move', slot, path, len: L.len, use: L.use, victims: (occ.get(slot) || []).filter((o) => o.q !== q) });
    }
    const movers = acts.size;
    const six = movesOnly ? -1 : free.find((i) => dice[i].v === 6) ?? -1;
    let repair = false, ransom = false;
    if (six >= 0) {
      for (const s of mine) if (s.slot === shipyards[q]) { add(s, { kind: 'repair', slot: harbors[q], len: 6, use: [six] }); repair = true; }
      for (const s of mine) if (s.slot.prison) { add(s, { kind: 'ransom', slot: shipyards[q], len: 6, use: [six] }); ransom = true; }
    }
    if (movers === 1 && !repair && !ransom) {
      const [ship, moves] = acts.entries().next().value;
      acts.set(ship, singleMoverRoutes(moves));
    }
    return { acts, movers, repair, ransom, six: six >= 0, sailing: mine.filter((s) => atSea(s) && !blocked?.has(s)).length, held: held.length };
  }
  return { nextCell, atSea, options, routes, occupancy };
}

// Logical board for the server and headless games.
export function makeBotBoard() {
  const cells = {}, harbors = {}, shipyards = {}, prisons = {};
  for (const q of Object.keys(NEXT)) {
    const c = (cells[q] = { f: [null], b: { q, field: 'b' }, s: [] });
    for (let i = 1; i <= 13; i++) c.f.push({ q, field: i });
    for (let k = 1; k <= 5; k++) c.s.push({ q, star: k });
    harbors[q] = { q, kind: 'zone', zone: 'harbor' };
    shipyards[q] = { q, kind: 'zone', zone: 'shipyard' };
    prisons[q] = { q, kind: 'zone', zone: 'prison', prison: true };
  }
  return { cells, harbors, shipyards, prisons };
}
