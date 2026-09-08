// Persona system for the Playwright heuristic engine. Two ways to define a
// persona:
//
//  1. `archetype` — one of the 5 built-in presets below (expert/novice/
//     hurried/cautious/distracted). Kept for backward compatibility and as
//     quick shorthand.
//  2. `traits` — a semantic trait vector (attention, techSavvy, dexterity,
//     languageFluency, patience, each 0-1) that gets mapped to the same
//     underlying behavioral parameters via traitsToParams(). This is the
//     general mechanism: it's what "high attention", "distracted", "tech
//     savvy", "senior with low dexterity", "ESL beginner" etc. actually are
//     underneath — SEMANTIC_PRESETS below just names some common points in
//     that space.
//
// IMPORTANT LIMITATION, stated up front: this engine is hand-written
// heuristics, not a language model — it has no real comprehension of page
// text. `languageFluency` and similar traits are approximated by adding
// randomness and slowing down scent-following (as a stand-in for "doesn't
// reliably parse wording"), not by actually judging whether specific button
// copy is jargon-y or clear. For that kind of genuine semantic judgment
// (e.g. "would a low-literacy user understand the word 'Remediate'?"), use
// LLM-agent mode instead — see references/llm-agent-mode.md — where the
// persona is played by an actual model reasoning over the real page text.

