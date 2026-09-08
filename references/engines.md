# Engines

Three ways to decide what a synthetic user clicks next, trading cost/speed
against fidelity. All three write the same event schema (`config-schema.md`)
and feed the same report generator — switching engines never changes
anything downstream.

| | Tier 1: Heuristic | Tier 2: LLM-scored | LLM-agent mode |
|---|---|---|---|
| `config.engine` | `"heuristic"` (default) | `"llm-scored"` | n/a — see `llm-agent-mode.md` |
| What scores each element | Token-overlap + position decay (`scent.mjs`) | A real model call per decision, narrowed to the top ~20 heuristic candidates first | A subagent reading the actual rendered page and reasoning in character |
| Real language comprehension | No | Yes | Yes, plus visual/layout judgment |
| Cost per session | ~free, no API calls | ~1 small model call per step | 1 full subagent turn per session |
| Practical scale | Dozens–hundreds of sessions | Tens of sessions comfortably | ~5–10 sessions |
| Needs | Nothing extra | `ANTHROPIC_API_KEY` (env or `config.llm.apiKey`) | Browser pane + subagent budget |

Default to Tier 1 for real scale. Reach for Tier 2 when the prototype's
copy is subtle enough that keyword-matching plausibly picks the wrong
element even after narrowing (dense pages, lots of similar-sounding
controls) but you still want more than ~10 sessions. Reach for LLM-agent
mode when the judgment itself has to be genuinely semantic — real
language-fluency effects, "does this copy read as trustworthy," anything
keyword-matching fundamentally can't see regardless of how it's scored.

## Tier 2 config

```jsonc
{
  "engine": "llm-scored",
  "llm": { "model": "claude-haiku-4-5-20251001" }, // optional, this is the default
  // ...rest of the config as normal
}
```

The API key is never read from the config file by default — set
`ANTHROPIC_API_KEY` in the environment, or pass `config.llm.apiKey`
explicitly if you're generating the config programmatically. If no key is
found, the run doesn't fail: every session logs one `error` event and
permanently falls back to the Tier 1 heuristic for the rest of that
session (not stalled, not crashed — just downgraded, with the downgrade
visible in the event log).

**Why the top-20 narrowing step, specifically**: a live sample pulled from
Mind2Web (see below) showed a *median* of ~200 raw candidate elements per
decision point on real complex pages, up to 900+. Sending all of them to a
model per step would be slow, expensive, and actually worse for accuracy —
the genuinely relevant element gets diluted in a sea of irrelevant ones.
The heuristic scorer does a cheap first pass; the model only re-ranks what
survives that pass. This mirrors Mind2Web's own retrieval-then-rank
pipeline rather than reinventing something.

## `cursorRealism`

```jsonc
{ "cursorRealism": true }
```

When on, clicks move the mouse along a curved, eased path (`cursor.mjs`)
instead of teleporting, calibrated against real speed/distance numbers
sampled from a public mouse-telemetry dataset (below). This is slower —
each click now takes real wall-clock time to "travel" — so it's a
deliberate opt-in, not a default. Two reasons it's worth the cost for a
smaller/high-fidelity run: it triggers genuine CSS `:hover` states along
the way (discovering hover-revealed controls the way a real cursor
would), and each click logs a `humanness` score (`meta.humanness` on the
`click` event) — a cheap self-check, inspired by bot-detection research
run in reverse, that our own generated movement doesn't look robotic
(constant speed / perfectly straight lines are the classic tell).

## Data sources this engine draws on

Verified directly (fetched and sampled during development, not assumed):

| Source | What it actually showed | How it's used here |
|---|---|---|
| [Mind2Web](https://huggingface.co/datasets/osunlp/Mind2Web) (osunlp) | Real crowdsourced action traces, 137 sites/31 domains. Sampled tasks averaged ~7-19 steps to complete; candidate-element counts per decision ranged from dozens to 900+ (median ~200). Element representation format: `[tag] label -> OPERATION`. | Directly shaped the Tier-2 prompt's element format and the top-20 narrowing design; the step-count range is a sanity check that `patienceSteps` defaults (14-50) are in a realistic ballpark. |
| [RecGaze](https://huggingface.co/datasets/santideleon/Rec-Gaze-Click-Cursor-Eye-Tracking-Movie-Recommendation-Dataset-for-Carousel-Interfaces) | Real gaze+click+cursor study, 87 users, 3,477 interactions on carousel UIs. Documented finding: a "golden triangle"/F-pattern scan pattern, not a uniform one. | Grounds the exponential position-decay term in `scent.mjs` and the `considerationSpan` mechanism in `personas.mjs` (attention limits *scan depth*, not just decision noise). |
| [dejanseo/mouse_movement_tracking](https://huggingface.co/datasets/dejanseo/mouse_movement_tracking) | Real browser telemetry, 685k events. Sampled "move" events: distance-per-~17ms-sample at p10/p50/p90 of 5/61/149px. | Calibrates the speed/duration curve in `cursor.mjs`. Used only as aggregate statistics, never literal replay — the dataset's README documents no collection/consent details, which is exactly why nothing here treats it as more than a rough speed reference. |

Checked but not directly integrated:

| Source | Why not (yet) |
|---|---|
| [WebChain](https://huggingface.co/datasets/webagentlab/webchain) (webagentlab) | Confirmed real trajectory-structured data for GUI-agent training, but it wasn't clear from the dataset card whether traces are human-sourced or agent-generated — didn't want to build a design decision on an unconfirmed distinction. Worth another look if you want to push on this further. |
| A fine-tuned Mind2Web checkpoint (e.g. an element-grounding model) | Would mean hosting a model (GPU, licensing review) for a lightweight Node/Playwright skill — disproportionate, and likely narrower than a general LLM call for prototypes it's never seen. Tier 2 solves the same problem Mind2Web's own models are trained for, via a general model instead. |

Referenced from general knowledge (not fetched/verified this session — check
before relying on specifics):

- **WebArena / VisualWebArena** — human-annotated multi-step tasks on real
  self-hosted sites, each with an explicit programmatic success check.
  Worth a look if you want sharper guidance on writing `successCriteria` —
  their tasks are a good model for "success" being a checkable fact about
  end state, not a vibe.
- **MiniWoB++** — simpler simulated web-interaction benchmark with human
  demonstration timing. A loose sanity check that this engine's default
  timing budgets aren't wildly off from real human interaction speed.
- **WebShop** — synthetic e-commerce benchmark (browse → select → cart →
  checkout) with human demonstrations. There's no verified public no-auth
  demo storefront to build a working example against right now (the two
  candidates checked while building this — OpenCart's demo and
  SauceDemo — are Cloudflare-blocked and password-gated respectively), so
  this shaped the *shape* of an e-commerce task rather than a shippable
  example. See the funnel structure in `examples/ecommerce-template-config.json`.
- **Balabit Mouse Dynamics Challenge** and similar bot-detection corpora —
  built to *catch* robotic mouse movement, which is the same signal run in
  reverse for the `humannessScore()` self-check in `cursor.mjs`.
