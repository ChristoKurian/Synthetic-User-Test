#!/usr/bin/env node
// Core engine: drives headless Chromium sessions against one or more prototype
// URLs, each session played by a synthetic persona pursuing the configured
// task via information-scent (see lib/scent.mjs). No selectors are hardcoded
// per-target — this is what makes the same script work against any prototype.
//
// Usage: node run-synthetic-test.mjs <config.json>
// Config schema: see references/config-schema.md

import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildPersonaRoster } from "./lib/personas.mjs";
import { scoreElement, weightedPick, extractKeywords } from "./lib/scent.mjs";
import { JsonlWriter, makeEvent } from "./lib/events.mjs";
import { scoreElementsWithLLM, resolveApiKey } from "./lib/llm-scorer.mjs";
import { humanMouseMove, humannessScore } from "./lib/cursor.mjs";

async function collectInteractiveElements(page, scopePrefix) {
  return page.evaluate((scopePrefix) => {
    const SELECTOR =
      "a[href], button, [role=button], [role=link], [role=menuitem], " +
      "input:not([type=hidden]):not([disabled]), select, textarea, summary, [onclick]";
    const nodes = Array.from(document.querySelectorAll(SELECTOR));
    const seen = new Set();
    const out = [];
    let idx = 0;
    const prefixWithSlash = scopePrefix.endsWith("/") ? scopePrefix : scopePrefix + "/";
    const inScope = (pathname) => pathname === scopePrefix || pathname.startsWith(prefixWithSlash);

    // Icon-only buttons and bare checkboxes/toggles ("mark complete", "select
    // row", "delete") often carry no accessible text of their own — a human
    // reads the label or row text sitting next to them instead. Without this,
    // exactly the kind of control a task usually cares about (a per-item
    // toggle) scores near zero forever and never gets picked.
    function nearbyContextText(el) {
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl && lbl.innerText && lbl.innerText.trim()) return lbl.innerText.trim().slice(0, 120);
      }
      const wrappingLabel = el.closest("label");
      if (wrappingLabel && wrappingLabel.innerText && wrappingLabel.innerText.trim()) {
        return wrappingLabel.innerText.trim().slice(0, 120);
      }
      const row = el.closest('li, tr, [role="listitem"], [role="row"]');
      if (row && row.innerText && row.innerText.trim()) return row.innerText.trim().slice(0, 120);
      return "";
    }

    for (const el of nodes) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      // Deliberately NOT checking opacity: custom-styled checkboxes/radios
      // very commonly keep the native input at opacity:0 (real size, real
      // hit target) while drawing a fake control via CSS on a sibling — that
      // element is exactly as clickable as a real user's mouse would find
      // it, opacity notwithstanding.
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      if (!visible) continue;

      const tag = el.tagName.toLowerCase();
      const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 120);
      const placeholder = el.getAttribute("placeholder") || "";
      if (!text && !placeholder && !["input", "select", "textarea"].includes(tag)) continue;

      // Stay within the prototype variant being tested. Same-origin isn't a
      // tight enough boundary on its own: a logo/home link often leads back
      // to a parent site that then fans out into unrelated pages (or, worse,
      // a sibling variant deployed under the same domain) — scope to the
      // variant's own URL path, not just its hostname.
      if (tag === "a") {
        const href = el.getAttribute("href") || "";
        if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
          try {
            const resolved = new URL(href, location.href);
            if (resolved.hostname !== location.hostname || !inScope(resolved.pathname)) continue;
          } catch {
            /* relative or unparsable href — treat as in-scope */
          }
        }
      }

      const key = tag + "|" + text + "|" + Math.round(rect.top) + "|" + Math.round(rect.left);
      if (seen.has(key)) continue;
      seen.add(key);

      const type = el.getAttribute("type") || "";
      const needsContext = !text && !placeholder && (tag === "input" ? ["checkbox", "radio"].includes(type) : true);

      el.setAttribute("data-suid", String(idx));
      out.push({
        suid: idx,
        text,
        aria: el.getAttribute("aria-label") || "",
        placeholder,
        context: needsContext ? nearbyContextText(el) : "",
        name: el.getAttribute("name") || "",
        title: el.getAttribute("title") || "",
        tag,
        role: el.getAttribute("role") || "",
        type,
        href: el.getAttribute("href") || "",
        index: idx,
        y: Math.round(rect.top + window.scrollY),
      });
      idx++;
    }
    return out;
  }, scopePrefix);
}

async function detectAuthWall(page) {
  const hasPassword = await page.locator("input[type=password]").first().isVisible().catch(() => false);
  return hasPassword;
}

