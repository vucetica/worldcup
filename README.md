# World Cup Underdog Report

A tiny, zero-dependency generator that turns three text files into one self-contained
`index.html` report about World Cup **underdogs**, where "underdog" means a squad with a
lower total market value. The fun is in comparing what each team's price tag says it
*should* do against what it *actually* did.

## Usage

```bash
node build.js
```

That reads `teams.txt`, `groups.txt`, `matches.txt` from this folder and writes
`index.html`. Open the file directly in a browser (no server needed) — everything
(data, charts, styling) is baked in. Re-run after each round of results.

Requires Node.js 18+. No `npm install`, no dependencies.

## Getting real results automatically

Instead of typing results by hand, pull finished games from ESPN's public API:

```bash
node fetch-matches.js   # writes matches.txt (finished games only)
node build.js           # matches.txt -> index.html
```

`fetch-matches.js` (Node 18+, uses built-in `fetch`, no API key):

- Scans the tournament window (`START`/`END` constants at the top of the file) and
  writes every **finished** match to `matches.txt` with the correct stage token;
  scheduled/in-progress games are skipped.
- Reconciles API team names against `teams.txt` ignoring accents and punctuation, plus
  an `ALIASES` table for the genuinely different ones (e.g. `USA` → `United States`,
  `Czechia` → `Czech Republic`). Any name it can't map is printed so you can add an alias.
- Also writes **`groups.suggested.txt`**, the real group draw derived from the matches.
  Review it and rename it to `groups.txt` so the group analysis matches reality.
- Detects penalty-shootout winners in tied knockout games and records who advanced.

Re-run `fetch-matches.js` whenever you want fresh results. It overwrites `matches.txt`,
so if you prefer to keep manual control, just don't run it. Note: the ESPN endpoint is
unofficial and could change; if a fetch fails, `matches.txt` is left as-is from before.

## Hosting

`index.html` is fully self-contained, so host it anywhere static:

- **GitHub Pages** — commit `index.html` to a repo, enable Pages on that branch.
- **Netlify / Cloudflare Pages** — drag the file (or the folder) into the dashboard.
- **S3 / any web host** — upload `index.html`.

To update the live report: edit `matches.txt`, run `node build.js`, re-upload `index.html`.

## Input files

Blank lines and anything after `#` are ignored in all three files.

### `teams.txt` — squad market values
One team per line, `Name,marketValueInEuros` (millions written out as whole numbers):

```
France,1520000000
Qatar,19930000
```

Team names must be unique and must match exactly across all three files.

### `groups.txt` — the draw
One group per line, `Label: Team, Team, Team, Team`:

```
A: France, Turkey, Ghana, Tunisia
```

### `matches.txt` — results
One match per line, `Home,HomeScore,Away,AwayScore`:

```
France,2,Tunisia,0
Saudi Arabia,2,Germany,1
```

Optional extras:
- **Stage prefix** (`Group`, `R32`, `R16`, `QF`, `SF`, `3P`, `Final`) for precision:
  `R16,Morocco,1,Spain,0`. If omitted, the stage is inferred — two teams in the same
  group is a group match; otherwise it's knockout, and knockout games are assigned to
  bracket rounds **by file order** (so list knockouts chronologically).
- **Penalty winner** as a 5th field on a tied knockout game:
  `QF,France,1,England,1,France`. A tied knockout game without it is flagged in the report.

The report fills in as `matches.txt` grows; sections with no data yet show a placeholder.

## What the report shows

- **Headline cards** — biggest single upset, best overachiever, biggest flop, best
  value for money, deepest underdog run, and "does money buy wins?".
- **Money table vs. real table** — value rank beside points rank, with the delta and
  points over/under what value predicts. Sortable.
- **Upset leaderboard** — every cheaper-team win or draw, scored by how many times
  dearer the favourite was.
- **Value vs. points scatter** — with a value→points regression line; teams above the
  line overperform their price.
- **Value for money** — squad cost per point earned.
- **Money buys wins?** — share of decisive games won by the pricier side, by stage.
- **Group analysis** — total value per group ("Group of Death"), internal spread, and
  whether each group's cheapest team advanced.
- **Cinderella watch** — the bottom quarter by value, ranked by points actually earned.

The "expected points" model is deliberately transparent: a least-squares fit of points
on log₁₀(value) across the teams that have played. No hidden ratings.
