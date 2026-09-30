/**
 * content/content.js
 * 注入在 x.com / twitter.com 上，负责：
 *   1. 在「正在关注」列表内识别并高亮没有回关的账号
 *   2. 按跳过数量和本次上限自动取关（需用户确认，可手动停止）
 *   3. 在每条推文操作栏旁注入币安图标，同步到 Binance Square
 *   4. 响应 popup 发来的状态和操作指令
 */
(function () {
  'use strict';

  const CELL_SELECTOR = '[data-testid="UserCell"]';
  const PRIMARY_COLUMN_SELECTOR = '[data-testid="primaryColumn"]';
  const FOLLOW_INDICATOR_SELECTOR = '[data-testid="userFollowIndicator"]';
  const HANDLE_RE = /^\/([A-Za-z0-9_]{1,15})\/?$/;
  const USER_LIST_PATH_RE = /^\/([A-Za-z0-9_]{1,15})\/(followers|following)\/?$/;
  const HIGHLIGHT_STORAGE_KEY = 'xnfb.highlightEnabled';
  const UNFOLLOW_BTN_SELECTOR = 'button, [role="button"]';
  const CONFIRM_BTN_SELECTOR = '[data-testid="confirmationSheetConfirm"]';
  const UNFOLLOW_INTERVAL_MIN_MS = 3800;
  const UNFOLLOW_INTERVAL_MAX_MS = 7500;
  const UNFOLLOW_LIMIT_MAX = 200;
  const UNFOLLOW_DAILY_CAP = 200;
  const UNFOLLOW_DAILY_KEY = 'xnfb.unfollowDaily';
  const UNFOLLOW_SKIP_FRONT_DEFAULT = 0;
  const UNFOLLOW_SKIP_FRONT_MAX = 1000;
  const UNFOLLOW_BREAK_EVERY_MIN = 6;
  const UNFOLLOW_BREAK_EVERY_MAX = 10;
  const UNFOLLOW_BREAK_MS_MIN = 25000;
  const UNFOLLOW_BREAK_MS_MAX = 45000;
  const UNFOLLOW_NO_PROGRESS_LIMIT = 10;
  const UNFOLLOW_BUTTON_RETRY_MAX = 2;
  // X 的关注列表是虚拟列表，取关仅作用于当前显示并已校验身份的账号。
  const CONFIRM_DIALOG_TIMEOUT_MS = 3000;
  const CONFIRM_CLOSE_TIMEOUT_MS = 4000;
  // 原有的自然停顿分布：大多数操作节奏较短，偶尔插入较长间隔。
  const DISTRACTION_CHANCE = 0.12;
  const DISTRACTION_MS_MIN = 8000;
  const DISTRACTION_MS_MAX = 25000;
  const SCROLL_BACK_CHANCE = 0.12;
  const SYNC_BADGE_CLASS = 'xnfb-sync-badge';
  const SYNC_BADGE_FLAG = 'xnfbSyncBadge';
  const syncBadgeResetTimers = new WeakMap();

  let unfollowTimer = null;
  let observer = null;
  let lastUrl = location.href;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }
  function humanDelay(min, max) {
    const base = min + (max - min) * Math.pow(Math.random(), 1.6);
    if (Math.random() < DISTRACTION_CHANCE) {
      return base + randomBetween(DISTRACTION_MS_MIN, DISTRACTION_MS_MAX);
    }
    return base;
  }
  function listScrollRoot() {
    const cell = followingUserCells()[0];
    for (let node = cell?.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/i.test(`${style.overflowY} ${style.overflow}`) && node.scrollHeight > node.clientHeight + 80) {
        return node;
      }
    }
    return document.scrollingElement || document.documentElement;
  }

  function listScrollMetrics() {
    const root = listScrollRoot();
    const isDocument = root === document.scrollingElement || root === document.documentElement || root === document.body;
    const viewport = Math.max(1, isDocument ? window.innerHeight : root.clientHeight);
    const top = isDocument ? (window.scrollY || root.scrollTop) : root.scrollTop;
    const max = Math.max(0, root.scrollHeight - (isDocument ? viewport : root.clientHeight));
    return { root, isDocument, viewport, top, max, atEnd: max - top <= Math.max(80, viewport * 0.12) };
  }

  function humanScroll(allowBackward) {
    const metrics = listScrollMetrics();
    const lookBack = allowBackward && metrics.top > 0 && Math.random() < SCROLL_BACK_CHANCE;
    const distance = metrics.viewport * (lookBack ? randomBetween(0.1, 0.2) : randomBetween(0.24, 0.52));
    const top = lookBack ? -distance : distance;
    if (metrics.isDocument) window.scrollBy({ top, behavior: 'smooth' });
    else metrics.root.scrollBy({ top, behavior: 'smooth' });
    return metrics;
  }

  async function scrollListToStart() {
    const metrics = listScrollMetrics();
    if (metrics.top <= 4) return;
    if (metrics.isDocument) window.scrollTo({ top: 0, behavior: 'smooth' });
    else metrics.root.scrollTo({ top: 0, behavior: 'smooth' });
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      await sleep(120);
      if (listScrollMetrics().top <= 4) return;
    }
  }

  async function waitForSelector(selector, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const el = document.querySelector(selector);
      if (el) return el;
      if (Date.now() >= deadline) return null;
      await sleep(120);
    }
  }

  async function waitForSelectorGone(selector, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!document.querySelector(selector)) return true;
      if (Date.now() >= deadline) return false;
      await sleep(120);
    }
  }

  // ---------- 基础工具 ----------

  function handleOf(cell) {
    const anchors = cell.querySelectorAll('a[href]');
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const m = HANDLE_RE.exec(href);
      if (m) return m[1].toLowerCase();
    }
    return null;
  }

  function followsMe(cell) {
    if (cell.querySelector(FOLLOW_INDICATOR_SELECTOR)) return true;
    return Array.from(cell.querySelectorAll('span')).some((span) => {
      const label = (span.textContent || '').trim();
      return /^follows you$/i.test(label) || /^(关注你|关注了你)$/.test(label);
    });
  }

  function cellIsInViewport(cell) {
    const rect = cell.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight &&
      rect.right > 0 && rect.left < window.innerWidth;
  }

  function placeBadgeBesideFollowingButton(cell, badge) {
    const button = unfollowButtonOf(cell);
    if (!button || !button.getClientRects().length) return false;
    const cellRect = cell.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    if (!cellRect.width || !cellRect.height || !buttonRect.width || !buttonRect.height) return false;

    // Anchor to this row and measure the actual button: badge ends 7px before its left edge.
    // Absolute positioning keeps the badge out of X's layout flow, so it cannot grow the row.
    cell.classList.add('xnfb-badge-anchor');
    if (badge.parentElement !== cell) {
      badge.parentElement?.classList.remove('xnfb-badge-anchor');
      cell.appendChild(badge);
    }
    badge.style.left = `${buttonRect.left - cellRect.left - 7}px`;
    badge.style.top = `${buttonRect.top - cellRect.top + buttonRect.height / 2}px`;
    return true;
  }

  function clearCellHighlight(cell) {
    cell.classList.remove('xnfb-marked', 'xnfb-badge-anchor');
    const badge = cell.querySelector('.xnfb-badge');
    badge?.parentElement?.classList.remove('xnfb-badge-anchor');
    badge?.remove();
  }

  function unfollowButtonOf(cell) {
    const buttons = Array.from(cell.querySelectorAll(UNFOLLOW_BTN_SELECTOR));
    return buttons.find((button) => {
      const testId = (button.getAttribute('data-testid') || '').trim();
      const label = [button.getAttribute('aria-label'), button.getAttribute('title'), button.innerText]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      return /(?:^|[-_])unfollow$/i.test(testId) || /\bunfollow\b/i.test(label) ||
        /取消关注|正在关注|已关注/.test(label) || /^following(?:\b|\s|@)/i.test(label);
    });
  }

  function unfollowMenuItem(handle) {
    const menu = document.querySelector('[role="menu"]');
    if (!menu) return null;
    const items = Array.from(menu.querySelectorAll('[role="menuitem"], button'));
    const exact = items.filter((item) => {
      const label = (item.innerText || item.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      if (!/^(unfollow|取消关注)(?:\s+@?[A-Za-z0-9_]+)?$/i.test(label)) return false;
      const account = label.match(/^(?:unfollow|取消关注)\s+@?([A-Za-z0-9_]+)$/i)?.[1];
      return !handle || !account || account.toLowerCase() === handle.toLowerCase();
    });
    return exact.length === 1 ? exact[0] : null;
  }

  function targetNoLongerFollowed(target) {
    return !target?.cell?.isConnected || handleOf(target.cell) !== target.handle || !unfollowButtonOf(target.cell);
  }

  async function waitForTargetUpdate(target, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (targetNoLongerFollowed(target)) return true;
      await sleep(150);
    }
    return targetNoLongerFollowed(target);
  }

  function myHandle() {
    const link =
      document.querySelector('a[data-testid="AppTabBar_Profile_Link"]') ||
      document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"] a[href]');
    if (!link) return null;
    const m = HANDLE_RE.exec(link.getAttribute('href') || '');
    return m ? m[1].toLowerCase() : null;
  }

  function listPathMatch() {
    return USER_LIST_PATH_RE.exec(location.pathname);
  }

  function pageKind() {
    const m = listPathMatch();
    return m ? m[2] : null;
  }

  // 必须确认是「自己的」粉丝/关注页，否则会把陌生人的列表当成自己的数据处理
  function isMyListPage(kind) {
    const m = listPathMatch();
    if (!m || m[2] !== kind) return false;
    return m[1].toLowerCase() === myHandle();
  }

  function followingUserCells() {
    if (!isMyListPage('following')) return [];
    const primary = document.querySelector(PRIMARY_COLUMN_SELECTOR);
    if (!primary) return [];
    return Array.from(primary.querySelectorAll(CELL_SELECTOR)).filter((cell) =>
      !cell.closest('aside, [data-testid="sidebarColumn"]') &&
      cell.closest(PRIMARY_COLUMN_SELECTOR) === primary
    );
  }

  function isCurrentAutoUnfollowPage() {
    return isMyListPage('following') && myHandle() === unfollowState.me;
  }

  // ---------- chrome.storage 封装（Promise 化） ----------
  // 回调里必须读一次 lastError，否则失败时 Chrome 会抛「Unchecked runtime.lastError」

  function storageGet(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (data) => {
        if (chrome.runtime.lastError) {
          console.warn('[未回关卫士] 读取本地存储失败：', chrome.runtime.lastError.message);
          resolve({});
          return;
        }
        resolve(data || {});
      });
    });
  }
  function storageSet(obj) {
    return new Promise((resolve) => {
      chrome.storage.local.set(obj, () => {
        if (chrome.runtime.lastError) {
          console.warn('[未回关卫士] 写入本地存储失败：', chrome.runtime.lastError.message);
          resolve(false);
          return;
        }
        resolve(true);
      });
    });
  }
  // ---------- 高亮逻辑 ----------

  let highlightObserverDebounce = null;
  let lastHighlightStats = { checked: 0, marked: 0, hasData: false };

  async function isHighlightEnabled() {
    const data = await storageGet([HIGHLIGHT_STORAGE_KEY]);
    return data[HIGHLIGHT_STORAGE_KEY] !== false; // 默认开启
  }

  async function setHighlightEnabled(enabled) {
    await storageSet({ [HIGHLIGHT_STORAGE_KEY]: enabled });
    if (isMyListPage('following')) {
      if (enabled) await applyHighlights();
      else clearHighlights();
    }
  }

  function clearHighlights() {
    document.querySelectorAll('.xnfb-marked').forEach((cell) => {
      clearCellHighlight(cell);
    });
    lastHighlightStats = { checked: 0, marked: 0, hasData: false };
  }

  async function applyHighlights() {
    if (!isMyListPage('following')) {
      clearHighlights();
      return;
    }
    const enabled = await isHighlightEnabled();
    if (!enabled) {
      clearHighlights();
      return;
    }
    const me = myHandle();
    if (!me) return;

    let checked = 0;
    let marked = 0;
    const cells = followingUserCells();
    const allowedCells = new Set(cells);
    document.querySelectorAll('.xnfb-marked').forEach((cell) => {
      if (allowedCells.has(cell)) return;
      clearCellHighlight(cell);
    });
    cells.forEach((cell) => {
      const h = handleOf(cell);
      if (!h || h === me) {
        clearCellHighlight(cell);
        return;
      }
      checked += 1;
      let badge = cell.querySelector('.xnfb-badge');
      // X 在关注列表中直接显示「关注你」标识，无需另行扫描粉丝列表。
      if (followsMe(cell)) {
        clearCellHighlight(cell);
        return;
      }
      marked += 1;
      cell.classList.add('xnfb-marked');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'xnfb-badge';
        badge.textContent = '未回关';
        badge.title = '该账号没有回关你';
        badge.setAttribute('aria-label', '未回关');
      }
      if (!placeBadgeBesideFollowingButton(cell, badge)) {
        // Preserve the row highlight but never show a misaligned in-flow fallback badge.
        badge.parentElement?.classList.remove('xnfb-badge-anchor');
        cell.classList.remove('xnfb-badge-anchor');
        badge.remove();
      }
    });

    lastHighlightStats = { checked, marked, hasData: checked > 0 };
  }

  // ---------- 自动取关（危险操作，需谨慎） ----------
  // 只处理已标记为「未回关」的账号；跳过列表最前面若干位，并受本次和单日上限约束。

  const unfollowState = {
    running: false,
    me: null,
    processed: null,
    skipped: null,
    seen: null,
    seenCount: 0,
    nonFollowers: null,
    count: 0,
    limit: 20,
    skipFront: UNFOLLOW_SKIP_FRONT_DEFAULT,
    noProgressRounds: 0,
    sinceBreak: 0,
    sinceScroll: 0,
    nextScrollAfter: 3,
    nextBreakAt: UNFOLLOW_BREAK_EVERY_MIN,
    missingBtn: 0,
  };

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }
  async function readDailyUnfollow() {
    const data = await storageGet([UNFOLLOW_DAILY_KEY]);
    const rec = data[UNFOLLOW_DAILY_KEY];
    if (!rec || rec.day !== todayKey()) return 0;
    return rec.count || 0;
  }
  async function bumpDailyUnfollow() {
    const done = (await readDailyUnfollow()) + 1;
    await storageSet({ [UNFOLLOW_DAILY_KEY]: { day: todayKey(), count: done } });
    return done;
  }

  async function startAutoUnfollow(limit, skipFront) {
    if (!isMyListPage('following')) {
      notifyStatus('请先打开自己的「正在关注」页面再开始自动取关');
      return { ok: false, error: 'wrong_page' };
    }
    const me = myHandle();
    if (!me) {
      notifyStatus('未检测到登录账号');
      return { ok: false, error: 'no_login' };
    }
    await applyHighlights();
    if (!followingUserCells().length) {
      notifyStatus('正在关注列表还没加载出账号，请稍候再开始');
      return { ok: false, error: 'list_not_ready' };
    }
    const alreadyToday = await readDailyUnfollow();
    if (alreadyToday >= UNFOLLOW_DAILY_CAP) {
      notifyStatus(`今天已取关 ${alreadyToday} 人，达到安全上限，请明天再操作`);
      return { ok: false, error: 'daily_cap' };
    }
    const allowed = Math.min(Number(limit) || 20, UNFOLLOW_DAILY_CAP - alreadyToday);
    if (unfollowTimer) clearTimeout(unfollowTimer);
    unfollowState.running = true;
    unfollowState.me = me;
    unfollowState.processed = new Set();
    unfollowState.skipped = new Set();
    unfollowState.seen = new Map();
    unfollowState.seenCount = 0;
    unfollowState.nonFollowers = new Set();
    unfollowState.count = 0;
    unfollowState.limit = Math.max(1, Math.min(UNFOLLOW_LIMIT_MAX, allowed));
    const skipNum = Number(skipFront);
    unfollowState.skipFront = Number.isFinite(skipNum)
      ? Math.max(0, Math.min(UNFOLLOW_SKIP_FRONT_MAX, Math.floor(skipNum)))
      : UNFOLLOW_SKIP_FRONT_DEFAULT;
    unfollowState.noProgressRounds = 0;
    unfollowState.sinceBreak = 0;
    unfollowState.sinceScroll = 0;
    unfollowState.nextScrollAfter = Math.round(randomBetween(2, 4));
    unfollowState.missingBtn = 0;
    unfollowState.nextBreakAt = Math.round(randomBetween(UNFOLLOW_BREAK_EVERY_MIN, UNFOLLOW_BREAK_EVERY_MAX));
    notifyStatus(
      `自动取关中…0/${unfollowState.limit}（前 ${unfollowState.skipFront} 位暂不处理，今日安全上限剩 ${UNFOLLOW_DAILY_CAP - alreadyToday}）`
    );
    // 跳过 N 位需要稳定的列表起点，开始前先回到当前关注列表顶部，不离开此页面。
    await scrollListToStart();
    scheduleUnfollowTick(0);
    return { ok: true };
  }

  function scheduleUnfollowTick(delayMs) {
    if (unfollowTimer) clearTimeout(unfollowTimer);
    unfollowTimer = setTimeout(() => {
      unfollowTimer = null;
      unfollowTick().catch(async (error) => {
        console.error('[未回关卫士] 自动取关异常并停止：', error);
        await stopAutoUnfollow();
        notifyStatus(`自动取关遇到错误并已停止：${error?.message || '未知错误'}`);
      });
    }, delayMs);
  }

  async function stopAutoUnfollow() {
    const wasRunning = unfollowState.running;
    unfollowState.running = false;
    if (unfollowTimer) {
      clearTimeout(unfollowTimer);
      unfollowTimer = null;
    }
    if (wasRunning) notifyStatus(`已停止自动取关，本次共取关 ${unfollowState.count} 人`);
  }

  function isSameNonFollowerTarget(target) {
    return !!target?.cell?.isConnected &&
      handleOf(target.cell) === target.handle &&
      !followsMe(target.cell);
  }

  async function unfollowTick() {
    if (!unfollowState.running) return;

    if (!isCurrentAutoUnfollowPage()) {
      await stopAutoUnfollow();
      notifyStatus('账号或页面已变化，自动取关已停止。');
      return;
    }

    if (document.querySelector(CONFIRM_BTN_SELECTOR)) {
      await stopAutoUnfollow();
      notifyStatus('检测到已有确认弹窗，自动取关已停止；请先手动处理页面弹窗');
      return;
    }

    if (unfollowState.count >= unfollowState.limit) {
      unfollowState.running = false;
      notifyStatus(`自动取关完成，共取关 ${unfollowState.count} 人`);
      return;
    }
    await applyHighlights();
    if (!unfollowState.running) return;

    // 记录每个账号第一次出现的顺序，近似还原「正在关注」列表里从上到下的位置，
    // 用于跳过最前面 skipFront 位（他们可能还没来得及回关）
    const seenBefore = unfollowState.seenCount;
    followingUserCells().forEach((cell) => {
      const h = handleOf(cell);
      if (!h || !cellIsInViewport(cell)) return;
      if (h && !unfollowState.seen.has(h)) {
        unfollowState.seen.set(h, unfollowState.seenCount++);
      }
      if (h && unfollowState.seen.get(h) < unfollowState.skipFront) unfollowState.skipped.add(h);
      if (h && h !== unfollowState.me && !followsMe(cell)) unfollowState.nonFollowers.add(h);
    });
    const newlySeen = unfollowState.seenCount - seenBefore;

    const cells = followingUserCells();
    let target = null;
    for (const cell of cells) {
      const h = handleOf(cell);
      if (!h || !unfollowState.seen.has(h) || !cellIsInViewport(cell) || followsMe(cell) || unfollowState.processed.has(h)) continue;
      const pos = unfollowState.seen.get(h);
      if (pos != null && pos < unfollowState.skipFront) continue; // 保护期内，先不处理
      target = { cell, handle: h };
      break;
    }

    if (!target) {
      const before = listScrollMetrics();
      humanScroll(true);
      await sleep(450);
      let after = listScrollMetrics();
      let scrollMoved = Math.abs(after.top - before.top) > 8;
      if (!scrollMoved) {
        const currentCells = followingUserCells();
        const lastCell = currentCells[currentCells.length - 1];
        if (lastCell) {
          lastCell.scrollIntoView({ block: 'end', behavior: 'smooth' });
          await sleep(450);
          after = listScrollMetrics();
          scrollMoved = Math.abs(after.top - before.top) > 8;
        }
      }
      if (newlySeen > 0 || scrollMoved) unfollowState.noProgressRounds = 0;
      else unfollowState.noProgressRounds += 1;

      if (unfollowState.noProgressRounds >= UNFOLLOW_NO_PROGRESS_LIMIT) {
        unfollowState.running = false;
        if (unfollowState.missingBtn > 0) {
          notifyStatus(`已检查 ${unfollowState.seenCount} 个账号，发现 ${unfollowState.nonFollowers.size} 个未回关；其中 ${unfollowState.missingBtn} 个没有识别到“正在关注”按钮。本次取关 ${unfollowState.count} 人，请更新 X 页面后重试。`);
        } else if (!after.atEnd) {
          notifyStatus(`列表滚动或加载没有进展，已检查 ${unfollowState.seenCount} 个账号，识别到 ${unfollowState.nonFollowers.size} 个未回关，本次取关 ${unfollowState.count} 人。请先手动滚动列表一屏后重试。`);
        } else {
          notifyStatus(`已检查 ${unfollowState.seenCount} 个账号，发现 ${unfollowState.nonFollowers.size} 个未回关；跳过前 ${unfollowState.skipFront} 位，本次取关 ${unfollowState.count} 人，列表已到末尾。`);
        }
        return;
      }
      notifyStatus(`正在继续检查「正在关注」列表…已看到 ${unfollowState.seenCount} 个账号，识别到 ${unfollowState.nonFollowers.size} 个未回关`);
      scheduleUnfollowTick(randomBetween(900, 1500));
      return;
    }

    unfollowState.noProgressRounds = 0;
    const targetRect = target.cell.getBoundingClientRect();
    if (targetRect.top < 90 || targetRect.bottom > window.innerHeight - 90) {
      target.cell.scrollIntoView({ block: targetRect.top < 90 ? 'start' : 'end', behavior: 'smooth' });
    }
    await sleep(randomBetween(600, 1300));

    if (!unfollowState.running) return;
    if (!isCurrentAutoUnfollowPage()) {
      await stopAutoUnfollow();
      notifyStatus('页面已变化，自动取关已停止');
      return;
    }
    // X 会复用虚拟列表里的 DOM 节点；滚动等待期间先核对节点仍属于同一账号。
    if (!isSameNonFollowerTarget(target)) {
      notifyStatus('列表正在更新，重新识别当前账号…');
      scheduleUnfollowTick(1200);
      return;
    }
    let btn = unfollowButtonOf(target.cell);
    for (let attempt = 0; !btn && attempt < UNFOLLOW_BUTTON_RETRY_MAX; attempt += 1) {
      target.cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await sleep(randomBetween(350, 550));
      if (!unfollowState.running) return;
      btn = unfollowButtonOf(target.cell);
    }
    if (!btn) {
      unfollowState.missingBtn += 1;
      unfollowState.processed.add(target.handle);
      notifyStatus(`未找到 @${target.handle} 的“正在关注”按钮，继续检查后续账号…`);
      scheduleUnfollowTick(900);
      return;
    }
    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await sleep(randomBetween(250, 600));
    if (!unfollowState.running) return;
    btn.click();

    // 确认弹窗可能因为 DOM 变化没弹出来；而弹窗卡住不关时必须停下，
    // 否则下一轮会点到上一次残留的弹窗，造成失控连点
    let confirmBtn = await waitForSelector(CONFIRM_BTN_SELECTOR, CONFIRM_DIALOG_TIMEOUT_MS);
    if (!unfollowState.running) return;
    if (!confirmBtn) {
      const menuItem = unfollowMenuItem(target.handle);
      if (menuItem) {
        menuItem.click();
        confirmBtn = await waitForSelector(CONFIRM_BTN_SELECTOR, CONFIRM_DIALOG_TIMEOUT_MS);
      }
      if (!confirmBtn) {
        if (!(await waitForTargetUpdate(target, 1500))) {
          await stopAutoUnfollow();
          notifyStatus(`@${target.handle} 点击后页面没有出现确认操作，且关注状态未变化；已停止，避免继续误点。`);
          return;
        }
      }
    }

    if (confirmBtn) {
      await sleep(randomBetween(200, 600));
      if (!unfollowState.running) return;
      if (!isCurrentAutoUnfollowPage()) {
        await stopAutoUnfollow();
        notifyStatus('页面已变化，未确认取关；请检查页面弹窗');
        return;
      }
      if (!confirmBtn.isConnected || document.querySelector(CONFIRM_BTN_SELECTOR) !== confirmBtn) {
        await stopAutoUnfollow();
        notifyStatus('确认弹窗已变化，自动取关已停止；请手动检查页面');
        return;
      }
      confirmBtn.click();

      if (!(await waitForSelectorGone(CONFIRM_BTN_SELECTOR, CONFIRM_CLOSE_TIMEOUT_MS))) {
        // 先停再报原因：stopAutoUnfollow 自己也会写一条状态，顺序反了会把诊断信息盖掉
        await stopAutoUnfollow();
        notifyStatus('确认弹窗迟迟未关闭，已自动停止，请检查页面状态');
        return;
      }
      if (!(await waitForTargetUpdate(target, 5000))) {
        await stopAutoUnfollow();
        notifyStatus(`X 已关闭确认弹窗，但列表仍显示 @${target.handle} 正在关注；已停止，请刷新列表确认状态。`);
        return;
      }
    }
    if (!unfollowState.running) return;

    unfollowState.count += 1;
    unfollowState.sinceBreak += 1;
    await bumpDailyUnfollow();
    unfollowState.processed.add(target.handle);
    notifyStatus(`自动取关中…${unfollowState.count}/${unfollowState.limit}（刚取关 @${target.handle}）`);

    unfollowState.sinceScroll += 1;
    if (unfollowState.sinceScroll >= unfollowState.nextScrollAfter) {
      unfollowState.sinceScroll = 0;
      unfollowState.nextScrollAfter = Math.round(randomBetween(2, 4));
      humanScroll(false);
      await sleep(randomBetween(450, 900));
    }

    if (!unfollowState.running) return;

    if (unfollowState.sinceBreak >= unfollowState.nextBreakAt) {
      unfollowState.sinceBreak = 0;
      unfollowState.nextBreakAt = Math.round(randomBetween(UNFOLLOW_BREAK_EVERY_MIN, UNFOLLOW_BREAK_EVERY_MAX));
      const breakMs = randomBetween(UNFOLLOW_BREAK_MS_MIN, UNFOLLOW_BREAK_MS_MAX);
      notifyStatus(`自动取关中…${unfollowState.count}/${unfollowState.limit}（暂停 ${Math.round(breakMs / 1000)} 秒）`);
      scheduleUnfollowTick(breakMs);
      return;
    }

    scheduleUnfollowTick(humanDelay(UNFOLLOW_INTERVAL_MIN_MS, UNFOLLOW_INTERVAL_MAX_MS));
  }

  // ---------- 提取推文内容（供同步到 Binance Square 使用） ----------

  function extractTweetFromArticle(article) {
    if (!article) return null;
    const belongsToArticle = (node) => {
      const owner = node.closest('article[data-testid="tweet"]');
      return !owner || owner === article;
    };
    const textEl = Array.from(article.querySelectorAll('[data-testid="tweetText"]')).find(belongsToArticle);
    const text = textEl ? textEl.innerText.trim() : '';
    const permalink = Array.from(article.querySelectorAll('a[href*="/status/"]')).find(belongsToArticle);
    const sourceId = permalink?.getAttribute('href')?.match(/\/status\/(\d+)/)?.[1] || '';
    const videoElement = Array.from(article.querySelectorAll('video')).find(belongsToArticle);
    let video = null;
    if (videoElement) {
      const sources = [videoElement.currentSrc, videoElement.src, videoElement.querySelector('source')?.src].filter(Boolean);
      const directVideoUrl = sources.find((src) => {
        try {
          const url = new URL(src);
          return url.protocol === 'https:' && url.hostname === 'video.twimg.com' && /\.(mp4|mov|webm|avi)$/i.test(url.pathname);
        } catch {
          return false;
        }
      }) || '';
      video = {
        present: true,
        url: directVideoUrl,
        poster: videoElement.poster || '',
        duration: Number.isFinite(videoElement.duration) ? videoElement.duration : 0,
      };
    }
    const images = video ? [] : Array.from(article.querySelectorAll('img[src*="pbs.twimg.com/media"]'))
      .filter(belongsToArticle)
      .map((img) => img.src.replace(/name=\w+/, 'name=orig'))
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .slice(0, 4);
    return { text, images, video, sourceId };
  }

  // ---------- 每条推文旁的 Binance 图标按钮 ----------

  function setSyncBadgeState(badge, state, text) {
    const pendingReset = syncBadgeResetTimers.get(badge);
    if (pendingReset) clearTimeout(pendingReset);
    syncBadgeResetTimers.delete(badge);
    badge.dataset.state = state;
    badge.setAttribute('aria-label', text === '同步到 Square' ? '同步这条推文到 Binance Square' : text);
    badge.title = text;
    badge.replaceChildren();
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<g fill="currentColor"><path d="m12 1 3.1 3.1L12 7.2 8.9 4.1 12 1Zm0 15.8 3.1 3.1L12 23l-3.1-3.1 3.1-3.1ZM4.1 8.9 7.2 12l-3.1 3.1L1 12l3.1-3.1Zm15.8 0L23 12l-3.1 3.1-3.1-3.1 3.1-3.1ZM12 7.8l4.2 4.2-4.2 4.2L7.8 12 12 7.8Zm-5.3-1 2.2 2.2-2.2 2.2-2.2-2.2 2.2-2.2Zm10.6 6 2.2 2.2-2.2 2.2-2.2-2.2 2.2-2.2Zm-10.6 0 2.2 2.2-2.2 2.2-2.2-2.2 2.2-2.2Zm10.6-6 2.2 2.2-2.2 2.2-2.2-2.2 2.2-2.2Z"/></g>';
    badge.appendChild(icon);
  }

  function resetSyncBadgeLater(badge, delayMs) {
    syncBadgeResetTimers.set(badge, setTimeout(() => {
      setSyncBadgeState(badge, 'idle', '同步到 Square');
    }, delayMs));
  }

  function injectSyncBadges() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
      if (article.dataset[SYNC_BADGE_FLAG]) return;
      const actionBar = article.querySelector('[role="group"]');
      if (!actionBar) return;
      article.dataset[SYNC_BADGE_FLAG] = '1';

      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = SYNC_BADGE_CLASS;
      setSyncBadgeState(badge, 'idle', '同步到 Square');

      badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (badge.dataset.published === 'true') {
          if (badge.dataset.postUrl) {
            chrome.runtime.sendMessage({ type: 'xnfb:openSquarePost', url: badge.dataset.postUrl });
          } else {
            badge.title = '这条内容已提交；币安未返回帖子链接。请先检查 Square，避免重复发布。';
          }
          return;
        }
        if (badge.dataset.uncertain === 'true') {
          badge.title = '币安响应超时，帖子可能已经发布。请先检查 Square，确认不存在后再刷新页面重试。';
          return;
        }
        if (badge.dataset.state === 'syncing') return;
        const tweet = extractTweetFromArticle(article);
        if (!tweet || (!tweet.text && !tweet.images.length && !tweet.video)) {
          setSyncBadgeState(badge, 'failed', '内容为空');
          resetSyncBadgeLater(badge, 2000);
          return;
        }
        setSyncBadgeState(badge, 'syncing', '同步中…');
        const syncOptions = { allowNonMonetized: false, allowCashtagLimit: false };
        const handleSyncResponse = (resp) => {
          if (chrome.runtime.lastError) {
            badge.dataset.uncertain = 'true';
            setSyncBadgeState(badge, 'failed', '结果未知，请先检查 Square');
            badge.title = `扩展没有收到发布结果（${chrome.runtime.lastError.message}）。帖子可能已发布，请先检查 Square，勿直接重试。`;
            return;
          }
          if (resp?.needsCashtagLimitConfirmation) {
            const continueWithLimit = window.confirm(
              `${resp.error}\n\n继续发布吗？`
            );
            if (!continueWithLimit) {
              setSyncBadgeState(badge, 'failed', '已取消发布');
              badge.title = '已取消发布。可调整原文中的币种顺序后再同步。';
              resetSyncBadgeLater(badge, 2500);
              return;
            }
            syncOptions.allowCashtagLimit = true;
            setSyncBadgeState(badge, 'syncing', '正在发布…');
            sendSyncRequest();
            return;
          }
          if (resp?.needsMonetizationConfirmation) {
            const continueAnyway = window.confirm(
              `${resp.error}\n\n仍要发布这条内容吗？`
            );
            if (!continueAnyway) {
              setSyncBadgeState(badge, 'failed', '已取消发布');
              badge.title = '已取消：没有检测到可归因的币种 cashtag';
              resetSyncBadgeLater(badge, 2500);
              return;
            }
            syncOptions.allowNonMonetized = true;
            setSyncBadgeState(badge, 'syncing', '正在发布…');
            sendSyncRequest();
            return;
          }
          if (resp?.ok) {
            badge.dataset.published = 'true';
            badge.dataset.postUrl = resp.postUrl || '';
            const symbols = Array.isArray(resp.symbols) ? resp.symbols : [];
            const skipped = Array.isArray(resp.skippedSymbols) ? resp.skippedSymbols : [];
            const linked = symbols.length ? `；关联 ${symbols.map((symbol) => `$${symbol}`).join(' ')}` : '；无币种标记';
            const capped = skipped.length ? `；超出每帖3个上限，未关联 ${skipped.map((symbol) => `#${symbol}`).join(' ')}` : '';
            const openHint = resp.postUrl ? '；再点打开已发布帖子' : '；币安未返回帖子链接，勿重复发布';
            if (resp.alreadyPublished) {
              setSyncBadgeState(badge, 'done', `✓ 这条 X 内容之前已同步${linked}${openHint}`);
            } else {
              setSyncBadgeState(badge, 'done', `✓ 已发布${linked}${capped}${openHint}`);
            }
          } else if (resp?.uncertain) {
            badge.dataset.uncertain = 'true';
            setSyncBadgeState(badge, 'failed', '结果未知，请先检查 Square');
            badge.title = resp.error || '帖子可能已发布；请先检查 Square，勿直接重试';
          } else {
            setSyncBadgeState(badge, 'failed', '同步失败');
            badge.title = resp?.error || '未知错误';
            resetSyncBadgeLater(badge, 3000);
          }
        };
        const sendSyncRequest = () => {
          chrome.runtime.sendMessage({
            type: 'xnfb:syncToSquare',
            payload: tweet,
            ...syncOptions,
          }, handleSyncResponse);
        };
        sendSyncRequest();
      });

      const wrap = document.createElement('div');
      wrap.className = 'xnfb-sync-wrap';
      wrap.appendChild(badge);

      const actionButton = actionBar.querySelector(
        'button[data-testid="bookmark"], [role="button"][data-testid="bookmark"], ' +
        'button[aria-label*="Bookmark" i], [role="button"][aria-label*="Bookmark" i], ' +
        'button[aria-label*="书签"], [role="button"][aria-label*="书签"]'
      );
      let beforeItem = actionButton;
      if (!beforeItem) {
        const items = Array.from(actionBar.children);
        // X 通常把书签和分享按钮放在操作栏末尾；这里插入书签之前，落在浏览量和书签之间。
        beforeItem = items.length > 1 ? items[items.length - 2] : null;
      }
      if (beforeItem && beforeItem.parentElement !== actionBar) {
        while (beforeItem.parentElement && beforeItem.parentElement !== actionBar) beforeItem = beforeItem.parentElement;
      }
      if (beforeItem?.parentElement === actionBar) actionBar.insertBefore(wrap, beforeItem);
      else actionBar.appendChild(wrap);
    });
  }

  // ---------- 状态上报（供 popup 拉取） ----------

  let lastStatusText = '打开自己的「正在关注」列表，未回关账号会自动高亮';

  function notifyStatus(text) {
    lastStatusText = text;
  }

  // ---------- SPA 导航监听 ----------

  function onUrlMaybeChanged() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if ((!isMyListPage('following') || myHandle() !== unfollowState.me) && unfollowState.running) {
      // 离开了自己的「正在关注」页面，立刻停止自动取关，避免误操作
      stopAutoUnfollow();
    }
    if (isMyListPage('following')) {
      setTimeout(applyHighlights, 400);
    }
    setTimeout(injectSyncBadges, 400);
  }

  setInterval(onUrlMaybeChanged, 1000);

  // X 的时间线 DOM 非常吵，MutationObserver 每批变动都做全文档查询会明显掉帧，
  // 所以两类注入都合并到防抖里执行
  let syncBadgeDebounce = null;
  observer = new MutationObserver(() => {
    if (syncBadgeDebounce) clearTimeout(syncBadgeDebounce);
    syncBadgeDebounce = setTimeout(injectSyncBadges, 300);
    if (!isMyListPage('following')) return;
    if (highlightObserverDebounce) clearTimeout(highlightObserverDebounce);
    highlightObserverDebounce = setTimeout(applyHighlights, 400);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', () => {
    if (!isMyListPage('following')) return;
    if (highlightObserverDebounce) clearTimeout(highlightObserverDebounce);
    highlightObserverDebounce = setTimeout(applyHighlights, 120);
  });

  // ---------- 与 popup 的消息通道 ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg?.type) {
        case 'xnfb:getState': {
          const me = myHandle();
          const kind = pageKind();
          if (!me) {
            sendResponse({ me: null, kind, status: '未检测到登录账号' });
            break;
          }
          sendResponse({
            me,
            kind,
            myFollowingPage: isMyListPage('following'),
            followingListReady: isMyListPage('following') && followingUserCells().length > 0,
            status: lastStatusText,
            highlight: lastHighlightStats,
            highlightEnabled: await isHighlightEnabled(),
            unfollowing: unfollowState.running,
            unfollowCount: unfollowState.count,
            unfollowLimit: unfollowState.limit,
            unfollowSkipFront: unfollowState.skipFront,
            unfollowScanned: unfollowState.seenCount,
            unfollowNonFollowers: unfollowState.nonFollowers?.size || 0,
            unfollowSkipped: unfollowState.skipped?.size || 0,
            unfollowHandled: unfollowState.processed?.size || 0,
            unfollowToday: await readDailyUnfollow(),
            unfollowDailyCap: UNFOLLOW_DAILY_CAP,
          });
          break;
        }
        case 'xnfb:setHighlightEnabled':
          await setHighlightEnabled(!!msg.enabled);
          sendResponse({ ok: true });
          break;
        case 'xnfb:startAutoUnfollow':
        case 'xnfb:stopAutoUnfollow':
          if (msg.type === 'xnfb:startAutoUnfollow') {
            sendResponse(await startAutoUnfollow(msg.limit, msg.skipFront));
          } else {
            await stopAutoUnfollow();
            sendResponse({ ok: true });
          }
          break;
        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    })().catch((error) => {
      console.error('[未回关卫士] 处理页面操作失败：', error);
      sendResponse({
        ok: false,
        error: 'internal_error',
        message: error?.message || '未知脚本错误',
        status: `插件执行出错：${error?.message || '未知脚本错误'}`,
      });
    });
    return true; // 异步响应
  });

  // ---------- 初始化 ----------

  (async () => {
    if (isMyListPage('following')) applyHighlights();
    injectSyncBadges();
  })();
})();
