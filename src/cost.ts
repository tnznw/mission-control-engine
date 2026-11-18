// AI usage priced in US dollars at API list prices. Dollars are computed at query time from raw
// token counts and never stored (same rule as durations): a price change recomputes every report.
// This is what Claude Code's tokens would cost on the API, not what Tenzin is billed (a Max seat).
// Copied into journal's hub as server/src/hub/cost.ts: change both copies together.

/** One Claude response, from a Claude Code transcript. The same response is written to the
 *  transcript several times, so the API message id is the key and repeats are ignored. */
export interface UsageRow {
  id: string; // API message id (msg_…)
  session: string; // Claude Code session; a subagent's rows carry its parent's session
  project: string; // the session's project at that moment, by the same events as time
  model: string;
  ts: number; // epoch seconds
  input: number; // uncached input tokens
  output: number; // includes thinking
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  webSearch: number; // web search requests
  fast: boolean; // fast mode: premium price
}

/** US$ per million tokens. A cache write costs 1.25x input (5-minute) or 2x input (1-hour). */
interface Rates { input: number; output: number; cacheRead: number }
interface Price extends Rates { long?: Rates & { over: number } }

// From the claude-api skill's model table (cached 2026-10-06). Checked 2026-11-10 against the
// running cost Claude Code writes into its own transcripts ("cost-state"): identical to the cent
// for Opus 5.5, Opus 5, Haiku 5.5 and Haiku 4.5, cache writes and web search included, in every
// session since tracking began. Haiku 5.5 cache reads follow the usual 0.1x input; none seen yet.
// A model missing here is reported as unpriced tokens, never guessed.
export const PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  // Haiku 5.5: prompts over 100K tokens cost 5x.
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, long: { over: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 } },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
};
export const WEB_SEARCH_USD = 0.01; // $10 per 1,000 searches
export const FAST = 2; // fast mode: Opus 5.5 $8 / $40, Opus 5 $10 / $50

/** "claude-haiku-4-5-20251001" and "claude-opus-5[1m]" price as their base model. */
export function modelKey(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
}

/** US$ for one response at API prices, or null for a model with no price. */
export function costOf(r: UsageRow): number | null {
  const p = PRICES[modelKey(r.model)];
  if (!p) return null;
  const prompt = r.input + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;
  const t: Rates = p.long && prompt > p.long.over ? p.long : p;
  const tokens = r.input * t.input + r.output * t.output + r.cacheRead * t.cacheRead + r.cacheWrite5m * t.input * 1.25 + r.cacheWrite1h * t.input * 2;
  return ((r.fast ? FAST : 1) * tokens) / 1e6 + r.webSearch * WEB_SEARCH_USD;
}

export const tokensOf = (r: UsageRow): number => r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;
