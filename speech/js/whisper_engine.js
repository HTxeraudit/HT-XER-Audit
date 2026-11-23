// محرك Whisper: التقاط الصوت بأنفسنا (فلتر للزنّة والصفير) ثم تقطيعه جملًا، وتعلية كل جملة لوحدها
// لأعلى مستوى نظيف بلا تشويه، وإرسالها إلى Groq.
// الأحداث: level, speechstart, speechend, pending{seq,at}, final{seq,text,failed}, error{code,fatal,message}

import { Segmenter } from './vad.js';
import { downsample, encodeWav, normalizeSpeech } from './wav.js';
import { transcribe } from './groq.js';
import { judge, isForeignResponse } from './filter.js';

// مستويات تعلية الصوت. «far» للكلام البعيد (غرفة مجاورة): تعلية أقصى وحساسية أعلى لبداية الكلام.
export const BOOST = {
  off:    { gain: 1,  ratio: 3,   absMin: 0.004 },
  medium: { gain: 3,  ratio: 3,   absMin: 0.004 },
  high:   { gain: 6,  ratio: 2.5, absMin: 0.003 },
  far:    { gain: 14, ratio: 1.8, absMin: 0.0015 },
};

// تقليل الضوضاء المدمج في آيفون مصمم للكلام القريب من الهاتف، ويمسح الأصوات البعيدة على أنها ضوضاء؛
// لذلك نقفله ونعتمد على فلاترنا (حذف الزنّة والصفير) وعلى منع الاختلاق بعد التفريغ.
export const MIC_CONSTRAINTS = { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 };

const MAX_PER_MIN = 18;     // حد الخطة المجانية 20 طلبًا في الدقيقة؛ نترك هامشًا
const CONCURRENCY = 2;

