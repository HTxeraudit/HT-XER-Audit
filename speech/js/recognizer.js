// غلاف لمحرك التعرف على الكلام المدمج في المتصفح (في سفاري على آيفون هو محرك الإملاء من Apple).
// يعيد التشغيل تلقائيًا عند توقف المحرك بعد الصمت، ويفرّق بين الأخطاء العابرة والأخطاء التي تستلزم التوقف.

const FATAL = new Set(['not-allowed', 'service-not-allowed', 'language-not-supported', 'audio-capture', 'bad-grammar']);

export function getEngineClass() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export class Recognizer extends EventTarget {
  constructor({ lang = 'ar-EG' } = {}) {
    super();
    this.lang = lang;
    this.rec = null;
    this.wanted = false;        // هل يريد المستخدم الاستماع الآن؟
    this.restarts = [];         // أوقات إعادة التشغيل لاكتشاف الحلقات السريعة
    this.lastError = null;
  }

  static supported() { return !!getEngineClass(); }

  start() {
    this.wanted = true;
    this.restarts = [];
    this._spawn();
  }

  /** إيقاف مع تثبيت ما سُمع (stop يسمح للمحرك بإرسال النتيجة الأخيرة). */
  stop() {
    this.wanted = false;
    if (this.rec) {
      try { this.rec.stop(); } catch (_) { /* متوقف بالفعل */ }
    }
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  _spawn() {
    const Engine = getEngineClass();
    if (!Engine) { this._emit('error', { code: 'unsupported', fatal: true }); return; }
    const rec = new Engine();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    this.rec = rec;
    this.lastError = null;

    rec.onstart = () => this._emit('state', { listening: true });
    rec.onspeechstart = () => this._emit('speechstart');
    rec.onresult = (ev) => {
      const list = [];
      for (let i = 0; i < ev.results.length; i++) {
        const r = ev.results[i];
        list.push({ text: r[0] ? r[0].transcript : '', isFinal: !!r.isFinal });
      }
      this._emit('results', { results: list });
    };
    rec.onerror = (ev) => {
      const code = ev.error || 'unknown';
      this.lastError = code;
      if (code === 'no-speech' || code === 'aborted') return; // صمت عادي: يعاد التشغيل عند end
      const fatal = FATAL.has(code);
      if (fatal) this.wanted = false;
      this._emit('error', { code, fatal });
    };
    rec.onend = () => {
      if (this.rec !== rec) return;
      this._emit('instanceend');
      if (!this.wanted) { this.rec = null; this._emit('state', { listening: false }); return; }
      // إعادة تشغيل تلقائية، مع إبطاء إذا تكرر التوقف بسرعة (مثلاً انقطاع الشبكة).
      const now = Date.now();
      this.restarts = this.restarts.filter((t) => now - t < 10000);
      this.restarts.push(now);
      const delay = this.restarts.length > 5 ? 2000 : 150;
      if (this.restarts.length > 12) {
        this.wanted = false;
        this.rec = null;
        this._emit('error', { code: this.lastError === 'network' ? 'network' : 'restart-loop', fatal: true });
        this._emit('state', { listening: false });
        return;
      }
      setTimeout(() => { if (this.wanted) this._spawn(); }, delay);
    };

    try {
      rec.start();
    } catch (e) {
      this._emit('error', { code: 'start-failed', fatal: true, message: String(e) });
      this.wanted = false;
    }
  }
}
