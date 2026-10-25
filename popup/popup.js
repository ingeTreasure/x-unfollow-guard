(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const KEYS = { api: 'xnfb.binanceApiKey', prefs: 'xnfb.unfollowPreferences', protected: 'xnfb.protectedHandles', highlight: 'xnfb.highlightEnabled', posts: 'xnfb.squarePublishedSourcePosts', pending: 'xnfb.squarePendingSourcePosts', daily: 'xnfb.unfollowDaily' };
  let activeTabId = null;
  let currentState = null;
  let refreshing = false;
  let starting = false;
  let historyLimit = 20;
  let lastHistory = '';

  function storage(method, value) {
    return new Promise((resolve, reject) => chrome.storage.local[method](value, (result) => {
      const error = chrome.runtime.lastError;
      error ? reject(new Error(error.message)) : resolve(result || {});
    }));
  }
  function sendToTab(message) {
    return new Promise((resolve) => {
      if (activeTabId == null) return resolve(null);
      chrome.tabs.sendMessage(activeTabId, message, (response) => resolve(chrome.runtime.lastError ? null : response));
    });
  }
  function sendToWorker(message) {
    return new Promise((resolve) => chrome.runtime.sendMessage(message, (response) => resolve(chrome.runtime.lastError ? null : response)));
  }
  function status(id, text, error = false) { $(id).textContent = text; $(id).classList.toggle('error', error); }
  function integer(value, min, max, fallback) {
    const number = String(value).trim() ? Number(value) : NaN;
    return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
  }
  function preferences() {
    return { limit: integer($('unfollowLimit').value, 1, 200, 20), skipFront: integer($('unfollowSkipFront').value, 0, 1000, 0) };
  }
  async function savePreferences() {
    const prefs = preferences();
    $('unfollowLimit').value = prefs.limit;
    $('unfollowSkipFront').value = prefs.skipFront;
    try { await storage('set', { [KEYS.prefs]: prefs }); }
    catch { status('unfollowStatusLine', '参数保存失败，请重试', true); }
  }
  function confirmAction(title, description, action) {
    const dialog = $('confirmDialog');
    if (dialog.open) return Promise.resolve(false);
    $('confirmTitle').textContent = title;
    $('confirmDescription').textContent = description;
    $('btnConfirmAction').textContent = action;
    $('confirmNote').classList.toggle('hidden', title !== '确认开始取关');
    dialog.returnValue = 'cancel';
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
      dialog.showModal();
    });
  }
  function chooseTab(name) {
    document.querySelectorAll('[role=tab]').forEach((tab) => {
      const selected = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      $(`panel-${tab.dataset.tab}`).classList.toggle('hidden', !selected);
    });
    document.querySelector('main').scrollTop = 0;
    if (name === 'history') loadHistory().catch(() => status('statusLine', '同步记录读取失败', true));
  }
  document.querySelectorAll('[role=tab]').forEach((tab, index, tabs) => {
    tab.addEventListener('click', () => chooseTab(tab.dataset.tab));
    tab.addEventListener('keydown', (event) => {
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
      if (next === null) return;
      event.preventDefault(); chooseTab(tabs[next].dataset.tab); tabs[next].focus();
    });
  });

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const onX = /^https:\/\/(x\.com|twitter\.com)\//.test(tab?.url || '');
      activeTabId = onX ? tab.id : null;
      const state = onX ? await sendToTab({ type: 'xnfb:getState' }) : null;
      currentState = state?.me ? state : null;
      $('meHandle').textContent = state?.me ? `@${state.me}` : '尚未连接 X';
      $('btnOpenFollowing').textContent = state?.me ? '打开关注列表' : '打开 X';
      status('statusLine', !onX ? '在 X 标签页打开插件，即可识别当前账号' : !state ? '页面连接未就绪，请刷新 X 页面后重试' : !state.me ? '请先登录 X，再打开自己的关注列表' : state.status || '等待识别关注列表');
      const hasData = state?.myFollowingPage && state.highlight?.hasData;
      $('checkedCount').textContent = hasData ? state.highlight.checked : '—';
      $('markedCount').textContent = hasData ? state.highlight.marked : '—';
      const running = !!state?.unfollowing;
      $('btnAutoUnfollow').classList.toggle('hidden', running);
      $('btnStopUnfollow').classList.toggle('hidden', !running);
      $('btnAutoUnfollow').disabled = starting || !state?.myFollowingPage || !state?.followingListReady || state.unfollowToday >= (state.unfollowDailyCap || 200);
      $('unfollowLimit').disabled = running || starting;
      $('unfollowSkipFront').disabled = running || starting;
      if (state?.me) {
        $('todayUnfollow').replaceChildren(document.createTextNode(String(state.unfollowToday || 0)), Object.assign(document.createElement('small'), { textContent: `/${state.unfollowDailyCap || 200}` }));
        $('todayUnfollow').classList.toggle('danger', state.unfollowToday >= 180);
        if (running || state.unfollowScanned) {
          status('unfollowStatusLine', `${running ? '运行中' : '本次结束'} · 已扫描 ${state.unfollowScanned || 0} · 跳过 ${state.unfollowSkipped || 0} · 已取关 ${state.unfollowCount || 0}/${state.unfollowLimit || 20}`);
        } else if (!$('unfollowStatusLine').classList.contains('error')) status('unfollowStatusLine', '');
      }
    } catch { status('statusLine', '连接失败，请重新打开插件', true); }
    finally { refreshing = false; }
  }

  $('btnOpenFollowing').addEventListener('click', () => {
    const handle = currentState?.me;
    const url = /^[A-Za-z0-9_]{1,15}$/.test(handle || '') ? `https://x.com/${handle}/following` : 'https://x.com/home';
    if (activeTabId != null) chrome.tabs.update(activeTabId, { url });
    else chrome.tabs.create({ url });
  });
  $('toggleHighlight').addEventListener('change', async (event) => {
    try { await storage('set', { [KEYS.highlight]: event.target.checked }); await sendToTab({ type: 'xnfb:setHighlightEnabled', enabled: event.target.checked }); await refresh(); }
    catch { event.target.checked = !event.target.checked; status('statusLine', '设置保存失败，请重试', true); }
  });
  ['unfollowLimit', 'unfollowSkipFront'].forEach((id) => {
    $(id).addEventListener('change', savePreferences);
    // Popup may close before blur/change; persist while typing without disrupting the field.
    $(id).addEventListener('input', () => storage('set', { [KEYS.prefs]: preferences() }).catch(() => status('unfollowStatusLine', '参数保存失败，请重试', true)));
  });
  const errors = { wrong_page: '请先打开自己的关注列表', no_login: '请先登录 X', list_not_ready: '列表尚未加载，请稍后重试', daily_cap: '今日已达 200 人上限', already_running: '已有取关任务在运行，请先停止', storage_error: '本地记录保存失败，已停止操作' };
  $('btnAutoUnfollow').addEventListener('click', async () => {
    if (starting) return;
    starting = true; $('btnAutoUnfollow').disabled = true; status('unfollowStatusLine', '');
    try {
      const { limit, skipFront } = preferences();
      const handle = currentState?.me || '';
      const approved = await confirmAction('确认开始取关', `账号 @${handle}：跳过列表前 ${skipFront} 位，最多取关 ${limit} 个未回关账号。保护名单内账号会跳过；随后自动处理 X 的逐账号确认弹窗。`, '确认取关');
      if (!approved) return;
      await savePreferences();
      const response = await sendToTab({ type: 'xnfb:startAutoUnfollow', limit, skipFront });
      if (!response?.ok) status('unfollowStatusLine', response?.message || errors[response?.error] || '无法连接页面，请刷新 X 后重试', true);
    } finally { starting = false; await refresh(); }
  });
  $('btnStopUnfollow').addEventListener('click', async () => {
    const response = await sendToTab({ type: 'xnfb:stopAutoUnfollow' });
    if (!response?.ok) status('unfollowStatusLine', '停止指令未送达，请立即关闭正在执行的 X 标签页', true);
    await refresh();
  });
  $('btnSaveProtected').addEventListener('click', async () => {
    const tokens = $('protectedHandles').value.split(/[\s,，;；]+/).filter(Boolean).map((item) => item.replace(/^@/, '').toLowerCase());
    if (tokens.some((item) => !/^[a-z0-9_]{1,15}$/.test(item))) return status('protectionStatus', '请输入有效 X 用户名，不要填写网址', true);
    const handles = [...new Set(tokens)];
    if (handles.length > 1000) return status('protectionStatus', '最多保存 1,000 位账号', true);
    try {
      await storage('set', { [KEYS.protected]: handles });
      $('protectedHandles').value = handles.map((handle) => `@${handle}`).join('\n');
      $('protectedCount').textContent = `${handles.length} 位`;
      status('protectionStatus', '已保存，运行中的任务也会跳过');
    } catch { status('protectionStatus', '保存失败，请重试', true); }
  });
  async function updateKeyState() {
    const data = await storage('get', [KEYS.api]);
    const configured = !!data[KEYS.api];
    $('keyState').textContent = configured ? '已配置 · 本地保存' : '未配置';
    $('keyState').classList.toggle('connected', configured);
  }
  $('btnSaveKey').addEventListener('click', async () => {
    const key = $('binanceApiKey').value.trim();
    if (!key) return status('syncStatusLine', '请先填写 Key；删除请使用「清除」', true);
    try { await storage('set', { [KEYS.api]: key }); $('binanceApiKey').value = ''; await updateKeyState(); status('syncStatusLine', 'Key 已保存在本机，可到推文下点击币安图标'); }
    catch { status('syncStatusLine', 'Key 保存失败，请重试', true); }
  });
  $('btnClearKey').addEventListener('click', async () => {
    if (!await confirmAction('清除本地 Key', '清除后将暂停一键同步；已发布记录会保留。', '确认清除')) return;
    try { await storage('remove', KEYS.api); $('binanceApiKey').value = ''; await updateKeyState(); status('syncStatusLine', '已清除本地 Key'); }
    catch { status('syncStatusLine', '清除失败，请重试', true); }
  });

  function safePostUrl(value) {
    try { const url = new URL(value); return url.origin === 'https://www.binance.com' && /^\/en\/square\/post\/\d+\/?$/.test(url.pathname) ? url.href : ''; } catch { return ''; }
  }
  function link(text, url) { const element = document.createElement('a'); element.textContent = text; element.href = url; element.target = '_blank'; element.rel = 'noreferrer'; return element; }
  async function loadHistory() {
    const data = await storage('get', [KEYS.posts, KEYS.pending]);
    const fingerprint = JSON.stringify([data, historyLimit]);
    if (lastHistory === fingerprint) return;
    lastHistory = fingerprint;
    const posts = data[KEYS.posts] || {};
    const entries = [...Object.entries(posts).map(([id, post]) => ({ id, ...post })), ...Object.entries(data[KEYS.pending] || {}).filter(([id]) => !posts[id]).map(([id, post]) => ({ id, ...post, uncertain: true }))].filter((post) => /^\d{5,30}$/.test(post.id)).sort((a, b) => (b.publishedAt || b.startedAt || 0) - (a.publishedAt || a.startedAt || 0));
    $('historyCount').textContent = `${entries.length} 条`;
    $('historyList').replaceChildren();
    $('btnMoreHistory').classList.toggle('hidden', entries.length <= historyLimit);
    if (!entries.length) {
      const empty = document.createElement('div'); empty.className = 'empty-state';
      empty.innerHTML = '<img src="../icons/icon128.png" alt="" /><h3>还没有同步记录</h3><p>配置 Key 后，在 X 推文下点击币安图标。<br />成功同步的内容会出现在这里。</p>';
      $('historyList').appendChild(empty); return;
    }
    for (const post of entries.slice(0, historyLimit)) {
      const row = document.createElement('article'); row.className = 'history-item';
      const heading = document.createElement('h3'); heading.textContent = post.uncertain ? '待核实 · 已阻止重复发布' : '已同步至 Square';
      const date = document.createElement('p'); date.textContent = new Date(post.publishedAt || post.startedAt || 0).toLocaleString('zh-CN', { hour12: false });
      const info = document.createElement('p'); info.textContent = `X #${post.id}${Array.isArray(post.symbols) && post.symbols.length ? ' · ' + post.symbols.map((symbol) => `$${symbol}`).join(' ') : ''}`;
      const links = document.createElement('div'); links.className = 'history-links'; links.appendChild(link('查看 X 原帖 ↗', `https://x.com/i/status/${post.id}`));
      const url = safePostUrl(post.postUrl);
      if (url) links.appendChild(link('查看 Square ↗', url));
      if (post.uncertain) {
        const release = document.createElement('button'); release.className = 'text-button'; release.textContent = '已核实未发布';
        release.addEventListener('click', async () => {
          if (!await confirmAction('解除重复发布保护', '仅在确认 Square 中不存在这条帖子后解除。若帖子已经发布，再次同步会造成重复内容。', '确认未发布')) return;
          const response = await sendToWorker({ type: 'xnfb:clearPendingPost', sourceId: post.id });
          if (!response?.ok) { release.textContent = response?.error || '解除失败，请重试'; return; }
          await loadHistory();
        });
        links.appendChild(release);
      }
      row.append(heading, date, info, links); $('historyList').appendChild(row);
    }
  }
  $('btnMoreHistory').addEventListener('click', () => { historyLimit += 20; loadHistory(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[KEYS.posts] || changes[KEYS.pending]) loadHistory().catch(() => {});
    if (changes[KEYS.highlight]) $('toggleHighlight').checked = changes[KEYS.highlight].newValue !== false;
  });
  (async () => {
    try {
      const data = await storage('get', Object.values(KEYS));
      $('unfollowLimit').value = integer(data[KEYS.prefs]?.limit ?? 20, 1, 200, 20);
      $('unfollowSkipFront').value = integer(data[KEYS.prefs]?.skipFront ?? 0, 0, 1000, 0);
      const handles = Array.isArray(data[KEYS.protected]) ? data[KEYS.protected] : [];
      $('protectedHandles').value = handles.map((handle) => `@${handle}`).join('\n'); $('protectedCount').textContent = `${handles.length} 位`;
      $('toggleHighlight').checked = data[KEYS.highlight] !== false;
      const today = new Date(); const day = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;
      if (data[KEYS.daily]?.day === day) $('todayUnfollow').replaceChildren(document.createTextNode(String(data[KEYS.daily].count || 0)), Object.assign(document.createElement('small'), { textContent: '/200' }));
      await updateKeyState();
    } catch { status('statusLine', '本地数据读取失败，请重新打开插件', true); }
    await refresh();
  })();
  const poll = setInterval(refresh, 2000);
  window.addEventListener('unload', () => clearInterval(poll));
})();
