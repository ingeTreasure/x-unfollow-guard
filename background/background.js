/**
 * background/background.js
 * MV3 service worker：负责直连 Binance Square OpenAPI 发帖。
 * Binance OpenAPI Key 只发送给 Binance；媒体只从 X 的图片/视频 CDN 读取。
 */
'use strict';

const V1_BASE = 'https://www.binance.com/bapi/composite/v1/public/pgc/openApi';
const V2_BASE = 'https://www.binance.com/bapi/composite/v2/public/pgc/openApi';
const API_KEY_STORAGE_KEY = 'xnfb.binanceApiKey';
const PUBLISHED_SOURCE_POSTS_KEY = 'xnfb.squarePublishedSourcePosts';
const MEDIA_EXTENSION_CONTENT_TYPE = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  webm: 'video/webm',
};
const IMAGE_STATUS_POLL_INTERVAL_MS = 1200;
const IMAGE_STATUS_MAX_POLLS = 20;
const VIDEO_STATUS_POLL_INTERVAL_MS = 3000;
const VIDEO_STATUS_MAX_POLLS = 20;
const FETCH_TIMEOUT_MS = 20000;
const SPOT_EXCHANGE_INFO_URL = 'https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT';
const SPOT_ASSET_CACHE_KEY = 'xnfb.binanceSpotAssets.v2';
const SPOT_ASSET_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SPOT_ASSET_CACHE_MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SQUARE_CASHTAGS = 3;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_VIDEO_DURATION_SECONDS = 600;
const MAX_SHORT_POST_CHARACTERS = 2100;

function getApiKey() {
  return new Promise((resolve) => {
    chrome.storage.local.get([API_KEY_STORAGE_KEY], (data) => resolve(data[API_KEY_STORAGE_KEY] || ''));
  });
}

function getCachedSpotAssets() {
  return new Promise((resolve) => {
    chrome.storage.local.get([SPOT_ASSET_CACHE_KEY], (data) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(data?.[SPOT_ASSET_CACHE_KEY] || null);
    });
  });
}

function cacheSpotAssets(assets, fetchedAt) {
  return new Promise((resolve) => {
    chrome.storage.local.set({
      [SPOT_ASSET_CACHE_KEY]: { assets, fetchedAt },
    }, () => resolve(!chrome.runtime.lastError));
  });
}

async function getSpotAssetSet() {
  const cached = await getCachedSpotAssets();
  const cachedAssets = Array.isArray(cached?.assets) ? cached.assets : [];
  const cacheAge = Date.now() - Number(cached?.fetchedAt || 0);
  if (cachedAssets.length && cacheAge >= 0 && cacheAge < SPOT_ASSET_CACHE_TTL_MS) {
    return new Set(cachedAssets);
  }

  try {
    const response = await fetchWithTimeout(SPOT_EXCHANGE_INFO_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    }, 12000);
    if (!response.ok) throw new Error(`获取币种列表失败（HTTP ${response.status}）`);
    const info = await response.json();
    if (!Array.isArray(info?.symbols)) throw new Error('币种列表格式无法识别');

    const assets = Array.from(new Set(info.symbols
      .filter((symbol) => symbol?.status === 'TRADING')
      .flatMap((symbol) => [symbol.baseAsset, symbol.quoteAsset])
      .filter((asset) => typeof asset === 'string')
      .map((asset) => asset.trim().toUpperCase())
      .filter((asset) => /^[A-Z0-9]{1,20}$/.test(asset))));
    if (!assets.length) throw new Error('币安返回的现货币种列表为空');

    await cacheSpotAssets(assets, Date.now());
    return new Set(assets);
  } catch (error) {
    // If Binance is temporarily unavailable, reuse only a recent cache; do not guess symbols.
    if (cachedAssets.length && cacheAge >= 0 && cacheAge < SPOT_ASSET_CACHE_MAX_STALE_MS) {
      return new Set(cachedAssets);
    }
    throw new Error(`无法核验币安现货币种，未发布帖子：${error?.message || '请求失败'}`);
  }
}

function isHashtagInsideUrl(text, index) {
  return /(?:https?:\/\/|www\.)\S*$/i.test(text.slice(0, index));
}

