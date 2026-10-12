import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { classifyOpenAiError, createVisionClient, reasoningParam } from '../../src/infra/openai.js';
import { analysisRequest } from '../../src/modules/ai/photo-analysis.service.js';

const sdkError = (Class) => Object.create(Class.prototype);

describe('createVisionClient', () => {
  it('anahtar yoksa 503 ai_disabled', async () => {
    const ai = createVisionClient({ enabled: false, visionModel: 'gpt-4o' });
    expect(ai.enabled).toBe(false);
    await expect(ai.create({ messages: [] })).rejects.toMatchObject({
      details: { reason: 'ai_disabled' },
    });
  });

  it('create: response_format ve gpt-4o için reasoning yok', async () => {
    const seen = [];
    const impl = {
      chat: {
        completions: {
          create: async (p) => {
            seen.push(p);
            return {
              choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
              model: 'gpt-4o',
            };
          },
        },
      },
    };
    const ai = createVisionClient(
      { enabled: true, visionModel: 'gpt-4o', reasoningEffort: 'high' },
      { clientImpl: impl },
    );
    const out = await ai.create({
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      response_format: { type: 'json_object' },
    });
    expect(seen[0]).toMatchObject({
      model: 'gpt-4o',
      max_completion_tokens: 100,
      response_format: { type: 'json_object' },
    });
    expect(seen[0].reasoning_effort).toBeUndefined();
    expect(out).toMatchObject({ text: '{"ok":true}', finishReason: 'stop', model: 'gpt-4o' });
  });

  it('devre kesici: 5 geçici hatadan sonra 30 sn hızlı başarısızlık; kalıcı hata saymaz', async () => {
    let t = 0;
    let calls = 0;
    let error = sdkError(OpenAI.InternalServerError);
    const impl = {
      chat: {
        completions: {
          create: async () => {
            calls += 1;
            throw error;
          },
        },
      },
    };
    const ai = createVisionClient(
      { enabled: true, visionModel: 'gpt-4o' },
      { clientImpl: impl, now: () => t },
    );
    for (let i = 0; i < 5; i += 1) await expect(ai.create({})).rejects.toBe(error);
    await expect(ai.create({})).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      details: { reason: 'vision_circuit_open' },
    });
    expect(calls).toBe(5);
    t = 31_000;
    error = sdkError(OpenAI.BadRequestError);
    for (let i = 0; i < 6; i += 1) await expect(ai.create({})).rejects.toBe(error);
    expect(calls).toBe(11);
  });

  it('hata sınıflandırması tipli SDK sınıflarıyla', () => {
    expect(classifyOpenAiError(sdkError(OpenAI.RateLimitError))).toBe('rate_limited');
    expect(classifyOpenAiError(sdkError(OpenAI.APIConnectionTimeoutError))).toBe('timeout');
    expect(classifyOpenAiError(sdkError(OpenAI.APIConnectionError))).toBe('connection');
    expect(classifyOpenAiError(sdkError(OpenAI.InternalServerError))).toBe('overloaded');
    expect(classifyOpenAiError(sdkError(OpenAI.APIUserAbortError))).toBe('aborted');
    expect(classifyOpenAiError(sdkError(OpenAI.BadRequestError))).toBe('permanent');
  });
});

describe('analysisRequest', () => {
  it('görüntü high detail + json_schema ile gider', () => {
    const req = analysisRequest(Buffer.from('webp'), 'tr', { visionModel: 'gpt-4o' });
    expect(req.model).toBe('gpt-4o');
    expect(req.response_format).toMatchObject({ type: 'json_schema' });
    const image = req.messages[1].content.find((c) => c.type === 'image_url');
    expect(image.image_url.detail).toBe('high');
    expect(image.image_url.url).toMatch(/^data:image\/webp;base64,/);
  });
});

describe('reasoningParam', () => {
  it('yalnızca o-serisi / gpt-5 modellerine eklenir', () => {
    expect(reasoningParam('high', 'gpt-4o')).toEqual({});
    expect(reasoningParam('high', 'o3-mini')).toEqual({ reasoning_effort: 'high' });
    expect(reasoningParam(null, 'o1')).toEqual({});
  });
});
