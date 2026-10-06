import { exportJWK, generateKeyPair } from 'jose';

/**
 * Yeni Ed25519 JWT imzalama anahtarı üretir (anahtar rotasyonu için).
 *   npm run keys:jwt
 *   npm run keys:jwt -- --public-jwks '<mevcut JWT_PUBLIC_JWKS>'   → eskilerle birleştirir
 *
 * Rotasyon: JWT_PRIVATE_JWK'i yenisiyle değiştir, JWT_PUBLIC_JWKS'i çıktıdakiyle değiştir.
 * Eski açık anahtarı access token ömrü (15 dk) geçtikten sonra listeden çıkarabilirsin.
 */
const idx = process.argv.indexOf('--public-jwks');
const existing = idx > -1 ? JSON.parse(process.argv[idx + 1]) : [];

const kid = `k${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${Math.random().toString(36).slice(2, 6)}`;
const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
  crv: 'Ed25519',
  extractable: true,
});
const privateJwk = { ...(await exportJWK(privateKey)), kid, alg: 'EdDSA', use: 'sig' };
const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' };

console.log(`JWT_PRIVATE_JWK='${JSON.stringify(privateJwk)}'`);
console.log(`JWT_PUBLIC_JWKS='${JSON.stringify([publicJwk, ...existing])}'`);
