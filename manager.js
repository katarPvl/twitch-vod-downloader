// Менеджер загрузки VOD. Работает в отдельной вкладке расширения, чтобы
// загрузку не убил service worker (MV3) и не прервала навигация по Twitch.
//
// Конвейер: сегменты HLS (MPEG-TS) скачиваются параллельно, но строго по
// порядку проходят через mux.js (TS -> fragmented MP4) и порционно пишутся
// на диск через File System Access API. Память ограничена окном упреждающей
// загрузки независимо от длины VOD.

const CONCURRENCY = 4;   // одновременных запросов сегментов
const MAX_AHEAD = 8;     // максимум скачанных, но ещё не записанных сегментов
const RETRIES = 4;       // повторов на сегмент при ошибках сети

const ui = {
  meta: document.getElementById('meta'),
  startBlock: document.getElementById('startBlock'),
  startBtn: document.getElementById('startBtn'),
  progressBlock: document.getElementById('progressBlock'),
  barFill: document.getElementById('barFill'),
  stats: document.getElementById('stats'),
  cancelBtn: document.getElementById('cancelBtn'),
  doneBlock: document.getElementById('doneBlock'),
  errorBlock: document.getElementById('errorBlock'),
};

document.documentElement.lang = chrome.i18n.getUILanguage().split('-')[0];
document.title = t('managerPageTitle');
document.getElementById('pageTitle').textContent = t('managerHeading');
document.getElementById('startHint').textContent = t('managerHint');
ui.startBtn.textContent = t('chooseFile');
ui.cancelBtn.textContent = t('cancel');

let running = false;

// fmtTime и fmtBytes — в shared.js (подключён в manager.html)

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function showError(message) {
  ui.startBlock.hidden = true;
  ui.progressBlock.hidden = true;
  ui.errorBlock.hidden = false;
  ui.errorBlock.innerHTML = '';
  const head = document.createElement('div');
  head.textContent = t('errorPrefix', message);
  const retry = document.createElement('button');
  retry.className = 'primary';
  retry.textContent = t('tryAgain');
  retry.addEventListener('click', () => location.reload());
  ui.errorBlock.append(head, retry);
}

// ---------- разбор медиа-плейлиста ----------

function parseMediaPlaylist(text, playlistUrl) {
  const base = playlistUrl.slice(0, playlistUrl.lastIndexOf('/') + 1);
  const lines = text.split(/\r?\n/);
  const segs = [];
  let t = 0;
  let dur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) {
      dur = parseFloat(line.slice(8)) || 0;
    } else if (line && !line.startsWith('#') && dur !== null) {
      const url = /^https?:/i.test(line) ? line : base + line;
      segs.push({ url, duration: dur, start: t });
      t += dur;
      dur = null;
    }
  }
  return segs;
}

// ---------- загрузка ----------

