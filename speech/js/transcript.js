// النواة: دمج نتائج محرك التعرف على الكلام في نص واحد بلا تكرار ولا فقد.
// لا تعتمد على الواجهة ولا على المتصفح، لذلك تُعاد كما هي في أي نسخة لاحقة.

/** يطبّع المسافات فقط؛ لا يغيّر الكلمات أبدًا (تفريغ حرفي). */
export function clean(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * يدمج سلسلة نصوص متتالية من المحرك.
 * بعض نسخ سفاري تعيد النص تراكميًا (كل نتيجة تحتوي ما قبلها)، وبعضها يعيد أجزاء منفصلة،
 * فنتعامل مع الحالتين: إن بدأ النص الجديد بالقديم نستبدله، وإن كان القديم ينتهي به نتجاهله.
 */
export function mergeSequence(parts) {
  let acc = '';
  for (const raw of parts) {
    const t = clean(raw);
    if (!t) continue;
    if (!acc) { acc = t; continue; }
    if (t.startsWith(acc)) { acc = t; continue; }
    if (acc.endsWith(t)) continue;
    acc = acc + ' ' + t;
  }
  return acc;
}

/**
 * يحسب الجزء الثابت والجزء المؤقت لجولة واحدة من جولات المحرك.
 * results: مصفوفة { text, isFinal } بالترتيب كما وصلت.
 */
export function splitInstance(results) {
  const finals = [];
  const interims = [];
  for (const r of results) (r.isFinal ? finals : interims).push(r.text);
  const finalText = mergeSequence(finals);
  let interimText = mergeSequence(interims);
  // إن أعاد المحرك النص الثابت داخل المؤقت نحذف المكرر.
  if (finalText && interimText.startsWith(finalText)) {
    interimText = clean(interimText.slice(finalText.length));
  }
  return { finalText, interimText };
}

/** يدير نص الجلسة كاملة: فقرات مثبتة + جولة حالية (ثابت + مؤقت). */
export class Transcript {
  constructor() {
    this.segments = [];      // { text, at: Date }
    this.current = { finalText: '', interimText: '' };
    this.currentStartedAt = null;
  }

  /** تحديث الجولة الحالية بكل نتائجها (المحرك يرسل القائمة كاملة كل مرة). */
  update(results) {
    if (!this.currentStartedAt) this.currentStartedAt = new Date();
    this.current = splitInstance(results);
  }

  /** عند انتهاء الجولة: يُثبَّت كل ما ظهر، حتى المؤقت، لأن سفاري أحيانًا لا يعلّم النتيجة بأنها نهائية. */
  commit() {
    const text = mergeSequence([this.current.finalText, this.current.interimText]);
    const at = this.currentStartedAt || new Date();
    this.current = { finalText: '', interimText: '' };
    this.currentStartedAt = null;
    if (!text) return null;
    const last = this.segments[this.segments.length - 1];
    if (last && last.text === text) return null;           // تكرار حرفي للجولة السابقة
    if (last && last.text.endsWith(text)) return null;      // جزء من السابقة أعيد إرساله
    const seg = { text, at };
    this.segments.push(seg);
    return seg;
  }

  /** استبدال النص كله بعد تعديل المستخدم. */
  replaceAll(text) {
    this.current = { finalText: '', interimText: '' };
    this.currentStartedAt = null;
    const paras = String(text).split(/\n+/).map(clean).filter(Boolean);
    this.segments = paras.map((p) => ({ text: p, at: null }));
  }

  clear() {
    this.segments = [];
    this.current = { finalText: '', interimText: '' };
    this.currentStartedAt = null;
  }

  isEmpty() {
    return !this.segments.length && !this.current.finalText && !this.current.interimText;
  }

  /** النص الكامل للنسخ والحفظ، فقرة لكل جولة. */
  toPlainText({ withTimes = false } = {}) {
    const lines = this.segments.map((s) => (withTimes && s.at ? `[${formatTime(s.at)}] ` : '') + s.text);
    const live = mergeSequence([this.current.finalText, this.current.interimText]);
    if (live) lines.push(live);
    return lines.join('\n');
  }
}

export function formatTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
