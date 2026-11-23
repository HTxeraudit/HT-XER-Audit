// مؤشر مستوى الصوت واكتشاف بداية الكلام بصريًا (للتنبيه البصري لضعاف السمع).
// يعمل بالتوازي مع محرك التعرف؛ إن تعارض معه على جهاز ما يمكن إيقافه من الإعدادات.

export class LevelMeter extends EventTarget {
  constructor() {
    super();
    this.stream = null;
    this.ctx = null;
    this.raf = 0;
    this.level = 0;            // 0..1
    this.speaking = false;
    this._loudSince = 0;
    this._quietSince = 0;
  }

  get active() { return !!this.stream; }

  async start() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const src = this.ctx.createMediaStreamSource(this.stream);
    const an = this.ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    let noiseFloor = 0.01;
    const tick = () => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      // أرضية الضوضاء تتبع الهدوء ببطء، فيُقاس الكلام فوقها لا فوق صفر مطلق.
      noiseFloor = rms < noiseFloor ? noiseFloor * 0.95 + rms * 0.05 : noiseFloor * 0.999 + rms * 0.001;
      const db = 20 * Math.log10(Math.max(rms, 1e-6));
      this.level = Math.min(1, Math.max(0, (db + 60) / 50));
      const now = performance.now();
      const loud = rms > Math.max(0.012, noiseFloor * 3);
      if (loud) { this._quietSince = 0; if (!this._loudSince) this._loudSince = now; }
      else { this._loudSince = 0; if (!this._quietSince) this._quietSince = now; }
      if (!this.speaking && this._loudSince && now - this._loudSince > 120) {
        this.speaking = true; this.dispatchEvent(new Event('speechstart'));
      } else if (this.speaking && this._quietSince && now - this._quietSince > 900) {
        this.speaking = false; this.dispatchEvent(new Event('speechend'));
      }
      this.dispatchEvent(new CustomEvent('level', { detail: this.level }));
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  stop() {
    cancelAnimationFrame(this.raf);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) this.ctx.close().catch(() => {});
    this.stream = null; this.ctx = null; this.level = 0; this.speaking = false;
    this.dispatchEvent(new CustomEvent('level', { detail: 0 }));
  }
}
