// يحفظ ملفات الصفحة لتفتح بسرعة؛ يجلب النسخة الأحدث من الشبكة أولًا عند توفرها.
// طلبات Groq لا تمر عبر هذا الملف (نطاق آخر وطريقة POST).
const CACHE = 'htspeech-v5';
const FILES = ['./', 'index.html', 'styles.css', 'js/app.js', 'js/transcript.js', 'js/recognizer.js', 'js/meter.js',
  'js/vad.js', 'js/wav.js', 'js/filter.js', 'js/groq.js', 'js/whisper_engine.js', 'js/capture-worklet.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request))
  );
});
