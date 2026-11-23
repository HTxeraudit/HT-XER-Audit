// الواجهة: تربط الأزرار والعرض بالنواة (transcript.js) وبأحد المحركين:
// Whisper عبر Groq (whisper_engine.js) أو محرك Apple المدمج (recognizer.js).
import { Transcript, formatTime } from './transcript.js';
import { Recognizer } from './recognizer.js';
import { LevelMeter } from './meter.js';
import { WhisperEngine, MIC_CONSTRAINTS } from './whisper_engine.js';
import { checkKey } from './groq.js';

const $ = (id) => document.getElementById(id);
const els = {
  dot: $('statusDot'), statusText: $('statusText'),
  level: $('levelFill'), cue: $('cue'), stage: $('stage'),
  transcript: $('transcript'), placeholder: $('placeholder'), editor: $('editor'), toast: $('toast'),
  btnStart: $('btnStart'), btnPause: $('btnPause'), btnResume: $('btnResume'), btnEnd: $('btnEnd'),
  rowText: $('rowText'), btnEdit: $('btnEdit'), btnCopy: $('btnCopy'), btnSave: $('btnSave'),
  btnShare: $('btnShare'), btnClear: $('btnClear'),
  fontUp: $('fontUp'), fontDown: $('fontDown'), openSettings: $('openSettings'),
  settings: $('settings'), privacy: $('privacy'), privacyEngineText: $('privacyEngineText'),
  engine: $('engine'), whisperBox: $('whisperBox'), appleLangBox: $('appleLangBox'),
  groqKey: $('groqKey'), saveKey: $('saveKey'), clearKey: $('clearKey'), keyStatus: $('keyStatus'),
  wlang: $('wlang'),
  lang: $('lang'), fontSize: $('fontSize'), fontVal: $('fontVal'), theme: $('theme'),
  optMeter: $('optMeter'), optWake: $('optWake'), optTimes: $('optTimes'),
};

// ---------- الإعدادات ----------
const SKEY = 'htspeech.settings.v1';
const TKEY = 'htspeech.transcript.v1';
const PKEY = 'htspeech.privacyAccepted.v2';     // تنبيه الخصوصية يظهر مرة واحدة فقط
const KKEY = 'htspeech.groqKey';
const defaults = {
  engine: 'whisper', wlang: '',
  lang: 'ar-EG', font: 34, theme: 'dark', meter: true, wake: true, times: false,
};
const settings = { ...defaults, ...safeJSON(localStorage.getItem(SKEY)) };
function safeJSON(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }
function saveSettings() { localStorage.setItem(SKEY, JSON.stringify(settings)); }
function groqKey() { return (localStorage.getItem(KKEY) || '').trim(); }

