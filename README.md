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
| **Vegas edge — Strategy by Faraz** | Rank divergence between the sportsbooks and the fantasy analysts: buy where Vegas ranks a player well above the analyst consensus, fade the reverse |
| **League winners & overspend ceiling** | Who's worth breaking your budget for, how far over market you're justified going, and the hard limit past which your starting lineup can't be filled |
| **Anchored value** | Worth comes from analysts + Vegas only and never moves with league bidding; cost moves with the room. The Value tab ranks the board in blocks of 12 by the gap between them |
| **Value bank** | Every under-market buy banks surplus, which becomes your licence to outbid in a war and still be level on value |
| **Key handcuffs** | Ranked league-wide by the workload waiting in front of them, since injuries happen on every roster — confirmed against analyst ranks and Vegas props |
| **Buying power & war chest** | Tracks when the room goes broke and protects the money to take advantage |

## Anchored value, the value bank, and the value board

**A player's worth is anchored in the analyst board and the Vegas books — and in nothing else.**
What the room is bidding changes what he *costs*, never what he's *worth*. The app keeps those two
numbers strictly apart:

| | |
| --- | --- |
| **Worth** | `anchorValue` — the analyst board blended with the Vegas books (50/50 by default, adjustable on the Vegas tab). Rock steady; league bidding cannot move it |
| **Cost** | the analyst consensus moved by room inflation — what he'll actually sell for |
| **Edge** | worth − cost. The whole game |

Watch it work: rivals spend $1,260 and Bijan's **worth stays $74** while his **cost falls $59 → $33**,
so his edge grows from +15 to +41. The player didn't change; the market did.

### The value board — blocks of 12

The **Value** tab ranks every remaining player by anchored worth, then cuts the board into blocks
the size of your league — one nomination cycle each. Inside a block the only question is who's
underpriced, so rows are sorted by edge and the top three are starred. Each block header shows how
much total value is sitting in it, which tells you how hard to compete for this stretch of the
board.

### The value bank — your bidding-war ammunition

Every purchase banks the difference between a player's worth and what you paid. Buy Tee Higgins
(worth $31) for $5 and you've banked **+$26**. The header carries a running **Value Banked** figure,
and the bid dialog turns it into a concrete licence:

> 🏦 Banked **$26** of value so far — worth $74 plus that surplus means you can go to **$100** in a
> bidding war and still be level on value across the draft.

That's the honest ceiling: paying `worth + bank` leaves your cumulative surplus at exactly zero. It
never exceeds the lineup-safe hard ceiling.

### Key handcuffs — league-wide

Injuries happen on every roster, so a backup's value comes from **the job waiting in front of him**,
not from whose team the starter is on. The handcuff board ranks every backup in the pool by the
workload he'd inherit, weighted by position (a lost bell-cow back hands over the entire job; a
receiver doesn't), divided by what he costs — then checks the analysts and books actually support
him. A `?` marks a name with no projection behind it: speculation, not insurance. 🔗 marks one who
happens to back up a player you own, which is a bonus rather than the point.

## Buying power & the bench war chest

Nominations come up at random, so you can't schedule your spending. If you convert every dollar
into starters early, you arrive at the back half of the draft at $1 a slot — and every opponent
with cash left outbids you on reflex. Meanwhile the *reverse* is the biggest edge in the room: when
everyone else has overspent, a $20 player sells for $10 and only the team that kept money can take
him.

So the bench reserve is **not a depth budget — it's a war chest**, and the app models it as one.

### Prices are set by rivals, not by your sheet

An auction price is set by the best-funded bidder who wants the player, so nobody can cost more
than the richest rival's max bid plus a dollar. The **Buying power** panel reports:

- **Your max bid** and **room rank** — where your spending power sits in the field
- **Top rival** — the highest bid anyone else can currently make
- **War chest** — what's held back for your remaining bench spots

Underneath it names the market state directly:

