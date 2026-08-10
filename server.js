/**
 * AI Auction Draft — server
 *
 * Serves the static front-end and proxies the Sleeper / ESPN fantasy APIs
 * (ESPN's API does not allow cross-origin browser requests, and proxying
 * Sleeper too keeps every network call same-origin).
 */
const express = require('express');
const path = require('path');
const fs = require('fs');

// Minimal .env loader — enough for KEY=value lines, without a dependency.
// Real environment variables always win, so `ODDS_API_KEY=… npm start` overrides
// the file. Never commit .env; see .env.example.
(function loadDotEnv() {
  try {
    const file = path.join(__dirname, '.env');
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m || line.trim().startsWith('#')) continue;
      const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
      if (process.env[m[1]] === undefined && value) process.env[m[1]] = value;
    }
  } catch (_) { /* unreadable .env just means no file-based config */ }
})();

// Respect HTTPS_PROXY/HTTP_PROXY for outbound fetches when running behind a
// corporate/egress proxy (Node's fetch ignores these env vars by default).
try {
  if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY) {
    const { setGlobalDispatcher, EnvHttpProxyAgent } = require('undici');
    setGlobalDispatcher(new EnvHttpProxyAgent());
  }
} catch (_) { /* undici not available — direct connections only */ }

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Sleeper proxy — read-only, no auth required.
// GET /api/sleeper/<anything>  ->  https://api.sleeper.app/v1/<anything>
// ---------------------------------------------------------------------------
const SLEEPER_BASE = 'https://api.sleeper.app/v1';
const SLEEPER_ALLOWED = /^(user|users|league|draft|drafts|players)\//;

let sleeperPlayersCache = null; // the /players/nfl payload is ~5MB; cache it
let sleeperPlayersCacheTime = 0;

