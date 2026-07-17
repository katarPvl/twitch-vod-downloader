// Кнопка «Скачать» и панель выбора качества на страницах VOD и клипов.
// Twitch — SPA: кнопка переустанавливается при клиентской навигации и
// ре-рендерах плеера (интервальная проверка вместо хрупких подписок на DOM).

(() => {
  const BTN_ID = 'tvd-btn';
  const PANEL_ID = 'tvd-panel';
  let currentKey = '';
  let videoInfo = null; // ответ background для текущего видео

  // ---------- определение видео по URL ----------

  function detectVideo() {
    const host = location.hostname;
    const path = location.pathname;
    let m;
    if (host === 'clips.twitch.tv') {
      m = path.match(/^\/([A-Za-z0-9_-]+)/);
      if (m && m[1] !== 'embed') return { kind: 'clip', id: m[1] };
      return null;
    }
    m = path.match(/^\/videos\/(\d+)/);
    if (m) return { kind: 'vod', id: m[1] };
    m = path.match(/^\/[^/]+\/clip\/([A-Za-z0-9_-]+)/);
    if (m) return { kind: 'clip', id: m[1] };
    return null;
  }

  // ---------- вспомогательные ----------

  function sanitizeName(s) {
    return s
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 150)
      .replace(/^[. ]+|[. ]+$/g, '') || 'video';
  }

  // «1:23:45», «23:45», «45» -> секунды; пустая строка -> null; мусор -> NaN
  function parseTime(s) {
    s = (s || '').trim();
    if (!s) return null;
    if (!/^\d+(:[0-5]?\d){0,2}$/.test(s)) return NaN;
    return s.split(':').reduce((acc, p) => acc * 60 + parseInt(p, 10), 0);
  }

  // fmtTime и fmtBytes — в shared.js

  function el(id) {
    return document.getElementById(id);
  }

  // ---------- кнопка ----------

  function findPlayerContainer() {
    const video = document.querySelector('video');
    if (!video) return null;
    return (
      video.closest('[data-a-target="video-player"]') ||
      video.closest('.video-player__container') ||
      video.closest('.video-player') ||
      video.parentElement
    );
  }

  function ensureButton() {
    const info = detectVideo();
    const key = info ? info.kind + ':' + info.id : '';
    if (!info) {
      const btn = el(BTN_ID);
      if (btn) btn.remove();
      closePanel();
      currentKey = '';
      return;
    }
    if (key !== currentKey) {
      closePanel();
      videoInfo = null;
      const btn = el(BTN_ID);
      if (btn) btn.remove();
      currentKey = key;
    }
    if (el(BTN_ID)) return;
    const container = findPlayerContainer();
    if (!container) return;
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    const b = document.createElement('button');
    b.id = BTN_ID;
    b.type = 'button';
    b.textContent = '⬇ ' + t('download');
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      togglePanel(container, info);
    });
    container.appendChild(b);
  }

  setInterval(ensureButton, 1000);

  // ---------- панель ----------

  function closePanel() {
    const p = el(PANEL_ID);
    if (p) p.remove();
  }

  function togglePanel(container, info) {
    if (el(PANEL_ID)) {
      closePanel();
      return;
    }
    const p = document.createElement('div');
    p.id = PANEL_ID;
    p.innerHTML = `
      <div class="tvd-title">${t(info.kind === 'vod' ? 'downloadVod' : 'downloadClip')}</div>
      <div class="tvd-meta" id="tvd-meta">&nbsp;</div>
      <div class="tvd-form" id="tvd-form" hidden>
        <label class="tvd-label">${t('quality')}
          <select id="tvd-quality"></select>
        </label>
        <div class="tvd-range" id="tvd-range" hidden>
          <label class="tvd-label tvd-half">${t('from')}
            <input id="tvd-from" type="text" placeholder="0:00:00" spellcheck="false">
          </label>
          <label class="tvd-label tvd-half">${t('to')}
            <input id="tvd-to" type="text" placeholder="${t('untilEnd')}" spellcheck="false">
          </label>
        </div>
        <div class="tvd-est" id="tvd-est"></div>
        <button type="button" class="tvd-download" id="tvd-download">${t('download')}</button>
      </div>
      <div class="tvd-status" id="tvd-status"></div>
    `;
    p.addEventListener('click', (e) => e.stopPropagation());
    // Клавиши в полях «От»/«До» не должны дёргать хоткеи плеера Twitch
    for (const t of ['keydown', 'keyup', 'keypress']) {
      p.addEventListener(t, (e) => e.stopPropagation());
    }
    container.appendChild(p);
    loadInfo(info, p);
  }

  function setStatus(text, isError) {
    const s = el('tvd-status');
    if (!s) return;
    s.textContent = text;
    s.classList.toggle('tvd-error', !!isError);
  }

  async function loadInfo(info, panel) {
    if (!videoInfo) {
      setStatus(t('loadingVideoInfo'));
      let resp;
      try {
        resp = await chrome.runtime.sendMessage(
          info.kind === 'vod'
            ? { type: 'getVodInfo', id: info.id }
            : { type: 'getClipInfo', slug: info.id }
        );
      } catch (e) {
        resp = { ok: false, error: (e && e.message) || String(e) };
      }
      // Панель закрыли или пересоздали, пока шёл запрос, — ответ уже не наш:
      // повторный renderForm навесил бы второй обработчик «Скачать»
      if (el(PANEL_ID) !== panel) return;
      if (!resp || !resp.ok) {
        setStatus(t('errorPrefix', resp ? resp.error : t('noExtensionResponse')), true);
        return;
      }
      videoInfo = resp.data;
    }
    renderForm(videoInfo);
  }

  function renderForm(v) {
    setStatus('');
    el('tvd-meta').textContent = v.channel + ' — ' + v.title;
    const form = el('tvd-form');
    form.hidden = false;
    const select = el('tvd-quality');
    select.innerHTML = '';
    v.qualities.forEach((q, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = q.label;
      select.appendChild(opt);
    });
    if (v.kind === 'vod') {
      el('tvd-range').hidden = false;
      el('tvd-from').addEventListener('input', () => updateEstimate(v));
      el('tvd-to').addEventListener('input', () => updateEstimate(v));
    }
    select.addEventListener('change', () => updateEstimate(v));
    updateEstimate(v);
    el('tvd-download').addEventListener('click', () => submit(v));
  }

  function selectedQuality(v) {
    const i = parseInt(el('tvd-quality').value, 10) || 0;
    return v.qualities[i] || v.qualities[0];
  }

  function readRange(v) {
    if (v.kind !== 'vod') return { from: 0, to: v.lengthSeconds };
    let from = parseTime(el('tvd-from').value);
    let to = parseTime(el('tvd-to').value);
    if (Number.isNaN(from) || Number.isNaN(to)) return { error: t('invalidTime') };
    if (from === null) from = 0;
    if (to === null || to > v.lengthSeconds) to = v.lengthSeconds;
    if (from >= to) return { error: t('fromBeforeTo') };
    if (from >= v.lengthSeconds) return { error: t('fromBeyondVideo', fmtTime(v.lengthSeconds)) };
    return { from, to };
  }

  function updateEstimate(v) {
    const est = el('tvd-est');
    if (!est) return;
    const q = selectedQuality(v);
    if (v.kind !== 'vod' || !q.bandwidth) {
      est.textContent = v.kind === 'vod' ? '' : t('duration', fmtTime(v.lengthSeconds));
      return;
    }
    const r = readRange(v);
    if (r.error) {
      est.textContent = '';
      return;
    }
    const bytes = (q.bandwidth / 8) * (r.to - r.from);
    est.textContent = t('rangeEstimate', [fmtTime(r.from), fmtTime(r.to), fmtBytes(bytes)]);
  }

  async function submit(v) {
    const q = selectedQuality(v);
    const btn = el('tvd-download');
    if (v.kind === 'clip') {
      const filename = sanitizeName(`${v.channel}_${v.title}_${v.date}_${q.label}`) + '.mp4';
      btn.disabled = true;
      setStatus(t('startingDownload'));
      let resp;
      try {
        resp = await chrome.runtime.sendMessage({ type: 'downloadClip', url: q.url, filename });
      } catch (e) {
        resp = { ok: false, error: (e && e.message) || String(e) };
      }
      if (resp && resp.ok) {
        setStatus(t('clipDownloadStarted'));
      } else {
        btn.disabled = false;
        setStatus(t('errorPrefix', resp ? resp.error : t('noResponse')), true);
      }
      return;
    }
    const r = readRange(v);
    if (r.error) {
      setStatus(r.error, true);
      return;
    }
    const isPartial = r.from > 0 || r.to < v.lengthSeconds;
    const rangePart = isPartial
      ? '_' + fmtTime(r.from).replace(/:/g, '.') + '-' + fmtTime(r.to).replace(/:/g, '.')
      : '';
    const filename = sanitizeName(`${v.channel}_${v.title}_${v.date}_${q.label}${rangePart}`) + '.mp4';
    const job = {
      playlistUrl: q.url,
      filename,
      title: v.title,
      channel: v.channel,
      date: v.date,
      qualityLabel: q.label,
      bandwidth: q.bandwidth,
      fromSec: r.from,
      toSec: r.to,
      lengthSeconds: v.lengthSeconds,
    };
    btn.disabled = true;
    setStatus(t('openingManager'));
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: 'startVodDownload', job });
    } catch (e) {
      resp = { ok: false, error: (e && e.message) || String(e) };
    }
    btn.disabled = false;
    if (resp && resp.ok) {
      setStatus(t('managerOpened'));
    } else {
      setStatus(t('errorPrefix', resp ? resp.error : t('noResponse')), true);
    }
  }
})();