// Some tasks leave no lasting trace to snapshot — "add an element, then
// delete it" ends in the exact DOM state it started in. Those need a
// criterion over the session's own action history (did it click something
// matching each keyword, in order) rather than a check of current page state.
function actionSequenceMatched(actionHistory, keywords) {
  let i = 0;
  for (const text of actionHistory) {
    if (i >= keywords.length) break;
    if (text.includes(String(keywords[i]).toLowerCase())) i++;
  }
  return i >= keywords.length;
}

async function checkCriteria(page, criteria, actionHistory = []) {
  if (!criteria || !criteria.length) return null;
  const url = page.url();
  for (const c of criteria) {
    try {
      if (c.type === "urlContains" && url.includes(c.value)) return c;
      if (c.type === "urlMatches" && new RegExp(c.value).test(url)) return c;
      if (c.type === "actionSequence" && actionSequenceMatched(actionHistory, c.value)) return c;
      if (c.type === "textVisible") {
        const found = await page.getByText(c.value, { exact: false }).first().isVisible({ timeout: 500 }).catch(() => false);
        if (found) return c;
      }
      if (c.type === "selectorVisible") {
        const found = await page.locator(c.value).first().isVisible({ timeout: 500 }).catch(() => false);
        if (found) return c;
      }
      if (c.type === "selectorHidden") {
        const found = await page.locator(c.value).first().isVisible({ timeout: 500 }).catch(() => false);
        if (!found) return c;
      }
    } catch {
      // criteria checks are best-effort; a transient failure just means "not matched yet"
    }
  }
  return null;
}

// Tier 2 (config.engine === "llm-scored"): a real model scores the
// candidate elements instead of the token-overlap heuristic. See
// lib/llm-scorer.mjs for the design (grounded in Mind2Web's task/candidate
// format and scale). Falls back to the heuristic — permanently, for the
// rest of this session, not just this step — the first time the LLM call
// fails, so one bad response or a missing key degrades gracefully instead
// of stalling or crashing a whole run.
async function computeBaseScores(elements, task, keywords, config, sessionState, log) {
  if (config.engine === "llm-scored" && !sessionState.llmDowngraded) {
    try {
      return await scoreElementsWithLLM({ elements, task, keywords, apiKey: config.llm?.apiKey, model: config.llm?.model });
    } catch (err) {
      sessionState.llmDowngraded = true;
      log("error", { meta: { message: `LLM scoring failed, falling back to heuristic for the rest of this session: ${String(err).slice(0, 200)}` } });
    }
  }
  return elements.map((el) => scoreElement(el, keywords));
}

// When config.cursorRealism is on, moves the mouse along a curved,
// eased path (lib/cursor.mjs) before clicking, instead of Playwright's
// default teleport-click. Falls back to a plain click on any failure
// (missing bounding box, race with a re-render, etc.) — this is a realism
// upgrade, not something that should ever be the reason a session fails.
async function clickWithCursor(page, locator, config, mouseState) {
  if (!config.cursorRealism) {
    try {
      await locator.click({ timeout: 4000 });
    } catch {
      await locator.click({ timeout: 3000, force: true });
    }
    return null;
  }
  try {
    const box = await locator.boundingBox({ timeout: 3000 });
    if (!box) throw new Error("no bounding box");
    const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const { trace } = await humanMouseMove(page, mouseState.pos, target);
    mouseState.pos = target;
    await page.mouse.down();
    await page.mouse.up();
    return humannessScore(trace);
  } catch {
    try {
      await locator.click({ timeout: 4000 });
    } catch {
      await locator.click({ timeout: 3000, force: true });
    }
    return null;
  }
}

function fakeValueFor(el, task) {
  const label = (el.placeholder || el.aria || el.name || "").toLowerCase();
  if (label.includes("email")) return "synthetic.user+test@example.com";
  if (label.includes("search")) return (task.keywords && task.keywords[0]) || task.description?.split(" ").slice(0, 2).join(" ") || "test";
  if (el.type === "number") return String(Math.floor(Math.random() * 100) + 1);
  if (el.tag === "textarea") return "Synthetic usability-test session — auto-generated input.";
  return (task.keywords && task.keywords[0]) || "Test";
}

