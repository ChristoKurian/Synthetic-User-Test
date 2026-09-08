// Tier-2 scoring: replaces the pure heuristic scent score with a real
// language model's judgment of which candidate element best matches the
// task. This is the same problem Mind2Web (osunlp/Mind2Web) trains
// specialist "element grounding" models for — task description + candidate
// elements -> which one a human would act on — solved here with a general
// model call instead of a fine-tuned checkpoint, so it generalizes to any
// unseen prototype with no training step and no hosting.
//
// Two-stage design, deliberately mirroring Mind2Web's own retrieval-then-
// rank pipeline rather than sending everything to the model: a real sample
// pulled from the dataset (5 tasks, Sept 2026) showed a MEDIAN of ~200 raw
// candidate elements per decision point, up to 900+ on complex pages. That
// validates why this can't be "send every element to the LLM" — it would
// be both expensive and worse for accuracy (context dilution drowns the
// genuinely relevant elements in noise). So: the cheap heuristic scorer
// (scent.mjs) does a first-pass narrow to the top N by scent score, and
// only that narrowed set goes to the model for re-scoring.

import { scoreElement } from "./scent.mjs";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001"; // fast + cheap — this is a per-step classification call, not a reasoning task
const NARROW_TO = 20;

function formatElement(el, idx) {
  // Mirrors Mind2Web's own compact element representation in its
  // human-readable `action_reprs` field: "[tag]  label -> OPERATION".
  // Confirmed directly from a live sample of the dataset rather than
  // assumed — that's a deliberate design choice, not incidental.
  //
  // `context` (nearby row/label text, populated by collectInteractiveElements
  // only for icon-only controls with no label of their own) matters most
  // for exactly the elements that would otherwise show up blank here — an
  // unlabeled checkbox next to "Buy milk" needs that text to be scoreable
  // at all, same reasoning as the heuristic scorer's own context handling.
  const label = (el.text || el.aria || el.placeholder || el.name || el.context || "").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${idx}: [${el.tag}${el.type ? ":" + el.type : ""}] ${label}`;
}

// Resolve the API key: explicit `apiKey` argument wins, then
// ANTHROPIC_API_KEY from the environment. Never hardcode or prompt for it
// any other way — same rule as every other credential this skill touches.
export function resolveApiKey(explicit) {
  return explicit || process.env.ANTHROPIC_API_KEY || null;
}

// Returns a full-length array of 0-1 scores, one per input element (0 for
// anything outside the narrowed top-N, since a persona's ordinary decision
// process never considers those — a noise-click samples the full list
// independent of score, so this doesn't cut off "surprise" clicks).
export async function scoreElementsWithLLM({ elements, task, keywords, apiKey, model = DEFAULT_MODEL, fetchImpl = fetch }) {
  if (!elements.length) return [];
  const key = resolveApiKey(apiKey);
  if (!key) throw new Error("No Anthropic API key available (set ANTHROPIC_API_KEY or pass one explicitly)");

  const heuristicScores = elements.map((el) => scoreElement(el, keywords));
  const ranked = elements
    .map((el, i) => ({ el, i, s: heuristicScores[i] }))
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.min(NARROW_TO, elements.length));

  const listing = ranked.map((r, j) => formatElement(r.el, j)).join("\n");
  const prompt = `A person is trying to accomplish this task on a web page: "${task.description}"
${task.keywords?.length ? `Relevant keywords: ${task.keywords.join(", ")}` : ""}

Below are ${ranked.length} clickable/typeable elements currently visible on the page, listed in no particular order. For EACH one, score how likely a real person pursuing this task would interact with it next — 0 means clearly irrelevant, 10 means exactly what they're looking for.

${listing}

Respond with ONLY a JSON array of ${ranked.length} numbers, one per line above in order, and nothing else. Example: [2, 0, 7, 10, 1]`;

  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`LLM scoring request failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.content?.[0]?.text || "";
  const match = text.match(/\[[\s\S]*?\]/);
  if (!match) throw new Error(`Could not find a JSON array in LLM response: ${text.slice(0, 200)}`);

  let llmScores;
  try {
    llmScores = JSON.parse(match[0]);
  } catch {
    throw new Error(`LLM response wasn't valid JSON: ${match[0].slice(0, 200)}`);
  }
  if (!Array.isArray(llmScores) || llmScores.length !== ranked.length) {
    throw new Error(`LLM returned ${llmScores?.length ?? "?"} scores, expected ${ranked.length}`);
  }

  const fullScores = new Array(elements.length).fill(0);
  ranked.forEach((r, j) => {
    fullScores[r.i] = Math.max(0, Number(llmScores[j]) || 0) / 10;
  });
  return fullScores;
}
