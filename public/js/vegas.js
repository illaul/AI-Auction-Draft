/**
 * Vegas engine — turn sportsbook lines into auction dollars.
 *
 * Pipeline:
 *   prop lines (season totals, or Week-1 props extrapolated)
 *     -> fantasy points, using your league's scoring
 *     -> value over replacement (VORP) at each position
 *     -> auction dollars, using your league's money supply
 *     -> EDGE = Vegas dollars - your sheet dollars
 *
 * A positive edge means the books' implied usage is worth more than you (or the
 * room) are pricing the player at. That is the buy signal. Negative edge is the
 * fade signal — let somebody else pay for the name.
 *
 * NOTE ON DATA: the bundled LINES are SAMPLE values for demonstration only.
 * They are NOT real sportsbook numbers. Import or fetch real lines before you
 * draft — the app will not surface Vegas edges on the board until you do.
 */
window.VegasEngine = (function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Scoring presets — points per unit
  // ---------------------------------------------------------------------------
  const SCORING = {
    ppr:  { py: 0.04, ptd: 4, int: -2, ry: 0.1, rtd: 6, rec: 1.0, recy: 0.1, rectd: 6 },
    half: { py: 0.04, ptd: 4, int: -2, ry: 0.1, rtd: 6, rec: 0.5, recy: 0.1, rectd: 6 },
    std:  { py: 0.04, ptd: 4, int: -2, ry: 0.1, rtd: 6, rec: 0.0, recy: 0.1, rectd: 6 },
  };

  /** Season fantasy points implied by a player's prop line. */
  function projectPoints(props, scoringKey) {
    const s = SCORING[scoringKey] || SCORING.ppr;
    const g = (k) => Number(props[k] || 0);
    if (props.fpts) return Number(props.fpts); // explicit override from an import
    return (
      g('py') * s.py + g('ptd') * s.ptd + g('int') * s.int +
      g('ry') * s.ry + g('rtd') * s.rtd +
      g('rec') * s.rec + g('recy') * s.recy + g('rectd') * s.rectd
    );
  }

  // ---------------------------------------------------------------------------
  // Projections -> auction dollars (VORP pricing)
  // ---------------------------------------------------------------------------
  /**
   * How many players at each position the room will actually draft. Starters
   * plus a share of flex and bench spots — this sets replacement level, which
   * is what makes RB/WR dollars comparable to QB/TE dollars.
   */
  function draftedCounts(league) {
    const { teams, rosterSize } = league;
    const startersUsed = 10; // QB, RB×2, WR×2, TE, FLEX×2, K, DST
    const bench = Math.max(0, rosterSize - startersUsed);
    return {
      QB: Math.round(teams * (1 + bench * 0.10)),
      RB: Math.round(teams * (2 + 2 * 0.45 + bench * 0.40)),
      WR: Math.round(teams * (2 + 2 * 0.45 + bench * 0.40)),
      TE: Math.round(teams * (1 + 2 * 0.10 + bench * 0.10)),
      K: teams,
      DST: teams,
    };
  }

  /**
   * Projection of the last player drafted at a position — the baseline that
   * makes RB dollars comparable to QB dollars.
   *
   * When you have lines for fewer players than the room will draft (common:
   * books post props for ~50 skill players, a 12-team league drafts ~190),
   * reading the worst player you happen to have would put replacement level
   * far too high, which crushes the deep positions and wildly overprices QBs.
   * Positional scoring decays roughly logarithmically with rank, so fit
   * proj ≈ a + b·ln(rank) over what you do have and read off rank n.
   */
  function replacementLevel(sortedList, n) {
    const len = sortedList.length;
    if (!len) return 0;
    if (n <= len) return sortedList[n - 1].proj;

    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < len; i++) {
      const x = Math.log(i + 1), y = sortedList[i].proj;
      sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    const denom = len * sxx - sx * sx;
    const worst = sortedList[len - 1].proj;
    if (!denom) return worst;
    const b = (len * sxy - sx * sy) / denom;
    const a = (sy - b * sx) / len;
    // A deeper rank can never be better than the worst player we can actually see.
    return Math.max(0, Math.min(worst, a + b * Math.log(n)));
  }

  /**
   * Prices Vegas projections in auction dollars.
   *
   * Lines rarely cover the whole draftable pool, so the money is NOT spread
   * across the league's full budget — that would inflate every covered player
   * by the inverse of the coverage rate. Instead the model is calibrated to
   * your own board: the same dollars you already assign to the covered players
   * get redistributed according to the books' implied usage. That makes the
   * edge a clean "Vegas would spend your money differently" signal, and it
   * stays correct whether you have lines for 40 players or 400.
   *
   * @param {Array<{id,pos,proj,mine}>} rows  players with a Vegas projection
   * @param {{teams,budget,rosterSize}} league
   * @returns {Map<id, {proj, vorp, val}>}
   */
  function priceProjections(rows, league) {
    const counts = draftedCounts(league);
    const byPos = {};
    for (const r of rows) (byPos[r.pos] = byPos[r.pos] || []).push(r);

    const replacement = {};
    for (const [pos, list] of Object.entries(byPos)) {
      list.sort((a, b) => b.proj - a.proj);
      replacement[pos] = replacementLevel(list, counts[pos] || list.length);
    }

    // Group the VORP per position first — both calibration modes need it.
    const groups = {};
    for (const [pos, list] of Object.entries(byPos)) {
      const n = counts[pos] || list.length;
      const g = { rows: [], vorpSum: 0, mineSum: 0 };
      list.forEach((r, i) => {
        const vorp = i < n ? Math.max(0, r.proj - replacement[pos]) : 0;
        g.rows.push({ r, vorp });
        g.vorpSum += vorp;
        g.mineSum += Math.max(0, Number(r.mine) || 0);
      });
      groups[pos] = g;
    }

    const fallbackPot = Math.max(1, league.teams * league.budget - league.teams * league.rosterSize);
    const out = new Map();

    if (league.compare === 'global') {
      // One pot across every position. Only trustworthy when coverage is deep
      // at every position — otherwise replacement levels aren't comparable.
      let vorpSum = 0, mineSum = 0, count = 0;
      for (const g of Object.values(groups)) {
        vorpSum += g.vorpSum; mineSum += g.mineSum; count += g.rows.length;
      }
      const pot = mineSum > 0 ? Math.max(1, mineSum - count) : fallbackPot;
      const perPoint = vorpSum > 0 ? pot / vorpSum : 0;
      for (const g of Object.values(groups)) {
        for (const { r, vorp } of g.rows) {
          out.set(r.id, { proj: r.proj, vorp, val: Math.max(1, Math.round(1 + vorp * perPoint)) });
        }
      }
      return out;
    }

    // Default: calibrate each position against your own dollars for that
    // position. Edges then read "among tight ends, the books like him more
    // than you do" — which stays valid no matter how thin your coverage is,
    // and never manufactures a fake "every TE is a buy" signal.
    for (const g of Object.values(groups)) {
      const pot = g.mineSum > 0
        ? Math.max(1, g.mineSum - g.rows.length)
        : fallbackPot * (g.rows.length / Math.max(1, Object.values(groups).reduce((s, x) => s + x.rows.length, 0)));
      const perPoint = g.vorpSum > 0 ? pot / g.vorpSum : 0;
      for (const { r, vorp } of g.rows) {
        out.set(r.id, { proj: r.proj, vorp, val: Math.max(1, Math.round(1 + vorp * perPoint)) });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Name matching
  // ---------------------------------------------------------------------------
  function normName(n) {
    return String(n || '').toLowerCase()
      .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '')
      .replace(/[^a-z]/g, '');
  }

  // ---------------------------------------------------------------------------
  // CSV / paste import
  // ---------------------------------------------------------------------------
  const COL_ALIASES = {
    player: 'name', name: 'name', playername: 'name',
    pos: 'pos', position: 'pos',
    team: 'tm', tm: 'tm',
    games: 'g', g: 'g', gp: 'g',
    passyds: 'py', passingyards: 'py', pyds: 'py', passyards: 'py',
    passtd: 'ptd', passingtds: 'ptd', ptd: 'ptd', passtds: 'ptd',
    int: 'int', ints: 'int', interceptions: 'int',
    rushyds: 'ry', rushingyards: 'ry', ryds: 'ry', rushyards: 'ry',
    rushtd: 'rtd', rushingtds: 'rtd', rtd: 'rtd', rushtds: 'rtd',
    rec: 'rec', receptions: 'rec', catches: 'rec',
    recyds: 'recy', receivingyards: 'recy', recyards: 'recy',
    rectd: 'rectd', receivingtds: 'rectd', rectds: 'rectd',
    fpts: 'fpts', points: 'fpts', projection: 'fpts', proj: 'fpts',
  };

  /** Parses CSV/TSV with a header row. Returns { lines, errors }. */
  function parseCsv(text) {
    const errors = [];
    const rows = String(text).trim().split(/\r?\n/).filter((l) => l.trim());
    if (rows.length < 2) return { lines: {}, errors: ['Need a header row plus at least one player row.'] };

    const delim = rows[0].includes('\t') ? '\t' : ',';
    const header = rows[0].split(delim).map((h) => COL_ALIASES[h.trim().toLowerCase().replace(/[^a-z]/g, '')] || null);
    if (!header.includes('name')) return { lines: {}, errors: ['No "player" (or "name") column found in the header row.'] };

    const lines = {};
    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i].split(delim);
      const rec = {};
      header.forEach((key, ci) => {
        if (!key) return;
        const raw = (cells[ci] || '').trim();
        rec[key] = key === 'name' || key === 'pos' || key === 'tm' ? raw : Number(raw.replace(/[^0-9.\-]/g, '')) || 0;
      });
      if (!rec.name) { errors.push(`Row ${i + 1}: missing player name — skipped.`); continue; }
      rec.pos = (rec.pos || '').toUpperCase().replace('D/ST', 'DST').replace('DEF', 'DST');
      lines[normName(rec.name)] = rec;
    }
    return { lines, errors };
  }

  /** Parses "BUF 11.5" / "BUF,11.5" lines into { TEAM: wins }. */
  function parseWinTotals(text) {
    const out = {};
    for (const line of String(text).trim().split(/\r?\n/)) {
      const m = line.trim().match(/^([A-Za-z]{2,4})[\s,:]+(\d+(?:\.\d+)?)/);
      if (m) out[m[1].toUpperCase()] = Number(m[2]);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Week-1 props -> season lines
  // ---------------------------------------------------------------------------
  /**
   * The Odds API serves per-game props, not season totals. Extrapolating a
   * Week-1 line across an expected-games count is a crude but genuinely useful
   * proxy for the books' view of a player's role.
   */
  function extrapolateWeekProps(perGame, expectedGames) {
    const lines = {};
    for (const [key, p] of Object.entries(perGame)) {
      const g = expectedGames || 16.2;
      lines[key] = {
        name: p.name, pos: p.pos || '', tm: p.tm || '', g,
        py: (p.py || 0) * g, ptd: (p.ptd || 0) * g, int: (p.int || 0) * g,
        ry: (p.ry || 0) * g, rtd: (p.rtd || 0) * g,
        rec: (p.rec || 0) * g, recy: (p.recy || 0) * g, rectd: (p.rectd || 0) * g,
      };
    }
    return lines;
  }

  /** American odds -> implied probability. */
  function impliedProb(american) {
    const a = Number(american);
    if (!a) return 0;
    return a > 0 ? 100 / (a + 100) : -a / (-a + 100);
  }

  // ---------------------------------------------------------------------------
  // SAMPLE DATA — NOT REAL SPORTSBOOK LINES.
  // Illustrative season-long numbers so the feature is usable out of the box.
  // Replace before draft day via "Fetch live" or "Import lines".
  // ---------------------------------------------------------------------------
  const SAMPLE_LINES_RAW = [
    // name, pos, tm, g, py, ptd, int, ry, rtd, rec, recy, rectd
    ['Josh Allen', 'QB', 'BUF', 17, 4050, 30, 12, 560, 12, 0, 0, 0],
    ['Lamar Jackson', 'QB', 'BAL', 17, 3900, 30, 8, 750, 5, 0, 0, 0],
    ['Jayden Daniels', 'QB', 'WAS', 17, 3850, 26, 10, 720, 6, 0, 0, 0],
    ['Jalen Hurts', 'QB', 'PHI', 17, 3500, 22, 9, 570, 11, 0, 0, 0],
    ['Joe Burrow', 'QB', 'CIN', 17, 4550, 34, 11, 180, 2, 0, 0, 0],
    ['Patrick Mahomes', 'QB', 'KC', 17, 4200, 28, 10, 340, 3, 0, 0, 0],
    ['Baker Mayfield', 'QB', 'TB', 17, 4100, 30, 14, 300, 4, 0, 0, 0],
    ['Bo Nix', 'QB', 'DEN', 17, 3800, 26, 11, 420, 5, 0, 0, 0],
    ['Drake Maye', 'QB', 'NE', 17, 3950, 26, 10, 400, 4, 0, 0, 0],
    ['Brock Purdy', 'QB', 'SF', 17, 4000, 26, 11, 200, 2, 0, 0, 0],
    ['Jordan Love', 'QB', 'GB', 17, 3900, 28, 12, 240, 3, 0, 0, 0],
    ['Matthew Stafford', 'QB', 'LAR', 17, 4150, 29, 11, 90, 1, 0, 0, 0],

    ['Bijan Robinson', 'RB', 'ATL', 16.5, 0, 0, 0, 1350, 11, 62, 500, 3],
    ['Jahmyr Gibbs', 'RB', 'DET', 16.5, 0, 0, 0, 1250, 12, 55, 480, 3],
    ['Saquon Barkley', 'RB', 'PHI', 16, 0, 0, 0, 1400, 12, 35, 260, 1],
    ['Ashton Jeanty', 'RB', 'LV', 16.5, 0, 0, 0, 1280, 10, 44, 340, 2],
    ['Christian McCaffrey', 'RB', 'SF', 14.5, 0, 0, 0, 1000, 8, 68, 560, 3],
    ['Jonathan Taylor', 'RB', 'IND', 16, 0, 0, 0, 1300, 11, 30, 220, 1],
    ["De'Von Achane", 'RB', 'MIA', 16, 0, 0, 0, 900, 8, 72, 560, 3],
    ['James Cook', 'RB', 'BUF', 16, 0, 0, 0, 1150, 12, 34, 260, 1],
    ['Derrick Henry', 'RB', 'BAL', 16, 0, 0, 0, 1250, 13, 15, 110, 0],
    ['Josh Jacobs', 'RB', 'GB', 16, 0, 0, 0, 1150, 13, 40, 300, 2],
    ['Bucky Irving', 'RB', 'TB', 16, 0, 0, 0, 1080, 8, 50, 400, 2],
    ['Chase Brown', 'RB', 'CIN', 16, 0, 0, 0, 1000, 9, 54, 420, 2],
    ['Omarion Hampton', 'RB', 'LAC', 16, 0, 0, 0, 1050, 8, 40, 300, 1],
    ['Kyren Williams', 'RB', 'LAR', 16, 0, 0, 0, 1020, 10, 34, 240, 1],
    ['Breece Hall', 'RB', 'NYJ', 16, 0, 0, 0, 900, 7, 48, 380, 2],
    ['James Conner', 'RB', 'ARI', 15, 0, 0, 0, 900, 8, 38, 300, 1],

    ["Ja'Marr Chase", 'WR', 'CIN', 16.5, 0, 0, 0, 40, 0, 112, 1480, 12],
    ['Justin Jefferson', 'WR', 'MIN', 16.5, 0, 0, 0, 20, 0, 100, 1420, 9],
    ['Puka Nacua', 'WR', 'LAR', 15.5, 0, 0, 0, 60, 0, 100, 1300, 7],
    ['Amon-Ra St. Brown', 'WR', 'DET', 16.5, 0, 0, 0, 30, 0, 106, 1250, 10],
    ['CeeDee Lamb', 'WR', 'DAL', 16.5, 0, 0, 0, 30, 0, 98, 1300, 8],
    ['Jaxon Smith-Njigba', 'WR', 'SEA', 16.5, 0, 0, 0, 20, 0, 100, 1350, 8],
    ['Malik Nabers', 'WR', 'NYG', 16, 0, 0, 0, 20, 0, 95, 1200, 7],
    ['Nico Collins', 'WR', 'HOU', 15.5, 0, 0, 0, 10, 0, 82, 1200, 8],
    ['Drake London', 'WR', 'ATL', 16, 0, 0, 0, 10, 0, 90, 1180, 8],
    ['Brian Thomas Jr.', 'WR', 'JAX', 16.5, 0, 0, 0, 30, 0, 84, 1180, 8],
    ['A.J. Brown', 'WR', 'PHI', 15.5, 0, 0, 0, 10, 0, 78, 1150, 8],
    ['George Pickens', 'WR', 'DAL', 16, 0, 0, 0, 20, 0, 82, 1180, 8],
    ['Tee Higgins', 'WR', 'CIN', 15.5, 0, 0, 0, 0, 0, 80, 1120, 10],
    ['Ladd McConkey', 'WR', 'LAC', 16, 0, 0, 0, 20, 0, 88, 1100, 6],
    ['Rashee Rice', 'WR', 'KC', 15, 0, 0, 0, 30, 0, 86, 1000, 7],
    ['Marvin Harrison Jr.', 'WR', 'ARI', 16.5, 0, 0, 0, 10, 0, 76, 1050, 8],
    ['Garrett Wilson', 'WR', 'NYJ', 16, 0, 0, 0, 10, 0, 88, 1050, 6],
    ['Tetairoa McMillan', 'WR', 'CAR', 16, 0, 0, 0, 10, 0, 80, 1050, 6],
    ['Zay Flowers', 'WR', 'BAL', 16, 0, 0, 0, 40, 0, 80, 1050, 6],
    ['Mike Evans', 'WR', 'TB', 15, 0, 0, 0, 0, 0, 68, 1000, 10],

    ['Brock Bowers', 'TE', 'LV', 16.5, 0, 0, 0, 10, 0, 100, 1150, 8],
    ['Trey McBride', 'TE', 'ARI', 16.5, 0, 0, 0, 0, 0, 95, 950, 6],
    ['George Kittle', 'TE', 'SF', 15, 0, 0, 0, 0, 0, 68, 900, 7],
    ['Tucker Kraft', 'TE', 'GB', 16, 0, 0, 0, 0, 0, 66, 820, 7],
    ['Colston Loveland', 'TE', 'CHI', 16, 0, 0, 0, 0, 0, 64, 760, 6],
    ['Tyler Warren', 'TE', 'IND', 16, 0, 0, 0, 10, 0, 66, 740, 5],
    ['Sam LaPorta', 'TE', 'DET', 16, 0, 0, 0, 0, 0, 60, 700, 6],
    ['T.J. Hockenson', 'TE', 'MIN', 16, 0, 0, 0, 0, 0, 66, 720, 4],
  ];

  const SAMPLE_LINES = (() => {
    const out = {};
    for (const r of SAMPLE_LINES_RAW) {
      const [name, pos, tm, g, py, ptd, int, ry, rtd, rec, recy, rectd] = r;
      out[normName(name)] = { name, pos, tm, g, py, ptd, int, ry, rtd, rec, recy, rectd };
    }
    return out;
  })();

  const SAMPLE_WIN_TOTALS = {
    BUF: 11.5, BAL: 11.5, KC: 11, PHI: 11.5, DET: 10.5, SF: 10.5, CIN: 9.5, HOU: 9.5,
    LAR: 9.5, GB: 9.5, WAS: 9, MIN: 8.5, TB: 9.5, DEN: 9.5, LAC: 9, ARI: 8,
    SEA: 8.5, CHI: 8.5, DAL: 8.5, ATL: 8, PIT: 8, NE: 8.5, IND: 8, MIA: 7.5,
    JAX: 7.5, NYJ: 6.5, LV: 6.5, CAR: 6.5, NO: 5.5, NYG: 5.5, CLE: 5.5, TEN: 5.5,
  };

  return {
    SCORING,
    SAMPLE_LINES,
    SAMPLE_WIN_TOTALS,
    projectPoints,
    priceProjections,
    draftedCounts,
    normName,
    parseCsv,
    parseWinTotals,
    extrapolateWeekProps,
    impliedProb,
  };
})();
