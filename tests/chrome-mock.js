// Local preview only. This file is excluded from the release package.
(() => {
  const persisted = new URLSearchParams(location.search).has('design') ? {} : JSON.parse(localStorage.getItem('guard-fixture') || '{}');
  if (new URLSearchParams(location.search).has('history')) {
    persisted['xnfb.squarePublishedSourcePosts'] = { '123456789': { postId: '987654321', postUrl: 'https://www.binance.com/en/square/post/987654321', symbols: ['BTC', 'ETH'], publishedAt: Date.now() - 3600000 } };
    persisted['xnfb.squarePendingSourcePosts'] = { '234567890': { startedAt: Date.now() - 60000 } };
  }
  const changes = [];
  const state = { me: 'your_handle', myFollowingPage: true, followingListReady: true, status: '等待识别关注列表', highlight: { hasData: false }, highlightEnabled: true, unfollowToday: 0, unfollowDailyCap: 200, unfollowing: false };
  function write(values, callback) {
    const delta = {};
    for (const [key, value] of Object.entries(values)) { delta[key] = { oldValue: persisted[key], newValue: value }; persisted[key] = value; }
    localStorage.setItem('guard-fixture', JSON.stringify(persisted));
    callback?.(); changes.forEach((listener) => listener(delta, 'local'));
  }
  window.chrome = {
    runtime: { lastError: null, sendMessage(message, callback) { if (message.type === 'xnfb:clearPendingPost') { const pending = { ...(persisted['xnfb.squarePendingSourcePosts'] || {}) }; delete pending[message.sourceId]; write({ 'xnfb.squarePendingSourcePosts': pending }); } callback({ ok: true }); } },
    tabs: {
      async query() { return new URLSearchParams(location.search).has('offline') ? [{ id: 1, url: 'https://example.com/' }] : [{ id: 1, url: 'https://x.com/your_handle/following' }]; },
      sendMessage(id, message, callback) {
        if (message.type === 'xnfb:startAutoUnfollow') Object.assign(state, { unfollowing: true, unfollowLimit: message.limit, unfollowScanned: 0, unfollowCount: 0, status: '自动取关中，测试环境不会操作真实账号' });
        if (message.type === 'xnfb:stopAutoUnfollow') Object.assign(state, { unfollowing: false, status: '已停止自动取关' });
        callback(message.type === 'xnfb:getState' ? state : { ok: true });
      }, update() {}, create() {}
    },
    storage: { local: {
      get(keys, callback) { callback(Object.fromEntries(keys.filter((key) => key in persisted).map((key) => [key, persisted[key]]))); },
      set: write,
      remove(key, callback) { delete persisted[key]; localStorage.setItem('guard-fixture', JSON.stringify(persisted)); callback?.(); }
    }, onChanged: { addListener(listener) { changes.push(listener); } } }
  };
})();
