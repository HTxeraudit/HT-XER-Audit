// الواجهة: تربط الأزرار والعرض بالنواة (transcript.js) والمحرك (recognizer.js) ومؤشر الصوت (meter.js).
import { Transcript, formatTime } from './transcript.js';
import { Recognizer } from './recognizer.js';
import { LevelMeter } from './meter.js';

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'), dot: $('statusDot'), statusText: $('statusText'),
  level: $('levelFill'), cue: $('cue'), stage: $('stage'),
  transcript: $('transcript'), placeholder: $('placeholder'), editor: $('editor'), toast: $('toast'),
  btnStart: $('btnStart'), btnPause: $('btnPause'), btnResume: $('btnResume'), btnEnd: $('btnEnd'),
  rowText: $('rowText'), btnEdit: $('btnEdit'), btnCopy: $('btnCopy'), btnSave: $('btnSave'),
  btnShare: $('btnShare'), btnClear: $('btnClear'),
  fontUp: $('fontUp'), fontDown: $('fontDown'), openSettings: $('openSettings'),
  settings: $('settings'), privacy: $('privacy'),
  lang: $('lang'), fontSize: $('fontSize'), fontVal: $('fontVal'), theme: $('theme'),
  optMeter: $('optMeter'), optWake: $('optWake'), optTimes: $('optTimes'),
};

// ---------- الإعدادات ----------
const SKEY = 'htspeech.settings.v1';
const TKEY = 'htspeech.transcript.v1';
const PKEY = 'htspeech.privacyAccepted.v1';
const defaults = { lang: 'ar-EG', font: 34, theme: 'dark', meter: true, wake: true, times: false };
const settings = { ...defaults, ...safeJSON(localStorage.getItem(SKEY)) };
function safeJSON(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }
function saveSettings() { localStorage.setItem(SKEY, JSON.stringify(settings)); }

function applySettings() {
  document.documentElement.style.setProperty('--font', settings.font + 'px');
  document.body.dataset.theme = settings.theme;
  document.body.classList.toggle('no-meter', !settings.meter);
  els.lang.value = settings.lang;
  els.fontSize.value = settings.font;
  els.fontVal.textContent = settings.font;
  els.theme.value = settings.theme;
  els.optMeter.checked = settings.meter;
  els.optWake.checked = settings.wake;
  els.optTimes.checked = settings.times;
  const themeColor = getComputedStyle(document.body).getPropertyValue('--bg').trim();
  document.querySelector('meta[name=theme-color]').setAttribute('content', themeColor || '#0b1220');
}

// ---------- الحالة ----------
let state = 'idle';           // idle | listening | paused | ended
let editing = false;
const transcript = new Transcript();
let recognizer = null;
const meter = new LevelMeter();
let wakeLock = null;
let cueTimer = 0;
let meterFallbackTried = false;

// استعادة النص المحفوظ محليًا (يبقى على الجهاز فقط).
(function restore() {
  const saved = safeJSON(localStorage.getItem(TKEY));
  if (Array.isArray(saved.segments)) {
    transcript.segments = saved.segments
      .filter((s) => s && s.text)
      .map((s) => ({ text: s.text, at: s.at ? new Date(s.at) : null }));
  }
})();
function persistTranscript() {
  localStorage.setItem(TKEY, JSON.stringify({ segments: transcript.segments }));
}

// ---------- العرض ----------
let liveP = null;

function isNearBottom() {
  const t = els.transcript;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 80;
}
function scrollToBottom() {
  els.transcript.scrollTop = els.transcript.scrollHeight;
  requestAnimationFrame(() => { els.transcript.scrollTop = els.transcript.scrollHeight; });
}

function segmentNode(seg) {
  const p = document.createElement('p');
  p.dir = 'auto';
  if (settings.times && seg.at) {
    const t = document.createElement('span');
    t.className = 'time';
    t.textContent = formatTime(seg.at);
    p.appendChild(t);
  }
  p.appendChild(document.createTextNode(seg.text));
  return p;
}

