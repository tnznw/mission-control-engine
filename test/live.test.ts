// Live sessions (src/live.ts): the states hook events make, what a permission card says, waiting
// for the dashboard's answer, the opt-in, mc setup's extra hooks, and the real hook end to end
// against a stand-in hub. Every test works in a fresh temp folder with its own MC_HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { reloadConfig, settings } from '../src/config.ts';
import { answered, awaitDecision, lastPart, pushFile, pushOutcome, summarize, updateFor, watchAnswer, type LiveUpdate, type PushOutcome } from '../src/live.ts';
import { setup, supportsRewake } from '../src/setup.ts';

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

test('live: only the hub\'s own JSON counts as sent; a 4xx is not worth resending', () => {
  assert.deepEqual(pushOutcome(200, 'application/json; charset=UTF-8'), { sent: true });
  const page = pushOutcome(200, 'text/html'); // the address answering with a page while the hub restarts
  assert.deepEqual(page.sent ? null : [page.retry, page.down], [true, true]);
  const gateway = pushOutcome(502, 'text/html'); // the proxy in front of a hub that is not running
  assert.deepEqual(gateway.sent ? null : [gateway.retry, gateway.down], [true, true]);
  // The hub itself answering with an error about this update: worth one more go, the others still go.
  for (const s of [500, 503, 408, 429]) { const r = pushOutcome(s, 'application/json'); assert.deepEqual(r.sent ? null : [r.retry, r.down], [true, false], String(s)); }
  for (const s of [400, 401, 404]) { const r = pushOutcome(s, 'application/json'); assert.deepEqual(r.sent ? null : [r.retry, r.down], [false, false], String(s)); }
});

