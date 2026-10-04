/**
 * Effective Critical Hits for the dnd5e system.
 *
 * On a critical hit the dice are rolled as normal (RAW). If the result is lower than the maximum damage the same
 * attack could deal on a normal hit, the damage is raised to that maximum.
 *
 * Example: Greatsword 2d6 + 4. Crit rolls 4d6 + 4. If that totals less than 16 (2×6 + 4), it becomes 16.
 *
 * The threshold is checked against the attack's TOTAL damage across all damage types. Only if the total falls short
 * is a bonus added, and it goes to the damage type(s) that rolled below their own normal-hit maximum, so the total
 * lands exactly on the threshold (damage parts are checked in order, each capped at its own normal-hit maximum). Crit-only extra dice (Savage Attacks, Brutal Strike, an item's extra critical
 * damage) count toward the critical roll but not toward the threshold.
 */

const MODULE_ID = "effective-crits";
const FLAG = "effectiveCrit";

/** Flavor text on the bonus term. Kept un-localized so it can be recognised reliably if the roll is ever re-parsed. */
const TERM_FLAVOR = "Effective Crit";

/* -------------------------------------------- */
/*  Setup                                       */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "enabled", {
    name: "EFFECTIVECRITS.Settings.Enabled.Name",
    hint: "EFFECTIVECRITS.Settings.Enabled.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "showNote", {
    name: "EFFECTIVECRITS.Settings.ShowNote.Name",
    hint: "EFFECTIVECRITS.Settings.ShowNote.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  patchDamageRoll(CONFIG.Dice.DamageRoll);
});

/** Why the module switched itself off, if it did. Shown to the GM once the world is ready. */
let disabledReason = null;

Hooks.once("ready", () => {
  if ( disabledReason && game.user.isGM ) {
    ui.notifications.warn(game.i18n.format("EFFECTIVECRITS.Disabled", { reason: disabledReason }), { permanent: true });
  }
});

Hooks.on("dnd5e.renderChatMessage", addChatNote);

/* -------------------------------------------- */
/*  DamageRoll Patches                          */
/* -------------------------------------------- */

/** Marks a DamageRoll class as already patched, so the patches can never be applied twice. */
const PATCHED = Symbol.for(`${MODULE_ID}.patched`);

/**
 * Snapshot of each critical roll's terms from before the system doubled its dice. Kept outside roll.options so it
 * isn't saved into chat messages.
 * @type {WeakMap<Roll, object[]>}
 */
const baseTermsByRoll = new WeakMap();

/**
 * Wrap the system's DamageRoll so that critical rolls remember their pre-critical terms, and so that the threshold is
 * applied once all of an attack's damage parts have been rolled (before the chat card is created).
 *
 * If anything this relies on is missing (for example after a dnd5e update renamed a method), nothing is patched and
 * the GM is warned. Damage rolls then work exactly as they do without the module.
 * @param {typeof Roll} DamageRoll
 */
