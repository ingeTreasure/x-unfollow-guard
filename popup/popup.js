// popup/popup.js
(function () {
  'use strict';

  const els = {
    notLoggedIn: document.getElementById('notLoggedIn'),
    mainPanel: document.getElementById('mainPanel'),
    meHandle: document.getElementById('meHandle'),
    todayUnfollow: document.getElementById('todayUnfollow'),
    statusLine: document.getElementById('statusLine'),
    toggleHighlight: document.getElementById('toggleHighlight'),
    followingStats: document.getElementById('followingStats'),
    checkedCount: document.getElementById('checkedCount'),
    markedCount: document.getElementById('markedCount'),
    unfollowLimit: document.getElementById('unfollowLimit'),
    unfollowSkipFront: document.getElementById('unfollowSkipFront'),
    btnAutoUnfollow: document.getElementById('btnAutoUnfollow'),
    btnStopUnfollow: document.getElementById('btnStopUnfollow'),
    unfollowStatusLine: document.getElementById('unfollowStatusLine'),
    unfollowHint: document.getElementById('unfollowHint'),
    binanceApiKey: document.getElementById('binanceApiKey'),
    btnSaveKey: document.getElementById('btnSaveKey'),
    syncStatusLine: document.getElementById('syncStatusLine'),
  };

  const API_KEY_STORAGE_KEY = 'xnfb.binanceApiKey';
  let unfollowError = '';

  let activeTabId = null;

  // 回调里必须读一次 lastError：页面在插件安装前就打开时内容脚本还没注入，
  // sendMessage 会失败，不读的话 Chrome 会报「Unchecked runtime.lastError」
  function sendToTab(msg) {
    return new Promise((resolve) => {
      if (activeTabId == null) return resolve(null);
      chrome.tabs.sendMessage(activeTabId, msg, (resp) => {
        if (chrome.runtime.lastError) return resolve({ __unreachable: true });
        resolve(resp || null);
      });
    });
  }

  function clampNumber(raw, min, max, fallback) {
    const text = String(raw ?? '').trim();
    if (!text) return fallback;
    const n = Number(text);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
  }

  function showHint(text) {
    els.notLoggedIn.textContent = text;
    els.notLoggedIn.classList.remove('hidden');
    els.mainPanel.classList.add('hidden');
  }

  function renderUnfollowStatus(state) {
    let headline = '';
    if (unfollowError) {
      headline = unfollowError;
    } else if (state.unfollowing) {
      headline = `自动取关中…${state.unfollowCount}/${state.unfollowLimit}`;
    } else if (state.unfollowCount > 0) {
      headline = `上次共取关 ${state.unfollowCount} 人`;
    }

    const scanned = Number(state.unfollowScanned) || 0;
    const progress = state.myFollowingPage && (state.unfollowing || scanned > 0)
      ? `已扫过 ${scanned} 人 · 未回关 ${Number(state.unfollowNonFollowers) || 0} 人 · 跳过 ${Number(state.unfollowSkipped) || 0} 人 · 本次取关 ${Number(state.unfollowCount) || 0} 人`
      : '';
    els.unfollowStatusLine.textContent = [headline, progress].filter(Boolean).join('｜');
  }

  async function refresh() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !/^https:\/\/(x\.com|twitter\.com)\//.test(tab.url || '')) {
      showHint('请在 X（x.com）标签页打开本插件');
      return;
    }
    activeTabId = tab.id;

    const state = await sendToTab({ type: 'xnfb:getState' });
    if (state && state.__unreachable) {
      showHint('内容脚本未就绪，请刷新该 X 页面后重试');
      return;
    }
    if (!state || !state.me) {
      showHint(state?.status || '未检测到登录账号，请先登录 X');
      return;
    }

    els.notLoggedIn.classList.add('hidden');
    els.mainPanel.classList.remove('hidden');

    els.meHandle.textContent = `@${state.me}`;
    els.statusLine.textContent = state.status || (state.myFollowingPage
      ? '正在关注列表会自动标记未回关账号'
      : '打开自己的「正在关注」列表自动标记未回关账号');
    els.toggleHighlight.checked = state.highlightEnabled !== false;
    const dailyCap = state.unfollowDailyCap || 200;
    const today = state.unfollowToday || 0;
    els.todayUnfollow.textContent = `${today} / ${dailyCap} 人`;
    els.todayUnfollow.classList.toggle('danger', dailyCap - today <= 20);

    if (state.myFollowingPage && state.highlight?.hasData) {
      els.followingStats.classList.remove('hidden');
      els.checkedCount.textContent = state.highlight.checked;
      els.markedCount.textContent = state.highlight.marked;
    } else {
      els.followingStats.classList.add('hidden');
    }
    els.btnAutoUnfollow.classList.toggle('hidden', state.unfollowing);
    els.btnStopUnfollow.classList.toggle('hidden', !state.unfollowing);
    const readyToUnfollow = state.myFollowingPage && state.followingListReady;
    els.btnAutoUnfollow.disabled = !readyToUnfollow;
    if (!state.myFollowingPage) {
      els.unfollowHint.textContent = '进入自己的「正在关注」列表后会直接识别并高亮未回关账号；自动取关也在当前列表执行。';
    } else if (!state.followingListReady) {
      els.unfollowHint.textContent = '正在读取当前列表…加载出账号后即可高亮并开始处理。';
    } else if (state.highlightEnabled === false) {
      els.unfollowHint.textContent = '高亮显示已关闭；如开始自动取关，仍会在当前列表识别未回关账号。';
    } else {
      els.unfollowHint.textContent = '仅处理当前列表中识别为未回关的账号。开始前会再次确认，随后自动处理 X 的逐账号确认弹窗；可随时停止。请谨慎使用。';
    }
    renderUnfollowStatus(state);

  }

  els.toggleHighlight.addEventListener('change', async (e) => {
    await sendToTab({ type: 'xnfb:setHighlightEnabled', enabled: e.target.checked });
    setTimeout(refresh, 200);
  });

  const UNFOLLOW_ERRORS = {
    wrong_page: '请先打开自己的「正在关注」页面',
    no_login: '未检测到登录账号，请先登录 X',
    list_not_ready: '正在关注列表还没加载出账号，请稍候再开始',
    daily_cap: '今日取关已达安全上限，请明天再继续',
  };
  els.btnAutoUnfollow.addEventListener('click', async () => {
    unfollowError = '';
    const limit = clampNumber(els.unfollowLimit.value, 1, 200, 20);
    const skipFront = clampNumber(els.unfollowSkipFront.value, 0, 1000, 0);
    els.unfollowLimit.value = limit;
    els.unfollowSkipFront.value = skipFront;
    if (!confirm(`将在自己的「正在关注」页自动取消最多 ${limit} 个未回关账号（跳过前 ${skipFront} 位）。开始后会自动确认 X 对每个账号显示的弹窗。此操作不可撤销，确定继续吗？`)) return;
    const resp = await sendToTab({ type: 'xnfb:startAutoUnfollow', limit, skipFront });
    if (!resp || resp.__unreachable) unfollowError = '无法连接页面，请刷新 X 页面后重试';
    else if (resp.ok === false) unfollowError = resp.message || UNFOLLOW_ERRORS[resp.error] || '启动失败';
    setTimeout(refresh, 300);
  });
  els.btnStopUnfollow.addEventListener('click', async () => {
    await sendToTab({ type: 'xnfb:stopAutoUnfollow' });
    setTimeout(refresh, 300);
  });

  async function loadApiKey() {
    const data = await new Promise((resolve) => chrome.storage.local.get([API_KEY_STORAGE_KEY], resolve));
    els.binanceApiKey.value = data[API_KEY_STORAGE_KEY] || '';
  }

  els.btnSaveKey.addEventListener('click', async () => {
    const key = els.binanceApiKey.value.trim();
    await new Promise((resolve) => chrome.storage.local.set({ [API_KEY_STORAGE_KEY]: key }, resolve));
    els.syncStatusLine.textContent = key ? 'Key 已保存到本地，去推文下方点「同步到 Square」即可' : '已清空 Key';
  });

  loadApiKey();
  refresh();
  const poll = setInterval(refresh, 2000);
  window.addEventListener('unload', () => clearInterval(poll));
})();
