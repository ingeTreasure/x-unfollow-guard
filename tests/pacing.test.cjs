const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../content/pacing.js');
function seeded(seed) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}
function simulation(seed, count = 2000) {
  let time = 0;
  const pacing = create({ random: seeded(seed), now: () => time });
  const waits = [], rests = [], batches = [];
  let completedSinceRest = 0;
  for (let i = 0; i < count; i++) {
    time += 2500; completedSinceRest++;
    const next = pacing.afterAction();
    if (next.rest) { rests.push(next.waitMs); batches.push(completedSinceRest); completedSinceRest = 0; }
    else waits.push(next.waitMs);
    time += next.waitMs;
    if (next.scroll) pacing.scrollPlan({ top: 1200, viewport: 800, allowBackward: true });
  }
  return { waits, rests, batches };
}
test('many operations keep finite bounded waits and rests without fixed batches', () => {
  const { waits, rests, batches } = simulation(63);
  assert.ok(waits.length > 1000 && rests.length > 50);
  assert.ok(waits.every((wait) => Number.isInteger(wait) && wait >= 4000 && wait <= 55000));
  assert.ok(rests.every((wait) => Number.isInteger(wait) && wait >= 18000 && wait <= 105000));
  assert.ok(new Set(batches).size >= 8);
  assert.ok(batches.some((count) => count < 6));
  assert.ok(batches.some((count) => count > 10));
  assert.ok(rests.some((wait) => wait >= 65000));
});
test('waits cover short, medium and long ranges with no narrow periodic sequence', () => {
  const { waits } = simulation(27);
  assert.ok(waits.some((wait) => wait < 6500));
  assert.ok(waits.some((wait) => wait >= 10000 && wait < 20000));
  assert.ok(waits.some((wait) => wait >= 30000));
  assert.ok(new Set(waits).size > waits.length * 0.85);
  const other = simulation(28); assert.notDeepEqual(waits.slice(0, 20), other.waits.slice(0, 20));
});
test('rest eligibility follows elapsed time rather than operation count', () => {
  let fastTime = 0, slowTime = 0;
  const fast = create({ random: seeded(11), now: () => fastTime });
  const slow = create({ random: seeded(11), now: () => slowTime });
  for (let i = 0; i < 15; i++) { fastTime += 500; assert.equal(fast.afterAction().rest, false); }
  slowTime += 180000;
  assert.equal(slow.afterAction().rest, true);
});
test('scrolling varies while never reversing twice or leaving bounded step sizes', () => {
  const pacing = create({ random: seeded(192) });
  let previousBackward = false, backward = 0;
  const forwardSteps = [];
  for (let i = 0; i < 2000; i++) {
    const step = pacing.scrollPlan({ top: 2000, viewport: 800, allowBackward: true });
    assert.equal(step.behavior, 'smooth');
    assert.ok(Number.isFinite(step.top) && step.top !== 0);
    assert.ok(!(step.top < 0 && previousBackward));
    if (step.top < 0) { backward++; assert.ok(step.top >= -160 && step.top <= -40); }
    else { forwardSteps.push(step.top); assert.ok(step.top >= 80 && step.top <= 448); }
    previousBackward = step.top < 0;
  }
  assert.ok(backward > 50);
  assert.ok(new Set(forwardSteps).size > 150);
});
test('progress-required scrolling and scrolling near list start always go forward', () => {
  const pacing = create({ random: seeded(85) });
  for (let i = 0; i < 100; i++) {
    assert.ok(pacing.scrollPlan({ top: 4000, viewport: 800, allowBackward: false }).top > 0);
    assert.ok(pacing.scrollPlan({ top: 0, viewport: 800, allowBackward: true }).top > 0);
  }
});
test('interaction waits stay within bounds, including extreme random values', () => {
  const minima = { start: 1100, read: 700, hover: 280, confirm: 350, settle: 450, retry: 1000 };
  for (const rng of [() => 0, () => 1 - Number.EPSILON, seeded(42)]) {
    let time = 0; const pacing = create({ random: rng, now: () => time });
    for (let i = 0; i < 100; i++) {
      time += 30000;
      for (const [kind, min] of Object.entries(minima)) { const value = pacing.delay(kind); assert.ok(Number.isFinite(value) && value >= min && value <= 6300); }
      assert.ok(pacing.nextWait() >= 4000 && pacing.nextWait() <= 55000);
    }
  }
});
