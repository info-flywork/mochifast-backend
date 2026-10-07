import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Rate } from 'k6/metrics';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

/**
 * Sabah zirvesi (docs/backend/07-cache-performans.md §8.1, §9):
 * %60 ana sayfa (summary + aktif oruç), %20 yazma (su/öğün), %10 sohbet listesi, %10 katalog.
 * Hedef: 500 istek/sn'de p95 SLO'ları, 5xx < %0.1.
 *
 *   BASE_URL=https://staging-api.example.com k6 run loadtest/morning-peak.js
 *   RATE=100 DURATION=3m k6 run loadtest/morning-peak.js     (kısa deneme)
 *
 * Önce: `node loadtest/create-users.js 500` (aynı ortamda). Staging'de geçici olarak
 * RATE_LIMIT_GLOBAL_MAX yükseltilmeli (tek IP'den yük gelir). Sohbet mesajı GÖNDERİLMEZ
 * (gerçek model maliyeti); yalnızca liste okunur.
 */
const BASE = __ENV.BASE_URL ?? 'http://localhost:3000';
const RATE = Number(__ENV.RATE ?? 500);
const DURATION = __ENV.DURATION ?? '10m';
const users = new SharedArray('users', () => JSON.parse(open('./users.json')));

export const options = {
  scenarios: {
    peak: {
      executor: 'ramping-arrival-rate',
      startRate: Math.ceil(RATE / 10),
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 1000,
      stages: [
        { target: RATE, duration: '2m' },
        { target: RATE, duration: DURATION },
        { target: 0, duration: '30s' },
      ],
    },
  },
  thresholds: {
    'http_req_duration{kind:read}': ['p(95)<150'],
    'http_req_duration{kind:write}': ['p(95)<250'],
    'http_req_duration{name:summary}': ['p(95)<120'],
    'http_req_duration{kind:catalog}': ['p(95)<50'],
    server_errors: ['rate<0.001'],
    checks: ['rate>0.99'],
  },
};

const serverErrors = new Rate('server_errors');

function request(method, path, { token, body, kind, name }) {
  const params = {
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'accept-language': 'tr',
      'x-timezone': 'Europe/Istanbul',
    },
    tags: { kind, name: name ?? path },
  };
  if (kind === 'write') params.headers['idempotency-key'] = crypto.randomUUID();
  const res = http.request(method, `${BASE}${path}`, body ? JSON.stringify(body) : null, params);
  serverErrors.add(res.status >= 500);
  check(res, { [`${name ?? path} 2xx`]: (r) => r.status >= 200 && r.status < 300 });
  return res;
}

export default function () {
  const { token } = users[randomIntBetween(0, users.length - 1)];
  const roll = Math.random();
  if (roll < 0.6) {
    request('GET', '/v1/user/summary', { token, kind: 'read', name: 'summary' });
    request('GET', '/v1/fasts/active', { token, kind: 'read', name: 'fasts_active' });
  } else if (roll < 0.8) {
    if (Math.random() < 0.7) {
      request('POST', '/v1/water', {
        token,
        kind: 'write',
        name: 'water_add',
        body: { amountMl: 250 },
      });
    } else {
      request('POST', '/v1/meals', {
        token,
        kind: 'write',
        name: 'meal_add',
        body: { id: crypto.randomUUID(), kind: 'meal', title: 'Yulaf', kcal: 320 },
      });
    }
  } else if (roll < 0.9) {
    request('GET', '/v1/chat/conversations', { token, kind: 'read', name: 'chat_list' });
  } else {
    const path = Math.random() < 0.5 ? '/v1/catalog/plans' : '/v1/catalog/faq';
    request('GET', path, { token, kind: 'catalog', name: path.slice(4) });
  }
}