test('live: an update\'s file goes once the hub has it; a failed send is kept, logged, and resent next time', async () => {
  const home = world();
  const dir = join(home, '.mission-control/live');
  mkdirSync(dir, { recursive: true });
  const at = (seq: number, session: string, state: string, tag = 'x') => {
    const f = join(dir, `${seq}-${tag}.json`);
    writeFileSync(f, JSON.stringify({ session, state, seq }));
    return f;
  };
  const sent: string[] = [];
  const ok = async (u: LiveUpdate): Promise<PushOutcome> => { sent.push(u.session + ':' + u.state); return { sent: true }; };
  const down = async (): Promise<PushOutcome> => { throw new Error('fetch failed'); };
  let now = 100_000_000;

  // Sent: the file goes. A day-old leftover goes unsent; one still in flight is left to its own push.
  at(now - 90_000_000, 'old', 'working', 'old');
  at(now - 5_000, 'other', 'working', 'flight');
  let r = await pushFile(at(now, 's1', 'working'), ok, now);
  assert.deepEqual([r, sent], [{ sent: 1, failed: 0 }, ['s1:working']]);
  assert.deepEqual(readdirSync(dir), [`${now - 5_000}-flight.json`]);
  rmSync(join(dir, `${now - 5_000}-flight.json`));

  // The hub is down (or restarting): the file stays, the failure is on record, and nothing throws.
  sent.length = 0;
  const finished = at(now += 60_000, 's1', 'waiting');
  r = await pushFile(finished, down, now);
  assert.deepEqual(r, { sent: 0, failed: 1 });
  assert.ok(existsSync(finished));
  assert.match(readFileSync(join(home, '.mission-control/live-errors.log'), 'utf8'), /s1 waiting kept to resend: fetch failed/);

  // The next push, from another session, sends its own update and then the one that was kept.
  r = await pushFile(at(now += 60_000, 's2', 'working'), ok, now);
  assert.deepEqual([r, sent], [{ sent: 2, failed: 0 }, ['s2:working', 's1:waiting']]);
  assert.deepEqual(readdirSync(dir), []);

  // Of one session's leftovers only the newest is sent; any older than this push's own is dropped.
  sent.length = 0;
  at(now - 300_000, 's3', 'working', 'a');
  at(now - 200_000, 's3', 'waiting', 'b');
  at(now - 250_000, 's4', 'working', 'c');
  r = await pushFile(at(now += 1, 's4', 'ended'), ok, now);
  assert.deepEqual([r, sent], [{ sent: 2, failed: 0 }, ['s4:ended', 's3:waiting']]);
  assert.deepEqual(readdirSync(dir), []);

  // An update the hub refuses (a 4xx) is dropped, not kept; the others still go.
  sent.length = 0;
  at(now - 100_000, 's5', 'waiting', 'd');
  const refused = async (u: LiveUpdate): Promise<PushOutcome> => (u.session === 's6' ? { sent: false, retry: false, down: false, why: 'hub answered 400' } : ok(u));
  r = await pushFile(at(now += 1, 's6', 'waiting'), refused, now);
  assert.deepEqual([r, sent], [{ sent: 1, failed: 1 }, ['s5:waiting']]);
  assert.deepEqual(readdirSync(dir), []);

  // One the hub keeps failing on (a 500 about this update, an emoji its table refuses) is kept, but
  // does not hold up another session's; that session's next update replaces it.
  sent.length = 0;
  const stuck = async (u: LiveUpdate): Promise<PushOutcome> => (u.session === 's9' ? { sent: false, retry: true, down: false, why: 'hub answered 500' } : ok(u));
  at(now - 200_000, 's9', 'waiting', 'f');
  at(now - 100_000, 's10', 'waiting', 'g');
  r = await pushFile(at(now += 1, 's11', 'working'), stuck, now);
  assert.deepEqual([r, sent], [{ sent: 2, failed: 1 }, ['s11:working', 's10:waiting']]);
  assert.deepEqual(readdirSync(dir), [`${now - 1 - 200_000}-f.json`]);
  r = await pushFile(at(now += 1, 's9', 'working'), ok, now);
  assert.deepEqual(readdirSync(dir), [], 's9\'s newer update replaced the stuck one');

  // With the hub down, the rest wait for the next push.
  sent.length = 0;
  at(now - 100_000, 's7', 'waiting', 'e');
  r = await pushFile(at(now += 1, 's8', 'working'), down, now);
  assert.deepEqual(r, { sent: 0, failed: 1 });
  assert.equal(readdirSync(dir).length, 2, 'both wait for the next push');

  // A file that is not an update is dropped.
  const junk = join(dir, `${now}-junk.json`);
  writeFileSync(junk, '{');
  await pushFile(junk, ok, now);
  assert.equal(existsSync(junk), false);
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

  assert.deepEqual(['2.1.331 (Claude Code)', '2.1.330 (Claude Code)', '2.2.0', '3.0.1', 'claude: not found'].map((v) => supportsRewake(v)), [true, false, true, true, false]);
  const old = setup({ dry: true, summaries, claudeDir, hub: null, live: true, rewake: false });
  assert.equal(old.find((s) => s.step === 'Inbox watcher')?.result, 'skipped', 'an older Claude Code would hold every Stop');
  const on = setup({ dry: false, summaries, claudeDir, hub: null, live: true, rewake: true });
  assert.equal(on.find((s) => s.step === 'Claude Code hooks')?.note, 'PermissionRequest, PreToolUse (AskUserQuestion), PostToolUse (AskUserQuestion), Stop (inbox watcher)');
  const s = read();
  const watcher = s.hooks.Stop.flatMap((e: { hooks: { command: string; asyncRewake?: boolean; timeout: number }[] }) => e.hooks).find((h: { command: string }) => /mc-inbox-wait$/.test(h.command));
  assert.deepEqual([watcher.asyncRewake, watcher.timeout], [true, 43200], 'the relay\'s watcher runs in the background and may wake its session');
  assert.equal(s.hooks.PermissionRequest[0].hooks[0].timeout, 1800);
  assert.deepEqual(s.hooks.PreToolUse.map((e: { matcher: string }) => e.matcher), ['Bash', 'AskUserQuestion']);
  assert.match(s.hooks.PostToolUse[0].hooks[0].command, /bin\/mc hook$/);

  const again = setup({ dry: false, summaries, claudeDir, hub: null, live: true, rewake: true });
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

test('live: a question box is put on the dashboard with a request, and its answers go back as Claude\'s input', async () => {
  const input = { questions: [
    { question: 'Q'.repeat(1200) + ' email next or hold?', header: 'Next', options: [{ label: 'Email next', description: 'd' }, { label: 'Hold' }], multiSelect: false },
    { question: 'Which tests?', header: 'Tests', options: [{ label: 'Unit' }, { label: 'E2E' }], multiSelect: true },
  ] };
  const u = updateFor({ session_id: 's1', cwd: '/w/p', hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: input }, 'p', 9_000)!;
  assert.equal(u.state, 'question');
  assert.deepEqual([u.request!.tool, u.request!.summary], ['AskUserQuestion', '']);
  assert.deepEqual(u.questions!.map((q) => [q.options, q.multiSelect]), [[['Email next', 'Hold'], undefined], [['Unit', 'E2E'], true]]);
  assert.ok(u.questions![0].question.length <= 900, 'the card shows it cut short');

  const replies = [{ pending: true, decision: null }, { pending: true, decision: null, answers: ['Hold'] }, { pending: true, decision: 'allow', answers: ['Hold', 'Unit, E2E'] }] as const;
  let i = 0;
  const calls = { post: async () => true, poll: async () => replies[Math.min(i++, replies.length - 1)], input };
  const r = await awaitDecision(u, calls, 60_000, 0);
  assert.equal(r.end, 'decided');
  const d = JSON.parse(r.out).hookSpecificOutput.decision;
  assert.equal(d.behavior, 'allow');
  assert.deepEqual(d.updatedInput.answers, { [input.questions[0].question]: 'Hold', 'Which tests?': 'Unit, E2E' }, 'keyed by the full question, every question answered');
  assert.deepEqual(d.updatedInput.questions, input.questions);

  // Dismissed on the dashboard: denied at once. Allowed by a hub that knows only Allow: left to Claude Code.
  const once = (r: { pending: boolean; decision: 'allow' | 'deny' | null }) => ({ post: async () => true, poll: async () => r, input });
  assert.equal(JSON.parse((await awaitDecision(u, once({ pending: true, decision: 'deny' }), 60_000, 0)).out).hookSpecificOutput.decision.behavior, 'deny');
  assert.deepEqual(await awaitDecision(u, once({ pending: true, decision: 'allow' }), 60_000, 0), { out: '', end: 'none' });

  // Never answered: the wait runs out, and the hook says so (the card then loses its buttons).
  const quiet = { post: async () => true, poll: async () => ({ pending: true, decision: null }), input };
  assert.deepEqual(await awaitDecision(u, quiet, 5, 1), { out: '', end: 'expired' });
});

test('live: answers are used only when every question has one', () => {
  const input = { questions: [{ question: 'A?' }, { question: 'B?' }] };
  assert.equal(answered(input, ['x']), null);
  assert.equal(answered(input, ['x', '  ']), null);
  assert.equal(answered(input, 'x'), null);
  assert.equal(answered(undefined, ['x']), null);
  assert.deepEqual(answered(input, ['x', ' y ']), { ...input, answers: { 'A?': 'x', 'B?': 'y' } });
  assert.deepEqual(answered(input, [['Unit', 'E2E'], 'y']), { ...input, answers: { 'A?': 'Unit, E2E', 'B?': 'y' } }, 'a list of picks is joined');
});

test('live: a wait that runs out just after Claude Code\'s own prompt was answered counts as answered', async () => {
  const u = updateFor({ session_id: 's1', cwd: '/w', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }, 'p')!;
  const calls = { post: async () => true, poll: async () => ({ pending: true, decision: null }) };
  // A wait of 0 ms never polls: only the last check runs.
  assert.equal((await awaitDecision(u, { ...calls, answered: () => true }, 0, 1)).end, 'answered');
  assert.equal((await awaitDecision(u, { ...calls, answered: () => false }, 0, 1)).end, 'expired');
});

test('mc answers --apply: plain arguments, refusals reported, a program that cannot run kept for later, a lost report said again', async () => {
  const log = join(realpathSync(tmpdir()), `mc-answers-${process.pid}.log`);
  // Exit 0 for q1; exit 3 for q2 (refused).
  const script = 'require("fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\\n"); process.exit(process.argv[2] === "q2" ? 3 : 0)';
  const home = world({ answer: ['node', '-e', script, log, '{id}', '{answer}'] });
  let answers = [{ id: 'q1', project: 'p', answer: 'Hold; $(touch /tmp/x) "quoted" $& $$5' }, { id: 'q2', project: 'p', answer: 'no' }];
  const applied: { id: string; body: unknown }[] = [];
  let failReports = true;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url === '/answers') return res.end(JSON.stringify({ answers }));
      const m = /^\/answers\/(.+)\/applied$/.exec(req.url ?? '');
      if (req.method === 'POST' && m) {
        if (failReports) { res.statusCode = 500; return res.end('{}'); }
        applied.push({ id: decodeURIComponent(m[1]), body: JSON.parse(body) });
        answers = answers.filter((a) => a.id !== decodeURIComponent(m[1]));
        return res.end('{"ok":true}');
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const mc = fileURLToPath(new URL('../bin/mc', import.meta.url));
  const env = { ...process.env, MC_HOME: join(home, '.mission-control'), MC_HUB_URL: `http://127.0.0.1:${port}`, MC_HUB_TOKEN: 't', MC_VSCODE_SETTINGS: join(home, 'no-vscode.json') };
  const run = () => new Promise<number | null>((resolve) => { spawn('/bin/sh', [mc, 'answers', '--apply', '--quiet'], { env }).on('close', resolve); });
  try {
    assert.equal(await run(), 0);
    const calls = () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(calls(), [['q1', 'Hold; $(touch /tmp/x) "quoted" $& $$5'], ['q2', 'no']], 'one argument each, as typed, nothing run by a shell');
    assert.equal(applied.length, 0, 'the hub did not take the reports');
    failReports = false;
    assert.equal(await run(), 0);
    assert.equal(calls().length, 2, 'the second run only says again what happened, never hands over twice');
    assert.deepEqual(applied.map((a) => [a.id, (a.body as any).ok]), [['q1', true], ['q2', false]]);
    assert.match((applied[1].body as any).note, /exit 3/);

    // A program that cannot run: nothing reported, so the next run tries again.
    writeFileSync(join(home, '.mission-control', 'config.json'), JSON.stringify({ answer: ['/no/such/program', '{id}', '{answer}'] }));
    answers = [{ id: 'q3', project: 'p', answer: 'x' }];
    assert.equal(await run(), 0);
    assert.deepEqual(applied.map((a) => a.id), ['q1', 'q2']);
  } finally {
    server.close();
  }
});

test('mc asks: an ask is answered with its time, even when no account could be read; nothing asked does nothing', async () => {
  const home = world({ limits: true, accountDirs: [join(realpathSync(tmpdir()), 'mc-no-such-sign-ins', '*')] });
  let reply = '{"limits":true,"limitsAsked":1800000000}';
  const posted: unknown[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/asks') return res.end(reply);
      if (req.method === 'POST' && req.url === '/limits') { posted.push(JSON.parse(body)); return res.end('{"accounts":0}'); }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const mc = fileURLToPath(new URL('../bin/mc', import.meta.url));
  const env = { ...process.env, MC_HOME: join(home, '.mission-control'), MC_HUB_URL: `http://127.0.0.1:${port}`, MC_HUB_TOKEN: 't', MC_VSCODE_SETTINGS: join(home, 'no-vscode.json') };
  const run = () => new Promise<string>((resolve) => {
    const p = spawn('/bin/sh', [mc, 'asks'], { env });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(out));
  });
  try {
    await run();
    assert.deepEqual(posted, [{ accounts: [], answers: 1800000000 }], 'no sign-in could be read: an empty answer still clears the ask');
    reply = '{"limits":false}';
    assert.equal(await run(), 'Nothing asked.\n');
    reply = '{}';
    assert.equal(await run(), 'Nothing asked.\n', 'a hub without /asks');
    reply = '{"limits":true,"limitsAsked":null}';
    assert.equal(await run(), 'Nothing asked.\n', 'an ask without its time is left alone');
    assert.equal(posted.length, 1);
  } finally {
    server.close();
  }
});
