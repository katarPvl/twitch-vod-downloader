# Twitch VOD & Clip Downloader

[English](#english) · [Русский](#русский)

A Manifest V3 extension for Yandex Browser and other Chromium-based browsers. Download Twitch VODs and clips from their pages, choose the available quality, and optionally save only part of a VOD.

The extension interface is available in **English and Russian** and automatically follows the browser language.

## English

### Installation

1. Open your browser's extensions page:
   - Yandex Browser — `browser://extensions`
   - Chrome / Chromium / Brave / Vivaldi — `chrome://extensions`
   - Microsoft Edge — `edge://extensions`
   - Opera — `opera://extensions`
2. Enable **Developer mode** (usually in the upper-right corner; in Edge, it is in the left sidebar).
3. Click **Load unpacked** and select the `twitch-vod-downloader` folder.
4. Open a VOD (`twitch.tv/videos/…`) or clip page. A **⬇ Download** button will appear in the upper-right corner of the player.

> **Important:** a VPN may be required in regions where Twitch or its video servers are restricted. The extension downloads from the same Twitch/CloudFront servers used for regular playback. If the video does not play without a VPN, the extension will not be able to download it without one either.

No build step is required. All files, including mux.js, are included in the extension directory.

### Usage

- **Clip:** click the download button, select a quality, and click **Download**. The MP4 file will appear in the browser's regular downloads.
- **VOD:** click the button, select a quality, and optionally enter a **From**/**To** range (format: `1:23:45`; empty **From** means the beginning, empty **To** means the end). After you click **Download**, the download manager opens in a new tab. Choose where to save the file and keep that tab open until the download finishes. You can continue using other browser tabs normally.

VODs are saved as fragmented MP4 (H.264 + AAC without re-encoding). HLS segments are downloaded in parallel, transmuxed from MPEG-TS to MP4 with mux.js, and written to disk incrementally, keeping memory use limited even for multi-hour recordings.

### Limitations

- **Up to Full HD without signing in.** Twitch provides anonymous requests with qualities up to 1080p (approximately 12,500 Kbit/s). 1440p/4K options will not appear even if the streamer recorded them.
- **Subscriber-only VODs are not supported.** The extension works without Twitch authentication and displays an explanatory error.
- **VOD ranges are cut at HLS segment boundaries** (usually 10–13 seconds), so the actual boundaries may differ from the requested times by approximately ±10 seconds.
- Twitch rotates its public Client-ID periodically. If necessary, the extension retrieves the current value from the Twitch home page and caches it automatically.
- VODs containing `EXT-X-DISCONTINUITY` markers may have a small timestamp jump at a join.
- Downloading content owned by others may violate Twitch's Terms of Service. Use the extension for personal purposes and only for content you are permitted to download.

### Project structure

- `_locales/en` and `_locales/ru` — English and Russian interface translations.
- `manifest.json` — Manifest V3 configuration, permissions, and content script.
- `background.js` — service worker for Twitch GQL/usher requests, clip downloads, and opening the VOD manager.
- `content.js` / `content.css` — the download button and quality/range panel on Twitch pages.
- `manager.html` / `manager.js` — VOD download manager (download, transmux, and incremental disk writing).
- `lib/mux.min.js` — mux.js 7.1.0 (Apache-2.0), used to transmux MPEG-TS to fMP4.

---

## Русский

Расширение для Яндекс Браузера и других Chromium-браузеров (Manifest V3): скачивает записи стримов (VOD) и клипы с Twitch по кнопке на странице, позволяет выбрать качество и сохранить только нужный фрагмент VOD.

Интерфейс доступен на **русском и английском языках** и автоматически выбирается по языку браузера.

### Установка

1. Откройте страницу управления расширениями своего браузера:
   - Яндекс Браузер — `browser://extensions`
   - Chrome / Chromium / Brave / Vivaldi — `chrome://extensions`
   - Microsoft Edge — `edge://extensions`
   - Opera — `opera://extensions`
2. Включите **«Режим разработчика»** (обычно справа вверху, в Edge — в левой колонке).
3. Нажмите **«Загрузить распакованное расширение»** и укажите папку `twitch-vod-downloader`.
4. Откройте страницу VOD (`twitch.tv/videos/…`) или клипа — в правом верхнем углу плеера появится кнопка **«⬇ Скачать»**.

> **Важно:** в регионах с ограничением доступа к Twitch или его видеосерверам может потребоваться VPN. Расширение скачивает с тех же серверов Twitch/CloudFront, что используются для обычного просмотра. Если видео не воспроизводится без VPN, расширение также не сможет скачать его без VPN.

Сборка не требуется: все файлы, включая mux.js, находятся в папке расширения.

### Использование

- **Клип:** нажмите кнопку, выберите качество и нажмите «Скачать» — MP4-файл появится в обычных загрузках браузера.
- **VOD:** нажмите кнопку, выберите качество и при желании задайте отрезок «От»/«До» (формат `1:23:45`; пустое «От» означает начало, пустое «До» — конец). После нажатия «Скачать» откроется вкладка менеджера загрузки. Выберите, куда сохранить файл, и не закрывайте эту вкладку до завершения. Остальными вкладками браузера можно пользоваться как обычно.

VOD сохраняется как fragmented MP4 (H.264 + AAC без перекодирования): сегменты HLS скачиваются параллельно, на лету перепаковываются из MPEG-TS в MP4 с помощью mux.js и порционно записываются на диск. Благодаря этому потребление памяти ограничено даже при скачивании многочасовых записей.

### Ограничения

- **Максимум Full HD без авторизации.** Twitch выдаёт анонимным запросам качество не выше 1080p (примерно 12 500 Кбит/с). Варианты 1440p/4K не появятся, даже если стример записывал в таком качестве.
- **VOD только для подписчиков не поддерживаются.** Расширение работает без авторизации Twitch и показывает понятную ошибку.
- **Фрагмент режется по границам сегментов HLS** (обычно 10–13 секунд), поэтому фактические границы могут отличаться от заданных примерно на ±10 секунд.
- Twitch периодически меняет публичный Client-ID. При необходимости расширение автоматически получает актуальное значение с главной страницы Twitch и сохраняет его в кэше.
- Если в VOD присутствуют маркеры `EXT-X-DISCONTINUITY`, в месте склейки возможен небольшой скачок таймстемпов.
- Скачивание чужого контента может нарушать условия использования Twitch. Используйте расширение в личных целях и только для контента, который вам разрешено скачивать.

### Структура проекта

- `_locales/en` и `_locales/ru` — английский и русский переводы интерфейса.
- `manifest.json` — Manifest V3, разрешения и content script.
- `background.js` — service worker: запросы к GQL/usher, загрузка клипов и открытие менеджера VOD.
- `content.js` / `content.css` — кнопка и панель выбора качества/отрезка на странице Twitch.
- `manager.html` / `manager.js` — менеджер загрузки VOD (скачивание, трансмукс и порционная запись на диск).
- `lib/mux.min.js` — mux.js 7.1.0 (Apache-2.0), перепаковка MPEG-TS → fMP4.