async function prepareSquareText(text) {
  const explicitSymbols = Array.from(text.matchAll(/(?:^|[^A-Za-z0-9_])\$([A-Za-z0-9]{1,20})(?![A-Za-z0-9_])/g))
    .filter((match) => !isHashtagInsideUrl(text, match.index + match[0].indexOf('$')))
    .map((match) => match[1].toUpperCase())
    .filter((symbol, index, symbols) => symbols.indexOf(symbol) === index);
  const hasCandidateHashtag = Array.from(text.matchAll(/#([A-Za-z0-9]{1,20})(?![A-Za-z0-9_])/g))
    .some((match) => match.index === 0 || (text[match.index - 1] !== '#' && !isHashtagInsideUrl(text, match.index)));
  if (!hasCandidateHashtag && !explicitSymbols.length) return { text, symbols: [], skippedSymbols: [] };

  const spotAssets = await getSpotAssetSet();
  const symbols = new Set(explicitSymbols.filter((symbol) => spotAssets.has(symbol)));
  if (symbols.size > MAX_SQUARE_CASHTAGS) {
    throw new Error(`币安每帖最多 ${MAX_SQUARE_CASHTAGS} 个币种标记；原文已有 ${symbols.size} 个有效币种，请保留最相关的 ${MAX_SQUARE_CASHTAGS} 个后再同步`);
  }
  const skippedSymbols = new Set();
  const convertedText = text.replace(/#([A-Za-z0-9]{1,20})(?![A-Za-z0-9_])/g, (tag, rawSymbol, index) => {
    if ((index > 0 && text[index - 1] === '#') || isHashtagInsideUrl(text, index)) return tag;
    const symbol = rawSymbol.toUpperCase();
    if (!spotAssets.has(symbol)) return tag;
    if (!symbols.has(symbol) && symbols.size >= MAX_SQUARE_CASHTAGS) {
      skippedSymbols.add(symbol);
      return tag;
    }
    symbols.add(symbol);
    return `$${symbol}`;
  });
  return { text: convertedText, symbols: Array.from(symbols), skippedSymbols: Array.from(skippedSymbols) };
}

function getPublishedSourcePost(sourceId) {
  if (!/^\d{5,30}$/.test(String(sourceId || ''))) return Promise.resolve(null);
  return new Promise((resolve) => {
    chrome.storage.local.get([PUBLISHED_SOURCE_POSTS_KEY], (data) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(data?.[PUBLISHED_SOURCE_POSTS_KEY]?.[sourceId] || null);
    });
  });
}

function rememberPublishedSourcePost(sourceId, post) {
  if (!/^\d{5,30}$/.test(String(sourceId || ''))) return Promise.resolve(false);
  return new Promise((resolve) => {
    chrome.storage.local.get([PUBLISHED_SOURCE_POSTS_KEY], (data) => {
      if (chrome.runtime.lastError) return resolve(false);
      const entries = { ...(data?.[PUBLISHED_SOURCE_POSTS_KEY] || {}) };
      entries[sourceId] = { ...post, publishedAt: Date.now() };
      const retained = Object.entries(entries)
        .sort((a, b) => Number(b[1]?.publishedAt || 0) - Number(a[1]?.publishedAt || 0))
        .slice(0, 500);
      chrome.storage.local.set({
        [PUBLISHED_SOURCE_POSTS_KEY]: Object.fromEntries(retained),
      }, () => resolve(!chrome.runtime.lastError));
    });
  });
}

