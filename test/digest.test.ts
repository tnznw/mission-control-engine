import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addLines, digestsSince, promptText, redact, type Digest } from '../src/digest.ts';

const user = (text: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', timestamp: '2026-11-26T01:00:00.000Z', cwd: '/p/aletheia', origin: { kind: 'human' }, message: { role: 'user', content: text }, ...extra });
const reply = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] }, ...extra });
const tool = () => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } });

test('only what the person typed opens a turn', () => {
  assert.equal(promptText(JSON.parse(user('Make the cut list'))), 'Make the cut list');
  assert.equal(promptText(JSON.parse(user([{ type: 'text', text: '<system-reminder>ignore me</system-reminder> Ship it <ide_selection>x</ide_selection>' }]))), 'Ship it');
  assert.equal(promptText(JSON.parse(user('<pasted_content id="1">the idea</pasted_content> please'))), 'the idea please');
  assert.equal(promptText(JSON.parse(user('<task-notification>done</task-notification>', { origin: { kind: 'task-notification' } }))), '');
  assert.equal(promptText(JSON.parse(user([{ type: 'tool_result', content: 'ok' }], { toolUseResult: {} }))), '');
  assert.equal(promptText(JSON.parse(user('summary of earlier', { isCompactSummary: true }))), '');
  assert.equal(promptText(JSON.parse(user('<local-command-stdout>Compacted</local-command-stdout>', { origin: undefined }))), '');
  assert.equal(promptText(JSON.parse(user('injected', { isMeta: true }))), '');
  assert.equal(promptText(JSON.parse(user('[Request interrupted by user]'))), '');
});

test('each turn keeps the prompt and Claude\'s last reply in it; the newest title wins', () => {
  const d: Digest = { session: 's', title: '', home: 'aletheia', turns: [] };
  addLines(d, [
    JSON.stringify({ type: 'ai-title', aiTitle: 'First title' }),
    user('Cut the video'), reply('Looking at the transcript.'), tool(), reply('Here is the cut list: 15 minutes.'),
    user('Now in journal', { cwd: '/p/journal' }), reply('Journal is building it.', { isSidechain: true }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Video cuts' }),
  ].join('\n'), (cwd) => cwd.split('/').pop()!);
  assert.equal(d.title, 'Video cuts');
  assert.deepEqual(d.turns.map((t) => [t.project, t.you, t.claude]), [
    ['aletheia', 'Cut the video', 'Here is the cut list: 15 minutes.'],
    ['journal', 'Now in journal', ''], // a subagent's words are not the session's reply
  ]);
  assert.equal(d.turns[0].at, Date.parse('2026-11-26T01:00:00.000Z') / 1000);
});

test('secrets never go in a digest', () => {
  // Built in pieces, so the engine export's guard against publishing a key does not take this
  // stand-in for one (scripts/export-engine.sh).
  const key = 'OPENSSH ' + 'PRIVATE KEY';
  const t = redact('key sk-ant-abcdefghijklmnop123456 and ghp_abcdefghijklmnopqrstuv1234 and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fw '
    + 'password: hunter2secret, https://claude.ai/artifact/TY?sk=ABL1u_eSYEAl#x and ' + 'a'.repeat(44) + ` -----BEGIN ${key}-----\nabc\n-----END ${key}-----`);
  for (const bad of ['sk-ant-abcdefghijklmnop', 'ghp_abcdef', 'eyJhbGci', 'hunter2secret', 'ABL1u_eSYEAl', 'a'.repeat(44), 'abc\n']) assert.ok(!t.includes(bad), `${bad} left in: ${t}`);
  assert.match(t, /password: \[hidden\]/);
  assert.match(t, /\?sk=\[hidden\]#x/);
  assert.equal(redact('/Users/tenzin/Projects/mission-control/src/digest.ts at 3b9c784'), '/Users/tenzin/Projects/mission-control/src/digest.ts at 3b9c784'); // paths and short hashes stay
});

test('read on from where it was left: new turns join, unchanged and subagent transcripts are skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-digest-'));
  const f = join(root, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
  writeFileSync(f, user('First') + '\n' + reply('One') + '\n');
  writeFileSync(join(root, 'notes.jsonl'), user('not a session') + '\n');
  const dir = join(root, 'state'), projectOf = () => 'aletheia', homeOf = () => 'aletheia';
  const a = digestsSince([f, join(root, 'notes.jsonl')], 0, dir, projectOf, homeOf);
  assert.deepEqual(a.digests.map((d) => [d.session.slice(0, 8), d.home, d.turns.length]), [['aaaaaaaa', 'aletheia', 1]]);
  a.save();
  assert.equal(digestsSince([f], 0, dir, projectOf, homeOf).digests.length, 0); // nothing new
  appendFileSync(f, user('Second') + '\n' + reply('Two') + '\n' + user('Third, still being writ'));
  const b = digestsSince([f], 0, dir, projectOf, homeOf);
  assert.deepEqual(b.digests[0].turns.map((t) => t.you + '/' + t.claude), ['First/One', 'Second/Two']); // a half-written line waits
  b.save();
  writeFileSync(f, user('Rewritten') + '\n'); // shorter than what was read: read again from the start
  assert.deepEqual(digestsSince([f], 0, dir, projectOf, homeOf).digests[0].turns.map((t) => t.you), ['Rewritten']);
  assert.equal(digestsSince([f], Date.now() / 1000 + 60, dir, projectOf, homeOf).digests.length, 0); // not changed since
});
