---
name: synthetic-usability-test
description: Runs synthetic ("fake" / simulated) user sessions against one or more live, no-auth web prototypes to compare usability — task success rate, time-on-task, clicks, errors, rage-clicks, dead ends, backtracking — without waiting on real user-research participants. Use this whenever the user wants to A/B test or compare prototypes/design variants, "simulate users" or "spam a prototype with fake/synthetic users", generate usability analytics for a design review, decide between two implementations of the same feature (different redesigns, different frameworks, competing prototypes, Figma-to-code vs. hand-built, a Lovable/v0/Bolt-generated app vs. the real product), or wants a quick read on "which version is easier to use" — even if they never say the words "usability test." Drives headless Chromium with persona-based human-like behavior (varying speed, error rate, hesitation, distraction) against any prototype URL with no login wall, and produces a comparison report plus an optional PostHog (or other, swappable) analytics export. Do NOT use this for prototypes that require authentication, or to load-test / stress-test a production service — it is a UX-research tool, not a traffic generator.
---

# Synthetic Usability Test

Turn "does variant A or variant B work better for this task" into a
measured answer by running many differently-behaved synthetic users
against each variant and comparing outcomes — instead of eyeballing two
screenshots or waiting weeks for a real research cycle.

This generalizes the pattern from an earlier one-off (a hardcoded simulator
built for a specific product's exact DOM): the engine here reads whatever
page it's pointed at and decides what to click using information scent
(does this element's text/label resemble what the current task is asking
for?) rather than any prototype-specific selector. Point it at any two
URLs implementing the same feature and it works without calibration.

Every command below is written as `<skill_dir>/scripts/...` — resolve
`<skill_dir>` to wherever this skill actually lives on disk (the "Base
directory for this skill" this invocation reported, or wherever you found
`SKILL.md` if reading it directly) rather than assuming a fixed path. This
skill may be installed personally (`~/.claude/skills/synthetic-usability-test`),
per-project (`.claude/skills/synthetic-usability-test` inside some other
repo), or anywhere else someone cloned it — hardcoding one location's path
would break for everyone else.

## Scope and safety

- **No authentication.** This tool assumes every target is reachable
  without logging in. If a session hits a password field or an obvious
  login wall, it stops that session and logs `auth_wall_detected` — it
  never guesses or enters credentials. If *every* session on a variant
  hits this immediately, tell the user the variant needs auth and can't be
  tested this way.
- **Only test prototypes the user owns or is authorized to test.** This
  drives real page loads against a real server. Default concurrency (5)
  and the jittered session start times in the runner keep load modest, but
  don't raise concurrency past what's reasonable for a target you don't
  control, and don't point this at third-party production sites without
  the user's explicit confirmation that they're authorized to.
- This is a UX-measurement tool, not a load-testing tool — if the user's
  actual goal is stress-testing infrastructure, say so and decline; that's
  a different (and riskier) kind of task.

## Workflow

### 1. Gather the essentials

You need, at minimum:
- **Variants**: one or more `{name, url}` pairs — the array isn't capped at
  two. A single URL works (single-prototype usability check, no
  comparison table), and so does comparing 3+ competing implementations of
  the same feature (e.g. three Lovable/v0/Bolt-generated prototypes for
  the same flow) side by side in one report. Nothing about the engine or
  report assumes exactly two.
- **Task**: what is a synthetic user trying to accomplish? Get a plain
  description *and* push for a concrete **success criterion** — a piece of
  text, a URL fragment, or an element that only appears once the task is
  actually done. Without this the engine can't tell success from wandering.
  If the user can't articulate one, propose a reasonable one from what the
  task implies (e.g. "a confirmation message appears") and confirm it. If
  the task is "do X, then do Y" and neither step leaves anything new and
  stable on the page (e.g. "add an item, then delete it" — the end state
  looks identical to the start state), a page-state criterion can't work at
  all; use `actionSequence` instead (see `config-schema.md`), which checks
  the session's own click history rather than a DOM snapshot.
- **Scale**: how many synthetic users per variant? Default to ~15-20 if
  not specified — enough for the persona mix in `references/personas.md`
  to produce a real spread, not so many it takes forever.
- **Who's using it**: if the user describes their actual audience ("mostly
  older users, not very tech-savvy," "people on mobile shopping while
  distracted," "non-native English speakers") — or if a segment matters
  for the comparison — translate that into a persona trait mix yourself
  (see `references/personas.md`) rather than defaulting to the generic
  archetype spread. Plain-language description → trait vector is the
  intended workflow, not something the user has to know preset names for.

Don't over-interview — infer sensible defaults (see config schema) for
everything else and state your assumptions rather than asking a long
checklist. This is auto-mode-friendly: proceed with reasonable defaults,
only ask when something is genuinely ambiguous or consequential (e.g. the
success criterion, or whether a URL is actually meant to be tested).

### 2. One-time environment setup

Check whether the skill's dependencies are installed (they persist across
projects once done):

