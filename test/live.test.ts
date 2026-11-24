// Live sessions (src/live.ts): the states hook events make, what a permission card says, waiting
// for the dashboard's answer, the opt-in, mc setup's extra hooks, and the real hook end to end
// against a stand-in hub. Every test works in a fresh temp folder with its own MC_HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { reloadConfig, settings } from '../src/config.ts';
import { awaitDecision, lastPart, pushFile, summarize, updateFor, watchAnswer, type LiveUpdate } from '../src/live.ts';
import { setup } from '../src/setup.ts';

function world(cfg: Record<string, unknown> = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mc-live-')));
  process.env.MC_HOME = join(home, '.mission-control');
  mkdirSync(process.env.MC_HOME, { recursive: true });
  if (Object.keys(cfg).length) writeFileSync(join(process.env.MC_HOME, 'config.json'), JSON.stringify(cfg));
  reloadConfig();
  return home;
}

test('live: off unless switched on, since it sends Claude\'s messages off the laptop', () => {
  world();
  assert.equal(settings().live, false);
  world({ live: true });
  assert.equal(settings().live, true);
});

test('live: each hook event makes its state; the waiting text is the end of the message', () => {
  const base = { session_id: 's1', cwd: '/w/p' };
  assert.equal(updateFor({ ...base, hook_event_name: 'UserPromptSubmit' }, 'p', 5_000)?.state, 'working');
  assert.equal(updateFor({ ...base, hook_event_name: 'SessionEnd' }, 'p')?.state, 'ended');
  assert.equal(updateFor({ ...base, hook_event_name: 'SessionStart' }, 'p'), null);
  assert.equal(updateFor({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash' }, 'p'), null);
  assert.equal(updateFor({ hook_event_name: 'Stop' }, 'p'), null, 'no session, no update');

  const long = 'x'.repeat(5000) + '\n\nShall I push to staging?';
  const w = updateFor({ ...base, hook_event_name: 'Stop', last_assistant_message: long }, 'p', 7_000)!;
  assert.deepEqual([w.state, w.since, w.seq, w.cwd, w.project], ['waiting', 7, 7_000, '/w/p', 'p']);
  assert.ok(w.text!.endsWith('Shall I push to staging?'));
  assert.ok(w.text!.startsWith('…') && w.text!.length === 3500);
  assert.equal(lastPart('short'), 'short');

  const q = updateFor({ ...base, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: {
    questions: [{ question: 'Which icon?', header: 'Icon', options: [{ label: 'Sliders', description: 'three' }, { label: 'Ring' }], multiSelect: false }],
  } }, 'p')!;
  assert.deepEqual([q.state, q.questions], ['question', [{ question: 'Which icon?', options: ['Sliders', 'Ring'] }]]);
  assert.equal(updateFor({ ...base, hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' }, 'p')?.state, 'working');

  const r = updateFor({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run tests' } }, 'p')!;
  assert.equal(r.state, 'permission');
  assert.deepEqual([r.request!.tool, r.request!.summary], ['Bash', 'npm test']);
  assert.match(r.request!.id, /^[0-9a-f-]{36}$/);
});

test('live: a permission card says what the tool wants, briefly', () => {
  assert.equal(summarize('Bash', { command: 'git push' }), 'git push');
  assert.equal(summarize('WebFetch', { url: 'https://example.com' }), 'https://example.com');
  assert.equal(summarize('SomeTool', { id: 'w1' }), '{"id":"w1"}');
  assert.equal(summarize('Bash', { command: 'y'.repeat(4000) }).length, 1500);
});

test('live: waiting for Allow or Deny, and leaving it to Claude Code when the dashboard cannot answer', async () => {
  const u = updateFor({ session_id: 's1', cwd: '/w', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }, 'p')!;
  const sleep = async () => {};
  const answers = (...rs: ({ pending: boolean; decision: 'allow' | 'deny' | null } | null)[]) => {
    const polls: string[] = [];
    return { polls, calls: { post: async () => true, sleep, poll: async (s: string, r: string) => { polls.push(`${s} ${r}`); return rs.shift() ?? { pending: true, decision: null }; } } };
  };

  let a = answers(null, { pending: true, decision: null }, { pending: true, decision: 'allow' });
  let r = await awaitDecision(u, a.calls, 60_000, 0);
  assert.equal(r.end, 'decided');
  assert.deepEqual(JSON.parse(r.out), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.deepEqual(a.polls, Array(3).fill(`s1 ${u.request!.id}`));

  a = answers({ pending: true, decision: 'deny' });
  assert.equal(JSON.parse((await awaitDecision(u, a.calls, 60_000, 0)).out).hookSpecificOutput.decision.message, 'Denied from Mission Control.');

  a = answers({ pending: false, decision: null }); // the session moved on
  assert.deepEqual(await awaitDecision(u, a.calls, 60_000, 0), { out: '', end: 'none' });

  // Answered in Claude Code's own prompt: the wait ends there, without asking the hub again.
  let seen = 0;
  a = answers();
  r = await awaitDecision(u, { ...a.calls, answered: () => ++seen >= 2 }, 60_000, 0);
  assert.deepEqual([r, a.polls.length], [{ out: '', end: 'answered' }, 1]);

  assert.equal((await awaitDecision(u, { ...answers().calls, post: async () => false }, 60_000, 0)).end, 'none', 'hub unreachable');
  assert.equal((await awaitDecision(u, answers().calls, 5, 1)).out, '', 'the wait runs out');
  assert.equal((await awaitDecision({ ...u, state: 'waiting' }, answers().calls)).out, '');
});

test('live: a request answered in Claude Code shows in the transcript as its tool call\'s result', () => {
  const home = world();
  const t = join(home, 'session.jsonl');
  const line = (o: object) => JSON.stringify(o) + '\n';
  const call = (id: string, command: string) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description: 'make it' } }] } });
  const result = (id: string) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: '' }] } });
  writeFileSync(t, line({ type: 'user', message: { content: 'go' } }) + call('t1', 'touch a') + result('t1') + call('t2', 'touch b'));

  const answered = watchAnswer(t, 'Bash', { command: 'touch b', description: 'make it' });
  assert.equal(answered(), false, 'waiting: t2 has no result yet');
  appendFileSync(t, result('t9')); // another call's result
  assert.equal(answered(), false);
  appendFileSync(t, result('t2').slice(0, 20)); // half written
  assert.equal(answered(), false);
  appendFileSync(t, result('t2').slice(20));
  assert.equal(answered(), true);
  assert.equal(answered(), true);

  assert.equal(watchAnswer(t, 'Bash', { command: 'touch a', description: 'make it' })(), true, 'an earlier call already answered');
  // The same command again: the earlier run's result does not answer the new request.
  appendFileSync(t, call('t3', 'touch a'));
  const again = watchAnswer(t, 'Bash', { command: 'touch a' });
  assert.equal(again(), false);
  appendFileSync(t, result('t3'));
  assert.equal(again(), true);
  assert.equal(watchAnswer(join(home, 'none.jsonl'), 'Bash', {})(), false);
  assert.equal(watchAnswer(undefined, 'Bash', {})(), false);
});

