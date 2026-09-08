# Run config schema

The Playwright engine (`scripts/run-synthetic-test.mjs`) and the report
generator both read/write this shape. Build one JSON file per test run.

```jsonc
{
  // Each variant is one thing being compared — two versions of the same
  // prototype, or two entirely different products solving the same task.
  // "name" becomes the output subdirectory and the report's row label.
  "variants": [
    { "name": "classic", "url": "https://example.vercel.app/classic" },
    { "name": "redesign", "url": "https://example.vercel.app/redesign" }
  ],

  "task": {
    // Free text — also mined for keywords automatically.
    "description": "Find a critical severity issue and resolve it",
    // Explicit keywords/phrases sharpen scoring beyond what's mined from the
    // description. Include synonyms real UI copy might use ("resolve",
    // "fix", "remediate") since you don't control the target's wording.
    "keywords": ["critical", "resolve", "fix", "remediate"],

    // A session stops the moment ANY one of these matches. Prefer something
    // that only appears once the task is genuinely done (a confirmation
    // toast, a URL change to a "done" state) — not something present on
    // every page.
    "successCriteria": [
      { "type": "textVisible", "value": "Resolved" },
      { "type": "urlContains", "value": "/resolved" }
    ],

    // Optional — stop early and log the session as a hard failure (not just
    // a timeout) if the target shows an explicit error/dead-end state.
    "failureCriteria": [
      { "type": "textVisible", "value": "Something went wrong" }
    ]
  },

  // How many synthetic users, and what mix of behavioral personas. Omit
  // "mix" and just set "count" to use the built-in default distribution
  // (see references/personas.md) — a spread of expert/novice/hurried/
  // cautious/distracted rather than N identical bots.
  "personas": {
    "count": 20
    // or, mixing all three ways a mix entry can be defined — see
    // references/personas.md for the full trait/preset reference:
    // "mix": [
    //   { "archetype": "novice", "count": 8 },              // built-in preset
    //   { "preset": "esl_beginner", "count": 6 },            // named semantic preset
    //   { "preset": "senior_low_dexterity", "count": 4 },
    //   { "name": "power_user_native", "count": 2,           // fully custom trait vector
    //     "traits": { "attention": 0.9, "techSavvy": 0.9, "dexterity": 0.85,
    //                 "languageFluency": 0.95, "patience": 0.6 } }
    // ]
  },

  // Concurrent browser contexts per variant. Keep this modest — this tool
  // is for exercising a prototype you own/are authorized to test, not for
  // hammering a server. 5-10 is plenty to see real signal; there's rarely a
  // reason to go past ~20 even for a "large" run.
  "concurrency": 5,

  // Per-session budget. A session that hits either limit first is logged
  // "abandoned" (or "timeout" in meta.reason), which is itself a real
  // usability signal — not noise to filter out.
  "maxDurationMs": 90000,

  "headless": true,
  "outDir": "./out/my-run",

  // Optional — see references/engines.md for the full comparison.
  "engine": "heuristic", // or "llm-scored" (Tier 2: a real model scores candidates, needs ANTHROPIC_API_KEY)
  "llm": { "model": "claude-haiku-4-5-20251001" }, // only used when engine is "llm-scored"; this is the default
  "cursorRealism": false, // curved/eased mouse movement before clicks instead of teleporting — slower, more realistic, also surfaces hover-revealed controls

  // Optional — see references/analytics-connect.md. Tags every session
  // inside the TARGET PROTOTYPE'S OWN PostHog/Mixpanel client (if either
  // is already wired into its code), so its own tracking can be queried
  // back and compared per variant — the opposite direction from
  // analytics-adapters.md (which exports OUR event log outward).
  "connectAnalytics": false
}
```

## Criteria types

| type | value means | matches when |
|---|---|---|
| `urlContains` | substring | current page URL contains it |
| `urlMatches` | regex | current page URL matches it |
| `textVisible` | text | that text is visible anywhere on the page |
| `selectorVisible` | CSS selector | an element matching it is visible |
| `selectorHidden` | CSS selector | no visible element matches it (e.g. a spinner/modal gone) |
| `actionSequence` | array of keywords, e.g. `["add", "delete"]` | the session's own click/type history matched each keyword, in order (not a page-state check) |

`actionSequence` exists for tasks that leave no lasting trace in the DOM —
"add an element, then delete it" ends in exactly the state it started in, so
every state-snapshot criterion (`textVisible`, `selectorVisible`, ...) is
unusable: it either matches before the task starts or never matches at all.
Use it whenever the task is "do X, then do Y" and neither X nor Y leaves
something new and stable on the page to check for.

## Event schema (output)

Every session writes one JSONL file: one JSON object per line, append-only,
safe to tail while a run is in progress.

```jsonc
{
  "ts": "2026-09-08T14:03:11.204Z",
  "tMs": 4210,                  // ms since session start
  "sessionId": "novice-3-abc123",
  "variant": "redesign",
  "personaId": "novice-3",
  "personaArchetype": "novice",
  "step": 6,
  "event": "click",             // see event vocabulary below
  "target": { "text": "Resolve", "tag": "button", "role": "", "href": "" },
  "pageUrl": "https://example.vercel.app/redesign/issue/42",
  "scentScore": 2.1,
  "meta": {}
}
```

**Event vocabulary**: `session_start`, `click`, `type`, `backtrack`,
`dead_end`, `backtrack_loop`, `rage_click`, `error`, `auth_wall_detected`,
`task_completed`, `task_failed`, `task_abandoned`, `session_end`.

This is the same schema an LLM-agent-mode session should write (see
`llm-agent-mode.md`) — the report generator and every analytics adapter are
engine-agnostic as long as the JSONL matches this shape.
