# World Cup Underdog Report

A tiny, zero-dependency generator that produces one self-contained `index.html` report
about World Cup **underdogs**, where "underdog" means a squad with a lower total market
value. The fun is in comparing what each team's price tag says it *should* do against
what it *actually* did.

## Usage

```bash
node build.js
```

That reads `teams.txt` (squad market values) from this folder, pulls the group draw and
finished results live from ESPN, and writes `index.html`. Open the file directly in a
browser (no server needed): everything (data, charts, styling) is baked in. Re-run after
each round to refresh.

Requires Node.js 18+ and network access (uses the built-in `fetch`, no API key). No
`npm install`, no dependencies.

### How the data is sourced

`teams.txt` is the only input file you maintain; market values are not available from any
score API. Everything else comes from ESPN's public scoreboard at build time:

- The tournament window (`START`/`END` constants in `fetch-matches.js`) is scanned for
  **finished** matches; scheduled/in-progress games are skipped.
- The group draw is derived from every group fixture (scheduled or played), so the bracket
  is known before kickoff.
- API team names are reconciled against `teams.txt` ignoring accents and punctuation, plus
  an `ALIASES` table for the genuinely different ones (e.g. `USA` → `United States`,
  `Czechia` → `Czech Republic`). Any name it can't map is printed so you can add an alias.
- Penalty-shootout winners in tied knockout games are detected and recorded as the team
  that advanced.

The ESPN endpoint is unofficial and could change. If it's unreachable, `build.js` exits
non-zero rather than emitting an empty report, so the last good `index.html` stays in place.

### Optional: snapshot the data to disk

`fetch-matches.js` writes the same data to `matches.txt` (finished games) and
`groups.suggested.txt` (the derived draw) if you want a local copy to inspect or hand-edit:

```bash
node fetch-matches.js   # writes matches.txt + groups.suggested.txt
```

`build.js` does not read these files; it fetches directly.

## Hosting

`index.html` is fully self-contained, so host it anywhere static:

- **GitHub Pages** — commit `index.html` to a repo, enable Pages on that branch.
- **Netlify / Cloudflare Pages** — drag the file (or the folder) into the dashboard.
- **S3 / any web host** — upload `index.html`.

To update the live report: run `node build.js` to re-fetch, then re-upload `index.html`.

## Input file

### `teams.txt` — squad market values
The one file you maintain. One team per line, `Name,marketValueInEuros` (whole numbers).
Blank lines and anything after `#` are ignored:

```
France,1520000000
Qatar,19930000
```

Team names must be unique. They are the canonical names that ESPN's results are reconciled
against (see the `ALIASES` table in `fetch-matches.js` for spelling differences).

The report fills in as results come in over the tournament; sections with no data yet show
a placeholder.

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
