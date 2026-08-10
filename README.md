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
| **Buying power & war chest** | Prices are set by the richest rival, not your sheet — tracks when the room goes broke and the board becomes yours at a discount, and protects the money to take it |
| **Value board & value bank** | Worth is anchored in the analyst board + Vegas books, never in what the room is bidding — a Value tab ranks everyone left by that worth in blocks of one nomination cycle, and Value banked tracks the surplus you've earned buying under worth, your license to outbid in a war |
| **Draft Plan** | A live, full-roster answer to "what's my best team from here" — every slot, drafted or targeted, re-solved after every pick in the room, with a tier survival forecast, positional-run and archetype reads, and a caution list feeding your decoy nominations |

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
hand you is a handcuff to a real starter or a breakout before he breaks out. So the bench score
weights four factors, tilted by your **waiver setting** (⚙︎ → Waiver wire):

| Factor | Why |
| --- | --- |
| **Handcuff** 🔗 | Backs up a real starter **anywhere in the league**, not just on your own roster — injuries don't check who owns whom. Only counts once the backup clears a worth floor of his own, confirmed against the analyst board and Vegas books, so "next on the depth chart" alone doesn't qualify. Weighted highest for RBs, where the workload transfer is near-total |
| **Upside vs. cost** | Production per dollar at what he'll *actually clear for*, not sheet value |
| **Bye coverage** | Penalised if he shares a bye with your starter at that position, rewarded if he covers it |
| **Scarcity insurance** | Depth where the pool is drying up — dialled down in streaming leagues, up in locked ones |

Bye weeks come from ESPN's public pro-team schedule (no auth, so Sleeper drafters get them too).
They're pulled automatically when you connect a draft, or on demand via ⚙︎ → **Fetch bye weeks**.

## Value board & the value bank

**A player's worth comes from the analyst board and the Vegas books — never from what the room is
bidding.** Bidding decides what you pay; the analysts and the books decide what he's worth, and the
gap between the two is the entire game. That worth (`anchorValue`, an even blend of your board and
Vegas dollars once Vegas data is active) now drives every "$" figure shown against a player, while
his inflation-adjusted **market** price — a separate figure — is what the room will actually make
him cost.

The **Value** tab lists everyone left, ranked purely by worth, in blocks the size of your league —
one full trip through the nomination order — so you can see who survives each cycle without the
room's own bidding warping the ranking. Each row shows worth, market, the edge between them, and
the Faraz buy/fade badge where Vegas lines are loaded.

**Value banked**, on the My Team tab, sums worth-minus-price across everything you've drafted so
far. A positive bank is money you've effectively made by buying under value — spend it as
justification to go over the odds the next time you're in a real bidding war for a player you want.

## Draft Plan

**What's the best full team achievable from right now, and how does that change as the room drafts
around you?** The **Plan** tab answers that live: every one of your 9 starting slots (QB / 2 RB /
2 WR / TE / FLEX / K / DST) gets a target — drafted or recommended — solved fresh after *every* pick
in the room, not just yours. K/DST are deliberate $1 endgame picks, never part of the points chase.

- **Objective is points, not dollars.** Slots are filled to maximize total points above a starter
  (the same metric behind the Winners tab), priced at what a player will actually cost — not what
  he's "worth" — inside your remaining budget.
- **Best value available, wherever it fits.** There's no rigid QB-then-RB-then-WR fill order. A
  third RB better than anything else on the board takes FLEX or bench instead of being passed over
  for a premature kicker buy.
- **Re-solved from scratch, not patched.** Grab a tier-1 player off-plan because he fell into your
  range, and the plan doesn't need a special rule to "adjust" — a fresh solve from your new budget
  and slots naturally finds the best remaining answer, even if that means a cheaper target at some
  other slot later.
- **Sticky.** A slot keeps its current target unless the fresh solve finds someone a full tier
  better, so the plan doesn't visibly reshuffle just because an unrelated team made a pick.
- **Tier % — a forecast, never a bet on a name.** Nomination order in a real auction is random, so
  the plan won't claim "you'll get Player X in two picks." Instead it estimates, from the position's
  own pace so far, how likely his *tier* still has survivors by your next 2–3 turns through the room.
- **Bench** reuses the existing handcuff/upside/bye/scarcity scoring rather than the points
  objective, since bench production scores you zero.

### Reserve money for a target before you need it

Star (⭐) a player from Edit Value/Tier and, if the Plan has him as a slot's target, his expected
market price becomes that slot's protected reserve — the same floor math that already guarantees a
startable lineup now specifically protects *him*, so early bidding elsewhere can't quietly price him
out before you get to nominate him.

### Reading the room

- **🏃 Positional runs.** When a position's share of the last half-cycle of picks runs well ahead of
  its normal pace, the Plan flags it — prices there are inflated; sit it out, or nominate an ignored
  position while the room's distracted.
- **📐 Archetype read.** The Plan compares each position's actual sale prices to sheet value against
  the room's overall rate. If RB is selling hot and WR cold (or vice versa), it says so — and it's
  already leaning the plan's own pricing that way, not just reporting it.
- **🧊 / 🔥 Contestedness.** Each planned target is checked against every rival who both needs his
  position and can currently afford him. Uncontested (🧊) → nominate him yourself and get him cheap.
  Contested (🔥) → expect a war, or use him as someone else's bait instead.
- **💱 Trade value**, in the Nomination Helper, flags players who don't fill *your* need but several
  rivals are thin at — good value regardless, since this app only signals the opportunity live on
  draft day and has no post-draft trade board to act on it later.
- **⚠️ Stack risk** notes when your own roster concentrates several players on one NFL team or bye
  week — never a block, just something to weigh.

### Caution list

Never a block — a flagged player still gets recommended if he's genuinely the best value on the
board. Auto-flags: market price running well above worth, and (once you've fetched the playoff
schedule below) a tough fantasy-playoff-week (weeks 15–17) slate. Add your own reasons any time via
🚧 in Edit Value/Tier. The list feeds the Nomination Helper's decoy suggestions — a name the room
still likes is good bait even after your own numbers have soured on him.

Fetch bye weeks (⚙︎ → **Fetch bye + playoff schedule**) also pulls each team's weeks 15/16/17
opponents off ESPN's public schedule, best-effort — opponent strength is read from the same team win
totals the Vegas tab already tracks. ESPN doesn't document this field, so it can fail quietly; the
caution list just won't show a playoff reason until it succeeds.

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