function patchDamageRoll(DamageRoll) {
  if ( !DamageRoll ) {
    disabledReason = "CONFIG.Dice.DamageRoll was not found";
    console.error(`${MODULE_ID} | ${disabledReason}; is the dnd5e system active?`);
    return;
  }
  if ( DamageRoll[PATCHED] ) return;

  const proto = DamageRoll.prototype;
  const required = {
    "DamageRoll#configureDamage": proto.configureDamage,
    "DamageRoll#evaluate": proto.evaluate,
    "DamageRoll.buildEvaluate": DamageRoll.buildEvaluate,
    "NumericTerm": foundry.dice?.terms?.NumericTerm,
    "OperatorTerm": foundry.dice?.terms?.OperatorTerm,
    "RollTerm.fromData": foundry.dice?.terms?.RollTerm?.fromData
  };
  const missing = Object.entries(required).filter(([, value]) => typeof value !== "function").map(([name]) => name);
  if ( missing.length ) {
    disabledReason = `missing ${missing.join(", ")}`;
    console.error(`${MODULE_ID} | Not patching damage rolls: ${disabledReason}. Critical hits will follow the rules as `
      + "written until the module is updated.");
    return;
  }

  // The system doubles the dice inside configureDamage, so capture the terms just before that happens.
  wrap(DamageRoll, "prototype", "configureDamage", function(wrapped, ...args) {
    if ( !this.options.configured && this.isCritical ) {
      this.options[FLAG] = { baseFormula: this.formula };
      try {
        baseTermsByRoll.set(this, this.terms.map(t => foundry.utils.deepClone(t.toJSON())));
      } catch(err) {
        console.warn(`${MODULE_ID} | Could not snapshot damage terms; using the formula instead`, err);
      }
    }
    return wrapped(...args);
  });

  wrap(DamageRoll, "prototype", "evaluate", async function(wrapped, ...args) {
    const state = prepareForEvaluation(this);
    const result = await wrapped(...args);
    if ( state ) recordPart(this, state, await nonCritMaximum(this, state));
    return result;
  });

  if ( typeof proto.evaluateSync === "function" ) {
    wrap(DamageRoll, "prototype", "evaluateSync", function(wrapped, ...args) {
      const state = prepareForEvaluation(this);
      const result = wrapped(...args);
      if ( state ) recordPart(this, state, nonCritMaximumSync(this, state));
      return result;
    });
  }

  // All damage parts of one attack are evaluated together here, before the chat card is created. This is where the
  // threshold is checked against the combined total.
  wrap(DamageRoll, null, "buildEvaluate", async function(wrapped, rolls, config={}, ...rest) {
    const result = await wrapped(rolls, config, ...rest);
    if ( config?.evaluate !== false ) {
      try {
        applyGroupFloor(rolls ?? []);
      } catch(err) {
        console.warn(`${MODULE_ID} | Could not apply effective crit`, err);
      }
    }
    return result;
  });

  // Pull the top-up out of the flat modifier in the damage breakdown and show it as its own entry. Display only.
  if ( typeof proto.aggregateTerms === "function" ) {
    wrap(DamageRoll, "prototype", "aggregateTerms", function(wrapped, ...args) {
      const aggregate = wrapped(...args);
      try {
        separateBonusInBreakdown(this, aggregate);
      } catch(err) {
        console.warn(`${MODULE_ID} | Could not separate bonus in damage breakdown`, err);
      }
      return aggregate;
    });
  }

  DamageRoll[PATCHED] = true;
  console.log(`${MODULE_ID} | DamageRoll patched${useLibWrapper() ? " via libWrapper" : ""}`);
}

/* -------------------------------------------- */

/**
 * Is libWrapper installed and active?
 * @returns {boolean}
 */
function useLibWrapper() {
  return (typeof globalThis.libWrapper?.register === "function") && !!game.modules.get("lib-wrapper")?.active;
}

/**
 * Wrap a method so the wrapper receives the original as its first argument. Uses libWrapper when it's available, so
 * other modules wrapping the same method are chained safely; otherwise wraps the method directly.
 * @param {Function} cls                 The DamageRoll class.
 * @param {"prototype"|null} where       "prototype" for instance methods, null for static methods.
 * @param {string} name                  Method name.
 * @param {Function} wrapper             function(wrapped, ...args), called with the roll (or class) as `this`.
 */
function wrap(cls, where, name, wrapper) {
  const target = where ? cls[where] : cls;
  if ( useLibWrapper() ) {
    const path = `CONFIG.Dice.DamageRoll${where ? `.${where}` : ""}.${name}`;
    globalThis.libWrapper.register(MODULE_ID, path, function(wrapped, ...args) {
      return wrapper.call(this, wrapped, ...args);
    }, "WRAPPER");
    return;
  }
  const original = target[name];
  target[name] = function(...args) {
    return wrapper.call(this, original.bind(this), ...args);
  };
}

/* -------------------------------------------- */

/**
 * Before a roll is evaluated, strip any bonus term left over from an earlier evaluation (e.g. a cloned or re-rolled
 * roll), and decide whether this roll should receive the floor.
 * @param {Roll} roll
 * @returns {object|null}  The stored state if the floor should be applied, otherwise null.
 */
function prepareForEvaluation(roll) {
  if ( roll._evaluated ) return null;
  const state = roll.options?.[FLAG];
  if ( !state?.baseFormula ) return null;
  stripBonusTerm(roll);
  if ( !roll.isCritical || !game.settings.get(MODULE_ID, "enabled") ) return null;
  return state;
}

