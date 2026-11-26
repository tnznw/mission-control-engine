import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { activity, allRunning, board, checkExtras, runningAgents, sessionFiles, streamOf, type Agent } from '../src/workers.ts';

const NOW = Math.floor(Date.now() / 1000);
const line = (id: string, ts: number, output = 1000) => JSON.stringify({ type: 'assistant', sessionId: 's1', timestamp: new Date(ts * 1000).toISOString(), message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: output } } });

test('workers: background sessions still running, per sign-in folder; a failed listing is not "none"', () => {
  const gone = spawnSync('true').pid; // a process that has just ended
  const out = JSON.stringify([
    { name: 'a-1', kind: 'background', status: 'busy', sessionId: 's1' },
    { name: 'old', kind: 'background', status: null, sessionId: 's2' },
    { name: 'tab', kind: 'interactive', status: 'idle', sessionId: 's3' },
    { name: 'orphan', kind: 'background', status: 'busy', sessionId: 's4', pid: gone }, // its daemon went away
    { name: 'me', kind: 'background', status: 'busy', sessionId: 's5', pid: process.pid },
  ]);
  let env: NodeJS.ProcessEnv = {};
  const got = runningAgents('/p/sam', (e) => { env = e; return { status: 0, stdout: out } as any; });
  assert.deepEqual(got!.map((a) => a.name), ['a-1', 'me'], 'a busy status whose process is gone is not running');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/p/sam', 'listed with that folder\'s sign-in');
  assert.equal(runningAgents('', () => ({ status: 1, stdout: '' }) as any), null);
  assert.equal(runningAgents('', () => ({ status: null, stdout: '' }) as any), null, 'timed out');
  assert.equal(runningAgents('', () => ({ status: 0, stdout: 'not json' }) as any), null);

  const lists: Record<string, Agent[] | null> = { a: [{ name: 'x', kind: 'background', sessionId: 's1' }], b: [{ name: 'x', kind: 'background', sessionId: 's1' }, { name: 'y', kind: 'background', sessionId: 's2' }, { name: 'ops', kind: 'interactive', sessionId: 'o1' }], c: null };
  const both = allRunning(['a', 'b'], (d) => lists[d])!;
  assert.deepEqual(both.running.map((a) => a.sessionId), ['s1', 's2'], 'a session listed twice counts once; an interactive one is not a worker');
  assert.deepEqual([...both.live].sort(), ['o1', 's1', 's2'], 'but it is alive, for its subagents');
  assert.equal(allRunning(['a', 'c'], (d) => lists[d]), null, 'one folder unreadable: no board at all');
});

test('workers: a session\'s transcripts wherever its worktree put them, and its last ten minutes as tokens', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-workers-'));
  mkdirSync(join(root, '-w-repo-wt1', 's1', 'subagents'), { recursive: true });
  writeFileSync(join(root, '-w-repo-wt1', 's1.jsonl'), [line('m1', NOW - 3600), line('m2', NOW - 120), line('m2', NOW - 120)].join('\n') + '\n');
  writeFileSync(join(root, '-w-repo-wt1', 's1', 'subagents', 'x.jsonl'), line('m3', NOW - 60) + '\n');
  const quiet = join(root, '-w-repo-wt1', 's1', 'subagents', 'old.jsonl');
  writeFileSync(quiet, line('m4', NOW - 60) + '\n');
  utimesSync(quiet, NOW - 3600, NOW - 3600); // untouched for an hour: skipped
  writeFileSync(join(root, '-w-repo-wt1', 's9.jsonl'), line('m9', NOW) + '\n');
  const files = sessionFiles('s1', root);
  assert.equal(files.length, 3);
  const a = activity(files, NOW);
  assert.deepEqual([a.responses10, a.last], [2, NOW - 60], 'the hour-old response and the quiet subagent are out; a repeated message counts once');
  assert.deepEqual(a.tokens10, [{ model: 'claude-opus-5-5', fast: false, input: 20, output: 2000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0 }], 'tokens, never dollars');
});