function renderAll() {
  els.transcript.replaceChildren();
  for (const s of transcript.segments) els.transcript.appendChild(segmentNode(s));
  liveP = null;
  renderLive();
  els.placeholder.hidden = !transcript.isEmpty();
  if (transcript.isEmpty()) els.transcript.appendChild(els.placeholder);
  scrollToBottom();
}

function renderLive() {
  const { finalText, interimText } = transcript.current;
  if (!finalText && !interimText) { if (liveP) { liveP.remove(); liveP = null; } return; }
  const stick = isNearBottom();
  if (!liveP) {
    liveP = document.createElement('p');
    liveP.dir = 'auto';
    els.transcript.appendChild(liveP);
  }
  liveP.replaceChildren();
  if (finalText) liveP.appendChild(document.createTextNode(finalText + (interimText ? ' ' : '')));
  if (interimText) {
    const s = document.createElement('span');
    s.className = 'interim';
    s.textContent = interimText;
    liveP.appendChild(s);
  }
  if (els.placeholder.isConnected) els.placeholder.remove();
  if (stick) scrollToBottom();
}

function commitLive() {
  const seg = transcript.commit();
  if (liveP) { liveP.remove(); liveP = null; }
  if (seg) {
    const stick = isNearBottom();
    if (els.placeholder.isConnected) els.placeholder.remove();
    els.transcript.appendChild(segmentNode(seg));
    persistTranscript();
    if (stick) scrollToBottom();
  }
  updateButtons();
}

function setState(next) {
  state = next;
  const labels = { idle: 'متوقف', listening: 'يستمع الآن', paused: 'متوقف مؤقتًا', ended: 'انتهت الجلسة' };
  els.statusText.textContent = labels[state];
  els.dot.className = 'dot' + (state === 'listening' ? ' on' : state === 'paused' ? ' paused' : '');
  updateButtons();
}

function updateButtons() {
  const listening = state === 'listening';
  els.btnStart.hidden = !(state === 'idle' || state === 'ended');
  els.btnPause.hidden = !listening;
  els.btnResume.hidden = state !== 'paused';
  els.btnEnd.hidden = !(listening || state === 'paused');
  const hasText = !transcript.isEmpty();
  els.rowText.hidden = listening || (!hasText && !editing);
  els.btnEdit.textContent = editing ? 'حفظ التعديل' : 'تحرير';
  for (const b of [els.btnCopy, els.btnSave, els.btnShare, els.btnClear]) b.disabled = editing;
  els.btnStart.disabled = editing;
  els.btnResume.disabled = editing;
  if (!navigator.share) els.btnShare.hidden = true;
}

// ---------- الرسائل ----------
let toastTimer = 0;
function toast(msg, kind = 'error', ms = 0) {
  els.toast.textContent = msg;
  els.toast.className = 'toast' + (kind === 'info' ? ' info' : '');
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { els.toast.hidden = true; }

const ERRORS = {
  unsupported: 'هذا المتصفح لا يدعم التعرف على الكلام. افتح الصفحة في سفاري على آيفون بإصدار حديث.',
  'not-allowed': 'رُفض الوصول إلى الميكروفون. في سفاري اضغط زر «aA» في شريط العنوان، ثم «إعدادات موقع الويب»، واسمح بالميكروفون، ثم أعد تحميل الصفحة.',
  'service-not-allowed': 'خدمة التعرف على الكلام غير متاحة. تأكد من تفعيل الإملاء من: الإعدادات، ثم عام، ثم لوحة المفاتيح، ثم تفعيل الإملاء.',
  'language-not-supported': 'اللغة المختارة غير مدعومة على هذا الجهاز. اختر لغة أخرى من الإعدادات، مثل «العربية – السعودية».',
  'audio-capture': 'تعذّر الوصول إلى الميكروفون. تأكد من عدم استخدامه في تطبيق آخر أو مكالمة.',
  network: 'انقطع الاتصال بالإنترنت أو بخدمة التعرف على الكلام. تحقق من الاتصال ثم اضغط «استئناف».',
  'restart-loop': 'توقف المحرك عدة مرات متتالية. اضغط «استئناف» للمحاولة مرة أخرى.',
  'start-failed': 'تعذّر تشغيل محرك التعرف على الكلام. أعد تحميل الصفحة ثم حاول مرة أخرى.',
  'mic-denied': 'رُفض الوصول إلى الميكروفون، فلن يظهر مؤشر مستوى الصوت. يمكنك السماح به من إعدادات سفاري.',
};

// ---------- الشاشة المضاءة ----------
async function acquireWake() {
  if (!settings.wake || !('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (_) { /* غير متاح على هذا الجهاز */ }
}
function releaseWake() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state === 'listening') acquireWake();
});

