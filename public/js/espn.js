/**
 * ESPN live-draft sync.
 *
 * Polls ESPN's fantasy league API through the server proxy (/api/espn):
 *   ?view=mDraftDetail  -> draftDetail.picks (bidAmount, playerId, teamId)
 *   ?view=mTeams        -> team names
 *   /players?view=players_wl -> playerId -> name/position lookup
 *
 * Private leagues require the user's espn_s2 + SWID cookies.
 */
window.EspnSync = (function () {
  const POS_MAP = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DST' };

  function qs(params) {
    return Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
  }

  async function api(path, params) {
    const r = await fetch(`/api/espn/${path}?${qs(params)}`);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  }

  let playersDb = null;
  let playersDbYear = null;

  async function loadPlayersDb(year, auth) {
    if (!playersDb || playersDbYear !== year) {
      playersDb = await api('players', { year, ...auth });
      playersDbYear = year;
    }
    return playersDb;
  }

  async function getLeagueInfo(year, leagueId, auth) {
    const data = await api('league', { year, leagueId, views: 'mTeams,mSettings', ...auth });
    const teams = (data.teams || []).map((t) => ({
      espnId: t.id,
      name: t.name || `${t.location || ''} ${t.nickname || ''}`.trim() || t.abbrev || `Team ${t.id}`,
    }));
    const budget = data.settings?.acquisitionSettings?.acquisitionBudget
      || data.settings?.draftSettings?.auctionBudget || 200;
    const lineup = data.settings?.rosterSettings?.lineupSlotCounts || {};
    let rosterSize = 0;
    for (const c of Object.values(lineup)) rosterSize += Number(c) || 0;
    if (!rosterSize) rosterSize = 16;
    return { year, leagueId, teams, budget, rosterSize, name: data.settings?.name || `League ${leagueId}` };
  }

  /** Returns normalized picks: [{key, playerName, pos, price, espnTeamId}] */
  async function getPicks(year, leagueId, auth) {
    const [data, db] = await Promise.all([
      api('league', { year, leagueId, views: 'mDraftDetail', ...auth }),
      loadPlayersDb(year, auth),
    ]);
    const picks = data.draftDetail?.picks || [];
    return picks
      .filter((p) => p.playerId)
      .map((p) => {
        const dbp = db[p.playerId] || {};
        return {
          key: `es-${p.playerId}`,
          playerName: dbp.n || `ESPN #${p.playerId}`,
          pos: POS_MAP[dbp.pid] || '',
          nflTeam: '',
          price: Number(p.bidAmount || 1),
          espnTeamId: p.teamId,
        };
      });
  }

  return { getLeagueInfo, getPicks };
})();
