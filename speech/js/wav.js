// تحويل الصوت إلى 16 kHz أحادي وترميزه WAV بدقة 16 bit (الصيغة المناسبة لمحرك Whisper).

export function downsample(input, fromRate, toRate = 16000) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(input.length, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += input[j];
    out[i] = s / Math.max(1, b - a);
  }
  return out;
}

/**
 * تعلية جملة كاملة لأعلى مستوى نظيف: يُقاس مستوى الكلام في الجملة (لا أعلى قمة)،
 * فيُرفع الكلام الواطي والبعيد حتى 30 ضعفًا، ولا يُمس الكلام العالي، وتُليَّن القمم فقط بدل أن تتكسّر.
 */
export function normalizeSpeech(x, sampleRate = 16000, { target = 0.2, maxGain = 30 } = {}) {
  const frame = Math.max(1, Math.round(sampleRate * 0.02));
  const levels = [];
  for (let i = 0; i + frame <= x.length; i += frame) {
    let s = 0;
    for (let j = i; j < i + frame; j++) s += x[j] * x[j];
    levels.push(Math.sqrt(s / frame));
  }
  if (!levels.length) return x;
  levels.sort((a, b) => a - b);
  const speech = levels[Math.floor(levels.length * 0.9)] || levels[levels.length - 1];
  if (speech <= 1e-6) return x;
  const g = Math.min(maxGain, target / speech);
  if (g <= 1) return x;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = x[i] * g;
    const a = Math.abs(v);
    out[i] = a < 0.8 ? v : Math.sign(v) * (0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2));
  }
  return out;
}

export function encodeWav(samples, sampleRate = 16000) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
