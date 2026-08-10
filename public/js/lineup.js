/**
 * Starting-lineup engine.
 *
 * Premise: points scored on your bench are worth zero. Every dollar should buy
 * production that actually appears in your lineup on Sunday. So this module
 * measures players against a STARTER baseline rather than a draftable-pool
 * baseline, weights them by how reliably they'll be in the lineup at all, and
 * answers the only question that matters in a bidding war:
 *
 *   "How high can I go on this player and still field a complete lineup?"
 */
window.LineupEngine = (function () {
  'use strict';

  const STARTER_SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLX', 'K', 'DST'];
  const FLEX_POS = ['RB', 'WR', 'TE'];
  /** How the single flex slot historically splits across positions. */
  const FLEX_SHARE = { RB: 0.45, WR: 0.45, TE: 0.10 };
  const BASE_STARTERS = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DST: 1 };

  const slotEligible = (slot, pos) => (slot === 'FLX' ? FLEX_POS.includes(pos) : slot === pos);

  /** Starting jobs per team at a position, including its share of the flex. */
  function startersPerTeam(pos) {
    return (BASE_STARTERS[pos] || 0) + (FLEX_SHARE[pos] || 0) * 1;
  }

  /**
   * Fits a roster's picks into starting slots, best players first.
   * @param {Array<{pid,pos,price}>} picks
   * @returns {{slots, open: string[], benched: Array}}
   */
  function assignSlots(picks) {
    const slots = STARTER_SLOTS.map((s) => ({ slot: s, pick: null }));
    const benched = [];
    // Price is the best available proxy for "who is actually the starter here".
    const sorted = picks.slice().sort((a, b) => b.price - a.price);
    for (const pick of sorted) {
      let s = slots.find((x) => !x.pick && x.slot === pick.pos);
      if (!s && FLEX_POS.includes(pick.pos)) s = slots.find((x) => !x.pick && x.slot === 'FLX');
      if (s) s.pick = pick; else benched.push(pick);
    }
    return { slots, open: slots.filter((s) => !s.pick).map((s) => s.slot), benched };
  }

  /**
   * The ceiling on a bid that still leaves enough to fill every remaining
   * STARTING slot with a startable player, plus $1 for each bench spot.
   *
   * @param {object} o
   * @param {number} o.budget      dollars remaining
   * @param {number} o.spotsLeft   roster spots remaining
   * @param {string[]} o.openSlots starting slots still unfilled
   * @param {object} o.floors      slot -> cost of a startable option there
   * @param {string} o.pos         position of the player being bid on
   * @param {number} o.hardMax     the platform's own max bid
   */
  function safeMax(o) {
    if (o.spotsLeft <= 0) return 0;
    const open = o.openSlots.slice();
    const benchSpots = Math.max(0, o.spotsLeft - open.length);

    // Which starting slot would this player actually fill?
    let idx = open.indexOf(o.pos);
    if (idx < 0 && FLEX_POS.includes(o.pos)) idx = open.indexOf('FLX');
    const fillsStarter = idx >= 0;
    if (fillsStarter) open.splice(idx, 1);

    const reserve = open.reduce((s, slot) => s + Math.max(1, o.floors[slot] || 1), 0);

    // Bench money is a war chest, not loose change: nominations come at random,
    // so the ability to bid late is what lets you take the bargains that appear
    // once the rest of the room is broke. benchReserve is the whole bench
    // budget; a player who only makes your bench spends one slot's share of it.
    const totalBench = o.benchReserve === undefined ? benchSpots : o.benchReserve;
    const perBench = benchSpots > 0 ? totalBench / benchSpots : 0;
    const benchAfter = fillsStarter ? benchSpots : Math.max(0, benchSpots - 1);
    const benchCost = Math.round(perBench * benchAfter);

    const ceiling = o.budget - reserve - benchCost;
    return Math.max(1, Math.min(o.hardMax, Math.floor(ceiling)));
  }

  /**
   * Bench value. A bench player never scores for you on a normal week, so he
   * earns his spot three other ways: by replacing a starter you lose, by
   * covering a bye, or by outgrowing what you paid. Weights shift with how much
   * the waiver wire can replace — in a streaming league generic depth is free,
   * so the only bench spots worth paying for are the ones waivers can't hand
   * you: a league-wide handcuff to a real starter (injuries don't check who
   * owns whom), and the breakout nobody has noticed.
   */
  const BENCH_WEIGHTS = {
    active: { handcuff: 0.35, upside: 0.45, bye: 0.10, scarcity: 0.10 },
    normal: { handcuff: 0.30, upside: 0.35, bye: 0.20, scarcity: 0.15 },
    locked: { handcuff: 0.25, upside: 0.30, bye: 0.20, scarcity: 0.25 },
  };

  function benchScore(parts, waivers) {
    const w = BENCH_WEIGHTS[waivers] || BENCH_WEIGHTS.normal;
    const clamp = (n) => Math.max(0, Math.min(1, n || 0));
    return (
      clamp(parts.handcuff) * w.handcuff +
      clamp(parts.upside) * w.upside +
      clamp(parts.bye) * w.bye +
      clamp(parts.scarcity) * w.scarcity
    );
  }

  /**
   * Week-to-week reliability, read straight out of the prop composition.
   *
   * Yards and receptions recur every week; touchdowns are lumpy binary events.
   * A back whose value is mostly goal-line scores has a far shakier floor than
   * one with the same projection built on volume. Passing TDs sit in between —
   * a starting QB throws them at a fairly steady rate.
   *
   * @returns {number} 0..1, higher is steadier
   */
  function consistency(line, scoring) {
    if (!line || !scoring) return null;
    const total =
      (line.py || 0) * scoring.py + (line.ptd || 0) * scoring.ptd + (line.int || 0) * scoring.int +
      (line.ry || 0) * scoring.ry + (line.rtd || 0) * scoring.rtd +
      (line.rec || 0) * scoring.rec + (line.recy || 0) * scoring.recy + (line.rectd || 0) * scoring.rectd;
    if (total <= 0) return null;
    const lumpy =
      (line.rtd || 0) * scoring.rtd +
      (line.rectd || 0) * scoring.rectd +
      (line.ptd || 0) * scoring.ptd * 0.35;
    return Math.max(0.2, Math.min(1, 1 - lumpy / total));
  }

  /** Share of the season the books expect him available. */
  function availability(line) {
    if (!line || !line.g) return null;
    return Math.max(0.3, Math.min(1, line.g / 17));
  }

  /**
   * League-winner score — who is worth breaking your budget for.
   *
   * Built from production ABOVE A TYPICAL STARTER (not above a bench body),
   * discounted for weeks he won't be in the lineup and for boom-bust scoring,
   * and for how much the books and the analysts disagree about him. A player
   * both sides love, who plays every week and scores steadily, is the one worth
   * overspending on. Divergence plays are cheap upside; these are cornerstones.
   */
  function winnerScore(o) {
    const pas = Math.max(0, o.pointsAboveStarter || 0);
    const avail = o.availability === null || o.availability === undefined ? 0.95 : o.availability;
    const cons = o.consistency === null || o.consistency === undefined ? 0.7 : o.consistency;
    const agree = o.agreement === null || o.agreement === undefined ? 1 : o.agreement;
    // Consistency shades the result rather than dominating it.
    return pas * avail * (0.62 + 0.38 * cons) * agree;
  }

  /**
   * How far over a player's market value you're justified going, scaled by how
   * much of a league winner he is. Never exceeds the lineup-safe ceiling.
   */
  function overspendCap(o) {
    const premium = 0.08 + 0.30 * Math.max(0, Math.min(1, o.winnerPct || 0));
    const stretch = Math.round((o.marketValue || 1) * (1 + premium));
    return {
      premium,
      suggested: Math.max(1, Math.min(o.safeMax, stretch)),
      cappedBySafeMax: stretch > o.safeMax,
    };
  }

  return {
    STARTER_SLOTS,
    FLEX_POS,
    BENCH_WEIGHTS,
    slotEligible,
    startersPerTeam,
    assignSlots,
    safeMax,
    benchScore,
    consistency,
    availability,
    winnerScore,
    overspendCap,
  };
})();