test('live: a pushed update\'s file goes, sent or not, and so do leftovers over an hour old', async () => {
  const home = world();
  const dir = join(home, '.mission-control/live');
  mkdirSync(dir, { recursive: true });
  const now = 10_000_000;
  writeFileSync(join(dir, `${now - 3_700_000}-old.json`), '{}');
  writeFileSync(join(dir, `${now - 60_000}-recent.json`), '{}');
  const file = join(dir, `${now}-mine.json`);
  writeFileSync(file, JSON.stringify({ session: 's1', state: 'working' }));
  const sent: LiveUpdate[] = [];
  await pushFile(file, async (u) => { sent.push(u); }, now);
  assert.deepEqual(sent.map((u) => u.state), ['working']);
  assert.deepEqual(readdirSync(dir), [`${now - 60_000}-recent.json`]);

  writeFileSync(file, '{}');
  await assert.rejects(pushFile(file, async () => { throw new Error('offline'); }, now));
  assert.equal(existsSync(file), false);
});

test('setup: live sessions add their hooks only when switched on, once', () => {
  const home = world();
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  // Someone's own PreToolUse hook for another tool is left alone and is not mistaken for ours.
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }] } }));
  const summaries = join(home, 'mc/projects');
  const read = () => JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));

  setup({ dry: false, summaries, claudeDir, hub: null });
  assert.equal(read().hooks.PermissionRequest, undefined);

  const on = setup({ dry: false, summaries, claudeDir, hub: null, live: true });
  assert.equal(on.find((s) => s.step === 'Claude Code hooks')?.note, 'PermissionRequest, PreToolUse (AskUserQuestion), PostToolUse (AskUserQuestion)');
  const s = read();
  assert.equal(s.hooks.PermissionRequest[0].hooks[0].timeout, 1800);
  assert.deepEqual(s.hooks.PreToolUse.map((e: { matcher: string }) => e.matcher), ['Bash', 'AskUserQuestion']);
  assert.match(s.hooks.PostToolUse[0].hooks[0].command, /bin\/mc hook$/);

  const again = setup({ dry: false, summaries, claudeDir, hub: null, live: true });
  assert.equal(again.find((x) => x.step === 'Claude Code hooks')?.result, 'already');
});

/** Run the real `mc hook` with one event, as Claude Code does. */
function runHook(input: object, env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  const mc = fileURLToPath(new URL('../bin/mc', import.meta.url));
  return new Promise((resolve) => {
    const p = spawn('/bin/sh', [mc, 'hook'], { env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
    p.stdin.end(JSON.stringify(input));
  });
}

test('hook, end to end: a stop reaches the hub as waiting; a permission request takes Allow from it', async () => {
  const home = world({ live: true });
  const got: LiveUpdate[] = [];
  let decision: 'allow' | null = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/live') {
        const u = JSON.parse(body) as LiveUpdate;
        got.push(u);
        if (u.state === 'permission') setTimeout(() => (decision = 'allow'), 300); // the owner presses Allow
        return res.end('{"ok":true}');
      }
      if (req.method === 'GET' && req.url?.startsWith('/live/s1/decision')) return res.end(JSON.stringify({ pending: true, decision }));
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const env = { MC_HOME: join(home, '.mission-control'), MC_HUB_URL: `http://127.0.0.1:${port}`, MC_HUB_TOKEN: 't' };
  try {
    const stop = await runHook({ hook_event_name: 'Stop', session_id: 's1', cwd: home, last_assistant_message: 'Shall I go on?' }, env);
    assert.deepEqual(stop, { code: 0, out: '' });
    for (let i = 0; i < 100 && !got.length; i++) await new Promise((r) => setTimeout(r, 100)); // the detached push
    assert.deepEqual(got.map((u) => [u.session, u.state, u.text, u.cwd]), [['s1', 'waiting', 'Shall I go on?', home]]);

    const perm = await runHook({ hook_event_name: 'PermissionRequest', session_id: 's1', cwd: home, tool_name: 'Bash', tool_input: { command: 'npm test' } }, env);
    assert.equal(perm.code, 0);
    assert.deepEqual(JSON.parse(perm.out), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    assert.equal(got.at(-1)?.request?.summary, 'npm test');
  } finally {
    server.close();
  }
});
