# Connecting to a prototype's own analytics

This is the opposite direction from `analytics-adapters.md`. That doc covers
**exporting** — sending our own engine's event log (clicks, timing, errors)
to an analytics backend. This doc covers **connecting** — when the
prototype under test already has PostHog or Mixpanel wired into its own
code, tagging our synthetic sessions inside *that* client so its own
tracking (whatever custom events it fires — `resolve_completed`,
`search_used`, checkout funnels, anything specific to that product) can be
queried back and folded into the comparison report, broken down by variant.

The two are independent. Use either, both, or neither.

## Why this needs more than just watching network traffic

You can't just read the target's already-fired events after the fact —
you need the target's *own* analytics client to tag each event as it fires,
so a later query can tell "this event came from our synthetic-test run,
this specific session, this variant" apart from everything else in that
analytics project (including real user traffic, if the project isn't
dedicated to testing).

## How it works

1. **Tagging** (`lib/analytics-injection.mjs`, wired into `run-synthetic-test.mjs`
   via `config.connectAnalytics: true`) — before the target page's own
   scripts run, we install a property watcher on `window.posthog` /
   `window.mixpanel`. The instant the target's own code assigns either
   global (however its install snippet does that), we immediately call
   `.register({...tags})` on it — both libraries expose this exact method
   for setting persistent "super properties" that get attached to every
   subsequent event automatically. Tags: `synthetic_session`,
   `synthetic_run_id` (one per full comparison run), `synthetic_variant`,
   `synthetic_persona_id`, `synthetic_persona_archetype`, `synthetic_session_id`.

   This also masks `navigator.webdriver` (many analytics SDKs, PostHog's
   included, can silently drop events from a browser that fingerprints as
   automated). **Scope this carefully**: this is appropriate only because
   the "bot" here is the prototype's own owner intentionally testing their
   own prototype — never repurpose this to defeat bot protection on a
   system you don't own or aren't authorized to test.

   Verified directly: the registered properties do land in the target's
   real PostHog client (`posthog.persistence.props`), confirmed against a
   live prototype. What's *not* independently verified is delivery — see
   the caveat below.

2. **Querying back** (`scripts/adapters/posthog-query.mjs`) — after the run,
   query PostHog's HogQL query API (`POST /api/projects/{id}/query/`) for
   every event tagged with this run's `synthetic_run_id`, grouped by event
   type and variant. Writes `native-analytics.json` into the run's outDir.

3. **Reporting** — `generate-report.mjs` picks up `native-analytics.json`
   automatically if present and adds a "Product analytics (from the
   prototype's own tracking)" section: real event counts per variant, from
   whatever the prototype actually tracks — not just our generic
   click/time/friction metrics.

## Config

```jsonc
{
  "connectAnalytics": true
  // ...rest of the config as normal
}
```

That's it on the run side — tagging happens automatically for every
session once this is on. No credentials needed for tagging itself (it just
calls a method the target's own already-loaded client exposes).

## Querying

```bash
node scripts/adapters/posthog-query.mjs <outDir> --key <personal_api_key> --project-id <id> [--host https://us.posthog.com]
node scripts/generate-report.mjs <outDir> --title "..."   # rerun to fold the results in
```

**Get a Personal API key**: PostHog → Project Settings → Personal API Keys
→ create one scoped to `query:read` (not the project/public key used for
capture — different credential, different purpose, and the query endpoint
will reject the wrong one). Ask the user for this interactively or read it
from `POSTHOG_PERSONAL_API_KEY` — never hardcode it, same rule as every
other credential this skill touches.

**Host note**: the query API lives on the *app* host (`us.posthog.com` /
`eu.posthog.com`), not the *ingestion* host used for capture
(`us.i.posthog.com`). Mixing these up is the most common way this fails —
check both hosts if a query 404s or 401s unexpectedly.

## A real caveat, found while building this

Client-side tagging succeeding is not proof the target's analytics is
actually sending anything. While verifying this against a live prototype
with real `posthog.init()` in its own code, tagging worked perfectly
(confirmed via `posthog.persistence.props`), but **zero capture events
were ever sent to PostHog** — not even the SDK's own automatic pageview
event, across multiple waits up to 25 seconds and multiple manual
`.capture()` calls. No reverse-proxy endpoint, no delayed batch flush,
nothing. The cause wasn't identified (could be a paused/misconfigured
project, disabled ingestion, or something specific to that deployment) —
the point is: **before spending time debugging `posthog-query.mjs`
returning zero rows, check the target's PostHog project directly to
confirm it's receiving *any* events at all**, ideally from a real manual
browser session first, independent of this skill entirely.
