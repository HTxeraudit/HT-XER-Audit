// النواة: اكتشاف بداية الكلام ونهايته وتقطيعه إلى جمل، دون قطع كلمة في المنتصف.
// منطق خالص بلا متصفح: يأخذ إطارات صوت ويُخرج مقاطع؛ يُعاد كما هو في أي نسخة لاحقة.

export function rms(frame) {
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
  return Math.sqrt(s / (frame.length || 1));
}

export class Segmenter {
  constructor(opts = {}) {
    this.o = {
      sampleRate: 16000,
      frameMs: 20,
      preRollMs: 300,        // ما قبل بداية الكلام حتى لا يضيع أول حرف
      startMs: 100,          // مدة الصوت المتواصل لاعتباره كلامًا
      endSilenceMs: 700,     // صمت ينهي الجملة (إذا بلغت الحد الأدنى للطول)
      minLenMs: 2500,        // لا نرسل جملًا قصيرة جدًا منفصلة (حدود الطلبات المجانية)
      flushSilenceMs: 1400,  // صمت أطول ينهي أي جملة مهما قصرت
      softMaxMs: 12000,      // بعد هذا الطول نقطع عند أول توقف قصير
      softGapMs: 200,
      hardMaxMs: 25000,      // قطع إجباري
      minSpeechMs: 200,      // أقل كلام فعلي داخل المقطع، وإلا فهو ضوضاء
      absMin: 0.004,         // أدنى مستوى يُعد صوتًا
      ratio: 3,              // كم مرة فوق مستوى الضوضاء
      ...opts,
    };
    this.frameLen = Math.round(this.o.sampleRate * this.o.frameMs / 1000);
    this.floor = 0;
    this.hist = [];                                   // مستويات آخر ثانيتين
    this.histN = Math.round(1500 / this.o.frameMs);
    this.calibN = Math.round(300 / this.o.frameMs);   // أول 300 ms لمعرفة مستوى المكان
    this.reset();
  }

  reset() {
    this.inSpeech = false;
    this.frames = [];
    this.pre = [];
    this.loudRun = 0;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.lenMs = 0;
    this.pending = new Float32Array(0);
    this.pendingStore = new Float32Array(0);
  }

  /**
   * يستقبل أي عدد من العينات، ويعيد قائمة أحداث: start / end(segment).
   * samples: الصوت الذي يُقاس عليه الكلام. store (اختياري، بنفس الطول): الصوت الذي يُحفظ ويُرسل.
   */
  push(samples, store = samples) {
    const events = [];
    const join = (a, b) => { if (!a.length) return b; const d = new Float32Array(a.length + b.length); d.set(a); d.set(b, a.length); return d; };
    const data = join(this.pending, samples);
    const keep = join(this.pendingStore, store);
    let i = 0;
    for (; i + this.frameLen <= data.length; i += this.frameLen) {
      this._frame(data.slice(i, i + this.frameLen), events, keep.slice(i, i + this.frameLen));
    }
    this.pending = data.slice(i);
    this.pendingStore = keep.slice(i);
    return events;
  }

  isLoud(level) { return level > Math.max(this.o.absMin, this.floor * this.o.ratio); }

  _frame(frame, events, stored = frame) {
    const o = this.o;
    const level = rms(frame);
    this.lastLevel = level;
    // مستوى الضوضاء = أقل مستوى خلال آخر ثانية ونصف. الكلام فيه فراغات بين المقاطع تنزل قرب مستوى المكان،
    // فلا يرتفع هذا المستوى مع الكلام، أما الضوضاء الثابتة (مروحة أو تكييف) أو تغيّر التعلية التلقائية فيتبعها.
    // الإطارات الصفرية تمامًا (قبل أن يبدأ الميكروفون فعليًا) لا تُحسب مستوى للمكان.
    if (level > 1e-5) {
      this.hist.push(level);
      if (this.hist.length > this.histN) this.hist.shift();
      let m = Infinity;
      for (const v of this.hist) if (v < m) m = v;
      this.floor = m;
    }
    const calibrating = this.hist.length < this.calibN && !this.inSpeech;
    const loud = !calibrating && this.isLoud(level);
    if (!this.inSpeech) {
      this.pre.push(stored);
      const maxPre = Math.ceil(o.preRollMs / o.frameMs);
      if (this.pre.length > maxPre) this.pre.shift();
      this.loudRun = loud ? this.loudRun + 1 : 0;
      if (this.loudRun * o.frameMs >= o.startMs) {
        this.inSpeech = true;
        this.frames = this.pre.slice();
        this.pre = [];
        this.lenMs = this.frames.length * o.frameMs;
        this.speechMs = this.loudRun * o.frameMs;
        this.silenceMs = 0;
        events.push({ type: 'start' });
      }
      return;
    }
    this.frames.push(stored);
    this.lenMs += o.frameMs;
    if (loud) { this.speechMs += o.frameMs; this.silenceMs = 0; } else { this.silenceMs += o.frameMs; }
    const end =
      (this.silenceMs >= o.endSilenceMs && this.lenMs >= o.minLenMs) ||
      this.silenceMs >= o.flushSilenceMs ||
      (this.lenMs >= o.softMaxMs && this.silenceMs >= o.softGapMs) ||
      this.lenMs >= o.hardMaxMs;
    if (end) this._finish(events);
  }

  _finish(events) {
    const o = this.o;
    // نترك 300 ms من الصمت في النهاية ونحذف الباقي.
    const trailing = Math.max(0, Math.floor((this.silenceMs - 300) / o.frameMs));
    const keep = this.frames.slice(0, this.frames.length - trailing);
    const enough = this.speechMs >= o.minSpeechMs;
    const audio = enough ? concat(keep) : null;
    const durMs = keep.length * o.frameMs;
    this.inSpeech = false;
    this.frames = [];
    this.loudRun = 0;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.lenMs = 0;
    events.push({ type: 'end', audio, durMs });
  }

  /** عند الإيقاف: يُخرج ما في المخزن إن كان كلامًا. */
  flush() {
    const events = [];
    if (this.inSpeech) this._finish(events);
    this.pending = new Float32Array(0);
    this.pendingStore = new Float32Array(0);
    this.pre = [];
    return events;
  }
}

export function concat(frames) {
  let n = 0;
  for (const f of frames) n += f.length;
  const out = new Float32Array(n);
  let k = 0;
  for (const f of frames) { out.set(f, k); k += f.length; }
  return out;
}
