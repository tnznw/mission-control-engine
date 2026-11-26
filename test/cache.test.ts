// A session's prompt cache (src/cache.ts): read from the transcript, priced, and the warning before
// the first message after it closed. Every test works in a fresh temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cacheCosts, cacheState, cacheWarning } from '../src/cache.ts';
import { updateFor } from '../src/live.ts';

const T0 = 1_800_000_000; // epoch seconds
const iso = (s: number) => new Date(s * 1000).toISOString();
const reply = (at: number, usage: object, extra: object = {}) => JSON.stringify({
  type: 'assistant', timestamp: iso(at), message: { model: 'claude-opus-5-5', usage }, ...extra,
}) + '\n';
const home = () => realpathSync(mkdtempSync(join(tmpdir(), 'mc-cache-')));

test('cache: the last response says when, for how long and how much; subagents and older lines do not count', () => {
  const dir = home();
  const t = join(dir, 's.jsonl');
  writeFileSync(t,
    '{"type":"user","message":{"content":"go"}}\n'
    + reply(T0, { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 30_000, cache_creation: { ephemeral_1h_input_tokens: 30_000, ephemeral_5m_input_tokens: 0 } })
    + reply(T0 + 50, { input_tokens: 4, cache_read_input_tokens: 551_002, cache_creation_input_tokens: 160, cache_creation: { ephemeral_1h_input_tokens: 160, ephemeral_5m_input_tokens: 0 } })
    + reply(T0 + 60, { input_tokens: 1, cache_read_input_tokens: 9, cache_creation_input_tokens: 0 }, { isSidechain: true })
    + '{"type":"user","message":{"content":"thanks"}}\n');
  assert.deepEqual(cacheState(t), { at: T0 + 50, ttl: 3600, tokens: 551_166, model: 'claude-opus-5-5' });

  // Only reads since the last write: the lifetime is the one that write had. The 5-minute kind too.
  writeFileSync(t, reply(T0, { input_tokens: 1, cache_creation_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 0 } })
    + reply(T0 + 100, { input_tokens: 1, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }));
  assert.deepEqual(cacheState(t), { at: T0 + 100, ttl: 300, tokens: 40_001, model: 'claude-opus-5-5' });

  assert.equal(cacheState(join(dir, 'none.jsonl')), null);
  assert.equal(cacheState(undefined), null);
});

test('cache: what the next message costs, warm or closed (Opus 5.5, hour-long cache)', () => {
  const { warm, cold } = cacheCosts({ at: 0, ttl: 3600, tokens: 551_000, model: 'claude-opus-5-5' });
  assert.equal(warm!.toFixed(2), '0.11');
  assert.equal(cold!.toFixed(2), '4.41');
  assert.equal(cacheCosts({ at: 0, ttl: 300, tokens: 100_000, model: 'claude-opus-5-5' }).cold!.toFixed(2), '0.50'); // 1.25x input
  assert.deepEqual(cacheCosts({ at: 0, ttl: 300, tokens: 1, model: 'no-such-model' }), { warm: null, cold: null });
});

test('cache warning: held back once after the cache closed; the next send within 10 minutes goes through', () => {
  const dir = join(home(), 'cache');
  const c = { at: T0, ttl: 3600, tokens: 551_000, model: 'claude-opus-5-5' };
  assert.equal(cacheWarning(c, 's1', T0 + 3599, dir), null, 'still warm');
  assert.equal(cacheWarning({ ...c, tokens: 19_000 }, 's1', T0 + 7200, dir), null, 'small context: not worth a warning');
  assert.equal(cacheWarning(null, 's1', T0 + 7200, dir), null);

  const out = JSON.parse(cacheWarning(c, 's1', T0 + 3600 + 14 * 60, dir)!);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /closed 14 minutes ago/);
  assert.match(out.reason, /about 551k tokens/);
  assert.match(out.reason, /\$4\.41 at API prices, instead of \$0\.11/);
  assert.match(out.reason, /Send it again to go ahead/);

  assert.equal(cacheWarning(c, 's1', T0 + 3600 + 15 * 60, dir), null, 'sent again: through');
  assert.equal(existsSync(join(dir, 's1')), false, 'and the marker is gone');
  assert.ok(cacheWarning(c, 's1', T0 + 3600 + 16 * 60, dir), 'a later send after that is warned again');
  assert.ok(cacheWarning(c, 's1', T0 + 3600 + 30 * 60, dir), 'a send again over 10 minutes later is warned again');
  assert.ok(cacheWarning(c, 's2', T0 + 3600 + 30 * 60, dir), 'each session on its own');
});

test('live: a waiting session\'s update carries its cache; a working one does not', () => {
  const t = join(home(), 's.jsonl');
  writeFileSync(t, reply(T0, { input_tokens: 4, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } }));
  const w = updateFor({ hook_event_name: 'Stop', session_id: 's1', cwd: '/w', transcript_path: t, last_assistant_message: 'Done?' }, 'p')!;
  assert.deepEqual(w.cache, { at: T0, ttl: 300, tokens: 100_004, model: 'claude-opus-5-5' });
  assert.equal(updateFor({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/w', transcript_path: t }, 'p')!.cache, undefined);
});