// ---------- تنبيه بدء الكلام ----------
function showCue(autoHideMs = 0) {
  if (state !== 'listening') return;
  els.cue.classList.add('show');
  els.stage.classList.add('speaking');
  clearTimeout(cueTimer);
  if (autoHideMs) cueTimer = setTimeout(hideCue, autoHideMs);
}
function hideCue() {
  clearTimeout(cueTimer);
  els.cue.classList.remove('show');
  els.stage.classList.remove('speaking');
}
meter.addEventListener('level', (e) => { els.level.style.width = Math.round(e.detail * 100) + '%'; });
meter.addEventListener('speechstart', () => showCue());
meter.addEventListener('speechend', () => hideCue());

// ---------- المحرك ----------
function buildRecognizer() {
  const r = new Recognizer({ lang: settings.lang });
  r.addEventListener('results', (e) => {
    transcript.update(e.detail.results);
    renderLive();
    if (!meter.active) showCue(2500);
  });
  r.addEventListener('instanceend', () => commitLive());
  r.addEventListener('speechstart', () => { if (!meter.active) showCue(2500); });
  r.addEventListener('error', async (e) => {
    const { code, fatal } = e.detail;
    // على بعض الأجهزة قد يتعارض مؤشر الصوت مع المحرك على الميكروفون: نوقف المؤشر ونحاول مرة واحدة.
    if (code === 'audio-capture' && meter.active && !meterFallbackTried) {
      meterFallbackTried = true;
      meter.stop();
      toast('أُوقف مؤشر مستوى الصوت لأنه تعارض مع الميكروفون على هذا الجهاز.', 'info', 6000);
      setTimeout(() => { if (state === 'listening') recognizer.start(); }, 300);
      return;
    }
    toast(ERRORS[code] || ('حدث خطأ في التعرف على الكلام: ' + code));
    if (fatal) {
      commitLive();
      stopAux();
      setState(transcript.isEmpty() ? 'idle' : 'paused');
    }
  });
  return r;
}

async function startAux() {
  acquireWake();
  if (settings.meter && !meter.active && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try { await meter.start(); }
    catch (err) {
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      toast(denied ? ERRORS['mic-denied'] : 'تعذّر تشغيل مؤشر مستوى الصوت؛ الاستماع مستمر بدونه.', 'info', 7000);
    }
  }
}
function stopAux() { meter.stop(); releaseWake(); hideCue(); }

async function beginListening() {
  if (!Recognizer.supported()) { toast(ERRORS.unsupported); return; }
  if (!navigator.onLine) toast('لا يوجد اتصال بالإنترنت. قد لا يعمل التعرف على الكلام بدون اتصال.', 'info', 7000);
  else hideToast();
  meterFallbackTried = false;
  recognizer = buildRecognizer();
  recognizer.start();
  setState('listening');
  startAux();
}

function pauseListening() {
  if (recognizer) recognizer.stop();
  stopAux();
  setState('paused');
}
function endSession() {
  if (recognizer) recognizer.stop();
  stopAux();
  setState('ended');
}

// ---------- الأزرار ----------
els.btnStart.addEventListener('click', async () => {
  if (!localStorage.getItem(PKEY)) {
    els.privacy.returnValue = '';
    els.privacy.showModal();
    els.privacy.addEventListener('close', function once() {
      els.privacy.removeEventListener('close', once);
      if (els.privacy.returnValue === 'ok') { localStorage.setItem(PKEY, '1'); beginListening(); }
    });
    return;
  }
  beginListening();
});
els.btnPause.addEventListener('click', pauseListening);
els.btnResume.addEventListener('click', beginListening);
els.btnEnd.addEventListener('click', endSession);

