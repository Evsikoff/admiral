// The commentator: one narrator per fleet, each with its own voice and manner (tools/commentator_data.py).
// Every line is pre-voiced; the caption is the same text, then what a recorded voice cannot know:
// names, dice, routes. A line is spoken by the fleet whose turn it is, except where noted.
// lines: { '<event>_<nation>': [variant text, ...] }, the clip <bucket>/<NN>.mp3 is variant NN.
function createCommentator({ sound, say, lines, swatch, NAMES, DIE_NOM, DIE_TWO }) {
  // a variant of the bucket: the clip starts playing, its text comes back for the caption
  function pick(q, event, interrupt) {
    const bucket = `${event}_${q}`, list = lines[bucket] || [];
    const idx = sound.speak(bucket, list.length, { interrupt });
    return list.length ? list[idx % list.length] : '';
  }
  const detail = (t) => (t ? ` <span class="cap-detail">${t}</span>` : '');
  // the caption starts with the colour of the fleet whose narrator speaks
  function line(q, event, { interrupt = false, lead = '', more = '', cls = '' } = {}) {
    say(`${swatch(q)}${lead}${pick(q, event, interrupt)}${detail(more)}`, cls);
  }

  return {
    // voice of the fleet that moves first
    gameStart(q, rosterHTML) {
      line(q, 'game_start', { interrupt: true, more: `На воде: ${rosterHTML}.` });
    },
    // the player's first turn explains the throw; later turns only say whose turn it is
    turnStart(q, nameHTML, interrupt, first) {
      line(q, first ? 'turn_first' : 'turn', { interrupt, more: `(${nameHTML})`, cls: 'turn' });
    },
    // the reason and the request to throw again are one line
    foulRetry(kind, whyText, q) {
      line(q, `foul_${kind}`, { interrupt: true, more: `(${whyText})`, cls: 'bad' });
    },
    doubleBonus(q) {
      line(q, 'double_bonus', { cls: 'turn' });
    },
    // after a counted throw (first) or after a step: what can be done now.
    // explainSix: the first time this player has no six while every ship is at the shipyard
    afterRollOrStep({ q, first, dice, leftV, o, detail: optionsText, prompt, explainSix }) {
      let lead = '';
      let interrupt = first;
      if (first && dice) {
        const [a, b] = dice;
        if (a === b) {
          lead = `${pick(q, 'roll_double', true)}${detail(`(${DIE_TWO[a]})`)} `;
          interrupt = false;
        } else {
          lead = `На костях ${DIE_NOM[a]} и ${DIE_NOM[b]}. `;
        }
      }

      if (!o.acts.size) {
        if (first) {
          const event = !o.sailing && !o.held && !o.six
            ? (explainSix ? 'no_move_empty_first' : 'no_move_empty')
            : !o.six ? 'no_move_blocked' : 'no_move_with_six';
          line(q, event, { interrupt, lead, cls: 'good' });
        } else if (leftV) {
          line(q, o.held ? 'unspent_captured' : 'unspent_blocked', { more: `(осталась ${DIE_NOM[leftV]})` });
        }
        return;
      }

      if (!first) lead = `Осталась ${DIE_NOM[leftV]}. `;
      const event = o.held ? 'opt_captured_other'
        : o.movers && (o.repair || o.ransom) ? 'opt_move_and_six'
          : !o.movers && o.repair && !o.ransom ? 'opt_repair_only'
            : !o.movers ? 'opt_ransom_only'
              : first ? 'opt_sail_first' : 'opt_second_die';
      const more = [optionsText && `(${optionsText})`, prompt].filter(Boolean).join(' ');
      line(q, event, { interrupt, lead, more, cls: first ? 'good' : '' });
    },
    // q: the fleet of the ship that sails (on the jailer's six steps, the jailer)
    shipMove({ comp, q, fromHarbor, enteringParade, toBay, skippedNames, route, victimsText, hasVictims }) {
      const lead = comp ? 'Ответный трофейный ход! ' : '';
      const interrupt = !comp;
      if (hasVictims) {
        line(q, 'boarding', { interrupt, lead, more: `(${route}; в плену: ${victimsText})`, cls: 'cap' });
      } else if (enteringParade) {
        line(q, 'parade', { interrupt, lead, more: `(${route})` });
      } else if (fromHarbor) {
        line(q, 'harbor', { interrupt, lead, more: `(${route})` });
      } else if (toBay) {
        line(q, 'move_bay', { interrupt, lead, more: `(${route})` });
      } else if (skippedNames) {
        line(q, 'move_bypass', { interrupt, lead, more: `(в обход ${skippedNames}; ${route})` });
      } else {
        line(q, 'sail', { interrupt, lead, more: `(${route})` });
      }
    },
    repair(q) {
      line(q, 'repair', { interrupt: true });
    },
    ransom(q, fromText, X) {
      line(q, 'ransom', { interrupt: true, more: `(корабль возвращается ${fromText} на верфь; шесть шагов получает ${NAMES[X]})` });
    },
    // the jailer's six steps: voice of the jailer's fleet X
    compNone(X) {
      line(X, 'comp_none');
    },
    compAuto(X) {
      line(X, 'comp_auto');
    },
    compChoose(X, nameHTML) {
      line(X, 'comp_choose', { more: `(выбирает ${nameHTML})`, cls: 'turn' });
    },
    // q: the fleet of the ship that has just sailed; only the first chase of a move is voiced
    chase(kind, text, voiceAllowed, q) {
      if (voiceAllowed) line(q, `chase_${kind}`, { more: text, cls: 'warn' });
      else say(text, 'warn');
    },
    victory(q, nameHTML) {
      line(q, 'victory', { interrupt: true, more: `(${nameHTML})`, cls: 'win' });
    },
  };
}
