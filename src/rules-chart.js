// Frame pieces of the game's board in 2D so the examples can play before the 3D scene loads.
function createRulesChart(canvas, data) {
  const ctx = canvas.getContext('2d');
  const width = 720, height = 378, boardSize = 1500;
  const gold = '#ffd488', teal = '#8df3dc', red = '#ff9b91', ink = '#082630';
  const frame = [0, 0, width, height], left = [0, 0, 355, height], right = [365, 0, 355, height];
  const compareLeft = [0, 52, 355, height - 52], compareRight = [365, 52, 355, height - 52];
  const { ru, en, nl } = data.fields;
  const { shipyard, harbor, prison } = data.zones.ru;
  const load = (src) => { const image = new Image(); image.src = src; return image; };
  let board;
  const ships = { intact: load(data.ship), wreck: load(data.wreck) };
  const ready = (image) => image.complete && image.naturalWidth > 0;
  const clamp = (n, min = 0, max = 1) => Math.max(min, Math.min(n, max));
  const numbered = (sector, from, to) => Array.from({ length: to - from + 1 }, (_, i) => sector[from + i]);

  function mapView(points, rect = frame, padding = 70) {
    const [x, y, w, h] = rect;
    const xs = points.map(([u]) => u), ys = points.map(([, v]) => v);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const zoom = clamp(Math.min(w / (maxX - minX + padding * 2), h / (maxY - minY + padding * 2)),
                       Math.max(w, h) / boardSize, 1.45);
    const viewW = w / zoom, viewH = h / zoom;
    const srcX = clamp((minX + maxX - viewW) / 2, 0, boardSize - viewW);
    const srcY = clamp((minY + maxY - viewH) / 2, 0, boardSize - viewH);
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 10);
    ctx.clip();
    if (ready(board)) {
      const ratio = board.naturalWidth / boardSize;
      ctx.drawImage(board, srcX * ratio, srcY * ratio, viewW * ratio, viewH * ratio, x, y, w, h);
    }
    const shade = ctx.createLinearGradient(0, y, 0, y + h);
    shade.addColorStop(0, '#051d2a42');
    shade.addColorStop(0.35, '#051d2a0d');
    shade.addColorStop(0.75, '#051d2a0d');
    shade.addColorStop(1, '#051d2a38');
    ctx.fillStyle = shade;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
    return {
      zoom,
      project: ([u, v]) => [x + (u - srcX) * zoom, y + (v - srcY) * zoom],
    };
  }

  function text(value, x, y, color) {
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(value, x, y);
  }
  function pill(value, x, y, color = gold) {
    ctx.font = '700 25px "Segoe UI", sans-serif';
    const half = ctx.measureText(value).width / 2 + 14;
    x = clamp(x, half + 8, width - half - 8);
    y = clamp(y, 25, height - 25);
    ctx.beginPath();
    ctx.roundRect(x - half, y - 20, half * 2, 40, 8);
    ctx.fillStyle = '#092632f2';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    ctx.stroke();
    text(value, x, y, color);
  }
  function circle(x, y, radius, fill, edge, lineWidth = 2) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (edge) { ctx.strokeStyle = edge; ctx.lineWidth = lineWidth; ctx.stroke(); }
  }
  function ring([x, y], radius, color, fill = '#09263238') {
    circle(x, y, radius, fill, '#08252eaa', 6);
    circle(x, y, radius, null, color, 2.5);
  }
  function cells(view, sector, from, to, color = teal) {
    const radius = clamp(view.zoom * 23, 14, 23);
    ctx.font = `700 ${Math.max(22, radius)}px "Segoe UI", sans-serif`;
    numbered(sector, from, to).forEach((point, i) => {
      const [x, y] = view.project(point);
      ring([x, y], radius, color, ink);
      text(from + i, x, y, color);
    });
  }
  function zone(view, point, label, color = teal, radius = 48, labelOffset = 0) {
    const [x, y] = view.project(point);
    ring([x, y], radius * view.zoom, color);
    pill(label, x + labelOffset, y - radius * view.zoom - 24, color);
  }
  function die(value, x, y, color = gold, size = 45) {
    ctx.beginPath();
    ctx.roundRect(x - size / 2, y - size / 2, size, size, 8);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2;
    ctx.stroke();
    const pips = [[-1, -1], [1, 1], [1, -1], [-1, 1], [-1, 0], [1, 0]];
    const spots = value === 6 ? pips : pips.slice(0, value - value % 2);
    if (value % 2) spots.push([0, 0]);
    for (const [a, b] of spots) circle(x + a * size / 4, y + b * size / 4, size / 14, ink);
  }
  function ship([x, y], color = teal, wreck = false, size = 72) {
    circle(x, y + 3, size * 0.24, '#06212cef', color);
    const image = ships[wreck ? 'wreck' : 'intact'];
    if (ready(image)) ctx.drawImage(image, x - size / 2, y - size * 0.57, size, size);
    else {
      ctx.font = '700 20px "Segoe UI", sans-serif';
      text('◆', x, y, color);
    }
  }
  function stroke(points, color, weight, dash = []) {
    ctx.beginPath();
    ctx.moveTo(...points[0]);
    for (const p of points.slice(1)) ctx.lineTo(...p);
    ctx.strokeStyle = color;
    ctx.lineWidth = weight;
    ctx.setLineDash(dash);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  function arrow(points, color, dash = [], inset = 0) {
    const [endX, endY] = points.at(-1), [a, b] = points.at(-2);
    const angle = Math.atan2(endY - b, endX - a);
    const offset = Math.min(inset, Math.hypot(endX - a, endY - b) / 2);
    const x = endX - Math.cos(angle) * offset, y = endY - Math.sin(angle) * offset;
    const line = [...points.slice(0, -1), [x, y]];
    const tip = (offset) => [x - Math.cos(angle + offset) * 13, y - Math.sin(angle + offset) * 13];
    const head = [tip(-0.55), [x, y], tip(0.55)];
    stroke(line, '#082630bd', 7);
    stroke(head, '#082630bd', 7);
    stroke(line, color, 3.4, dash);
    stroke(head, color, 3.4);
  }
  function onPath(path, progress) {
    // Sample by distance so a ring arc and a straight leg take proportional time.
    const lengths = path.slice(1).map(([x, y], i) => Math.hypot(x - path[i][0], y - path[i][1]));
    let distance = clamp(progress) * lengths.reduce((sum, length) => sum + length, 0);
    let i = 0;
    while (i < lengths.length - 1 && distance > lengths[i]) distance -= lengths[i++];
    const t = lengths[i] ? distance / lengths[i] : 0;
    return path[i].map((n, axis) => n + (path[i + 1][axis] - n) * t);
  }
  function lane(view, sector, from, to, color = teal) {
    const path = numbered(sector, from, to).map(view.project);
    arrow(path, color, [], 25);
    cells(view, sector, from, to, color);
    return path;
  }
  function stars(view) {
    for (const point of ru.stars) ring(view.project(point), 25 * view.zoom, gold);
  }

  function fleet(cue, progress) {
    const view = mapView([shipyard, harbor, ru[13], ...ru.stars], frame, 112);
    zone(view, shipyard, 'Верфь');
    stars(view);
    const [x, y] = view.project(ru.stars[2]);
    pill('Парад', x, y - 42);
    if (cue === 0) {
      const [sx, sy] = view.project(shipyard);
      const offsets = [[-26, -22], [26, -22], [-37, 14], [0, 14], [37, 14]];
      for (const [dx, dy] of offsets) ship([sx + dx, sy + dy], teal, true, 54);
      return;
    }
    const filled = Math.min(5, Math.floor(progress * 5.99));
    for (const point of ru.stars.slice(5 - filled)) ship(view.project(point));
    pill(`${filled} из 5`, x, y + 46, gold);
  }
  function departure(cue, progress) {
    const view = mapView([shipyard, harbor, ru[1]], frame, 120);
    const [sx, sy] = shipyard, [hx, hy] = harbor;
    const transfer = [shipyard, [sx + 76, sy + 49], [hx - 80, hy + 49], harbor];
    const path = (cue ? [harbor, ru[1]] : transfer).map(view.project);
    arrow(path, teal, cue ? [] : [6, 7], cue ? 26 : 0);
    zone(view, shipyard, 'Верфь', cue ? gold : teal);
    zone(view, harbor, 'Гавань', teal, 48, cue ? -90 : 0);
    cells(view, ru, 1, 1, cue ? teal : gold);
    die(cue ? 1 : 6, 47, 43);
    ship(onPath(path, progress), teal, cue === 0 && progress < 0.78);
  }
  function dice(cue, progress) {
    if (cue === 0) {
      const section = numbered(ru, 7, 13);
      const a = mapView(section, compareLeft, 60), b = mapView(section, compareRight, 60);
      const two = lane(a, ru, 7, 9);
      const three = lane(a, ru, 10, 13, gold);
      const five = lane(b, ru, 7, 12);
      ship(onPath(two, clamp(progress * 2)));
      ship(onPath(three, clamp(progress * 2 - 1)), gold);
      ship(onPath(five, progress));
      pill('По отдельности', 178, 27);
      pill('Вместе · 5 клеток', 542, 27);
      die(2, 145, 338, teal);
      die(3, 208, 338);
      die(2, 500, 338, teal);
      die(3, 584, 338, teal);
      ctx.font = '700 30px "Segoe UI", sans-serif';
      text('+', 542, 338, ink);
    } else if (cue === 1) {
      const view = mapView(numbered(ru, 10, 13), frame, 128);
      const path = lane(view, ru, 10, 13);
      ship(onPath(path, progress));
      die(2, 46, 43, '#a1b2af');
      stroke([[28, 58], [64, 28]], ink, 4);
      die(3, 102, 43);
    } else {
      mapView([ru[7], ru[8], ru[9], ru[10], ru[11], prison], frame, 110);
      ctx.fillStyle = '#06243068';
      ctx.fillRect(0, 0, width, height);
      die(3, 195, 178, gold, 58);
      die(3, 272, 178, gold, 58);
      arrow([[326, 178], [396, 178]], teal);
      die(2, 453, 178, teal, 58);
      die(5, 530, 178, teal, 58);
      pill('Дубль', 234, 246);
      pill('Новый бросок', 492, 246, teal);
    }
  }

  const [cx, cy] = data.center;
  const angle = ([x, y]) => Math.atan2(y - cy, x - cx);
  const startAngle = angle(ru[6]);
  const sweep = (angle(en[7]) - startAngle + Math.PI * 2) % (Math.PI * 2);
  const ringArc = Array.from({ length: 13 }, (_, i) => {
    const t = startAngle + sweep * i / 12;
    return [cx + Math.cos(t) * data.radius, cy + Math.sin(t) * data.radius];
  });
  function course(cue, progress) {
    if (!cue) {
      const area = [ru[6], nl[7], en[7], data.center];
      const open = mapView(area, compareLeft, 73), closed = mapView(area, compareRight, 73);
      for (const [view, next, path, color] of [
        [open, nl, [ru[6], nl[7]], teal],
        [closed, en, [ru[6], ...ringArc, en[7]], gold],
      ]) {
        const route = path.map(view.project);
        arrow(route, color, [], 21);
        cells(view, ru, 6, 6, color);
        cells(view, next, 7, 7, color);
        ship(onPath(route, progress), teal, false, 58);
      }
      const [x, y] = closed.project(nl[7]);
      ring([x, y], 17, red, ink);
      ctx.font = '700 23px "Segoe UI", sans-serif';
      text('×', x, y, red);
      pill('Сектор открыт', 178, 27, teal);
      pill('Сектор закрыт', 542, 27, gold);
      return;
    }
    const other = mapView([en[13], en[1], en[2]], compareLeft, 107);
    const home = mapView([ru[13], ...ru.stars.slice(0, 2)], compareRight, 85);
    const a = [en[13], en[1]].map(other.project);
    const b = [ru[13], ...ru.stars.slice(0, 2)].map(home.project);
    arrow(a, gold, [], 24);
    arrow(b, teal, [], 22);
    cells(other, en, 13, 13, gold);
    cells(other, en, 1, 1, gold);
    cells(home, ru, 13, 13);
    ru.stars.slice(0, 2).forEach((point) => ring(home.project(point), 25 * home.zoom, teal));
    ship(onPath(a, progress), teal, false, 62);
    ship(onPath(b, progress), teal, false, 62);
    pill('Чужой сектор', 178, 27, gold);
    pill('Свой сектор', 542, 27, teal);
  }
  function capture(cue, progress) {
    const fields = numbered(ru, 7, 10);
    const view = mapView([...fields, prison], frame, 88);
    const path = fields.map(view.project);
    const captor = view.project(prison);
    die(3, 46, 43);
    if (!cue) {
      const blocked = onPath(path.slice(1, 3), 0.73);
      arrow([path[0], path[1], blocked], red, [5, 7]);
      cells(view, ru, 7, 10, gold);
      ship(path[0]);
      ship(path[2], red);
      pill('Путь закрыт', path[2][0] - 15, path[2][1] - 52, red);
      return;
    }
    if (cue === 1) arrow(path, teal, [], 25);
    cells(view, ru, 7, 10);
    zone(view, prison, 'Плен', red, 49);
    if (cue === 1) {
      const captured = clamp((progress - 0.57) / 0.43);
      if (captured > 0) arrow([path[3], captor], red, [5, 7]);
      ship(onPath([path[3], captor], captured), red, captured > 0.5);
      ship(onPath(path, clamp(progress / 0.57)));
    } else {
      ship(path[3]);
      ship(captor, red, true);
      pill('Нужен новый бросок', 360, 32, gold);
    }
  }
  function bay(cue, progress) {
    const view = mapView([...numbered(ru, 1, 3), ru.b], frame, 90);
    const path = (cue ? [ru.b, ru[3]] : [ru[1], ru.b]).map(view.project);
    stroke(numbered(ru, 1, 3).map(view.project), '#194557bf', 2.5, [5, 6]);
    arrow(path, teal, [], 25);
    cells(view, ru, 1, 3, gold);
    zone(view, ru.b, 'Бухта', teal, 34, cue ? -74 : 0);
    ship(onPath(path, progress));
  }
  function ransom(cue, progress) {
    if (cue === 0) {
      const prison = data.zones.nl.prison;
      const a = mapView([prison], left, 132), b = mapView([shipyard], right, 132);
      const path = [a.project(prison), b.project(shipyard)];
      arrow(path, gold, [5, 8]);
      zone(a, prison, 'Чужой Плен', red, 52);
      zone(b, shipyard, 'Своя Верфь');
      ship(onPath(path, progress), teal, true);
      die(6, 360, 128, gold, 56);
      return;
    }
    const [sector, end, color] = cue === 1 ? [nl, 13, gold] : [ru, 10, teal];
    const view = mapView(numbered(sector, 7, end), frame, 88);
    const path = lane(view, sector, 7, end, color);
    ship(onPath(path, progress), color);
    die(end - 7, 46, 43, color);
  }
  function parade(cue, progress) {
    const view = mapView([ru[13], ...ru.stars], frame, 108);
    const path = [ru[13], ...ru.stars].map(view.project);
    const filled = cue ? Math.floor(5 * progress) : 0;
    const open = path.slice(0, 6 - filled);
    if (open.length > 1) arrow(open, teal, [], 26);
    cells(view, ru, 13, 13);
    stars(view);
    path.slice(6 - filled).forEach((point) => ship(point));
    if (open.length > 1) ship(onPath(open, cue ? 5 * progress - filled : progress));
    const [x, y] = view.project(ru.stars[2]);
    pill(cue ? `${filled} из 5` : 'Парад', x, y + 48);
    if (!cue) {
      const [endX, endY] = path.at(-1);
      ring([endX + 41, endY], 14, red, ink);
      ctx.font = '700 21px "Segoe UI", sans-serif';
      text('×', endX + 41, endY, red);
    }
  }
  const diagrams = { fleet, harbor: departure, dice, course, capture, bay, ransom, parade };
  return (id, cue, progress) => {
    board ??= load(window.ADMIRAL?.board || 'assets/board.jpg');
    const scale = canvas.width / width;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    diagrams[id](cue, clamp((progress - 0.09) / 0.68));
  };
}
