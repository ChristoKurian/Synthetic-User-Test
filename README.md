# synthetic-usability-test

A [Claude Code](https://claude.com/claude-code) skill that runs synthetic
("fake"/simulated) user sessions against one or more live, no-auth web
prototypes to compare usability — task success rate, time-on-task, clicks,
errors, rage-clicks, dead ends, backtracking — without waiting on real
user-research participants.

Point it at two or three URLs implementing the same feature (different
redesigns, different frameworks, competing Lovable/v0/Bolt prototypes, a
Figma-to-code build vs. the hand-built original) and it drives real
headless Chromium sessions, each played by a differently-behaved synthetic
persona (varying attention, tech familiarity, dexterity, patience,
language fluency), and produces a comparison report — plus, optionally, an
analytics export (PostHog by default, swappable to anything else).

No selectors are hardcoded per-target: the engine reads whatever page it's
pointed at and decides what to click using information scent (does this
element's text/label resemble what the current task is asking for?), the
same way a real, uncertain user would scan a page they've never seen
before.

## Install

**Personally** (available in every Claude Code project on this machine):

```bash
git clone <this-repo-url> ~/.claude/skills/synthetic-usability-test
```

**Per-project** (checked into a specific repo, available only there):

```bash
git clone <this-repo-url> path/to/your/repo/.claude/skills/synthetic-usability-test
```

Either way, one-time setup after cloning:

```bash
cd <wherever you cloned it>
npm install
npx playwright install chromium   # downloads a browser binary, ~100MB, one-time
```

Then in a Claude Code session, just describe what you want tested — e.g.
*"compare these two Lovable prototypes on how easily someone can complete
signup"* — and Claude will pick up the skill automatically (it's declared
in `SKILL.md`'s frontmatter). See `SKILL.md` for the full workflow Claude
follows.

## Try it without Claude, from the command line

```bash
cd <skill_dir>
node scripts/run-synthetic-test.mjs examples/example-config.json
node scripts/generate-report.mjs out/todomvc-example --title "Smoke test"
open out/todomvc-example/report.html   # or just open the file in a browser
```

That runs a real comparison against two public TodoMVC implementations
(React vs. Vue) — no config needed, safe to run repeatedly, good smoke
test after any change.

## What it needs

- **Node.js** and the one-time `npm install` / `playwright install` above.
- **Nothing else, by default.** The default engine (Tier 1, heuristic) makes
  zero network calls beyond loading the pages under test — no API keys, no
  LLM connection, no account of any kind.
- **Optional, only if you turn it on:**
  - `ANTHROPIC_API_KEY` — only if you set `"engine": "llm-scored"` (Tier 2:
    a real model scores ambiguous decisions instead of keyword-matching).
  - A PostHog project key (or another analytics backend's credentials) —
    only if you want the run's events exported somewhere; the local
    JSONL + HTML report are already complete without this.

## Structure

```
SKILL.md                    the workflow Claude follows — start here
scripts/
  run-synthetic-test.mjs    Tier 1/2 engine (Playwright)
  generate-report.mjs       JSONL -> comparison HTML report
  lib/                      personas, scent scoring, cursor movement, LLM scorer
  adapters/                 analytics export (posthog.mjs is the default)
references/                 detailed docs — config schema, personas/traits,
                             engines compared, analytics adapter contract,
                             LLM-agent mode, how to read the report
examples/                   working + template configs
evals/                      test prompts used to validate the skill
```

## License

MIT — see [LICENSE](LICENSE). Fork it, use it, change it.