/* -------------------------------------------- */

/**
 * Remove a previously added "+ N[Effective Crit]" term from an unevaluated roll.
 * @param {Roll} roll
 */
function stripBonusTerm(roll) {
  const { NumericTerm, OperatorTerm } = foundry.dice.terms;
  const index = roll.terms.findIndex(t => (t instanceof NumericTerm)
    && (t.options?.[FLAG] || (t.options?.flavor === TERM_FLAVOR)));
  if ( index < 0 ) return;
  const prev = roll.terms[index - 1];
  const start = (prev instanceof OperatorTerm) ? index - 1 : index;
  roll.terms.splice(start, index - start + 1);
  roll.resetFormula();
}

/* -------------------------------------------- */

/**
 * Fresh, unrolled copies of the roll's pre-critical terms. Copying the terms (the same way the system copies them)
 * keeps custom term types intact. Falls back to re-parsing the stored formula.
 * @param {Roll} roll
 * @param {object} state
 * @returns {RollTerm[]}
 */
function baseTermsFor(roll, state) {
  const { RollTerm } = foundry.dice.terms;
  const snapshot = baseTermsByRoll.get(roll);
  if ( snapshot ) {
    try {
      return snapshot.map(data => {
        const copy = foundry.utils.deepClone(data);
        if ( Array.isArray(copy.results) ) copy.results = [];
        copy.evaluated = false;
        return RollTerm.fromData(copy);
      });
    } catch(err) {
      console.warn(`${MODULE_ID} | Could not copy damage terms; using the formula instead`, err);
    }
  }
  return new foundry.dice.Roll(state.baseFormula).terms;
}

/**
 * Work out how to find the maximum of a list of terms. For ordinary formulas made only of dice and numbers joined by
 * + and -, added dice are maximized and subtracted dice are minimized, giving the true maximum (2d6 - 1d4 → 11).
 * Anything more complex (multiplication, parentheses, functions, unknown terms) returns null, and the whole formula
 * is maximized instead.
 * @param {RollTerm[]} terms
 * @returns {{term: RollTerm, sign: number}[]|null}
 */
function planMaximum(terms) {
  const { DiceTerm, NumericTerm, OperatorTerm } = foundry.dice.terms;
  const plan = [];
  let sign = 1;
  for ( const term of terms ) {
    if ( term instanceof OperatorTerm ) {
      if ( term.operator === "-" ) sign *= -1;
      else if ( term.operator !== "+" ) return null;
      continue;
    }
    if ( !(term instanceof DiceTerm) && !(term instanceof NumericTerm) ) return null;
    plan.push({ term, sign });
    sign = 1;
  }
  return plan;
}

/**
 * Normal-hit maximum of a critical roll's pre-critical terms.
 * @param {Roll} roll
 * @param {object} state
 * @returns {Promise<number|null>}
 */
async function nonCritMaximum(roll, state) {
  try {
    const { Roll } = foundry.dice;
    const terms = baseTermsFor(roll, state);
    const plan = planMaximum(terms);
    if ( !plan ) return (await Roll.fromTerms(terms).evaluate({ maximize: true, allowInteractive: false })).total;
    let total = 0;
    for ( const { term, sign } of plan ) {
      if ( term instanceof foundry.dice.terms.NumericTerm ) total += sign * term.number;
      else {
        const extreme = (sign > 0) ? { maximize: true } : { minimize: true };
        total += sign * (await Roll.fromTerms([term]).evaluate({ ...extreme, allowInteractive: false })).total;
      }
    }
    return total;
  } catch(err) {
    console.warn(`${MODULE_ID} | Could not compute the normal-hit maximum of "${state.baseFormula}"`, err);
    return null;
  }
}

/**
 * Synchronous version of nonCritMaximum.
 * @param {Roll} roll
 * @param {object} state
 * @returns {number|null}
 */
