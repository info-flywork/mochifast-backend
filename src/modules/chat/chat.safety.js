/**
 * Acil durum sinyali (docs/backend/09-yapay-zeka.md §5.2): kullanıcı mesajında tehlike
 * belirtisi varsa yanıtın meta verisine `safety: "urgent"` eklenir, istemci "acil durum"
 * kartını gösterir. Model de aynı durumda orucu bitirmesini söyler (persona kuralı); bu
 * sınıflandırıcı modelden bağımsız bir güvenlik ağıdır. Kasıtlı olarak geniş tutulur: yanlış
 * pozitif yalnızca bir bilgi kartıdır, yanlış negatif ise kaçan bir uyarı.
 *
 * Metin küçük harfe çevrilir ve aksanlar atılır (ş→s, ü→u, ı→i, é→e …); kalıplar buna göre yazılır.
 */
const PATTERNS = {
  en: [
    /\bfaint/,
    /\bpass(ed|ing)? out\b/,
    /\bblack(ed)? ?out\b/,
    /\bchest (pain|hurts|is hurting|tight)/,
    /\b(can'?t|cannot|hard to) breathe\b/,
    /\bshort(ness)? of breath\b/,
    /\bheart (is )?(racing|pounding)\b/,
    /\bpalpitation/,
    /\b(vomit|throw(ing)? up|threw up)/,
    /\b(very|so|really|extremely|severely) dizzy\b/,
    /\b(severe|bad|extreme) dizziness\b/,
    /\b(low|crashing) blood sugar\b/,
    /\bhypo(glyc)?/,
    /\bseizure/,
    /\bconfused and\b/,
  ],
  tr: [
    /\bbayil/,
    /\bbayg/,
    /\bgogs(um|un)? agri/,
    /\bgogus(um)? agri/,
    /\bnefes ?alam/,
    /\bnefesim daral/,
    /\bkalp ?carpint/,
    /\bkalbim (cok )?(hizli|carpiyor|sikis)/,
    /\bkus(tum|uyorum|acak|ma|uyor)/,
    /\b(cok|fena|asiri) (basim donuyor|bas donmesi)/,
    /\bbasim (cok|fena) don/,
    /\bseker(im)? (dus|cok dus)/,
    /\bhipoglisemi/,
    /\bnobet geci/,
  ],
  de: [
    /\bohnmacht/,
    /\bohnmachtig/,
    /\bbrustschmerz/,
    /\bschmerzen in der brust/,
    /\b(keine luft|atemnot)/,
    /\bherzrasen/,
    /\b(erbrech|ubergeb|kotz)/,
    /\b(stark|sehr|extrem) schwindel/,
    /\bunterzucker/,
    /\bkrampfanfall/,
  ],
  es: [
    /\bdesmay/,
    /\bdolor (en el|de|del) pecho/,
    /\bno puedo respirar/,
    /\bfalta de aire/,
    /\bpalpitacion/,
    /\bcorazon (muy )?acelerado/,
    /\b(vomit|vomite)/,
    /\b(muy mareado|mareo (muy )?fuerte|mareos fuertes)/,
    /\bhipoglucemia/,
    /\bazucar (muy )?baj/,
    /\bconvulsi/,
  ],
  fr: [
    /\bevanoui/,
    /\bdouleur(s)? (a la|dans la) poitrine/,
    /\b(du mal a|n'arrive pas a|ne peux pas) respirer/,
    /\bpalpitation/,
    /\bcoeur (qui )?(bat|s'emballe)/,
    /\bvomi/,
    /\bvertige(s)? (fort|intense|violent)/,
    /\bhypoglycemie/,
    /\bconvulsion/,
  ],
  it: [
    /\bsvenut/,
    /\bsvenire/,
    /\bdolore al petto/,
    /\bnon riesco a respirare/,
    /\bfiato corto/,
    /\bpalpitazion/,
    /\btachicardia/,
    /\bvomit/,
    /\b(capogiro forte|forti vertigini|vertigini forti)/,
    /\bipoglicemia/,
    /\bconvulsion/,
  ],
  ru: [
    /обморок/,
    /потерял(а)? сознание/,
    /бол(ь|ит) в груди/,
    /не могу дышать/,
    /задыха/,
    /сердцебиени/,
    /сердце (колотится|бешено)/,
    /рвот/,
    /вырвал/,
    /(сильно кружится|сильное головокружение)/,
    /гипогликеми/,
    /низкий сахар/,
    /судорог/,
  ],
};

const ALL = Object.values(PATTERNS).flat();

/** Küçük harf + aksansız; Türkçe noktasız ı da i olur. */
export function normalizeForMatch(text) {
  return String(text ?? '')
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’`]/g, "'");
}

/** @returns 'urgent' | 'none' — tüm dillerin kalıpları denenir (kullanıcı dil karıştırabilir). */
export function classifySafety(text) {
  const t = normalizeForMatch(text);
  return ALL.some((re) => re.test(t)) ? 'urgent' : 'none';
}