els.btnEdit.addEventListener('click', () => {
  if (!editing) {
    editing = true;
    els.editor.value = transcript.toPlainText();
    els.transcript.hidden = true;
    els.editor.hidden = false;
    els.editor.focus();
  } else {
    editing = false;
    transcript.replaceAll(els.editor.value);
    persistTranscript();
    els.editor.hidden = true;
    els.transcript.hidden = false;
    renderAll();
  }
  updateButtons();
});

function plain() { return transcript.toPlainText({ withTimes: settings.times }); }

els.btnCopy.addEventListener('click', async () => {
  const text = plain();
  try { await navigator.clipboard.writeText(text); toast('تم نسخ النص.', 'info', 2500); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove();
    toast(ok ? 'تم نسخ النص.' : 'تعذّر النسخ تلقائيًا؛ استخدم «تحرير» ثم انسخ يدويًا.', ok ? 'info' : 'error', 3500);
  }
});

function fileName() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `تفريغ-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.txt`;
}
els.btnSave.addEventListener('click', () => {
  const blob = new Blob([plain()], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName();
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
});
els.btnShare.addEventListener('click', async () => {
  const text = plain();
  try {
    const file = new File([text], fileName(), { type: 'text/plain' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
    else await navigator.share({ text });
  } catch (err) { if (err && err.name !== 'AbortError') toast('تعذّرت المشاركة.', 'error', 3000); }
});
els.btnClear.addEventListener('click', () => {
  if (!confirm('هل تريد مسح النص كله؟ لا يمكن التراجع عن ذلك.')) return;
  transcript.clear();
  persistTranscript();
  renderAll();
  setState('idle');
});

// حجم الخط بسرعة من الأعلى
function setFont(px) {
  settings.font = Math.max(20, Math.min(72, px));
  saveSettings(); applySettings();
}
els.fontUp.addEventListener('click', () => setFont(settings.font + 4));
els.fontDown.addEventListener('click', () => setFont(settings.font - 4));

// نافذة الإعدادات
els.openSettings.addEventListener('click', () => els.settings.showModal());
els.fontSize.addEventListener('input', () => setFont(Number(els.fontSize.value)));
els.theme.addEventListener('change', () => { settings.theme = els.theme.value; saveSettings(); applySettings(); });
els.optTimes.addEventListener('change', () => { settings.times = els.optTimes.checked; saveSettings(); renderAll(); });
els.optWake.addEventListener('change', () => {
  settings.wake = els.optWake.checked; saveSettings();
  if (settings.wake && state === 'listening') acquireWake(); else if (!settings.wake) releaseWake();
});
els.optMeter.addEventListener('change', () => {
  settings.meter = els.optMeter.checked; saveSettings(); applySettings();
  if (!settings.meter) meter.stop(); else if (state === 'listening') startAux();
});
els.lang.addEventListener('change', () => {
  settings.lang = els.lang.value; saveSettings();
  if (state === 'listening') {          // تغيير اللغة أثناء الاستماع: نثبّت ما سبق ونبدأ باللغة الجديدة
    recognizer.stop();
    setTimeout(() => { if (state === 'listening') { recognizer = buildRecognizer(); recognizer.start(); } }, 400);
  }
});

window.addEventListener('offline', () => { if (state === 'listening') toast(ERRORS.network); });
window.addEventListener('online', () => { if (!els.toast.hidden && els.toast.textContent === ERRORS.network) hideToast(); });

// ---------- تشغيل ----------
applySettings();
renderAll();
setState(transcript.isEmpty() ? 'idle' : 'ended');
if (!Recognizer.supported()) toast(ERRORS.unsupported);

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// للاختبارات فقط
window.__htspeech = { transcript, get state() { return state; } };
