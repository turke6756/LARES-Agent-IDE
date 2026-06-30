// Context-Overhead Analyzer — token estimator (plan §2.1 / §4, decision D-1).
//
// Pure + Electron-free + side-effect-free so it unit-tests under the system-Node
// runner. The cl100k encoder (js-tiktoken) is built OUTSIDE this module and
// injected as `opts.encoder` — the module itself has no dependency on
// js-tiktoken, so tests inject a deterministic stub and production injects the
// real encoder once per scan (built in the IPC handler).
//
// Default method: `tiktoken-approx` when an encoder is supplied; otherwise the
// `chars-heuristic` fallback (ceil(chars/3.5)). Both stamp `approximate:true`.
// The exact (`anthropic-count-tokens`) path is Phase-3 and STRUCTURED (R2): the
// `TokenClient` mirrors POST /v1/messages/count_tokens so MCP tool schemas are
// counted as the structured `tools` array, never as flat text.

import type { TokenCountMethod, TokenEstimate } from '../../shared/types';

// (R2) The exact (Phase-3) client is STRUCTURED, not text-only: Anthropic counts
// the structured `tools` array (full input_schema verbatim), so a flat
// countText() can never give exact MCP/tool numbers.
export interface AnthropicToolDef {
  name: string;
  description?: string;
  input_schema: unknown;
}
export interface CountMessageInput {
  system?: string;
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools?: AnthropicToolDef[];
}
export interface TokenClient {
  countText(text: string): Promise<number>;
  countTools(tools: AnthropicToolDef[]): Promise<number>;
  countMessageInput?(input: CountMessageInput): Promise<number>;
}

export interface EstimatorOptions {
  /** Injected cl100k counter (js-tiktoken); omit ⇒ chars-heuristic fallback. */
  encoder?: (text: string) => number;
  /** Omit ⇒ exact path is inert (Phase-3 only). */
  client?: TokenClient;
}

const CHARS_PER_TOKEN = 3.5;

/** Fast, dependency-free FNV-1a (32-bit) content hash for memoization. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    // h *= 16777619, kept in 32-bit unsigned range via Math.imul.
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export class TokenEstimator {
  private readonly encoder?: (text: string) => number;
  private readonly client?: TokenClient;
  private readonly memo = new Map<string, TokenEstimate>();

  constructor(opts: EstimatorOptions = {}) {
    this.encoder = opts.encoder;
    this.client = opts.client;
  }

  /** Active default (sync) method. */
  get method(): TokenCountMethod {
    return this.encoder ? 'tiktoken-approx' : 'chars-heuristic';
  }

  /** text → TokenEstimate (sync). Memoized by content hash so identical
   *  shared-ancestor files are estimated once. Never throws: if the injected
   *  encoder throws for a given input, falls back to chars-heuristic for THAT
   *  input and stamps the method accordingly. */
  estimate(text: string): TokenEstimate {
    const key = fnv1a(text);
    const cached = this.memo.get(key);
    if (cached) return cached;

    const bytes = Buffer.byteLength(text, 'utf8');
    const chars = text.length;

    let est: TokenEstimate;
    if (this.encoder) {
      try {
        est = {
          tokens: this.encoder(text),
          bytes,
          chars,
          method: 'tiktoken-approx',
          approximate: true,
        };
      } catch {
        est = this.charsEstimate(text, bytes, chars);
      }
    } else {
      est = this.charsEstimate(text, bytes, chars);
    }
    this.memo.set(key, est);
    return est;
  }

  private charsEstimate(_text: string, bytes: number, chars: number): TokenEstimate {
    return {
      tokens: Math.ceil(chars / CHARS_PER_TOKEN),
      bytes,
      chars,
      method: 'chars-heuristic',
      approximate: true,
    };
  }

  /** Phase-3 exact tool count via client.countTools([tool]). Falls back to the
   *  sync estimate of the serialized tool when no client is wired. */
  async estimateToolExact(tool: AnthropicToolDef): Promise<TokenEstimate> {
    const serialized = JSON.stringify({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    });
    if (!this.client) return this.estimate(serialized);
    try {
      const tokens = await this.client.countTools([tool]);
      return {
        tokens,
        bytes: Buffer.byteLength(serialized, 'utf8'),
        chars: serialized.length,
        method: 'anthropic-count-tokens',
        approximate: false,
      };
    } catch {
      return this.estimate(serialized);
    }
  }

  /** Phase-3 exact text count via client.countText(text). Falls back to the sync
   *  estimate when no client is wired. */
  async estimateTextExact(text: string): Promise<TokenEstimate> {
    if (!this.client) return this.estimate(text);
    try {
      const tokens = await this.client.countText(text);
      return {
        tokens,
        bytes: Buffer.byteLength(text, 'utf8'),
        chars: text.length,
        method: 'anthropic-count-tokens',
        approximate: false,
      };
    } catch {
      return this.estimate(text);
    }
  }
}

/** A zero-valued estimate stamped with the estimator's active method — used for
 *  strict-excluded MCP servers and other "counted 0 for this agent" rows so the
 *  shape is uniform without fabricating a count. */
export function zeroEstimate(method: TokenCountMethod): TokenEstimate {
  return { tokens: 0, bytes: 0, chars: 0, method, approximate: method !== 'anthropic-count-tokens' };
}

/** Sum a list of estimates into one, preserving the dominant method. The summed
 *  estimate is `approximate` unless every input was exact. */
export function sumEstimates(estimates: TokenEstimate[], fallbackMethod: TokenCountMethod): TokenEstimate {
  if (estimates.length === 0) return zeroEstimate(fallbackMethod);
  let tokens = 0;
  let bytes = 0;
  let chars = 0;
  let allExact = true;
  for (const e of estimates) {
    tokens += e.tokens;
    bytes += e.bytes;
    chars += e.chars;
    if (e.method !== 'anthropic-count-tokens') allExact = false;
  }
  return {
    tokens,
    bytes,
    chars,
    method: allExact ? 'anthropic-count-tokens' : fallbackMethod,
    approximate: !allExact,
  };
}