```bash
cd <skill_dir> && [ -d node_modules ] || npm install
cd <skill_dir> && npx playwright install chromium
```

`playwright install chromium` downloads a browser binary (one-time, ~100MB)
— mention this to the user before it runs the first time on a machine.

### 3. Preflight each variant

Before running real sessions, do a quick sanity check per URL: is it
reachable, and does it show an obvious login wall on first load? A fast way
is to run one throwaway session with `personas.count: 1` and `maxDurationMs`
low, or just eyeball it with the `mcp__Claude_Browser__navigate` /
`get_page_text` tools if the Browser pane is already open. If a variant is
unreachable or auth-gated, tell the user now rather than burning a full run
discovering it session-by-session.

Hosted prototype builders (Lovable, v0, Bolt, Figma Make, and similar) are a
common variant source and usually publish a plain public URL
(`<project>.lovable.app` etc.) with no login — but some let the owner turn
on a password-protected preview. That shows up as the same
`auth_wall_detected` signal as any other login wall; if it fires on first
load for every session on a variant, tell the user to check that project's
share/publish settings rather than assuming the prototype is broken.

### 4. Write the run config

Build a JSON file per `references/config-schema.md` — variants, task
(with `successCriteria`), `personas`, `concurrency`, `maxDurationMs`,
`outDir`. Put it somewhere in the current project (not the skill
directory) so it's easy for the user to find and rerun, e.g.
`./synthetic-tests/<slug>/config.json`.

### 5. Choose the engine

Three tiers — full comparison and config details in `references/engines.md`:

- **Tier 1, heuristic** (`engine: "heuristic"`, the default) — free, scales
  to hundreds of sessions. Use this unless something below points
  elsewhere.
- **Tier 2, LLM-scored** (`engine: "llm-scored"`) — a real model scores
  each decision instead of keyword-matching, needs `ANTHROPIC_API_KEY`.
  Reach for this when the prototype's copy is subtle enough that
  token-matching plausibly picks the wrong element (dense pages, several
  similar-sounding controls) but the run still needs more than ~10
  sessions. Costs more than Tier 1, far less than full LLM-agent mode.
- **LLM-agent mode** (separate script path, `references/llm-agent-mode.md`)
  — a subagent reasons in character per session, reading the real page.
  Reach for this when the judgment itself is genuinely semantic (real
  language-fluency effects, "does this copy read as trustworthy") — not
  just uncertain scoring, but something keyword-matching or a scoring
  call fundamentally can't see. Caps out around 5-10 sessions.
- Also useful either way: if a first Tier 1 run shows near-universal early
  `dead_end`/`task_abandoned` across all personas on a variant, that's a
  signal the heuristic couldn't parse the UI (not that the UI is broken)
  — a good trigger to retry that variant with Tier 2 or LLM-agent mode.

