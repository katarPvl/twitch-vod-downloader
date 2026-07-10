// Service worker: запросы к Twitch GQL/usher, запуск загрузок клипов,
// открытие менеджера загрузки VOD. Долгие загрузки здесь не ведутся —
// MV3 останавливает service worker посреди работы.

// Публичный client-id веб-плеера Twitch. Периодически ротируется,
// поэтому при ошибке «Client-ID header is invalid» актуальное значение
// достаётся заново из HTML главной страницы и кэшируется в storage.
const DEFAULT_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const GQL_URL = 'https://gql.twitch.tv/gql';

async function getClientId() {
  const { clientId } = await chrome.storage.local.get('clientId');
  return clientId || DEFAULT_CLIENT_ID;
}

async function rediscoverClientId() {
  const resp = await fetch('https://www.twitch.tv/', { credentials: 'omit' });
  const html = await resp.text();
  const m = html.match(/clientId\s*[:=]\s*"([a-z0-9]{20,40})"/i);
  if (!m) throw new Error('Не удалось определить актуальный Client-ID Twitch');
  await chrome.storage.local.set({ clientId: m[1] });
  return m[1];
}

async function gqlRequest(body, clientId) {
  const resp = await fetch(GQL_URL, {
    method: 'POST',
    headers: { 'Client-ID': clientId, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error('Twitch GQL недоступен (HTTP ' + resp.status + ')');
  }
}

async function gql(query, variables) {
  let clientId = await getClientId();
  let json = await gqlRequest({ query, variables }, clientId);
  const hasGqlErrors = json && Array.isArray(json.errors) && json.errors.length > 0;
  if ((!json || !json.data) && !hasGqlErrors) {
    // Ответ без data и без GraphQL-ошибок — чаще всего протух client-id
    // (Twitch его ротирует). Не завязываемся на текст ошибки: пробуем один
    // раз обновить client-id со страницы Twitch и повторить запрос.
    let fresh = null;
    try {
      fresh = await rediscoverClientId();
    } catch (_) {
      // главная страница недоступна — оставляем исходный ответ
    }
    if (fresh && fresh !== clientId) {
      json = await gqlRequest({ query, variables }, fresh);
    }
  }
  if (json && Array.isArray(json.errors) && json.errors.length) {
    throw new Error('Twitch GQL: ' + json.errors.map((e) => e.message).join('; '));
  }
  if (!json || !json.data) {
    throw new Error('Twitch GQL: пустой ответ (' + JSON.stringify(json).slice(0, 200) + ')');
  }
  return json.data;
}

// ---------- VOD ----------

const VOD_QUERY = `query($id: ID!) {
  video(id: $id) {
    title
    lengthSeconds
    createdAt
    owner { login displayName }
  }
  videoPlaybackAccessToken(id: $id, params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) {
    value
    signature
  }
}`;

function parseAttrList(s) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
  let m;
  while ((m = re.exec(s))) attrs[m[1]] = m[2] !== undefined ? m[2] : m[3];
  return attrs;
}

function parseMasterPlaylist(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = parseAttrList(lines[i].slice('#EXT-X-STREAM-INF:'.length));
    let url = '';
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j].trim();
      if (l && !l.startsWith('#')) { url = l; break; }
    }
    if (!url) continue;
    const group = attrs['VIDEO'] || '';
    if (group === 'audio_only') continue;
    const res = attrs['RESOLUTION'] || '';
    const height = res.includes('x') ? parseInt(res.split('x')[1], 10) : 0;
    const fps = Math.round(parseFloat(attrs['FRAME-RATE'] || '30')) || 30;
    const bandwidth = parseInt(attrs['BANDWIDTH'] || '0', 10) || 0;
    const isSource = group === 'chunked';
    let label = height ? height + 'p' + (fps !== 30 ? fps : '') : (group || 'видео');
    if (isSource) label += ' (source)';
    out.push({ label, url, height, fps, bandwidth, isSource });
  }
  out.sort((a, b) => (b.isSource - a.isSource) || (b.height - a.height) || (b.bandwidth - a.bandwidth));
  return out;
}

