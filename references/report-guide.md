# Reading the report

`scripts/generate-report.mjs` produces `report.html` with two tables and a
one-line verdict callout. What each column means, and where it can mislead:

- **Success rate** — the headline number, but only trustworthy alongside
  session count (`n`). 5/5 successes and 47/50 successes aren't the same
  claim even though both round to "high."
- **Median time-to-success** — computed only over *successful* sessions.
  A variant with a low success rate but a fast median time can be
  misleading: it means the sessions that *did* succeed were fast, not that
  the variant is fast overall. Look at both numbers together.
- **Median clicks** — computed over all sessions, including abandoned
  ones, since click count itself is a friction signal regardless of
  outcome.
- **Errors/session** — count of `error` events (a click/type action that
  failed, e.g. a detached element). A handful is normal in headless
  automation; a variant with a much higher rate than others may indicate
  actual UI flakiness (elements that shift under the user), which is a
  real finding worth flagging even if it wasn't the thing being tested.
- **Rage-click / backtrack-loop sessions** — count of *sessions* (not
  events) that showed at least one of these frustration signals. These are
  detected directly from behavior (repeated clicks on the same target,
  revisiting the same URL 3+ times) and don't depend on any analytics
  backend being configured.
- **Success rate by persona archetype** — the table most likely to contain
  the actually-interesting finding. A variant with a similar *overall*
  success rate to another can still be badly failing novices while
  experts breeze through, and that gap is invisible in the top-line number.

## What this report is not

It's a comparison of synthetic sessions on one defined task, not a full
usability verdict. Treat a result like "redesign: 85% vs classic: 40%" as
a strong, specific signal ("on this task, this many synthetic users, this
much friction") — worth reporting plainly — not as "redesign is definitely
better" in some general sense. Say what was tested, on what, at what N,
alongside the numbers.