Don't inline your own version of the LLM-agent subagent prompt template —
read `references/llm-agent-mode.md` first; it keeps archetype behavior
consistent across all three tiers so results are comparable.

### 6. Run it

```bash
node <skill_dir>/scripts/run-synthetic-test.mjs ./synthetic-tests/<slug>/config.json
```

This streams per-variant outcome counts to stdout as it goes and writes
`manifest.json` + one JSONL file per session under `outDir`. Let it run in
the background if it's a large run (`run_in_background: true` on the Bash
call) rather than blocking the conversation — check in via the completion
notification, don't poll.

### 7. Analytics — ask, don't assume, and know which direction they mean

"Connect my analytics" is ambiguous — find out which of two different
things the user means before building either:

- **Export** — send OUR engine's own event log (clicks, timing, errors,
  friction signals) outward to an analytics backend. Ask which one; if
  PostHog (the default adapter):
  ```bash
  node <skill_dir>/scripts/adapters/posthog.mjs <outDir> --key <project_api_key> --host https://us.i.posthog.com --experiment <slug>
  ```
  For a different backend, `references/analytics-adapters.md` has the
  contract plus starter mappings for Mixpanel, Amplitude, GA4, Segment,
  and a generic webhook.

- **Connect** — the prototype *already* has PostHog/Mixpanel wired into
  its own code, and the user wants its own tracking (whatever custom
  events it fires) compared per variant, not just our generic metrics. Set
  `connectAnalytics: true` in the config (tags every session inside the
  target's own analytics client automatically, no credentials needed for
  that part), then after the run use `scripts/adapters/posthog-query.mjs`
  to pull the tagged events back and fold them into the report. Full
  details, including a real caveat worth reading before assuming a script
  is broken, in `references/analytics-connect.md`.

Never default to silently sending or connecting anywhere, and never ask
the user to paste a secret key into chat if they'd rather set it as an
environment variable first. Not wanting either is a complete, legitimate
outcome — the local JSONL and the report don't depend on it.

### 8. Generate and deliver the report

```bash
node <skill_dir>/scripts/generate-report.mjs <outDir> --title "<descriptive title>"
```

Publish the resulting `report.html` as a Claude Artifact (preferred — the
user can revisit/share it) or send it via `SendUserFile` if an Artifact
doesn't fit the context. Then summarize the finding **in your own words**
in chat: which variant won, by how much, at what sample size, and anything
notable in the per-archetype breakdown or the frustration signals
(rage-clicks, backtrack loops). `references/report-guide.md` explains what
each metric means and where it can mislead — read it before writing that
summary so you don't overstate a thin result.

## Reference files

- `references/config-schema.md` — full run-config format, criteria types,
  the canonical event schema all engines write.
- `references/personas.md` — built-in archetypes, semantic trait vectors,
  and how to translate a plain-language user description into one.
- `references/engines.md` — Tier 1 vs. Tier 2 vs. LLM-agent mode compared,
  `cursorRealism`, and the research/datasets each mechanism is grounded in.
- `references/analytics-adapters.md` — **export**: the adapter contract for
  sending our own event log outward; PostHog default plus how to swap in
  another backend.
- `references/analytics-connect.md` — **connect**: tagging synthetic
  sessions inside a prototype's own already-wired PostHog/Mixpanel client
  and querying its own tracking back into the report — the other
  direction from export, read both before assuming which one someone means.
- `references/llm-agent-mode.md` — when and how to use the high-fidelity
  subagent-driven mode instead of/alongside the Playwright engine.
- `references/report-guide.md` — how to read and correctly caveat the
  comparison report.
- `examples/example-config.json` — a working config against two public
  TodoMVC implementations, useful as a template or a smoke test.
- `examples/ecommerce-template-config.json` — an unverified template (no
  live URLs — fill in your own) for a browse→cart task funnel, plus a
  semantic persona mix.