// 不加超时的话，接口挂起会让推文下方的小标签永远停在「同步中…」
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('请求超时，请稍后重试');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function binancePost(url, body, apiKey) {
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Square-OpenAPI-Key': apiKey,
      clienttype: 'binanceSkill',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// X 的图片地址把格式放在 ?format= 查询参数里（/media/xxx?format=jpg），
// 光看扩展名会全部落到 jpg 兜底，导致 PNG 被按 image/jpeg 上传
function guessExtension(url) {
  try {
    const format = new URL(url).searchParams.get('format');
    if (format) return format.toLowerCase();
  } catch {
    // 非法地址就走下面的扩展名兜底
  }
  const clean = url.split('?')[0];
  const ext = (clean.split('.').pop() || '').toLowerCase();
  return /^[a-z]{2,4}$/.test(ext) ? ext : 'jpg';
}

async function uploadOneImage(imageUrl, apiKey) {
  const imgRes = await fetchWithTimeout(imageUrl);
  if (!imgRes.ok) throw new Error(`图片下载失败（HTTP ${imgRes.status}）`);
  const blob = await imgRes.blob();

  const ext = guessExtension(imageUrl);
  const imageName = `xnfb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const pre = await binancePost(`${V2_BASE}/image/presignedUrl`, { imageName }, apiKey);
  if (pre.json?.code !== '000000' || !pre.json?.data) {
    throw new Error(pre.json?.message || `获取图片上传地址失败（code=${pre.json?.code}）`);
  }
  const { presignedUrl, fileTicket } = pre.json.data;

  const contentType = MEDIA_EXTENSION_CONTENT_TYPE[ext] || 'image/jpeg';
  const putRes = await fetchWithTimeout(
    presignedUrl,
    {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: blob,
    },
    60000
  );
  if (!putRes.ok) throw new Error(`图片上传失败（HTTP ${putRes.status}）`);

  for (let i = 0; i < IMAGE_STATUS_MAX_POLLS; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, IMAGE_STATUS_POLL_INTERVAL_MS));
    const st = await binancePost(`${V2_BASE}/image/imageStatus`, { fileTicket }, apiKey);
    const data = st.json?.data;
    if (data?.status === 1 && data.imageUrl) return data.imageUrl;
    if (data?.status === 2) throw new Error(data.failedReason || '图片处理失败');
  }
  throw new Error('图片处理超时，请稍后重试');
}

async function uploadOneVideo(video, apiKey) {
  let videoUrl;
  let posterUrl;
  try {
    videoUrl = new URL(video.url);
    posterUrl = new URL(video.poster);
  } catch {
    throw new Error('无法读取视频或封面地址；该 X 视频格式暂不支持同步');
  }
  if (videoUrl.protocol !== 'https:' || videoUrl.hostname !== 'video.twimg.com') {
    throw new Error('只支持可直接读取的 X 视频文件；当前视频流格式暂不支持');
  }
  if (posterUrl.protocol !== 'https:' || posterUrl.hostname !== 'pbs.twimg.com') {
    throw new Error('未找到可用的视频封面，暂不能同步这条视频');
  }

  const ext = (videoUrl.pathname.split('.').pop() || '').toLowerCase();
  const contentType = MEDIA_EXTENSION_CONTENT_TYPE[ext];
  if (!contentType?.startsWith('video/')) {
    throw new Error('当前只支持 X 提供的 MP4、MOV、AVI 或 WebM 直链视频');
  }
  const duration = Number(video.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_VIDEO_DURATION_SECONDS) {
    throw new Error('视频时长无效或超过 10 分钟限制');
  }

  const videoRes = await fetchWithTimeout(video.url, {}, 60000);
  if (!videoRes.ok) throw new Error(`视频读取失败（HTTP ${videoRes.status}）`);
  const blob = await videoRes.blob();
  if (!blob.size) throw new Error('视频文件为空');
  if (blob.size > MAX_VIDEO_BYTES) throw new Error('视频超过 200 MB，不能同步到 Square');

  const fileName = `xnfb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const pre = await binancePost(`${V2_BASE}/video/preSign`, { fileName, size: blob.size }, apiKey);
  if (pre.json?.code !== '000000' || !pre.json?.data) {
    throw new Error(pre.json?.message || `获取视频上传地址失败（code=${pre.json?.code}）`);
  }
  const { presignedUrl, fileTicket } = pre.json.data;
  const putRes = await fetchWithTimeout(presignedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: blob,
  }, 180000);
  if (!putRes.ok) throw new Error(`视频上传失败（HTTP ${putRes.status}）`);

  let ready = false;
  for (let i = 0; i < VIDEO_STATUS_MAX_POLLS; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, VIDEO_STATUS_POLL_INTERVAL_MS));
    const status = await binancePost(`${V2_BASE}/image/imageStatus`, { fileTicket }, apiKey);
    if (status.json?.data?.status === 1) {
      ready = true;
      break;
    }
    if (status.json?.data?.status === 2) {
      throw new Error(status.json.data.failedReason || '视频处理失败');
    }
  }
  if (!ready) throw new Error('视频处理超时，请稍后重试');

  const cover = await uploadOneImage(video.poster, apiKey);
  return {
    contentType: 3,
    fileTicket,
    cover,
    videoTimeSeconds: duration,
    isPublish: true,
    ...(video.text ? { bodyTextOnly: video.text } : {}),
  };
}

