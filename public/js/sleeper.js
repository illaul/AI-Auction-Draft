/**
 * Sleeper live-draft sync.
 *
 * Uses Sleeper's public read-only API (proxied through /api/sleeper):
 *   /draft/{id}          -> settings (budget, teams, roster slots), draft_order
 *   /draft/{id}/picks    -> completed auction purchases (metadata.amount)
 *   /league/{id}/users   -> team display names (when the draft belongs to a league)
 *   /players/nfl         -> player id -> name/pos lookup
 */
window.SleeperSync = (function () {
  const api = (path) => fetch(`/api/sleeper/${path}`).then((r) => {
    if (!r.ok) return r.json().then((b) => { throw new Error(b.error || `HTTP ${r.status}`); });
    return r.json();
  });

  let playersDb = null;

  async function loadPlayersDb() {
    if (!playersDb) playersDb = await api('players/nfl');
    return playersDb;
  }

  async function findDrafts(username, season) {
    const user = await api(`user/${encodeURIComponent(username)}`);
    if (!user || !user.user_id) throw new Error('Sleeper user not found');
    const drafts = await api(`user/${user.user_id}/drafts/nfl/${season}`);
    return (drafts || []).map((d) => ({
      id: d.draft_id,
      label: `${d.metadata?.name || d.type} — ${d.type}${d.settings?.budget ? ` ($${d.settings.budget})` : ''} — ${d.status}`,
      isAuction: d.type === 'auction',
    }));
  }

  async function getDraftInfo(draftId) {
    const d = await api(`draft/${draftId}`);
    if (!d || !d.draft_id) throw new Error('Draft not found');
    const teams = d.settings?.teams || 12;
    const budget = d.settings?.budget || 200;
    const s = d.settings || {};
    const rosterSize =
      (s.slots_qb || 0) + (s.slots_rb || 0) + (s.slots_wr || 0) + (s.slots_te || 0) +
      (s.slots_flex || 0) + (s.slots_super_flex || 0) + (s.slots_k || 0) +
      (s.slots_def || 0) + (s.slots_bn || 0) || 16;

    // slot -> display name. draft_order maps user_id -> slot.
    const slotNames = {};
    for (let i = 1; i <= teams; i++) slotNames[i] = `Team ${i}`;
    const order = d.draft_order || {};
    let users = [];
    if (d.league_id) {
      try { users = await api(`league/${d.league_id}/users`); } catch (_) { /* mock drafts have no league */ }
    }
    const userName = {};
    for (const u of users) userName[u.user_id] = u.metadata?.team_name || u.display_name;
    for (const [uid, slot] of Object.entries(order)) {
      slotNames[slot] = userName[uid] || `Team ${slot}`;
    }
    return { draftId, teams, budget, rosterSize, slotNames, order, status: d.status, type: d.type };
  }

  /** Returns normalized picks: [{key, playerName, pos, team, price, slot}] */
  async function getPicks(draftId, draftInfo) {
    const [picks, db] = await Promise.all([api(`draft/${draftId}/picks`), loadPlayersDb()]);
    return (picks || []).map((p) => {
      const meta = p.metadata || {};
      const dbp = db[p.player_id] || {};
      const name = dbp.n || `${meta.first_name || ''} ${meta.last_name || ''}`.trim() || `#${p.player_id}`;
      const pos = (dbp.p || meta.position || '').replace('DEF', 'DST');
      const slot = p.draft_slot || (draftInfo.order ? draftInfo.order[p.picked_by] : null);
      return {
        key: `sl-${p.player_id}`,
        playerName: name,
        pos,
        nflTeam: dbp.t || meta.team || '',
        price: Number(meta.amount || 1),
        slot: slot || 1,
      };
    });
  }

  return { findDrafts, getDraftInfo, getPicks };
})();
