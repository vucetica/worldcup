#!/usr/bin/env node
'use strict';

/*
 * Fetch finished World Cup results from ESPN's public scoreboard API and write
 * them to matches.txt in the format build.js expects. Zero dependencies (uses
 * Node 18+ global fetch).
 *
 *   node fetch-matches.js [outFile]      # default outFile = matches.txt
 *
 * Then run:  node build.js
 *
 * Only matches that have FINISHED are written; scheduled/in-progress games are
 * skipped. Team names are reconciled against teams.txt (accent/punctuation
 * insensitive, plus the alias table below). Any unmapped name is reported so
 * you can add an alias.
 */

const fs = require('fs');
const path = require('path');

// --- config ------------------------------------------------------------------
const LEAGUE = 'fifa.world';          // ESPN soccer league slug for the World Cup
const START = '2026-06-11';           // tournament window (inclusive)
const END = '2026-07-19';
const OUT = process.argv[2] || path.join(__dirname, 'matches.txt');

// ESPN stage headline -> build.js stage token
const STAGE_MAP = [
  [/round of 32/i, 'R32'], [/round of 16/i, 'R16'],
  [/quarter/i, 'QF'], [/semi/i, 'SF'],
  [/(3rd|third) place/i, '3P'], [/final/i, 'Final'], [/group/i, 'Group'],
];

// Aliases: normalized API name -> exact teams.txt name (only the ones that differ).
const ALIASES = {
  usa: 'United States', unitedstatesofamerica: 'United States',
  czechia: 'Czech Republic', korearepublic: 'South Korea',
  iriran: 'Iran', congodr: 'DR Congo', drcongo: 'DR Congo',
  turkiye: 'Turkey', cotedivoire: 'Ivory Coast', caboverde: 'Cape Verde',
  bosniaandherzegovina: 'Bosnia & Herzegovina',
};

// --- helpers -----------------------------------------------------------------
const fail = (m) => { console.error('\n  ERROR: ' + m + '\n'); process.exit(1); };
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

function buildLookup(names) {
  const lookup = new Map(); // normalized -> canonical
  for (const name of names) if (name) lookup.set(norm(name), name);
  for (const [k, v] of Object.entries(ALIASES)) lookup.set(k, v);
  return lookup;
}

function readTeamNames() {
  const p = path.join(__dirname, 'teams.txt');
  if (!fs.existsSync(p)) fail('teams.txt not found — run from the project folder.');
  const names = [];
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.replace(/#.*$/, '').trim();
    if (!t) continue;
    const name = t.split(',')[0].trim();
    if (name) names.push(name);
  }
  return names;
}

// Placeholder competitors for undecided slots ("Round of 32 16 Winner",
// "Semifinal 1 Loser", "Group J 2nd Place", "Third Place Group E/H/I/J/K"). Not
// real teams — skip silently so they don't clutter the unmapped report. No
// country name contains these tokens or a slash.
const PLACEHOLDER = /\b(winner|loser|runner-?up|place)\b|\//i;

function resolveName(apiName, lookup, unmapped) {
  const hit = lookup.get(norm(apiName));
  if (hit) return hit;
  if (!PLACEHOLDER.test(apiName)) unmapped.add(apiName);
  return null;
}

function* eachDate(start, end) {
  const d = new Date(start + 'T00:00:00Z'), last = new Date(end + 'T00:00:00Z');
  while (d <= last) {
    yield d.toISOString().slice(0, 10).replace(/-/g, '');
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

function stageFromHeadline(h) {
  if (!h) return null;
  for (const [re, tok] of STAGE_MAP) if (re.test(h)) return tok;
  return null;
}

async function fetchDay(yyyymmdd) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${LEAGUE}/scoreboard?dates=${yyyymmdd}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'worldcup-report' } });
  if (!res.ok) throw new Error(`${yyyymmdd}: HTTP ${res.status}`);
  return res.json();
}

