import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { QueueEvents } from 'bullmq';
import { buildApp } from '../../src/app.js';
import { createDatabase } from '../../src/infra/db.js';
import { createCache } from '../../src/infra/cache.js';
import {
  closeRedis,
  createCacheRedis,
  createQueueRedis,
  queueConnectionOptions,
} from '../../src/infra/redis.js';
import { createQueues, createWorker } from '../../src/infra/queue.js';
import { syncSchedules } from '../../src/schedules.js';
import { systemJobs } from '../../src/jobs/system.jobs.js';
import { createTestDatabase, testConfig } from '../helpers/infra.js';

const mysqlUrl = inject('mysqlUrl');
const redisUrl = inject('redisUrl');
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

describe.skipIf(!redisUrl)('Redis: cache & kuyruk', () => {
  const config = testConfig({
    REDIS_CACHE_URL: redisUrl,
    REDIS_QUEUE_URL: redisUrl,
  });
  let redis;

  beforeAll(async () => {
    redis = createCacheRedis(config.redis.cacheUrl);
    await redis.connect();
  });
  afterAll(async () => {
    if (redis) await closeRedis(redis);
  });

  it("cache gerçek Redis ile TTL'li yazar ve okur", async () => {
    const cache = createCache({ client: redis, prefix: `${config.redis.keyPrefix}:test` });
    await cache.set('k', { v: 1 }, 30);
    expect(await cache.get('k')).toEqual({ v: 1 });
    const ttl = await redis.ttl(cache.key('k'));
    expect(ttl).toBeGreaterThan(25);
    expect(ttl).toBeLessThanOrEqual(33);
  });

  it('zamanlamalar senkronlanır (upsert + listeden çıkanları silme)', async () => {
    const queues = createQueues(config);
    try {
      await syncSchedules(queues, [
        { id: 'a', queue: 'system', jobName: 'heartbeat', repeat: { every: 60_000 } },
        { id: 'b', queue: 'system', jobName: 'heartbeat', repeat: { every: 120_000 } },
      ]);
      const result = await syncSchedules(queues, [
        { id: 'a', queue: 'system', jobName: 'heartbeat', repeat: { every: 60_000 } },
      ]);
      expect(result).toEqual({ upserted: 1, removed: 1 });
      const ids = (await queues.system.getJobSchedulers()).map((s) => s.key);
      expect(ids).toEqual(['a']);
      await queues.system.removeJobScheduler('a');
    } finally {
      await queues.system.obliterate({ force: true });
      await queues.system.close();
    }
  });

  it('kuyruğa atılan heartbeat işi worker tarafından işlenir', async () => {
    const queues = createQueues(config);
    const worker = createWorker(config, 'system', systemJobs({ logger: silentLogger }), {
      logger: silentLogger,
    });
    const events = new QueueEvents('system', {
      connection: queueConnectionOptions(config.redis.queueUrl),
      prefix: `${config.redis.keyPrefix}:${config.env}:bull`,
    });
    try {
      await events.waitUntilReady();
      const job = await queues.system.add('heartbeat', {});
      const result = await job.waitUntilFinished(events, 10_000);
      expect(typeof result.at).toBe('string');
    } finally {
      await worker.close();
      await events.close();
      await queues.system.obliterate({ force: true });
      await queues.system.close();
    }
  });
});

describe.skipIf(!mysqlUrl || !redisUrl)('readiness (gerçek MySQL + Redis)', () => {
  it('tüm bağımlılıklar gerçekten ayaktayken 200, Redis store ile rate limit çalışır', async () => {
    const testDb = await createTestDatabase(mysqlUrl);
    const config = testConfig({
      ...testDb.env,
      REDIS_CACHE_URL: redisUrl,
      REDIS_QUEUE_URL: redisUrl,
      RATE_LIMIT_GLOBAL_MAX: '2',
    });
    const db = createDatabase(config.db);
    const cacheRedis = createCacheRedis(config.redis.cacheUrl);
    const queueRedis = createQueueRedis(config.redis.queueUrl);
    await Promise.all([cacheRedis.connect(), queueRedis.connect()]);
    const cache = createCache({ client: cacheRedis, prefix: config.redis.keyPrefix });
    const app = await buildApp({
      config,
      logger: false,
      deps: { db, cacheRedis, queueRedis, cache },
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.status).toBe('ok');

      const codes = [];
      for (let i = 0; i < 3; i += 1)
        codes.push((await app.inject({ method: 'GET', url: '/v1/yok' })).statusCode);
      expect(codes).toEqual([404, 404, 429]);
    } finally {
      await app.close();
      await Promise.allSettled([db.close(), closeRedis(cacheRedis), closeRedis(queueRedis)]);
      await testDb.drop();
    }
  });
});
