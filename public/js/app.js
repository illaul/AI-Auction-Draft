/**
 * Auction War Room — main app.
 *
 * Implements the Fantasy Points auction playbook:
 *  - tier-based cheat sheet (attack tiers with depth, last-in-tier alerts)
 *  - par sheets ("shoot par" — commit exactly your budget across your spots)
 *  - nomination helper (protect tiers, drain money, aim at the hammer, punt noms)
 *  - hammer tracking (most money left) + per-team max bids and needs
 *  - live room inflation vs. your sheet values
 *  - endgame guardrails (max-bid rule, every nomination gets drafted)
 *
 * Draft results come from manual entry, or live sync with Sleeper / ESPN.
 */
/* global DRAFT_DATA, SleeperSync, EspnSync */
(function () {
  'use strict';

  const { DEFAULT_PLAYERS, PAR_BUILDS, STRATEGY_TIPS } = window.DRAFT_DATA;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const STORE_KEY = 'auction-war-room-v1';
  const FLEX_POS = ['RB', 'WR', 'TE'];
  const STARTERS = { QB: 1, RB: 2, WR: 2, TE: 1, FLX: 2, K: 1, DST: 1 }; // + bench

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let state = null;

  function freshState() {
    const teams = 12;
    return {
      settings: { teams, budget: 200, rosterSize: 16, myTeam: 0, waivers: 'active' },
      byes: null,
      teams: Array.from({ length: teams }, (_, i) => ({ name: `Team ${i + 1}`, spent: 0, picks: [] })),
      players: DEFAULT_PLAYERS.map((p, i) => ({
        id: `p${i}`, n: p.n, pos: p.pos, tm: p.tm, tier: p.tier, v: p.v,
        target: false, draftedBy: null, price: 0,
      })),
      log: [], // [{pid, team, price}] chronological
      parBuild: 'Hero RB',
      parSlots: PAR_BUILDS['Hero RB'].map((s) => s.slice()),
      conn: { type: 'manual' },
      syncedKeys: [],
      vegas: freshVegas(),
    };
  }

  function freshVegas() {
    return {
      source: 'sample',     // 'sample' | 'odds-api' | 'import'
      asOf: 'bundled sample data',
      allowSample: false,   // must opt in before sample edges show on the board
      scoring: 'ppr',
      compare: 'pos',       // 'pos' = edges within a position | 'global' = across all
      blend: 50,            // % weight of the books in a player's anchored worth
      lines: null,          // null => use the bundled sample
      raw: null,            // per-book payload, so book selection can change offline
      books: [],            // available books from the last fetch
      pickedBooks: [],      // the top-3 (or N) you trust — Strategy by Faraz
      expectedGames: 16.2,
      aranks: null,         // imported analyst rankings: normName -> rank
      arankSource: 'sheet', // 'sheet' = derived from your values | 'import'
      winTotals: null,
      meta: null,
      stamp: 0,
    };
  }

  function save() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        state = JSON.parse(raw);
        // Backfill fields added after this save was written.
        state.vegas = Object.assign(freshVegas(), state.vegas || {});
        if (!state.settings.waivers) state.settings.waivers = 'active';
        if (state.byes === undefined) state.byes = null;
        return;
      }
    } catch (_) { /* fall through */ }
    state = freshState();
  }

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------
  const undrafted = () => state.players.filter((p) => p.draftedBy === null);
  const teamRemaining = (i) => state.settings.budget - state.teams[i].spent;
  const teamSpotsLeft = (i) => state.settings.rosterSize - state.teams[i].picks.length;
  const teamMaxBid = (i) => Math.max(0, teamRemaining(i) - (teamSpotsLeft(i) - 1));

  function hammerIndex() {
    let best = -1, bestMoney = -1;
    state.teams.forEach((t, i) => {
      if (teamSpotsLeft(i) <= 0) return;
      const m = teamRemaining(i);
      if (m > bestMoney) { bestMoney = m; best = i; }
    });
    return best;
  }

  // ---- Vegas ---------------------------------------------------------------
  const activeLines = () => state.vegas.lines || VegasEngine.SAMPLE_LINES;
  const activeWinTotals = () => state.vegas.winTotals || VegasEngine.SAMPLE_WIN_TOTALS;
  /** Sample data stays off the board until the user explicitly opts in. */
  const vegasActive = () => state.vegas.source !== 'sample' || state.vegas.allowSample;

  let vegasCache = null;

  function vegasMap() {
    const v = state.vegas;
    const key = [v.source, v.scoring, v.stamp, v.compare, state.settings.teams,
      state.settings.budget, state.settings.rosterSize, state.players.length].join('|');
    if (vegasCache && vegasCache.key === key) return vegasCache.map;

    const lines = activeLines();
    const rows = [];
    for (const p of state.players) {
      if (p.pos === 'K' || p.pos === 'DST' || !p.pos) continue;
      const line = lines[VegasEngine.normName(p.n)];
      if (!line) continue;
      rows.push({ id: p.id, pos: p.pos, mine: p.v, proj: VegasEngine.projectPoints(line, v.scoring) });
    }
    const priced = VegasEngine.priceProjections(rows, { ...state.settings, compare: v.compare || 'pos' });
    const map = new Map();
    for (const [id, x] of priced) {
      const p = playerById(id);
      map.set(id, { ...x, edge: x.val - (p ? p.v : 0) });
    }
    vegasCache = { key, map };
    return map;
  }

  const vegasFor = (p) => (vegasActive() ? vegasMap().get(p.id) || null : null);

  /**
   * Strategy by Faraz — Vegas-vs-analyst rank divergence.
   *
   * Where the books rank a player (by the season production their over/unders
   * imply) versus where the fantasy analysts rank him. The buys are the players
   * Vegas is high on that the analyst consensus has buried; the fades are the
   * analyst darlings the books won't back.
   */
  let farazCache = null;

  function farazMap() {
    const v = state.vegas;
    const key = [v.source, v.scoring, v.stamp, v.arankSource,
      state.players.length, state.settings.teams].join('|');
    if (farazCache && farazCache.key === key) return farazCache.map;

    const lines = activeLines();
    const rows = [];
    for (const p of state.players) {
      if (p.pos === 'K' || p.pos === 'DST' || !p.pos) continue;
      const line = lines[VegasEngine.normName(p.n)];
      if (!line) continue;
      rows.push({
        id: p.id, pos: p.pos,
        proj: VegasEngine.projectPoints(line, v.scoring),
        analyst: analystRank(p),
        spread: line.spread || 0,
        books: line.books || 0,
      });
    }
    const div = VegasEngine.rankDivergence(rows);
    const map = new Map();
    for (const r of rows) {
      const d = div.get(r.id);
      if (d) map.set(r.id, { ...d, proj: r.proj, spread: r.spread, books: r.books });
    }
    farazCache = { key, map };
    return map;
  }

  /**
   * Analyst ranking for a player — lower is better. Uses imported expert ranks
   * when you've pasted them, otherwise falls back to the order implied by the
   * cheat-sheet values already on your board.
   */
  function analystRank(p) {
    const ar = state.vegas.aranks;
    if (ar) {
      const r = ar[VegasEngine.normName(p.n)];
      if (r !== undefined) return r;
      return 9999; // unranked by the analysts you pasted
    }
    return -p.v; // higher sheet value => better rank
  }

  const farazFor = (p) => (vegasActive() ? farazMap().get(p.id) || null : null);

  /**
   * Buy / fade / neutral verdict from the rank gap.
   *
   * Thresholds are relative to the size of the position's ranked pool: moving
   * three spots means everything in a 6-player list and nothing in a 60-player
   * one. `rel` is the fraction of the position list the player moves.
   */
  function farazVerdict(d) {
    if (!d) return null;
    const pool = Math.max(2, d.pool || 2);
    const rel = d.gap / pool;
    const mag = Math.abs(rel);
    const strong = mag >= 0.20 || Math.abs(d.gap) >= 8;
    const lean = mag >= 0.08 && Math.abs(d.gap) >= 2;
    if (!strong && !lean) return { kind: 'flat', strength: '', label: '—', rel };
    const strength = strong ? 'strong' : 'lean';
    return d.gap > 0
      ? { kind: 'buy', strength, label: strong ? 'BUY' : 'buy', rel }
      : { kind: 'fade', strength, label: strong ? 'FADE' : 'fade', rel };
  }

  /**
   * A player's WORTH — anchored in the fantasy-analyst board and the Vegas
   * books, and in nothing else. What the room is bidding never moves this.
   * Bidding decides what you pay; the analysts and the books decide what he's
   * worth, and the gap between those two things is the entire game.
   */
  function anchorValue(p) {
    const w = (state.vegas.blend === undefined ? 50 : state.vegas.blend) / 100;
    const vg = vegasFor(p);
    if (!vg || !w) return p.v;
    return Math.max(1, Math.round(p.v * (1 - w) + vg.val * w));
  }

  /**
   * Room inflation, measured against the ANALYST board — that's the consensus
   * an auction room actually prices off, so it's the right basis for predicting
   * what things will sell for.
   */
  function inflation() {
    let moneyLeft = 0, spotsLeft = 0;
    state.teams.forEach((_, i) => { moneyLeft += teamRemaining(i); spotsLeft += teamSpotsLeft(i); });
    if (spotsLeft <= 0) return 1;
    const pool = undrafted().slice().sort((a, b) => b.v - a.v).slice(0, spotsLeft);
    const poolValue = pool.reduce((s, p) => s + Math.max(p.v, 1), 0);
    if (poolValue <= 0) return 1;
    return moneyLeft / poolValue;
  }

  /** What he'll actually cost: the analyst consensus, moved by room inflation. */
  const adjValue = (p, infl) => Math.max(1, Math.round(p.v * infl));

  /** Worth minus cost. Positive means buying him banks value. */
  const valueEdge = (p, infl) => anchorValue(p) - adjValue(p, infl === undefined ? inflation() : infl);

  /**
   * Surplus banked so far: for every player bought, his anchored worth minus
   * what was actually paid. A positive bank is ammunition — it's how much you
   * can go over the odds on a player you truly want and still be ahead.
   */
  function valueBank(teamIdx) {
    let bank = 0;
    for (const pk of state.teams[teamIdx].picks) {
      const p = playerById(pk.pid);
      if (p) bank += anchorValue(p) - pk.price;
    }
    return Math.round(bank);
  }

  /** Positions a team still needs to fill among its starters. */
  function teamNeeds(i) {
    const counts = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 };
    for (const pick of state.teams[i].picks) {
      const p = playerById(pick.pid);
      if (p && counts[p.pos] !== undefined) counts[p.pos] += 1;
    }
    const needs = [];
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      if (counts[pos] < (STARTERS[pos] || 0)) needs.push(pos);
    }
    const flexUsed = Math.max(0, counts.RB - STARTERS.RB) + Math.max(0, counts.WR - STARTERS.WR) + Math.max(0, counts.TE - STARTERS.TE);
    if (flexUsed < STARTERS.FLX) needs.push('FLX');
    if (counts.K < 1) needs.push('K');
    if (counts.DST < 1) needs.push('DST');
    return needs;
  }

  const playerById = (pid) => state.players.find((p) => p.id === pid);

  /** Remaining players per pos+tier. */
  function tierCounts() {
    const map = {};
    for (const p of undrafted()) {
      const k = `${p.pos}|${p.tier}`;
      (map[k] = map[k] || []).push(p);
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // Starting-lineup engine — bench points are worth zero
  // ---------------------------------------------------------------------------
  function picksWithPos(teamIdx) {
    return state.teams[teamIdx].picks
      .map((pk) => {
        const p = playerById(pk.pid);
        return p ? { pid: pk.pid, pos: p.pos, price: pk.price, n: p.n } : null;
      })
      .filter(Boolean);
  }

  let lineupCache = null;

  /**
   * Everything the safe-max maths needs, rebuilt once per draft event:
   * each team's unfilled starting slots, league-wide demand for each slot,
   * and what a startable option at each slot currently costs.
   */
  function lineupCtx() {
    const key = [state.log.length, state.settings.myTeam, state.settings.rosterSize,
      state.settings.teams, state.vegas.stamp, state.vegas.blend].join('|');
    if (lineupCache && lineupCache.key === key) return lineupCache.ctx;

    const infl = inflation();
    const openByTeam = state.teams.map((_, i) => LineupEngine.assignSlots(picksWithPos(i)).open);
    const demand = {};
    for (const list of openByTeam) for (const s of list) demand[s] = (demand[s] || 0) + 1;

    // Slots compete for overlapping players: every open FLEX also chases the
    // RB/WR/TE pool, so demand for a position is its own openings plus its
    // share of the flexes. Ignoring that made FLEX look far scarcer than RB.
    const FLEX_SHARE = { RB: 0.45, WR: 0.45, TE: 0.10 };
    const skillDemand = (demand.RB || 0) + (demand.WR || 0) + (demand.TE || 0) + (demand.FLX || 0);
    const effDemand = (slot) => {
      if (slot === 'FLX') return skillDemand;
      if (FLEX_SHARE[slot]) return (demand[slot] || 0) + (demand.FLX || 0) * FLEX_SHARE[slot];
      return demand[slot] || 0;
    };

    // Two reserve levels per slot:
    //   floor  — the cheapest player you could still START there once the rest
    //            of the room has filled its own holes. Guarantees a legal,
    //            playable lineup; this is what the hard ceiling protects.
    //   market — what a genuinely competitive starter there costs right now.
    //            Overspending past this doesn't break the lineup, it just makes
    //            the rest of it below average.
    const floors = {};
    const marketFloors = {};
    for (const slot of ['QB', 'RB', 'WR', 'TE', 'FLX', 'K', 'DST']) {
      const cands = undrafted()
        .filter((p) => LineupEngine.slotEligible(slot, p.pos))
        .sort((a, b) => adjValue(b, infl) - adjValue(a, infl));
      if (!cands.length) { floors[slot] = 1; marketFloors[slot] = 1; continue; }
      const d = effDemand(slot);
      const floorIdx = Math.min(cands.length - 1, Math.max(0, Math.round(d)));
      const mktIdx = Math.min(cands.length - 1, Math.max(0, Math.round(d * 0.4)));
      floors[slot] = Math.max(1, adjValue(cands[floorIdx], infl));
      marketFloors[slot] = Math.max(floors[slot], adjValue(cands[mktIdx], infl));
    }

    const ctx = { infl, openByTeam, demand, floors, marketFloors };
    lineupCache = { key, ctx };
    return ctx;
  }

  const openStartingSlots = (teamIdx) => lineupCtx().openByTeam[teamIdx] || [];

  const benchSpotsLeft = (teamIdx) =>
    Math.max(0, teamSpotsLeft(teamIdx) - openStartingSlots(teamIdx).length);

  // ---- the endgame market -------------------------------------------------
  /**
   * What the late draft will look like.
   *
   * Once every team has paid for its starting lineup, whatever money is left
   * has to chase whatever players are left. When the room has spent big early
   * that ratio collapses and $20 players sell for $10 — which is exactly the
   * window worth holding money for. When the room has hoarded, it inverts and
   * scraps go for real money.
   */
  function marketPressure() {
    const me = state.settings.myTeam;
    const rivals = state.teams
      .map((_, i) => i)
      .filter((i) => i !== me && teamSpotsLeft(i) > 0)
      .map((i) => teamMaxBid(i))
      .sort((a, b) => b - a);
    return {
      rivals,
      top: rivals[0] || 0,
      second: rivals[1] || 0,
      median: rivals[Math.floor(rivals.length / 2)] || 0,
      count: rivals.length,
    };
  }

  /**
   * What a player will actually cost, as opposed to what he's worth.
   *
   * An auction price is set by the second-most-motivated bidder, so a player
   * can never cost more than the best-funded rival can bid plus a dollar. Once
   * the room has spent up, that ceiling collapses and genuinely good players
   * sell for a fraction of their value — which is the whole reason to keep
   * money back rather than convert every dollar into starters early.
   */
  function clearingPrice(p) {
    const market = adjValue(p, lineupCtx().infl);
    const mp = marketPressure();
    return Math.max(1, Math.min(market, mp.top + 1));
  }

  /** Aggregate read on how cheap the remaining market is for me. */
  function endgameOutlook() {
    const ctx = lineupCtx();
    const mp = marketPressure();
    const pool = undrafted()
      .filter((p) => p.pos !== 'K' && p.pos !== 'DST')
      .sort((a, b) => adjValue(b, ctx.infl) - adjValue(a, ctx.infl))
      .slice(0, 30);
    let market = 0, clears = 0;
    for (const p of pool) {
      const m = adjValue(p, ctx.infl);
      market += m;
      clears += Math.max(1, Math.min(m, mp.top + 1));
    }
    const best = pool[0] ? adjValue(pool[0], ctx.infl) : 0;
    return {
      discount: market > 0 ? clears / market : 1,
      rivalTop: mp.top,
      rivalMedian: mp.median,
      bestValue: best,
      bestName: pool[0] ? pool[0].n : null,
      // How many of the best remaining players rivals simply cannot afford.
      outOfRivalReach: pool.filter((p) => adjValue(p, ctx.infl) > mp.top + 1).length,
    };
  }

  /** Where my spending power sits against the rest of the room. */
  function biddingPower() {
    const me = state.settings.myTeam;
    const mine = teamMaxBid(me);
    const others = state.teams
      .map((_, i) => i)
      .filter((i) => i !== me && teamSpotsLeft(i) > 0)
      .map((i) => teamMaxBid(i));
    const above = others.filter((m) => m > mine).length;
    const sorted = others.slice().sort((a, b) => b - a);
    return {
      mine,
      above,
      rank: above + 1,
      field: others.length + 1,
      top: sorted[0] || 0,
      median: sorted[Math.floor(sorted.length / 2)] || 0,
    };
  }

  // ---- bench targets ------------------------------------------------------
  /** Players who back up someone already on my roster. */
  function handcuffSet(teamIdx) {
    const mine = picksWithPos(teamIdx)
      .map((pk) => playerById(pk.pid))
      .filter((p) => p && ['RB', 'WR', 'TE', 'QB'].includes(p.pos));
    const out = new Map();
    if (!mine.length) return out;
    for (const p of undrafted()) {
      if (!p.tm || p.tm === 'FA') continue;
      const covers = mine.find((m) => m.tm === p.tm && m.pos === p.pos && m.v > p.v);
      if (covers) {
        // Losing a bell-cow back hands his replacement the entire workload;
        // the same is far less true at receiver.
        const leverage = p.pos === 'RB' ? 1 : p.pos === 'TE' ? 0.6 : 0.5;
        out.set(p.id, { covers, leverage });
      }
    }
    return out;
  }

  const byeFor = (p) => (state.byes && p.tm ? state.byes[p.tm] || null : null);

  let benchCache = null;

  function benchMap() {
    const me = state.settings.myTeam;
    const key = [state.log.length, me, state.vegas.stamp, state.settings.waivers,
      state.byes ? Object.keys(state.byes).length : 0].join('|');
    if (benchCache && benchCache.key === key) return benchCache.map;

    const ctx = lineupCtx();
    const cuffs = handcuffSet(me);
    const waivers = state.settings.waivers || 'active';

    // Bye weeks my current starters are off, per position.
    const starterByes = {};
    for (const pk of picksWithPos(me)) {
      const p = playerById(pk.pid);
      const b = p && byeFor(p);
      if (b) (starterByes[p.pos] = starterByes[p.pos] || []).push(b);
    }

    // How thin each position is getting, league-wide.
    const scarcity = {};
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      const left = undrafted().filter((p) => p.pos === pos && p.v >= 3).length;
      const need = (ctx.demand[pos] || 0) + (ctx.demand.FLX || 0) * 0.3;
      scarcity[pos] = Math.max(0, Math.min(1, need / Math.max(1, left)));
    }

    const rows = [];
    for (const p of undrafted()) {
      if (p.pos === 'K' || p.pos === 'DST') continue;
      const market = adjValue(p, ctx.infl);
      const late = clearingPrice(p);
      const w = winnerFor(p);
      const proj = w && w.proj !== null ? w.proj : null;

      // Upside per dollar: production relative to what he'll actually cost late.
      const perDollar = proj !== null ? proj / Math.max(1, late) : (p.v / Math.max(1, late)) * 6;
      const cuff = cuffs.get(p.id);
      const bye = byeFor(p);
      const posByes = starterByes[p.pos] || [];
      const byeFit = bye === null || !posByes.length ? 0.5
        : posByes.includes(bye) ? 0 : 1;

      rows.push({
        p, market, late, proj,
        perDollar,
        handcuff: cuff ? cuff.leverage : 0,
        cuffFor: cuff ? cuff.covers.n : null,
        bye,
        byeFit,
        scarcity: scarcity[p.pos] || 0,
        availability: w ? w.availability : null,
      });
    }

    // Normalise upside across the pool so the weights mean something.
    const maxPer = Math.max(1, ...rows.map((r) => r.perDollar));
    const map = new Map();
    for (const r of rows) {
      const parts = {
        handcuff: r.handcuff,
        upside: r.perDollar / maxPer,
        bye: r.byeFit,
        scarcity: r.scarcity,
      };
      map.set(r.p.id, { ...r, parts, score: LineupEngine.benchScore(parts, waivers) });
    }
    benchCache = { key, map };
    return map;
  }

  const benchFor = (p) => benchMap().get(p.id) || null;

  /**
   * The bench war chest: what the best available bench targets will cost once
   * the market softens, floored so there's always enough left to win a
   * contested bid rather than being priced out of every nomination.
   */
  function benchReserveFor(teamIdx) {
    const spots = benchSpotsLeft(teamIdx);
    if (spots <= 0) return 0;
    if (teamIdx !== state.settings.myTeam) return spots; // opponents: cheap estimate

    // Cost of the bench targets you'd actually want, at what they'll clear for.
    const mp = marketPressure();
    const perSpot = Math.max(2, Math.min(mp.top + 1, mp.median + 2));
    const expected = spots * perSpot;

    // Cap it so the war chest never eats the starting lineup: bench money is
    // there to win a late bid or two, not to sit idle while your starters rot.
    const cap = Math.max(spots, Math.round(teamRemaining(teamIdx) * 0.25));
    return Math.max(spots, Math.min(expected, cap));
  }

  /** Highest bid that still leaves a complete, startable lineup. */
  function safeMaxFor(p, teamIdx) {
    const i = teamIdx === undefined ? state.settings.myTeam : teamIdx;
    const ctx = lineupCtx();
    return LineupEngine.safeMax({
      budget: teamRemaining(i),
      spotsLeft: teamSpotsLeft(i),
      openSlots: ctx.openByTeam[i] || [],
      floors: ctx.floors,
      pos: p.pos,
      hardMax: teamMaxBid(i),
      benchReserve: benchReserveFor(i),
    });
  }

  /** Does this player step straight into my starting lineup? */
  function fillsStarter(p, teamIdx) {
    const open = openStartingSlots(teamIdx === undefined ? state.settings.myTeam : teamIdx);
    return open.includes(p.pos) || (LineupEngine.FLEX_POS.includes(p.pos) && open.includes('FLX'));
  }

  // ---- league winners ------------------------------------------------------
  let winnerCache = null;

  /** Points a typical STARTER at this position produces — the bar that matters. */
  function starterBaseline(pos, projByPos) {
    const list = projByPos[pos];
    if (!list || !list.length) return 0;
    const n = Math.round(state.settings.teams * LineupEngine.startersPerTeam(pos));
    return VegasEngine.replacementLevel(list.map((x) => ({ proj: x })), Math.max(1, n));
  }

  function winnerMap() {
    const key = [state.log.length, state.vegas.stamp, state.vegas.scoring, state.vegas.compare,
      state.settings.teams, state.settings.rosterSize, vegasActive()].join('|');
    if (winnerCache && winnerCache.key === key) return winnerCache.map;

    const scoring = VegasEngine.SCORING[state.vegas.scoring] || VegasEngine.SCORING.ppr;
    const lines = activeLines();
    const hasVegas = vegasActive();

    // Projection per player: Vegas when we have it, otherwise the sheet value
    // stands in so the board still ranks sensibly without lines loaded.
    const entries = [];
    for (const p of state.players) {
      if (p.pos === 'K' || p.pos === 'DST' || !p.pos) continue;
      const fz = hasVegas ? farazFor(p) : null;
      const line = hasVegas ? lines[VegasEngine.normName(p.n)] : null;
      const proj = fz ? fz.proj : null;
      entries.push({ p, fz, line, proj });
    }

    const projByPos = {};
    for (const e of entries) {
      if (e.proj === null) continue;
      (projByPos[e.p.pos] = projByPos[e.p.pos] || []).push(e.proj);
    }
    for (const list of Object.values(projByPos)) list.sort((a, b) => b - a);
    const baselines = {};
    for (const pos of Object.keys(projByPos)) baselines[pos] = starterBaseline(pos, projByPos);

    // Without projections, fall back to dollars above a startable price.
    const valBaseline = {};
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      const vals = state.players.filter((x) => x.pos === pos).map((x) => x.v).sort((a, b) => b - a);
      const n = Math.round(state.settings.teams * LineupEngine.startersPerTeam(pos));
      valBaseline[pos] = vals[Math.min(vals.length - 1, Math.max(0, n - 1))] || 0;
    }

    const raw = [];
    for (const e of entries) {
      const cons = e.line ? LineupEngine.consistency(e.line, scoring) : null;
      const avail = e.line ? LineupEngine.availability(e.line) : null;
      const agreement = e.fz
        ? 1 - Math.min(0.35, Math.abs(e.fz.gap) / Math.max(2, e.fz.pool))
        : null;
      const pas = e.proj !== null
        ? e.proj - (baselines[e.p.pos] || 0)
        // dollar-space fallback, rescaled so the two are broadly comparable
        : (e.p.v - (valBaseline[e.p.pos] || 0)) * 3;
      const score = LineupEngine.winnerScore({
        pointsAboveStarter: pas, availability: avail, consistency: cons, agreement,
      });
      raw.push({ e, cons, avail, agreement, pas, score });
    }

    const top = Math.max(1, ...raw.map((r) => r.score));
    const map = new Map();
    for (const r of raw) {
      map.set(r.e.p.id, {
        score: r.score,
        pct: Math.max(0, Math.min(1, r.score / top)),
        pas: r.pas,
        consistency: r.cons,
        availability: r.avail,
        agreement: r.agreement,
        proj: r.e.proj,
        estimated: r.e.proj === null,
      });
    }
    winnerCache = { key, map };
    return map;
  }

  const winnerFor = (p) => winnerMap().get(p.id) || null;

  /**
   * The competitive ceiling: pay more than this and the rest of your starting
   * lineup drops below market-average, even though it's still fieldable.
   */
  function competitiveMaxFor(p, teamIdx) {
    const i = teamIdx === undefined ? state.settings.myTeam : teamIdx;
    const ctx = lineupCtx();
    return LineupEngine.safeMax({
      budget: teamRemaining(i),
      spotsLeft: teamSpotsLeft(i),
      openSlots: ctx.openByTeam[i] || [],
      floors: ctx.marketFloors,
      pos: p.pos,
      hardMax: teamMaxBid(i),
      benchReserve: benchReserveFor(i),
    });
  }

  /** Market price, safe ceiling, and the justified stretch for one player. */
  function bidGuide(p) {
    const infl = inflation();
    const market = adjValue(p, infl);
    const safe = safeMaxFor(p);
    const competitive = competitiveMaxFor(p);
    const w = winnerFor(p);
    const cap = LineupEngine.overspendCap({
      marketValue: market, safeMax: safe, winnerPct: w ? w.pct : 0,
    });
    // A stretch is only justified while the rest of the lineup stays
    // competitive — except for genuine cornerstones, who earn a little more.
    const elite = w && w.pct >= 0.75;
    const ceilingForStretch = elite ? safe : Math.min(safe, Math.max(competitive, market));
    const suggested = Math.max(1, Math.min(ceilingForStretch, cap.suggested));

    // Surplus already banked is real money you can put on top in a bidding war
    // without ending up behind on value.
    // Paying his anchored worth plus the surplus you've banked leaves your
    // cumulative value exactly level — that, not the sheet price, is the true
    // "how far can I go and still be ahead" number in a bidding war.
    const bank = Math.max(0, valueBank(state.settings.myTeam));
    const anchor = anchorValue(p);
    const withBank = Math.max(1, Math.min(safe, anchor + bank));

    return {
      market, safe, competitive, suggested, anchor, bank, withBank,
      premium: cap.premium, winner: w,
    };
  }

  // ---------------------------------------------------------------------------
  // Draft actions
  // ---------------------------------------------------------------------------
  function applyPick(pid, teamIdx, price, syncKey) {
    const p = playerById(pid);
    if (!p || p.draftedBy !== null) return;
    p.draftedBy = teamIdx;
    p.price = price;
    state.teams[teamIdx].spent += price;
    state.teams[teamIdx].picks.push({ pid, price });
    state.log.push({ pid, team: teamIdx, price });
    if (syncKey) state.syncedKeys.push(syncKey);
    save();
    renderAll();
  }

  function undoLast() {
    const last = state.log.pop();
    if (!last) return;
    const p = playerById(last.pid);
    if (p) { p.draftedBy = null; p.price = 0; }
    const t = state.teams[last.team];
    t.spent -= last.price;
    t.picks = t.picks.filter((pk) => pk.pid !== last.pid);
    save();
    renderAll();
  }

  function ensurePlayer(name, pos, tm) {
    const norm = normalizeName(name);
    let found = state.players.find((p) => {
      if (pos && p.pos !== pos) return false;
      if (pos === 'DST') return dstMatch(p, name, tm);
      return normalizeName(p.n) === norm;
    });
    if (!found && pos !== 'DST') {
      // looser: match ignoring position (transcription/position quirks)
      found = state.players.find((p) => normalizeName(p.n) === norm);
    }
    if (!found) {
      found = {
        id: `x${state.players.length}-${Date.now()}`,
        n: name, pos: pos || '?', tm: tm || '', tier: 9, v: 1,
        target: false, draftedBy: null, price: 0,
      };
      state.players.push(found);
    }
    return found;
  }

  function normalizeName(n) {
    return String(n).toLowerCase()
      .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '')
      .replace(/[^a-z]/g, '');
  }

  function dstMatch(p, incomingName, tm) {
    if (p.pos !== 'DST') return false;
    if (tm && p.tm === tm) return true;
    const nickname = p.n.replace(/\s*D\/?ST\s*/i, '').trim().toLowerCase();
    return incomingName.toLowerCase().includes(nickname);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  let boardFilter = { pos: 'ALL', q: '', hideDrafted: true };
  let currentPid = null;

  function renderAll() {
    renderTopStats();
    renderCoach();
    renderBoard();
    renderNomHelper();
    renderLog();
    renderMyTeam();
    renderParSheet();
    renderTeams();
    renderVegas();
    renderWinners();
    renderValueTab();
  }

  function renderTopStats() {
    const me = state.settings.myTeam;
    $('#statBudget').textContent = `$${teamRemaining(me)}`;
    $('#statMaxBid').textContent = `$${teamMaxBid(me)}`;
    $('#statSpots').textContent = teamSpotsLeft(me);
    const open = openStartingSlots(me);
    const reserve = open.reduce((s, slot) => s + (lineupCtx().floors[slot] || 1), 0);
    const st = $('#statStarters');
    st.textContent = open.length;
    st.title = open.length
      ? `Unfilled: ${open.join(', ')} — about $${reserve} to fill them all with startable players`
      : 'Starting lineup complete';
    $('#statInflation').textContent = `${inflation().toFixed(2)}×`;
    const bank = valueBank(me);
    const bankEl = $('#statBank');
    bankEl.textContent = `${bank >= 0 ? '+' : '−'}$${Math.abs(bank)}`;
    bankEl.style.color = bank > 0 ? 'var(--accent)' : bank < 0 ? 'var(--danger)' : '';
    bankEl.title = bank >= 0
      ? `You've bought $${bank} of anchored value below cost. That's how far over the odds you can go on a player you want and still be ahead.`
      : `You've paid $${Math.abs(bank)} above anchored value so far. Make it back on your next buys.`;
    const h = hammerIndex();
    $('#statHammer').textContent = h >= 0 ? `${state.teams[h].name} ($${teamRemaining(h)})` : '—';
  }

  function renderCoach() {
    const tips = [];
    const me = state.settings.myTeam;
    const picksMade = state.log.length;
    const myNeeds = teamNeeds(me);
    const tc = tierCounts();

    if (picksMade < state.settings.teams * 0.75) tips.push({ t: STRATEGY_TIPS.sittingDownBonus });

    // last-in-tier alerts for positions I still need (top tiers only)
    for (const [k, list] of Object.entries(tc)) {
      const [pos, tier] = k.split('|');
      if (list.length === 1 && Number(tier) <= 3 && myNeeds.includes(pos) && list[0].v >= 10) {
        tips.push({ t: `⚠️ ${list[0].n} is the LAST ${pos} left in Tier ${tier} — expect a bidding war and an over-value price. If you already have yours, nominate him to drain money from the room.`, alert: true });
        break;
      }
    }

    const progress = picksMade / (state.settings.teams * state.settings.rosterSize);
    const mySpots = teamSpotsLeft(me);
    if (mySpots <= 3 && mySpots > 0) {
      tips.push({ t: STRATEGY_TIPS.maxBidRule, alert: true });
      tips.push({ t: STRATEGY_TIPS.everyNomDrafted });
    } else if (progress > 0.35 && progress < 0.75) {
      const h = hammerIndex();
      tips.push({ t: h === me ? STRATEGY_TIPS.hammer : STRATEGY_TIPS.midDraftAggression });
    }

    // 1-QB guarantee reminder while I still need a QB
    if (myNeeds.includes('QB') && progress > 0.2 && mySpots > 3) tips.push({ t: STRATEGY_TIPS.qbGuarantee });

    // The buyer's window: rivals can no longer cover the board.
    if (mySpots > 0 && state.log.length > state.settings.teams) {
      const out = endgameOutlook();
      const power = biddingPower();
      if (out.outOfRivalReach > 0 && power.mine > out.rivalTop) {
        tips.push({ t: `🟢 Buyer's window open: ${out.outOfRivalReach} of the best players left are beyond every rival's max bid ($${out.rivalTop}). You can take them for ~$${out.rivalTop + 1}. Spend now.` });
      } else if (power.above >= Math.ceil((power.field - 1) * 0.7)) {
        tips.push({ t: `🚨 ${power.above} of ${power.field - 1} rivals can outbid you ($${power.mine} max). You'll lose contested nominations — stop bidding to your ceiling on players you don't need.`, alert: true });
      }
    }

    // biggest Vegas-vs-analyst divergence at a position I still need
    if (vegasActive() && mySpots > 2) {
      const buy = undrafted()
        .map((p) => ({ p, fz: farazFor(p), vg: vegasFor(p) }))
        .map((x) => ({ ...x, vd: farazVerdict(x.fz) }))
        .filter((x) => x.fz && x.vd.kind === 'buy' && x.vd.strength === 'strong'
          && (myNeeds.includes(x.p.pos) || (FLEX_POS.includes(x.p.pos) && myNeeds.includes('FLX'))))
        .sort((a, b) => b.vd.rel - a.vd.rel)[0];
      if (buy) {
        tips.push({ t: `📐 Strategy by Faraz: the books have ${buy.p.n} as ${buy.p.pos}#${buy.fz.vegasRank} while the analysts have him ${buy.p.pos}#${buy.fz.analystRank}. The room prices the analyst rank — buy the gap${buy.vg ? `, up to about $${buy.vg.val}` : ''}.` });
      }
    }

    // rotate one general tip
    const generals = [STRATEGY_TIPS.tierAttack, STRATEGY_TIPS.nominationMix, STRATEGY_TIPS.priceEnforcer,
      STRATEGY_TIPS.onesie, STRATEGY_TIPS.valuesTrap, STRATEGY_TIPS.twoCurrencies, STRATEGY_TIPS.maxBidRead];
    tips.push({ t: generals[picksMade % generals.length] });

    $('#coachBar').innerHTML = tips.slice(0, 2)
      .map((x) => `<span class="tip${x.alert ? ' alert' : ''}">${x.t}</span>`)
      .join('');
  }

  function renderBoard() {
    const infl = inflation();
    const board = $('#playerBoard');
    let players = state.players.slice();
    if (boardFilter.pos !== 'ALL') players = players.filter((p) => p.pos === boardFilter.pos);
    if (boardFilter.q) {
      const q = boardFilter.q.toLowerCase();
      players = players.filter((p) => p.n.toLowerCase().includes(q) || p.tm.toLowerCase().includes(q));
    }
    if (boardFilter.hideDrafted) players = players.filter((p) => p.draftedBy === null);

    // group by pos (when filtered to one pos) or overall value order
    players.sort((a, b) => anchorValue(b) - anchorValue(a) || a.n.localeCompare(b.n));

    const groups = new Map();
    for (const p of players) {
      const key = boardFilter.pos === 'ALL' ? `${p.pos} · Tier ${p.tier}` : `Tier ${p.tier}`;
      const gk = boardFilter.pos === 'ALL' ? `${p.pos}|${p.tier}` : `${p.pos}|${p.tier}`;
      if (!groups.has(gk)) groups.set(gk, { label: key, pos: p.pos, tier: p.tier, list: [] });
      groups.get(gk).list.push(p);
    }

    const tc = tierCounts();
    const ordered = Array.from(groups.values()).sort((a, b) => {
      const posOrder = { RB: 0, WR: 1, QB: 2, TE: 3, K: 4, DST: 5 };
      if (boardFilter.pos === 'ALL' && posOrder[a.pos] !== posOrder[b.pos]) return posOrder[a.pos] - posOrder[b.pos];
      return a.tier - b.tier;
    });

    board.innerHTML = ordered.map((g) => {
      const remain = (tc[`${g.pos}|${g.tier}`] || []).length;
      const warn = remain === 1 ? '<span class="tier-warn">⚠ last one in tier</span>' : `<span>${remain} left</span>`;
      const rows = g.list.map((p) => {
        const drafted = p.draftedBy !== null;
        const adj = adjValue(p, infl);
        const vg = vegasFor(p);
        const fz = farazFor(p);
        const verdict = farazVerdict(fz);
        const tip = fz
          ? `Strategy by Faraz — analysts ${p.pos}#${fz.analystRank}, Vegas ${p.pos}#${fz.vegasRank}`
            + ` · books imply ${Math.round(fz.proj)} fantasy pts`
            + `${vg ? ` (worth $${vg.val})` : ''}`
            + `${fz.books ? ` · ${fz.books} book${fz.books > 1 ? 's' : ''}` : ''}`
          : '';
        const veg = !fz || drafted ? ''
          : verdict.kind === 'buy' ? `<span class="veg up${verdict.strength === 'strong' ? ' strong' : ''}" title="${tip}">▲${fz.gap}</span>`
          : verdict.kind === 'fade' ? `<span class="veg down${verdict.strength === 'strong' ? ' strong' : ''}" title="${tip}">▼${Math.abs(fz.gap)}</span>`
          : `<span class="veg flat" title="${tip}">≈</span>`;
        return `<div class="p-row${drafted ? ' drafted' : ''}" data-pid="${p.id}">
          <span class="pos-chip pos-${p.pos}">${p.pos === 'DST' ? 'D' : p.pos}</span>
          <span class="p-name">${p.target ? '<span class="star">⭐</span> ' : ''}${p.n}<span class="tm">${p.tm}</span></span>
          <span class="p-val">$${anchorValue(p)}</span>
          <span class="p-adj">${drafted ? '' : `$${adj}`}</span>
          <span class="p-veg">${veg}</span>
          <span class="p-paid">${drafted ? `$${p.price} · ${state.teams[p.draftedBy].name}` : ''}</span>
        </div>`;
      }).join('');
      return `<div class="tier-block"><div class="tier-label"><span>${g.label}</span>${warn}</div>${rows}</div>`;
    }).join('') || '<div class="log-empty">No players match.</div>';
  }

  function renderNomHelper() {
    const el = $('#nomHelper');
    const me = state.settings.myTeam;
    const myNeeds = teamNeeds(me);
    const tc = tierCounts();
    const infl = inflation();
    const picksMade = state.log.length;
    const mySpots = teamSpotsLeft(me);
    const groups = [];

    const item = (p, why) =>
      `<div class="nom-item" data-pid="${p.id}"><span>${p.n} <span class="tm muted">${p.pos} · $${adjValue(p, infl)}</span></span><span class="why">${why}</span></div>`;

    // 1. Sitting-down bonus (early)
    if (picksMade < state.settings.teams) {
      const deals = undrafted().filter((p) => p.v >= 25 || p.target).sort((a, b) => b.v - a.v).slice(0, 4);
      if (deals.length) {
        groups.push(`<div class="nom-group"><h4>🪑 Sitting-down bonus — cold room, cornerstone deals</h4>${deals.map((p) => item(p, 'room is cold')).join('')}</div>`);
      }
    }

    // 2. Protect your tiers: positions I need with 3+ left in a good tier
    const protect = [];
    for (const [k, list] of Object.entries(tc)) {
      const [pos, tier] = k.split('|');
      if (!myNeeds.includes(pos) && !(FLEX_POS.includes(pos) && myNeeds.includes('FLX'))) continue;
      if (Number(tier) > 5 || list.length < 3) continue;
      const targets = list.filter((p) => p.target);
      const pick = targets[0] || list[0];
      protect.push({ p: pick, why: `${list.length} left in tier — buy from ahead` });
    }
    protect.sort((a, b) => b.p.v - a.p.v);
    if (protect.length && mySpots > 3) {
      groups.push(`<div class="nom-group"><h4>🎯 Attack a tier with depth (you need these)</h4>${protect.slice(0, 4).map((x) => item(x.p, x.why)).join('')}</div>`);
    }

    // 2b. Strategy by Faraz — rank divergence between the books and the analysts
    if (vegasActive()) {
      const needsPos = (pos) => myNeeds.includes(pos) || (FLEX_POS.includes(pos) && myNeeds.includes('FLX'));
      const buys = undrafted()
        .map((p) => ({ p, fz: farazFor(p) }))
        .map((x) => ({ ...x, vd: farazVerdict(x.fz) }))
        .filter((x) => x.fz && x.vd.kind === 'buy' && needsPos(x.p.pos))
        .sort((a, b) => b.vd.rel - a.vd.rel)
        .slice(0, 4);
      if (buys.length && mySpots > 2) {
        groups.push(`<div class="nom-group vegas"><h4>📐 Faraz buys — Vegas high, analysts low</h4>${buys.map((x) => item(x.p, `A#${x.fz.analystRank} → V#${x.fz.vegasRank} (+${x.fz.gap})`)).join('')}</div>`);
      }
      const fades = undrafted()
        .map((p) => ({ p, fz: farazFor(p) }))
        .map((x) => ({ ...x, vd: farazVerdict(x.fz) }))
        .filter((x) => x.fz && x.vd.kind === 'fade' && !needsPos(x.p.pos) && x.p.v >= 12)
        .sort((a, b) => a.vd.rel - b.vd.rel)
        .slice(0, 3);
      if (fades.length && mySpots > 2) {
        groups.push(`<div class="nom-group drain"><h4>📐 Faraz fades — analyst darlings the books doubt</h4>${fades.map((x) => item(x.p, `A#${x.fz.analystRank} but only V#${x.fz.vegasRank}`)).join('')}</div>`);
      }
    }

    // 3. Money drains: last-in-tier or expensive players at positions I've filled
    const drains = [];
    for (const [k, list] of Object.entries(tc)) {
      const [pos, tier] = k.split('|');
      if (myNeeds.includes(pos) || Number(tier) > 4) continue;
      if (list.length === 1 && list[0].v >= 8) drains.push({ p: list[0], why: 'last in tier — start a bidding war' });
      else if (list.length >= 1 && list[0].v >= 30) drains.push({ p: list[0], why: 'drain the room\'s money' });
    }
    drains.sort((a, b) => b.p.v - a.p.v);
    if (drains.length && mySpots > 2) {
      groups.push(`<div class="nom-group drain"><h4>💸 Money drains (you're set here)</h4>${drains.slice(0, 4).map((x) => item(x.p, x.why)).join('')}</div>`);
    }

    // 4. Aim at the hammer
    const h = hammerIndex();
    if (h >= 0 && h !== me && state.log.length > state.settings.teams * 4) {
      const hNeeds = teamNeeds(h).filter((n) => n !== 'FLX' && n !== 'K' && n !== 'DST');
      const picks = [];
      for (const pos of hNeeds) {
        const best = undrafted().filter((p) => p.pos === pos).sort((a, b) => b.v - a.v)[0];
        if (best && best.v >= 5 && !myNeeds.includes(pos)) picks.push({ p: best, why: `${state.teams[h].name} needs ${pos}` });
      }
      if (picks.length) {
        groups.push(`<div class="nom-group drain"><h4>🔨 Aim at the hammer — make the money spend</h4>${picks.slice(0, 3).map((x) => item(x.p, x.why)).join('')}</div>`);
      }
    }

    // 5. Punt nominations (endgame)
    if (mySpots <= Math.max(4, state.settings.rosterSize * 0.25)) {
      const punts = undrafted().filter((p) => (p.pos === 'K' || p.pos === 'DST')).sort((a, b) => a.v - b.v).slice(0, 4);
      if (punts.length) {
        groups.push(`<div class="nom-group punt"><h4>🥾 Punt noms — kick the can, save your real targets</h4>${punts.map((p) => item(p, 'fine to own at $1')).join('')}</div>`);
      }
    }

    el.innerHTML = groups.join('') || '<div class="log-empty">Draft complete — nice work.</div>';
  }

  function renderLog() {
    const el = $('#draftLog');
    if (!state.log.length) {
      el.innerHTML = '<div class="log-empty">No picks yet. Click a player to record a sale, or connect a live draft.</div>';
      return;
    }
    const rows = state.log.slice().reverse().map((entry, ri) => {
      const p = playerById(entry.pid);
      if (!p) return '';
      const n = state.log.length - ri;
      const diff = entry.price - anchorValue(p);
      const cls = diff <= -4 ? ' steal' : diff >= 5 ? ' overpay' : '';
      const mine = entry.team === state.settings.myTeam ? ' mine' : '';
      return `<div class="log-row${cls}${mine}">
        <span>#${n} <b>${p.n}</b> <span class="tm muted">${p.pos}</span></span>
        <span class="team">${state.teams[entry.team].name}</span>
        <span class="price">$${entry.price}</span>
      </div>`;
    }).join('');
    el.innerHTML = rows;
  }

  function renderMyTeam() {
    const me = state.settings.myTeam;
    const el = $('#tab-myteam');
    const slots = [];
    for (const pos of ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLX', 'FLX', 'K', 'DST']) slots.push({ pos, pick: null });
    const bench = state.settings.rosterSize - slots.length;
    for (let i = 0; i < bench; i++) slots.push({ pos: 'BN', pick: null });

    const picks = state.teams[me].picks
      .map((pk) => ({ ...pk, p: playerById(pk.pid) }))
      .filter((x) => x.p)
      .sort((a, b) => b.price - a.price);

    for (const pick of picks) {
      let slot = slots.find((s) => !s.pick && s.pos === pick.p.pos);
      if (!slot && FLEX_POS.includes(pick.p.pos)) slot = slots.find((s) => !s.pick && s.pos === 'FLX');
      if (!slot) slot = slots.find((s) => !s.pick && s.pos === 'BN');
      if (slot) slot.pick = pick;
    }

    // Starting-lineup production: the only points that count.
    let starterPts = 0, ptsKnown = 0;
    const STARTING = 10;
    slots.slice(0, STARTING).forEach((s) => {
      if (!s.pick) return;
      const w = winnerFor(s.pick.p);
      if (w && w.proj !== null) { starterPts += w.proj; ptsKnown += 1; }
    });

    el.innerHTML = slots.map((s, i) => {
      const bench = i >= STARTING;
      const w = s.pick ? winnerFor(s.pick.p) : null;
      const pts = w && w.proj !== null ? `<span class="slot-pts">${Math.round(w.proj)}</span>` : '<span class="slot-pts"></span>';
      return `
      <div class="roster-slot${bench ? ' benched' : ''}">
        <span class="slot-label">${s.pos === 'DST' ? 'D/ST' : s.pos}</span>
        ${s.pick
          ? `<span>${s.pick.p.n} <span class="tm muted">${s.pick.p.tm}</span></span>${pts}<span class="paid">$${s.pick.price}</span>`
          : '<span class="empty">empty</span><span class="slot-pts"></span><span class="paid muted"></span>'}
      </div>`;
    }).join('') +
      `<div class="par-summary" style="margin-top:10px">
        <span>Spent <b>$${state.teams[me].spent}</b></span>
        <span>Left <b>$${teamRemaining(me)}</b></span>
        <span>Max bid <b>$${teamMaxBid(me)}</b></span>
      </div>
      ${ptsKnown ? `<div class="lineup-strength">
        <span>Projected <b>starting</b> points</span><b>${Math.round(starterPts)}</b>
        <div class="muted">From ${ptsKnown} of 10 starting slots. Bench production is excluded — it scores you nothing.</div>
      </div>` : ''}`;
  }

  function renderParSheet() {
    const el = $('#tab-parsheet');
    const me = state.settings.myTeam;
    const budget = state.settings.budget;

    const buildOpts = Object.keys(PAR_BUILDS)
      .map((b) => `<option${b === state.parBuild ? ' selected' : ''}>${b}</option>`).join('');

    // assign my picks to par slots (price desc; exact pos, then FLX, then BN)
    const slots = state.parSlots.map(([pos, target]) => ({ pos, target, pick: null }));
    const picks = state.teams[me].picks
      .map((pk) => ({ ...pk, p: playerById(pk.pid) }))
      .filter((x) => x.p)
      .sort((a, b) => b.price - a.price);
    for (const pick of picks) {
      let slot = slots.find((s) => !s.pick && s.pos === pick.p.pos);
      if (!slot && FLEX_POS.includes(pick.p.pos)) slot = slots.find((s) => !s.pick && s.pos === 'FLX');
      if (!slot) slot = slots.find((s) => !s.pick && s.pos === 'BN');
      if (slot) slot.pick = pick;
    }

    const planned = slots.reduce((s, x) => s + Number(x.target || 0), 0);
    const spent = state.teams[me].spent;
    const remainingPlan = slots.filter((s) => !s.pick).reduce((s, x) => s + Number(x.target || 0), 0);
    const parDelta = (budget - spent) - remainingPlan; // + = ahead of par (extra money), − = behind

    const rows = slots.map((s, i) => {
      const diff = s.pick ? s.pick.price - s.target : null;
      return `<div class="par-row">
        <span class="slot-label">${s.pos === 'DST' ? 'D/ST' : s.pos}</span>
        <span class="fill">${s.pick ? s.pick.p.n : '<span class="muted">—</span>'}</span>
        <input type="number" min="0" value="${s.target}" data-par-idx="${i}" />
        <span class="actual">${s.pick ? `$${s.pick.price}` : ''}</span>
        <span class="diff ${diff === null ? '' : diff <= 0 ? 'pos' : 'neg'}">${diff === null ? '' : (diff > 0 ? `+${diff}` : diff)}</span>
      </div>`;
    }).join('');

    el.innerHTML = `
      <div class="par-controls">
        <select id="parBuildSel">${buildOpts}</select>
        <button id="btnParReset" class="btn btn-sm btn-ghost">Load build</button>
      </div>
      <div class="par-summary">
        <span>Plan <b class="${planned === budget ? 'good' : 'bad'}">$${planned}</b>/$${budget}</span>
        <span>Spent <b>$${spent}</b></span>
        <span>Par <b class="${parDelta >= 0 ? 'good' : 'bad'}">${parDelta >= 0 ? '+' : ''}${parDelta}</b></span>
      </div>
      <div class="par-row head"><span>Slot</span><span>Player</span><span>Par $</span><span>Paid</span><span>±</span></div>
      ${rows}
      <p class="muted" style="margin-top:8px">"Shoot par": plan should total exactly $${budget}. Par + means you're running ahead (money freed up); − means you've overspent your plan and need to pull back somewhere.</p>`;

    $('#parBuildSel').addEventListener('change', (e) => { state.parBuild = e.target.value; });
    $('#btnParReset').addEventListener('click', () => {
      state.parBuild = $('#parBuildSel').value;
      state.parSlots = PAR_BUILDS[state.parBuild].map((s) => s.slice());
      save(); renderParSheet();
    });
    $$('#tab-parsheet input[data-par-idx]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const i = Number(inp.dataset.parIdx);
        state.parSlots[i][1] = Number(inp.value) || 0;
        save(); renderParSheet();
      });
    });
  }

  function renderTeams() {
    const el = $('#tab-teams');
    const h = hammerIndex();
    const me = state.settings.myTeam;
    el.innerHTML = state.teams.map((t, i) => {
      const needs = teamNeeds(i);
      return `<div class="team-card${i === h ? ' hammer' : ''}${i === me ? ' me' : ''}">
        <div class="team-head">
          <span class="tname">${i === h ? '🔨 ' : ''}${i === me ? '⭐ ' : ''}${t.name}</span>
          <span class="tmoney">$${teamRemaining(i)}</span>
        </div>
        <div class="team-sub">
          <span>${t.picks.length}/${state.settings.rosterSize} spots · max bid $${teamMaxBid(i)}</span>
        </div>
        <div class="needs">${needs.map((n) => `<span class="need-chip">${n}</span>`).join('') || '<span class="need-chip">starters full</span>'}</div>
      </div>`;
    }).join('');
  }

  function renderVegas() {
    const el = $('#tab-vegas');
    const v = state.vegas;
    const sample = v.source === 'sample';
    const lineCount = Object.keys(activeLines()).length;

    const banner = sample
      ? `<div class="vg-banner ${v.allowSample ? 'warn' : 'stop'}">
           <b>⚠️ Sample data — these are NOT real sportsbook lines.</b>
           <div class="muted">They exist so you can see how the tool works. Fetch or import real
           lines before draft day.</div>
           ${v.allowSample
             ? '<button id="btnVgDisallow" class="btn btn-sm btn-ghost">Hide sample edges</button>'
             : '<button id="btnVgAllow" class="btn btn-sm btn-ghost">Show sample edges anyway</button>'}
         </div>`
      : `<div class="vg-banner ok"><b>✓ ${v.source === 'odds-api' ? 'Live Odds API lines' : 'Imported lines'}</b>
           <div class="muted">${lineCount} players · ${v.asOf}${v.meta?.events ? ` · ${v.meta.events} games sampled` : ''}</div></div>`;

    // Book picker — the strategy rests on trusting a chosen few books.
    const picked = v.pickedBooks || [];
    const bookPicker = (v.books && v.books.length)
      ? `<div class="vg-books">
           <label>Books used <span class="muted">(${picked.length} selected)</span></label>
           <div class="book-chips">${v.books.slice(0, 10).map((b) =>
             `<button class="book-chip${picked.includes(b.key) ? ' on' : ''}" data-book="${b.key}">${b.title}</button>`).join('')}</div>
         </div>`
      : '';

    const controls = `
      <div class="vg-controls">
        <button id="btnVgOpen" class="btn btn-sm">Fetch / import lines</button>
        <button id="btnVgRanks" class="btn btn-sm btn-ghost">Analyst ranks</button>
      </div>
      ${bookPicker}
      <div class="vg-row">
        <label>Scoring</label>
        <select id="vgScoring">
          <option value="ppr"${v.scoring === 'ppr' ? ' selected' : ''}>Full PPR</option>
          <option value="half"${v.scoring === 'half' ? ' selected' : ''}>Half PPR</option>
          <option value="std"${v.scoring === 'std' ? ' selected' : ''}>Standard</option>
        </select>
      </div>
      <div class="vg-row">
        <label>Compare</label>
        <select id="vgCompare">
          <option value="pos"${(v.compare || 'pos') === 'pos' ? ' selected' : ''}>Within position</option>
          <option value="global"${v.compare === 'global' ? ' selected' : ''}>Across all positions</option>
        </select>
      </div>
      <div class="vg-row">
        <label>Books' weight in anchored value <b>${v.blend}%</b></label>
        <input id="vgBlend" type="range" min="0" max="100" step="5" value="${v.blend}" />
      </div>
      <p class="muted">A player's <b>worth</b> is anchored in the analyst board and the Vegas books —
      never in what the room is bidding. This sets how much of that anchor comes from the books.
      At 0% it's purely the analysts; 50% weights them equally.</p>`;

    let body = '';
    if (!vegasActive()) {
      body = '<div class="log-empty">Vegas edges are hidden until real lines are loaded.</div>';
    } else {
      const rated = state.players
        .filter((p) => p.draftedBy === null)
        .map((p) => ({ p, vg: vegasFor(p), fz: farazFor(p) }))
        .filter((x) => x.fz);
      const scored = rated.map((x) => ({ ...x, vd: farazVerdict(x.fz) }));
      const buys = scored.filter((x) => x.vd.kind === 'buy').sort((a, b) => b.vd.rel - a.vd.rel).slice(0, 10);
      const fades = scored.filter((x) => x.vd.kind === 'fade').sort((a, b) => a.vd.rel - b.vd.rel).slice(0, 8);

      const row = (x) => {
        const shaky = x.fz.spread > 0.12 || (x.fz.books && x.fz.books < 2);
        const tip = `Books imply ${Math.round(x.fz.proj)} fantasy pts this season`
          + `${x.fz.books ? ` · consensus of ${x.fz.books} book${x.fz.books > 1 ? 's' : ''}` : ''}`
          + `${x.fz.spread ? ` · book spread ${Math.round(x.fz.spread * 100)}%` : ''}`;
        return `<div class="vg-item" data-pid="${x.p.id}" title="${tip}">
          <span class="pos-chip pos-${x.p.pos}">${x.p.pos}</span>
          <span class="fill">${x.p.n}${shaky ? ' <span class="shaky" title="Books disagree on this line — lower confidence">≠</span>' : ''}</span>
          <span class="arank">A#${x.fz.analystRank}</span>
          <span class="vrank">V#${x.fz.vegasRank}</span>
          <span class="edge ${x.fz.gap > 0 ? 'up' : 'down'}">${x.fz.gap > 0 ? '+' : ''}${x.fz.gap}</span>
          <span class="mine">${x.vg ? `$${x.p.v}→$${x.vg.val}` : ''}</span>
        </div>`;
      };

      // Coverage matters: thin position groups make replacement level optimistic.
      const cov = {};
      for (const p of state.players) {
        if (p.pos === 'K' || p.pos === 'DST') continue;
        cov[p.pos] = cov[p.pos] || { have: 0, total: 0 };
        cov[p.pos].total += 1;
        if (activeLines()[VegasEngine.normName(p.n)]) cov[p.pos].have += 1;
      }
      const covChips = Object.entries(cov).map(([pos, c]) =>
        `<span class="need-chip${c.have < 8 ? ' thin' : ''}">${pos} ${c.have}/${c.total}</span>`).join('');
      const thin = Object.values(cov).some((c) => c.have > 0 && c.have < 8);

      const wins = activeWinTotals();
      const winChips = Object.entries(wins).sort((a, b) => b[1] - a[1]).slice(0, 12)
        .map(([t, w]) => `<span class="need-chip">${t} ${w}</span>`).join('');

      const arSrc = v.arankSource === 'import'
        ? `${Object.keys(v.aranks || {}).length} imported analyst ranks`
        : 'analyst ranks derived from your board values';

      body = `
        <div class="faraz-head">
          <b>📐 Strategy by Faraz</b>
          <div class="muted">Buy where the books rank a player well above the analysts — the room
          prices the analyst rank, so you get the books' production at a discount. Fade the reverse.
          Ranks are within position; <b>A#</b> = analyst, <b>V#</b> = Vegas.</div>
          <div class="muted" style="margin-top:4px">Using ${arSrc}.</div>
        </div>
        <div class="vg-head"><span></span><span>Player</span><span>A#</span><span>V#</span><span>Gap</span><span>$</span></div>
        <h4 class="vg-sec up">🟢 Vegas high / analysts low — BUY</h4>
        ${buys.map(row).join('') || '<div class="muted">No buy-side divergence right now.</div>'}
        <h4 class="vg-sec down">🔴 Analyst darlings the books don\'t back — FADE</h4>
        ${fades.map(row).join('') || '<div class="muted">No fade-side divergence right now.</div>'}
        <h4 class="vg-sec">🏆 Team win totals</h4>
        <div class="needs">${winChips || '<span class="muted">None loaded.</span>'}</div>
        <h4 class="vg-sec">📋 Line coverage</h4>
        <div class="needs">${covChips}</div>
        <p class="muted">Rank gaps only compare players who have lines, so a thin position means a
        short ranking list and noisier gaps.${thin ? ' Groups under 8 players are especially rough here.' : ''}
        The <b>$</b> column shows your value → the Vegas-implied value.
        ${(state.vegas.compare || 'pos') === 'pos'
          ? 'Dollar values compare within <b>position</b>.'
          : '<b>Across-positions</b> dollar mode needs deep coverage everywhere to hold up.'}
        <span class="shaky">≠</span> marks players your selected books disagree on.</p>`;
    }

    el.innerHTML = banner + controls + body;

    const bind = (sel, ev, fn) => { const n = $(sel); if (n) n.addEventListener(ev, fn); };
    bind('#btnVgAllow', 'click', () => { state.vegas.allowSample = true; save(); renderAll(); });
    bind('#btnVgDisallow', 'click', () => { state.vegas.allowSample = false; save(); renderAll(); });
    bind('#btnVgOpen', 'click', () => { $('#vegasMsg').classList.add('hidden'); show('#modalVegas'); });
    bind('#btnVgRanks', 'click', () => {
      $('#vegasMsg').classList.add('hidden');
      $$('#vegTabs button').forEach((x) => x.classList.remove('active'));
      $('#vegTabs button[data-vtab="ranks"]').classList.add('active');
      $$('#modalVegas .ctab-body').forEach((x) => x.classList.add('hidden'));
      show('#vtab-ranks');
      show('#modalVegas');
    });
    $$('#tab-vegas .book-chip').forEach((n) => n.addEventListener('click', () => {
      const k = n.dataset.book;
      const picked = new Set(state.vegas.pickedBooks || []);
      if (picked.has(k)) picked.delete(k); else picked.add(k);
      state.vegas.pickedBooks = Array.from(picked);
      rebuildLinesFromBooks();
    }));
    bind('#vgScoring', 'change', (e) => { state.vegas.scoring = e.target.value; save(); renderAll(); });
    bind('#vgCompare', 'change', (e) => { state.vegas.compare = e.target.value; save(); renderAll(); });
    bind('#vgBlend', 'change', (e) => { state.vegas.blend = Number(e.target.value); save(); renderAll(); });
    $$('#tab-vegas .vg-item').forEach((n) => n.addEventListener('click', () => openDraftModal(n.dataset.pid)));
  }

  /** Where your money sits against the room, and what the endgame looks like. */
  function renderBuyingPower() {
    const me = state.settings.myTeam;
    const power = biddingPower();
    const out = endgameOutlook();
    const chest = benchReserveFor(me);
    const bench = benchSpotsLeft(me);
    const disc = out.discount;

    // An auction price is set by the best-funded rival, never by the sheet.
    const mood = out.outOfRivalReach > 0
      ? { cls: 'good', txt: `🟢 <b>Buyer's market.</b> ${out.outOfRivalReach} of the best players left are worth more than the richest rival can even bid ($${out.rivalTop}) — including ${out.bestName} at $${out.bestValue}. They're yours for about $${out.rivalTop + 1}. This is the window you held money for.` }
      : disc >= 0.97
      ? { cls: 'bad', txt: `🔴 <b>Full price.</b> The top rival can bid $${out.rivalTop}, which still covers everyone left (best is ${out.bestName} at $${out.bestValue}). No discount yet — bargains only appear once the room overspends.` }
      : { cls: 'ok', txt: `🟡 <b>Softening.</b> Top rival is down to $${out.rivalTop} and the board is clearing about ${Math.round((1 - disc) * 100)}% under value. Getting close to the window.` };

    const rankCls = power.above === 0 ? 'good' : power.above >= state.settings.teams - 3 ? 'bad' : 'ok';
    const lockout = power.above >= Math.ceil((power.field - 1) * 0.7)
      ? `<div class="bp-alert">🚨 ${power.above} of ${power.field - 1} opponents can outbid you. You'll lose most contested nominations from here — stop bidding to your ceiling on non-essentials.</div>`
      : '';

    return `
      <h4 class="vg-sec">💰 Buying power</h4>
      <div class="bp-grid">
        <div><label>Your max bid</label><b class="${rankCls}">$${power.mine}</b></div>
        <div><label>Room rank</label><b class="${rankCls}">#${power.rank} of ${power.field}</b></div>
        <div><label>Top rival</label><b>$${power.top}</b></div>
        <div><label>War chest</label><b>$${chest}</b></div>
      </div>
      <p class="muted bp-note ${mood.cls}">${mood.txt}</p>
      ${bench ? `<p class="muted">$${chest} is held back for ${bench} bench spot${bench > 1 ? 's' : ''} — not to buy depth, but so you can still win a bid when a good player falls late.</p>` : ''}
      ${lockout}`;
  }

  function renderValueTab() {
    const el = $('#tab-value');
    el.innerHTML = `
      <div class="panel-note">
        <b>💎 Value board — blocks of ${state.settings.teams}</b>
        <div class="muted">Everyone left, ranked by <b>anchored worth</b> — the analyst board and
        the Vegas books, and nothing else. What the room is bidding never moves this number; it
        only moves the price. Each block is one nomination cycle, sorted by the gap.</div>
      </div>
      <div class="win-head vb-legend"><span></span><span>Player</span><span>Worth</span><span>Cost</span><span>Edge</span></div>
      ${renderValueBlocks()}`;
    $$('#tab-value .vb-item').forEach((n) =>
      n.addEventListener('click', () => openDraftModal(n.dataset.pid)));
  }

  /**
   * The board in blocks of one nomination cycle (one player per team).
   *
   * Everyone left is ranked by anchored worth — analysts plus books, untouched
   * by what the room is doing — then cut into blocks the size of the league.
   * Inside each block the question is only ever "who is underpriced here",
   * which is what the value column answers.
   */
  function renderValueBlocks() {
    const infl = inflation();
    const size = state.settings.teams;
    const pool = undrafted()
      .filter((p) => p.pos !== 'K' && p.pos !== 'DST')
      .map((p) => ({ p, worth: anchorValue(p), price: adjValue(p, infl) }))
      .map((x) => ({ ...x, edge: x.worth - x.price }))
      .sort((a, b) => b.worth - a.worth);
    if (!pool.length) return '';

    const blocks = [];
    for (let i = 0; i < Math.min(pool.length, size * 6); i += size) {
      blocks.push({ from: i + 1, to: Math.min(i + size, pool.length), rows: pool.slice(i, i + size) });
    }

    return blocks.map((b) => {
      const best = b.rows.slice().sort((x, y) => y.edge - x.edge).slice(0, 3).map((x) => x.p.id);
      const rows = b.rows
        .slice()
        .sort((x, y) => y.edge - x.edge)
        .map((x) => {
          const good = best.includes(x.p.id) && x.edge > 0;
          return `<div class="vb-item${good ? ' pick' : ''}" data-pid="${x.p.id}"
                       title="Worth $${x.worth} (analysts + books) · should cost about $${x.price}">
            <span class="pos-chip pos-${x.p.pos}">${x.p.pos}</span>
            <span class="fill">${good ? '★ ' : ''}${x.p.n}</span>
            <span class="worth">$${x.worth}</span>
            <span class="price">$${x.price}</span>
            <span class="edge ${x.edge > 0 ? 'up' : x.edge < 0 ? 'down' : ''}">${x.edge > 0 ? '+' : ''}${x.edge}</span>
          </div>`;
        }).join('');
      const blockEdge = b.rows.reduce((s, x) => s + Math.max(0, x.edge), 0);
      return `<div class="vb-block">
        <div class="vb-head"><span>Players ${b.from}–${b.to}</span><span class="muted">$${blockEdge} of value in this block</span></div>
        ${rows}
      </div>`;
    }).join('');
  }

  /**
   * Key handcuffs, league-wide.
   *
   * A backup is worth owning because of the job he'd inherit, not because of
   * whose roster the starter is on — injuries happen to every team. So this
   * ranks every backup in the pool by the workload sitting in front of him,
   * then checks that the analysts and the books actually back him: a name with
   * no projection behind it is not a handcuff, it's a lottery ticket.
   */
  function contingencyBoard() {
    const infl = inflation();
    const byTeamPos = {};
    for (const p of state.players) {
      if (!p.tm || p.tm === 'FA') continue;
      if (!['RB', 'WR', 'TE', 'QB'].includes(p.pos)) continue;
      const k = `${p.tm}|${p.pos}`;
      (byTeamPos[k] = byTeamPos[k] || []).push(p);
    }
    const mine = new Set(state.teams[state.settings.myTeam].picks.map((pk) => pk.pid));

    const rows = [];
    for (const [k, group] of Object.entries(byTeamPos)) {
      if (group.length < 2) continue;
      group.sort((a, b) => anchorValue(b) - anchorValue(a));
      const starter = group[0];
      const starterWorth = anchorValue(starter);
      // Only a real workload is worth insuring.
      if (starterWorth < 18) continue;
      for (const backup of group.slice(1)) {
        if (backup.draftedBy !== null) continue;
        const w = winnerFor(backup);
        const line = activeLines()[VegasEngine.normName(backup.n)];
        const backed = !!(w && w.proj !== null) || backup.v >= 3;
        // Position leverage: a lost bell-cow back hands over the whole job.
        const leverage = backup.pos === 'RB' ? 1 : backup.pos === 'QB' ? 0.8
          : backup.pos === 'TE' ? 0.6 : 0.45;
        const price = adjValue(backup, infl);
        rows.push({
          p: backup, starter, starterWorth, leverage, price,
          proj: w && w.proj !== null ? w.proj : null,
          backed,
          minesStarter: mine.has(starter.id),
          // Value of the job he'd step into, per dollar he costs.
          score: (starterWorth * leverage) / Math.max(1, price) * (backed ? 1 : 0.35)
            * (line ? 1.15 : 1),
        });
      }
    }
    return rows.sort((a, b) => b.score - a.score);
  }

  function renderContingency() {
    const rows = contingencyBoard().slice(0, 10);
    if (!rows.length) return '';
    return `
      <h4 class="vg-sec">🚑 Key handcuffs — league-wide</h4>
      <div class="win-head"><span></span><span>Backup</span><span>Inherits</span><span>Job $</span><span>Cost</span></div>
      ${rows.map((r) => `
        <div class="win-item bench-item" data-pid="${r.p.id}"
             title="${r.p.n} sits behind ${r.starter.n} ($${r.starterWorth} of value). ${r.backed ? 'Analysts/books back him.' : 'Thin projection — speculative.'}">
          <span class="pos-chip pos-${r.p.pos}">${r.p.pos}</span>
          <span class="fill">${r.p.n}${r.minesStarter ? ' <span class="cuff">🔗</span>' : ''}${r.backed ? '' : ' <span class="shaky">?</span>'}</span>
          <span class="fill muted">${r.starter.n}</span>
          <span class="cons">$${r.starterWorth}</span>
          <span class="paybox"><b>$${r.price}</b></span>
        </div>`).join('')}
      <p class="muted">Ranked by the workload waiting in front of them, not by whose roster the
      starter is on — a torn ACL anywhere in the league makes one of these a starter.
      🔗 backs up a player you own. <span class="shaky">?</span> means the analysts and books don't
      support him yet, so he's speculation rather than insurance.</p>`;
  }

  /** Bench buys: insurance and upside that waivers can't hand you. */
  function renderBenchTargets() {
    const me = state.settings.myTeam;
    const bench = benchSpotsLeft(me);
    if (bench <= 0) return '';
    // Not "players who can't start" — early on, every skill player could fill a
    // slot. A bench target is one your bench money can actually reach.
    const chest = benchReserveFor(me);
    const perSpot = Math.max(3, Math.round((chest / bench) * 2.5));
    const rows = Array.from(benchMap().values())
      .filter((b) => b.late <= perSpot)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    if (!rows.length) return '';

    const waivers = state.settings.waivers || 'active';
    const why = (b) => {
      const bits = [];
      if (b.cuffFor) bits.push(`handcuffs ${b.cuffFor}`);
      if (b.proj !== null) bits.push(`${Math.round(b.proj)} pts`);
      if (b.bye) bits.push(`bye ${b.bye}`);
      if (!bits.length) bits.push('value');
      return bits.join(' · ');
    };

    return `
      <h4 class="vg-sec">🪑 Bench targets — ${bench} spot${bench > 1 ? 's' : ''} to fill</h4>
      ${rows.map((b) => `
        <div class="win-item bench-item" data-pid="${b.p.id}" title="${why(b)}">
          <span class="pos-chip pos-${b.p.pos}">${b.p.pos}</span>
          <span class="fill">${b.p.n}${b.cuffFor ? ' <span class="cuff">🔗</span>' : ''}</span>
          <span class="wbar"><i style="width:${Math.round(b.score * 100)}%"></i></span>
          <span class="cons">${b.bye || '—'}</span>
          <span class="paybox"><b>~$${b.late}</b><em>mkt $${b.market}</em></span>
        </div>`).join('')}
      <p class="muted">🔗 handcuffs someone you already own. <b>~$</b> is what he should cost once
      the room's money dries up. ${waivers === 'active'
        ? 'Your league streams easily, so these are weighted toward handcuffs and breakout upside — the two things waivers can\'t replace.'
        : 'Weighted for a league where waivers won\'t bail you out.'}
      ${state.byes ? '' : 'Bye column is empty until you fetch bye weeks (⚙︎ → Fetch bye weeks).'}</p>`;
  }

  function renderWinners() {
    const el = $('#tab-winners');
    const me = state.settings.myTeam;
    const open = openStartingSlots(me);
    const ctx = lineupCtx();
    const infl = ctx.infl;

    const rows = undrafted()
      .filter((p) => p.pos !== 'K' && p.pos !== 'DST')
      .map((p) => ({ p, w: winnerFor(p), g: bidGuide(p), starter: fillsStarter(p) }))
      .filter((x) => x.w && x.w.score > 0)
      .sort((a, b) => b.w.score - a.w.score);

    const needed = rows.filter((x) => x.starter).slice(0, 12);
    const anyEstimated = rows.some((x) => x.w.estimated);

    const pct = (n) => (n === null || n === undefined ? '—' : `${Math.round(n * 100)}%`);
    const row = (x) => {
      const bar = Math.round(x.w.pct * 100);
      const cons = x.w.consistency;
      const consCls = cons === null ? '' : cons >= 0.72 ? 'good' : cons >= 0.55 ? 'ok' : 'bad';
      const tip = `${x.w.proj !== null ? `${Math.round(x.w.proj)} pts · ` : ''}`
        + `${Math.round(x.w.pas)} above a starting ${x.p.pos}`
        + `${cons !== null ? ` · ${pct(cons)} volume-based scoring` : ''}`
        + `${x.w.availability !== null ? ` · ${pct(x.w.availability)} of the season` : ''}`;
      return `<div class="win-item" data-pid="${x.p.id}" title="${tip}">
        <span class="pos-chip pos-${x.p.pos}">${x.p.pos}</span>
        <span class="fill">${x.p.n}${x.p.target ? ' <span class="star">⭐</span>' : ''}</span>
        <span class="wbar"><i style="width:${bar}%"></i></span>
        <span class="cons ${consCls}">${pct(cons)}</span>
        <span class="paybox${x.g.suggested < x.g.market ? ' unaffordable' : ''}">
          <b>$${x.g.suggested}</b><em>${x.g.suggested < x.g.market ? `costs ~$${x.g.market}` : `mkt $${x.g.market}`}</em>
        </span>
      </div>`;
    };

    const slotLine = open.length
      ? open.map((s) => `<span class="need-chip">${s === 'DST' ? 'D/ST' : s} ~$${ctx.floors[s]}</span>`).join('')
      : '<span class="muted">Starting lineup is full — everything left is bench.</span>';

    el.innerHTML = `
      <div class="panel-note">
        <b>🏆 League winners — who to overspend on</b>
        <div class="muted">Ranked by production <b>above a typical starter</b> at the position, then
        discounted for weeks missed and boom-bust scoring. Bench points are worth zero, so only
        players who'd walk into your lineup are listed.</div>
      </div>
      <div class="par-summary">
        <span>Starters open <b>${open.length}</b></span>
        <span>Budget <b>$${teamRemaining(me)}</b></span>
        <span>Bench spots <b>${Math.max(0, teamSpotsLeft(me) - open.length)}</b></span>
      </div>
      ${renderBuyingPower()}
      <h4 class="vg-sec">🧱 Cost to fill your remaining starting slots</h4>
      <div class="needs">${slotLine}</div>
      <p class="muted">That reserve is what the <b>max</b> figure protects. Spend past it and one of
      those slots goes unfilled.</p>
      <div class="win-head"><span></span><span>Player</span><span>Winner</span><span>Steady</span><span>Pay to</span></div>
      ${needed.map(row).join('') || '<div class="muted">No starters left to chase.</div>'}
      ${renderContingency()}
      ${anyEstimated ? '<p class="muted">⚠️ Some scores are estimated from your board values because no Vegas line covers that player — load lines for real consistency and availability numbers.</p>' : ''}
      <p class="muted"><b>$X</b> is the most you're justified paying; <b>mkt</b> is what he'd
      normally go for. The gap between them is your licensed overspend — deliberately small for
      ordinary starters and large only for genuine cornerstones, and never past the point where the
      rest of your lineup drops below market. Click a player for the full ceiling breakdown.</p>`;

    $$('#tab-winners .win-item').forEach((n) =>
      n.addEventListener('click', () => openDraftModal(n.dataset.pid)));
    void infl;
    void ctx;
  }

  // ---------------------------------------------------------------------------
  // Vegas data loading
  // ---------------------------------------------------------------------------
  function vegasMsg(text, isError) {
    const el = $('#vegasMsg');
    el.textContent = text;
    el.style.color = isError ? '' : 'var(--accent)';
    el.classList.remove('hidden');
  }

  async function vegasTestKey() {
    const key = $('#vgKey').value.trim();
    if (!key) return vegasMsg('Enter your Odds API key first.', true);
    try {
      const r = await fetch(`/api/odds/status?key=${encodeURIComponent(key)}`);
      const b = await r.json();
      if (!r.ok) return vegasMsg(b.error, true);
      vegasMsg(`Key works — ${b.creditsRemaining ?? '?'} API credits remaining.`, false);
    } catch (err) {
      vegasMsg(String(err.message || err), true);
    }
  }

  async function vegasFetch() {
    const key = $('#vgKey').value.trim();
    if (!key) return vegasMsg('Enter your Odds API key first.', true);
    const expectedGames = Number($('#vgGames').value) || 16.2;
    const maxEvents = Number($('#vgMaxEvents').value) || 16;
    const btn = $('#btnVgFetch');
    btn.textContent = 'Fetching…';
    try {
      const r = await fetch(`/api/odds/props?key=${encodeURIComponent(key)}&maxEvents=${maxEvents}`);
      const b = await r.json();
      if (!r.ok) return vegasMsg(b.error, true);
      const count = Object.keys(b.players || {}).length;
      if (!count) {
        return vegasMsg('The Odds API returned no player props — books may not have posted them yet for the next slate.', true);
      }
      const v = state.vegas;
      v.raw = b.players;
      v.books = b.books || [];
      v.expectedGames = expectedGames;
      // Keep the user's book picks if those books are still available.
      const avail = v.books.map((x) => x.key);
      const keep = (v.pickedBooks || []).filter((k) => avail.includes(k));
      v.pickedBooks = keep.length ? keep : VegasEngine.defaultBooks(v.books, 3);
      v.lines = VegasEngine.consensusLines(v.raw, v.pickedBooks, expectedGames);
      v.source = 'odds-api';
      v.asOf = `fetched ${new Date().toLocaleString()}`;
      v.meta = b.meta;
      v.stamp = Date.now();
      save();
      hide('#modalVegas');
      renderAll();
    } catch (err) {
      vegasMsg(String(err.message || err), true);
    } finally {
      btn.textContent = 'Fetch lines';
    }
  }

  /** Recomputes season lines from the stored per-book payload. */
  function rebuildLinesFromBooks() {
    const v = state.vegas;
    if (!v.raw) return;
    if (!v.pickedBooks || !v.pickedBooks.length) {
      v.pickedBooks = VegasEngine.defaultBooks(v.books, 3);
    }
    v.lines = VegasEngine.consensusLines(v.raw, v.pickedBooks, v.expectedGames);
    v.stamp = Date.now();
    save();
    renderAll();
  }

  function vegasImportRanks() {
    const text = $('#vgRanks').value.trim();
    if (!text) return vegasMsg('Paste an analyst ranking first.', true);
    const ranks = VegasEngine.parseRanks(text);
    const count = Object.keys(ranks).length;
    if (!count) return vegasMsg('Could not read any player names out of that.', true);
    state.vegas.aranks = ranks;
    state.vegas.arankSource = 'import';
    state.vegas.stamp = Date.now();
    save();
    const matched = state.players.filter((p) => ranks[VegasEngine.normName(p.n)] !== undefined).length;
    hide('#modalVegas');
    renderAll();
    alert(`Imported ${count} analyst ranks — ${matched} matched players on your board.`);
  }

  function vegasClearRanks() {
    state.vegas.aranks = null;
    state.vegas.arankSource = 'sheet';
    state.vegas.stamp = Date.now();
    save();
    hide('#modalVegas');
    renderAll();
  }

  function vegasImport() {
    const csv = $('#vgCsv').value.trim();
    if (!csv) return vegasMsg('Paste some player lines first.', true);
    const { lines, errors } = VegasEngine.parseCsv(csv);
    const count = Object.keys(lines).length;
    if (!count) return vegasMsg(errors[0] || 'No usable rows found.', true);
    state.vegas.lines = lines;
    state.vegas.source = 'import';
    state.vegas.asOf = `imported ${new Date().toLocaleDateString()}`;
    state.vegas.meta = null;
    state.vegas.stamp = Date.now();
    const wins = $('#vgWins').value.trim();
    if (wins) state.vegas.winTotals = VegasEngine.parseWinTotals(wins);
    save();

    // How many of these actually matched a player on the board?
    const matched = state.players.filter((p) => lines[VegasEngine.normName(p.n)]).length;
    hide('#modalVegas');
    renderAll();
    if (matched < count) {
      alert(`Imported ${count} lines — ${matched} matched players on your board. Unmatched names are ignored; check spelling if that number looks low.`);
    }
  }

  // ---------------------------------------------------------------------------
  // Modals & interactions
  // ---------------------------------------------------------------------------
  function openDraftModal(pid) {
    const p = playerById(pid);
    if (!p || p.draftedBy !== null) return;
    currentPid = pid;
    const infl = inflation();
    $('#draftPlayerName').textContent = p.n;
    $('#draftPlayerMeta').textContent =
      `${p.pos} · ${p.tm} · Tier ${p.tier} · sheet $${p.v} · inflation-adjusted $${adjValue(p, infl)}`;
    const sel = $('#draftTeamSelect');
    sel.innerHTML = state.teams.map((t, i) =>
      `<option value="${i}"${i === state.settings.myTeam ? ' selected' : ''}>${t.name} ($${teamRemaining(i)}, max $${teamMaxBid(i)})</option>`).join('');
    $('#draftPrice').value = Math.min(adjValue(p, infl), teamMaxBid(state.settings.myTeam)) || 1;
    renderBidGuide(p);
    updateMaxHint();
    show('#modalDraft');
  }

  /** The overspend panel: market price, justified stretch, lineup-safe ceiling. */
  function renderBidGuide(p) {
    const el = $('#bidGuide');
    const g = bidGuide(p);
    const w = g.winner;
    const starter = fillsStarter(p);
    const open = openStartingSlots(state.settings.myTeam);
    const pctTxt = (n) => (n === null || n === undefined ? '—' : `${Math.round(n * 100)}%`);

    const tier = g.safe < g.market
      ? { cls: 'broke', txt: `⛔ Out of reach — he goes for about $${g.market}, your ceiling is $${g.safe}` }
      : w && w.pct >= 0.75 ? { cls: 'elite', txt: '🏆 League winner — worth stretching for' }
      : w && w.pct >= 0.45 ? { cls: 'solid', txt: '✅ Quality starter' }
      : starter ? { cls: 'ok', txt: 'Fills a starting slot' }
      : { cls: 'bench', txt: '🪑 Bench body — bench points score you nothing' };

    el.innerHTML = `
      <div class="bg-tier ${tier.cls}">${tier.txt}</div>
      <div class="bg-nums">
        <div><label>Worth</label><b class="bg-anchor">$${g.anchor}</b></div>
        <div><label>Market</label><b>$${g.market}</b></div>
        <div class="bg-go"><label>Pay up to</label><b>$${g.suggested}</b></div>
        <div><label>Hard ceiling</label><b>$${g.safe}</b></div>
      </div>
      ${g.bank > 0 && g.withBank > g.suggested
        ? `<div class="bg-bank">🏦 Banked <b>$${g.bank}</b> of value so far — worth $${g.anchor} plus
             that surplus means you can go to <b>$${g.withBank}</b> in a bidding war and still be
             level on value across the draft.</div>`
        : ''}
      <div class="bg-meta muted">
        ${starter ? `Steps into your <b>${open.includes(p.pos) ? p.pos : 'FLEX'}</b> slot` : 'Would sit on your bench'}
        ${w && w.consistency !== null ? ` · ${pctTxt(w.consistency)} of his points are volume-based` : ''}
        ${w && w.availability !== null ? ` · books expect ${Math.round((w.availability) * 17)} games` : ''}
        ${w ? ` · ${Math.round(w.pas)} pts above a starting ${p.pos}` : ''}
      </div>`;
    checkBidWarning();
  }

  /** Live feedback as the price is typed. */
  function checkBidWarning() {
    const p = playerById(currentPid);
    const warn = $('#bidWarn');
    if (!p) return;
    const teamIdx = Number($('#draftTeamSelect').value);
    const price = Math.max(1, Math.round(Number($('#draftPrice').value) || 1));
    if (teamIdx !== state.settings.myTeam) { warn.classList.add('hidden'); return; }

    const g = bidGuide(p);
    const spots = teamSpotsLeft(teamIdx);
    const open = openStartingSlots(teamIdx);
    const startersAfter = open.length - (fillsStarter(p) ? 1 : 0);
    const left = teamRemaining(teamIdx) - price;
    const benchAfter = Math.max(0, (spots - 1) - startersAfter);
    const perStarter = startersAfter > 0
      ? Math.floor((left - benchAfter) / startersAfter)
      : null;

    // Always show what this bid actually leaves behind — that's the real answer
    // to "am I jeopardizing the team".
    const after = startersAfter > 0
      ? `At $${price}: <b>$${left}</b> left for <b>${startersAfter}</b> more starting slots
         (≈$${Math.max(0, perStarter)} each) plus ${benchAfter} bench.`
      : `At $${price}: <b>$${left}</b> left, starting lineup complete.`;

    if (price > g.safe) {
      warn.className = 'bid-warn danger';
      warn.innerHTML = `🚨 <b>$${price} breaks your lineup.</b> ${after} That isn't enough to put a
        startable player in every slot. Hard ceiling is <b>$${g.safe}</b>.`;
    } else if (price > g.suggested) {
      warn.className = 'bid-warn caution';
      warn.innerHTML = `⚠️ Past the justified stretch of <b>$${g.suggested}</b> — the rest of your
        lineup drops below market from here. ${after} Survivable up to $${g.safe}, but only for a
        player you've decided you must own.`;
    } else {
      warn.className = 'bid-warn ok';
      warn.innerHTML = after;
    }
    warn.classList.remove('hidden');
  }

  function updateMaxHint() {
    const i = Number($('#draftTeamSelect').value);
    $('#draftMaxHint').textContent = `Max bid for ${state.teams[i].name}: $${teamMaxBid(i)} (must leave $1 per open spot)`;
    checkBidWarning();
  }

  function confirmDraft() {
    const teamIdx = Number($('#draftTeamSelect').value);
    const price = Math.max(1, Math.round(Number($('#draftPrice').value) || 1));
    if (price > teamMaxBid(teamIdx)) {
      alert(`${state.teams[teamIdx].name} can't bid $${price} — max is $${teamMaxBid(teamIdx)} (needs $1 per remaining roster spot).`);
      return;
    }
    hide('#modalDraft');
    applyPick(currentPid, teamIdx, price);
  }

  function openEditModal() {
    const p = playerById(currentPid);
    if (!p) return;
    $('#editValue').value = p.v;
    $('#editTier').value = p.tier;
    $('#editTarget').checked = !!p.target;
    hide('#modalDraft');
    show('#modalEdit');
  }

  function saveEdit() {
    const p = playerById(currentPid);
    if (p) {
      p.v = Math.max(0, Number($('#editValue').value) || 0);
      p.tier = Math.max(1, Number($('#editTier').value) || 1);
      p.target = $('#editTarget').checked;
      save();
    }
    hide('#modalEdit');
    renderAll();
  }

  // ---- settings ----
  function openSettings() {
    $('#setTeams').value = state.settings.teams;
    $('#setBudget').value = state.settings.budget;
    $('#setRoster').value = state.settings.rosterSize;
    $('#setTeamNames').value = state.teams.map((t) => t.name).join('\n');
    $('#setWaivers').value = state.settings.waivers || 'active';
    $('#byeStatus').textContent = state.byes
      ? `${Object.keys(state.byes).length} teams loaded`
      : 'not loaded';
    const sel = $('#setMyTeam');
    sel.innerHTML = state.teams.map((t, i) =>
      `<option value="${i}"${i === state.settings.myTeam ? ' selected' : ''}>${t.name}</option>`).join('');
    show('#modalSettings');
  }

  function saveSettings() {
    const nTeams = Math.max(4, Math.min(20, Number($('#setTeams').value) || 12));
    state.settings.budget = Math.max(50, Number($('#setBudget').value) || 200);
    state.settings.rosterSize = Math.max(8, Number($('#setRoster').value) || 16);
    const names = $('#setTeamNames').value.split('\n').map((s) => s.trim()).filter(Boolean);
    // resize teams array preserving picks where possible
    while (state.teams.length < nTeams) state.teams.push({ name: `Team ${state.teams.length + 1}`, spent: 0, picks: [] });
    if (state.teams.length > nTeams) state.teams = state.teams.slice(0, nTeams);
    state.settings.teams = nTeams;
    names.forEach((n, i) => { if (state.teams[i]) state.teams[i].name = n; });
    state.settings.myTeam = Math.min(nTeams - 1, Number($('#setMyTeam').value) || 0);
    state.settings.waivers = $('#setWaivers').value || 'active';
    hide('#modalSettings');
    save(); renderAll();
  }

  function resetDraft() {
    if (!confirm('Reset all picks? (Keeps your player values, tiers, targets and settings.)')) return;
    for (const p of state.players) { p.draftedBy = null; p.price = 0; }
    for (const t of state.teams) { t.spent = 0; t.picks = []; }
    state.log = [];
    state.syncedKeys = [];
    hide('#modalSettings');
    save(); renderAll();
  }

  // ---------------------------------------------------------------------------
  // Live sync (Sleeper / ESPN)
  // ---------------------------------------------------------------------------
  let pollTimer = null;

  function setBadge(mode, ok) {
    const b = $('#connBadge');
    b.className = `badge ${mode === 'manual' ? 'badge-manual' : ok ? 'badge-live' : 'badge-error'}`;
    b.textContent = mode === 'manual' ? 'MANUAL' : `${mode.toUpperCase()} ${ok ? '● LIVE' : '⚠ RETRYING'}`;
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function startPolling() {
    stopPolling();
    if (state.conn.type === 'manual') { setBadge('manual', true); return; }
    const tick = async () => {
      try {
        if (state.conn.type === 'sleeper') await syncSleeper();
        else if (state.conn.type === 'espn') await syncEspn();
        setBadge(state.conn.type, true);
      } catch (err) {
        console.warn('sync error:', err);
        setBadge(state.conn.type, false);
      }
    };
    tick();
    pollTimer = setInterval(tick, 5000);
  }

  async function syncSleeper() {
    const c = state.conn;
    const picks = await SleeperSync.getPicks(c.draftId, c.info);
    for (const pk of picks) {
      if (state.syncedKeys.includes(pk.key)) continue;
      const teamIdx = Math.max(0, Math.min(state.teams.length - 1, (pk.slot || 1) - 1));
      const player = ensurePlayer(pk.playerName, pk.pos, pk.nflTeam);
      if (player.draftedBy !== null) { state.syncedKeys.push(pk.key); continue; }
      applyPick(player.id, teamIdx, pk.price, pk.key);
    }
  }

  async function syncEspn() {
    const c = state.conn;
    const picks = await EspnSync.getPicks(c.year, c.leagueId, { s2: c.s2, swid: c.swid });
    for (const pk of picks) {
      if (state.syncedKeys.includes(pk.key)) continue;
      const teamIdx = c.espnTeamIds.indexOf(pk.espnTeamId);
      const player = ensurePlayer(pk.playerName, pk.pos, pk.nflTeam);
      if (player.draftedBy !== null || teamIdx < 0) { state.syncedKeys.push(pk.key); continue; }
      applyPick(player.id, teamIdx, pk.price, pk.key);
    }
  }

  /**
   * Bye weeks come from ESPN's public pro-team schedule, which needs no auth —
   * so Sleeper drafters get them too. Pulled automatically on connect.
   */
  async function fetchByes(interactive) {
    const year = state.conn.year
      || (state.conn.type === 'sleeper' ? new Date().getFullYear() : new Date().getFullYear());
    const status = $('#byeStatus');
    if (interactive && status) status.textContent = 'fetching…';
    try {
      const r = await fetch(`/api/byes?year=${encodeURIComponent(year)}`);
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
      state.byes = b;
      save();
      if (status) status.textContent = `${Object.keys(b).length} teams loaded`;
      renderAll();
    } catch (err) {
      if (status) status.textContent = String(err.message || err);
      if (interactive) console.warn('bye fetch failed:', err);
    }
  }

  function connError(msg) {
    const el = $('#connError');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  async function connectSleeper() {
    const draftId = $('#slDraftId').value.trim();
    if (!draftId) return connError('Enter a Sleeper draft ID (or find one by username).');
    try {
      $('#btnSlConnect').textContent = 'Connecting…';
      const info = await SleeperSync.getDraftInfo(draftId);
      if (info.type !== 'auction') {
        connError(`Heads up: that draft's type is "${info.type}", not auction — connecting anyway.`);
      }
      // apply league shape
      state.settings.teams = info.teams;
      state.settings.budget = info.budget;
      state.settings.rosterSize = info.rosterSize;
      state.teams = Array.from({ length: info.teams }, (_, i) => ({
        name: info.slotNames[i + 1] || `Team ${i + 1}`, spent: 0, picks: [] }));
      for (const p of state.players) { p.draftedBy = null; p.price = 0; }
      state.log = []; state.syncedKeys = [];
      state.conn = { type: 'sleeper', draftId, info };
      save();
      hide('#modalConnect');
      startPolling();
      fetchByes(false);
      renderAll();
      openSettings(); // let the user pick which team is theirs
    } catch (err) {
      connError(`Sleeper: ${err.message}`);
    } finally {
      $('#btnSlConnect').textContent = 'Connect';
    }
  }

  async function connectEspn() {
    const leagueId = $('#esLeagueId').value.trim();
    const year = $('#esSeason').value.trim();
    const s2 = $('#esS2').value.trim();
    const swid = $('#esSwid').value.trim();
    if (!leagueId || !year) return connError('Enter an ESPN league ID and season.');
    try {
      $('#btnEsConnect').textContent = 'Connecting…';
      const info = await EspnSync.getLeagueInfo(year, leagueId, { s2, swid });
      state.settings.teams = info.teams.length || 12;
      state.settings.budget = info.budget;
      state.settings.rosterSize = info.rosterSize;
      state.teams = info.teams.map((t) => ({ name: t.name, spent: 0, picks: [] }));
      for (const p of state.players) { p.draftedBy = null; p.price = 0; }
      state.log = []; state.syncedKeys = [];
      state.conn = { type: 'espn', year, leagueId, s2, swid, espnTeamIds: info.teams.map((t) => t.espnId) };
      save();
      hide('#modalConnect');
      startPolling();
      fetchByes(false);
      renderAll();
      openSettings();
    } catch (err) {
      connError(`ESPN: ${err.message}`);
    } finally {
      $('#btnEsConnect').textContent = 'Connect';
    }
  }

  async function findSleeperDrafts() {
    const u = $('#slUsername').value.trim();
    const season = $('#slSeason').value.trim() || '2026';
    if (!u) return connError('Enter a Sleeper username first.');
    try {
      $('#btnSlFind').textContent = 'Searching…';
      const drafts = await SleeperSync.findDrafts(u, season);
      const list = $('#slDraftList');
      if (!drafts.length) { list.innerHTML = '<div class="muted">No drafts found for that season.</div>'; return; }
      list.innerHTML = drafts.map((d) =>
        `<div class="found-item" data-draft="${d.id}"><span>${d.isAuction ? '💰 ' : ''}${d.label}</span><span class="muted">${d.id}</span></div>`).join('');
      $$('#slDraftList .found-item').forEach((el) => el.addEventListener('click', () => {
        $('#slDraftId').value = el.dataset.draft;
        $$('#slDraftList .found-item').forEach((x) => x.classList.remove('sel'));
        el.classList.add('sel');
      }));
    } catch (err) {
      connError(`Sleeper: ${err.message}`);
    } finally {
      $('#btnSlFind').textContent = 'Find my drafts';
    }
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  const show = (sel) => $(sel).classList.remove('hidden');
  const hide = (sel) => $(sel).classList.add('hidden');

  function wire() {
    // board interactions
    $('#playerBoard').addEventListener('click', (e) => {
      const row = e.target.closest('.p-row');
      if (row && !row.classList.contains('drafted')) openDraftModal(row.dataset.pid);
    });
    $('#nomHelper').addEventListener('click', (e) => {
      const it = e.target.closest('.nom-item');
      if (it) openDraftModal(it.dataset.pid);
    });
    $('#searchBox').addEventListener('input', (e) => { boardFilter.q = e.target.value; renderBoard(); });
    $('#hideDrafted').addEventListener('change', (e) => { boardFilter.hideDrafted = e.target.checked; renderBoard(); });
    $$('#posFilters button').forEach((b) => b.addEventListener('click', () => {
      $$('#posFilters button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      boardFilter.pos = b.dataset.pos;
      renderBoard();
    }));

    // right tabs
    $$('#rightTabs button').forEach((b) => b.addEventListener('click', () => {
      $$('#rightTabs button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      $$('.tab-body').forEach((x) => x.classList.add('hidden'));
      show(`#tab-${b.dataset.tab}`);
    }));

    // draft modal
    $('#btnConfirmDraft').addEventListener('click', confirmDraft);
    $('#draftTeamSelect').addEventListener('change', updateMaxHint);
    $('#draftPrice').addEventListener('input', checkBidWarning);
    $('#btnEditPlayer').addEventListener('click', openEditModal);
    $('#btnSaveEdit').addEventListener('click', saveEdit);
    $('#btnUndo').addEventListener('click', () => {
      if (state.conn.type !== 'manual') { alert('Undo is disabled while live-synced — fix it on the draft platform and it will re-sync.'); return; }
      undoLast();
    });

    // settings
    $('#btnSettings').addEventListener('click', openSettings);
    $('#btnFetchByes').addEventListener('click', () => fetchByes(true));
    $('#btnSaveSettings').addEventListener('click', saveSettings);
    $('#btnResetDraft').addEventListener('click', resetDraft);

    // connect modal
    $('#btnConnect').addEventListener('click', () => { $('#connError').classList.add('hidden'); show('#modalConnect'); });
    $$('#connTabs button').forEach((b) => b.addEventListener('click', () => {
      $$('#connTabs button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      $$('#modalConnect .ctab-body').forEach((x) => x.classList.add('hidden'));
      show(`#ctab-${b.dataset.ctab}`);
    }));
    // vegas modal
    $$('#vegTabs button').forEach((b) => b.addEventListener('click', () => {
      $$('#vegTabs button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      $$('#modalVegas .ctab-body').forEach((x) => x.classList.add('hidden'));
      show(`#vtab-${b.dataset.vtab}`);
    }));
    $('#btnVgTest').addEventListener('click', vegasTestKey);
    $('#btnVgFetch').addEventListener('click', vegasFetch);
    $('#btnVgImport').addEventListener('click', vegasImport);
    $('#btnVgImportRanks').addEventListener('click', vegasImportRanks);
    $('#btnVgClearRanks').addEventListener('click', vegasClearRanks);

    $('#btnSlFind').addEventListener('click', findSleeperDrafts);
    $('#btnSlConnect').addEventListener('click', connectSleeper);
    $('#btnEsConnect').addEventListener('click', connectEspn);
    $('#btnManual').addEventListener('click', () => {
      stopPolling();
      state.conn = { type: 'manual' };
      save(); setBadge('manual', true); hide('#modalConnect');
    });

    // generic modal close
    $$('.modal').forEach((m) => {
      m.addEventListener('click', (e) => {
        if (e.target === m || e.target.hasAttribute('data-close')) m.classList.add('hidden');
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  load();
  wire();
  renderAll();
  startPolling();
})();