async function getVodInfo(vodId) {
  const d = await gql(VOD_QUERY, { id: vodId });
  if (!d.video) throw new Error('VOD не найден: удалён или недоступен');
  const token = d.videoPlaybackAccessToken;
  if (!token) throw new Error('Twitch не выдал токен воспроизведения для этого VOD');
  try {
    const auth = JSON.parse(token.value).authorization;
    if (auth && auth.forbidden) {
      throw new Error('Доступ запрещён: скорее всего, VOD только для подписчиков канала');
    }
  } catch (e) {
    if (String(e.message).startsWith('Доступ запрещён')) throw e;
  }
  const usherUrl = 'https://usher.ttvnw.net/vod/' + encodeURIComponent(vodId) + '.m3u8' +
    '?sig=' + encodeURIComponent(token.signature) +
    '&token=' + encodeURIComponent(token.value) +
    '&allow_source=true&allow_audio_only=false&player=twitchweb';
  const resp = await fetch(usherUrl);
  if (!resp.ok) {
    if (resp.status === 403) throw new Error('usher вернул 403: вероятно, VOD только для подписчиков');
    throw new Error('usher.ttvnw.net ответил ' + resp.status);
  }
  const qualities = parseMasterPlaylist(await resp.text());
  if (!qualities.length) throw new Error('В мастер-плейлисте не найдено ни одного качества');
  return {
    kind: 'vod',
    id: vodId,
    title: d.video.title || 'untitled',
    channel: (d.video.owner && (d.video.owner.displayName || d.video.owner.login)) || 'unknown',
    date: (d.video.createdAt || '').slice(0, 10),
    lengthSeconds: d.video.lengthSeconds || 0,
    qualities,
  };
}

// ---------- Клипы ----------

const CLIP_QUERY = `query($slug: ID!) {
  clip(slug: $slug) {
    title
    durationSeconds
    createdAt
    broadcaster { login displayName }
    playbackAccessToken(params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) {
      signature
      value
    }
    videoQualities { frameRate quality sourceURL }
  }
}`;

async function getClipInfo(slug) {
  const d = await gql(CLIP_QUERY, { slug });
  const clip = d.clip;
  if (!clip) throw new Error('Клип не найден: удалён или недоступен');
  const token = clip.playbackAccessToken;
  if (!token || !Array.isArray(clip.videoQualities) || !clip.videoQualities.length) {
    throw new Error('Twitch не выдал ссылки на файл клипа');
  }
  const qualities = clip.videoQualities
    .filter((q) => q.sourceURL)
    .map((q) => {
      const fps = Math.round(q.frameRate || 0);
      return {
        label: q.quality + 'p' + (fps && fps !== 30 ? fps : ''),
        url: q.sourceURL +
          '?sig=' + encodeURIComponent(token.signature) +
          '&token=' + encodeURIComponent(token.value),
        height: parseInt(q.quality, 10) || 0,
      };
    });
  qualities.sort((a, b) => b.height - a.height);
  return {
    kind: 'clip',
    id: slug,
    title: clip.title || 'clip',
    channel: (clip.broadcaster && (clip.broadcaster.displayName || clip.broadcaster.login)) || 'unknown',
    date: (clip.createdAt || '').slice(0, 10),
    lengthSeconds: clip.durationSeconds || 0,
    qualities,
  };
}

// ---------- Сообщения ----------

async function handleMessage(msg) {
  switch (msg.type) {
    case 'getVodInfo':
      return getVodInfo(msg.id);
    case 'getClipInfo':
      return getClipInfo(msg.slug);
    case 'downloadClip':
      await chrome.downloads.download({ url: msg.url, filename: msg.filename });
      return { started: true };
    case 'startVodDownload': {
      const jobId = 'job_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      await chrome.storage.local.set({ [jobId]: msg.job });
      await chrome.tabs.create({ url: chrome.runtime.getURL('manager.html#' + jobId) });
      return { jobId };
    }
    case 'cleanupJob':
      await chrome.storage.local.remove(msg.jobId);
      return {};
    default:
      throw new Error('Неизвестный тип сообщения: ' + msg.type);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg).then(
    (data) => sendResponse({ ok: true, data }),
    (err) => sendResponse({ ok: false, error: (err && err.message) || String(err) })
  );
  return true;
});
