import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { attribute, collect, parseUsage, readNewLines, withLock, type RawUsage } from '../src/usage.ts';
import { costOf, modelKey, tokensOf, type UsageRow } from '../src/cost.ts';
import type { ActivityEvent } from '../src/time.ts';

const T0 = Date.parse('2026-11-10T00:00:00Z') / 1000;
const iso = (ts: number) => new Date(ts * 1000).toISOString();

/** A transcript line the way Claude Code writes it. */
function entry(id: string, ts: number, usage: Record<string, unknown>, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant', sessionId: 's1', timestamp: iso(ts), cwd: '/p/a',
    message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 300 }, server_tool_use: { web_search_requests: 0 }, speed: 'standard', ...usage } },
    ...over,
  });
}

test('parse: one row per message id, errors and other entries skipped, cache writes split', () => {
  const text = [
    entry('m1', T0, {}),
    entry('m1', T0, {}), // the same response, written again
    JSON.stringify({ type: 'user', message: { content: 'hi', usage: 1 } }),
    entry('m2', T0 + 60, { speed: 'fast', server_tool_use: { web_search_requests: 3 } }),
    JSON.stringify({ type: 'assistant', sessionId: 's1', timestamp: iso(T0), message: { id: 'm3', model: '<synthetic>', usage: { input_tokens: 0 } } }),
    entry('m4', T0, { cache_creation_input_tokens: 700, cache_creation: undefined }), // older transcripts: total only
    entry('m5', T0 - 3600, {}), // before tracking began
    '{"type":"assistant", torn',
  ].join('\n');
  const rows = parseUsage(text, T0 - 60);
  assert.deepEqual(rows.map((r) => r.id), ['m1', 'm2', 'm4']);
  assert.deepEqual(rows[0], { id: 'm1', session: 's1', model: 'claude-opus-5-5', ts: T0, cwd: '/p/a', input: 2, output: 100, cacheRead: 5000, cacheWrite5m: 0, cacheWrite1h: 300, webSearch: 0, fast: false });
  assert.equal(rows[1].fast, true);
  assert.equal(rows[1].webSearch, 3);
  assert.equal(rows[2].cacheWrite5m, 700);
});

test('prices: match what Claude Code itself recorded, to the cent', () => {
  const row = (over: Partial<UsageRow>): UsageRow => ({ id: 'x', session: 's', project: 'p', model: 'claude-opus-5-5', ts: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, fast: false, ...over });
  // A real session's totals from its transcript's cost-state entry (Opus 5.5, $8.5273422).
  const opus = row({ input: 2399, output: 87304, cacheRead: 17102936, cacheWrite5m: 491, cacheWrite1h: 418578 });
  assert.ok(Math.abs(costOf(opus)! - 8.5273422) < 1e-9, String(costOf(opus)));
  // Haiku 5.5 subagents, 8 web searches ($0.0971449 in total; each request under 100K tokens).
  const haiku = [row({ model: 'claude-haiku-5-5', input: 60000, output: 5000, webSearch: 5 }), row({ model: 'claude-haiku-5-5', input: 63349, output: 4620, webSearch: 3 })];
  assert.ok(Math.abs(costOf(haiku[0])! + costOf(haiku[1])! - 0.0971449) < 1e-9);
  // Over 100K prompt tokens Haiku 5.5 costs 5x; fast mode doubles Opus.
  assert.ok(Math.abs(costOf(row({ model: 'claude-haiku-5-5', input: 200_000 }))! - 0.1) < 1e-9);
  assert.ok(Math.abs(costOf(row({ output: 1_000_000, fast: true }))! - 40) < 1e-9);
  // Fable 5.2 at its list price ($8 / $40, cache reads $0.20), not left unpriced.
  assert.ok(Math.abs(costOf(row({ model: 'claude-fable-5-2', input: 1_000_000, output: 100_000, cacheRead: 1_000_000 }))! - 12.2) < 1e-9);
  assert.equal(modelKey('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(modelKey('claude-opus-5[1m]'), 'claude-opus-5');
  assert.equal(costOf(row({ model: 'claude-unknown-9', input: 5 })), null); // never guessed
  assert.equal(tokensOf(opus), 2399 + 87304 + 17102936 + 491 + 418578);
});

test('read: only whole lines, and the next read starts where the last one stopped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-usage-'));
  const f = join(dir, 't.jsonl');
  writeFileSync(f, 'one\ntwo\nthr');
  const seen: string[] = [];
  const at = readNewLines(f, 0, (t) => seen.push(t));
  assert.deepEqual(seen, ['one\ntwo']);
  assert.equal(at, 8);
  appendFileSync(f, 'ee ✓\n');
  const at2 = readNewLines(f, at, (t) => seen.push(t));
  assert.deepEqual(seen, ['one\ntwo', 'three ✓']);
  assert.equal(readNewLines(f, at2, (t) => seen.push(t)), at2); // nothing new
  writeFileSync(f, 'new\n'); // rewritten shorter: read again from the start
  assert.equal(readNewLines(f, at2, (t) => seen.push(t)), 4);
  assert.equal(seen.at(-1), 'new');
});

