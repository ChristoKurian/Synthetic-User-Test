import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Canonical event schema shared by both engines (Playwright heuristic mode
// and the LLM-agent mode's session logs) and by generate-report.mjs. Keeping
// one schema means a report never has to know which engine produced a run,
// and swapping the analytics backend (see adapters/) never touches this shape.
//
// { ts, tMs, sessionId, variant, personaId, personaArchetype, step,
//   event, target: {text, tag, role, href}|null, pageUrl, pageTitle,
//   scentScore, meta }

export class JsonlWriter {
  constructor(filePath) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.stream = createWriteStream(filePath, { flags: "a" });
  }
  write(event) {
    this.stream.write(JSON.stringify(event) + "\n");
  }
  close() {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}

export function makeEvent(base, event, extra = {}) {
  return {
    ts: new Date().toISOString(),
    ...base,
    event,
    target: null,
    scentScore: null,
    meta: {},
    ...extra,
  };
}