async function download(job, fileHandle) {
  let writable = null;
  let userCancelled = false;
  let aborted = false;
  let firstError = null;
  const controllers = new Set();

  ui.cancelBtn.onclick = () => {
    userCancelled = true;
    aborted = true;
    for (const c of controllers) c.abort();
    ui.cancelBtn.disabled = true;
    ui.cancelBtn.textContent = t('cancelling');
  };

  try {
    writable = await fileHandle.createWritable();
    const resp = await fetch(job.playlistUrl);
    if (!resp.ok) throw new Error(t('playlistFetchFailed', String(resp.status)));
    const all = parseMediaPlaylist(await resp.text(), job.playlistUrl);
    if (!all.length) throw new Error(t('playlistEmpty'));

    const segs = all.filter(
      (s) => s.start + s.duration > job.fromSec && s.start < job.toSec
    );
    if (!segs.length) throw new Error(t('noSegments'));

    // Транс-мукс: один Transmuxer на всю загрузку, сегменты подаются строго
    // по порядку — так сохраняется непрерывность таймстемпов.
    const transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: false });
    let pendingChunks = [];
    let initWritten = false;
    transmuxer.on('data', (segment) => {
      if (!initWritten && segment.initSegment) {
        pendingChunks.push(segment.initSegment);
        initWritten = true;
      }
      pendingChunks.push(segment.data);
    });

    let bytesDone = 0;
    let bytesWritten = 0;
    const speedWindow = []; // {t, bytes} за последние секунды

    const buffers = new Map(); // index -> ArrayBuffer
    let fetchIdx = 0;
    let writeIdx = 0;

    async function fetchSegment(seg) {
      for (let attempt = 0; ; attempt++) {
        if (aborted) throw new Error(t('downloadCancelledError'));
        const ac = new AbortController();
        controllers.add(ac);
        try {
          const r = await fetch(seg.url, { signal: ac.signal });
          if (!r.ok) {
            const err = new Error(t('segmentHttpError', String(r.status)));
            // 4xx (кроме 408/429) повтором не лечатся — падаем сразу
            err.fatal = r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429;
            throw err;
          }
          return await r.arrayBuffer();
        } catch (e) {
          if (aborted) throw new Error(t('downloadCancelledError'));
          if (e.fatal || attempt >= RETRIES) throw e;
          await sleep(500 * Math.pow(2, attempt));
        } finally {
          controllers.delete(ac);
        }
      }
    }

    async function worker() {
      while (!aborted && fetchIdx < segs.length) {
        if (fetchIdx - writeIdx >= MAX_AHEAD) {
          await sleep(100);
          continue;
        }
        const idx = fetchIdx++;
        const buf = await fetchSegment(segs[idx]);
        buffers.set(idx, buf);
        bytesDone += buf.byteLength;
        speedWindow.push({ t: Date.now(), bytes: buf.byteLength });
      }
    }

    async function writer() {
      while (writeIdx < segs.length) {
        if (aborted) throw new Error(t('downloadCancelledError'));
        const buf = buffers.get(writeIdx);
        if (!buf) {
          await sleep(50);
          continue;
        }
        buffers.delete(writeIdx);
        transmuxer.push(new Uint8Array(buf));
        transmuxer.flush();
        const chunks = pendingChunks;
        pendingChunks = [];
        for (const c of chunks) {
          await writable.write(c);
          bytesWritten += c.byteLength;
        }
        writeIdx++;
      }
    }

    function updateProgress() {
      const pct = Math.floor((writeIdx / segs.length) * 100);
      ui.barFill.style.width = pct + '%';
      const now = Date.now();
      while (speedWindow.length && now - speedWindow[0].t > 5000) speedWindow.shift();
      const winBytes = speedWindow.reduce((a, x) => a + x.bytes, 0);
      const winSpan = speedWindow.length ? Math.max(1000, now - speedWindow[0].t) : 1000;
      const speed = winBytes / (winSpan / 1000);
      const remaining = segs.length - writeIdx;
      const avgSegBytes = writeIdx > 0 ? bytesWritten / writeIdx : 0;
      const eta = speed > 0 && avgSegBytes > 0 ? (remaining * avgSegBytes) / speed : 0;
      ui.stats.textContent = t('progress', [
        String(pct), String(writeIdx), String(segs.length), fmtBytes(bytesDone), fmtBytes(speed),
        eta > 1 ? t('eta', fmtTime(eta)) : '',
      ]);
    }

    running = true;
    const progressTimer = setInterval(updateProgress, 500);
    updateProgress();

    const tasks = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      tasks.push(
        worker().catch((e) => {
          aborted = true;
          if (!firstError) firstError = e;
        })
      );
    }
    tasks.push(
      writer().catch((e) => {
        aborted = true;
        if (!firstError) firstError = e;
      })
    );
    await Promise.all(tasks);
    clearInterval(progressTimer);
    running = false;

    if (userCancelled) {
      await writable.abort();
      ui.progressBlock.hidden = true;
      ui.doneBlock.hidden = false;
      ui.doneBlock.textContent = t('cancelledNoFile');
      chrome.runtime.sendMessage({ type: 'cleanupJob', jobId: currentJobId });
      return;
    }
    if (firstError) throw firstError;

    await writable.close();
    ui.progressBlock.hidden = true;
    ui.doneBlock.hidden = false;
    ui.doneBlock.innerHTML = '';
    const head = document.createElement('div');
    head.textContent = t('saved', fmtBytes(bytesWritten));
    const path = document.createElement('div');
    path.className = 'path';
    path.textContent = job.filename;
    ui.doneBlock.append(head, path);
    chrome.runtime.sendMessage({ type: 'cleanupJob', jobId: currentJobId });
  } catch (e) {
    running = false;
    try {
      if (writable) await writable.abort();
    } catch (_) {
      // writable мог быть уже закрыт
    }
    if (userCancelled) {
      ui.progressBlock.hidden = true;
      ui.doneBlock.hidden = false;
      ui.doneBlock.textContent = t('cancelledNoFile');
      return;
    }
    showError((e && e.message) || String(e));
  }
}

// ---------- инициализация страницы ----------

let currentJobId = '';

async function init() {
  currentJobId = location.hash.slice(1);
  if (!currentJobId) {
    showError(t('missingJobParams'));
    return;
  }
  const store = await chrome.storage.local.get(currentJobId);
  const job = store[currentJobId];
  if (!job) {
    showError(t('jobNotFound'));
    return;
  }

  const isPartial = job.fromSec > 0 || job.toSec < job.lengthSeconds;
  const estBytes = job.bandwidth ? (job.bandwidth / 8) * (job.toSec - job.fromSec) : 0;
  ui.meta.innerHTML = '';
  const rows = [
    job.channel + ' — ' + job.title,
    t('qualityValue', job.qualityLabel),
    t('rangeValue', isPartial
      ? fmtTime(job.fromSec) + ' – ' + fmtTime(job.toSec)
      : t('wholeVod', fmtTime(job.lengthSeconds))),
    estBytes ? t('estimatedSize', fmtBytes(estBytes)) : '',
    t('fileValue', job.filename),
  ];
  for (const r of rows) {
    if (!r) continue;
    const d = document.createElement('div');
    d.textContent = r;
    ui.meta.appendChild(d);
  }

  ui.startBtn.addEventListener('click', async () => {
    if (ui.startBtn.disabled) return;
    // Блокируем сразу: повторный клик до скрытия startBlock запускал бы
    // вторую параллельную загрузку
    ui.startBtn.disabled = true;
    let handle;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: job.filename,
        types: [{ description: t('mp4Video'), accept: { 'video/mp4': ['.mp4'] } }],
      });
    } catch (e) {
      ui.startBtn.disabled = false;
      return; // пользователь закрыл диалог выбора файла
    }
    ui.startBlock.hidden = true;
    ui.progressBlock.hidden = false;
    ui.stats.textContent = t('gettingPlaylist');
    download(job, handle).catch((e) => showError((e && e.message) || String(e)));
  });
}

window.addEventListener('beforeunload', (e) => {
  if (running) {
    e.preventDefault();
    e.returnValue = t('downloadInProgress');
  }
});

init();