async function syncToSquare({ text, images, video, sourceId, allowNonMonetized = false, allowCashtagLimit = false }) {
  const priorPost = await getPublishedSourcePost(sourceId);
  if (priorPost) {
    return { ok: true, alreadyPublished: true, postId: priorPost.postId || '', postUrl: priorPost.postUrl || '', symbols: priorPost.symbols || [] };
  }
  const apiKey = await getApiKey();
  if (!apiKey) return { ok: false, error: '请先在插件面板中填写并保存 Binance OpenAPI Key' };
  const sourceText = typeof text === 'string' ? text : '';
  let bodyTextOnly = sourceText;
  let tokenSymbols = [];
  let skippedSymbols = [];
  try {
    const prepared = await prepareSquareText(sourceText);
    bodyTextOnly = prepared.text;
    tokenSymbols = prepared.symbols;
    skippedSymbols = prepared.skippedSymbols;
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
  if (skippedSymbols.length && !allowCashtagLimit) {
    return {
      ok: false,
      needsCashtagLimitConfirmation: true,
      symbols: tokenSymbols,
      skippedSymbols,
      error: `这条内容识别到超过 ${MAX_SQUARE_CASHTAGS} 个可交易币种。插件优先保留原文已有的有效 $币种标记，再按 #标签出现顺序关联；本次会关联 ${tokenSymbols.map((symbol) => `$${symbol}`).join(' ')}，其余标签保持普通话题。`,
    };
  }
  if (!tokenSymbols.length && !allowNonMonetized) {
    return {
      ok: false,
      needsMonetizationConfirmation: true,
      error: '同步正文中未检测到可归因的币安币种引用（如 $BTC）。普通话题标签通常不能形成币种点击归因。',
    };
  }
  if (Array.from(bodyTextOnly).length > MAX_SHORT_POST_CHARACTERS) {
    return { ok: false, error: `Square 短帖最多 ${MAX_SHORT_POST_CHARACTERS} 个字符；当前正文过长，未发布。长文章需要单独设置标题和封面。` };
  }
  if (!video?.present && !bodyTextOnly.trim()) {
    return { ok: false, error: 'Square OpenAPI 需要正文；纯图片推文无法通过此同步功能发布' };
  }
  if (video?.present && images?.length) {
    return { ok: false, error: 'Square 不支持同一条帖子同时包含视频和图片；未发布' };
  }

  try {
    let body;
    if (video?.present) {
      body = await uploadOneVideo({ ...video, text: bodyTextOnly }, apiKey);
    } else {
      let imageList;
      if (images && images.length) {
        imageList = [];
        for (const url of images.slice(0, 4)) {
          imageList.push(await uploadOneImage(url, apiKey));
        }
      }

      body = { contentType: 1, bodyTextOnly };
      if (imageList && imageList.length) body.imageList = imageList;
    }

    let r;
    try {
      r = await binancePost(`${V1_BASE}/content/add`, body, apiKey);
    } catch (err) {
      return {
        ok: false,
        uncertain: true,
        error: `Square 发布请求没有得到确认（${err?.message || '网络错误'}）。帖子可能已发布，请先检查 Square，再决定是否重试。`,
      };
    }
    if (r.json?.code === '000000') {
      const postId = r.json?.data?.id == null ? '' : String(r.json.data.id);
      const postUrl = /^\d+$/.test(postId)
        ? `https://www.binance.com/en/square/post/${postId}`
        : '';
      await rememberPublishedSourcePost(sourceId, { postId, postUrl, symbols: tokenSymbols });
      return { ok: true, symbols: tokenSymbols, skippedSymbols, postId, postUrl };
    }
    if (r.status >= 500) {
      return { ok: false, uncertain: true, error: '币安没有及时返回结果，帖子可能已发布。请先检查 Square 最新内容，再决定是否重试。' };
    }
    return { ok: false, error: r.json?.message || `发布失败（code=${r.json?.code ?? r.status}）` };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'xnfb:syncToSquare') {
    syncToSquare({
      ...(msg.payload || {}),
      allowNonMonetized: !!msg.allowNonMonetized,
      allowCashtagLimit: !!msg.allowCashtagLimit,
    }).then(sendResponse);
    return true;
  }
  if (msg?.type === 'xnfb:openSquarePost') {
    try {
      const url = new URL(msg.url);
      if (url.origin !== 'https://www.binance.com' || !/^\/en\/square\/post\/\d+\/?$/.test(url.pathname)) {
        sendResponse({ ok: false });
        return false;
      }
      chrome.tabs.create({ url: url.href }, () => sendResponse({ ok: !chrome.runtime.lastError }));
    } catch {
      sendResponse({ ok: false });
    }
    return true;
  }
  return false;
});
