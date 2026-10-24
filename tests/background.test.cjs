const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(require('node:path').join(__dirname, '../background/background.js'), 'utf8');
const API = 'xnfb.binanceApiKey', POSTS = 'xnfb.squarePublishedSourcePosts', PENDING = 'xnfb.squarePendingSourcePosts';
function harness({ data = { [API]: 'fixture-key' }, fetcher, failWrite = () => false } = {}) {
  let listener, removed;
  const context = { console, URL, AbortController, setTimeout, clearTimeout, crypto: webcrypto, fetch: fetcher || (async () => ({ status: 200, json: async () => ({ code: '000000', data: { id: '99999' } }) })) };
  context.chrome = { runtime: { lastError: null, getURL: (path) => `chrome-extension://fixture/${path}`, onMessage: { addListener(fn) { listener = fn; } } }, tabs: { onRemoved: { addListener(fn) { removed = fn; } }, create({ url }, cb) { cb(); } }, storage: { local: {
    get(keys, cb) { queueMicrotask(() => cb(Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, structuredClone(data[key])])))); },
    set(values, cb) { queueMicrotask(() => { if (failWrite(values)) context.chrome.runtime.lastError = { message: 'fixture failure' }; else Object.assign(data, structuredClone(values)); cb(); context.chrome.runtime.lastError = null; }); }
  } } };
  vm.createContext(context); vm.runInContext(source, context);
  return { data, sync: (payload) => context.syncToSquare(payload), call: (message, sender = { url: 'chrome-extension://fixture/popup/popup.html' }) => new Promise((resolve) => listener(message, sender, resolve)), removed, context };
}
const payload = (sourceId = '123456') => ({ text: 'Hello Square', images: [], sourceId, allowNonMonetized: true });
const sender = (id) => ({ tab: { id, url: 'https://x.com/tester/following' } });
test('rejects source without stable post ID before any request', async () => {
  let requests = 0; const h = harness({ fetcher: async () => { requests++; } });
  assert.equal((await h.sync(payload('bad'))).ok, false); assert.equal(requests, 0);
});
test('concurrent clicks submit exactly once and save pending before network', async () => {
  let requests = 0; let h;
  h = harness({ fetcher: async () => { requests++; assert.ok(h.data[PENDING]['123456']); await new Promise((r) => setTimeout(r, 5)); return { status: 200, json: async () => ({ code: '000000', data: { id: '99999' } }) }; } });
  const result = await Promise.all([h.sync(payload()), h.sync(payload())]);
  assert.ok(result.every((entry) => entry.ok)); assert.equal(requests, 1); assert.ok(h.data[POSTS]['123456']); assert.deepEqual(h.data[PENDING], {});
  assert.equal((await h.sync(payload())).alreadyPublished, true); assert.equal(requests, 1);
});
test('ambiguous publication survives worker restart and blocks retry', async () => {
  const h = harness({ fetcher: async () => { throw new Error('timeout'); } });
  assert.equal((await h.sync(payload())).uncertain, true); assert.ok(h.data[PENDING]['123456']);
  let requests = 0; const restarted = harness({ data: h.data, fetcher: async () => { requests++; } });
  assert.equal((await restarted.sync(payload())).uncertain, true); assert.equal(requests, 0);
  assert.equal((await restarted.call({ type: 'xnfb:clearPendingPost', sourceId: '123456' }, sender(2))).ok, false);
  assert.equal((await restarted.call({ type: 'xnfb:clearPendingPost', sourceId: '123456' })).ok, true);
  assert.deepEqual(h.data[PENDING], {});
});
test('confirmed rejection clears pending and permits a corrected retry', async () => {
  const h = harness({ fetcher: async () => ({ status: 400, json: async () => ({ code: 'INVALID', message: 'content rejected' }) }) });
  assert.equal((await h.sync(payload())).ok, false); assert.deepEqual(h.data[PENDING], {});
});
test('failed protection write prevents irreversible network request', async () => {
  let requests = 0;
  const h = harness({ failWrite: (values) => PENDING in values, fetcher: async () => { requests++; } });
  assert.equal((await h.sync(payload())).ok, false); assert.equal(requests, 0);
});
test('concurrent different posts retain both history entries', async () => {
  const h = harness(); await Promise.all([h.sync(payload('123456')), h.sync(payload('234567'))]);
  assert.equal(Object.keys(h.data[POSTS]).length, 2); assert.deepEqual(h.data[PENDING], {});
});
test('unresolved protection is never evicted when full', async () => {
  const pending = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [String(100000 + i), { startedAt: i }]));
  let requests = 0; const h = harness({ data: { [API]: 'fixture-key', [PENDING]: pending }, fetcher: async () => { requests++; } });
  assert.equal((await h.sync(payload('999999'))).ok, false); assert.equal(requests, 0); assert.equal(Object.keys(h.data[PENDING]).length, 500);
});
test('cashtag conversion retains ordinary and Chinese topics and confirms fourth coin', async () => {
  const h = harness({ data: { [API]: 'fixture-key', 'xnfb.binanceSpotAssets.v2': { assets: ['BTC', 'ETH', 'BNB', 'SOL'], fetchedAt: Date.now() } } });
  const p = { ...payload(), text: '#BTC #ETH #BNB #SOL #DeFi #中文 @someone' };
  const response = await h.sync(p); assert.equal(response.needsCashtagLimitConfirmation, true); assert.equal(h.data[PENDING], undefined);
  const prepared = await h.context.prepareSquareText(p.text);
  assert.equal(prepared.text, '$BTC $ETH $BNB #SOL #DeFi #中文 @someone');
});
test('two tabs cannot acquire the same unfollow lease and wrong owner cannot release', async () => {
  const h = harness(); const results = await Promise.all([h.call({ type: 'xnfb:acquireUnfollow' }, sender(1)), h.call({ type: 'xnfb:acquireUnfollow' }, sender(2))]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  const token = results[0].token;
  assert.equal((await h.call({ type: 'xnfb:releaseUnfollow', token }, sender(2))).ok, false);
  assert.equal((await h.call({ type: 'xnfb:renewUnfollow', token }, sender(1))).ok, true);
  assert.equal((await h.call({ type: 'xnfb:releaseUnfollow', token }, sender(1))).ok, true);
  assert.equal((await h.call({ type: 'xnfb:acquireUnfollow' }, sender(2))).ok, true);
});
test('expired lease can be recovered without accepting stale owner', async () => {
  const h = harness(); const first = await h.call({ type: 'xnfb:acquireUnfollow' }, sender(1));
  h.data['xnfb.unfollowLease'].expiresAt = Date.now() - 1;
  assert.equal((await h.call({ type: 'xnfb:renewUnfollow', token: first.token }, sender(1))).ok, false);
  const second = await h.call({ type: 'xnfb:acquireUnfollow' }, sender(2)); assert.equal(second.ok, true);
  assert.equal((await h.call({ type: 'xnfb:releaseUnfollow', token: first.token }, sender(1))).ok, false);
});