test('workers: each worker joined to its workstream by name; the queue less what a worker took', () => {
  const streams = [{ slug: 'ledger', name: 'Ledger' }, { slug: 'unified-ledger', name: 'Unified ledger', stage: 'Build', done: 3, total: 7, project: 'hub' }];
  assert.equal(streamOf('unified-ledger-18', streams)?.name, 'Unified ledger', 'the longest slug');
  assert.equal(streamOf('ledger', streams)?.name, 'Ledger');
  assert.equal(streamOf('ledgerx', streams), undefined, 'a slug is followed by a dash or nothing');
  const agents: Agent[] = [{ name: 'unified-ledger-18', kind: 'background', status: 'busy', cwd: '/w/hub', sessionId: 's1', startedAt: (NOW - 600) * 1000 }, { name: 'stray', kind: 'background', status: 'idle', cwd: '/w/other', sessionId: 's2', startedAt: (NOW - 60) * 1000 }];
  const extras = { slots: 8, streams, queue: [{ name: 'Unified ledger', slug: 'unified-ledger' }, { name: 'Unified ledger', slug: 'unified-ledger-app' }, { name: 'PDF service' }], at: NOW - 60 };
  const b = board(agents, extras, (cwd) => cwd.split('/').pop()!, NOW, () => []);
  assert.deepEqual(b.workers.map((w) => [w.name, w.workstream, w.project, w.done, w.total, w.since]), [['unified-ledger-18', 'Unified ledger', 'hub', 3, 7, NOW - 600], ['stray', undefined, 'other', undefined, undefined, NOW - 60]]);
  assert.deepEqual([b.slots, b.queue.map((q) => q.slug ?? q.name)], [8, ['unified-ledger-app', 'PDF service']], 'matched by slug, not by a name two workstreams can share');
  const old = board(agents, { ...extras, at: NOW - 2 * 86400 }, () => 'p', NOW, () => []);
  assert.deepEqual([old.slots, old.queue.length, old.workers[0].workstream], [null, 0, undefined], 'a feeder silent for a day is not shown');
});

test('workers: a feeder\'s extras are checked before they are kept', () => {
  assert.deepEqual(checkExtras({ slots: 8, streams: [{ slug: 'a', name: 'A' }], queue: [{ name: 'Q' }] }), { slots: 8, streams: [{ slug: 'a', name: 'A' }], queue: [{ name: 'Q' }] });
  assert.deepEqual(checkExtras({ queue: [{ name: 'P', planned: true }, { name: 'U', planned: false }, { name: 'K' }] }).queue, [{ name: 'P', planned: true }, { name: 'U', planned: false }, { name: 'K' }], 'planned, needs a plan, or not known');
  assert.throws(() => checkExtras({ queue: [{ name: 'U', planned: 'yes' }] }), /planned is not true or false/);
  assert.deepEqual(checkExtras({}), { slots: undefined, streams: [], queue: [] });
  const long = checkExtras({ streams: [{ slug: 's', name: 'n'.repeat(500), done: '3', total: 5000 }], queue: [{ name: 'q', stage: 'Queued' }] });
  assert.deepEqual([long.streams![0].name.length, long.streams![0].done, long.streams![0].total, long.queue], [200, undefined, 1000, [{ name: 'q' }]], 'cut to what the hub takes');
  for (const bad of [[], null, 'x', { slots: 0 }, { slots: 2.5 }, { slots: 101 }, { streams: { a: {} } }, { streams: [null] }, { streams: [{ slug: 'a' }] }, { queue: [{}] }]) {
    assert.throws(() => checkExtras(bad), /mc workers --extras/, JSON.stringify(bad));
  }
});

