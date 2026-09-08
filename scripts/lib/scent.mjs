// Information-scent scoring: this is what lets the engine navigate a prototype
// it has never seen before, with no hardcoded selectors. It's the same model
// real users are believed to use (SNIF-ACT / information foraging theory) —
// people click whatever nearby text most resembles the thing they're trying
// to accomplish. Score every visible interactive element against the task's
// keywords, then let the persona's temperature decide how strictly to follow
// the highest score vs. wander.

const ACTION_VERBS = [
  "submit", "save", "continue", "next", "confirm", "add", "create", "resolve",
  "checkout", "buy", "purchase", "sign", "complete", "apply", "start", "finish",
  "done", "go", "search", "find", "open", "view", "select", "choose", "delete",
  "remove", "edit", "update", "send", "post", "login", "log in", "sign in",
];

function tokenize(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function jaccard(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  let overlap = 0;
  for (const t of a) if (b.has(t)) overlap++;
  return overlap / (a.size + b.size - overlap);
}

// `keywords` is an array of strings/phrases pulled from the task description
// and any explicit hints the user supplied. `element` has {text, aria, placeholder,
// name, title, tag, role, index, y}.
export function scoreElement(element, keywords) {
  // `context` is proximity text (a <label>, or the enclosing row/list-item)
  // pulled in only for controls with no accessible text of their own — an
  // icon-only checkbox next to "Buy the blue mug" should still score against
  // "buy"/"mug", the way a human reads the row, not just the bare control.
  const elTokens = tokenize(
    [element.text, element.aria, element.placeholder, element.name, element.title, element.context].join(" ")
  );
  const kwTokens = tokenize(keywords.join(" "));

  let score = jaccard(elTokens, kwTokens) * 3;
  // Context-sourced matches are a weaker signal than the control's own
  // label, so give them a smaller independent bonus rather than letting
  // them dominate via jaccard alone.
  if (element.context) {
    const ctxTokens = tokenize(element.context);
    score += jaccard(ctxTokens, kwTokens) * 1.2;
  }

  // Substring bonus: a whole keyword phrase appearing verbatim is a much
  // stronger signal than scattered token overlap.
  const haystack = (element.text || "").toLowerCase();
  for (const kw of keywords) {
    const k = kw.toLowerCase().trim();
    if (k.length > 2 && haystack.includes(k)) score += 1.5;
  }

  // Generic action-verb bonus — real users are drawn to buttons that sound
  // like "do a thing" even when the wording doesn't match the task exactly.
  for (const verb of ACTION_VERBS) {
    if (haystack.includes(verb)) {
      score += 0.3;
      break;
    }
  }

  // Role/tag priors: primary interactive controls read as more "clickable"
  // than incidental ones.
  if (["button", "submit"].includes(element.role) || element.tag === "button") score += 0.4;
  if (element.tag === "a") score += 0.2;
  if (element.tag === "input" || element.tag === "select" || element.tag === "textarea") score += 0.1;

  // Position bias: real scanning isn't uniform — eye-tracking studies of
  // list/carousel UIs consistently find a steep "golden triangle"/F-pattern
  // drop-off (e.g. RecGaze, a controlled gaze+click+cursor study of 87 users
  // across 40 carousel interfaces) rather than a flat or gently-sloped one.
  // An exponential decay matches that shape much better than a linear one:
  // strong pull toward the first few elements, a long, nearly-flat tail
  // rather than a cliff.
  score += 0.6 * Math.exp(-element.index / 6);

  return Math.max(0, score);
}

// Weighted-random pick over scored candidates using a softmax with the
// persona's `temperature`. Low temperature -> near-greedy (experts). High
// temperature -> close to uniform random (lost/novice users).
export function weightedPick(candidates, scores, temperature, rng = Math.random) {
  if (candidates.length === 0) return null;
  const maxScore = Math.max(...scores);
  const weights = scores.map((s) => Math.exp((s - maxScore) / Math.max(temperature, 0.05)));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) return { item: candidates[i], score: scores[i], index: i };
  }
  const last = candidates.length - 1;
  return { item: candidates[last], score: scores[last], index: last };
}

export function extractKeywords(task) {
  const kws = new Set();
  for (const kw of task.keywords || []) kws.add(kw);
  // Pull a few content words out of the free-text description too, so a task
  // with no explicit keyword list still has something to score against.
  for (const t of tokenize(task.description || "")) {
    if (t.length > 3) kws.add(t);
  }
  return [...kws];
}
