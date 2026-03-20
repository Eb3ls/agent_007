// ============================================================
// src/llm/llm-client.ts — LLM HTTP client (T21)
//
// Wraps OpenRouter (OpenAI-compatible) /v1/chat/completions.
// - complete(messages, maxTokens): Promise<string | null>
// - Rate limiting: minCallIntervalMs between calls
// - Timeout: 10 000 ms
// - Returns null on any failure (caller falls back to BFS)
// - Hard-cap: truncates message content to TOTAL_INPUT_BUDGET_TOKENS * 3.5
//   chars total before sending (safety net beyond llm-memory.ts dropping).
// ============================================================

import type { LlmConfig } from '../types.js';
import { createLogger } from '../logging/logger.js';
import { TOTAL_INPUT_BUDGET_TOKENS } from './llm-memory.js';

const logger = createLogger('llm-client');

const DEFAULT_TIMEOUT_MS = 10_000;

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class LlmClient {
  private readonly cfg: LlmConfig;
  private lastCallAt = 0;

  constructor(cfg: LlmConfig) {
    this.cfg = cfg;
  }

  // -----------------------------------------------------------------------
  // complete(messages, maxTokens): calls the LLM and returns the text content.
  // Returns null on timeout, network error, or non-2xx response.
  // -----------------------------------------------------------------------
  async complete(messages: LlmMessage[], maxTokens: number): Promise<string | null> {
    await this._rateLimit();

    const startMs = Date.now();
    let responseText: string | null = null;
    let tokensUsed = 0;

    try {
      const body = JSON.stringify({
        model:      this.cfg.model,
        messages:   this._enforceCharBudget(messages),
        max_tokens: maxTokens,
      });

      const response = await Promise.race([
        fetch(this.cfg.apiUrl, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${this.cfg.apiToken}`,
          },
          body,
        }),
        this._timeout(),
      ]);

      if (response === null) {
        logger.warn({ kind: 'llm_fallback', reason: 'timeout' });
        return null;
      }

      if (!response.ok) {
        logger.warn({ kind: 'llm_fallback', reason: `http_${response.status}` });
        return null;
      }

      const json = await response.json() as OpenRouterResponse;
      responseText = json.choices?.[0]?.message?.content ?? null;
      tokensUsed   = json.usage?.total_tokens ?? 0;

      if (responseText === null) {
        logger.warn({ kind: 'llm_fallback', reason: 'empty_response' });
        return null;
      }
    } catch (err) {
      logger.warn({ kind: 'llm_fallback', reason: String(err) });
      return null;
    } finally {
      this.lastCallAt = Date.now();
      const latencyMs = Date.now() - startMs;
      logger.info({ kind: 'llm_call', latencyMs, tokensUsed });
    }

    return responseText;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Hard safety cap: if the total character count of all message contents
   * exceeds TOTAL_INPUT_BUDGET_TOKENS * 3.5, trim content from the last
   * message until it fits.  This is a last-resort guard; llm-memory.ts's
   * progressive tier dropping should prevent reaching this limit.
   */
  private _enforceCharBudget(messages: LlmMessage[]): LlmMessage[] {
    const maxChars = Math.floor(TOTAL_INPUT_BUDGET_TOKENS * 3.5);
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    if (totalChars <= maxChars) return messages;

    logger.warn({
      kind: 'llm_fallback',
      reason: `char_budget_cap totalChars=${totalChars} maxChars=${maxChars}`,
    });

    const result = messages.map(m => ({ ...m }));
    let remaining = totalChars - maxChars;
    for (let i = result.length - 1; i >= 0 && remaining > 0; i--) {
      const trimBy = Math.min(remaining, result[i].content.length);
      result[i] = {
        ...result[i],
        content: result[i].content.slice(0, result[i].content.length - trimBy),
      };
      remaining -= trimBy;
    }
    return result;
  }

  private async _rateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastCallAt;
    const wait    = this.cfg.minCallIntervalMs - elapsed;
    if (wait > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, wait));
    }
  }

  /** Resolves to null after DEFAULT_TIMEOUT_MS. */
  private _timeout(): Promise<null> {
    return new Promise<null>(resolve =>
      setTimeout(() => resolve(null), DEFAULT_TIMEOUT_MS).unref(),
    );
  }
}

// -----------------------------------------------------------------------
// OpenRouter response shape (subset)
// -----------------------------------------------------------------------

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  usage?: {
    total_tokens?: number;
  };
}
