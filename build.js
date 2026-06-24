#!/usr/bin/env node
'use strict';

/*
 * World Cup Underdog Report generator.
 * Reads teams.txt, groups.txt, matches.txt and writes a single self-contained index.html.
 * Zero dependencies. Run with:  node build.js
 */

const fs = require('fs');
const path = require('path');

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

function parseGroups(teams) {
  const groups = [];
  const teamGroup = new Map();
  for (const { n, text } of readLines('groups.txt')) {
    const m = text.match(/^([^:]+):\s*(.+)$/);
    if (!m) fail(`groups.txt line ${n}: expected "Label: a, b, c, d" — got "${text}"`);
    const label = m[1].trim();
    const members = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    for (const mem of members) {
      if (!teams.has(mem)) fail(`groups.txt line ${n}: unknown team "${mem}" (not in teams.txt)`);
      teamGroup.set(mem, label);
    }
    groups.push({ label, members });
  }
  return { groups, teamGroup };
}

const KO_ORDER = ['R32', 'R16', 'QF', 'SF', '3P', 'Final'];
const KO_SIZE = { R32: 16, R16: 8, QF: 4, SF: 2, '3P': 1, Final: 1 };
const STAGE_TOKENS = ['Group', ...KO_ORDER];
const KO_DEPTH = { Group: 0, R32: 1, R16: 2, QF: 3, '3P': 3, SF: 4, Final: 5 };
const KO_NAME = { R32: 'Round of 32', R16: 'Round of 16', QF: 'Quarter-final', SF: 'Semi-final', '3P': 'Third place', Final: 'Final' };

