# Personas

Real usability results vary enormously with who's using the product — an
expert flies through a flow a novice gets stuck on. A synthetic panel that
runs the same "perfect" click-path N times just measures whether *a*
path exists, not whether real, varied humans can find it. The persona system
exists to make that variance show up in the data.

There are two ways to define a persona: the 5 built-in **archetypes** below
(quick shorthand), or a **semantic trait vector** — attention, tech
savviness, dexterity, language fluency, patience — which is the general
mechanism underneath everything, including the archetypes themselves. Use
traits directly whenever the built-in archetypes don't name the dimension
you actually care about (age-related dexterity, English fluency, attention
span, ...).

## Built-in archetypes

Five built-in archetypes (`scripts/lib/personas.mjs`), each a bundle of
parameters that feed the scent-based decision policy:

| Archetype | Behavior | Key parameters |
|---|---|---|
| `expert` | Knows what to look for, moves fast, rarely errs | low temperature (greedy), low misclick/backtrack, short dwell |
| `novice` | Explores more, hesitates, occasionally lost | high temperature, high misclick/backtrack, long dwell |
| `hurried` | Fast, skims, low patience for friction | short dwell, high misclick, **low patience budget** (abandons quickly) |
| `cautious` | Reads everything, double-checks before committing | long dwell, high backtrack (goes back to re-verify), low misclick |
| `distracted` | Occasional off-task noise clicks, uneven attention | moderate everything, **highest noise-click rate** |

Parameter meanings (in `ARCHETYPES`):

- **temperature** — softmax temperature over element scent scores. Lower =
  more greedily picks the highest-scoring (most task-relevant) element.
  Higher = closer to random exploration.
- **misclickProb** — chance a step deliberately picks a mid-scoring element
  instead of the best one, simulating a plausible-looking wrong click.
- **noiseClickProb** — chance a step picks a *completely* random element,
  simulating attention drift.
- **backtrackProb** — chance the session navigates back after a step even
  when not stuck, simulating double-checking or disorientation.
- **dwellMsRange** — pause range between actions (reading/deciding time).
- **readingSpeedFactor** — multiplier on dwell, scaled per archetype.
- **patienceSteps** — max steps before giving up. This is the parameter that
  makes `hurried` sessions abandon a clunky flow long before a `cautious`
  one would.

## Customizing the mix

Default mix (used when a config just sets `personas.count`) is roughly 20%
expert / 30% novice / 25% hurried / 15% cautious / 10% distracted — biased
toward the archetypes most likely to surface friction, since that's usually
what a comparison is trying to find.

Override per-run with `personas.mix` in the config (see
`config-schema.md`), or override individual parameters per archetype with
an `overrides` block on a mix entry:

```jsonc
{ "archetype": "novice", "count": 10, "overrides": { "patienceSteps": 15 } }
```

Add an entirely new archetype by adding an entry to `ARCHETYPES` in
`scripts/lib/personas.mjs` — it's just another parameter bundle, nothing
archetype-specific is hardcoded elsewhere in the engine.

## Semantic traits — attention, tech savvy, age-related dexterity, language fluency

A mix entry can use `traits` instead of `archetype` — a vector of five
dimensions, each 0-1, mapped to the engine's underlying parameters by
`traitsToParams()` in `scripts/lib/personas.mjs`:

| Trait | 0 means | 1 means | Mainly drives |
|---|---|---|---|
| `attention` | distractible, skims, misses things | highly focused, reads carefully | noise clicks (off-task actions) |
| `techSavvy` | unfamiliar with common UI conventions | expert with the medium | how reliably it follows the correct element, backtracking |
| `dexterity` | low motor precision (age-, ability-, or mobile-thumb-related) | precise | misclick rate |
| `languageFluency` | beginner/unfamiliar with the page's language | fully fluent | how reliably it follows correct wording, reading speed |
| `patience` | gives up fast under friction | persistent | how many steps it'll try before abandoning |

```jsonc
{ "name": "senior_shopper", "traits": { "attention": 0.6, "techSavvy": 0.2, "dexterity": 0.2, "languageFluency": 0.85, "patience": 0.7 }, "count": 8 }
```

`SEMANTIC_PRESETS` in `personas.mjs` names some common points in this space
so you don't have to hand-tune every run — reference them with `preset`
instead of `traits`:

```jsonc
{ "preset": "low_attention", "count": 10 }
{ "preset": "esl_beginner", "count": 10 }
```

Current presets: `high_attention`, `low_attention`, `distracted`,
`tech_savvy`, `tech_novice`, `senior_low_dexterity`, `young_digital_native`,
`esl_beginner`, `esl_intermediate`. Add more directly to that table, or
just pass a one-off `traits` vector in the config — presets are a
convenience, not a fixed taxonomy.

## Describing personas in plain language

You don't need to know any preset name or hand-pick numbers to get a
semantic persona — just describe the user segment in plain language (e.g.
"busy parents shopping on their phone, one eye on their kids" or "an older
user who's not a digital native but has plenty of time") and have Claude
translate that into a trait vector using the table above as a rubric,
showing its reasoning briefly (e.g. "distracted context → low attention;
no stated tech background → mid techSavvy; unhurried → high patience").
This is the intended default workflow, not a fallback — the fixed preset
names exist as convenient shorthand for common combinations, not as a
closed list you're limited to. When in doubt about a dimension the
description doesn't address, leave it at the neutral default in the
`traitsToParams()` signature rather than guessing.

**On "age group" specifically**: there's no `age` trait. Age itself isn't
what changes behavior — the underlying traits it correlates with (motor
precision, tech familiarity, reading speed) are, and different individuals
of the same age vary hugely on all three. Model the actual trait you mean
(`dexterity`, `techSavvy`, ...) rather than a blunt age number; a couple of
named presets (`senior_low_dexterity`, `young_digital_native`) exist as
starting points for the combinations people usually mean by "older users"
or "younger users."

**A real limitation, stated plainly**: this engine is hand-written scoring
heuristics, not a language model — it has no actual comprehension of page
text. `languageFluency` is approximated by adding decision noise and
slowing reading speed (as a stand-in for "doesn't reliably parse
wording"), not by judging whether specific copy is genuinely confusing.
It can't tell you "a beginner wouldn't understand the word 'Remediate'" —
it can only make a low-fluency persona click somewhat more randomly and
read somewhat more slowly, everywhere, uniformly. If you need that kind of
real semantic judgment (does *this specific copy* read as jargon to *this
specific persona*), use LLM-agent mode instead — see
`llm-agent-mode.md` — where the persona is played by an actual model
reading the real page and reasoning in character, not a scoring formula.