export const ARCHETYPES = {
  expert: {
    label: "Expert",
    // Lower temperature = more greedily follows the highest-scent element.
    temperature: 0.35,
    misclickProb: 0.03,
    backtrackProb: 0.04,
    dwellMsRange: [200, 700],
    readingSpeedFactor: 0.6,
    patienceSteps: 40,
    noiseClickProb: 0.01,
    // How many of the top-scoring candidates a persona even notices before
    // choosing among them — see the comment on considerationSpan below.
    considerationSpan: 18,
  },
  novice: {
    label: "Novice",
    temperature: 0.9,
    misclickProb: 0.14,
    backtrackProb: 0.18,
    dwellMsRange: [900, 2600],
    readingSpeedFactor: 1.4,
    patienceSteps: 30,
    noiseClickProb: 0.05,
    considerationSpan: 12,
  },
  hurried: {
    label: "Hurried",
    temperature: 0.7,
    misclickProb: 0.2,
    backtrackProb: 0.08,
    dwellMsRange: [150, 500],
    readingSpeedFactor: 0.4,
    // Hurried users bail fast when they hit friction.
    patienceSteps: 16,
    noiseClickProb: 0.04,
    considerationSpan: 6,
  },
  cautious: {
    label: "Cautious",
    temperature: 0.5,
    misclickProb: 0.02,
    backtrackProb: 0.22,
    dwellMsRange: [1200, 3200],
    readingSpeedFactor: 1.8,
    patienceSteps: 45,
    noiseClickProb: 0.01,
    considerationSpan: 20,
  },
  distracted: {
    label: "Distracted",
    temperature: 1.15,
    misclickProb: 0.16,
    backtrackProb: 0.12,
    dwellMsRange: [400, 2000],
    readingSpeedFactor: 1.0,
    patienceSteps: 25,
    noiseClickProb: 0.12,
    considerationSpan: 5,
  },
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Maps a semantic trait vector to the engine's underlying behavioral
// parameters. Each formula is deliberately simple and documented so the
// mapping stays auditable — "why did a low-dexterity persona misclick more"
// should have a one-line answer, not a black box.
//
//   attention        0 = distractible/skims        1 = highly focused
//   techSavvy        0 = unfamiliar with UI conventions   1 = expert
//   dexterity        0 = low motor precision (small targets, mobile thumbs,
//                        age- or ability-related)          1 = precise
//   languageFluency  0 = beginner/unfamiliar with the page's language
//                        (idioms, jargon land less reliably)   1 = fluent
//   patience         0 = gives up fast under friction   1 = persistent
//
// All five default to a neutral-ish baseline if omitted, so a partial trait
// vector (e.g. just { languageFluency: 0.2 }) still produces something
// sane rather than an error.
export function traitsToParams(rawTraits = {}) {
  const attention = clamp01(rawTraits.attention ?? 0.5);
  const techSavvy = clamp01(rawTraits.techSavvy ?? 0.5);
  const dexterity = clamp01(rawTraits.dexterity ?? 0.7);
  const languageFluency = clamp01(rawTraits.languageFluency ?? 0.85);
  const patience = clamp01(rawTraits.patience ?? 0.5);

  // How reliably the persona follows the highest-scent (most task-relevant)
  // element, vs. wandering. Low tech familiarity and low fluency both erode
  // this — for different reasons (unfamiliar UI patterns vs. unfamiliar
  // wording) — so they're summed rather than picking one.
  const temperature = 0.3 + (1 - techSavvy) * 0.5 + (1 - languageFluency) * 0.35;

  // Misclicks: motor precision matters most, tech unfamiliarity a bit too
  // (tapping the wrong-but-similar-looking control).
  const misclickProb = 0.02 + (1 - dexterity) * 0.16 + (1 - techSavvy) * 0.06;

  // Backtracking/double-checking: low confidence (low techSavvy) and
  // correcting mis-taps (low dexterity) both drive this up.
  const backtrackProb = 0.03 + (1 - techSavvy) * 0.1 + (1 - dexterity) * 0.08;

  // Off-task noise clicks are attention's signature effect.
  const noiseClickProb = 0.01 + (1 - attention) * 0.15;

  // Low fluency means reading takes longer per word of copy.
  const readingSpeedFactor = 0.5 + (1 - languageFluency) * 1.1;

  // Patience budget in steps before giving up.
  const patienceSteps = Math.round(14 + patience * 36);

  // How many of the top-scoring candidates on screen a persona even
  // notices before choosing among them — not a decision-quality effect,
  // a scan-depth one. Eye-tracking research on list/carousel UIs (e.g.
  // RecGaze) finds attention concentrated in a "golden triangle"/F-pattern
  // rather than spread evenly; a low-attention persona doesn't evaluate an
  // element buried at position 15 worse, it just never looks that far.
  const considerationSpan = Math.round(4 + attention * 18);

  // Dwell time: impatience and low attention both shorten it (rasher,
  // faster actions); low fluency lengthens it (via readingSpeedFactor
  // above, applied on top of this base range).
  const dwellMin = Math.max(120, Math.round(250 - (1 - patience) * 100 - (1 - attention) * 80));
  const dwellMax = Math.round(dwellMin + 600 + (1 - patience) * 800 + (1 - attention) * 400);

  return {
    temperature: Number(temperature.toFixed(2)),
    misclickProb: Number(misclickProb.toFixed(3)),
    backtrackProb: Number(backtrackProb.toFixed(3)),
    dwellMsRange: [dwellMin, dwellMax],
    readingSpeedFactor: Number(readingSpeedFactor.toFixed(2)),
    patienceSteps,
    noiseClickProb: Number(noiseClickProb.toFixed(3)),
    considerationSpan,
  };
}

// Named points in trait-space for the dimensions people ask for most often.
// These are starting points, not a fixed taxonomy — pass `traits` directly
// in config for anything more specific (see config-schema.md).
export const SEMANTIC_PRESETS = {
  high_attention: { attention: 0.92, techSavvy: 0.6, dexterity: 0.8, languageFluency: 0.9, patience: 0.6 },
  low_attention: { attention: 0.15, techSavvy: 0.6, dexterity: 0.8, languageFluency: 0.9, patience: 0.4 },
  distracted: { attention: 0.1, techSavvy: 0.5, dexterity: 0.7, languageFluency: 0.85, patience: 0.3 },
  tech_savvy: { attention: 0.7, techSavvy: 0.95, dexterity: 0.85, languageFluency: 0.9, patience: 0.5 },
  tech_novice: { attention: 0.6, techSavvy: 0.15, dexterity: 0.6, languageFluency: 0.85, patience: 0.6 },
  senior_low_dexterity: { attention: 0.6, techSavvy: 0.25, dexterity: 0.2, languageFluency: 0.85, patience: 0.7 },
  young_digital_native: { attention: 0.5, techSavvy: 0.9, dexterity: 0.9, languageFluency: 0.9, patience: 0.3 },
  esl_beginner: { attention: 0.6, techSavvy: 0.5, dexterity: 0.75, languageFluency: 0.15, patience: 0.6 },
  esl_intermediate: { attention: 0.6, techSavvy: 0.5, dexterity: 0.75, languageFluency: 0.5, patience: 0.6 },
};

const DEFAULT_MIX = [
  ["expert", 0.2],
  ["novice", 0.3],
  ["hurried", 0.25],
  ["cautious", 0.15],
  ["distracted", 0.1],
];

// Resolve one mix entry to {label, params}. Priority: explicit `traits` >
// named `preset` (from SEMANTIC_PRESETS) > legacy `archetype` (from
// ARCHETYPES). `overrides` layers on top of whichever base was used, for
// one-off tweaks without defining a whole new persona.
function resolveSpec(spec) {
  let label;
  let base;
  if (spec.traits) {
    label = spec.name || "custom";
    base = traitsToParams(spec.traits);
  } else if (spec.preset) {
    const traits = SEMANTIC_PRESETS[spec.preset];
    if (!traits) throw new Error(`Unknown persona preset "${spec.preset}". Valid: ${Object.keys(SEMANTIC_PRESETS).join(", ")}`);
    label = spec.name || spec.preset;
    base = traitsToParams(traits);
  } else if (spec.archetype) {
    const archetype = ARCHETYPES[spec.archetype];
    if (!archetype) throw new Error(`Unknown persona archetype "${spec.archetype}". Valid: ${Object.keys(ARCHETYPES).join(", ")}`);
    label = spec.name || spec.archetype;
    base = archetype;
  } else {
    throw new Error(`Persona mix entry needs one of: archetype, preset, or traits. Got: ${JSON.stringify(spec)}`);
  }
  return { label, params: { ...base, ...(spec.overrides || {}) } };
}

// Expand a `personas` config entry into a flat list of {id, archetype, params}.
// Accepts an explicit `mix` of entries (each using archetype/preset/traits,
// see above), or a plain `count`, in which case DEFAULT_MIX distributes it
// across the 5 built-in archetypes so a run of "20 users" isn't 20 identical
// bots.
export function buildPersonaRoster(personasConfig, fallbackCount = 10) {
  const roster = [];
  let specs = personasConfig?.mix;

  if (!specs || specs.length === 0) {
    const total = personasConfig?.count ?? fallbackCount;
    specs = DEFAULT_MIX.map(([archetype, share]) => ({
      archetype,
      count: Math.max(0, Math.round(total * share)),
    }));
    const drift = total - specs.reduce((s, x) => s + x.count, 0);
    if (drift !== 0) specs[0].count += drift;
  }

  for (const spec of specs) {
    const { label, params } = resolveSpec(spec);
    for (let i = 0; i < spec.count; i++) {
      roster.push({ id: `${label}-${i + 1}`, archetype: label, params });
    }
  }
  return roster;
}
