// Tags synthetic sessions inside the TARGET PROTOTYPE'S OWN analytics client
// (PostHog or Mixpanel, if either is already wired into the page under
// test) — this is the opposite direction from adapters/posthog.mjs, which
// exports OUR event log to an analytics backend. This makes OUR sessions
// show up correctly labeled in an analytics account the prototype already
// reports to, so real product-specific events the prototype tracks (not
// just our generic click/time/error metrics) can be compared per variant.
//
// Mechanism: `context.addInitScript()` runs before any of the page's own
// scripts, on every navigation. Analytics SDKs load asynchronously and
// assign themselves to a global (`window.posthog`, `window.mixpanel`)
// once ready — usually via the vendor's install snippet, which defines a
// stub at that global synchronously and queues calls until the real
// library loads. We can't call `.register()` before that global exists,
// so instead we install a property watcher: it fires the instant the
// target's own code assigns the global, registers our tags immediately,
// then gets out of the way.
//
// IMPORTANT — read before using: some analytics SDKs (PostHog's JS SDK
// among them) can suppress capture() when they detect an automated
// browser (`navigator.webdriver`, headless UA strings, etc.), same as
// bot-filtering aimed at keeping real analytics clean of scraper noise.
// Since here the "bot" is the prototype's own owner intentionally testing
// their own prototype — not evading anyone else's protection — this also
// masks navigator.webdriver so the target's own analytics treats
// synthetic sessions as real traffic worth tagging and counting. Only use
// this against prototypes you own or are authorized to test; do not
// repurpose it to defeat bot protection on a system you don't control.

export function buildInjectionScript(tags) {
  const tagsJson = JSON.stringify(tags);
  return `(() => {
    try { Object.defineProperty(navigator, "webdriver", { get: () => false, configurable: true }); } catch (e) {}

    const tags = ${tagsJson};

    function watch(globalName) {
      let real;
      try {
        Object.defineProperty(window, globalName, {
          configurable: true,
          get() { return real; },
          set(v) {
            real = v;
            try {
              if (v && typeof v.register === "function") v.register(tags);
            } catch (e) {}
          },
        });
      } catch (e) {}
    }

    watch("posthog");
    watch("mixpanel");
  })();`;
}

// One stable ID per full comparison run (all variants, all personas) so a
// later query can pull back exactly this run's events. Per-session and
// per-persona identifiers are layered under it in the tags themselves.
export function makeRunId() {
  return `synthetic-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function sessionTags({ runId, variant, personaId, personaArchetype, sessionId }) {
  return {
    synthetic_session: true,
    synthetic_run_id: runId,
    synthetic_variant: variant,
    synthetic_persona_id: personaId,
    synthetic_persona_archetype: personaArchetype,
    synthetic_session_id: sessionId,
  };
}