function parseMatches(teams, teamGroup) {
  const matches = [];
  const inferred = []; // knockout matches awaiting round assignment, in file order
  for (const { n, text } of readLines('matches.txt')) {
    let parts = text.split(',').map((s) => s.trim());
    let stage = null;
    if (STAGE_TOKENS.includes(parts[0])) { stage = parts[0]; parts = parts.slice(1); }
    if (parts.length < 4) fail(`matches.txt line ${n}: expected "Home,HS,Away,AS" — got "${text}"`);
    const [home, hsRaw, away, asRaw, advance] = parts;
    const hs = Number(hsRaw), as = Number(asRaw);
    if (!teams.has(home)) fail(`matches.txt line ${n}: unknown team "${home}"`);
    if (!teams.has(away)) fail(`matches.txt line ${n}: unknown team "${away}"`);
    if (!Number.isInteger(hs) || !Number.isInteger(as) || hs < 0 || as < 0)
      fail(`matches.txt line ${n}: bad score in "${text}"`);
    if (advance && !teams.has(advance)) fail(`matches.txt line ${n}: unknown advancing team "${advance}"`);

    const m = { n, home, away, hs, as, advance: advance || null, stage, group: null };
    if (stage === 'Group' || stage === null) {
      const gh = teamGroup.get(home), ga = teamGroup.get(away);
      if (stage === 'Group') {
        m.group = gh || null;
      } else if (gh && ga && gh === ga) {
        m.stage = 'Group'; m.group = gh;
      } else {
        inferred.push(m); // resolve round below
      }
    }
    matches.push(m);
  }

  // Bucket inferred knockout matches into bracket slots by file order.
  const slots = [];
  for (const r of KO_ORDER) for (let i = 0; i < KO_SIZE[r]; i++) slots.push(r);
  inferred.forEach((m, i) => { m.stage = slots[i] || 'Final'; });

  const warnings = [];
  for (const m of matches) {
    if (m.stage !== 'Group' && m.hs === m.as && !m.advance)
      warnings.push(`Tied knockout match (matches.txt line ${m.n}: ${m.home} ${m.hs}-${m.as} ${m.away}) has no advancing team — add a 5th field.`);
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
    if (hv === av) continue;
    const favHome = hv > av;
    const favorite = favHome ? m.home : m.away;
    const underdog = favHome ? m.away : m.home;
    const favVal = Math.max(hv, av), undVal = Math.min(hv, av);
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

  return { stats, played, reg, upsets, eff, groupInfo, efficiency, cinderellas, advanced };
}

// ----------------------------------------------------------------------------
// SVG scatter chart (value vs points + regression line)
// ----------------------------------------------------------------------------

function scatterSVG(played, reg) {
  if (played.length < 2) return '<p class="empty">Not enough played matches yet for the value-vs-points chart.</p>';
  const W = 820, H = 470, P = { l: 52, r: 24, t: 24, b: 52 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const xs = played.map((s) => Math.log10(s.value));
  const xmin = Math.min(...xs) - 0.05, xmax = Math.max(...xs) + 0.05;
  const ymax = Math.max(3, ...played.map((s) => s.pts)) + 1;
  const X = (v) => P.l + ((Math.log10(v) - xmin) / (xmax - xmin)) * iw;
  const Y = (p) => P.t + ih - (p / ymax) * ih;

  const parts = [`<svg viewBox="0 0 ${W} ${H}" class="scatter" role="img" aria-label="Market value versus points">`];
  // y gridlines + labels
  for (let p = 0; p <= ymax; p += 3) {
    const y = Y(p);
    parts.push(`<line x1="${P.l}" y1="${y.toFixed(1)}" x2="${W - P.r}" y2="${y.toFixed(1)}" class="grid"/>`);
    parts.push(`<text x="${P.l - 8}" y="${(y + 4).toFixed(1)}" class="axlbl" text-anchor="end">${p}</text>`);
  }
  // x ticks at nice value marks
  const ticks = [20e6, 50e6, 100e6, 250e6, 500e6, 1e9, 1.5e9].filter((v) => Math.log10(v) >= xmin && Math.log10(v) <= xmax);
  for (const v of ticks) {
    const x = X(v);
    parts.push(`<line x1="${x.toFixed(1)}" y1="${P.t}" x2="${x.toFixed(1)}" y2="${P.t + ih}" class="grid"/>`);
    parts.push(`<text x="${x.toFixed(1)}" y="${P.t + ih + 18}" class="axlbl" text-anchor="middle">${fmtEuro(v)}</text>`);
  }
  // regression line
  if (reg) {
    const y1 = reg.slope * xmin + reg.intercept, y2 = reg.slope * xmax + reg.intercept;
    const cy1 = P.t + ih - (Math.max(0, Math.min(ymax, y1)) / ymax) * ih;
    const cy2 = P.t + ih - (Math.max(0, Math.min(ymax, y2)) / ymax) * ih;
    parts.push(`<line x1="${P.l}" y1="${cy1.toFixed(1)}" x2="${(W - P.r).toFixed(1)}" y2="${cy2.toFixed(1)}" class="regline"/>`);
  }
  // axis titles
  parts.push(`<text x="${P.l + iw / 2}" y="${H - 8}" class="axtitle" text-anchor="middle">Squad market value (log scale) →</text>`);
  parts.push(`<text x="16" y="${P.t + ih / 2}" class="axtitle" text-anchor="middle" transform="rotate(-90 16 ${P.t + ih / 2})">Points →</text>`);

  // dots; label the biggest residuals
  const byRes = played.slice().filter((s) => s.residual != null).sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual));
  const labelSet = new Set(byRes.slice(0, 7).map((s) => s.name));
  for (const s of played) {
    const x = X(s.value), y = Y(s.pts);
    const over = s.residual != null && s.residual > 0.3;
    const under = s.residual != null && s.residual < -0.3;
    const cls = over ? 'dot over' : under ? 'dot under' : 'dot';
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" class="${cls}"><title>${esc(s.name)} — ${fmtEuro(s.value)}, ${s.pts} pts (${s.residual >= 0 ? '+' : ''}${s.residual.toFixed(1)} vs expected)</title></circle>`);
    if (labelSet.has(s.name))
      parts.push(`<text x="${(x + 7).toFixed(1)}" y="${(y - 6).toFixed(1)}" class="dotlbl">${esc(s.name)}</text>`);
  }
  parts.push('</svg>');
  return parts.join('');
}

// ----------------------------------------------------------------------------
// HTML rendering
// ----------------------------------------------------------------------------

function pct(n, d) { return d ? Math.round((n / d) * 100) : 0; }

