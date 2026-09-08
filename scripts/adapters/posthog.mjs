#!/usr/bin/env node
// Default analytics adapter: reads every session's JSONL from a run's outDir
// and forwards it to PostHog via the /batch/ capture endpoint. This is one
// implementation of a simple contract — see references/analytics-adapters.md
// for the interface, and how to write a Mixpanel/Amplitude/GA4/Segment/webhook
// adapter instead. Swapping backends never touches the runner or the report
// generator; both only ever read the local JSONL.
//
// Usage: node posthog.mjs <outDir> --key <projectApiKey> [--host https://us.i.posthog.com] [--experiment <name>]

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function parseArgs(argv) {
  const args = { outDir: argv[2], host: "https://us.i.posthog.com" };
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === "--key") args.key = argv[++i];
    else if (argv[i] === "--host") args.host = argv[++i];
    else if (argv[i] === "--experiment") args.experiment = argv[++i];
  }
  return args;
}

function walkJsonlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walkJsonlFiles(p));
    else if (entry.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.outDir || !args.key) {
    console.error("Usage: node posthog.mjs <outDir> --key <projectApiKey> [--host <host>] [--experiment <name>]");
    process.exit(1);
  }

  const files = walkJsonlFiles(args.outDir);
  const batch = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      const ev = JSON.parse(line);
      batch.push({
        event: `synthetic_${ev.event}`,
        distinct_id: `synthetic-${ev.sessionId}`,
        timestamp: ev.ts,
        properties: {
          $current_url: ev.pageUrl,
          variant: ev.variant,
          persona_id: ev.personaId,
          persona_archetype: ev.personaArchetype,
          step: ev.step,
          t_ms: ev.tMs,
          scent_score: ev.scentScore,
          target_text: ev.target?.text,
          target_tag: ev.target?.tag,
          experiment: args.experiment || "synthetic-usability-test",
          synthetic: true,
          ...ev.meta,
        },
      });
    }
  }

  if (!batch.length) {
    console.log("No events found under", args.outDir);
    return;
  }

  console.log(`Sending ${batch.length} events to ${args.host}...`);
  // PostHog's batch endpoint caps payloads; chunk defensively.
  const CHUNK = 500;
  for (let i = 0; i < batch.length; i += CHUNK) {
    const chunk = batch.slice(i, i + CHUNK);
    const res = await fetch(`${args.host}/batch/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: args.key, batch: chunk }),
    });
    if (!res.ok) {
      console.error(`PostHog batch send failed (${res.status}):`, await res.text().catch(() => ""));
      process.exit(1);
    }
  }
  console.log(`Done. ${batch.length} events sent as variant-tagged "synthetic_*" events.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