app.get('/api/sleeper/*', async (req, res) => {
  const sub = req.params[0];
  if (!SLEEPER_ALLOWED.test(sub + '/')) {
    return res.status(400).json({ error: 'Unsupported Sleeper path' });
  }
  try {
    if (sub === 'players/nfl') {
      const DAY = 24 * 60 * 60 * 1000;
      if (!sleeperPlayersCache || Date.now() - sleeperPlayersCacheTime > DAY) {
        const r = await fetch(`${SLEEPER_BASE}/players/nfl`);
        if (!r.ok) throw new Error(`Sleeper ${r.status}`);
        sleeperPlayersCache = await r.json();
        sleeperPlayersCacheTime = Date.now();
      }
      // Slim the payload down to what the client needs.
      const slim = {};
      for (const [id, p] of Object.entries(sleeperPlayersCache)) {
        if (!p || !p.position) continue;
        slim[id] = {
          n: p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim(),
          p: p.position,
          t: p.team || 'FA',
        };
      }
      return res.json(slim);
    }
    const r = await fetch(`${SLEEPER_BASE}/${sub}`);
    if (!r.ok) return res.status(r.status).json({ error: `Sleeper responded ${r.status}` });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------------
// ESPN proxy.
// GET /api/espn/league?year=&leagueId=&views=mDraftDetail,mTeams&s2=&swid=
// GET /api/espn/players?year=&s2=&swid=
// Private leagues require the user's espn_s2 + SWID cookies (see README).
// ---------------------------------------------------------------------------
const ESPN_BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';

function espnHeaders(query) {
  const h = {
    Accept: 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  };
  const { s2, swid } = query;
  if (s2 && swid) {
    const swidFmt = swid.startsWith('{') ? swid : `{${swid}}`;
    h.Cookie = `espn_s2=${s2}; SWID=${swidFmt}`;
  }
  return h;
}

app.get('/api/espn/league', async (req, res) => {
  const { year, leagueId } = req.query;
  if (!/^\d{4}$/.test(year || '') || !/^\d+$/.test(leagueId || '')) {
    return res.status(400).json({ error: 'year and leagueId are required' });
  }
  const views = (req.query.views || 'mDraftDetail,mTeams,mSettings')
    .split(',')
    .filter((v) => /^[a-zA-Z_]+$/.test(v))
    .map((v) => `view=${v}`)
    .join('&');
  try {
    const url = `${ESPN_BASE}/seasons/${year}/segments/0/leagues/${leagueId}?${views}`;
    const r = await fetch(url, { headers: espnHeaders(req.query) });
    if (!r.ok) {
      return res.status(r.status).json({
        error:
          r.status === 401 || r.status === 403
            ? 'ESPN denied access — for private leagues supply espn_s2 and SWID cookies'
            : `ESPN responded ${r.status}`,
      });
    }
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

const espnPlayersCache = new Map(); // year -> { time, data }

app.get('/api/espn/players', async (req, res) => {
  const { year } = req.query;
  if (!/^\d{4}$/.test(year || '')) return res.status(400).json({ error: 'year is required' });
  const DAY = 24 * 60 * 60 * 1000;
  const cached = espnPlayersCache.get(year);
  if (cached && Date.now() - cached.time < DAY) return res.json(cached.data);
  try {
    const url = `${ESPN_BASE}/seasons/${year}/players?scoringPeriodId=0&view=players_wl`;
    const r = await fetch(url, {
      headers: {
        ...espnHeaders(req.query),
        'X-Fantasy-Filter': JSON.stringify({ filterActive: { value: true } }),
      },
    });
    if (!r.ok) return res.status(r.status).json({ error: `ESPN responded ${r.status}` });
    const raw = await r.json();
    // Slim: id -> { name, positionId, proTeamId }
    const slim = {};
    for (const p of raw) {
      slim[p.id] = { n: p.fullName, pid: p.defaultPositionId };
    }
    espnPlayersCache.set(year, { time: Date.now(), data: slim });
    res.json(slim);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------------
// The Odds API proxy — live sportsbook player props.
//
// The Odds API serves per-game markets, not season-long totals, so we pull the
// earliest slate of NFL games and return per-game consensus lines. The client
// extrapolates those across an expected-games count to get a season view.
// Requires the user's own API key (free tier at the-odds-api.com).
// ---------------------------------------------------------------------------
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const PROP_MARKETS = [
  'player_pass_yds', 'player_pass_tds', 'player_rush_yds',
  'player_reception_yds', 'player_receptions', 'player_anytime_td',
];
const MARKET_FIELD = {
  player_pass_yds: 'py', player_pass_tds: 'ptd', player_rush_yds: 'ry',
  player_reception_yds: 'recy', player_receptions: 'rec',
};

/** Node's fetch reports every connectivity problem as a bare "fetch failed". */
function netError(err) {
  const msg = String(err && err.message || err);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT/i.test(msg)) {
    return 'Could not reach the Odds API — check this machine\'s internet connection.';
  }
  return msg;
}

// ---------------------------------------------------------------------------
// NFL bye weeks. ESPN publishes pro-team schedules without auth, so this works
// for Sleeper drafters too.
// GET /api/byes?year=2026  ->  { "BUF": 12, "KC": 6, ... }
// ---------------------------------------------------------------------------
const byeCache = new Map();

app.get('/api/byes', async (req, res) => {
  const { year } = req.query;
  if (!/^\d{4}$/.test(year || '')) return res.status(400).json({ error: 'year is required' });
  const DAY = 24 * 60 * 60 * 1000;
  const hit = byeCache.get(year);
  if (hit && Date.now() - hit.time < DAY) return res.json(hit.data);
  try {
    const url = `${ESPN_BASE}/seasons/${year}?view=proTeamSchedules_wl`;
    const r = await fetch(url, { headers: espnHeaders({}) });
    if (!r.ok) return res.status(r.status).json({ error: `ESPN responded ${r.status}` });
    const data = await r.json();
    const teams = data?.settings?.proTeams || [];
    const byes = {};
    for (const t of teams) {
      if (t.abbrev && t.byeWeek) byes[String(t.abbrev).toUpperCase()] = t.byeWeek;
    }
    if (!Object.keys(byes).length) {
      return res.status(502).json({ error: 'ESPN returned no bye weeks for that season yet' });
    }
    byeCache.set(year, { time: Date.now(), data: byes });
    res.json(byes);
  } catch (err) {
    res.status(502).json({ error: netError(err) });
  }
});

// ---------------------------------------------------------------------------
// Fantasy-playoff-week opponents (weeks 15/16/17). Best-effort: reads the
// per-team weekly schedule off the same public ESPN payload the bye endpoint
// uses. ESPN doesn't document this shape, so this degrades to a clear error
// rather than silently returning wrong data if the field isn't there.
// GET /api/playoff-schedule?year=2026  ->  { "BUF": {"15":"KC","16":"NYJ","17":"MIA"}, ... }
// ---------------------------------------------------------------------------
const PLAYOFF_WEEKS = [15, 16, 17];
const scheduleCache = new Map();

app.get('/api/playoff-schedule', async (req, res) => {
  const { year } = req.query;
  if (!/^\d{4}$/.test(year || '')) return res.status(400).json({ error: 'year is required' });
  const DAY = 24 * 60 * 60 * 1000;
  const hit = scheduleCache.get(year);
  if (hit && Date.now() - hit.time < DAY) return res.json(hit.data);
  try {
    const url = `${ESPN_BASE}/seasons/${year}?view=proTeamSchedules_wl`;
    const r = await fetch(url, { headers: espnHeaders({}) });
    if (!r.ok) return res.status(r.status).json({ error: `ESPN responded ${r.status}` });
    const data = await r.json();
    const teams = data?.settings?.proTeams || [];
    const byId = {};
    for (const t of teams) if (t.id && t.abbrev) byId[t.id] = String(t.abbrev).toUpperCase();

    const schedule = {};
    for (const t of teams) {
      if (!t.abbrev || !t.proGamesByScoringPeriod) continue;
      const weeks = {};
      for (const wk of PLAYOFF_WEEKS) {
        const games = t.proGamesByScoringPeriod[String(wk)];
        const g = Array.isArray(games) ? games[0] : null;
        if (!g) continue;
        const oppId = g.awayProTeamId === t.id ? g.homeProTeamId : g.awayProTeamId;
        if (byId[oppId]) weeks[wk] = byId[oppId];
      }
      if (Object.keys(weeks).length) schedule[String(t.abbrev).toUpperCase()] = weeks;
    }

    if (!Object.keys(schedule).length) {
      return res.status(502).json({ error: 'ESPN did not return a weekly schedule for that season yet' });
    }
    scheduleCache.set(year, { time: Date.now(), data: schedule });
    res.json(schedule);
  } catch (err) {
    res.status(502).json({ error: netError(err) });
  }
});

/**
 * Where the Odds API key comes from.
 *
 * Preferring the server's environment keeps the key out of the browser and out
 * of request URLs entirely — set ODDS_API_KEY (a .env line or an exported shell
 * var) and the client never has to hold it. A key typed into the UI still works
 * as a fallback for a one-off.
 */
const serverOddsKey = () => (process.env.ODDS_API_KEY || '').trim();
const resolveOddsKey = (req) => serverOddsKey() || (req.query.key || '').trim();

// Lets the UI say "the server already has a key" instead of demanding one.
app.get('/api/odds/config', (_req, res) => {
  res.json({ serverKey: !!serverOddsKey() });
});

app.get('/api/odds/status', async (req, res) => {
  const key = resolveOddsKey(req);
  if (!key) return res.status(400).json({ error: 'An Odds API key is required' });
  try {
    const r = await fetch(`${ODDS_BASE}/sports/?apiKey=${encodeURIComponent(key)}`);
    if (!r.ok) {
      return res.status(r.status).json({
        error: r.status === 401 ? 'Odds API rejected that key' : `Odds API responded ${r.status}`,
      });
    }
    res.json({
      ok: true,
      creditsRemaining: r.headers.get('x-requests-remaining'),
      creditsUsed: r.headers.get('x-requests-used'),
    });
  } catch (err) {
    res.status(502).json({ error: netError(err) });
  }
});

app.get('/api/odds/props', async (req, res) => {
  const key = resolveOddsKey(req);
  if (!key) return res.status(400).json({ error: 'An Odds API key is required' });
  const maxEvents = Math.min(20, Math.max(1, Number(req.query.maxEvents) || 16));
  try {
    const evRes = await fetch(
      `${ODDS_BASE}/sports/americanfootball_nfl/events?apiKey=${encodeURIComponent(key)}`);
    if (!evRes.ok) {
      return res.status(evRes.status).json({
        error: evRes.status === 401 ? 'Odds API rejected that key' : `Odds API responded ${evRes.status}`,
      });
    }
    const events = await evRes.json();
    if (!Array.isArray(events) || !events.length) {
      return res.json({ players: {}, meta: { events: 0, note: 'No upcoming NFL events are posted yet.' } });
    }
    // Earliest slate first — that's the closest thing to a "next week" board.
    events.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
    const slate = events.slice(0, maxEvents);

    // Lines are kept PER BOOK, not pre-averaged: the Faraz strategy picks a
    // specific set of books to trust, and disagreement between them is itself
    // a confidence signal.
    // name -> market -> { bookKey: line }
    const acc = {};
    const bookTitles = {};
    const bookCounts = {};
    const bump = (name, field, book, value) => {
      const p = (acc[name] = acc[name] || {});
      const m = (p[field] = p[field] || {});
      m[book] = value;
    };

    let creditsRemaining = null;
    let fetched = 0;
    for (const ev of slate) {
      const url = `${ODDS_BASE}/sports/americanfootball_nfl/events/${ev.id}/odds`
        + `?apiKey=${encodeURIComponent(key)}&regions=us&oddsFormat=american`
        + `&markets=${PROP_MARKETS.join(',')}`;
      const r = await fetch(url);
      creditsRemaining = r.headers.get('x-requests-remaining') ?? creditsRemaining;
      if (!r.ok) continue; // a game with no posted props just contributes nothing
      fetched += 1;
      const data = await r.json();
      for (const bk of data.bookmakers || []) {
        bookTitles[bk.key] = bk.title || bk.key;
        for (const mk of bk.markets || []) {
          for (const oc of mk.outcomes || []) {
            const who = oc.description;
            if (!who) continue;
            if (mk.key === 'player_anytime_td') {
              if (String(oc.name).toLowerCase() !== 'yes') continue;
              // Anytime-TD price -> implied probability, de-vigged roughly.
              const a = Number(oc.price);
              const prob = (a > 0 ? 100 / (a + 100) : -a / (-a + 100)) * 0.93;
              bump(who, 'td', bk.key, prob);
              bookCounts[bk.key] = (bookCounts[bk.key] || 0) + 1;
            } else if (MARKET_FIELD[mk.key]) {
              if (String(oc.name).toLowerCase() !== 'over') continue;
              bump(who, MARKET_FIELD[mk.key], bk.key, Number(oc.point));
              bookCounts[bk.key] = (bookCounts[bk.key] || 0) + 1;
            }
          }
        }
      }
    }

    const players = {};
    for (const [name, markets] of Object.entries(acc)) {
      players[name] = { name, markets };
    }
    const books = Object.keys(bookCounts)
      .map((k) => ({ key: k, title: bookTitles[k] || k, lines: bookCounts[k] }))
      .sort((a, b) => b.lines - a.lines);

    res.json({
      players,
      books,
      meta: {
        events: fetched,
        requested: slate.length,
        books: books.length,
        commenceTime: slate[0]?.commence_time || null,
        creditsRemaining,
      },
    });
  } catch (err) {
    res.status(502).json({ error: netError(err) });
  }
});

app.listen(PORT, () => {
  console.log(`AI Auction Draft running at http://localhost:${PORT}`);
});