test('attribute: by the session events time uses; no events falls back to the folder', () => {
  const ev = (ts: number, project: string): ActivityEvent => ({ id: String(ts), session: 's1', project, kind: 'tick', ts, cwd: '' });
  const raw = (id: string, session: string, ts: number): RawUsage => ({ id, session, ts, cwd: '/p/' + session, model: 'm', input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, fast: false });
  const out = attribute([raw('a', 's1', 50), raw('b', 's1', 150), raw('c', 's1', 250), raw('d', 's2', 10)], [ev(100, 'cfo'), ev(200, 'seed')], (cwd) => 'from ' + cwd);
  assert.deepEqual(out.map((r) => r.project), ['from /p/s1', 'cfo', 'seed', 'from /p/s2']); // 'a' is before the session's first event
  assert.equal('cwd' in out[0], false);
});

test('attribute: each response takes the Claude account of the session event before it', () => {
  const ev = (ts: number, account?: string): ActivityEvent => ({ id: String(ts), session: 's1', project: 'p', kind: 'tick', ts, cwd: '', account });
  const raw = (id: string, session: string, ts: number): RawUsage => ({ id, session, ts, cwd: '/p', model: 'm', input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, fast: false });
  const out = attribute([raw('a', 's1', 150), raw('b', 's1', 250), raw('c', 's2', 10)], [ev(100, 'aaa'), ev(200, 'bbb')], () => 'q');
  assert.deepEqual(out.map((r) => r.account), ['aaa', 'bbb', '']);
  assert.equal(attribute([raw('d', 's1', 150)], [ev(100)], () => 'q')[0].account, '');
});

test('collect: every transcript and subagent once, then only what is new', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-tr-'));
  mkdirSync(join(root, 'proj/s1/subagents'), { recursive: true });
  writeFileSync(join(root, 'proj/s1.jsonl'), entry('m1', T0, {}) + '\n');
  writeFileSync(join(root, 'proj/s1/subagents/agent-x.jsonl'), entry('m2', T0, {}, { isSidechain: true }) + '\n');
  const old = join(root, 'proj/old.jsonl');
  writeFileSync(old, entry('m0', T0 - 86400 * 30, {}) + '\n');
  utimesSync(old, T0 - 86400 * 30, T0 - 86400 * 30); // untouched since before tracking: skipped unread
  const state = join(root, 'state.json');
  const a = collect(state, () => T0 - 60, root);
  assert.deepEqual(a.rows.map((r) => r.id).sort(), ['m1', 'm2']);
  assert.equal(a.files, 2);
  a.save();
  assert.equal(collect(state, () => 0, root).rows.length, 0);
  appendFileSync(join(root, 'proj/s1.jsonl'), entry('m3', T0 + 5, {}) + '\n' + entry('m4', T0 + 6, {}).slice(0, 40));
  const b = collect(state, () => 0, root);
  assert.deepEqual(b.rows.map((r) => r.id), ['m3']); // m4 is still being written
});

test('lock: a second run backs off while the first holds it', async () => {
  const lock = join(mkdtempSync(join(tmpdir(), 'mc-lock-')), 'usage.lock');
  const r = await withLock(lock, async () => withLock(lock, async () => 'inner'));
  assert.equal(r, 'busy');
  assert.equal(await withLock(lock, async () => 'free again'), 'free again');
});