async function runSession({ browser, variant, task, persona, outDir, config }) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: `SyntheticUsabilityTest/1.0 (${persona.archetype})`,
  });
  const page = await context.newPage();
  const sessionId = `${persona.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const base = { sessionId, variant: variant.name, personaId: persona.id, personaArchetype: persona.archetype };
  const scopePrefix = new URL(variant.url).pathname;
  const writer = new JsonlWriter(join(outDir, variant.name, `${sessionId}.jsonl`));
  const start = Date.now();
  const keywords = extractKeywords(task);
  const history = [];
  const actionTextHistory = [];
  const usedCounts = new Map();
  let step = 0;
  let outcome = "abandoned";
  let lastTargetSuid = null;
  let lastClickTime = 0;
  let rageStreak = 0;
  let visitedNonHome = false;
  const sessionState = { llmDowngraded: false };
  const mouseState = { pos: { x: 640, y: 400 } };

  const targetKey = (el) => `${el.tag}|${el.text}|${el.placeholder}|${el.name}`;

  const log = (event, extra = {}) =>
    writer.write(makeEvent({ ...base, step, tMs: Date.now() - start }, event, { pageUrl: page.url(), ...extra }));

  try {
    await page.goto(variant.url, { waitUntil: "domcontentloaded", timeout: 20000 });
    log("session_start");

    if (await detectAuthWall(page)) {
      log("auth_wall_detected");
      outcome = "blocked";
      await writer.close();
      await context.close();
      return { sessionId, outcome, steps: step, durationMs: Date.now() - start };
    }

    while (step < persona.params.patienceSteps && Date.now() - start < config.maxDurationMs) {
      step++;

      const matched = await checkCriteria(page, task.successCriteria, actionTextHistory);
      if (matched) {
        log("task_completed", { meta: { matched } });
        outcome = "success";
        break;
      }
      const failedMatch = await checkCriteria(page, task.failureCriteria, actionTextHistory);
      if (failedMatch) {
        log("task_failed", { meta: { matched: failedMatch } });
        outcome = "failed";
        break;
      }

      if (step % 3 === 0) {
        await page.mouse.wheel(0, 400 + Math.random() * 400).catch(() => {});
      }

      const elements = await collectInteractiveElements(page, scopePrefix);
      if (!elements.length) {
        log("dead_end", { meta: { reason: "no_interactive_elements" } });
        outcome = "abandoned";
        break;
      }

      // Real users don't repeat an action forever — once something's been
      // tried, its pull fades so attention shifts to what's new on the page
      // (e.g. the item just created, or the next step in the flow) instead
      // of re-submitting the same form indefinitely.
      const baseScores = await computeBaseScores(elements, task, keywords, config, sessionState, log);
      const scores = baseScores.map((raw, i) => {
        const used = usedCounts.get(targetKey(elements[i])) || 0;
        return raw * Math.pow(0.35, used);
      });

      // A persona only *considers* its top-scoring N elements before
      // choosing among them — considerationSpan (see personas.mjs) models
      // attention-limited scan depth, not decision quality. A noise click
      // is exempt: it represents attention drifting to something outside
      // the considered set entirely (an ad, an unrelated nav item), so it
      // samples from every element on the page, not just the considered ones.
      let pick;
      if (Math.random() < persona.params.noiseClickProb) {
        const idx = Math.floor(Math.random() * elements.length);
        pick = { item: elements[idx], score: scores[idx] };
      } else {
        const ranked = elements
          .map((e, i) => ({ e, s: scores[i] }))
          .sort((a, b) => b.s - a.s)
          .slice(0, Math.max(1, persona.params.considerationSpan || elements.length));
        const consideredElements = ranked.map((r) => r.e);
        const consideredScores = ranked.map((r) => r.s);

        if (Math.random() < persona.params.misclickProb) {
          const midPool = ranked.slice(Math.floor(ranked.length * 0.3), Math.floor(ranked.length * 0.7));
          const choice = midPool[Math.floor(Math.random() * midPool.length)] || ranked[0];
          pick = { item: choice.e, score: choice.s };
        } else {
          pick = weightedPick(consideredElements, consideredScores, persona.params.temperature);
        }
      }
      if (!pick) {
        outcome = "abandoned";
        break;
      }

      const target = pick.item;
      const [dMin, dMax] = persona.params.dwellMsRange;
      const dwell = (dMin + Math.random() * (dMax - dMin)) * persona.params.readingSpeedFactor;
      await page.waitForTimeout(Math.min(dwell, 4000));

      const locator = page.locator(`[data-suid="${target.suid}"]`).first();
      try {
        const isTextInput =
          ["input", "textarea"].includes(target.tag) &&
          !["checkbox", "radio", "submit", "button"].includes(target.type);
        if (isTextInput) {
          if (target.type === "password") {
            log("auth_wall_detected", { target });
            outcome = "blocked";
            break;
          }
          await locator.fill(fakeValueFor(target, task), { timeout: 5000 });
          log("type", { target, scentScore: pick.score });

          // Many single-line inputs (search boxes, todo/chat entry, quick-add
          // fields) have no visible submit button at all — real users just
          // press Enter. Do the same most of the time so those flows aren't
          // permanently unreachable to the engine.
          const singleLine = target.tag === "input" && ["text", "search", "email", "tel", "url", ""].includes(target.type);
          if (singleLine && Math.random() < 0.7) {
            await locator.press("Enter", { timeout: 3000 }).catch(() => {});
          }
        } else {
          // clickWithCursor handles its own fallback to a plain (possibly
          // forced) click — see its comment for why: hover-revealed row
          // controls in particular need the force-click escape hatch
          // regardless of whether cursor realism is on.
          const humanness = await clickWithCursor(page, locator, config, mouseState);
          log("click", { target, scentScore: pick.score, meta: humanness ? { humanness } : {} });
        }
      } catch (err) {
        log("error", { target, meta: { message: String(err).slice(0, 200) } });
        continue;
      }

      usedCounts.set(targetKey(target), (usedCounts.get(targetKey(target)) || 0) + 1);
      actionTextHistory.push((target.text || target.aria || target.placeholder || "").toLowerCase());
      if (page.url() !== variant.url) visitedNonHome = true;

      const now = Date.now();
      if (lastTargetSuid === target.suid && now - lastClickTime < 2500) {
        rageStreak++;
        if (rageStreak >= 2) log("rage_click", { target });
      } else {
        rageStreak = 0;
      }
      lastTargetSuid = target.suid;
      lastClickTime = now;

      const url = page.url();
      history.push(url);
      if (history.length > 6) history.shift();
      if (history.filter((u) => u === url).length >= 3) {
        log("backtrack_loop", { meta: { url } });
      }

      // Only backtrack if we've actually navigated somewhere — otherwise
      // page.goBack() walks past the session's own start URL into the
      // browser context's initial blank page, which strands the session on
      // a page with nothing on it at all.
      if (visitedNonHome && Math.random() < persona.params.backtrackProb) {
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 5000 }).catch(() => {});
        log("backtrack");
        visitedNonHome = false;
      }
    }

    if (outcome === "abandoned") {
      const reason = Date.now() - start >= config.maxDurationMs ? "timeout" : "patience_exhausted";
      log("task_abandoned", { meta: { reason } });
    }
  } catch (err) {
    log("error", { meta: { message: String(err).slice(0, 300), fatal: true } });
  } finally {
    log("session_end", { meta: { outcome } });
    await writer.close();
    await context.close();
  }

  return { sessionId, outcome, steps: step, durationMs: Date.now() - start };
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return results;
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error("Usage: node run-synthetic-test.mjs <config.json>");
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const outDir = config.outDir || `./synthetic-run-${Date.now()}`;
  mkdirSync(outDir, { recursive: true });
  config.maxDurationMs = config.maxDurationMs || 90000;
  const concurrency = config.concurrency || 5;

  if (config.engine === "llm-scored") {
    if (!resolveApiKey(config.llm?.apiKey)) {
      console.warn(
        "WARNING: engine is \"llm-scored\" but no API key found (set ANTHROPIC_API_KEY or config.llm.apiKey). " +
          "Every session will fall back to the heuristic scorer after its first failed call — the run will still " +
          "complete, just without Tier-2 scoring."
      );
    } else {
      console.log(`Engine: llm-scored (model: ${config.llm?.model || "claude-haiku-4-5-20251001"})`);
    }
  }
  if (config.cursorRealism) {
    console.log("Cursor realism: on (curved, eased mouse movement before each click — slower, more realistic)");
  }

  const browser = await chromium.launch({ headless: config.headless !== false });
  const summary = { startedAt: new Date().toISOString(), variants: {} };

  for (const variant of config.variants) {
    console.log(`\n=== Variant: ${variant.name} (${variant.url}) ===`);
    const roster = buildPersonaRoster(config.personas, config.userCount || 10);
    console.log(`Running ${roster.length} synthetic sessions (concurrency ${concurrency})...`);
    const results = await runWithConcurrency(roster, concurrency, async (persona) => {
      // Jitter start times so we don't fire a burst of simultaneous requests
      // at the target the instant the run begins.
      await new Promise((r) => setTimeout(r, Math.random() * 1500));
      return runSession({ browser, variant, task: config.task, persona, outDir, config });
    });
    const outcomes = results.reduce((acc, r) => {
      acc[r.outcome] = (acc[r.outcome] || 0) + 1;
      return acc;
    }, {});
    console.log("  Outcomes:", outcomes);
    summary.variants[variant.name] = { url: variant.url, results, outcomes };
  }

  await browser.close();
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify({ config, summary }, null, 2));
  console.log(`\nDone. Raw events + manifest.json in ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