test('workers: an orchestrator\'s background subagents that are still running, each counted once', async () => {
  const { subagentWorkers, expandGlob } = await import('../src/workers.ts');
  const root = mkdtempSync(join(tmpdir(), 'mc-sub-'));
  const dir = join(root, 'p1', 'projects', '-w-ops', 'sess1', 'subagents');
  mkdirSync(dir, { recursive: true });
  const agent = (id: string, description: unknown, lines: object[], o: { type?: string; shape?: string; age?: number } = {}) => {
    writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify(description === null ? null : { agentType: o.type ?? 'builder', requestShape: o.shape ?? 'background', description }));
    const f = join(dir, `agent-${id}.jsonl`);
    writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    utimesSync(f, NOW - (o.age ?? 60), NOW - (o.age ?? 60));
  };
  const t = (s: number) => new Date((NOW - s) * 1000).toISOString();
  const prompt = 'p'.repeat(9000); // a real first line carries the whole prompt
  agent('a1', 'site-b3 worker (Site B)', [{ type: 'user', timestamp: t(900), cwd: '/w/ops', message: { content: prompt } }, JSON.parse(line('m-b3', NOW - 90)), { type: 'assistant', timestamp: t(60), cwd: '/w/app-wt', message: { stop_reason: 'tool_use' } }]);
  agent('a2', 'site-b2 worker (Site B)', [{ type: 'user', timestamp: t(5000), cwd: '/w/ops' }, { type: 'user', timestamp: t(100) }]); // also still at it
  agent('a3', 'relay-f worker', [{ type: 'user', timestamp: t(600) }, { type: 'assistant', timestamp: t(120), message: { stop_reason: 'end_turn' } }]); // finished
  agent('a4', 'heap-b worker', [{ type: 'user', timestamp: t(600) }], { age: 3600 }); // silent an hour
  agent('a5', 'Review the PR', [{ type: 'user', timestamp: t(60) }], { type: 'general-purpose' }); // not a worker
  agent('a6', 'docs-c worker', [{ type: 'user', timestamp: t(60) }], { shape: 'foreground' }); // not in the background
  agent('a7', null, [{ type: 'user', timestamp: t(60) }]); // an odd meta file is skipped
  agent('a8', 'ci-watch-b worker', [{ type: 'user', timestamp: t(3000) }, { type: 'assistant', timestamp: t(1800), message: { stop_reason: 'tool_use' } }], { age: 1800 }); // inside a long tool call
  agent('a9', 'stale-d worker', [{ type: 'user', timestamp: t(3000) }, { type: 'user', timestamp: t(1800) }], { age: 1800 }); // quiet, not in a tool call
  writeFileSync(join(dir, 'agent-a10.meta.json'), JSON.stringify({ agentType: 'builder', requestShape: 'background', description: 'done-e worker', finished: true }));
  writeFileSync(join(dir, 'agent-a10.jsonl'), JSON.stringify({ type: 'user', timestamp: t(60) }) + '\n'); // finished by its meta file
  agent('a11', 'Fix the staging heap', [{ type: 'user', timestamp: t(60) }]);
  agent('a12', 'Fix email render', [{ type: 'user', timestamp: t(60) }]);
  agent('a13', 'max-out worker', [{ type: 'user', timestamp: t(600) }, { type: 'assistant', timestamp: t(100), message: { stop_reason: 'max_tokens' } }]); // also a final reply
  const glob = [join(root, '*', 'projects', '*', '*', 'subagents')];
  assert.deepEqual(subagentWorkers(glob, 'builder', NOW, new Set(['another'])), [], 'its session is not alive: none of its subagents are');
  const got = subagentWorkers(glob, 'builder', NOW, new Set(['sess1'])).sort((a, b) => a.name!.localeCompare(b.name!));
  assert.deepEqual(got.map((a) => [a.name, a.cwd, a.startedAt]), [['ci-watch-b', '', (NOW - 3000) * 1000], ['Fix email render', '', (NOW - 60) * 1000], ['Fix the staging heap', '', (NOW - 60) * 1000], ['site-b2', '', (NOW - 5000) * 1000], ['site-b3', '/w/app-wt', (NOW - 900) * 1000]], 'the start read from a first line over 4 KB; a long tool call keeps a worker; two Fix workers stay apart');
  // '*': a background subagent of any type counts (every background agent a session starts); foreground ones still don't.
  assert.deepEqual(subagentWorkers(glob, '*', NOW, new Set(['sess1'])).map((a) => a.name!).sort(), [...got.map((a) => a.name!), 'Review the PR'].sort());
  assert.equal(expandGlob(join(root, '*', 'projects', '*', '*', 'subagents')).length, 1);
  assert.deepEqual(expandGlob(join(root, 'none*', 'x')), []);

  // Under a --bg orchestrator, a worker's transcript counts on the worker's row only.
  const b = board([{ name: 'orchestrator', kind: 'background', status: 'busy', sessionId: 'sess1', root: join(root, 'p1', 'projects') }, ...got], {}, () => 'p', NOW);
  const row = (n: string) => b.workers.find((w) => w.name === n)!;
  assert.equal(row('orchestrator').responses10, 0, 'its subagents\' turns are theirs');
  assert.deepEqual([row('orchestrator').session, row('site-b3').session], ['sess1', undefined], 'a background session\'s id; a subagent\'s (its transcript path) is never sent');
  assert.ok(got.every((x) => typeof x.parent === 'string' && x.parent.length > 0), 'each subagent knows the session that started it');
  // Two sessions run workers: each worker's row names its own; the board names the newest worker's.
  const two = board([
    { name: 'site-b3', kind: 'subagent', status: 'busy', sessionId: '/x/A/subagents/a.jsonl', parent: 'sess-A', startedAt: (NOW - 7200) * 1000, files: [] },
    { name: 'kb-ingest', kind: 'subagent', status: 'busy', sessionId: '/x/B/subagents/b.jsonl', parent: 'sess-B', startedAt: (NOW - 600) * 1000, files: [] },
    { name: 'bg-1', kind: 'background', status: 'busy', sessionId: 'bg', parent: 'not-a-subagent', startedAt: NOW * 1000, files: [] },
  ], {}, () => 'p', NOW, () => []);
  assert.deepEqual(two.workers.map((w) => [w.name, w.parent]), [['site-b3', 'sess-A'], ['kb-ingest', 'sess-B'], ['bg-1', undefined]]);
  assert.equal(two.opsSession, 'sess-B');
  assert.equal(board([], {}, () => 'p', NOW, () => [], 'sess-A').opsSession, 'sess-A', 'none running: the one kept from before');
  assert.equal(board([], {}, () => 'p', NOW, () => []).opsSession, undefined);
  assert.deepEqual([row('site-b3').last, row('site-b3').responses10], [NOW - 90, 1]);
});