function nonCritMaximumSync(roll, state) {
  try {
    const { Roll } = foundry.dice;
    const terms = baseTermsFor(roll, state);
    const plan = planMaximum(terms);
    if ( !plan ) return Roll.fromTerms(terms).evaluateSync({ maximize: true, strict: false }).total;
    let total = 0;
    for ( const { term, sign } of plan ) {
      if ( term instanceof foundry.dice.terms.NumericTerm ) total += sign * term.number;
      else {
        const extreme = (sign > 0) ? { maximize: true } : { minimize: true };
        total += sign * Roll.fromTerms([term]).evaluateSync({ ...extreme, strict: false }).total;
      }
    }
    return total;
  } catch(err) {
    console.warn(`${MODULE_ID} | Could not compute the normal-hit maximum of "${state.baseFormula}"`, err);
    return null;
  }
}

/* -------------------------------------------- */

/**
 * Remember a damage part's own normal-hit maximum and what it rolled. Nothing is changed yet; the decision is made
 * once every part of the attack has been rolled (see applyGroupFloor).
 * @param {Roll} roll
 * @param {object} state
 * @param {number|null} floor
 */
function recordPart(roll, state, floor) {
  roll.options[FLAG] = { baseFormula: state.baseFormula, floor, rolled: roll.total, bonus: 0 };
}

/* -------------------------------------------- */

/**
 * Check the attack's total against the total normal-hit maximum. If it falls short, go through the damage parts in
 * order (the attack's first damage part first). Each part that rolled below its own normal-hit maximum receives the
 * amount still needed for the total to reach the threshold, but never more than it needs to reach its own maximum.
 * The total therefore lands exactly on the threshold.
 * @param {Roll[]} rolls  The evaluated damage rolls of a single attack.
 */
function applyGroupFloor(rolls) {
  if ( !game.settings.get(MODULE_ID, "enabled") ) return;
  const parts = rolls.filter(r => r._evaluated && r.isCritical
    && Number.isFinite(r.options?.[FLAG]?.floor) && Number.isFinite(r.options?.[FLAG]?.rolled));
  if ( !parts.length ) return;

  const floor = parts.reduce((sum, r) => sum + r.options[FLAG].floor, 0);
  const rolled = parts.reduce((sum, r) => sum + r.options[FLAG].rolled, 0);
  for ( const r of parts ) r.options[FLAG].group = { floor, rolled };

  let needed = floor - rolled;
  for ( const roll of parts ) {
    if ( needed <= 0 ) break;
    const gap = roll.options[FLAG].floor - roll.options[FLAG].rolled;
    if ( gap <= 0 ) continue;
    const bonus = Math.min(needed, gap);
    if ( addBonusTerm(roll, bonus) ) needed -= bonus;
  }
}

/* -------------------------------------------- */

/**
 * Add a visible "+ N[Effective Crit]" term to an evaluated roll. Using a real term (rather than only changing the
 * total) means the damage tray, damage-type grouping and resistances all see the raised number.
 * @param {Roll} roll
 * @param {number} bonus
 */
function addBonusTerm(roll, bonus) {
  // This relies on Foundry storing the evaluated total in roll._total. If that ever changes, leave the roll untouched.
  if ( !Number.isFinite(roll._total) || (roll.total !== roll._total) ) {
    console.warn(`${MODULE_ID} | Unexpected roll structure; leaving this critical as rolled`);
    return false;
  }
  const { NumericTerm, OperatorTerm } = foundry.dice.terms;
  const operator = new OperatorTerm({ operator: "+" });
  const term = new NumericTerm({ number: bonus, options: { flavor: TERM_FLAVOR, [FLAG]: true } });
  operator._evaluated = true;
  term._evaluated = true;

  roll.terms.push(operator, term);
  roll.resetFormula();
  roll._total += bonus;
  roll.options[FLAG].bonus = bonus;
  return true;
}

/* -------------------------------------------- */
/*  Damage Breakdown                            */
/* -------------------------------------------- */

/**
 * Is this term the bonus added by this module? Checks the flavor as well as the flag, since the system's damage-type
 * grouping copies terms and only some options may survive.
 * @param {RollTerm} term
 * @returns {boolean}
 */
function isBonusTerm(term) {
  return (term instanceof foundry.dice.terms.NumericTerm)
    && (term.options?.[FLAG] === true || term.options?.flavor === TERM_FLAVOR);
}

