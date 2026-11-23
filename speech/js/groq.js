// إرسال مقطع صوتي إلى محرك Whisper على Groq (خطة مجانية بحدود يومية).
// المفتاح يأتي من إعدادات الجهاز فقط ولا يُكتب في الكود.

export const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
export const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';

// مثال يوجّه المحرك لكتابة الكلمات الإنجليزية بحروفها داخل الكلام العربي المصري، دون ترجمة.
export const STYLE_PROMPT = 'أنا عندي meeting بكرة الساعة ten، وبعدين هبعتلك الـ report على الـ email. تمام، ماشي.';

export class GroqError extends Error {
  constructor(code, message, retryAfter = 0) { super(message || code); this.code = code; this.retryAfter = retryAfter; }
}

export async function transcribe(blob, { key, model = 'whisper-large-v3', language = '', prompt = '', signal } = {}) {
  const fd = new FormData();
  fd.append('file', blob, 'speech.wav');
  fd.append('model', model);
  fd.append('response_format', 'verbose_json');
  fd.append('temperature', '0');
  if (language) fd.append('language', language);
  if (prompt) fd.append('prompt', prompt);
  let res;
  try {
    res = await fetch(GROQ_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd, signal });
  } catch (e) {
    throw new GroqError('network', String(e));
  }
  if (res.ok) return res.json();
  let detail = '';
  try { detail = (await res.json()).error?.message || ''; } catch (_) { /* لا تفاصيل */ }
  if (res.status === 401 || res.status === 403) throw new GroqError('bad-key', detail);
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after')) || 0;
    throw new GroqError('rate-limit', detail, ra);
  }
  if (res.status === 413) throw new GroqError('too-large', detail);
  throw new GroqError('server', `${res.status} ${detail}`);
}

/** فحص المفتاح بطلب خفيف لا يستهلك من حدود الصوت. */
export async function checkKey(key) {
  try {
    const res = await fetch(GROQ_MODELS_URL, { headers: { Authorization: 'Bearer ' + key } });
    if (res.ok) return 'ok';
    if (res.status === 401 || res.status === 403) return 'bad-key';
    return 'server';
  } catch (_) {
    return 'network';
  }
}
