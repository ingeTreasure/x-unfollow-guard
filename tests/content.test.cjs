const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
let source = fs.readFileSync(require('node:path').join(__dirname, '../content/content.js'), 'utf8');
source = source.replace(/\}\)\(\);\s*$/, 'globalThis.testApi = { targetNoLongerFollowed, isSameNonFollowerTarget, loadProtectedHandles, applyHighlights, startAutoUnfollow, stopAutoUnfollow, scheduleUnfollowTick, unfollowState, followingUserCells, stats: () => lastHighlightStats };})();');
function cell(handle, { reciprocal = false, label = 'Following', testId = '123-unfollow', connected = true } = {}) {
  const button = { innerText: label, getAttribute: (key) => key === 'data-testid' ? testId : '', getClientRects: () => [1] };
  return { isConnected: connected, parentElement: null, classList: { add() {}, remove() {} }, querySelector: (selector) => selector.includes('userFollowIndicator') && reciprocal ? {} : null,
    querySelectorAll: (selector) => selector === 'a[href]' ? [{ getAttribute: () => `/${handle}` }] : selector === 'span' ? [] : [button],
    getBoundingClientRect: () => ({ top: 100, bottom: 150, left: 0, right: 400, width: 400, height: 50 }), closest: () => null };
}
function harness({ cells = [], path = '/tester/following', failProtected = false, protectedList = [] } = {}) {
  const data = { 'xnfb.highlightEnabled': false, 'xnfb.protectedHandles': protectedList };
  let listener;
  let timerId = 0;
  const timers = new Map();
  const primary = { querySelectorAll: () => cells };
  cells.forEach((entry) => { entry.closest = (selector) => selector.includes('primaryColumn') ? primary : null; });
  const context = { console, URL, location: { href: `https://x.com${path}`, pathname: path }, setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout(id) { timers.delete(id); }, setInterval() {}, MutationObserver: class { observe() {} }, window: { innerHeight: 800, innerWidth: 1200, scrollY: 0, addEventListener() {} }, getComputedStyle: () => ({ overflow: '', overflowY: '' }), document: {
    body: {}, scrollingElement: { scrollHeight: 800, clientHeight: 800, scrollTop: 0 }, documentElement: {},
    querySelector(selector) { return selector.includes('Profile_Link') ? { getAttribute: () => '/tester' } : selector.includes('primaryColumn') ? primary : null; }, querySelectorAll: () => []
  } };
  context.chrome = { runtime: { lastError: null, onMessage: { addListener(fn) { listener = fn; } }, sendMessage(message, cb) { cb({ ok: true, token: 'fixture-lease' }); } }, storage: { local: {
    get(keys, cb) { queueMicrotask(() => { if (failProtected && keys.includes('xnfb.protectedHandles')) context.chrome.runtime.lastError = { message: 'fixture error' }; cb(data); context.chrome.runtime.lastError = null; }); },
    set(values, cb) { Object.assign(data, values); cb(); }
  }, onChanged: { addListener() {} } } };
  vm.createContext(context);
  const projectRoot = require('node:path').join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(require('node:path').join(projectRoot, 'manifest.json'), 'utf8'));
  for (const file of manifest.content_scripts[0].js) vm.runInContext(file === 'content/content.js' ? source : fs.readFileSync(require('node:path').join(projectRoot, file), 'utf8'), context);
  return { api: context.testApi, data, context, timers, message: (msg) => new Promise((resolve) => listener(msg, {}, resolve)) };
}
test('DOM detach and recycled virtual rows are not proof of unfollow success', () => {
  const h = harness();
  assert.equal(h.api.targetNoLongerFollowed({ cell: cell('alice', { connected: false }), handle: 'alice' }), false);
  assert.equal(h.api.targetNoLongerFollowed({ cell: cell('bob', { label: 'Follow', testId: '1-follow' }), handle: 'alice' }), false);
  assert.equal(h.api.targetNoLongerFollowed({ cell: cell('alice'), handle: 'alice' }), false);
  assert.equal(h.api.targetNoLongerFollowed({ cell: cell('alice', { label: 'Follow', testId: '1-follow' }), handle: 'alice' }), true);
});
test('protected, reciprocal, and own accounts fail final target check', async () => {
  const h = harness({ protectedList: ['ALICE'] }); await h.api.loadProtectedHandles(); h.api.unfollowState.me = 'tester';
  assert.equal(h.api.isSameNonFollowerTarget({ cell: cell('alice'), handle: 'alice' }), false);
  assert.equal(h.api.isSameNonFollowerTarget({ cell: cell('bob', { reciprocal: true }), handle: 'bob' }), false);
  assert.equal(h.api.isSameNonFollowerTarget({ cell: cell('tester'), handle: 'tester' }), false);
  assert.equal(h.api.isSameNonFollowerTarget({ cell: cell('charlie'), handle: 'charlie' }), true);
});
test('disabled highlights still compute accurate list statistics', async () => {
  const h = harness({ cells: [cell('alice'), cell('bob', { reciprocal: true })] }); await h.api.applyHighlights();
  assert.deepEqual(JSON.parse(JSON.stringify(h.api.stats())), { checked: 2, marked: 1, hasData: true });
});
test('another user following page never yields eligible cells', () => {
  const h = harness({ path: '/someone/following', cells: [cell('alice')] }); assert.equal(h.api.followingUserCells().length, 0);
});
test('rapid duplicate start has only one active run and inputs are bounded', async () => {
  const h = harness({ cells: [cell('alice')] });
  const results = await Promise.all([h.api.startAutoUnfollow(9999, -2), h.api.startAutoUnfollow(20, 0)]);
  assert.equal(results[0].ok, true); assert.equal(results[1].error, 'already_running');
  assert.equal(h.api.unfollowState.limit, 200); assert.equal(h.api.unfollowState.skipFront, 0);
  await h.api.stopAutoUnfollow(); assert.equal(h.api.unfollowState.running, false);
});
test('protection read failure prevents starting any run', async () => {
  const h = harness({ failProtected: true, cells: [cell('alice')] });
  const response = await h.message({ type: 'xnfb:startAutoUnfollow', limit: 20, skipFront: 0 });
  assert.equal(response.ok, false); assert.equal(h.api.unfollowState.running, false);
});
test('stop during asynchronous startup cancels before scheduling destructive work', async () => {
  const h = harness({ cells: [cell('alice')] });
  const starting = h.api.startAutoUnfollow(20, 0); await h.api.stopAutoUnfollow();
  const response = await starting; assert.equal(response.ok, false); assert.equal(response.error, 'cancelled'); assert.equal(h.api.unfollowState.running, false);
});

test('variable startup wait remains cancellable without executing a queued action', async () => {
  const h = harness({ cells: [cell('alice')] });
  assert.equal((await h.api.startAutoUnfollow(20, 0)).ok, true);
  assert.equal(h.timers.size, 1);
  const timer = [...h.timers.values()][0];
  assert.ok(timer.delay >= 1100 && timer.delay <= 6300);
  await h.api.stopAutoUnfollow();
  assert.equal(h.timers.size, 0);
  assert.equal(h.api.unfollowState.count, 0);
});

test('long randomized rest can be stopped immediately, cancelling its pending action', async () => {
  const h = harness({ cells: [cell('alice')] });
  await h.api.startAutoUnfollow(20, 0);
  h.api.scheduleUnfollowTick(105000);
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].delay, 105000);
  await h.api.stopAutoUnfollow();
  assert.equal(h.timers.size, 0);
  assert.equal(h.api.unfollowState.running, false);
  assert.equal(h.api.unfollowState.count, 0);
});
