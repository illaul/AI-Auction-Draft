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
      settings: { teams, budget: 200, rosterSize: 16, myTeam: 0 },
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
      blend: 0,             // % weight of Vegas dollars blended into your values
      lines: null,          // null => use the bundled sample
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
        if (!state.vegas) state.vegas = freshVegas(); // saved before Vegas existed
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
   * The dollar figure the app prices against. Equals your own value unless you
   * dial in a Vegas blend, in which case it's a weighted mix of the two.
   */
  function sheetValue(p) {
    const w = (state.vegas.blend || 0) / 100;
    if (!w) return p.v;
    const vg = vegasFor(p);
    if (!vg) return p.v;
    return Math.max(1, Math.round(p.v * (1 - w) + vg.val * w));
  }

  /** Room inflation: remaining league money vs. sheet value of draftable remainder. */
  function inflation() {
    let moneyLeft = 0, spotsLeft = 0;
    state.teams.forEach((_, i) => { moneyLeft += teamRemaining(i); spotsLeft += teamSpotsLeft(i); });
    if (spotsLeft <= 0) return 1;
    const pool = undrafted().slice().sort((a, b) => sheetValue(b) - sheetValue(a)).slice(0, spotsLeft);
    const poolValue = pool.reduce((s, p) => s + Math.max(sheetValue(p), 1), 0);
    if (poolValue <= 0) return 1;
    return moneyLeft / poolValue;
  }

  const adjValue = (p, infl) => Math.max(1, Math.round(sheetValue(p) * infl));

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
  }

  function renderTopStats() {
    const me = state.settings.myTeam;
    $('#statBudget').textContent = `$${teamRemaining(me)}`;
    $('#statMaxBid').textContent = `$${teamMaxBid(me)}`;
    $('#statSpots').textContent = teamSpotsLeft(me);
    $('#statInflation').textContent = `${inflation().toFixed(2)}×`;
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

    // biggest Vegas disagreement at a position I still need
    if (vegasActive() && mySpots > 2) {
      const bull = undrafted()
        .map((p) => ({ p, vg: vegasFor(p) }))
        .filter((x) => x.vg && x.vg.edge >= 6
          && (myNeeds.includes(x.p.pos) || (FLEX_POS.includes(x.p.pos) && myNeeds.includes('FLX'))))
        .sort((a, b) => b.vg.edge - a.vg.edge)[0];
      if (bull) {
        tips.push({ t: `📈 Vegas edge: the books' props imply ${bull.p.n} is worth $${bull.vg.val} — $${bull.vg.edge} above your sheet. Bid up to the Vegas number, not yours.` });
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
    players.sort((a, b) => sheetValue(b) - sheetValue(a) || a.n.localeCompare(b.n));

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
        const veg = !vg || drafted ? ''
          : vg.edge >= 3 ? `<span class="veg up" title="Vegas values him at $${vg.val} (${Math.round(vg.proj)} pts)">▲$${vg.edge}</span>`
          : vg.edge <= -3 ? `<span class="veg down" title="Vegas values him at $${vg.val} (${Math.round(vg.proj)} pts)">▼$${Math.abs(vg.edge)}</span>`
          : `<span class="veg flat" title="Vegas values him at $${vg.val} (${Math.round(vg.proj)} pts)">≈</span>`;
        return `<div class="p-row${drafted ? ' drafted' : ''}" data-pid="${p.id}">
          <span class="pos-chip pos-${p.pos}">${p.pos === 'DST' ? 'D' : p.pos}</span>
          <span class="p-name">${p.target ? '<span class="star">⭐</span> ' : ''}${p.n}<span class="tm">${p.tm}</span></span>
          <span class="p-val">$${sheetValue(p)}</span>
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

    // 2b. Vegas edge: books imply more usage than your sheet says he's worth
    if (vegasActive()) {
      const needsPos = (pos) => myNeeds.includes(pos) || (FLEX_POS.includes(pos) && myNeeds.includes('FLX'));
      const bulls = undrafted()
        .map((p) => ({ p, vg: vegasFor(p) }))
        .filter((x) => x.vg && x.vg.edge >= 4 && needsPos(x.p.pos))
        .sort((a, b) => b.vg.edge - a.vg.edge)
        .slice(0, 4);
      if (bulls.length && mySpots > 2) {
        groups.push(`<div class="nom-group vegas"><h4>📈 Vegas is high on these (you need them)</h4>${bulls.map((x) => item(x.p, `books say $${x.vg.val} · +$${x.vg.edge}`)).join('')}</div>`);
      }
      const fades = undrafted()
        .map((p) => ({ p, vg: vegasFor(p) }))
        .filter((x) => x.vg && x.vg.edge <= -6 && !needsPos(x.p.pos) && x.p.v >= 12)
        .sort((a, b) => a.vg.edge - b.vg.edge)
        .slice(0, 3);
      if (fades.length && mySpots > 2) {
        groups.push(`<div class="nom-group drain"><h4>📉 Vegas fades — nominate, let someone else pay</h4>${fades.map((x) => item(x.p, `books say only $${x.vg.val}`)).join('')}</div>`);
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
      const diff = entry.price - sheetValue(p);
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

    el.innerHTML = slots.map((s) => `
      <div class="roster-slot">
        <span class="slot-label">${s.pos === 'DST' ? 'D/ST' : s.pos}</span>
        ${s.pick
          ? `<span>${s.pick.p.n} <span class="tm muted">${s.pick.p.tm}</span></span><span class="paid">$${s.pick.price}</span>`
          : '<span class="empty">empty</span><span class="paid muted"></span>'}
      </div>`).join('') +
      `<div class="par-summary" style="margin-top:10px">
        <span>Spent <b>$${state.teams[me].spent}</b></span>
        <span>Left <b>$${teamRemaining(me)}</b></span>
        <span>Max bid <b>$${teamMaxBid(me)}</b></span>
      </div>`;
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

    const controls = `
      <div class="vg-controls">
        <button id="btnVgOpen" class="btn btn-sm">Fetch / import lines</button>
      </div>
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
        <label>Blend into my values <b>${v.blend}%</b></label>
        <input id="vgBlend" type="range" min="0" max="100" step="5" value="${v.blend}" />
      </div>
      <p class="muted">At 0% your own numbers drive every price and Vegas is pure signal. Dial it up
      to let the books move your sheet — 25–40% is a sane range.</p>`;

    let body = '';
    if (!vegasActive()) {
      body = '<div class="log-empty">Vegas edges are hidden until real lines are loaded.</div>';
    } else {
      const rated = state.players
        .filter((p) => p.draftedBy === null)
        .map((p) => ({ p, vg: vegasFor(p) }))
        .filter((x) => x.vg);
      const bulls = rated.slice().sort((a, b) => b.vg.edge - a.vg.edge).filter((x) => x.vg.edge > 0).slice(0, 10);
      const fades = rated.slice().sort((a, b) => a.vg.edge - b.vg.edge).filter((x) => x.vg.edge < 0).slice(0, 8);

      const row = (x) => `<div class="vg-item" data-pid="${x.p.id}">
          <span class="pos-chip pos-${x.p.pos}">${x.p.pos}</span>
          <span class="fill">${x.p.n}</span>
          <span class="muted">${Math.round(x.vg.proj)} pts</span>
          <span class="mine">$${x.p.v}</span>
          <span class="theirs">$${x.vg.val}</span>
          <span class="edge ${x.vg.edge > 0 ? 'up' : 'down'}">${x.vg.edge > 0 ? '+' : ''}${x.vg.edge}</span>
        </div>`;

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

      body = `
        <div class="vg-head"><span></span><span>Player</span><span>Proj</span><span>Mine</span><span>Vegas</span><span>Edge</span></div>
        <h4 class="vg-sec up">📈 Books are higher than you — buy</h4>
        ${bulls.map(row).join('') || '<div class="muted">No positive edges left.</div>'}
        <h4 class="vg-sec down">📉 Books are lower — fade or let the room pay</h4>
        ${fades.map(row).join('') || '<div class="muted">No negative edges left.</div>'}
        <h4 class="vg-sec">🏆 Team win totals</h4>
        <div class="needs">${winChips || '<span class="muted">None loaded.</span>'}</div>
        <h4 class="vg-sec">📋 Line coverage</h4>
        <div class="needs">${covChips}</div>
        <p class="muted">Vegas dollars redistribute the money you already assign to covered players,
        so edges stay meaningful at any coverage level.
        ${(state.vegas.compare || 'pos') === 'pos'
          ? 'Edges compare a player to others at <b>his own position</b> — deciding RB vs. WR is your tiers\' job, not the books\'.'
          : '<b>Across-positions mode</b> only holds up when every position has deep coverage; thin groups will bias a whole position one way.'}
        ${thin ? ' Groups under 8 players make replacement level optimistic — treat those edges as rough.' : ''}</p>`;
    }

    el.innerHTML = banner + controls + body;

    const bind = (sel, ev, fn) => { const n = $(sel); if (n) n.addEventListener(ev, fn); };
    bind('#btnVgAllow', 'click', () => { state.vegas.allowSample = true; save(); renderAll(); });
    bind('#btnVgDisallow', 'click', () => { state.vegas.allowSample = false; save(); renderAll(); });
    bind('#btnVgOpen', 'click', () => { $('#vegasMsg').classList.add('hidden'); show('#modalVegas'); });
    bind('#vgScoring', 'change', (e) => { state.vegas.scoring = e.target.value; save(); renderAll(); });
    bind('#vgCompare', 'change', (e) => { state.vegas.compare = e.target.value; save(); renderAll(); });
    bind('#vgBlend', 'change', (e) => { state.vegas.blend = Number(e.target.value); save(); renderAll(); });
    $$('#tab-vegas .vg-item').forEach((n) => n.addEventListener('click', () => openDraftModal(n.dataset.pid)));
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
      const perGame = {};
      for (const [name, p] of Object.entries(b.players || {})) {
        perGame[VegasEngine.normName(name)] = { ...p, name };
      }
      const count = Object.keys(perGame).length;
      if (!count) {
        return vegasMsg('The Odds API returned no player props — books may not have posted them yet for the next slate.', true);
      }
      state.vegas.lines = VegasEngine.extrapolateWeekProps(perGame, expectedGames);
      state.vegas.source = 'odds-api';
      state.vegas.asOf = `fetched ${new Date().toLocaleString()}`;
      state.vegas.meta = b.meta;
      state.vegas.stamp = Date.now();
      save();
      hide('#modalVegas');
      renderAll();
    } catch (err) {
      vegasMsg(String(err.message || err), true);
    } finally {
      btn.textContent = 'Fetch lines';
    }
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
    updateMaxHint();
    show('#modalDraft');
  }

  function updateMaxHint() {
    const i = Number($('#draftTeamSelect').value);
    $('#draftMaxHint').textContent = `Max bid for ${state.teams[i].name}: $${teamMaxBid(i)} (must leave $1 per open spot)`;
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
    $('#btnEditPlayer').addEventListener('click', openEditModal);
    $('#btnSaveEdit').addEventListener('click', saveEdit);
    $('#btnUndo').addEventListener('click', () => {
      if (state.conn.type !== 'manual') { alert('Undo is disabled while live-synced — fix it on the draft platform and it will re-sync.'); return; }
      undoLast();
    });

    // settings
    $('#btnSettings').addEventListener('click', openSettings);
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
