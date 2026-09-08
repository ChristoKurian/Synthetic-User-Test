// Human-like cursor movement: a curved multi-point path with an eased
// (accelerate-then-decelerate) speed profile, instead of Playwright's
// default instant teleport-to-target. Calibrated against real numbers
// pulled from a live sample of dejanseo/mouse_movement_tracking (685k real
// browser mousemove events, sampled directly rather than assumed): actual
// "move" events show distance-per-~17ms-sample at p10/p50/p90 of
// 5/61/149px, implying an average in-motion speed around 3-4 px/ms. Used
// here as a STATISTICAL reference for speed/duration, not literal replay
// of any captured path — the dataset's README documents no collection or
// consent details, so this stays at the level of aggregate numbers, never
// anything session- or user-identifying.
//
// This isn't just cosmetic. A curved path that actually passes near
// intermediate elements triggers real CSS :hover states along the way —
// the same hover-revealed controls (e.g. a delete icon that only appears
// on row hover) that an instant teleport-click never discovers naturally.

const MEDIAN_SPEED_PX_PER_MS = 3.6; // ≈ 61px / 17ms, from the sampled dataset

function bezierPoint(p0, p1, p2, t) {
  const x = (1 - t) ** 2 * p0.x + 2 * (1 - t) * t * p1.x + t ** 2 * p2.x;
  const y = (1 - t) ** 2 * p0.y + 2 * (1 - t) * t * p1.y + t ** 2 * p2.y;
  return { x, y };
}

// Real cursor movement isn't constant-velocity — it accelerates away from
// the start and decelerates into the target (a Fitts's-law signature).
function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

// Moves the mouse from `from` to `to` along a curved path. Returns the
// waypoint trace ({x,y,t} per step) so callers can feed it to
// humannessScore() below.
export async function humanMouseMove(page, from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const trace = [{ x: from.x, y: from.y, t: 0 }];

  if (distance < 2) {
    await page.mouse.move(to.x, to.y);
    trace.push({ x: to.x, y: to.y, t: 1 });
    return { distance, durationMs: 0, trace };
  }

  // A slight perpendicular bow — real point-to-point movement curves
  // rather than tracing a perfectly straight line.
  const bow = (Math.random() - 0.5) * Math.min(80, distance * 0.3);
  const mid = {
    x: (from.x + to.x) / 2 - (dy / distance) * bow,
    y: (from.y + to.y) / 2 + (dx / distance) * bow,
  };

  const durationMs = Math.min(900, Math.max(80, distance / MEDIAN_SPEED_PX_PER_MS));
  const steps = Math.max(4, Math.min(20, Math.round(distance / 25)));

  const start = Date.now();
  for (let i = 1; i <= steps; i++) {
    const t = easeInOutQuad(i / steps);
    const pt = bezierPoint(from, mid, to, t);
    await page.mouse.move(pt.x, pt.y);
    trace.push({ x: pt.x, y: pt.y, t: Date.now() - start });
    const elapsedTarget = (i / steps) * durationMs;
    const remaining = elapsedTarget - (Date.now() - start);
    if (remaining > 0) await page.waitForTimeout(remaining);
  }
  return { distance, durationMs, trace };
}

// Lightweight self-check inspired by bot-detection ("mouse dynamics")
// research — e.g. the Balabit Mouse Dynamics Challenge dataset, built to
// catch robotic-looking movement in the OPPOSITE direction (flagging bots).
// The same signal is useful here as a sanity check on our own generated
// paths: real movement has variably-paced speed between samples; a
// constant speed or a perfectly straight line is the classic synthetic
// tell. Not a rigorous detector — a cheap, honest gut-check.
export function humannessScore(trace) {
  if (!trace || trace.length < 3) return null;
  const speeds = [];
  for (let i = 1; i < trace.length; i++) {
    const a = trace[i - 1];
    const b = trace[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const dt = Math.max(1, b.t - a.t);
    speeds.push(d / dt);
  }
  const mean = speeds.reduce((s, v) => s + v, 0) / speeds.length;
  const variance = speeds.reduce((s, v) => s + (v - mean) ** 2, 0) / speeds.length;
  const speedCV = mean > 0 ? Math.sqrt(variance) / mean : 0;
  return { speedCV: Number(speedCV.toFixed(3)), looksHuman: speedCV > 0.15 };
}
