/**
 * "1.2.3" biçimli sürümleri karşılaştırır (ön ek/derleme etiketi yok sayılır).
 * a < b → negatif, eşit → 0, a > b → pozitif. Geçersiz sürüm null döner.
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})/.exec(String(v ?? ''));
    return m ? m.slice(1).map(Number) : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
