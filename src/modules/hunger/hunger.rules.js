/**
 * Açlık check-in skorlaması (docs/backend/05-is-kurallari.md §5). Saf fonksiyon: aynı cevaplar
 * ve bağlam her zaman aynı sonucu verir. Girdiler API enum'larıyla (lowerCamelCase).
 */

export const SCORING_VERSION = 1;

/** Aktif oruç planın bu oranını geçtiyse ve fiziksel belirti varsa +1 fiziksel. */
const CONTEXT_RATIO = 0.75;
/** Baş dönmesi/bulantı bu süreyi aşan oruçta güvenlik bayrağı açar. */
const SAFETY_FAST_MINUTES = 16 * 60;

const Q3_PHYSICAL_CAPPED = ['stomachGrowling', 'lowEnergy', 'fatigue'];
const Q3_PHYSICAL = ['dizziness', 'nausea'];

/**
 * @param answers {symptoms[], q1, q2, bodyNotices[], q4}
 * @param context {fastedMinutes, targetMinutes} aktif oruç yoksa null
 */
export function scoreHunger(answers, context = null) {
  const symptoms = new Set(answers.symptoms ?? []);
  const notices = new Set(answers.bodyNotices ?? []);
  let p = 0;
  let e = 0;

  if (answers.q1 === 'yes') p += 2;
  if (answers.q1 === 'notReally') e += 2;

  if (answers.q2 === 'gradually') p += 2;
  if (answers.q2 === 'suddenly') e += 2;

  p += Math.min(2, Q3_PHYSICAL_CAPPED.filter((n) => notices.has(n)).length);
  p += Q3_PHYSICAL.filter((n) => notices.has(n)).length;
  if (notices.has('nothingPhysical')) e += 2;

  if (answers.q4 === 'almostAnything') p += 2;
  if (answers.q4 === 'somethingSweet') e += 2;
  if (answers.q4 === 'fastFood') e += 1;

  const fasted = context?.fastedMinutes ?? 0;
  if (context?.targetMinutes && fasted >= CONTEXT_RATIO * context.targetMinutes && p >= 1) p += 1;

  const dizzy = notices.has('dizziness') || symptoms.has('dizziness');
  const nausea = notices.has('nausea') || symptoms.has('nausea');
  const safetyFlag =
    (notices.has('dizziness') && notices.has('nausea')) ||
    ((dizzy || nausea) && fasted > SAFETY_FAST_MINUTES) ||
    (symptoms.has('dizziness') && symptoms.has('weakness'));

  // Eşitlikte fiziksel: gerçek açlığı "duygusal" diye geçiştirmemek daha güvenli.
  const resultType = p >= e ? 'physical' : 'emotional';
  return {
    resultType,
    physicalScore: p,
    emotionalScore: e,
    safetyFlag,
    scoringVersion: SCORING_VERSION,
    recommendationCodes: recommendationCodes(resultType, safetyFlag),
  };
}

/** Öneriler (05 §5.2–5.3): güvenlik bayrağında önce "orucu bitirmek normal". */
export function recommendationCodes(resultType, safetyFlag) {
  return [
    ...(safetyFlag ? ['safety_end_fast'] : []),
    ...(resultType === 'physical'
      ? ['physical_1', 'physical_2', 'physical_3']
      : ['emotional_1', 'emotional_2', 'emotional_3', 'emotional_4']),
  ];
}