> 🟢 **Buyer's market.** 30 of the best players left are worth more than the richest rival can even
> bid ($1) — including De'Von Achane at $7. They're yours for about $2. This is the window you held
> money for.

…versus 🔴 **Full price** when rivals can still cover the whole board. The coach bar fires the same
alert the moment the window opens, and the opposite one when 70%+ of the room can outbid you.

### What makes a bench player worth paying for

In a streaming league generic depth is free — you can get that off waivers. What waivers *cannot*
hand you is the handcuff to your own stud or a breakout before he breaks out. So the bench score
weights four factors, tilted by your **waiver setting** (⚙︎ → Waiver wire):

| Factor | Why |
| --- | --- |
| **Handcuff** 🔗 | Backs up a player you already own. Lose your bell-cow and you inherit the entire workload — weighted highest for RBs, where the workload transfer is near-total |
| **Upside vs. cost** | Production per dollar at what he'll *actually clear for*, not sheet value |
| **Bye coverage** | Penalised if he shares a bye with your starter at that position, rewarded if he covers it |
| **Scarcity insurance** | Depth where the pool is drying up — dialled down in streaming leagues, up in locked ones |

Bye weeks come from ESPN's public pro-team schedule (no auth, so Sleeper drafters get them too).
They're pulled automatically when you connect a draft, or on demand via ⚙︎ → **Fetch bye weeks**.

## League winners & the overspend ceiling

**Points scored on your bench are worth zero.** Every dollar should buy production that actually
appears in your lineup, so the Winners tab measures players against a **typical starter** at their
position — not against a bench body — and then discounts for the two things that keep production
out of your lineup:

- **Availability** — the share of the season the books expect him to play.
- **Consistency** — read straight out of the prop composition. Yards and receptions recur every
  week; touchdowns are lumpy binary events. A back whose value is mostly goal-line scores has a far
  shakier floor than one with the same projection built on volume. The `Steady` column is the share
  of his projected points that come from volume rather than scores.

A player both the books and the analysts rank elite, who plays every week and scores steadily, is
the one worth breaking your budget for. (Divergence plays from the Faraz board are cheap upside;
these are cornerstones — different jobs.)

### The three numbers on every bid

Click any player and the draft dialog shows:

| | Meaning |
| --- | --- |
| **Market** | What he'd normally go for, inflation-adjusted |
| **Pay up to** | The most you're *justified* paying. Market plus a premium that scales with how much of a league winner he is — small for ordinary starters, up to about +38% for genuine cornerstones — and never past the point where the rest of your lineup drops below market |
| **Hard ceiling** | Cross this and you **cannot** fill your remaining starting slots with startable players. Not a guideline |

As you type a price the dialog tells you exactly what that bid leaves behind — *"At $86: $114 left
for 9 more starting slots (≈$12 each) plus 6 bench"* — then turns amber past the justified stretch
and red past the hard ceiling. If a player's market price is already above your ceiling he's marked
**out of reach** rather than given a bid number.

### How the ceiling is computed

At any moment the app knows which starting slots you still have open and what a startable player at
each of those slots currently costs, given how many teams are still competing for one. Slots share
players — every open FLEX also chases the RB/WR/TE pool — so demand for a position counts its own
openings plus its share of the flexes. Your ceiling is your budget minus that reserve, minus $1 per
bench spot. It tightens automatically every time a pick lands.

The **Starters Left** stat in the header shows how many starting slots you still need (hover for
the total reserve), and **My Team** reports your projected **starting** points — bench excluded.
The par sheet includes a **Starters First** build that puts every bench slot at $1 and the whole
budget into the ten slots that play.

## Strategy by Faraz — Vegas vs. analyst rank divergence

The edge this app hunts for is **disagreement between the betting market and the fantasy
industry**, credited to and named for Faraz:

> Buy the players whose season over/unders at the top books imply a **high** finish but whom the
> fantasy analysts rank **low** — the draft room prices the analyst rank, so you get the books'
> projected production at a discount. Fade the mirror image: analyst darlings the books won't back,
> who will cost a premium for production Vegas doesn't project.

The Vegas tab is that board. For every player with lines it computes two rankings **within his own
position**, over the same covered set of players:

- **A#** — the analyst rank. Either an expert top-150 / ADP list you paste in, or (by default) the
  ranking implied by the values on your own board.
- **V#** — the Vegas rank, from the season fantasy points implied by his over/unders for yards,
  TDs, receptions and the rest, under your scoring settings.

**Gap = A# − V#.** Positive means Vegas is higher than the analysts → **BUY**. Negative means
analyst darling the books doubt → **FADE**. Thresholds scale with the size of the position pool,
since moving three spots means everything in a 6-player list and nothing in a 60-player one. A
`≠` marks players your selected books disagree sharply on — lower confidence.

The same signal drives ▲/▼ badges on the player board, a "Faraz buys" group in the nomination
helper (players you still need), a "Faraz fades" group (nominate them, let the room overpay), and
a coach-bar callout for the strongest divergence at a position you need.

### Choosing your books

The strategy rests on trusting a specific handful of books rather than the whole field, so lines
are stored **per book** and the Vegas tab has a book picker — the top 3 by default (DraftKings,
FanDuel, BetMGM when available), toggleable to any set. The consensus line is the median across
just the books you've selected, and switching books recomputes instantly without re-fetching.

### Analyst rankings

The "Analyst ranks" tab in the Vegas dialog takes an expert top-150 or ADP list. It accepts a plain
ordered list of names (line order = rank), `12. Bijan Robinson`, or `Bijan Robinson, 12`. Without
an import it falls back to your own board's ranking, which is itself an analyst cheat sheet.

## Vegas lines

The Vegas tab turns sportsbook player props into auction dollars and compares them to your own
values. A **+$9 edge means the books' implied usage is worth $9 more than you have him priced** —
that's the buy signal. Negative edge is the fade.

**⚠️ The bundled lines are SAMPLE data, not real sportsbook numbers.** They exist so the feature
is explorable out of the box. The app will not show Vegas edges on the player board until you
either load real lines or explicitly click "Show sample edges anyway". Two ways to load real ones:

- **Fetch live** — paste a free [the-odds-api.com](https://the-odds-api.com) key. The server pulls
  player props (pass/rush/receiving yards, receptions, anytime TD) across the next NFL slate,
  keeping every book's line separately so you can pick which three to trust. It de-vigs the
  anytime-TD price into a TD expectation and extrapolates to a season using your expected-games
  number. Each game sampled costs API credits.
- **Import / paste** — a CSV or TSV of season-long props with a header row. Recognized columns:
  `player, pos, team, games, pass_yds, pass_td, int, rush_yds, rush_td, rec, rec_yds, rec_td` —
  or just `player, fpts` if you already have projections. Optional team win totals paste in as
  `BUF 11.5`, one per line.

How the dollars are computed: projections → value over replacement at each position → dollars.
Because prop coverage is almost always partial (books post props for ~50 players; a 12-team league
drafts ~190), the model **calibrates against your own board** rather than the league's full budget —
it redistributes the dollars you already assign to the covered players. That keeps edges honest at
any coverage level. Replacement level for a position deeper than your coverage is estimated by
fitting the observed rank-vs-points decay.

Two controls worth knowing:

- **Compare** defaults to *within position* — "among tight ends, do the books like him more than you
  do". Choosing RB over WR is your tiers' job, not the books'. *Across all positions* is available
  but only trustworthy when every position has deep coverage.
- **Blend** (default 0%) mixes Vegas dollars into the values the app prices with. At 0% Vegas is
  pure signal and your numbers drive everything; 25–40% lets the books nudge your sheet.

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
