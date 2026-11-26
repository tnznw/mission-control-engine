// A Claude Code session's prompt cache (2026-11-24). Each request reads the conversation so far
// from Anthropic's prompt cache, which lasts 5 minutes or an hour after the last request (Claude
// Code records which, per response). A message sent after it closes writes the whole context again
// instead of reading it: for a long session about 40 times the cost (551k tokens: $4.41 instead of
// $0.11 on Opus 5.5 with the hour-long cache). Read locally from the session's transcript.
import { closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { costOf, type UsageRow } from './cost.ts';

/** When the last response was (epoch s), how long its cache lives (s), how much context it reads. */
export interface CacheState { at: number; ttl: number; tokens: number; model: string }

/** The cache as the session's last response left it, from the transcript's last megabyte; null when
 *  there is no response there yet. Subagents' responses (sidechains) keep caches of their own. */
export function cacheState(transcript: string | undefined): CacheState | null {
  if (!transcript) return null;
  let text = '';
  try {
    const size = statSync(transcript).size;
    const start = Math.max(0, size - 1024 * 1024);
    const fd = openSync(transcript, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  let last: CacheState | null = null;
  let ttl = 0; // of the newest cache write seen: reads keep the lifetime the entry was written with
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let e: { type?: string; isSidechain?: boolean; timestamp?: string; message?: { model?: string; usage?: Record<string, any> } };
    try { e = JSON.parse(line); } catch { continue; } // the first line, cut
    const u = e.message?.usage, model = e.message?.model;
    if (e.type !== 'assistant' || e.isSidechain || !u || !model || model === '<synthetic>') continue;
    const c = u.cache_creation ?? {};
    if ((c.ephemeral_1h_input_tokens ?? 0) > 0) ttl = 3600;
    else if ((c.ephemeral_5m_input_tokens ?? 0) > 0 || (!u.cache_creation && (u.cache_creation_input_tokens ?? 0) > 0)) ttl = 300;
    const at = Math.floor(Date.parse(e.timestamp ?? '') / 1000);
    if (!Number.isFinite(at)) continue;
    last = { at, ttl: 0, tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), model };
  }
  return last ? { ...last, ttl: ttl || 300 } : null; // no write seen: assume the short one, to warn early
}

/** US$ at API prices for the next message's context: read from a warm cache, or written again. */
export function cacheCosts(c: CacheState): { warm: number | null; cold: number | null } {
  const row = (o: Partial<UsageRow>): UsageRow => ({
    id: '', session: '', project: '', model: c.model, ts: 0, input: 0, output: 0,
    cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, fast: false, ...o,
  });
  return { warm: costOf(row({ cacheRead: c.tokens })), cold: costOf(row(c.ttl >= 3600 ? { cacheWrite1h: c.tokens } : { cacheWrite5m: c.tokens })) };
}

const money = (n: number | null) => (n === null ? 'an unknown amount' : n < 0.01 ? 'under a cent' : '$' + n.toFixed(2));
const minutes = (s: number) => (s < 90 ? 'a minute' : s < 5400 ? Math.round(s / 60) + ' minutes' : Math.round(s / 3600) + ' hours');

export const WARN_OVER = 20_000; // tokens: below this a closed cache costs little either way
const ASK_AGAIN = 600; // s: a second send within 10 minutes of the warning goes through

/** The UserPromptSubmit hook's output when the cache has closed: hold the message back once, saying
 *  what it will cost; the same session's next send within 10 minutes goes through. Null to let it
 *  through. `dir` keeps one small marker per session (~/.mission-control/cache). */
export function cacheWarning(c: CacheState | null, session: string, now: number, dir: string): string | null {
  if (!c || now < c.at + c.ttl || c.tokens < WARN_OVER) return null;
  const marker = join(dir, session.replace(/[^\w-]/g, '_'));
  try {
    const [at, warned] = readFileSync(marker, 'utf8').split(':').map(Number);
    if (at === c.at && now - warned < ASK_AGAIN) {
      rmSync(marker, { force: true });
      return null; // warned already: this is the send again
    }
  } catch { /* not warned yet */ }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(marker, `${c.at}:${now}`);
  } catch {
    return null; // no marker, no way to let the second send through: never block then
  }
  const { warm, cold } = cacheCosts(c);
  const k = Math.round(c.tokens / 1000);
  return JSON.stringify({
    decision: 'block',
    reason: `Mission Control: this session's cache closed ${minutes(now - c.at - c.ttl)} ago. Sending now writes about ${k}k tokens of context again: ${money(cold)} at API prices, instead of ${money(warm)} with the cache warm. Send it again to go ahead, or start a new conversation with a short summary to send less.`,
  });
}
