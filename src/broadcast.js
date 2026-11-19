// Broadcast graphics for a shared board. Live notices and handoff summaries share one slot per statistic.
function createFleetBroadcast(rail) {
  const titles = {
    ready: 'Кораблей в строю',
    field: 'Кораблей в поле',
    prison: 'Кораблей в плену',
    parade: 'Кораблей на параде',
  };
  const pending = new Map(), visible = new Map();
  const context = document.createElement('div');
  context.className = 'stat-context'; context.hidden = true; rail.append(context);

  function snapshot() {
    const fleets = new Map(game.players.map(({q}) => [q, {ready: 0, field: 0, prison: 0, parade: 0, heldBy: {}}]));
    for (const ship of ships) {
      const fleet = fleets.get(ship.q);
      if (!fleet) continue;
      const slot = ship.slot;
      if (slot.prison) {
        fleet.prison++;
        fleet.heldBy[slot.q] = (fleet.heldBy[slot.q] || 0) + 1;
      } else if (ship.state === 'ok') {
        fleet.ready++;
      }
      if (slot.field != null) fleet.field++; // Numbered cells and bays have a field, parade places have a star.
      if (slot.star) fleet.parade++;
    }
    return fleets;
  }

  function flag(q) {
    return `<img class="stat-flag" src="${FLAG_URL[q]}" alt="${NAMES[q]}">`;
  }
  function fill(card, kind, actors, recap, fleets) {
    const players = game.players;
    const names = new Map(players.map((p, i) => [p.q, escHTML(playerName(p, i))]));
    const captors = kind === 'prison' ? players.filter(p => players.some(owner => fleets.get(owner.q).heldBy[p.q])) : [];
    const byline = recap ? 'Итоги хода' : 'Сейчас';
    const columns = captors.map(p => `<th scope="col" title="В плену у ${names.get(p.q)} · ${NAMES[p.q]}"><span class="sr-only">В плену у ${names.get(p.q)}, </span>${flag(p.q)}</th>`).join('');
    const head = kind === 'prison' ? `<thead><tr><th scope="col">У кого в плену</th>${columns}<th scope="col" title="Всего в плену">Σ</th></tr></thead>` : '';
    let foot = '';
    if (captors.length) {
      const totals = captors.map(c => players.reduce((sum, p) => sum + (fleets.get(p.q).heldBy[c.q] || 0), 0));
      foot = `<tfoot><tr><th scope="row">Пленили</th>${totals.map(n => `<td>${n}</td>`).join('')}<td class="stat-total">${totals.reduce((sum, n) => sum + n, 0)}</td></tr></tfoot>`;
    }
    const rows = players.map(p => {
      const fleet = fleets.get(p.q);
      const counts = captors.map(c => `<td class="held-count">${fleet.heldBy[c.q] || '·'}</td>`).join('');
      return `<tr data-side="${p.q}"><th scope="row" title="${names.get(p.q)} · ${NAMES[p.q]}"><span class="stat-player">${flag(p.q)}<span>${names.get(p.q)}</span></span></th>${counts}<td class="stat-total">${fleet[kind]}</td></tr>`;
    }).join('');
    card.dataset.stage = recap ? 'recap' : 'live';
    card.style.setProperty('--side-color', TEAM_COLOR[actors[0]]);
    const attribution = actors.map(q => names.get(q)).join(' и ');
    card.innerHTML = `<div class="stat-byline"><span>${byline}</span><span>${attribution}</span></div><h3 id="stat-${kind}">${titles[kind]}</h3><table aria-labelledby="stat-${kind}">${head}<tbody>${rows}</tbody>${foot}</table>`;
  }
  function show(kind, actor, recap, fleets, seconds) {
    let notice = visible.get(kind);
    if (!notice) {
      const card = document.createElement('section');
      card.className = 'stat-card'; card.dataset.stat = kind;
      rail.append(card);
      notice = {card}; visible.set(kind, notice);
    }
    // A trophy sailor and the payer can finish in the same handoff. Credit both on a shared statistic.
    const actors = recap && notice.recap && notice.turn === game.turnNumber ? [...new Set([...notice.actors, actor])] : [actor];
    Object.assign(notice, {actors, recap, turn: game.turnNumber, left: seconds});
    notice.card.classList.remove('stat-out');
    fill(notice.card, kind, actors, recap, fleets);
  }

  function layout() {
    rail.hidden = !visible.size;
    const root = document.getElementById('hud');
    if (rail.hidden) { root.style.removeProperty('--stat-side'); return; }
    const notices = [...visible.values()], first = notices[0];
    const common = notices.length > 1 && notices.every(n => n.recap === first.recap && n.actors.join() === first.actors.join());
    context.hidden = !common; rail.classList.toggle('shared-context', common);
    if (common) {
      const byline = first.card.querySelector('.stat-byline');
      if (context.textContent !== byline.textContent) context.replaceChildren(byline.cloneNode(true));
      context.style.setProperty('--side-color', TEAM_COLOR[first.actors[0]]);
    }
    const W = window.innerWidth, H = window.innerHeight;
    const top = Math.ceil(document.getElementById('hud-bar').getBoundingClientRect().bottom) + 5;
    const side = W >= 520 && W > H;
    const rowHeight = 54 + game.players.length * 20;
    const columns = visible.size > 1 && (!side || visible.size * rowHeight > H - top - 12) ? 2 : 1;
    rail.dataset.dock = side ? 'side' : 'top';
    rail.style.top = top + 'px';
    rail.style.setProperty('--stat-cols', columns);
    // On a phone use the width of the top strip. In landscape keep the commentary beside the rail.
    const width = columns === 1 ? Math.min(208, Math.max(151, W * 0.20)) : Math.min(370, Math.max(250, W * 0.43));
    rail.style.width = (side ? width : columns === 1 ? Math.min(228, W - 12) : W - 12) + 'px';
    if (!side) root.style.removeProperty('--stat-side');
    const captionTop = document.querySelector('.hud-bottom').getBoundingClientRect().top;
    const room = side ? H - top - 5 : Math.max(45, Math.min(H * 0.40, captionTop - top - Math.min(120, H * 0.24)));
    rail.classList.remove('stat-tight');
    if (rail.offsetHeight > room) rail.classList.add('stat-tight');
    const scale = Math.min(1, Math.max(1, room) / Math.max(1, rail.offsetHeight));
    rail.style.transform = scale < 1 ? `scale(${scale})` : '';
    if (side) root.style.setProperty('--stat-side', (width * scale + 14) + 'px');
  }
  function changed() { refitViewport(); }
  function afterAction(actor, action, before) {
    const after = snapshot(), kinds = [];
    if (action.kind === 'repair') kinds.push('ready');
    if (game.players.some(p => before.get(p.q).field !== after.get(p.q).field)) kinds.push('field');
    if (action.victims?.length) kinds.push('prison');
    if (game.players.some(p => before.get(p.q).parade !== after.get(p.q).parade)) kinds.push('parade');
    // An open live score also reflects a ransom or a capture that changes an earlier statistic.
    for (const [kind, n] of visible) {
      if (!n.recap && !kinds.includes(kind) && game.players.some(p => before.get(p.q)[kind] !== after.get(p.q)[kind])) {
        fill(n.card, kind, n.actors, false, after);
      }
    }
    if (!kinds.length) return;
    if (!pending.has(actor)) pending.set(actor, new Set());
    for (const kind of kinds) {
      pending.get(actor).add(kind);
      if (game.players.length > 1) show(kind, actor, false, after, 5.5);
    }
    if (game.players.length > 1) changed();
  }
  function finish(actor) {
    const kinds = pending.get(actor);
    if (!kinds) return;
    const fleets = snapshot();
    for (const kind of kinds) show(kind, actor, true, fleets, 6 + kinds.size);
    pending.delete(actor);
    changed();
  }
  function tick(dt, holdingBoard) {
    let removed = false;
    for (const [kind, n] of visible) {
      n.left -= dt;
      if (holdingBoard) continue; // Keep the cell under a pressed pointer steady until release.
      if (n.left <= 0) { n.card.remove(); visible.delete(kind); removed = true; }
      else if (n.left < 0.22) n.card.classList.add('stat-out');
    }
    if (removed) changed();
  }
  function clear() {
    pending.clear(); visible.clear(); rail.replaceChildren(context); layout();
  }
  return {snapshot, afterAction, finish, tick, clear, layout};
}
