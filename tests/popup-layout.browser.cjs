// Real toolbar popup: isolated Chromium profile; never visits X or publishes content.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { resolve, join } = require('node:path');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');

test('native extension popup fits its content and scrolls every panel without hiding navigation', { timeout: 60000 }, async () => {
  const extension = resolve(__dirname, '..');
  const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json')));
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: process.env.EXTENSION_HEADLESS === '1', viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1000,850'],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(() => chrome.action.openPopup());
    const session = await context.browser().newBrowserCDPSession();
    let target;
    for (let attempt = 0; attempt < 20; attempt++) {
      target = (await session.send('Target.getTargets')).targetInfos.find(item => item.url.endsWith('/popup/popup.html'));
      if (target) break;
      await new Promise(done => setTimeout(done, 50));
    }
    assert.ok(target, 'Actual toolbar popup must open');
    const { sessionId } = await session.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
    let nextId = 0;
    const pending = new Map();
    session.on('Target.receivedMessageFromTarget', event => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message);
      const slot = pending.get(message.id);
      if (!slot) return;
      pending.delete(message.id);
      message.error ? slot.reject(new Error(JSON.stringify(message.error))) : slot.resolve(message.result);
    });
    async function send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        void session.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(reject);
      });
    }
    async function evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    async function settle() { await evaluate('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))'); }
    async function layout() {
      await settle();
      return evaluate(`(() => {
        const main = document.querySelector('main');
        const rect = element => element.getBoundingClientRect().toJSON();
        return { width: innerWidth, height: innerHeight, body: rect(document.body), header: rect(document.querySelector('.header')), tabs: rect(document.querySelector('.tabs')), main: rect(main), footer: rect(document.querySelector('footer')), scrollWidth: main.scrollWidth, clientWidth: main.clientWidth, scrollHeight: main.scrollHeight, clientHeight: main.clientHeight, scrollTop: main.scrollTop, button: rect(document.querySelector('#btnAutoUnfollow')) };
      })()`);
    }
    function fits(state) {
      assert.equal(state.body.width, state.width, 'No blank area beside the popup body');
      assert.equal(state.body.height, state.height, 'Body must fit the real popup viewport');
      assert.ok(state.footer.bottom <= state.height + 1, 'Footer stays inside the native popup');
      assert.ok(state.main.bottom <= state.footer.top + 1, 'Content cannot overlap footer');
      assert.ok(state.main.top >= state.tabs.bottom - 1, 'Content cannot overlap tabs');
      assert.ok(state.scrollWidth <= state.clientWidth + 1, 'No horizontal content overflow');
    }
    const initial = await layout();
    fits(initial);
    assert.ok(initial.width < 600, 'The popup must not expand to the Chrome maximum width');
    assert.ok(initial.height <= 600);
    assert.ok(initial.button.bottom <= initial.main.bottom + 1, 'Primary action visible before scrolling at default size');
    assert.equal(await evaluate('document.title'), '粉丝管理');
    assert.equal(await evaluate("document.querySelector('h1').textContent"), manifest.name);
    assert.equal(await evaluate("document.querySelector('.version').textContent"), manifest.version);
    if (process.env.EXTENSION_EVIDENCE_DIR) {
      mkdirSync(process.env.EXTENSION_EVIDENCE_DIR, { recursive: true });
      const screenshot = await send('Page.captureScreenshot');
      writeFileSync(join(process.env.EXTENSION_EVIDENCE_DIR, 'popup-default.png'), Buffer.from(screenshot.data, 'base64'));
    }
    await evaluate("document.querySelector('.protection').open = true; document.querySelector('main').scrollTop = 10000");
    const protection = await layout();
    fits(protection);
    const save = await evaluate("document.querySelector('#btnSaveProtected').getBoundingClientRect().toJSON()");
    assert.ok(protection.scrollTop > 0);
    assert.ok(save.bottom <= protection.main.bottom + 1 && save.top >= protection.main.top);
    assert.equal(protection.header.top, initial.header.top);
    await evaluate("document.querySelector('#tab-history').click()");
    await settle();
    assert.equal((await layout()).scrollTop, 0, 'Tab switching resets content scroll');
    await worker.evaluate(async () => {
      const posts = {};
      for (let i = 0; i < 45; i++) {
        posts[String(1000000000000000000n + BigInt(i))] = { publishedAt: Date.now() - i * 1000, postUrl: 'https://www.binance.com/en/square/post/123456789', symbols: ['BTC', 'ETH'] };
      }
      await chrome.storage.local.set({ 'xnfb.squarePublishedSourcePosts': posts });
    });
    for (let i = 0; i < 20 && await evaluate("document.querySelectorAll('.history-item').length") !== 20; i++) await new Promise(done => setTimeout(done, 50));
    assert.equal(await evaluate("document.querySelectorAll('.history-item').length"), 20);
    await evaluate("document.querySelector('main').scrollTop = 100000");
    fits(await layout());
    await evaluate("document.querySelector('#btnMoreHistory').click()");
    for (let i = 0; i < 20 && await evaluate("document.querySelectorAll('.history-item').length") !== 40; i++) await new Promise(done => setTimeout(done, 50));
    assert.equal(await evaluate("document.querySelectorAll('.history-item').length"), 40);
    await evaluate("document.querySelector('#tab-settings').click(); document.querySelector('.guide').open = true");
    assert.equal((await layout()).scrollTop, 0);
    fits(await layout());
    await evaluate("document.querySelector('#btnClearKey').click()");
    const dialog = await evaluate("document.querySelector('dialog').getBoundingClientRect().toJSON()");
    assert.ok(dialog.top >= 0 && dialog.bottom <= initial.height);
    await evaluate("document.querySelector('dialog button[value=cancel]').click()");
    // Native toolbar targets reject metrics overrides. Check smaller available
    // viewports in a real extension tab, after completing native popup checks.
    const tab = await context.newPage();
    for (const [width, height] of [[320, 480], [440, 400]]) {
      await tab.setViewportSize({ width, height });
      await tab.goto(new URL('../popup/popup.html', worker.url()).href);
      const state = await tab.evaluate(() => {
        const main = document.querySelector('main');
        const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        return { width: innerWidth, height: innerHeight, body: rect('body'), tabs: rect('.tabs'), main: rect('main'), footer: rect('footer'), scrollWidth: main.scrollWidth, clientWidth: main.clientWidth };
      });
      fits(state);
      await tab.evaluate(() => { document.querySelector('.protection').open = true; document.querySelector('main').scrollTop = 100000; });
      const save = await tab.locator('#btnSaveProtected').boundingBox();
      assert.ok(save.y + save.height <= state.main.bottom + 1 && save.y >= state.main.top);
    }
  } finally { await context.close(); }
});
