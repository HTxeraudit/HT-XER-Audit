// النواة: منع اختلاق الكلام. يحكم على نتيجة Whisper مقطعًا مقطعًا:
// يحذف ما يُعرف أنه وهمي (يظهر مع الصمت أو الضوضاء)، ويكتب «[غير واضح]» حين يكون المحرك غير واثق.

export const UNCLEAR = '[غير واضح]';

// عبارات يكتبها Whisper من بيانات تدريبه حين لا يوجد كلام حقيقي.
const KNOWN = [
  'اشتركوا في القناة', 'اشترك في القناة', 'لا تنسوا الاشتراك', 'لا تنسى الاشتراك', 'ترجمة نانسي قنقر', 'نانسي قنقر',
  'شكرا للمشاهدة', 'شكرا على المشاهدة', 'شكرا لكم على المشاهدة', 'شكرا لحسن استماعكم', 'تفريغ وتدقيق', 'موسيقى',
  'thank you for watching', 'thanks for watching', 'please subscribe', 'like and subscribe', 'subtitles by',
  'amara org', 'transcribed by', 'translated by',
];
// كلمات قصيرة شائعة الاختلاق؛ تُحذف فقط إن كان المحرك يشك في وجود كلام.
const SHORT_SUSPECT = ['you', 'thank you', 'bye', 'شكرا', 'نعم', 'ok'];

export function norm(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')           // التشكيل والتطويل
    .replace(/[إأآا]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function isKnown(n) {
  if (!n) return true;
  return KNOWN.some((k) => { const kn = norm(k); return n.includes(kn) && n.length <= kn.length + 12; });
}

/** يكسر التكرار الحلقي («لا لا لا لا لا ...») الذي يظهر مع الضوضاء. */
export function isLooping(text) {
  const w = norm(text).split(' ').filter(Boolean);
  if (w.length < 8) return false;
  const uniq = new Set(w).size;
  return uniq / w.length < 0.3;
}

/**
 * resp: استجابة verbose_json من Whisper. prompt: النص الذي أُرسل كتوجيه (لاكتشاف تسرّبه).
 * يعيد { text } (قد يكون فارغًا = لا شيء يُكتب).
 */
export function judge(resp, { prompt = '' } = {}) {
  const segs = Array.isArray(resp && resp.segments) && resp.segments.length
    ? resp.segments
    : [{ text: (resp && resp.text) || '' }];
  const nPrompt = norm(prompt);
  const out = [];
  for (const s of segs) {
    const text = String(s.text || '').trim();
    const n = norm(text);
    if (!n) continue;
    const nsp = typeof s.no_speech_prob === 'number' ? s.no_speech_prob : 0;
    const lp = typeof s.avg_logprob === 'number' ? s.avg_logprob : 0;
    const cr = typeof s.compression_ratio === 'number' ? s.compression_ratio : 1;
    if (nsp > 0.6 && lp < -0.7) continue;                         // غالبًا صمت
    if (isKnown(n)) continue;                                      // عبارة وهمية معروفة
    if (n.length > 12 && nPrompt.includes(n)) continue;            // تسرّب من التوجيه
    if (SHORT_SUSPECT.includes(n) && (nsp > 0.3 || lp < -0.8)) continue;
    if (lp < -1.15 || cr > 2.4 || isLooping(text)) {               // المحرك غير واثق
      if (out[out.length - 1] !== UNCLEAR) out.push(UNCLEAR);
      continue;
    }
    out.push(text);
  }
  // مقطع كله غير واضح بلا أي كلام مفهوم: نكتب العلامة مرة واحدة فقط.
  return { text: out.join(' ').replace(/\s+/g, ' ').trim() };
}
