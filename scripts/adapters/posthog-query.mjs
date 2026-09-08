#!/usr/bin/env node
// Reads back real product analytics events the TARGET PROTOTYPE'S OWN
// PostHog instrumentation captured during a run with connectAnalytics
// enabled (see lib/analytics-injection.mjs) — events our synthetic
// sessions tagged with synthetic_run_id, queried via PostHog's HogQL query
// API and broken down per variant. This is the "connect" half; the
// existing adapters/posthog.mjs is the "export" half (sends OUR event log
// TO PostHog) — the two are independent and can be used together or alone.
//
// Needs a PERSONAL API key (Project Settings -> Personal API keys, with
// "query:read" scope), NOT the project/public key used for capture —
// different credential, different purpose. Never hardcode it; pass via
// --key or POSTHOG_PERSONAL_API_KEY.
//
// Usage: node posthog-query.mjs <outDir> --key <personal_api_key> --project-id <id> [--host https://us.posthog.com]
//
// Note the host here is the APP/API host (us.posthog.com), not the
// ingestion host used for capture (us.i.posthog.com) — they're different
// subdomains for different purposes; using the wrong one is the most
// common way this fails.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function parseArgs(argv) {
  const args = { outDir: argv[2], host: "https://us.posthog.com" };
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === "--key") args.key = argv[++i];
    else if (argv[i] === "--project-id") args.projectId = argv[++i];
    else if (argv[i] === "--host") args.host = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const key = args.key || process.env.POSTHOG_PERSONAL_API_KEY;
  if (!args.outDir || !key || !args.projectId) {
    console.error("Usage: node posthog-query.mjs <outDir> --key <personal_api_key> --project-id <id> [--host <host>]");
    console.error("(key can also come from the POSTHOG_PERSONAL_API_KEY env var)");
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(join(args.outDir, "manifest.json"), "utf8"));
  const runId = manifest?.config?.runId;
  if (!runId) {
    console.error(
      "No runId in manifest.json — this run wasn't started with connectAnalytics enabled, so nothing was tagged to query for."
    );
    process.exit(1);
  }

  const hogql = `
    SELECT event, properties.synthetic_variant AS variant, properties.synthetic_persona_archetype AS archetype, count() AS n
    FROM events
    WHERE properties.synthetic_run_id = '${runId}'
    GROUP BY event, variant, archetype
    ORDER BY event, variant
  `;

  console.log(`Querying ${args.host} for run ${runId}...`);
  const res = await fetch(`${args.host}/api/projects/${args.projectId}/query/`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query: hogql } }),
  });

  if (!res.ok) {
    console.error(`Query failed (${res.status}):`, await res.text().catch(() => ""));
    process.exit(1);
  }

  const data = await res.json();
  const rows = data.results || [];
  if (!rows.length) {
    console.log(
      "No events found for this run id. Most likely cause: the target's analytics client isn't actually sending " +
        "events right now (check the project directly in the PostHog UI before assuming this script is broken) — " +
        "session tagging succeeding is not proof events are being captured at all."
    );
  }

  const byEvent = {};
  for (const [event, variant, archetype, n] of rows) {
    byEvent[event] ??= {};
    byEvent[event][variant] ??= {};
    byEvent[event][variant][archetype] = n;
  }

  const outPath = join(args.outDir, "native-analytics.json");
  writeFileSync(outPath, JSON.stringify({ runId, queriedAt: new Date().toISOString(), byEvent, rawRows: rows }, null, 2));
  console.log(`Wrote ${outPath} — ${rows.length} rows across ${Object.keys(byEvent).length} distinct event types.`);
  console.log("Re-run generate-report.mjs on the same outDir to fold this into the comparison report.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