// --- core fetch --------------------------------------------------------------
// Pull the tournament window from ESPN. Returns finished matches (chronological)
// plus the group draw derived from every group fixture, scheduled or played, so
// the bracket is known before kickoff. `teamNames` supplies the canonical names
// used to reconcile ESPN's spellings. This is what build.js calls directly;
// nothing here touches the filesystem.
async function fetchWorldCup(teamNames) {
  if (typeof fetch !== 'function') fail('Global fetch missing — needs Node 18 or newer.');
  const lookup = buildLookup(teamNames);
  const unmapped = new Set();
  const rows = [];         // finished matches: { date, stage, home, hs, away, as, advance }
  const draw = new Map();  // group letter -> Set of canonical team names
  let scanned = 0, finished = 0, daysFailed = 0;

  for (const day of eachDate(START, END)) {
    let data;
    try { data = await fetchDay(day); }
    catch (e) { console.warn('  skip ' + day + ': ' + e.message); daysFailed++; continue; }

    for (const ev of data.events || []) {
      const comp = (ev.competitions || [])[0];
      if (!comp) continue;
      scanned++;

      const home = (comp.competitors || []).find((c) => c.homeAway === 'home');
      const away = (comp.competitors || []).find((c) => c.homeAway === 'away');
      if (!home || !away) continue;
      const hName = resolveName(home.team.displayName || home.team.name, lookup, unmapped);
      const aName = resolveName(away.team.displayName || away.team.name, lookup, unmapped);
      if (!hName || !aName) continue;

      const headline = comp.altGameNote || (comp.notes && comp.notes[0] && comp.notes[0].headline) || ev.name;
      const stage = stageFromHeadline(headline);

      // Record the group draw from every group fixture, even before kickoff.
      if (stage === 'Group') {
        const gm = /group\s+([a-z])/i.exec(headline);
        if (gm) {
          const g = gm[1].toUpperCase();
          if (!draw.has(g)) draw.set(g, new Set());
          draw.get(g).add(hName); draw.get(g).add(aName);
        }
      }

      // Results: finished games with numeric scores only.
      const state = comp.status && comp.status.type && comp.status.type.state;
      if (state !== 'post' || !(comp.status.type.completed)) continue;
      const hs = parseInt(home.score, 10), as = parseInt(away.score, 10);
      if (!Number.isInteger(hs) || !Number.isInteger(as)) continue;

      // Tied knockout: record who advanced (penalty shootout winner flag).
      let advance = null;
      if (stage && stage !== 'Group' && hs === as)
        advance = home.winner ? hName : away.winner ? aName : null;

      rows.push({ date: ev.date || day, stage, home: hName, hs, away: aName, as, advance });
      finished++;
    }
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { rows, draw, unmapped, scanned, finished, daysFailed };
}

function reportUnmapped(unmapped) {
  if (!unmapped.size) return;
  console.log('\n  Unmapped team names (add to the ALIASES table in fetch-matches.js):');
  for (const n of unmapped) console.log('    - "' + n + '"  (normalized: ' + norm(n) + ')');
}

// --- CLI ---------------------------------------------------------------------
// Writes matches.txt (+ groups.suggested.txt) for anyone who wants the data on
// disk. build.js no longer needs this — it calls fetchWorldCup() directly.
async function cli() {
  const names = readTeamNames();
  const { rows, draw, unmapped, scanned, finished } = await fetchWorldCup(names);

  if (finished === 0) {
    console.log('No finished matches in the window — left ' + path.basename(OUT) + ' unchanged.');
  } else {
    const header = [
      '# Auto-generated by fetch-matches.js from ESPN (' + START + ' to ' + END + ').',
      '# Re-run `node fetch-matches.js` to refresh, then `node build.js`.',
      '# Hand-edit if you like — but a re-fetch overwrites this file.',
      '',
    ];
    const lines = rows.map((r) => {
      const f = [];
      if (r.stage) f.push(r.stage);
      f.push(r.home, r.hs, r.away, r.as);
      if (r.advance) f.push(r.advance);
      return f.join(',');
    });
    fs.writeFileSync(OUT, header.concat(lines).join('\n') + '\n');
  }

  // Write the real draw (non-destructive) for the user to review/rename.
  if (draw.size) {
    const drawPath = path.join(path.dirname(OUT), 'groups.suggested.txt');
    const lines = ['# Real draw derived from ESPN match data. Review, then rename to groups.txt.'];
    for (const g of [...draw.keys()].sort())
      lines.push(g + ': ' + [...draw.get(g)].sort().join(', '));
    fs.writeFileSync(drawPath, lines.join('\n') + '\n');
  }

  console.log('Fetched World Cup results from ESPN');
  console.log('  finished matches: ' + finished + ' (of ' + scanned + ' scanned)');
  if (finished) console.log('  wrote: ' + path.relative(process.cwd(), OUT));
  if (draw.size) console.log('  draw: ' + draw.size + ' groups -> groups.suggested.txt');
  reportUnmapped(unmapped);
}

module.exports = { fetchWorldCup, readTeamNames, reportUnmapped, START, END };

if (require.main === module) cli().catch((e) => fail(e.message));
