// يعمل داخل خيط الصوت: ينقل إلى الصفحة دفعتين متزامنتين:
// المدخل الأول = الصوت بعد التعلية الثابتة (لقرار بداية الكلام ونهايته)،
// المدخل الثاني = الصوت بعد الضاغط (هو الذي يُرسل للمحرك).
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.a = new Float32Array(2048);
    this.b = new Float32Array(2048);
    this.n = 0;
  }
  process(inputs) {
    const ca = inputs[0] && inputs[0][0];
    const cb = (inputs[1] && inputs[1][0]) || ca;
    if (ca) {
      for (let i = 0; i < ca.length; i++) {
        this.a[this.n] = ca[i];
        this.b[this.n] = cb ? cb[i] : ca[i];
        this.n++;
        if (this.n === this.a.length) {
          this.port.postMessage({ raw: this.a.slice(0), proc: this.b.slice(0) });
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
