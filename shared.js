// Общие форматтеры: подключается и как content script (manifest.json),
// и на странице менеджера (manager.html).

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

function fmtBytes(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' ' + t('unitGB');
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' ' + t('unitMB');
  return Math.max(1, Math.round(n / 1e3)) + ' ' + t('unitKB');
}
