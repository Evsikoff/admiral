// «i» in the top bar: the statistics of the game so far. The fleets are counted as on the broadcast cards
// (src/broadcast.js); the throws come from game.throws, where a throw that did not count (a die cocked, off the
// board, against a ship or still rolling) is kept with counted: false. Sixes and doubles are counted only among
// the throws that counted: the faces of the others are not played.
export function diceStats(throws, players) {
  const blank = () => ({ counted: 0, missed: 0, oneSix: 0, doubles: 0, sixSix: 0 });
  const total = blank(), byPlayer = players.map(blank);
  for (const t of throws) {
    const own = byPlayer[t.player];
    if (!own) continue;
    for (const s of [own, total]) {
      if (!t.counted) { s.missed++; continue; }
      const [a, b] = t.dice;
      s.counted++;
      if ((a === 6) !== (b === 6)) s.oneSix++;          // a six on one die only; 6 / 6 is a double of its own
      if (a === b) s.doubles++;
      if (a === 6 && b === 6) s.sixSix++;
    }
  }
  return { players: byPlayer, total };
}
// the share of throws that counted, or null before the first throw
export const throwRate = (s) => (s.counted + s.missed ? s.counted / (s.counted + s.missed) : null);

export function createMatchStats(dialog, button, fleetSnapshot) {
  const sub = dialog.querySelector('.ms-sub'), roster = dialog.querySelector('.ms-players');
  const fleetTable = dialog.querySelector('#ms-fleets'), diceTable = dialog.querySelector('#ms-dice');
  let shown = '';

  const flag = (q) => `<img class="stat-flag" src="${FLAG_URL[q]}" alt="">`;
  const count = (n) => (n ? String(n) : '<span class="ms-zero">0</span>');
  const percent = (s) => { const r = throwRate(s); return r == null ? '<span class="ms-zero">—</span>' : `${Math.round(r * 100)}%`; };

  function table(players, names, rows) {
    const cols = `<colgroup><col class="ms-label-col">${players.map(() => '<col>').join('')}<col></colgroup>`;
    const head = players.map((p) => `<th scope="col" title="${names.get(p.q)} · ${NAMES[p.q]}"><span class="ms-col-head">${flag(p.q)}`
      + `<span class="ms-col-name">${names.get(p.q)}</span></span></th>`).join('');
    const body = rows.map(({ label, title, cls, cells, total }) =>
      `<tr${cls ? ` class="${cls}"` : ''}><th scope="row"${title ? ` title="${title}"` : ''}>${label}</th>`
      + `${players.map((p, i) => `<td>${cells(p, i)}</td>`).join('')}<td class="ms-total">${total}</td></tr>`).join('');
    return `${cols}<thead><tr><td></td>${head}<th scope="col" class="ms-total" title="Всего"><span class="ms-wide">Всего</span><span class="ms-narrow" aria-hidden="true">Σ</span></th></tr></thead><tbody>${body}</tbody>`;
  }

  function render() {
    const players = game.players;
    const names = new Map(players.map((p, i) => [p.q, escHTML(playerName(p, i))]));
    const fleets = fleetSnapshot(), fleet = (p) => fleets.get(p.q);
    const sum = (f) => players.reduce((n, p) => n + f(p), 0);
    const held = (captor) => (p) => fleet(p).heldBy[captor.q] || 0;
    const captured = (captor) => sum(held(captor));
    const captors = players.filter((c) => captured(c));
    const fleetRow = (label, kind, title) => ({ label, title, cells: (p) => count(fleet(p)[kind]), total: count(sum((p) => fleet(p)[kind])) });
    const fleetRows = [
      fleetRow('Кораблей в строю', 'ready', 'Целые корабли, не считая пленённых'),
      fleetRow('Кораблей в поле', 'field', 'На пронумерованных клетках и в бухтах'),
      fleetRow('Кораблей на параде', 'parade'),
      fleetRow('Кораблей в плену', 'prison'),
      ...captors.map((c) => ({
        label: `<span class="ms-held">у ${flag(c.q)}<span>${names.get(c.q)}</span></span>`, title: `В плену у ${names.get(c.q)} · ${NAMES[c.q]}`,
        cls: 'ms-sub-row', cells: (p) => count(held(c)(p)), total: count(captured(c)),
      })),
      { label: 'Пленили', title: 'Сколько чужих кораблей держит в плену', cells: (p) => count(captured(p)), total: count(sum(captured)) },
    ];

    const dice = diceStats(game.throws || [], players), mine = (i) => dice.players[i];
    const diceRow = (label, key, title) => ({ label, title, cells: (p, i) => count(mine(i)[key]), total: count(dice.total[key]) });
    const diceRows = [
      diceRow('Засчитано бросков', 'counted'),
      diceRow('Не засчитано', 'missed', 'Кость легла криво, вылетела за край карты, задела корабль или не остановилась'),
      { label: 'Результа&shy;тивность', title: 'Засчитанные броски, делённые на все броски', cells: (p, i) => percent(mine(i)), total: percent(dice.total) },
      diceRow('Шестёрка на одной кости', 'oneSix', 'Броски, где шестёрка выпала только на одной из двух костей'),
      diceRow('Дубли', 'doubles', 'Обе кости показали одно число, включая 6 / 6'),
      diceRow('Дубли 6 / 6', 'sixSix'),
    ];

    const i = game.phase === 'over' ? game.winner : game.chooser ?? game.turn;
    const now = game.phase === 'over' ? `партия окончена, победа: ${names.get(players[i].q)}` : `ходит ${names.get(players[i].q)}`;
    const parts = {
      sub: `Ход ${game.turnNumber || 1} · ${now}`,
      roster: players.map((p, k) => `<li style="--side-color:${TEAM_COLOR[p.q]}">${flag(p.q)}<b>${names.get(p.q)}</b>`
        + `<span>${NAMES[p.q]}${p.bot ? ' · бот' : ''}</span></li>`).join(''),
      fleets: table(players, names, fleetRows),
      dice: table(players, names, diceRows),
    };
    const key = JSON.stringify(parts);
    if (key === shown) return;
    shown = key;
    sub.innerHTML = parts.sub; roster.innerHTML = parts.roster;
    fleetTable.innerHTML = parts.fleets; diceTable.innerHTML = parts.dice;
  }

  function open() {
    if (!game?.players || dialog.open) return;
    shown = '';
    render();
    dialog.showModal();
  }
  function close() { if (dialog.open) dialog.close(); }
  // the numbers follow the game while the window is open: bots and players online go on playing
  function refresh() { if (dialog.open && game?.players) render(); }

  button.addEventListener('click', open);
  // a click on the dimmed board round the window closes it, as the × and Escape do
  dialog.addEventListener('click', (ev) => {
    const r = dialog.getBoundingClientRect();
    if (ev.target === dialog && (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom)) close();
  });
  return { open, close, refresh };
}
