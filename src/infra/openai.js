import OpenAI from 'openai';
import { AppError } from '../shared/errors.js';
import { createBreaker } from './breaker.js';

/**
 * OpenAI istemcileri (Chat Completions): sohbet akışı + fotoğraf analizi (görüntü + JSON Schema).
 * Hatalar SDK'nın tipli sınıflarıyla sınıflandırılır.
 */

/** @returns 'aborted' | 'timeout' | 'connection' | 'rate_limited' | 'overloaded' | 'permanent' */
export function classifyOpenAiError(err) {
  if (err instanceof OpenAI.APIUserAbortError) return 'aborted';
  if (err instanceof OpenAI.APIConnectionTimeoutError) return 'timeout';
  if (err instanceof OpenAI.APIConnectionError) return 'connection';
  if (err instanceof OpenAI.RateLimitError) return 'rate_limited';
  if (err instanceof OpenAI.InternalServerError) return 'overloaded';
  if (err instanceof OpenAI.APIError && Number(err.status) >= 500) return 'overloaded';
  return 'permanent';
}

const TRANSIENT = new Set(['timeout', 'connection', 'rate_limited', 'overloaded']);

/**
 * OpenAI kullanımı → ortak biçim (ai_usage_daily, maliyet). OpenAI'de `prompt_tokens`
 * önbellekten okunanları da içerir; önbelleksiz girdi = prompt − cached.
 */
export function normalizeOpenAiUsage(usage) {
  if (!usage) return {};
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input_tokens: Math.max(0, (usage.prompt_tokens ?? 0) - cached),
    output_tokens: usage.completion_tokens ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

/**
 * @param config config.chatAi
 * @param deps.clientImpl testte sahte istemci (`chat.completions.create`)
 */
export function createChatClient(config, { logger, clientImpl, now = Date.now } = {}) {
  const client =
    clientImpl ?? (config.enabled ? new OpenAI({ apiKey: config.apiKey, maxRetries: 2 }) : null);
  const breaker = createBreaker({
    name: 'chat',
    isTransient: (err) => TRANSIENT.has(classifyOpenAiError(err)),
    now,
    logger,
  });

  function params(messages, { maxTokens, stream }) {
    return {
      model: config.model,
      messages,
      max_completion_tokens: maxTokens ?? config.maxOutputTokens,
      ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
  }

  return {
    enabled: Boolean(client),
    model: config.model,
    config,

    guard() {
      if (!client) throw new AppError('UNAVAILABLE', { details: { reason: 'chat_disabled' } });
      breaker.guard();
    },

    /**
     * Akış: async üreteç; her metin parçası `{ text }`, sonda `{ final: {text, finishReason,
     * refusal, usage, model} }`. İptal `signal` ile (istemci bağlantıyı kopardığında).
     */
    async *stream(messages, { signal, timeoutMs } = {}) {
      this.guard();
      const final = {
        text: '',
        finishReason: null,
        refusal: null,
        usage: null,
        model: config.model,
      };
      try {
        const stream = await client.chat.completions.create(params(messages, { stream: true }), {
          ...(signal ? { signal } : {}),
          ...(Number.isFinite(timeoutMs) ? { timeout: timeoutMs } : {}),
        });
        for await (const chunk of stream) {
          const choice = chunk.choices?.[0];
          const text = choice?.delta?.content;
          if (choice?.delta?.refusal) final.refusal = (final.refusal ?? '') + choice.delta.refusal;
          if (choice?.finish_reason) final.finishReason = choice.finish_reason;
          if (chunk.usage) final.usage = chunk.usage;
          if (chunk.model) final.model = chunk.model;
          if (text) {
            final.text += text;
            yield { text };
          }
        }
        breaker.success();
      } catch (err) {
        breaker.failure(err);
        throw err;
      }
      yield { final };
    },

    /** Tek çağrı (özet üretimi). */
    async complete(messages, { maxTokens, timeoutMs } = {}) {
      this.guard();
      try {
        const res = await client.chat.completions.create(params(messages, { maxTokens }), {
          ...(Number.isFinite(timeoutMs) ? { timeout: timeoutMs } : {}),
        });
        breaker.success();
        const choice = res.choices?.[0];
        return {
          text: choice?.message?.content ?? '',
          refusal: choice?.message?.refusal ?? null,
          finishReason: choice?.finish_reason ?? null,
          usage: res.usage,
          model: res.model,
        };
      } catch (err) {
        breaker.failure(err);
        throw err;
      }
    },
  };
}

/**
 * Fotoğraf analizi için OpenAI istemcisi (görüntü + yapılandırılmış JSON çıktı).
 * @param config config.ai (`apiKey`, `visionModel`, …)
 * @param deps.clientImpl testte sahte istemci (`chat.completions.create`)
 */
export function createVisionClient(config, { logger, clientImpl, now = Date.now } = {}) {
  const client =
    clientImpl ?? (config.enabled ? new OpenAI({ apiKey: config.apiKey, maxRetries: 2 }) : null);
  const breaker = createBreaker({
    name: 'vision',
    isTransient: (err) => TRANSIENT.has(classifyOpenAiError(err)),
    now,
    logger,
  });

  return {
    enabled: Boolean(client),
    model: config.visionModel,
    config,

    guard() {
      if (!client) throw new AppError('UNAVAILABLE', { details: { reason: 'ai_disabled' } });
      breaker.guard();
    },

    /**
     * Tek çağrı. `params`: `{ model?, messages, max_tokens?, response_format? }`.
     * Dönüş: `{ text, refusal, finishReason, usage (ortak biçim), model }`.
     */
    async create(params, { timeoutMs } = {}) {
      this.guard();
      try {
        const res = await client.chat.completions.create(
          {
            model: params.model ?? config.visionModel,
            messages: params.messages,
            max_completion_tokens: params.max_tokens ?? 8000,
            ...(params.response_format ? { response_format: params.response_format } : {}),
            ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
          },
          {
            ...(Number.isFinite(timeoutMs) ? { timeout: timeoutMs } : {}),
          },
        );
        breaker.success();
        const choice = res.choices?.[0];
        return {
          text: choice?.message?.content ?? '',
          refusal: choice?.message?.refusal ?? null,
          finishReason: choice?.finish_reason ?? null,
          usage: normalizeOpenAiUsage(res.usage),
          model: res.model ?? config.visionModel,
        };
      } catch (err) {
        breaker.failure(err);
        throw err;
      }
    },
  };
}
