#!/usr/bin/env node
'use strict';

/*
 * World Cup Underdog Report generator.
 * Reads teams.txt for market values, pulls groups + results live from ESPN, and
 * writes a single self-contained index.html. Zero dependencies (Node 18+).
 * Run with:  node build.js
 */

const fs = require('fs');
const path = require('path');
const { fetchWorldCup, reportUnmapped } = require('./fetch-matches');

const DIR = __dirname;
const file = (name) => path.join(DIR, name);

// ----------------------------------------------------------------------------
// Generic helpers
// ----------------------------------------------------------------------------

function readLines(name) {
  const p = file(name);
  if (!fs.existsSync(p)) throw new Error(`Missing input file: ${name}`);
  return fs.readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map((raw, i) => ({ n: i + 1, text: raw.replace(/#.*$/, '').trim() }))
    .filter((o) => o.text.length > 0);
}

function fmtEuro(v) {
  if (v >= 1e9) return '€' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '€' + (v / 1e6).toFixed(1) + 'M';
  return '€' + Math.round(v).toLocaleString('en-US');
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const fail = (msg) => { console.error('\n  ERROR: ' + msg + '\n'); process.exit(1); };

// ----------------------------------------------------------------------------
// Parsing
// ----------------------------------------------------------------------------

function parseTeams() {
  const teams = new Map();
  for (const { n, text } of readLines('teams.txt')) {
    const parts = text.split(',');
    if (parts.length < 2) fail(`teams.txt line ${n}: expected "Name,value" — got "${text}"`);
    const name = parts[0].trim();
    const value = Number(parts.slice(1).join(',').trim());
    if (!name) fail(`teams.txt line ${n}: empty team name`);
    if (!Number.isFinite(value) || value <= 0) fail(`teams.txt line ${n}: bad value for "${name}"`);
    if (teams.has(name)) fail(`teams.txt line ${n}: duplicate team "${name}"`);
    teams.set(name, { name, value });
  }
  if (teams.size === 0) fail('teams.txt has no teams.');
  [...teams.values()].sort((a, b) => b.value - a.value).forEach((t, i) => { t.valueRank = i + 1; });
  return teams;
}

// Build groups from the live draw (group letter -> Set of canonical names),
// keeping only teams we have a market value for.
function buildGroups(teams, draw) {
  const groups = [];
  const teamGroup = new Map();
  for (const label of [...draw.keys()].sort()) {
    const members = [...draw.get(label)].filter((m) => teams.has(m)).sort();
    for (const mem of members) teamGroup.set(mem, label);
    groups.push({ label, members });
  }
  return { groups, teamGroup };
}

const KO_ORDER = ['R32', 'R16', 'QF', 'SF', '3P', 'Final'];
const KO_SIZE = { R32: 16, R16: 8, QF: 4, SF: 2, '3P': 1, Final: 1 };
const STAGE_TOKENS = ['Group', ...KO_ORDER];
const KO_DEPTH = { Group: 0, R32: 1, R16: 2, QF: 3, '3P': 3, SF: 4, Final: 5 };
const KO_NAME = { R32: 'Round of 32', R16: 'Round of 16', QF: 'Quarter-final', SF: 'Semi-final', '3P': 'Third place', Final: 'Final' };

// A team is the underdog when its squad value is below this share of the
// opponent's (i.e. the favorite is worth more than 1/0.80 = 1.25x the underdog).
// A match where neither side clears this gap has no underdog.
const UNDERDOG_MAX = 0.80;

// Turn the fetched rows (chronological) into the match objects the metrics need.
// ESPN gives us the stage per game; the file-order bucketing only kicks in as a
// fallback for a knockout game whose headline we couldn't classify.
function buildMatches(teams, teamGroup, rows) {
  const matches = [];
  const inferred = []; // knockout matches with no detected stage, in chronological order
  rows.forEach((r, i) => {
    if (!teams.has(r.home) || !teams.has(r.away)) return; // no market value -> skip
    const stage = STAGE_TOKENS.includes(r.stage) ? r.stage : null;
    const m = { n: i + 1, home: r.home, away: r.away, hs: r.hs, as: r.as, advance: r.advance || null, stage, group: null };
    if (stage === 'Group' || stage === null) {
      const gh = teamGroup.get(r.home), ga = teamGroup.get(r.away);
      if (stage === 'Group') {
        m.group = gh || null;
      } else if (gh && ga && gh === ga) {
        m.stage = 'Group'; m.group = gh;
      } else {
        inferred.push(m); // resolve round below
      }
    }
    matches.push(m);
  });

  // Bucket inferred knockout matches into bracket slots by chronological order.
  const slots = [];
  for (const r of KO_ORDER) for (let i = 0; i < KO_SIZE[r]; i++) slots.push(r);
  inferred.forEach((m, i) => { m.stage = slots[i] || 'Final'; });

  const warnings = [];
  for (const m of matches) {
    if (m.stage !== 'Group' && m.hs === m.as && !m.advance)
      warnings.push(`Tied knockout match (${m.home} ${m.hs}-${m.as} ${m.away}) has no advancing team.`);
  }
  return { matches, warnings };
}

// ----------------------------------------------------------------------------
// Standings & metrics
// ----------------------------------------------------------------------------

function buildStats(teams, teamGroup, matches) {
  const stats = new Map();
  for (const t of teams.values())
    stats.set(t.name, {
      name: t.name, value: t.value, valueRank: t.valueRank, group: teamGroup.get(t.name) || null,
      played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, deepest: 0, deepestStage: '—',
    });

  for (const m of matches) {
    const h = stats.get(m.home), a = stats.get(m.away);
    h.played++; a.played++;
    h.gf += m.hs; h.ga += m.as; a.gf += m.as; a.ga += m.hs;
    if (m.hs > m.as) { h.w++; a.l++; h.pts += 3; }
    else if (m.hs < m.as) { a.w++; h.l++; a.pts += 3; }
    else { h.d++; a.d++; h.pts++; a.pts++; }
    const depth = KO_DEPTH[m.stage] || 0;
    for (const s of [h, a]) if (depth > s.deepest) { s.deepest = depth; s.deepestStage = m.stage; }
  }
  for (const s of stats.values()) s.gd = s.gf - s.ga;

  // Points rank across all teams (pts, then gd, then gf, then value desc as final tiebreak).
  const ranked = [...stats.values()].sort((a, b) =>
    b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || b.value - a.value);
  ranked.forEach((s, i) => { s.pointsRank = i + 1; });
  return stats;
}

function linreg(pts) {
  const n = pts.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  return { slope, intercept: (sy - slope * sx) / n };
}

function computeMetrics(teams, teamGroup, groups, matches) {
  const stats = buildStats(teams, teamGroup, matches);
  const played = [...stats.values()].filter((s) => s.played > 0);

  // Regression of points on log10(value), used for "expected points".
  const reg = linreg(played.map((s) => ({ x: Math.log10(s.value), y: s.pts })));
  for (const s of stats.values()) {
    s.expPts = reg ? reg.slope * Math.log10(s.value) + reg.intercept : null;
    s.residual = s.expPts == null || s.played === 0 ? null : s.pts - s.expPts;
  }

  // Upset leaderboard.
  const upsets = [];
  for (const m of matches) {
    const hv = teams.get(m.home).value, av = teams.get(m.away).value;
    const favVal = Math.max(hv, av), undVal = Math.min(hv, av);
    if (undVal >= UNDERDOG_MAX * favVal) continue; // no clear underdog -> not an upset
    const favHome = hv > av;
    const favorite = favHome ? m.home : m.away;
    const underdog = favHome ? m.away : m.home;
    const ratio = favVal / undVal;
    let kind = null;
    if (m.hs === m.as) kind = 'draw';
    else {
      const winner = m.hs > m.as ? m.home : m.away;
      if (winner === underdog) kind = 'win';
    }
    if (!kind) continue;
    upsets.push({
      stage: m.stage, favorite, underdog, favVal, undVal, ratio,
      score: m.hs, score2: m.as, home: m.home, away: m.away, hs: m.hs, as: m.as,
      kind, magnitude: ratio * (kind === 'win' ? 1 : 0.5),
    });
  }
  upsets.sort((a, b) => b.magnitude - a.magnitude);

  // Market efficiency: share of decisive matches won by the higher-valued side.
  const eff = { overall: { fav: 0, dec: 0, draws: 0 } };
  for (const m of matches) {
    const hv = teams.get(m.home).value, av = teams.get(m.away).value;
    if (hv === av) continue;
    const bucket = m.stage === 'Group' ? 'Group' : 'Knockout';
    eff[bucket] = eff[bucket] || { fav: 0, dec: 0, draws: 0 };
    if (m.hs === m.as) { eff.overall.draws++; eff[bucket].draws++; continue; }
    const winner = m.hs > m.as ? m.home : m.away;
    const favWon = (winner === m.home) === (hv > av);
    eff.overall.dec++; eff[bucket].dec++;
    if (favWon) { eff.overall.fav++; eff[bucket].fav++; }
  }

  // Group analysis.
  const advanced = new Set();
  for (const m of matches) if (m.stage !== 'Group') { advanced.add(m.home); advanced.add(m.away); }
  const groupInfo = groups.map((g) => {
    const members = g.members.map((name) => stats.get(name)).filter(Boolean);
    const total = members.reduce((s, t) => s + t.value, 0);
    const vals = members.map((t) => t.value);
    const lopsided = Math.max(...vals) / Math.min(...vals);
    const cheapest = members.slice().sort((a, b) => a.value - b.value)[0];
    return {
      label: g.label, total, lopsided,
      members: members.slice().sort((a, b) => b.value - a.value),
      cheapest: cheapest ? cheapest.name : null,
      cheapestAdvanced: cheapest ? advanced.has(cheapest.name) : false,
      anyKO: members.some((t) => advanced.has(t.name)),
    };
  }).sort((a, b) => b.total - a.total);

  // Efficiency leaderboard: euros (millions) per point.
  const efficiency = played.filter((s) => s.pts > 0)
    .map((s) => ({ name: s.name, value: s.value, pts: s.pts, gf: s.gf, perPt: s.value / 1e6 / s.pts }))
    .sort((a, b) => a.perPt - b.perPt);

  // Cinderella: bottom-quartile-by-value teams (valueRank in bottom 25%).
  const cutoff = Math.ceil(teams.size * 0.75); // rank > cutoff => bottom quartile
  const cinderellas = [...stats.values()]
    .filter((s) => s.valueRank > cutoff && s.played > 0)
    .sort((a, b) => b.pts - a.pts || b.gd - a.gd);

  // Raw per-match data (chronological): values, value ratio, outcome, and a
  // verdict. A team is the underdog only when its value is below UNDERDOG_MAX of
  // the opponent's. With an underdog: it wins or draws -> upset, else expected.
  // With no clear underdog the match has no verdict.
  const rawMatches = matches.map((m) => {
    const hv = teams.get(m.home).value, av = teams.get(m.away).value;
    const favVal = Math.max(hv, av), undVal = Math.min(hv, av);
    const ratio = favVal / undVal;
    const hasUnderdog = undVal < UNDERDOG_MAX * favVal;
    const favorite = hv >= av ? m.home : m.away;
    const underdog = hv >= av ? m.away : m.home;
    const winner = m.hs > m.as ? m.home : m.hs < m.as ? m.away : null;
    let verdict;
    if (!hasUnderdog) verdict = 'noUnderdog';
    else if (winner === favorite) verdict = 'expected'; // favorite won as priced
    else verdict = 'upset'; // underdog won or held the favorite to a draw
    return {
      n: m.n, stage: m.stage, group: m.group,
      home: m.home, away: m.away, hs: m.hs, as: m.as,
      hv, av, ratio, winner, hasUnderdog,
      favorite: hasUnderdog ? favorite : null,
      underdog: hasUnderdog ? underdog : null,
      verdict, advance: m.advance,
    };
  });

  return { stats, played, reg, upsets, eff, groupInfo, efficiency, cinderellas, advanced, rawMatches };
}

// ----------------------------------------------------------------------------
// Presentation rendering (Floodlight theme — full-viewport scroll-snap slides)
// ----------------------------------------------------------------------------

function pct(n, d) { return d ? Math.round((n / d) * 100) : 0; }
function emptyMsg(t) { return `<p class="empty">${t}</p>`; }

// A clickable team name. Clicking any of these filters the Raw Data table to
// that team's matches (wired up in the page script).
function teamLink(name) {
  return `<span class="team-link" data-team="${esc(name)}">${esc(name)}</span>`;
}

// One full-viewport slide. `kicker` is the small mono label, `n` the section number.
function slide(n, kicker, heading, body, extraClass) {
  return `<section class="slide ${extraClass || ''}" id="s${n}">
    <div class="slide-content">
      <div class="head reveal">
        <span class="kicker">${esc(kicker)}</span>
        <h2>${heading}</h2>
      </div>
      ${body}
    </div>
  </section>`;
}

function renderHTML(data, meta) {
  const { stats, played, reg, upsets, eff, groupInfo, efficiency, cinderellas, rawMatches } = data;
  const allTeams = [...stats.values()];
  const matchCount = meta.matchCount;

  // --- derived lists -------------------------------------------------------
  const overs = played.filter((s) => s.residual != null).sort((a, b) => b.residual - a.residual);
  const overTop = overs.slice(0, 6);
  const flopTop = overs.slice().reverse().slice(0, 6);
  const topUpset = upsets[0];
  const bestVal = efficiency[0];
  const deepestArr = played.slice().filter((s) => s.deepest > 0).sort((a, b) => b.deepest - a.deepest || b.valueRank - a.valueRank);
  const effPct = pct(eff.overall.fav, eff.overall.dec);

  // ========================================================================
  // SLIDE 0 — HERO
  // ========================================================================
  const hero = `<section class="slide hero visible" id="s0">
    <div class="pitch"></div>
    <div class="slide-content">
      <span class="kicker reveal">World Cup 2026 · a market-value study</span>
      <h1 class="reveal">THE<br><span class="hl">UNDERDOG</span><br>REPORT</h1>
      <p class="hero-sub reveal">When the price says one thing<br>and the pitch says another.</p>
      <div class="hero-stats reveal">
        <div class="hstat"><span class="count" data-to="${meta.teamCount}">0</span><label>teams</label></div>
        <div class="hstat"><span class="count" data-to="${matchCount}">0</span><label>matches</label></div>
        <div class="hstat lime"><span class="count" data-to="${upsets.length}">0</span><label>upsets</label></div>
        <div class="hstat"><span class="count" data-to="${effPct}" data-suffix="%">0</span><label>money won</label></div>
      </div>
      <div class="scrollcue reveal">scroll to begin ↓</div>
    </div>
  </section>`;

  // ========================================================================
  // SLIDE 1 — HEADLINES (cards)
  // ========================================================================
  const cardData = [
    ['Biggest single upset', topUpset ? teamLink(topUpset.underdog) : '—',
      topUpset ? `${topUpset.kind === 'draw' ? 'held' : 'beat'} ${teamLink(topUpset.favorite)} · ${topUpset.ratio.toFixed(1)}× dearer` : 'no upsets yet', 'gold'],
    ['Best overachiever', overs.length ? teamLink(overs[0].name) : '—',
      overs.length ? `+${overs[0].residual.toFixed(1)} pts vs value-expected` : '—', 'lime'],
    ['Biggest flop', flopTop.length && flopTop[0].residual < 0 ? teamLink(flopTop[0].name) : '—',
      flopTop.length && flopTop[0].residual < 0 ? `${flopTop[0].residual.toFixed(1)} pts vs value-expected` : '—', 'red'],
    ['Best value for money', bestVal ? teamLink(bestVal.name) : '—',
      bestVal ? `${fmtEuro(bestVal.value)} → ${bestVal.pts} pts` : '—', 'lime'],
    ['Deepest underdog run', deepestArr.length ? teamLink(deepestArr[0].name) : '—',
      deepestArr.length ? `${KO_NAME[deepestArr[0].deepestStage] || deepestArr[0].deepestStage} · value #${deepestArr[0].valueRank}` : 'knockouts not played', 'gold'],
    ['Does money buy wins?', eff.overall.dec ? `${effPct}%` : '—',
      eff.overall.dec ? `pricier side won ${eff.overall.fav}/${eff.overall.dec} decisive games` : '—', ''],
  ];
  const cards = cardData.map((c, i) => `<div class="card reveal ${c[3]}" style="transition-delay:${i * 70}ms">
      <div class="card-label">${c[0]}</div>
      <div class="card-big">${c[1]}</div>
      <div class="card-sub">${c[2]}</div>
    </div>`).join('');
  const headlines = slide(1, 'the story in six numbers', 'The Headlines', `<div class="cards reveal">${cards}</div>`);

  // ========================================================================
  // SLIDE 2 — GIANT-KILLINGS (top upsets with value-gap bars)
  // ========================================================================
  const gkBody = upsets.length
    ? `<div class="gk-list">${upsets.slice(0, 5).map((u, i) => {
        const w = Math.max(2.5, (u.undVal / u.favVal) * 100);
        const sc = u.home === u.underdog ? `${u.hs}–${u.as}` : `${u.as}–${u.hs}`;
        return `<div class="gk reveal" style="transition-delay:${i * 80}ms">
          <div class="gk-no">${String(i + 1).padStart(2, '0')}</div>
          <div class="gk-body">
            <div class="gk-line"><b>${teamLink(u.underdog)}</b> <em>${u.kind === 'draw' ? 'held' : 'beat'}</em> ${teamLink(u.favorite)} <span class="gk-score">${sc}</span></div>
            <div class="gk-bar"><div class="gk-fill" style="width:${w.toFixed(1)}%"></div></div>
            <div class="gk-sub">${fmtEuro(u.undVal)} vs ${fmtEuro(u.favVal)} · ${u.stage === 'Group' ? 'Group stage' : (KO_NAME[u.stage] || u.stage)}</div>
          </div>
          <div class="gk-x">${u.ratio.toFixed(1)}<span>×</span></div>
        </div>`;
      }).join('')}</div>`
    : emptyMsg('No upsets yet — every result has gone to the pricier squad (or to equals).');
  const giants = slide(2, 'cheaper squad wins or draws · ranked by value gap', 'Giant-Killings', gkBody);

  // ========================================================================
  // SLIDE 4 — OVERACHIEVERS & UNDERACHIEVERS (two columns)
  // ========================================================================
  const mvRow = (s) => {
    const delta = s.valueRank - s.pointsRank;
    const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '–';
    const dcls = delta > 0 ? 'pos' : delta < 0 ? 'neg' : '';
    return `<div class="mv">
      <span class="mv-team">${teamLink(s.name)}</span>
      <span class="mv-delta ${dcls}">${arrow} ${Math.abs(delta)}</span>
      <span class="mv-res ${s.residual > 0 ? 'pos' : 'neg'}">${s.residual >= 0 ? '+' : ''}${s.residual.toFixed(1)}</span>
    </div>`;
  };
  const twocol = overs.length
    ? `<div class="twocol reveal">
        <div class="col">
          <div class="col-head over">Overachievers</div>
          <div class="col-key"><span>team</span><span>rank ▲</span><span>vs exp</span></div>
          ${overTop.map(mvRow).join('')}
        </div>
        <div class="col">
          <div class="col-head under">Underachievers</div>
          <div class="col-key"><span>team</span><span>rank ▼</span><span>vs exp</span></div>
          ${flopTop.map(mvRow).join('')}
        </div>
      </div>`
    : emptyMsg('No matches played yet.');
  const movers = slide(3, 'rank by value vs rank by points · pts above/below value-expected', 'Punching Up &amp; Down', twocol);

  // ========================================================================
  // SLIDE 5 — VALUE FOR MONEY (efficiency bars)
  // ========================================================================
  const effShown = efficiency.slice(0, 8);
  const maxPerPt = effShown.length ? effShown[effShown.length - 1].perPt : 1;
  const effBody = effShown.length
    ? `<div class="bars reveal">${effShown.map((e, i) => {
        const w = Math.max(4, (e.perPt / maxPerPt) * 100);
        return `<div class="bar-row" style="transition-delay:${i * 50}ms">
          <div class="bar-name">${teamLink(e.name)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${w.toFixed(1)}%"></div></div>
          <div class="bar-val">€${e.perPt.toFixed(1)}M<span>/pt</span></div>
        </div>`;
      }).join('')}</div>`
    : emptyMsg('No points scored yet.');
  const valueForMoney = slide(4, 'squad cost per point earned · cheapest return first', 'Bang for the Buck', effBody);

  // ========================================================================
  // SLIDE 6 — THE GROUPS (value bars, Group of Death tagged)
  // ========================================================================
  const maxGroup = groupInfo.length ? groupInfo[0].total : 1;
  const groupBody = groupInfo.length
    ? `<div class="bars reveal">${groupInfo.map((g, i) => {
        const w = Math.max(6, (g.total / maxGroup) * 100);
        const tag = i === 0 ? '<span class="tag gold">Group of Death</span>' : '';
        const teams = g.members.map((t) =>
          `<span class="grp-team">${teamLink(t.name)} <em>${fmtEuro(t.value)}</em></span>`).join('');
        return `<div class="grp-block" style="transition-delay:${i * 35}ms">
          <div class="bar-row">
            <div class="bar-name grp">Group ${esc(g.label)}${tag}</div>
            <div class="bar-track"><div class="bar-fill ${i === 0 ? 'hot' : ''}" style="width:${w.toFixed(1)}%"></div></div>
            <div class="bar-val">${fmtEuro(g.total)}</div>
          </div>
          <div class="grp-teams">${teams}</div>
        </div>`;
      }).join('')}</div>`
    : emptyMsg('No groups defined.');
  const groupsSlide = slide(5, 'combined squad value per group · richest = deadliest', 'The Groups', groupBody);

  // ========================================================================
  // SLIDE 7 — CINDERELLA WATCH (bottom quartile by value)
  // ========================================================================
  const cinBody = cinderellas.length
    ? `<div class="cin reveal">${cinderellas.slice(0, 6).map((s, i) => `<div class="cin-row" style="transition-delay:${i * 60}ms">
        <span class="cin-team">${teamLink(s.name)} <em>value #${s.valueRank}</em></span>
        <span class="cin-pts"><b>${s.pts}</b> pts</span>
        <span class="cin-gd">${s.gd >= 0 ? '+' : ''}${s.gd} GD</span>
        <span class="cin-far">${s.deepest > 0 ? (KO_NAME[s.deepestStage] || s.deepestStage) : 'Group'}</span>
      </div>`).join('')}</div>`
    : emptyMsg('No bottom-quartile team has played yet.');
  const cinderella = slide(6, 'the cheapest quarter of the field · by points banked', 'Cinderella Watch', cinBody);

  // ========================================================================
  // SLIDE 8 — THE FULL LEDGER (complete sortable table; scrolls internally)
  // ========================================================================
  const ledgerRows = allTeams.slice().sort((a, b) => a.pointsRank - b.pointsRank).map((s) => {
    const delta = s.valueRank - s.pointsRank;
    const dCls = delta > 0 ? 'pos' : delta < 0 ? 'neg' : '';
    const resid = s.residual == null ? '' : (s.residual >= 0 ? '+' : '') + s.residual.toFixed(1);
    const rCls = s.residual == null ? '' : s.residual > 0.3 ? 'pos' : s.residual < -0.3 ? 'neg' : '';
    return `<tr>
      <td>${teamLink(s.name)}</td>
      <td class="num" data-sort="${s.value}">${fmtEuro(s.value)}</td>
      <td class="num" data-sort="${s.valueRank}">${s.valueRank}</td>
      <td class="num" data-sort="${s.pointsRank}">${s.pointsRank}</td>
      <td class="num">${s.played ? s.pts : '—'}</td>
      <td class="num ${dCls}" data-sort="${delta}">${delta > 0 ? '+' : ''}${delta}</td>
      <td class="num ${rCls}" data-sort="${s.residual == null ? -999 : s.residual}">${resid || '—'}</td>
    </tr>`;
  }).join('');
  const ledger = `<section class="slide" id="s7">
    <div class="slide-content">
      <div class="head reveal">
        <span class="kicker">all ${meta.teamCount} teams · click a header to sort</span>
        <h2>The Full Ledger</h2>
      </div>
      <div class="ledger-scroll reveal">
        <table id="money"><thead><tr>
          <th data-t="text" title="National team name.">Team</th>
          <th class="num" data-t="num" title="Total squad market value in euros (combined player transfer values).">Value</th>
          <th class="num" data-t="num" title="Rank by squad value; 1 = most valuable.">Val&nbsp;rk</th>
          <th class="num" data-t="num" title="Rank by points, with goal difference, goals for, then value as tiebreakers.">Pts&nbsp;rk</th>
          <th class="num" data-t="num" title="Points earned: 3 per win, 1 per draw, 0 per loss.">Pts</th>
          <th class="num" data-t="num" title="Value rank minus points rank. Positive = placed higher than its price implies.">Δ&nbsp;rk</th>
          <th class="num" data-t="num" title="Actual points minus expected points (value-fit line). Positive = over-performing its value.">vs&nbsp;exp</th>
        </tr></thead><tbody>${ledgerRows}</tbody></table>
      </div>
    </div>
  </section>`;

  // ========================================================================
  // SLIDE 9 — RAW DATA (every match: group/stage, score, values, verdict)
  // ========================================================================
  const vClass = { expected: 'pos', upset: 'neg', noUnderdog: 'muted' };
  const vLabel = { expected: 'Expected', upset: 'Upset', noUnderdog: 'No underdog' };
  const stageLabel = (m) => m.stage === 'Group'
    ? `Group ${m.group || '?'}`
    : (KO_NAME[m.stage] || m.stage || '—');
  const rawRows = rawMatches.slice().sort((a, b) => a.n - b.n).map((m) => {
    const win = m.winner ? (m.winner === m.home ? 'home' : 'away') : '';
    const homeSpan = `<span class="team-link${win === 'home' ? ' rw' : ''}" data-team="${esc(m.home)}">${esc(m.home)}</span>`;
    const awaySpan = `<span class="team-link${win === 'away' ? ' rw' : ''}" data-team="${esc(m.away)}">${esc(m.away)}</span>`;
    return `<tr data-home="${esc(m.home)}" data-away="${esc(m.away)}">
      <td class="num">${m.n}</td>
      <td data-sort="${esc(stageLabel(m))}">${esc(stageLabel(m))}</td>
      <td>${homeSpan} <b>${m.hs}–${m.as}</b> ${awaySpan}</td>
      <td class="num" data-sort="${m.hv}">${fmtEuro(m.hv)}</td>
      <td class="num" data-sort="${m.av}">${fmtEuro(m.av)}</td>
      <td class="num" data-sort="${m.ratio}">${m.ratio.toFixed(2)}×</td>
      <td>${m.underdog ? teamLink(m.underdog) : '—'}</td>
      <td>${m.winner ? teamLink(m.winner) : 'Draw'}</td>
      <td class="${vClass[m.verdict]}" data-sort="${m.verdict}">${vLabel[m.verdict]}</td>
    </tr>`;
  }).join('');
  const rawData = `<section class="slide" id="s8">
    <div class="slide-content">
      <div class="head reveal">
        <span class="kicker">every match · click any team name to filter · click a header to sort</span>
        <h2>The Raw Data</h2>
        <div id="rawFilter" class="raw-filter" hidden>filtering: <b id="rawFilterName"></b><button id="rawFilterClear" type="button">clear ✕</button></div>
      </div>
      <div class="ledger-scroll reveal">
        <table id="raw"><thead><tr>
          <th class="num" data-t="num" title="Match order in the tournament (chronological).">#</th>
          <th data-t="text" title="Group letter for group games, or the knockout round.">Stage</th>
          <th data-t="text" title="Home team, score, away team. The winner is highlighted.">Match</th>
          <th class="num" data-t="num" title="Home team's squad market value in euros.">Home&nbsp;val</th>
          <th class="num" data-t="num" title="Away team's squad market value in euros.">Away&nbsp;val</th>
          <th class="num" data-t="num" title="Value gap: larger squad value divided by the smaller.">Gap</th>
          <th data-t="text" title="The team valued below 80% of its opponent (gap above 1.25×). Blank if neither side clears that gap.">Underdog</th>
          <th data-t="text" title="Match winner, or Draw.">Winner</th>
          <th data-t="text" title="Upset = underdog won or drew. Expected = favorite won. No underdog = squads within 80% of each other.">Verdict</th>
        </tr></thead><tbody>${rawRows}</tbody></table>
      </div>
    </div>
  </section>`;

  // ========================================================================
  // SLIDE 10 — METHOD / CLOSING
  // ========================================================================
  const regNote = reg
    ? `Expected points = ${reg.slope.toFixed(2)}·log₁₀(value) ${reg.intercept >= 0 ? '+' : '−'} ${Math.abs(reg.intercept).toFixed(2)}, fit over the ${played.length} teams that have played a match.`
    : 'There are not yet enough played matches to fit the value-to-points line.';
  const effDefList = ['Group', 'Knockout'].filter((k) => eff[k]).map((k) =>
    `${k.toLowerCase()} stage ${eff[k].fav} of ${eff[k].dec} (${pct(eff[k].fav, eff[k].dec)}%)`).join('; ');
  const effNote = effDefList
    ? `Counted separately per phase. To date: ${effDefList}.`
    : 'No decisive matches have been played yet.';
  const warnHtml = meta.warnings.length
    ? `<div class="warn"><b>Data notes:</b><ul>${meta.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '';
  const closing = `<section class="slide method" id="s9">
    <div class="slide-content">
      <div class="head reveal">
        <span class="kicker">where the data comes from and how each metric is computed</span>
        <h2>The <span class="hl">Method</span></h2>
      </div>
      <div class="method-scroll reveal">
        <h3 class="method-h">Where the numbers come from</h3>
        <div class="method-grid">
          <div>
            <h3>Squad market values</h3>
            <p>Each team's value is the combined transfer-market value of its players, in euros. It is the single measure of how expensive a squad is, and the basis for every "favorite" and "underdog" call.</p>
          </div>
          <div>
            <h3>Match results</h3>
            <p>Scores, the stage of each game, and the group draw come from live World Cup results. Only finished matches are counted.</p>
          </div>
        </div>
        <p class="method-build">Everything below is computed from those two inputs. Nothing is hand-picked, and there are no hidden ratings.</p>

        <h3 class="method-h">What each number means</h3>
        <dl class="defs">
          <div><dt>Squad value</dt><dd>A team's total squad market value in euros: the combined transfer-market value of its players.</dd></div>
          <div><dt>Value rank</dt><dd>Teams ordered by squad value, where 1 is the most valuable.</dd></div>
          <div><dt>Points</dt><dd>Standard scoring applied to every match a team has played: 3 for a win, 1 for a draw, 0 for a loss.</dd></div>
          <div><dt>Points rank</dt><dd>Teams ordered by points, using goal difference, then goals for, then squad value as successive tiebreakers.</dd></div>
          <div><dt>Goals for / against / GD</dt><dd>Goals scored and conceded summed across all matches played. GD is goals for minus goals against.</dd></div>
          <div><dt>Deepest stage</dt><dd>The latest round in which a team appears, ordered group → round of 32 → round of 16 → quarter-final → semi-final → final.</dd></div>
          <div><dt>Expected points</dt><dd>A least-squares line fit of points against log₁₀(squad value). ${esc(regNote)}</dd></div>
          <div><dt>vs expected (residual)</dt><dd>Actual points minus expected points. Positive means more points than the value-fit line predicts; negative means fewer.</dd></div>
          <div><dt>Δ rank</dt><dd>Value rank minus points rank. Positive means a team sits higher in the table than its price implies.</dd></div>
          <div><dt>Value gap (ratio)</dt><dd>For a single match, the larger squad value divided by the smaller. Higher means a wider price difference between the two teams.</dd></div>
          <div><dt>Underdog</dt><dd>In a given match, the team whose squad value is below 80% of the opponent's, that is, a value gap above 1.25×. If neither team clears that gap, the match has no underdog.</dd></div>
          <div><dt>Upset / giant-killing</dt><dd>A match with a clear underdog in which the underdog wins or draws. Ranked by the value gap, with draws weighted at half the magnitude of a win.</dd></div>
          <div><dt>Verdict</dt><dd>Per match: <em>Upset</em> when the underdog won or drew, <em>Expected</em> when the favorite won, and <em>No underdog</em> when the two squads are within 80% of each other's value.</dd></div>
          <div><dt>Market efficiency</dt><dd>Share of decisive (non-draw) matches won by the higher-valued team. ${esc(effNote)}</dd></div>
          <div><dt>Bang for the buck</dt><dd>Squad value in millions of euros divided by points earned. A lower figure means more points per euro of squad value.</dd></div>
          <div><dt>Cinderella</dt><dd>Teams in the bottom quarter by squad value that have played at least one match, ordered by points, then goal difference.</dd></div>
          <div><dt>Group total / Group of Death</dt><dd>The combined squad value of the teams drawn into a group. The group with the highest combined value is labelled the Group of Death.</dd></div>
        </dl>
        ${warnHtml}
        <div class="end">⚽ updated ${esc(meta.builtAt)} · ${meta.teamCount} teams · ${matchCount} matches</div>
      </div>
    </div>
  </section>`;

  // --- assemble & nav ------------------------------------------------------
  const order = [hero, headlines, giants, movers, valueForMoney, groupsSlide, cinderella, ledger, rawData, closing];
  const navLabels = ['Intro', 'Headlines', 'Giant-kills', 'Up & down', 'Value for money', 'Groups', 'Cinderella', 'Full ledger', 'Raw data', 'Method'];
  const dots = navLabels.map((lab, i) =>
    `<a class="navdot${i === 0 ? ' on' : ''}" href="#s${i}" aria-label="${esc(lab)}"><span>${esc(lab)}</span></a>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Underdog Report · World Cup</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
/* ===== VIEWPORT BASE (mandatory) ===== */
html, body { height:100%; overflow-x:hidden; }
html { scroll-snap-type:y mandatory; scroll-behavior:smooth; }
.slide { width:100vw; height:100vh; height:100dvh; overflow:hidden; scroll-snap-align:start; display:flex; flex-direction:column; position:relative; }
.slide-content { flex:1; display:flex; flex-direction:column; justify-content:center; max-height:100%; overflow:hidden; padding:var(--slide-padding); }
:root {
  --title-size:clamp(1.5rem,5vw,4rem); --h2-size:clamp(1.6rem,5vw,3.6rem); --h3-size:clamp(1rem,2.5vw,1.4rem);
  --body-size:clamp(.8rem,1.4vw,1.05rem); --small-size:clamp(.62rem,1vw,.8rem);
  --slide-padding:clamp(1.1rem,4.5vw,4.5rem); --content-gap:clamp(.5rem,2vw,2rem); --element-gap:clamp(.25rem,1vw,1rem);
}
@media (max-height:700px){ :root{ --slide-padding:clamp(.8rem,3vw,2rem); --h2-size:clamp(1.4rem,4vw,2.4rem); } }
@media (max-height:600px){ :root{ --slide-padding:.7rem 1.2rem; --body-size:clamp(.7rem,1.2vw,.92rem);} .navdot span,.scrollcue,.col-key{display:none;} }
@media (prefers-reduced-motion:reduce){ *,*::before,*::after{animation-duration:.01ms!important;transition-duration:.2s!important;} html{scroll-behavior:auto;} }

/* ===== BRAND THEME (light: Deep Teal + Lime Green) ===== */
:root{
  /* brand scale */
  --teal:#05413F; --teal-med:#086664; --lime:#BAD868; --lime2:#a5c455; --lime-text:#607530;
  /* semantic */
  --bg:#ffffff; --panel:#f6fbfa; --panel2:#e8f6f2; --line:#cbe7e1;
  --ink:#05413F; --muted:#5c7c78; --gold:#b9831b; --red:#d23f33;
}
*{box-sizing:border-box;}
body{
  margin:0; color:var(--ink); background:var(--bg);
  font-family:'Archivo',-apple-system,BlinkMacSystemFont,sans-serif; font-size:var(--body-size); line-height:1.5;
  background-image:
    radial-gradient(ellipse 55% 45% at 12% -8%, rgba(186,216,104,.18), transparent 60%),
    radial-gradient(ellipse 55% 45% at 88% -8%, rgba(8,102,100,.09), transparent 60%);
  background-attachment:fixed;
}
h1,h2,h3{margin:0;}
h1{font-family:'Anton',sans-serif; font-weight:400; text-transform:uppercase; line-height:.88; letter-spacing:.005em; font-size:clamp(2.6rem,10vw,7.6rem);}
h2{font-family:'Anton',sans-serif; font-weight:400; text-transform:uppercase; line-height:.95; letter-spacing:.01em; font-size:var(--h2-size);}
h3{font-family:'Anton',sans-serif; font-weight:400; text-transform:uppercase; letter-spacing:.02em; font-size:var(--h3-size); color:var(--teal-med); margin-top:clamp(.6rem,1.5vh,1.2rem);}
.hl{color:var(--teal-med);}
b{font-weight:700;}
code{font-family:'Space Mono',monospace; color:var(--lime-text); font-size:.92em;}
.kicker{font-family:'Space Mono',monospace; text-transform:uppercase; letter-spacing:.22em; font-size:var(--small-size); color:var(--teal-med); display:block; margin-bottom:clamp(.4rem,1.2vh,.9rem);}
.empty{color:var(--muted); font-style:italic;}
.muted{color:var(--muted);}
.pos{color:var(--lime-text);} .neg{color:var(--red);}
.rw{font-weight:700; color:var(--teal-med);}
.team-link{cursor:pointer; text-decoration:underline; text-decoration-color:transparent; text-underline-offset:2px; transition:text-decoration-color .15s, color .15s;}
.team-link:hover{text-decoration-color:currentColor; color:var(--teal-med);}

.head{margin-bottom:clamp(.7rem,2vh,1.4rem);}

/* ===== entrance reveals ===== */
.reveal{opacity:0; transform:translateY(28px); transition:opacity .7s cubic-bezier(.16,1,.3,1), transform .7s cubic-bezier(.16,1,.3,1);}
.visible .reveal{opacity:1; transform:none;}

/* ===== HERO ===== */
.hero .slide-content{justify-content:center;}
.hero .kicker{margin-bottom:clamp(.6rem,1.6vh,1.1rem);}
.hero-sub{font-size:clamp(.95rem,2.1vw,1.45rem); color:var(--muted); margin:clamp(.8rem,2.4vh,1.6rem) 0 0; max-width:30ch; transition-delay:.12s;}
.hero h1{transition-delay:.05s;}
.pitch{position:absolute; inset:0; pointer-events:none; opacity:.5;
  background:
    repeating-linear-gradient(180deg, transparent 0 64px, rgba(8,102,100,.05) 64px 128px),
    radial-gradient(circle at 50% 118%, rgba(186,216,104,.20), transparent 42%);}
.pitch::after{content:""; position:absolute; left:50%; bottom:-30vh; width:60vh; height:60vh; transform:translateX(-50%); border:2px solid rgba(8,102,100,.16); border-radius:50%;}
.hero-stats{display:flex; flex-wrap:wrap; gap:clamp(1rem,4vw,3rem); margin-top:clamp(.9rem,3vh,2rem); transition-delay:.2s;}
.hstat{display:flex; flex-direction:column;}
.hstat .count{font-family:'Space Mono',monospace; font-weight:700; font-size:clamp(1.8rem,5vw,3.4rem); line-height:1; color:var(--ink);}
.hstat.lime .count{color:var(--teal-med);}
.hstat label{font-family:'Space Mono',monospace; text-transform:uppercase; letter-spacing:.15em; font-size:var(--small-size); color:var(--muted); margin-top:.35rem;}
.scrollcue{margin-top:clamp(1rem,3vh,1.9rem); font-family:'Space Mono',monospace; font-size:var(--small-size); letter-spacing:.2em; text-transform:uppercase; color:var(--muted); transition-delay:.35s; animation:bob 2.2s ease-in-out infinite;}
@keyframes bob{0%,100%{transform:translateY(0);}50%{transform:translateY(6px);}}

/* ===== CARDS ===== */
.cards{display:grid; grid-template-columns:repeat(3,1fr); gap:clamp(.6rem,1.5vw,1.1rem); max-width:1100px;}
.card{background:var(--panel); border:1px solid var(--line); border-radius:16px; padding:clamp(.9rem,2vw,1.6rem); transition:transform .25s, border-color .25s, opacity .7s, box-shadow .25s;}
.card:hover{transform:translateY(-5px); border-color:var(--lime); box-shadow:0 14px 40px rgba(5,65,63,.14);}
.card-label{font-family:'Space Mono',monospace; text-transform:uppercase; letter-spacing:.1em; font-size:var(--small-size); color:var(--muted);}
.card-big{font-family:'Anton',sans-serif; font-size:clamp(1.3rem,2.8vw,2.1rem); line-height:1.05; margin:.5rem 0 .3rem; text-transform:uppercase;}
.card-sub{font-size:var(--small-size); color:var(--muted);}
.card.lime .card-big{color:var(--teal-med);} .card.gold .card-big{color:var(--gold);} .card.red .card-big{color:var(--red);}
@media (max-width:760px){ .cards{grid-template-columns:repeat(2,1fr);} }

/* ===== GIANT-KILLINGS ===== */
.gk-list{display:flex; flex-direction:column; gap:clamp(.35rem,1vh,.58rem); max-width:1000px;}
.gk{display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:clamp(.8rem,2vw,1.6rem);
  background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:clamp(.42rem,1vw,.72rem) clamp(.9rem,2vw,1.5rem); transition:opacity .7s, transform .7s;}
.gk-no{font-family:'Anton',sans-serif; font-size:clamp(1.4rem,3vw,2.4rem); color:var(--line);}
.gk-line{font-size:clamp(.9rem,1.8vw,1.25rem);}
.gk-line b{color:var(--teal-med);} .gk-line em{font-style:normal; color:var(--muted); margin:0 .25em;}
.gk-score{font-family:'Space Mono',monospace; color:var(--gold); margin-left:.5em;}
.gk-bar{height:6px; background:var(--panel2); border-radius:4px; margin:.4rem 0 .3rem; overflow:hidden; border:1px solid var(--line);}
.gk-fill{height:100%; background:linear-gradient(90deg,var(--lime),var(--lime2)); border-radius:4px; box-shadow:0 0 10px rgba(186,216,104,.55);}
.gk-sub{font-family:'Space Mono',monospace; font-size:var(--small-size); color:var(--muted);}
.gk-x{font-family:'Anton',sans-serif; font-size:clamp(1.5rem,4vw,3rem); color:var(--gold); line-height:1;}
.gk-x span{font-size:.5em; color:var(--muted);}

/* ===== TWO COLUMNS (over/under) ===== */
.twocol{display:grid; grid-template-columns:1fr 1fr; gap:clamp(1rem,3vw,2.6rem); max-width:1000px;}
.col-head{font-family:'Anton',sans-serif; text-transform:uppercase; font-size:clamp(1.1rem,2.4vw,1.7rem); margin-bottom:.5rem;}
.col-head.over{color:var(--lime-text);} .col-head.under{color:var(--red);}
.col-key{display:grid; grid-template-columns:1fr auto auto; gap:1rem; font-family:'Space Mono',monospace; font-size:.7em; text-transform:uppercase; letter-spacing:.1em; color:var(--muted); padding:0 .2rem .4rem; border-bottom:1px solid var(--line);}
.mv{display:grid; grid-template-columns:1fr auto auto; gap:1rem; align-items:center; padding:clamp(.35rem,1vh,.6rem) .2rem; border-bottom:1px solid var(--line); font-size:clamp(.85rem,1.6vw,1.05rem);}
.mv-team{white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
.mv-delta{font-family:'Space Mono',monospace; font-size:.85em;}
.mv-res{font-family:'Space Mono',monospace; min-width:3ch; text-align:right;}
@media (max-width:760px){ .twocol{grid-template-columns:1fr;} }

/* ===== BARS (efficiency + groups) ===== */
.bars{display:flex; flex-direction:column; gap:clamp(.35rem,1.1vh,.7rem); max-width:1000px;}
.bar-row{display:grid; grid-template-columns:clamp(120px,22vw,210px) 1fr clamp(80px,12vw,130px); align-items:center; gap:clamp(.6rem,1.5vw,1.1rem); transition:opacity .7s, transform .7s;}
.bar-name{font-size:clamp(.8rem,1.5vw,1rem); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
.bar-name.grp{font-family:'Anton',sans-serif; text-transform:uppercase;}
.bar-track{background:var(--panel2); border:1px solid var(--line); border-radius:6px; height:clamp(13px,2vh,18px); overflow:hidden;}
.bar-fill{height:100%; background:linear-gradient(90deg,var(--lime2),var(--lime)); border-radius:6px;}
.bar-fill.hot{background:linear-gradient(90deg,#e8923a,var(--gold)); box-shadow:0 0 12px rgba(185,131,27,.3);}
.bar-val{font-family:'Space Mono',monospace; font-size:var(--small-size); text-align:right;}
.bar-val span{color:var(--muted);}
.tag{display:inline-block; font-family:'Space Mono',monospace; font-size:.6em; letter-spacing:.05em; padding:1px 8px; border-radius:100px; margin-left:.6em; vertical-align:middle; text-transform:uppercase;}
.tag.gold{background:rgba(185,131,27,.12); color:var(--gold); border:1px solid rgba(185,131,27,.4);}
.grp-block{transition:opacity .7s, transform .7s;}
.grp-teams{display:flex; flex-wrap:wrap; gap:clamp(.3rem,.8vw,.5rem); margin:.4rem 0 .2rem;
  padding-left:clamp(120px,22vw,210px);}
.grp-team{display:inline-flex; align-items:baseline; gap:.4em; background:var(--panel); border:1px solid var(--line);
  border-radius:100px; padding:2px clamp(.5rem,1.2vw,.8rem); font-size:clamp(.7rem,1.3vw,.88rem); white-space:nowrap;}
.grp-team em{font-style:normal; font-family:'Space Mono',monospace; font-size:.78em; color:var(--muted);}
@media (max-width:640px){ .grp-teams{padding-left:0;} }

/* ===== CINDERELLA ===== */
.cin{display:flex; flex-direction:column; gap:clamp(.4rem,1.2vh,.8rem); max-width:920px;}
.cin-row{display:grid; grid-template-columns:1fr auto auto auto; gap:clamp(.8rem,2.5vw,2rem); align-items:center;
  background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:clamp(.6rem,1.5vw,1rem) clamp(.9rem,2vw,1.4rem);
  font-size:clamp(.85rem,1.6vw,1.05rem); transition:opacity .7s, transform .7s;}
.cin-team em{font-style:normal; font-family:'Space Mono',monospace; font-size:.75em; color:var(--muted); margin-left:.5em;}
.cin-pts b{color:var(--teal-med); font-family:'Anton',sans-serif; font-size:1.3em;}
.cin-gd,.cin-far{font-family:'Space Mono',monospace; font-size:var(--small-size); color:var(--muted);}

/* ===== RAW-DATA FILTER CHIP ===== */
.raw-filter[hidden]{display:none;}
.raw-filter{display:inline-flex; align-items:center; gap:.5em; margin-top:clamp(.4rem,1.2vh,.8rem); font-family:'Space Mono',monospace; font-size:var(--small-size); text-transform:uppercase; letter-spacing:.08em; color:var(--muted); background:var(--panel2); border:1px solid var(--line); border-radius:100px; padding:.25rem .85rem;}
.raw-filter b{color:var(--teal-med);}
.raw-filter button{cursor:pointer; font:inherit; text-transform:uppercase; letter-spacing:.05em; color:var(--red); background:none; border:none; padding:0 0 0 .3em;}
.raw-filter button:hover{text-decoration:underline;}

/* ===== LEDGER ===== */
.ledger-scroll{overflow-y:auto; max-height:72vh; border:1px solid var(--line); border-radius:12px;}
.ledger-scroll::-webkit-scrollbar{width:10px;} .ledger-scroll::-webkit-scrollbar-thumb{background:var(--line); border-radius:8px;}
table{width:100%; border-collapse:collapse; font-size:clamp(.72rem,1.3vw,.92rem); background:var(--panel);}
th,td{padding:.5rem .7rem; text-align:left; border-bottom:1px solid var(--line); white-space:nowrap;}
thead th{position:sticky; top:0; background:var(--panel2); color:var(--muted); font-family:'Space Mono',monospace; font-weight:400; text-transform:uppercase; letter-spacing:.05em; font-size:.85em; cursor:pointer; user-select:none;}
thead th:hover{color:var(--teal-med);}
th.num,td.num{text-align:right; font-variant-numeric:tabular-nums; font-family:'Space Mono',monospace;}
tbody tr:hover{background:var(--panel2);}
tbody tr:last-child td{border-bottom:none;}

/* ===== METHOD ===== */
.method-scroll{overflow-y:auto; max-height:74vh; max-width:1000px; padding-right:clamp(.4rem,1.5vw,1rem);}
.method-scroll::-webkit-scrollbar{width:10px;} .method-scroll::-webkit-scrollbar-thumb{background:var(--line); border-radius:8px;}
.method-h{font-family:'Space Mono',monospace; text-transform:uppercase; letter-spacing:.18em; font-size:var(--small-size); color:var(--muted); margin:clamp(1rem,2.4vh,1.6rem) 0 .6rem; border-bottom:1px solid var(--line); padding-bottom:.4rem;}
.method-h:first-child{margin-top:0;}
.method-grid{display:grid; grid-template-columns:1fr 1fr; gap:clamp(1.2rem,4vw,3rem); max-width:1000px;}
.method-grid p{color:var(--muted); margin:.4rem 0 0;}
.method-grid h3:first-child{margin-top:0;}
.method-grid h3{margin-top:0;}
.method-build{color:var(--muted); margin:.9rem 0 0;}
.defs{display:grid; grid-template-columns:1fr 1fr; gap:clamp(.6rem,1.8vw,1.3rem) clamp(1.2rem,4vw,3rem); margin:.2rem 0 0;}
.defs dt{font-family:'Anton',sans-serif; text-transform:uppercase; letter-spacing:.02em; font-size:var(--h3-size); color:var(--teal-med);}
.defs dd{margin:.15rem 0 0; color:var(--muted);}
.defs dd em{font-style:normal; color:var(--ink); font-weight:600;}
@media (max-width:760px){ .defs{grid-template-columns:1fr;} }
.eff{margin:.4rem 0 0; padding-left:1.1rem; color:var(--ink);} .eff li{margin:.2rem 0;}
.warn{background:rgba(185,131,27,.08); border:1px solid rgba(185,131,27,.35); border-radius:12px; padding:.7rem 1.1rem; margin-top:clamp(.8rem,2vh,1.4rem);}
.warn ul{margin:.4rem 0 0; padding-left:1.1rem;}
.end{margin-top:clamp(1rem,3vh,2rem); font-family:'Space Mono',monospace; font-size:var(--small-size); letter-spacing:.1em; color:var(--muted);}

/* ===== NAV DOTS ===== */
.navdots{position:fixed; right:clamp(10px,2vw,26px); top:50%; transform:translateY(-50%); display:flex; flex-direction:column; gap:12px; z-index:50;}
.navdot{width:11px; height:11px; border-radius:50%; border:1.5px solid var(--muted); position:relative; transition:all .3s; display:block;}
.navdot:hover{border-color:var(--lime);}
.navdot.on{background:var(--teal-med); border-color:var(--teal-med); box-shadow:0 0 10px rgba(8,102,100,.5);}
.navdot span{position:absolute; right:22px; top:50%; transform:translateY(-50%); white-space:nowrap; font-family:'Space Mono',monospace; font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--ink); background:var(--panel); border:1px solid var(--line); padding:3px 9px; border-radius:100px; opacity:0; pointer-events:none; transition:opacity .25s;}
.navdot:hover span{opacity:1;}
@media (max-width:760px){ .navdots{right:8px; gap:9px;} .navdot{width:9px;height:9px;} }
</style>
</head>
<body>
<nav class="navdots">${dots}</nav>
${order.join('\n')}
<script>
(function(){
  var slides = document.querySelectorAll('.slide');
  var dots = document.querySelectorAll('.navdot');

  function runCounters(scope){
    var els = scope.querySelectorAll('.count:not(.done)');
    els.forEach(function(el){
      el.classList.add('done');
      var to = parseFloat(el.getAttribute('data-to')) || 0;
      var dec = parseInt(el.getAttribute('data-dec') || '0', 10);
      var suf = el.getAttribute('data-suffix') || '';
      var start = null, dur = 1100;
      function step(ts){
        if (start === null) start = ts;
        var p = Math.min(1, (ts - start) / dur);
        var eased = 1 - Math.pow(1 - p, 3);
        el.textContent = (to * eased).toFixed(dec) + suf;
        if (p < 1) requestAnimationFrame(step); else el.textContent = to.toFixed(dec) + suf;
      }
      requestAnimationFrame(step);
    });
  }
  function setActiveDot(slide){
    var href = '#' + slide.id;
    dots.forEach(function(d){ d.classList.toggle('on', d.getAttribute('href') === href); });
  }

  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if (e.isIntersecting){ e.target.classList.add('visible'); runCounters(e.target); setActiveDot(e.target); }
    });
  }, { threshold: 0.45 });
  slides.forEach(function(s){ io.observe(s); });
  // hero is visible immediately
  if (slides[0]) { slides[0].classList.add('visible'); runCounters(slides[0]); }

  function go(dir){
    var arr = Array.prototype.slice.call(slides);
    var cur = 0;
    for (var i = 0; i < arr.length; i++){
      var r = arr[i].getBoundingClientRect();
      if (r.top <= window.innerHeight * 0.5) cur = i;
    }
    var next = Math.max(0, Math.min(arr.length - 1, cur + dir));
    arr[next].scrollIntoView({ behavior: 'smooth' });
  }
  document.addEventListener('keydown', function(e){
    if (['ArrowDown','PageDown',' '].indexOf(e.key) >= 0){ e.preventDefault(); go(1); }
    else if (['ArrowUp','PageUp'].indexOf(e.key) >= 0){ e.preventDefault(); go(-1); }
  });

  // One wheel gesture = one full page, like clicking the next nav dot. The lock
  // swallows trackpad momentum so a single flick never skips past a slide.
  var wheelLock = false;
  window.addEventListener('wheel', function(e){
    // Let scrollable regions (ledger / raw-data tables) scroll internally first.
    var sc = e.target.closest && e.target.closest('.ledger-scroll, .method-scroll');
    if (sc){
      var atTop = sc.scrollTop <= 0;
      var atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1;
      if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom)) return;
    }
    e.preventDefault();
    if (wheelLock || Math.abs(e.deltaY) < 4) return;
    wheelLock = true;
    go(e.deltaY > 0 ? 1 : -1);
    setTimeout(function(){ wheelLock = false; }, 750);
  }, { passive:false });

  // Click-to-sort for the ledger and raw-data tables.
  function val(td, type){ var d = td.getAttribute('data-sort'); if (d !== null) return type === 'num' ? parseFloat(d) : d.toLowerCase(); return type === 'num' ? parseFloat(td.textContent.replace(/[^0-9.\\-]/g,'')) || 0 : td.textContent.trim().toLowerCase(); }
  function makeSortable(t){
    if (!t) return;
    var ths = t.tHead.rows[0].cells, st = {};
    for (var i = 0; i < ths.length; i++){ (function(idx){
      ths[idx].addEventListener('click', function(){
        var type = ths[idx].getAttribute('data-t') || 'text', body = t.tBodies[0], rows = [].slice.call(body.rows);
        st[idx] = !st[idx]; var s = st[idx] ? 1 : -1;
        rows.sort(function(a,b){ var x = val(a.cells[idx],type), y = val(b.cells[idx],type); return x < y ? -s : x > y ? s : 0; });
        rows.forEach(function(r){ body.appendChild(r); });
      });
    })(i); }
  }
  makeSortable(document.getElementById('money'));
  makeSortable(document.getElementById('raw'));

  // Click any team name -> filter the Raw Data table to that team's matches.
  var rawTable = document.getElementById('raw');
  var rawFilter = document.getElementById('rawFilter');
  var rawFilterName = document.getElementById('rawFilterName');
  var rawScroll = rawTable ? rawTable.closest('.ledger-scroll') : null;
  function applyRawFilter(team){
    if (!rawTable) return;
    var rows = rawTable.tBodies[0].rows;
    for (var i = 0; i < rows.length; i++){
      var r = rows[i];
      var show = !team || r.getAttribute('data-home') === team || r.getAttribute('data-away') === team;
      r.style.display = show ? '' : 'none';
    }
    if (rawFilter){ rawFilter.hidden = !team; }
    if (team && rawFilterName){ rawFilterName.textContent = team; }
    if (rawScroll){ rawScroll.scrollTop = 0; }
  }
  document.addEventListener('click', function(e){
    if (e.target.closest('#rawFilterClear')){ applyRawFilter(null); return; }
    var el = e.target.closest('[data-team]');
    if (!el) return;
    applyRawFilter(el.getAttribute('data-team'));
    var slide = document.getElementById('s8');
    if (slide) slide.scrollIntoView({ behavior: 'smooth' });
  });
})();
</script>
</body>
</html>`;
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
  const teams = parseTeams();
  const { rows, draw, unmapped, daysFailed } = await fetchWorldCup([...teams.keys()]);
  if (draw.size === 0)
    fail(`No World Cup data from ESPN (all ${daysFailed} day requests failed). Refusing to build an empty report.`);
  const { groups, teamGroup } = buildGroups(teams, draw);
  const { matches, warnings } = buildMatches(teams, teamGroup, rows);
  const data = computeMetrics(teams, teamGroup, groups, matches);
  const builtAt = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short',
  }) + ' EST';
  const html = renderHTML(data, { teamCount: teams.size, matchCount: matches.length, warnings, builtAt });
  fs.writeFileSync(file('index.html'), html);

  console.log('World Cup Underdog Report');
  console.log('  teams:    ' + teams.size);
  console.log('  groups:   ' + groups.length);
  console.log('  matches:  ' + matches.length + ' (finished)');
  console.log('  upsets:   ' + data.upsets.length);
  if (warnings.length) console.log('  warnings: ' + warnings.length + ' (shown in report)');
  reportUnmapped(unmapped);
  console.log('  wrote:    ' + path.relative(process.cwd(), file('index.html')));
}

main().catch((e) => fail(e.message));
