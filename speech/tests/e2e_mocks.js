// للاختبار فقط: ميكروفون صناعي (جمل متقطعة) + ردود Groq وهمية، لتجربة الصفحة كاملة بدون مفتاح حقيقي.
window.__gum = 0;
window.__calls = [];

navigator.mediaDevices.getUserMedia = async () => {
  window.__gum++;
  const c = new AudioContext();
  await c.resume();
  const sr = c.sampleRate;
  const pat = [[1, 0], [1.5, 0.1], [2, 0], [1.5, 0.1], [2, 0], [1.5, 0.1], [2, 0], [1.5, 0.1], [3, 0]];
  const total = pat.reduce((a, p) => a + p[0], 0);
  const buf = c.createBuffer(1, Math.round(total * sr), sr);
  const d = buf.getChannelData(0);
  let k = 0;
  for (const [sec, amp] of pat) {
    const n = Math.round(sec * sr);
    for (let i = 0; i < n; i++, k++) {
      const s = Math.sin(Math.PI * ((i / sr) * 4 % 1));
      d[k] = (Math.random() - 0.5) * 2 * (amp * s * s + 0.0004);
    }
  }
  const src = c.createBufferSource();
  src.buffer = buf; src.loop = true;
  const dst = c.createMediaStreamDestination();
  src.connect(dst); src.start();
  return dst.stream;
};

const seg = (text, o = {}) => ({ text, no_speech_prob: 0.01, avg_logprob: -0.2, compression_ratio: 1.2, ...o });
const R = [
  { d: 2500, segs: [seg(' بكرة عندي meeting مع المدير الساعة ten')] },    // أبطأ رد: يختبر الترتيب
  { d: 300, segs: [seg('اشتركوا في القناة', { no_speech_prob: 0.2, avg_logprob: -0.5 })] }, // وهمي: يُحذف
  { d: 300, segs: [seg('الواد قال'), seg('كلام بعيد', { avg_logprob: -1.5 })] },          // [غير واضح]
  { d: 300, segs: [seg(' Send me the report please')] },
];
const realFetch = window.fetch;
window.fetch = async (url, opt) => {
  if (String(url).includes('api.groq.com')) {
    const i = window.__calls.length;
    const f = opt.body.get('file');
    window.__calls.push({ size: f.size, lang: opt.body.get('language'), prompt: (opt.body.get('prompt') || '').slice(-40) });
    const r = R[i] || { d: 100, segs: [seg('جملة رقم ' + i)] };
    await new Promise((z) => setTimeout(z, r.d));
    return new Response(JSON.stringify({ text: r.segs.map((s) => s.text).join(''), segments: r.segs }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, opt);
};
