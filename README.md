# 🏈 AI Auction Draft — Auction War Room

A fantasy football **auction / salary-cap draft assistant** built on the strategy playbook from
the Fantasy Points auction draft plan podcast (Joe Dolan & Drew Davenport). It runs alongside
your draft — manual, **Sleeper**, or **ESPN** — and turns the podcast's strategy into live,
in-draft tooling.

## What it does

| Podcast concept | In the app |
| --- | --- |
| **Tiers, not rankings** — attack tiers while they have depth | Player board grouped by position + tier, with "X left in tier" counts and **"last one in tier"** bidding-war warnings |
| **The par sheet** — shoot exactly $200, don't drift | Par Sheet tab with preset builds (Hero RB, Zero RB, Robust RB, WR Robust, **Brock Bowers Build**, **Josh Allen Build**, Balanced), editable per-slot targets, live par +/− as you buy |
| **Nomination strategy** — few things you control; use them | Nomination Helper: sitting-down-bonus deals early, tier-protection noms, **money drains** (last-in-tier at positions you've filled), **aim at the hammer**, and endgame **punt noms** (K/D:ST) |
| **The hammer** — track who has the most money and what they need | League tab shows every team's remaining budget, **max bid**, roster spots, and positional needs; the hammer is flagged 🔨 |
| **Two currencies** — dollars *and* roster spots | Max bid everywhere = money − (open spots − 1); the app blocks illegal bids and warns at the endgame |
| **Room inflation** | Live inflation multiplier (remaining money ÷ remaining sheet value) and inflation-adjusted prices next to your sheet values |
| **Coach bar** | Context-aware strategy tips (sitting-down bonus, mid-draft aggression, 1-QB value guarantee, max-bid rule, don't price-enforce…) that change as the draft progresses |

Player values/tiers ship with an editable default cheat sheet (12-team, $200, 16 spots).
Click any player → **Edit Value/Tier** to make it your own; ⭐ mark targets. Everything persists
in your browser (localStorage).

## Run it

```bash
npm install
npm start
# open http://localhost:3000
```

Requires Node 18+.

## Connecting a live draft

### Sleeper
1. Click **Connect Draft → Sleeper**.
2. Paste the draft ID from the draft URL (`sleeper.com/draft/nfl/<draft id>`), or enter your
   Sleeper username + season and pick from your drafts (💰 = auction).
3. Connect, then choose which team is **yours** in the settings dialog that opens.

Sleeper's API is public and read-only — no login needed. Works for league drafts and mocks.
Picks sync every ~5 seconds; budgets, the hammer, inflation, and tier alerts update automatically.

### ESPN
1. Click **Connect Draft → ESPN** and enter your league ID (from the league URL) and season.
2. **Public leagues** work as-is. **Private leagues** need two cookies from a browser where
   you're logged in to fantasy.espn.com:
   - Open dev tools → Application/Storage → Cookies → `https://fantasy.espn.com`
   - Copy `espn_s2` (long string) and `SWID` (looks like `{XXXX-...-XXXX}`) into the form.
3. Connect, then pick your team.

ESPN doesn't expose a public real-time draft socket, so the app polls the league API
(`mDraftDetail`) every ~5 seconds — completed auction purchases (player, price, team) stream in
as ESPN records them. Cookies are only ever sent from your machine to your own server process,
which forwards them to ESPN.

### Manual mode
For in-person drafts with a live auctioneer: click a player on the board (or in the Nomination
Helper), enter the winning team + price, hit **Sold!**. Undo supported.

## Notes

- The default player pool/values are a starting point for a 2026-season, 12-team, $200 league —
  edit values and tiers to match your own rankings before draft day.
- Players sold on Sleeper/ESPN that aren't in the local pool are added automatically so budgets
  stay accurate.
- Reset a draft (keeping your values/targets) via ⚙︎ → **Reset Draft**.