function card(label, big, sub) {
  return `<div class="card"><div class="card-label">${label}</div><div class="card-big">${big}</div><div class="card-sub">${sub}</div></div>`;
}

function renderHTML(data, meta) {
  const { stats, played, reg, upsets, eff, groupInfo, efficiency, cinderellas } = data;
  const allTeams = [...stats.values()];

  // ---- Headline cards ----
  const topUpset = upsets[0];
  const overs = played.filter((s) => s.residual != null).sort((a, b) => b.residual - a.residual);
  const bestVal = efficiency[0];
  const deepest = played.slice().sort((a, b) => b.deepest - a.deepest || b.valueRank - a.valueRank)
    .filter((s) => s.deepest > 0);
  const flop = overs.length ? overs[overs.length - 1] : null;

  const cards = [
    card('Biggest single upset',
      topUpset ? `${esc(topUpset.underdog)}` : '—',
      topUpset ? `${topUpset.kind === 'draw' ? 'held' : 'beat'} ${esc(topUpset.favorite)} · ${topUpset.ratio.toFixed(1)}× dearer` : 'no upsets yet'),
    card('Best overachiever',
      overs.length ? esc(overs[0].name) : '—',
      overs.length ? `+${overs[0].residual.toFixed(1)} pts vs value-expected` : '—'),
    card('Biggest flop',
      flop ? esc(flop.name) : '—',
      flop ? `${flop.residual.toFixed(1)} pts vs value-expected` : '—'),
    card('Best value for money',
      bestVal ? esc(bestVal.name) : '—',
      bestVal ? `${fmtEuro(bestVal.value)} → ${bestVal.pts} pts` : '—'),
    card('Deepest underdog run',
      deepest.length ? esc(deepest.sort((a, b) => b.deepest - a.deepest || b.valueRank - a.valueRank)[0].name) : '—',
      deepest.length ? `${KO_NAME[deepest[0].deepestStage] || deepest[0].deepestStage} (value #${deepest[0].valueRank})` : 'knockouts not played'),
    card('Money buys wins?',
      eff.overall.dec ? `${pct(eff.overall.fav, eff.overall.dec)}%` : '—',
      eff.overall.dec ? `pricier side won ${eff.overall.fav}/${eff.overall.dec} decisive games` : '—'),
  ].join('');

  // ---- Money table vs real table ----
  const moneyRows = allTeams.slice().sort((a, b) => a.pointsRank - b.pointsRank).map((s) => {
    const delta = s.valueRank - s.pointsRank; // +ve = outperforming its price
    const dCls = delta > 0 ? 'pos' : delta < 0 ? 'neg' : '';
    const resid = s.residual == null ? '' : (s.residual >= 0 ? '+' : '') + s.residual.toFixed(1);
    const rCls = s.residual == null ? '' : s.residual > 0.3 ? 'pos' : s.residual < -0.3 ? 'neg' : '';
    return `<tr>
      <td>${esc(s.name)}</td>
      <td class="num" data-sort="${s.value}">${fmtEuro(s.value)}</td>
      <td class="num" data-sort="${s.valueRank}">${s.valueRank}</td>
      <td class="num" data-sort="${s.pointsRank}">${s.pointsRank}</td>
      <td class="num">${s.played ? s.pts : '—'}</td>
      <td class="num ${dCls}" data-sort="${delta}">${delta > 0 ? '+' : ''}${delta}</td>
      <td class="num ${rCls}" data-sort="${s.residual == null ? -999 : s.residual}">${resid || '—'}</td>
    </tr>`;
  }).join('');

  // ---- Upset leaderboard ----
  const upsetRows = upsets.length ? upsets.map((u, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td><b>${esc(u.underdog)}</b> <span class="muted">${fmtEuro(u.undVal)}</span></td>
      <td>${u.kind === 'draw' ? 'drew' : 'beat'}</td>
      <td>${esc(u.favorite)} <span class="muted">${fmtEuro(u.favVal)}</span></td>
      <td class="num">${u.home === u.underdog ? `${u.hs}-${u.as}` : `${u.as}-${u.hs}`}</td>
      <td>${u.stage === 'Group' ? 'Group' : (KO_NAME[u.stage] || u.stage)}</td>
      <td class="num ratio">${u.ratio.toFixed(1)}×</td>
    </tr>`).join('')
    : '<tr><td colspan="7" class="empty">No upsets yet — every result has gone to the pricier squad (or to equals).</td></tr>';

  // ---- Efficiency bars ----
  const maxPerPt = efficiency.length ? efficiency[efficiency.length - 1].perPt : 1;
  const effBars = efficiency.length ? efficiency.map((e) => {
    const w = Math.max(2, (e.perPt / maxPerPt) * 100);
    return `<div class="bar-row">
      <div class="bar-name">${esc(e.name)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${w.toFixed(1)}%"></div></div>
      <div class="bar-val">€${e.perPt.toFixed(1)}M/pt <span class="muted">(${e.pts} pts)</span></div>
    </div>`;
  }).join('') : '<p class="empty">No points scored yet.</p>';

  // ---- Group analysis ----
  const groupCards = groupInfo.map((g, i) => {
    const rows = g.members.map((t) => `<tr>
      <td>${esc(t.name)}</td>
      <td class="num">${fmtEuro(t.value)}</td>
      <td class="num">${t.played ? t.pts : '—'}</td>
    </tr>`).join('');
    const death = i === 0 ? ' <span class="tag death">Group of Death</span>' : '';
    const ch = g.anyKO
      ? (g.cheapestAdvanced ? `<span class="tag pos">cheapest (${esc(g.cheapest)}) advanced</span>` : `<span class="tag">cheapest (${esc(g.cheapest)}) went home</span>`)
      : '';
    return `<div class="group">
      <div class="group-head">Group ${esc(g.label)}${death}<span class="muted"> · ${fmtEuro(g.total)} total · ${g.lopsided.toFixed(1)}× spread</span></div>
      ${ch ? `<div class="group-note">${ch}</div>` : ''}
      <table class="mini"><thead><tr><th>Team</th><th class="num">Value</th><th class="num">Pts</th></tr></thead><tbody>${rows}</tbody></table>
    </div>`;
  }).join('');

  // ---- Market efficiency by stage ----
  const effStage = ['Group', 'Knockout'].filter((k) => eff[k]).map((k) =>
    `<li><b>${k}:</b> pricier side won ${eff[k].fav}/${eff[k].dec} decisive games (${pct(eff[k].fav, eff[k].dec)}%)${eff[k].draws ? `, ${eff[k].draws} draw${eff[k].draws > 1 ? 's' : ''}` : ''}</li>`
  ).join('');

  // ---- Cinderella ----
  const cinRows = cinderellas.length ? cinderellas.map((s) => `<tr>
      <td>${esc(s.name)} <span class="muted">#${s.valueRank} by value</span></td>
      <td class="num">${fmtEuro(s.value)}</td>
      <td class="num">${s.pts}</td>
      <td class="num">${s.gd >= 0 ? '+' : ''}${s.gd}</td>
      <td>${s.deepest > 0 ? (KO_NAME[s.deepestStage] || s.deepestStage) : 'Group'}</td>
    </tr>`).join('')
    : '<tr><td colspan="5" class="empty">No bottom-quartile team has played yet.</td></tr>';

  const warnHtml = meta.warnings.length
    ? `<div class="warn"><b>Data notes:</b><ul>${meta.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '';

  const regNote = reg
    ? `Expected points = ${reg.slope.toFixed(2)}·log₁₀(value) ${reg.intercept >= 0 ? '+' : '−'} ${Math.abs(reg.intercept).toFixed(2)}, fit across the ${played.length} teams that have played.`
    : 'Not enough matches yet to fit the value→points line.';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>World Cup Underdog Report</title>
<style>
  :root{
    --bg:#0e1117; --panel:#161b22; --panel2:#1c232d; --line:#2a323d; --ink:#e6edf3;
    --muted:#8b949e; --accent:#5db0ff; --pos:#3fb950; --neg:#f85149; --gold:#e3b341;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
  .wrap{max-width:1080px;margin:0 auto;padding:32px 20px 80px}
  header h1{font-size:30px;margin:0 0 4px}
  header p{color:var(--muted);margin:0}
  h2{font-size:20px;margin:44px 0 6px;padding-top:10px;border-top:1px solid var(--line)}
  .lede{color:var(--muted);margin:0 0 16px;max-width:70ch}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:12px;margin:22px 0}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
  .card-label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  .card-big{font-size:20px;font-weight:700;margin:6px 0 2px}
  .card-sub{color:var(--muted);font-size:13px}
  table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);
    border-radius:10px;overflow:hidden;font-size:14px}
  th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
  thead th{background:var(--panel2);color:var(--muted);font-weight:600;cursor:pointer;user-select:none}
  thead th.num,td.num{text-align:right}
  tbody tr:last-child td{border-bottom:none}
  tbody tr:hover{background:#1b2330}
  .num{font-variant-numeric:tabular-nums}
  .pos{color:var(--pos)} .neg{color:var(--neg)} .muted{color:var(--muted)} .ratio{color:var(--gold);font-weight:700}
  .scroll{overflow-x:auto}
  .scatter{width:100%;height:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px}
  .grid{stroke:#222c38;stroke-width:1}
  .axlbl{fill:var(--muted);font-size:11px} .axtitle{fill:var(--muted);font-size:12px}
  .dotlbl{fill:var(--ink);font-size:11px}
  .regline{stroke:var(--accent);stroke-width:2;stroke-dasharray:6 4;opacity:.8}
  .dot{fill:#6e7681} .dot.over{fill:var(--pos)} .dot.under{fill:var(--neg)}
  .legend{display:flex;gap:18px;flex-wrap:wrap;color:var(--muted);font-size:13px;margin:10px 2px}
  .legend span::before{content:"";display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}
  .legend .l-over::before{background:var(--pos)} .legend .l-under::before{background:var(--neg)} .legend .l-line::before{background:var(--accent);border-radius:0;height:3px;width:16px}
  .bars{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
  .bar-row{display:grid;grid-template-columns:150px 1fr 150px;align-items:center;gap:10px;padding:3px 0}
  .bar-name{font-size:13px;overflow:hidden;text-overflow:ellipsis}
  .bar-track{background:var(--panel2);border-radius:5px;height:14px;overflow:hidden}
  .bar-fill{background:linear-gradient(90deg,var(--pos),var(--gold));height:100%}
  .bar-val{font-size:12px;color:var(--ink);text-align:right;font-variant-numeric:tabular-nums}
  .groups{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
  .group{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px}
  .group-head{font-weight:700;margin-bottom:6px;font-size:15px}
  .group-note{margin-bottom:6px}
  table.mini{border:none;background:transparent}
  table.mini th,table.mini td{padding:4px 6px;border-bottom:1px solid var(--line)}
  .tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;background:var(--panel2);color:var(--muted);border:1px solid var(--line)}
  .tag.pos{color:var(--pos);border-color:rgba(63,185,80,.4)} .tag.death{color:var(--neg);border-color:rgba(248,81,73,.4)}
  .empty{color:var(--muted);text-align:center;padding:14px}
  .warn{background:rgba(227,179,65,.08);border:1px solid rgba(227,179,65,.4);border-radius:10px;padding:10px 14px;margin:18px 0}
  .warn ul{margin:6px 0 0;padding-left:18px} .warn li{color:var(--ink)}
  footer{margin-top:50px;color:var(--muted);font-size:13px;border-top:1px solid var(--line);padding-top:14px}
  ul.eff{color:var(--ink);line-height:1.8}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>⚽ World Cup Underdog Report</h1>
    <p>Where the money says one thing and the pitch says another. ${meta.teamCount} teams · ${meta.matchCount} matches played.</p>
  </header>

  ${warnHtml}

  <div class="cards">${cards}</div>

  <h2>Money table vs. real table</h2>
  <p class="lede">Every team's rank by squad value beside its rank by points earned. <span class="pos">Δ&nbsp;positive</span> = punching above its price; <span class="neg">negative</span> = underdelivering. "vs exp" is points above/below what value predicts. Click a header to sort.</p>
  <div class="scroll"><table id="money"><thead><tr>
    <th data-t="text">Team</th><th class="num" data-t="num">Value</th><th class="num" data-t="num">Value rank</th>
    <th class="num" data-t="num">Pts rank</th><th class="num" data-t="num">Pts</th><th class="num" data-t="num">Δ rank</th><th class="num" data-t="num">vs exp</th>
  </tr></thead><tbody>${moneyRows}</tbody></table></div>

  <h2>Upset leaderboard</h2>
  <p class="lede">Every match a cheaper squad won or drew, scored by how many times dearer the favourite was. A draw counts at half weight.</p>
  <div class="scroll"><table><thead><tr>
    <th class="num">#</th><th>Underdog</th><th></th><th>Favourite</th><th class="num">Score</th><th>Stage</th><th class="num">Value gap</th>
  </tr></thead><tbody>${upsetRows}</tbody></table></div>

  <h2>Value vs. points</h2>
  <p class="lede">${regNote} Teams <span class="pos">above the line</span> overperform their price tag (the underdogs); those <span class="neg">below</span> underperform. Hover any dot for detail.</p>
  ${scatterSVG(played, reg)}
  <div class="legend"><span class="l-over">overperforming value</span><span class="l-under">underperforming value</span><span class="l-line">value-expected points</span></div>

  <h2>Value for money</h2>
  <p class="lede">Squad cost per point earned — shortest bar is the thriftiest return, longest is the most expensive.</p>
  <div class="bars">${effBars}</div>

  <h2>Does money buy wins?</h2>
  <ul class="eff">${effStage || '<li class="muted">No decisive matches yet.</li>'}</ul>

  <h2>Group analysis</h2>
  <p class="lede">Groups ordered by combined squad value (richest = "Group of Death"). Spread = dearest squad ÷ cheapest in the group.</p>
  <div class="groups">${groupCards}</div>

  <h2>Cinderella watch</h2>
  <p class="lede">The bottom quarter by market value, ranked by what they've actually banked.</p>
  <div class="scroll"><table><thead><tr>
    <th>Team</th><th class="num">Value</th><th class="num">Pts</th><th class="num">GD</th><th>Furthest</th>
  </tr></thead><tbody>${cinRows}</tbody></table></div>

  <footer>
    Underdog = lower squad market value. Generated by <code>build.js</code> from <code>teams.txt</code>, <code>groups.txt</code> and <code>matches.txt</code>.
    Re-run <code>node build.js</code> after updating results. Self-contained file — no network needed.
  </footer>
</div>
<script>
// Click-to-sort for the money table.
(function(){
  var t=document.getElementById('money'); if(!t) return;
  var ths=t.tHead.rows[0].cells, dir={};
  function val(td,type){ var d=td.getAttribute('data-sort'); if(d!==null) return type==='num'?parseFloat(d):d; return type==='num'?parseFloat(td.textContent.replace(/[^0-9.\\-]/g,''))||0:td.textContent.trim().toLowerCase(); }
  for(var i=0;i<ths.length;i++)(function(idx){
    ths[idx].addEventListener('click',function(){
      var type=ths[idx].getAttribute('data-t')||'text', body=t.tBodies[0], rows=[].slice.call(body.rows);
      dir[idx]=!dir[idx]; var s=dir[idx]?1:-1;
      rows.sort(function(a,b){var x=val(a.cells[idx],type),y=val(b.cells[idx],type);return x<y?-s:x>y?s:0;});
      rows.forEach(function(r){body.appendChild(r);});
    });
  })(i);
})();
</script>
</body>
</html>`;
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

function main() {
  const teams = parseTeams();
  const { groups, teamGroup } = parseGroups(teams);
  const { matches, warnings } = parseMatches(teams, teamGroup);
  const data = computeMetrics(teams, teamGroup, groups, matches);
  const html = renderHTML(data, { teamCount: teams.size, matchCount: matches.length, warnings });
  fs.writeFileSync(file('index.html'), html);

  console.log('World Cup Underdog Report');
  console.log('  teams:    ' + teams.size);
  console.log('  groups:   ' + groups.length);
  console.log('  matches:  ' + matches.length);
  console.log('  upsets:   ' + data.upsets.length);
  if (warnings.length) console.log('  warnings: ' + warnings.length + ' (shown in report)');
  console.log('  wrote:    ' + path.relative(process.cwd(), file('index.html')));
}

main();
