# Analytics adapters

The engine's only durable output is the local JSONL under `outDir` — that's
the ground truth, always written, regardless of any analytics backend. An
adapter is a small standalone script that reads that JSONL and forwards it
somewhere else. This is what makes "PostHog by default, swappable later" a
one-file change instead of a rewrite: nothing about the runner, the personas,
or the report generator knows or cares which adapter (if any) gets used.

## Contract

An adapter is a Node script that:
1. Takes an `outDir` (or a single JSONL file) as input.
2. Walks the JSONL files (one per session, canonical schema in
   `config-schema.md`).
3. Maps each event to the destination's native event/track call.
4. Sends it, batching and rate-limiting as the destination requires.

Nothing else is required — no shared base class, no registration. `main.py`/
`main.mjs`-style adapters are trivial to write and easy to delete.

## Default: PostHog (`scripts/adapters/posthog.mjs`)

```bash
node scripts/adapters/posthog.mjs <outDir> --key <project_api_key> [--host https://us.i.posthog.com] [--experiment my-test]
```

Maps each JSONL event to a PostHog `capture` call:
- `event` → `synthetic_<event>` (e.g. `synthetic_click`, `synthetic_task_completed`)
- `distinct_id` → `synthetic-<sessionId>` (keeps each synthetic session as
  its own "person" in PostHog so session-level funnels/breakdowns work)
- `properties` → variant, persona archetype, step, elapsed ms, scent score,
  target text/tag, plus an `experiment` tag and `synthetic: true` so real
  user data is never ambiguous with synthetic data in shared dashboards.

Get the project API key and host from the user interactively when the skill
runs — never hardcode or ask for it any other way. If they don't have one
handy, skip sending and just hand them the local JSONL + HTML report; those
are already a complete result on their own (see §06 of the original
motivating writeup: nothing about scoring depends on any analytics backend).

## Writing a different adapter

Copy `scripts/adapters/posthog.mjs` as a starting point — the JSONL-walking
and chunking logic is destination-agnostic, only the per-event mapping and
the HTTP call at the bottom change. Sketches for common destinations:

**Mixpanel** — `POST https://api.mixpanel.com/import` with
`{event, properties: {distinct_id, time, ...}}` objects, `Authorization:
Basic <base64(api_secret:)>`.

**Amplitude** — `POST https://api2.amplitude.com/2/httpapi` with
`{api_key, events: [{user_id, event_type, time, event_properties}]}`.

**GA4 (Measurement Protocol)** — `POST
https://www.google-analytics.com/mp/collect?measurement_id=...&api_secret=...`
with `{client_id, events: [{name, params}]}`. Note GA4 event names are
restricted (no spaces, 40-char limit) — sanitize `synthetic_<event>` first.

**Segment** — `POST https://api.segment.io/v1/batch` with HTTP basic auth
using the write key as username, `{batch: [{type: "track", event, userId,
properties, timestamp}]}`.

**Generic webhook** — simplest of all: `POST` each event (or the whole
batch) as JSON to whatever URL the user gives you. Good default when they
say "just send it to our own endpoint."

**Local-only** — do nothing. The JSONL + `report.html` already stand alone;
this is a legitimate choice, not a fallback to apologize for.
