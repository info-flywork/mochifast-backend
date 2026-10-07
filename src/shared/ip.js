import { isIPv6 } from 'node:net';

/**
 * Rate limit anahtarı için IP: IPv4 olduğu gibi, IPv6 /64 ağına indirgenir (tek kullanıcı genelde
 * bir /64 bloğunun tamamına sahiptir; tek adres anahtarı bu blokta sınırsız deneme demektir).
 * IPv4-mapped IPv6 (`::ffff:1.2.3.4`) IPv4 sayılır.
 */
export function rateKeyForIp(ip) {
  if (!ip) return 'unknown';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  if (!isIPv6(ip)) return ip;
  const [head, tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => (parseInt(g, 16) || 0).toString(16))
    .join(':')}::/64`;
}
