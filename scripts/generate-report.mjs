#!/usr/bin/env node
// Reads every session's JSONL under a run's outDir (works for both the
// Playwright engine and LLM-agent-mode session logs, since both write the
// same event schema — see references/config-schema.md) and produces a
// self-contained HTML comparison report across variants.
//
// Usage: node generate-report.mjs <outDir> [--title "My Test"] [--out report.html]

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

function parseArgs(argv) {
  const args = { outDir: argv[2], title: "Synthetic Usability Test", out: null };
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === "--title") args.title = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
  }
  args.out = args.out || join(args.outDir, "report.html");
  return args;
}

function walkVariantDirs(root) {
  return readdirSync(root).filter((e) => statSync(join(root, e)).isDirectory());
}

function loadSessions(variantDir) {
  const files = readdirSync(variantDir).filter((f) => f.endsWith(".jsonl"));
  return files.map((f) => {
    const events = readFileSync(join(variantDir, f), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    return summarizeSession(events);
  });
}

function summarizeSession(events) {
  const last = events[events.length - 1];
  const end = events.find((e) => e.event === "session_end");
  const outcome =
    end?.meta?.outcome ||
    (events.find((e) => e.event === "task_completed") && "success") ||
    (events.find((e) => e.event === "task_failed") && "failed") ||
    (events.find((e) => e.event === "auth_wall_detected") && "blocked") ||
    "abandoned";
  return {
    sessionId: last?.sessionId,
    personaArchetype: last?.personaArchetype,
    outcome,
    steps: Math.max(0, ...events.map((e) => e.step || 0)),
    durationMs: Math.max(0, ...events.map((e) => e.tMs || 0)),
    clicks: events.filter((e) => e.event === "click").length,
    types: events.filter((e) => e.event === "type").length,
    errors: events.filter((e) => e.event === "error").length,
    rageClicks: events.filter((e) => e.event === "rage_click").length,
    backtrackLoops: events.filter((e) => e.event === "backtrack_loop").length,
  };
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const mean = (nums) => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0);

function aggregate(sessions) {
  const n = sessions.length;
  const successes = sessions.filter((s) => s.outcome === "success");
  const byArchetype = {};
  for (const s of sessions) {
    byArchetype[s.personaArchetype] ??= { n: 0, success: 0 };
    byArchetype[s.personaArchetype].n++;
    if (s.outcome === "success") byArchetype[s.personaArchetype].success++;
  }
  return {
    n,
    successRate: n ? successes.length / n : 0,
    outcomeCounts: sessions.reduce((acc, s) => ((acc[s.outcome] = (acc[s.outcome] || 0) + 1), acc), {}),
    medianTimeToSuccessMs: median(successes.map((s) => s.durationMs)),
    medianClicks: median(sessions.map((s) => s.clicks)),
    meanClicks: mean(sessions.map((s) => s.clicks)),
    errorRate: n ? sessions.reduce((a, s) => a + s.errors, 0) / n : 0,
    rageClickSessions: sessions.filter((s) => s.rageClicks > 0).length,
    backtrackLoopSessions: sessions.filter((s) => s.backtrackLoops > 0).length,
    byArchetype,
  };
}

function fmtMs(ms) {
  if (!ms) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
function pct(x) {
  return `${Math.round(x * 100)}%`;
}
function bar(value, max, color) {
  const w = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return `<div class="bar-track"><div class="bar-fill" style="width:${w}%;background:${color}"></div></div>`;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const PALETTE = ["#6d28d9", "#0ea5e9", "#16a34a", "#ea580c", "#db2777", "#64748b"];

function nativeAnalyticsSection(nativeAnalytics, variantNames) {
  if (!nativeAnalytics || !nativeAnalytics.byEvent || !Object.keys(nativeAnalytics.byEvent).length) return "";
  const events = Object.keys(nativeAnalytics.byEvent).sort();
  const rows = events
    .map((event) => {
      const perVariant = nativeAnalytics.byEvent[event];
      const cells = variantNames
        .map((v) => {
          const byArch = perVariant[v] || {};
          const total = Object.values(byArch).reduce((a, b) => a + b, 0);
          return `<td class="num">${total || "—"}</td>`;
        })
        .join("");
      return `<tr><td>${esc(event)}</td>${cells}</tr>`;
    })
    .join("");
  const headerCells = variantNames.map((v) => `<th>${esc(v)}</th>`).join("");
  return `<h2>Product analytics (from the prototype's own tracking)</h2>
  <p style="font-size:13px;color:var(--ink-muted);margin:0 0 10px">Real events the prototype's own PostHog/Mixpanel instrumentation captured during this run, queried back and counted per variant — not our engine's own click/time metrics above. Per-archetype detail is in <code>native-analytics.json</code> alongside this report.</p>
  <table>
    <thead><tr><th>Event</th>${headerCells}</tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function render(title, variantStats, hasSuccessSignal = true, nativeAnalytics = null) {
  const names = Object.keys(variantStats);
  const maxSuccessRate = Math.max(0.0001, ...names.map((n) => variantStats[n].successRate));
  const maxClicks = Math.max(1, ...names.map((n) => variantStats[n].medianClicks));

  // Without a real success criterion, checkCriteria() always returns null
  // (see run-synthetic-test.mjs) — every session ends via patience/timeout,
  // so successRate is deterministically 0 regardless of the prototype. A
  // report that showed a bare "0%" there would look like a real finding
  // when it's actually a guaranteed artifact of not configuring one — say
  // so plainly instead.
  const successCell = (s, color) =>
    hasSuccessSignal
      ? `${bar(s.successRate, maxSuccessRate, color)}<span class="num-label">${pct(s.successRate)}</span>`
      : `<span class="num-label">not measured</span>`;

  const rows = names
    .map((name, i) => {
      const s = variantStats[name];
      const color = PALETTE[i % PALETTE.length];
      return `
      <tr>
        <td><span class="dot" style="background:${color}"></span>${esc(name)}</td>
        <td class="num">${s.n}</td>
        <td>${successCell(s, color)}</td>
        <td class="num">${hasSuccessSignal ? fmtMs(s.medianTimeToSuccessMs) : "—"}</td>
        <td>${bar(s.medianClicks, maxClicks, color)}<span class="num-label">${s.medianClicks.toFixed(1)}</span></td>
        <td class="num">${s.errorRate.toFixed(2)}</td>
        <td class="num">${s.rageClickSessions}</td>
        <td class="num">${s.backtrackLoopSessions}</td>
      </tr>`;
    })
    .join("");

  const archetypeSection = hasSuccessSignal
    ? `<h2>Success rate by persona archetype</h2>
  <table>
    <thead><tr><th>Variant</th><th>Archetype</th><th>Sessions</th><th>Success rate</th></tr></thead>
    <tbody>${names
      .flatMap((name) => {
        const s = variantStats[name];
        return Object.entries(s.byArchetype).map(
          ([arch, a]) => `<tr><td>${esc(name)}</td><td>${esc(arch)}</td><td class="num">${a.n}</td><td class="num">${pct(a.n ? a.success / a.n : 0)}</td></tr>`
        );
      })
      .join("")}</tbody>
  </table>`
    : "";

  let calloutText;
  if (hasSuccessSignal) {
    const best = names.reduce((a, b) => (variantStats[a].successRate >= variantStats[b].successRate ? a : b), names[0]);
    const bestStats = variantStats[best];
    calloutText = `<strong>${esc(best)}</strong> had the highest task success rate (${pct(bestStats.successRate)} of ${bestStats.n} synthetic sessions), with a median time-to-success of ${fmtMs(bestStats.medianTimeToSuccessMs)}. Read the full table below before treating this as conclusive — check session counts and error/rage-click rates too.`;
  } else {
    const fewestClicks = names.reduce((a, b) => (variantStats[a].medianClicks <= variantStats[b].medianClicks ? a : b), names[0]);
    calloutText = `No success criterion was configured for this run, so success rate isn't measured — every session ran until it either finished exploring or hit its step/time budget, which is expected, not a failure. Comparing by friction instead: <strong>${esc(fewestClicks)}</strong> had the fewest median clicks. Add a real \`successCriteria\` (see config-schema.md) for a genuine completion-rate comparison.`;
  }

  return `<!doctype html><html><head><meta charset="utf8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root{ --paper:#faf9fc; --ink:#170a2e; --ink-muted:#5b5470; --ink-faint:#948da2; --line:#e6e3ec; --raised:#fff; --accent:#6d28d9; --accent-soft:#ede7fb; }
  @media (prefers-color-scheme: dark){ :root{ --paper:#170a2e; --ink:#f4f1fa; --ink-muted:#c3bcd6; --ink-faint:#948da2; --line:#3a2d5c; --raised:#20103f; --accent:#a78bfa; --accent-soft:#341a63; } }
  *{box-sizing:border-box}
  body{ margin:0; background:var(--paper); color:var(--ink); font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; padding:48px 24px 100px; }
  .wrap{ max-width:920px; margin:0 auto; }
  h1{ font-size:26px; margin:0 0 6px; }
  .sub{ color:var(--ink-muted); margin:0 0 32px; font-size:14px; }
  .callout{ background:var(--accent-soft); border-left:3px solid var(--accent); border-radius:8px; padding:14px 18px; margin:0 0 32px; font-size:14px; }
  h2{ font-size:16px; margin:36px 0 12px; }
  table{ width:100%; border-collapse:collapse; font-size:13px; background:var(--raised); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  th{ text-align:left; font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--ink-faint); padding:10px 12px; border-bottom:1px solid var(--line); }
  td{ padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:middle; }
  tr:last-child td{ border-bottom:none; }
  td.num{ text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .dot{ display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:8px; }
  .bar-track{ display:inline-block; width:80px; height:6px; background:var(--line); border-radius:4px; vertical-align:middle; margin-right:8px; overflow:hidden; }
  .bar-fill{ height:100%; border-radius:4px; }
  .num-label{ font-variant-numeric:tabular-nums; font-size:12px; color:var(--ink-muted); }
  footer{ margin-top:48px; color:var(--ink-faint); font-size:12px; }
</style></head><body><div class="wrap">
  <h1>${esc(title)}</h1>
  <p class="sub">Generated ${new Date().toISOString()} — synthetic-usability-test skill</p>
  <div class="callout">${calloutText}</div>

  <h2>Variant comparison</h2>
  <table>
    <thead><tr><th>Variant</th><th>Sessions</th><th>Success rate</th><th>Median time-to-success</th><th>Median clicks</th><th>Errors/session</th><th>Sessions w/ rage-click</th><th>Sessions w/ backtrack loop</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  ${archetypeSection}

  ${nativeAnalyticsSection(nativeAnalytics, names)}

  <footer>Raw per-session event logs (JSONL) live alongside this report in the same output directory. Rage-click and backtrack-loop counts are frustration signals detected directly from click/navigation patterns, independent of any analytics backend.</footer>
</div></body></html>`;
}

function main() {
  const args = parseArgs(process.argv);
  const variantDirs = walkVariantDirs(args.outDir);
  const variantStats = {};
  for (const dir of variantDirs) {
    const sessions = loadSessions(join(args.outDir, dir));
    if (!sessions.length) continue;
    variantStats[dir] = aggregate(sessions);
  }
  if (!Object.keys(variantStats).length) {
    console.error("No session data found under", args.outDir);
    process.exit(1);
  }

  let hasSuccessSignal = true;
  try {
    const manifest = JSON.parse(readFileSync(join(args.outDir, "manifest.json"), "utf8"));
    hasSuccessSignal = (manifest?.config?.task?.successCriteria || []).length > 0;
  } catch {
    // No manifest.json (e.g. LLM-agent-mode logs, or an older run) —
    // assume a signal was set rather than second-guess data we can't see.
  }

  let nativeAnalytics = null;
  try {
    nativeAnalytics = JSON.parse(readFileSync(join(args.outDir, "native-analytics.json"), "utf8"));
  } catch {
    // No native-analytics.json — connectAnalytics wasn't used, or
    // posthog-query.mjs hasn't been run yet for this outDir. Fine either way.
  }

  const html = render(args.title, variantStats, hasSuccessSignal, nativeAnalytics);
  writeFileSync(args.out, html);
  console.log(`Report written to ${args.out}`);
}

main();
