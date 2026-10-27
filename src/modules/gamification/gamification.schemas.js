import { envelope } from '../../shared/schemas.js';

const bearer = [{ bearerAuth: [] }];
const nstr = { type: ['string', 'null'] };

export const worldSchema = {
  tags: ['world'],
  summary: 'Mochi World: bölgeler, sahne seviyesi, sağlık',
  security: bearer,
  response: {
    200: envelope({
      type: 'object',
      properties: {
        level: { type: 'integer' },
        xp: { type: 'integer' },
        sceneLevel: { type: 'integer' },
        health: { type: 'string', enum: ['thriving', 'wilting', 'drought'] },
        worldProgress: { type: 'number' },
        zones: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              zone: { type: 'string' },
              metric: { type: 'string' },
              unit: { type: 'string' },
              current: { type: 'number' },
              level: { type: 'integer' },
              nextThreshold: { type: ['number', 'null'] },
              ratioToNext: { type: 'number' },
              thresholds: { type: 'array', items: { type: 'number' } },
            },
          },
        },
        week: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string' },
              fastedMinutes: { type: 'integer' },
              kept: { type: ['boolean', 'null'] },
            },
          },
        },
      },
    }),
  },
};

export const challengeSchema = {
  type: ['object', 'null'],
  properties: {
    code: { type: 'string' },
    title: { type: 'string' },
    subtitle: { type: 'string' },
    badge: nstr,
    description: nstr,
    metric: { type: 'string' },
    targetCount: { type: 'integer' },
    durationDays: { type: 'integer' },
    windowType: { type: 'string' },
    startsAt: nstr,
    endsAt: nstr,
    rewardXp: { type: 'integer' },
    isPremium: { type: 'boolean' },
    isFeatured: { type: 'boolean' },
    participantsCount: { type: 'integer' },
    participantAvatars: { type: 'array', items: { type: 'string' } },
    my: {
      type: ['object', 'null'],
      properties: {
        id: { type: 'string' },
        status: { type: 'string' },
        progress: { type: 'integer' },
        target: { type: 'integer' },
        windowStart: { type: 'string' },
        windowEnd: { type: 'string' },
        completedAt: nstr,
      },
    },
  },
};

const codeParams = {
  type: 'object',
  additionalProperties: false,
  required: ['code'],
  properties: { code: { type: 'string', pattern: '^[a-z0-9_]{1,40}$' } },
};
const one = envelope({ type: 'object', properties: { challenge: challengeSchema } });

export const listChallengesSchema = {
  tags: ['challenges'],
  summary: "Aktif challenge'lar ve katılımım",
  security: bearer,
  response: {
    200: envelope({
      type: 'object',
      properties: { items: { type: 'array', items: challengeSchema } },
    }),
  },
};
export const featuredSchema = {
  tags: ['challenges'],
  summary: 'Ana sayfa kartı',
  security: bearer,
  response: { 200: one },
};
export const joinSchema = {
  tags: ['challenges'],
  summary: 'Katıl (rolling pencere başlar; aktif katılım varsa 409)',
  security: bearer,
  params: codeParams,
  response: { 200: one },
};
export const leaveSchema = {
  tags: ['challenges'],
  summary: 'Ayrıl',
  security: bearer,
  params: codeParams,
  response: { 200: one },
};
export const getChallengeSchema = {
  tags: ['challenges'],
  summary: 'Challenge detayı',
  security: bearer,
  params: codeParams,
  response: { 200: one },
};
export const participantsSchema = {
  tags: ['challenges'],
  summary: 'Katılımcılar (ilerlemeye göre; rızasızlar anonim, kimlik dönmez)',
  security: bearer,
  params: codeParams,
  response: {
    200: envelope({
      type: 'object',
      properties: {
        total: { type: 'integer' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              rank: { type: 'integer' },
              isMe: { type: 'boolean' },
              displayName: nstr,
              avatarUrl: nstr,
              progress: { type: 'integer' },
              target: { type: 'integer' },
              status: { type: 'string' },
              completedAt: nstr,
            },
          },
        },
      },
    }),
  },
};
