import { createFleetRules, makeBotBoard } from '../src/fleet-rules.js';

// Follow the numbered decisions without the animation delays. Only the server's
// board can choose the account paid by the results RPC.
export function trackParty(players) {
  const board = makeBotBoard();
  const sides = new Set(players.map(p => p.q));
  const ships = players.flatMap(({ q }) => board.cells[q].s.map((_, i) => ({
    id: q + (i + 1), q, slot: board.shipyards[q],
  })));
  const { options } = createFleetRules({ ...board, ships }, q => sides.has(q));
  let turn = 0, jailer = null, dice = [], choices = new Map(), winner = null;
  const captured = new Set();

  function afterMove() {
    jailer = null;
    choices = options(players[turn].q, dice, false, captured).acts;
    if (!choices.size && dice[0].v !== dice[1].v) turn = (turn + 1) % players.length;
  }
  function move(ship, target) {
    const from = ship.slot;
    ship.slot = target.slot;
    if (!jailer) {
      for (const i of target.use) dice[i].used = true;
      if (target.victims?.length) captured.add(ship);
    }
    for (const victim of target.victims || []) victim.slot = board.prisons[ship.q];
    if (ship.slot.star && ships.every(s => s.q !== ship.q || s.slot.star)) {
      winner = players.find(p => p.q === ship.q).id;
      return;
    }
    if (target.kind === 'ransom') {
      jailer = players.find(p => p.q === from.q);
      choices = options(jailer.q, [{ v: 6 }], true).acts;
      if (choices.size) {
        const [replyShip, targets] = choices.entries().next().value;
        if (choices.size === 1 && targets.length === 1) move(replyShip, targets[0]);
        return;
      }
    }
    afterMove();
  }
  return function apply(action) {
    if (winner) return winner;
    const actor = jailer ?? players[turn];
    if (action.kind === 'skip') {
      if (action.id !== actor.id) return;
      if (jailer) afterMove();
      else { choices.clear(); turn = (turn + 1) % players.length; }
    } else if (action.by === actor.id) {
      if (action.kind === 'throw' && !choices.size) {
        if (action.res.some(d => d.out || d.ship || d.cocked || d.moving)) return;
        dice = action.res.map(d => ({ v: d.v, used: false }));
        captured.clear();
        afterMove();
      } else if (action.kind === 'act') {
        const ship = ships.find(s => s.id === action.ship);
        const target = choices.get(ship)?.[action.k];
        if (target) move(ship, target);
      }
    }
    return winner;
  };
}