export class WhisperEngine extends EventTarget {
  constructor({ key, language = '', boost = 'medium', firstSeq = 0, getStream = null } = {}) {
    super();
    this.getStream = getStream;       // ميكروفون مشترك تملكه الصفحة (إذن واحد طوال فتحها)
    this.key = key;
    this.language = language;
    this.boost = BOOST[boost] ? boost : 'medium';
    this.seq = firstSeq;              // ترقيم متصل عبر الإيقاف والاستئناف
    this.queue = [];
    this.active = 0;
    this.sentAt = [];
    this.running = false;
    this.dead = false;
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async start() {
    this.dead = false;
    this.stream = this.getStream ? await this.getStream() : await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const ctx = this.ctx;
    const b = BOOST[this.boost];

    const src = ctx.createMediaStreamSource(this.stream);
    const hp = ctx.createBiquadFilter();               // يحذف الزنّة والطنين المنخفض قبل التعلية
    hp.type = 'highpass'; hp.frequency.value = 90;
    const lp = ctx.createBiquadFilter();               // يحذف الصفير العالي الذي لا يحمل كلامًا
    lp.type = 'lowpass'; lp.frequency.value = 7500;
    // مسار القياس: تعلية ثابتة تُستخدم فقط لمعرفة بداية الكلام ونهايته (لا تُرسل للمحرك).
    this.gain = ctx.createGain();
    this.gain.gain.value = b.gain;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(hp); hp.connect(lp); lp.connect(this.gain);

    this.segmenter = new Segmenter({ sampleRate: ctx.sampleRate, ratio: b.ratio, absMin: b.absMin });
    const onSamples = (raw, proc) => this._onSamples(raw, proc);

    // المدخل الأول = مسار القياس، المدخل الثاني = الصوت النظيف بلا تعلية ولا ضاغط (هو الذي يُحفظ ويُرسل،
    // ثم تُعلّى كل جملة لوحدها عند انتهائها). الضاغط السابق كان يشوّه الكلام القريب فيكتب المحرك كلامًا خطأ.
    let sink;
    try {
      await ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
      sink = new AudioWorkletNode(ctx, 'capture-processor', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1] });
      sink.port.onmessage = (e) => onSamples(e.data.raw, e.data.proc);
      this.gain.connect(sink, 0, 0);
      lp.connect(sink, 0, 1);
    } catch (_) {
      const merger = ctx.createChannelMerger(2);       // بديل للأجهزة القديمة
      this.gain.connect(merger, 0, 0);
      lp.connect(merger, 0, 1);
      sink = ctx.createScriptProcessor(4096, 2, 1);
      sink.onaudioprocess = (e) => onSamples(
        new Float32Array(e.inputBuffer.getChannelData(0)), new Float32Array(e.inputBuffer.getChannelData(1)));
      merger.connect(sink);
    }
    sink.connect(mute); mute.connect(ctx.destination);
    this.sink = sink;
    this.running = true;
  }

  _onSamples(raw, proc) {
    if (!this.running) return;
    const events = this.segmenter.push(raw, proc);
    const lvl = this.segmenter.lastLevel || 0;
    const db = 20 * Math.log10(Math.max(lvl, 1e-6));
    this._emit('level', Math.min(1, Math.max(0, (db + 60) / 50)));
    this._handle(events);
  }

  _handle(events) {
    for (const ev of events) {
      if (ev.type === 'start') { this.segStartedAt = new Date(); this._emit('speechstart'); }
      if (ev.type === 'end') {
        this._emit('speechend');
        if (ev.audio) this._enqueue(ev.audio, this.segStartedAt || new Date());
      }
    }
  }

  /** إيقاف الميكروفون مع إرسال آخر جملة؛ الطلبات الجارية تكمل وتصل نتائجها. */
  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.segmenter) this._handle(this.segmenter.flush());
    try { this.sink && this.sink.disconnect(); } catch (_) { /* لا شيء */ }
    // الميكروفون المشترك لا يُغلق هنا حتى لا يُطلب الإذن مرة أخرى؛ الصفحة تتحكم فيه.
    if (this.stream && !this.getStream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) this.ctx.close().catch(() => {});
    this.stream = null; this.ctx = null;
    this._emit('level', 0);
  }

  get busy() { return this.active > 0 || this.queue.length > 0; }

  _enqueue(audio, at) {
    const seq = this.seq++;
    const sr = this.ctx ? this.ctx.sampleRate : 48000;
    const wav = encodeWav(normalizeSpeech(downsample(audio, sr, 16000), 16000), 16000);
    this._emit('pending', { seq, at });
    this.queue.push({ seq, at, wav, tries: 0 });
    this._pump();
  }

  _pump() {
    if (this.dead) return;
    while (this.active < CONCURRENCY && this.queue.length) {
      const now = Date.now();
      this.sentAt = this.sentAt.filter((t) => now - t < 60000);
      if (this.sentAt.length >= MAX_PER_MIN) {
        clearTimeout(this._wait);
        this._wait = setTimeout(() => this._pump(), 60000 - (now - this.sentAt[0]) + 50);
        return;
      }
      const job = this.queue.shift();
      this.sentAt.push(now);
      this.active++;
      this._run(job).finally(() => { this.active--; this._pump(); });
    }
  }

  async _run(job) {
    // بلا جملة توجيه وبلا سياق: Whisper كان يعيد كتابة جملة التوجيه كأنها قيلت، وينقل غلط جملة لما بعدها.
    try {
      let resp = await transcribe(job.wav, { key: this.key, language: this.language });
      // في الوضع التلقائي: إن ظنّ المحرك اللغة روسية أو غيرها، نعيد المقطع مرة واحدة على أنه عربي،
      // حتى لا يضيع كلام حقيقي تُرجم خطأً؛ وإن كان ضوضاء فسيحذفه الفلتر بعدها.
      if (!this.language && isForeignResponse(resp)) {
        resp = await transcribe(job.wav, { key: this.key, language: 'ar' });
      }
      const { text } = judge(resp);
      this._emit('final', { seq: job.seq, text });
    } catch (err) {
      const code = err.code || 'server';
      job.tries++;
      if (code === 'bad-key') {
        this.dead = true;
        this._emit('error', { code, fatal: true });
        this._failAll(job);
        return;
      }
      if (code === 'rate-limit' && job.tries <= 5) {
        this._emit('error', { code, fatal: false });
        await sleep(((err.retryAfter || 8) + 1) * 1000);
        this.queue.unshift(job);
        return;
      }
      if (code === 'network' && job.tries <= 4) {
        this._emit('error', { code, fatal: false });
        if (!navigator.onLine) await waitOnline(60000); else await sleep(1500 * job.tries);
        this.queue.unshift(job);
        return;
      }
      this._emit('error', { code, fatal: false, message: err.message });
      this._emit('final', { seq: job.seq, text: '[تعذّر تفريغ هذا المقطع]', failed: true });
    }
  }

  _failAll(first) {
    const jobs = [first, ...this.queue];
    this.queue = [];
    for (const j of jobs) this._emit('final', { seq: j.seq, text: '[تعذّر تفريغ هذا المقطع]', failed: true });
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function waitOnline(maxMs) {
  return new Promise((r) => {
    const done = () => { window.removeEventListener('online', done); clearTimeout(t); r(); };
    const t = setTimeout(done, maxMs);
    window.addEventListener('online', done);
  });
}
