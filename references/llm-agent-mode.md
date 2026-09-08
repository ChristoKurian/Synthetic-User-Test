# LLM-agent mode (high-fidelity, low-volume)

The Playwright heuristic engine (information scent + persona parameters)
scales cheaply to dozens of sessions, but it's still a heuristic — it can
get confused by prototypes with sparse semantic markup (icon-only buttons,
canvas/WebGL UI, heavily custom components with no visible text). LLM-agent
mode trades volume for real reasoning: each synthetic user is a subagent
actually looking at the page and deciding what a person in that persona
would do next.

Use this mode when:
- The user explicitly asks for a small, careful run ("run 5 careful
  sessions on this").
- A first heuristic run comes back with widespread early `dead_end` /
  `task_abandoned` events across *all* personas on a variant — that pattern
  usually means the scoring couldn't find task-relevant elements, not that
  the prototype is actually unusable, and needs a reasoning fallback to
  tell the difference.
- The task itself is inherently judgment-heavy (e.g. "notice if anything
  about this flow feels untrustworthy") in a way keyword-matching can't
  capture.

Cap this mode at roughly 5-10 sessions total — each one is a full subagent
turn, so cost and time scale linearly and it stops being worth it well
before Playwright-mode's practical ceiling.

## Running a session

Each synthetic user is one `general-purpose` subagent (needs full tool
access: the `mcp__Claude_Browser__*` tools plus `Write`). Spawn all of a
variant's sessions in parallel in a single turn — same rule as any other
parallel Agent dispatch.

**Before spawning**: create the session's own tab with `tabs_create`
(`foreground: false`) and note its `tabId`. Passing an explicit `tabId` to
every subsequent Browser tool call is what lets multiple sessions run
concurrently without fighting over which tab is frontmost — assign one tab
per session and never omit `tabId` in that session's prompt.

**Subagent prompt template** — fill in the bracketed parts from the run
config and persona archetype (archetype flavor text below):

```
You are running one simulated user session against a prototype, as part of a
synthetic usability test. Act as the persona described below — this shapes
HOW you explore and decide, not just what you click.

Persona: [archetype] — [flavor text, see below]

Target URL: [variant.url]
Browser tab id: [tabId] — pass this tabId explicitly to every navigate,
computer, read_page, and find call. Do not omit it.

Task: [task.description]
Consider the task successful the moment ANY of these become true:
[task.successCriteria, in plain language]
Consider it a hard failure if: [task.failureCriteria, if any]

Rules:
- This prototype has no authentication. If you hit a password field or a
  real login wall, stop immediately and record an "auth_wall_detected"
  event — do not attempt to guess or enter credentials.
- Stay in character as the persona: an "expert" should move fast and
  rarely hesitate; a "novice" should explore more and occasionally pick a
  plausible-but-wrong option; a "hurried" user should give up quickly
  (~10-15 actions) if the flow isn't obvious; a "cautious" user should
  double-check by going back before committing; a "distracted" user should
  occasionally click something unrelated to the task.
- Cap yourself at [persona.maxSteps, default ~25] actions total. If you
  haven't succeeded by then, stop and record "task_abandoned".
- After EVERY action (click, type, navigate, go-back), silently note an
  event for it — you'll write these all out at the end, not one at a time.
- If you notice yourself repeating the same click on the same element, or
  landing back on a page you've already seen 3+ times, that's real signal
  — record it as "rage_click" or "backtrack_loop" respectively, don't just
  silently keep going.

When the session ends (success, failure, or abandoned), write ONE file at
[outputPath] containing one JSON object per line (JSONL, no trailing
commas, no wrapping array) using exactly this shape per event:

{"ts": "<ISO 8601 timestamp>", "tMs": <ms since session start, your best estimate>,
 "sessionId": "[sessionId]", "variant": "[variant.name]", "personaId": "[personaId]",
 "personaArchetype": "[archetype]", "step": <1-indexed>, "event": "<see vocabulary>",
 "target": {"text": "<visible label of what you acted on>", "tag": "", "role": "", "href": ""} | null,
 "pageUrl": "<url at that point>", "scentScore": null, "meta": {}}

Event vocabulary (use exactly these strings): session_start, click, type,
backtrack, dead_end, backtrack_loop, rage_click, error, auth_wall_detected,
task_completed, task_failed, task_abandoned, session_end. Always emit
session_start as your first event and session_end as your last, with
meta.outcome set to one of "success" | "failed" | "blocked" | "abandoned"
on the session_end event.

Report back in under 100 words: outcome, step count, and anything about the
UI that made this persona struggle or breeze through.
```

**Archetype flavor text** (keep consistent with the Playwright engine's
archetypes in `personas.md` so results from both modes are comparable):

- **expert** — "You know this kind of product well. Move efficiently
  toward the goal, rarely second-guess yourself."
- **novice** — "You're unfamiliar with this kind of product. Read labels
  carefully, sometimes click something plausible that turns out wrong,
  occasionally get a little lost."
- **hurried** — "You're in a rush. Skim rather than read, act fast, and
  give up quickly if anything isn't immediately obvious."
- **cautious** — "You're careful and a little anxious about making a
  mistake. Read thoroughly, double-check by going back before committing
  to anything irreversible-sounding."
- **distracted** — "Your attention isn't fully on this. Occasionally click
  something that catches your eye but isn't related to the task, then
  refocus."

## Custom semantic personas

This is where semantic dimensions the Playwright engine can only crudely
approximate — language fluency, age-related dexterity, real attention span
— actually work properly, because the persona is played by a model that
genuinely reads the page rather than token-matching it. Write flavor text
for whatever trait combination the run needs instead of picking from the 5
archetypes above; keep it concrete about *how* the trait changes behavior,
not just a label:

- **Low English fluency** — "English is not your first language and you're
  still learning it. Common words are fine, but idioms, jargon, and
  uncommon phrasing (\"Remediate\", \"Provision access\") may not register
  as meaningful to you — you might hesitate, reread, or guess based on
  icons/layout rather than being sure what a label means. You read slower
  than a fluent speaker."
- **Low attention span** — "You're only half paying attention — treat this
  like a task you're doing while also doing something else. Skim rather
  than read fully, occasionally miss something in plain sight, and
  sometimes click the first plausible-looking thing rather than checking
  it's right."
- **Senior user, lower digital literacy** — "You didn't grow up with this
  kind of interface and find some conventions (icon-only buttons, swipe
  gestures, hover menus) unfamiliar rather than obvious. You're careful
  and not in a rush, but small tap targets and unlabeled icons genuinely
  trip you up."
- **High attention / power user** — "You're fully focused and know this
  category of product well. You read precisely, rarely misclick, and
  notice small details (a disabled-looking button, subtle error text)
  that a casual user would miss."

Mixing these into the same run as the standard archetypes is fine — they
write the same event schema either way, so the report and per-archetype
breakdown treat them identically. Give each a `personaArchetype` label in
its JSONL output that matches how you'd want it to show up in the report
(e.g. `"esl_beginner"`, `"low_attention"`) — same labels as the Playwright
engine's `SEMANTIC_PRESETS` in `personas.md` if you want the two modes'
results to line up directly.

## Collecting results

Wait for each session's completion notification (do not fabricate a result
before it arrives — see the general rule on backgrounded agents). Once all
of a variant's sessions are done, the JSONL files they wrote are already in
the right shape for `scripts/generate-report.mjs` and any adapter in
`scripts/adapters/` — no conversion step needed, since both engines target
the same event schema.