/**
 * Remove the bonus from the breakdown's flat modifier and add it as a separate labelled entry. The entry is added to
 * the dice list (the only list the system's template renders) and tidied up in the render hook below.
 * @param {Roll} roll
 * @param {object} aggregate  The breakdown produced by DamageRoll#aggregateTerms.
 */
function separateBonusInBreakdown(roll, aggregate) {
  if ( !Number.isFinite(aggregate?.constant) || !Array.isArray(aggregate?.dice) ) return;
  const bonus = roll.terms.filter(isBonusTerm).reduce((sum, t) => sum + t.number, 0);
  if ( !Number.isFinite(bonus) || !(bonus > 0) ) return;
  aggregate.constant -= bonus;
  const label = escapeHTML(game.i18n.localize("EFFECTIVECRITS.BreakdownLabel"));
  aggregate.dice.push({
    classes: "effective-crit-bonus",
    result: `<span class="effective-crit-label">${label}</span>`
      + `<span class="effective-crit-value"><span class="sign">+</span>${bonus}</span>`
  });
}

/**
 * Minimal HTML escaping for text placed into the breakdown.
 * @param {string} text
 * @returns {string}
 */
function escapeHTML(text) {
  return String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * The system renders every dice-list entry as a die. Restyle ours as a modifier and move it after the regular
 * modifier, so a part reads: dice, +4, Effective Crit +5.
 * @param {HTMLElement} html
 */
function tidyBreakdown(html) {
  for ( const entry of html.querySelectorAll(".dice-rolls .effective-crit-bonus") ) {
    entry.classList.remove("roll");
    entry.setAttribute("data-tooltip", "");
    entry.setAttribute("aria-label", game.i18n.localize("EFFECTIVECRITS.BreakdownTooltip"));
    const constant = entry.parentElement?.querySelector(":scope > .constant");
    if ( constant ) constant.after(entry);
  }
}

/* -------------------------------------------- */
/*  Chat Card Note                              */
/* -------------------------------------------- */

/**
 * Tidy the damage breakdown, and add a short line to damage cards whose critical damage was raised.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
function addChatNote(message, html) {
  tidyBreakdown(html);
  if ( !game.settings.get(MODULE_ID, "showNote") ) return;
  if ( !message.isContentVisible ) return;

  const raised = (message.rolls ?? []).filter(r => r.options?.[FLAG]?.bonus > 0);
  if ( !raised.length ) return;

  // Totals for the whole attack. Messages from version 1.1 and earlier have no group data, so fall back to the parts.
  const group = raised[0].options[FLAG].group ?? {
    rolled: raised.reduce((sum, r) => sum + r.options[FLAG].rolled, 0),
    floor: raised.reduce((sum, r) => sum + r.options[FLAG].floor, 0)
  };
  let text = game.i18n.format("EFFECTIVECRITS.Note", { rolled: group.rolled, floor: group.floor });

  // Name the damage type(s) that received the bonus whenever the attack deals more than one type.
  const types = new Set((message.rolls ?? []).map(r => r.options?.type).filter(t => t));
  if ( types.size > 1 ) {
    const parts = raised.map(r => {
      const label = CONFIG.DND5E.damageTypes?.[r.options.type]?.label
        ?? CONFIG.DND5E.healingTypes?.[r.options.type]?.label ?? "";
      return `${game.i18n.localize(label)} +${r.options[FLAG].bonus}`.trim();
    }).join(", ");
    text += ` ${game.i18n.format("EFFECTIVECRITS.NoteParts", { parts })}`;
  }

  const container = document.createElement("div");
  container.classList.add("effective-crit-notes");
  const note = document.createElement("p");
  note.classList.add("effective-crit-note");
  const icon = document.createElement("i");
  icon.className = "fa-solid fa-burst";
  icon.setAttribute("inert", "");
  const span = document.createElement("span");
  span.textContent = text;
  note.append(icon, span);
  container.append(note);

  // Place it right under the damage total, above the damage-application tray.
  const rows = html.querySelectorAll(".icon-row");
  const anchor = rows[rows.length - 1];
  if ( anchor ) anchor.after(container);
  else html.querySelector(".message-content")?.append(container);
}