function applySettings() {
  document.documentElement.style.setProperty('--font', settings.font + 'px');
  document.body.dataset.theme = settings.theme;
  document.body.classList.toggle('no-meter', !settings.meter);
  els.engine.value = settings.engine;
  els.whisperBox.hidden = settings.engine !== 'whisper';
  els.appleLangBox.hidden = settings.engine !== 'apple';
  els.wlang.value = settings.wlang;
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
let recognizer = null;        // محرك Apple
let whisper = null;           // محرك Whisper
const meter = new LevelMeter();
let wakeLock = null;
let cueTimer = 0;
let meterFallbackTried = false;

// جمل Whisper تصل بترتيب قد يختلف؛ نعرضها في مكانها ونثبتها في النص بالترتيب.
// ميكروفون واحد تأخذه الصفحة مرة واحدة وتحتفظ به طوال فتحها، فلا يُطلب الإذن عند كل بدء أو استئناف.
let micStream = null;
async function getMic() {
  const live = micStream && micStream.getAudioTracks().some((t) => t.readyState === 'live');
  if (!live) micStream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
  micStream.getAudioTracks().forEach((t) => { t.enabled = true; });
  return micStream;
}
function muteMic() { if (micStream) micStream.getAudioTracks().forEach((t) => { t.enabled = false; }); }

const pendings = new Map();   // seq -> { p, at, done, text }
let nextSeq = 0;
let seqBase = 0;

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
function dropPlaceholder() { if (els.placeholder.isConnected) els.placeholder.remove(); }

function fillSegment(p, seg) {
  p.replaceChildren();
  p.className = '';
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
function segmentNode(seg) { return fillSegment(document.createElement('p'), seg); }

function renderAll() {
  els.transcript.replaceChildren();
  for (const s of transcript.segments) els.transcript.appendChild(segmentNode(s));
  liveP = null;
  for (const [, item] of [...pendings].sort((a, b) => a[0] - b[0])) els.transcript.appendChild(item.p);
  renderLive();
  if (transcript.isEmpty() && !pendings.size) els.transcript.appendChild(els.placeholder);
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
  dropPlaceholder();
  if (stick) scrollToBottom();
}

function commitLive() {
  const seg = transcript.commit();
  if (liveP) { liveP.remove(); liveP = null; }
  if (seg) {
    const stick = isNearBottom();
    dropPlaceholder();
    els.transcript.appendChild(segmentNode(seg));
    persistTranscript();
    if (stick) scrollToBottom();
  }
  updateButtons();
}

// ---- جمل Whisper ----
function onPending({ seq, at }) {
  const stick = isNearBottom();
  dropPlaceholder();
  const p = document.createElement('p');
  p.className = 'pending';
  p.textContent = 'جارٍ الكتابة';
  els.transcript.appendChild(p);
  pendings.set(seq, { p, at, done: false, text: '' });
  if (stick) scrollToBottom();
  updateButtons();
}
function onFinal({ seq, text }) {
  const item = pendings.get(seq);
  if (!item) return;
  item.done = true;
  item.text = text || '';
  const stick = isNearBottom();
  if (item.text) fillSegment(item.p, { text: item.text, at: item.at });
  else item.p.remove();               // صمت أو ضوضاء: لا يُكتب شيء
  // التثبيت في النص بالترتيب
  while (pendings.has(nextSeq) && pendings.get(nextSeq).done) {
    const it = pendings.get(nextSeq);
    if (it.text) transcript.addSegment(it.text, it.at);
    pendings.delete(nextSeq);
    nextSeq++;
  }
  persistTranscript();
  if (stick) scrollToBottom();
  if (transcript.isEmpty() && !pendings.size && !els.transcript.childElementCount) els.transcript.appendChild(els.placeholder);
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
  els.btnEdit.disabled = !editing && pendings.size > 0;   // ننتظر وصول كل الجمل قبل التحرير
  for (const b of [els.btnCopy, els.btnSave, els.btnShare]) b.disabled = editing;
  els.btnClear.disabled = editing || pendings.size > 0;
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
  unsupported: 'هذا المتصفح لا يدعم محرك Apple للتعرف على الكلام. افتح الصفحة في سفاري، أو اختر محرك Whisper من الإعدادات.',
  'not-allowed': 'رُفض الوصول إلى الميكروفون. في سفاري اضغط زر «aA» في شريط العنوان، ثم «إعدادات موقع الويب»، واسمح بالميكروفون، ثم أعد تحميل الصفحة.',
  'service-not-allowed': 'خدمة الإملاء من Apple غير متاحة. فعّلها من: الإعدادات، ثم عام، ثم لوحة المفاتيح، ثم تفعيل الإملاء.',
  'language-not-supported': 'اللغة المختارة غير مدعومة على هذا الجهاز. اختر لغة أخرى من الإعدادات، مثل «العربية – السعودية».',
  'audio-capture': 'تعذّر الوصول إلى الميكروفون. تأكد من عدم استخدامه في تطبيق آخر أو مكالمة.',
  'no-mic': 'لم يُعثر على ميكروفون في هذا الجهاز.',
  network: 'لا يوجد اتصال بالإنترنت. سيُعاد إرسال الكلام تلقائيًا عند عودة الاتصال.',
  'restart-loop': 'توقف المحرك عدة مرات متتالية. اضغط «استئناف» للمحاولة مرة أخرى.',
  'start-failed': 'تعذّر تشغيل محرك التعرف على الكلام. أعد تحميل الصفحة ثم حاول مرة أخرى.',
  'mic-denied': 'رُفض الوصول إلى الميكروفون، فلن يظهر مؤشر مستوى الصوت. يمكنك السماح به من إعدادات سفاري.',
  'no-key': 'أدخل مفتاح Groq في الإعدادات أولًا، ثم اضغط «حفظ المفتاح وفحصه».',
  'bad-key': 'مفتاح Groq غير صحيح أو أُلغي. أدخل مفتاحًا صحيحًا في الإعدادات.',
  'rate-limit': 'بلغت حد الخطة المجانية مؤقتًا. سيكمل التطبيق الكتابة تلقائيًا بعد ثوانٍ.',
  'too-large': 'المقطع الصوتي أكبر من المسموح؛ تم تجاوزه.',
  server: 'خدمة Groq لم تستجب لهذا المقطع. سيستمر الاستماع.',
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
// آيفون يوقف الميكروفون لأي صفحة ويب عند الخروج منها إلى تطبيق آخر (قيد من النظام).
// عند العودة: نكتب في النص الفترة التي لم تُسمع، ونستأنف الاستماع تلقائيًا.
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (state === 'listening') hiddenAt = Date.now();
    return;
  }
  if (state !== 'listening') { hiddenAt = 0; return; }
  acquireWake();
  if (hiddenAt && Date.now() - hiddenAt > 2000) {
    const from = formatTime(new Date(hiddenAt)).slice(0, 5);
    const to = formatTime(new Date()).slice(0, 5);
    const note = `[لم يُسمع الكلام من ${from} إلى ${to} لأن الصفحة كانت في الخلفية]`;
    stopEngines();
    if (whisper) {
      // نحجز للملاحظة رقمًا في تسلسل الجمل حتى تُكتب بعد الجمل التي ما زالت في الطريق
      const s = whisper.seq++;
      onPending({ seq: s, at: new Date() });
      onFinal({ seq: s, text: note });
    } else {
      commitLive();
      const seg = transcript.addSegment(note, new Date());
      if (seg) { dropPlaceholder(); els.transcript.appendChild(segmentNode(seg)); persistTranscript(); scrollToBottom(); }
    }
    toast('استؤنف الاستماع. الكلام أثناء وجودك خارج الصفحة لم يُسمع، لأن آيفون يوقف الميكروفون لصفحات الويب في الخلفية.', 'info', 8000);
    setTimeout(() => { if (state === 'listening') beginListening(); }, 300);
  }
  hiddenAt = 0;
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
function setLevel(v) { els.level.style.width = Math.round(v * 100) + '%'; }
meter.addEventListener('level', (e) => setLevel(e.detail));
meter.addEventListener('speechstart', () => showCue());
meter.addEventListener('speechend', () => hideCue());

// ---------- محرك Apple ----------
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

// ---------- محرك Whisper ----------
function buildWhisper() {
  if (whisper) seqBase = whisper.seq;   // المحرك السابق أنهى ترقيمه عند الإيقاف
  const w = new WhisperEngine({
    firstSeq: seqBase,
    getStream: getMic,
    key: groqKey(),
    language: settings.wlang,
    boost: 'far',                        // دائمًا أعلى تعلية تلقائيًا (طلب المستخدم)
  });
  w.addEventListener('level', (e) => setLevel(e.detail));
  w.addEventListener('speechstart', () => showCue());
  w.addEventListener('speechend', () => hideCue());
  w.addEventListener('pending', (e) => onPending(e.detail));
  w.addEventListener('final', (e) => onFinal(e.detail));
  w.addEventListener('error', (e) => {
    const { code, fatal } = e.detail;
    toast(ERRORS[code] || ('خطأ: ' + code), fatal ? 'error' : 'info', fatal ? 0 : 6000);
    if (fatal) {
      w.stop();
      stopAux();
      setState(transcript.isEmpty() && !pendings.size ? 'idle' : 'paused');
      if (code === 'bad-key') { els.settings.showModal(); els.groqKey.focus(); }
    }
  });
  return w;
}

async function startAux() {
  acquireWake();
  if (settings.engine === 'apple' && settings.meter && !meter.active && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try { await meter.start(); }
    catch (err) {
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      toast(denied ? ERRORS['mic-denied'] : 'تعذّر تشغيل مؤشر مستوى الصوت؛ الاستماع مستمر بدونه.', 'info', 7000);
    }
  }
}
function stopAux() { meter.stop(); releaseWake(); hideCue(); setLevel(0); }

async function beginListening() {
  hideToast();
  if (settings.engine === 'whisper') {
    if (!groqKey()) { toast(ERRORS['no-key']); els.settings.showModal(); els.groqKey.focus(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast(ERRORS['no-mic']); return; }
    if (!navigator.onLine) toast(ERRORS.network, 'info', 7000);
    whisper = buildWhisper();
    setState('listening');
    try {
      await whisper.start();
    } catch (err) {
      const name = err && err.name;
      toast(name === 'NotAllowedError' || name === 'SecurityError' ? ERRORS['not-allowed']
        : name === 'NotFoundError' ? ERRORS['no-mic'] : ERRORS['audio-capture']);
      setState(transcript.isEmpty() ? 'idle' : 'paused');
      return;
    }
    acquireWake();
    return;
  }
  if (!Recognizer.supported()) { toast(ERRORS.unsupported); return; }
  if (!navigator.onLine) toast('لا يوجد اتصال بالإنترنت. قد لا يعمل محرك Apple بدون اتصال.', 'info', 7000);
  meterFallbackTried = false;
  recognizer = buildRecognizer();
  recognizer.start();
  setState('listening');
  startAux();
}

function stopEngines() {
  if (recognizer) recognizer.stop();
  if (whisper) whisper.stop();
  muteMic();               // لا يصل أي صوت أثناء الإيقاف، مع بقاء الإذن
  stopAux();
}
function pauseListening() { stopEngines(); setState('paused'); }
function endSession() { stopEngines(); setState('ended'); }

// ---------- الأزرار ----------
function privacyText() {
  return 'مع محرك Whisper تُرسَل مقاطع الكلام عبر الإنترنت إلى خدمة Groq لتحويلها إلى نص، ومع محرك Apple قد يُرسَل الصوت إلى خوادم Apple. يظهر هذا التنبيه مرة واحدة فقط.';
}
els.btnStart.addEventListener('click', () => {
  const pk = PKEY;
  if (!localStorage.getItem(pk)) {
    els.privacyEngineText.textContent = privacyText();
    els.privacy.returnValue = '';
    els.privacy.showModal();
    els.privacy.addEventListener('close', function once() {
      els.privacy.removeEventListener('close', once);
      if (els.privacy.returnValue === 'ok') { localStorage.setItem(pk, '1'); beginListening(); }
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

function setFont(px) {
  settings.font = Math.max(20, Math.min(72, px));
  saveSettings(); applySettings();
}
els.fontUp.addEventListener('click', () => setFont(settings.font + 4));
els.fontDown.addEventListener('click', () => setFont(settings.font - 4));

// ---------- نافذة الإعدادات ----------
function restartIfListening() {
  if (state !== 'listening') return;
  stopEngines();
  setTimeout(() => { if (state === 'listening') beginListening(); }, 400);
}
els.openSettings.addEventListener('click', () => {
  els.groqKey.value = groqKey();
  els.keyStatus.textContent = groqKey() ? 'يوجد مفتاح محفوظ على هذا الجهاز.' : '';
  els.keyStatus.className = 'key-status';
  els.settings.showModal();
});
els.engine.addEventListener('change', () => { settings.engine = els.engine.value; saveSettings(); applySettings(); restartIfListening(); });
els.wlang.addEventListener('change', () => { settings.wlang = els.wlang.value; saveSettings(); restartIfListening(); });
els.saveKey.addEventListener('click', async () => {
  const k = els.groqKey.value.trim();
  if (!k) { els.keyStatus.textContent = 'اكتب المفتاح أولًا.'; els.keyStatus.className = 'key-status bad'; return; }
  els.keyStatus.textContent = 'جارٍ فحص المفتاح…'; els.keyStatus.className = 'key-status';
  const r = await checkKey(k);
  if (r === 'ok') {
    localStorage.setItem(KKEY, k);
    els.keyStatus.textContent = 'المفتاح صحيح وتم حفظه على هذا الجهاز.'; els.keyStatus.className = 'key-status ok';
  } else if (r === 'bad-key') {
    els.keyStatus.textContent = 'المفتاح غير صحيح. تأكد من نسخه كاملًا.'; els.keyStatus.className = 'key-status bad';
  } else {
    localStorage.setItem(KKEY, k);
    els.keyStatus.textContent = 'حُفظ المفتاح، لكن تعذّر فحصه الآن (تحقق من الإنترنت).'; els.keyStatus.className = 'key-status bad';
  }
});
els.clearKey.addEventListener('click', () => {
  localStorage.removeItem(KKEY);
  els.groqKey.value = '';
  els.keyStatus.textContent = 'حُذف المفتاح من هذا الجهاز.'; els.keyStatus.className = 'key-status';
});
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
els.lang.addEventListener('change', () => { settings.lang = els.lang.value; saveSettings(); restartIfListening(); });

window.addEventListener('offline', () => { if (state === 'listening') toast(ERRORS.network, 'info'); });
window.addEventListener('online', () => { if (!els.toast.hidden && els.toast.textContent === ERRORS.network) hideToast(); });

// ---------- تشغيل ----------
applySettings();
renderAll();
setState(transcript.isEmpty() ? 'idle' : 'ended');
if (settings.engine === 'apple' && !Recognizer.supported()) toast(ERRORS.unsupported);

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// للاختبارات فقط
window.__htspeech = { transcript, get state() { return state; }, pendings, get whisper() { return whisper; } };
