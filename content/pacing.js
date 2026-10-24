/** Variable pacing for local UI actions. No target selection or safety decisions here. */
(function (root) {
  'use strict';

  function create({ random = Math.random, now = Date.now } = {}) {
    const between = (min, max) => min + random() * (max - min);
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const skew = (min, max) => min + (max - min) * Math.pow(random(), 1.7);
    // Each run has its own baseline; it drifts over time instead of repeating batches.
    const baseline = between(1, 1.35);
    const hesitationChance = between(0.09, 0.22);
    const lookBackChance = between(0.07, 0.19);
    let tempo = baseline;
    let targetTempo = baseline;
    let changeAt = now() + between(18000, 58000);
    let lastRestAt = now();
    let restBudget = between(75000, 175000);
    let lastScrollAt = now();
    let previousBackward = false;

    function pace() {
      const time = now();
      if (time >= changeAt) {
        targetTempo = baseline * between(0.85, 1.4);
        changeAt = time + between(18000, 58000);
      }
      tempo += (targetTempo - tempo) * between(0.15, 0.5);
      return tempo;
    }

    function nextWait() {
      const speed = pace();
      const choice = random();
      let wait = choice < 0.18 ? between(4000, 6500)
        : choice < 0.84 ? skew(6500, 15500)
          : skew(15500, 26000);
      wait *= speed;
      if (random() < hesitationChance) wait += skew(6000, 22000);
      return Math.round(clamp(wait, 4000, 55000));
    }

    function delay(kind) {
      const ranges = {
        start: [1100, 4200],
        read: [700, 2900],
        hover: [280, 1100],
        confirm: [350, 1400],
        settle: [450, 1600],
        retry: [1000, 2600],
      };
      const [min, max] = ranges[kind] || ranges.retry;
      return Math.round(clamp(skew(min, max) * pace(), min, max * 1.5));
    }

    function afterAction() {
      const time = now();
      const worked = Math.max(0, time - lastRestAt);
      // Time and probability determine a rest; there is no fixed N-account batch.
      const chance = clamp(0.025 + (worked / restBudget) ** 2 * 0.2, 0, 0.3);
      const rest = worked >= restBudget || (worked >= 40000 && random() < chance);
      if (rest) {
        const waitMs = Math.round(random() < 0.16 ? between(65000, 105000) : skew(18000, 65000));
        lastRestAt = time + waitMs;
        restBudget = between(75000, 175000);
        // The next action after resting starts with a newly sampled tempo.
        targetTempo = baseline * between(0.9, 1.3);
        return { waitMs, rest: true, scroll: false };
      }
      const scrollAge = Math.max(0, time - lastScrollAt);
      const scroll = scrollAge > 75000 || random() < clamp(0.1 + scrollAge / 180000, 0.1, 0.48);
      return { waitMs: nextWait(), rest: false, scroll };
    }

    function scrollPlan({ top, viewport, allowBackward = false }) {
      // A second consecutive backward step is forbidden; keep list traversal progressing.
      const backward = allowBackward && top > viewport * 0.15 && !previousBackward && random() < lookBackChance;
      previousBackward = backward;
      lastScrollAt = now();
      const choice = random();
      const fraction = backward ? between(0.05, 0.2)
        : choice < 0.3 ? between(0.1, 0.23)
          : choice < 0.9 ? between(0.23, 0.43) : between(0.43, 0.56);
      return { top: Math.round(viewport * fraction) * (backward ? -1 : 1), behavior: 'smooth' };
    }

    return Object.freeze({ nextWait, delay, afterAction, scrollPlan });
  }

  const api = Object.freeze({ create });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XnfbPacing = api;
})(globalThis);
