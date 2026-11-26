import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Frontmatter, parseProjectMd } from '../src/format.ts';
import { activeSeconds, momentum, decay, type ActivityEvent } from '../src/time.ts';
import { scan, projectForDir } from '../src/scan.ts';

const GOOD = `---
id: cfo
name: CFO bookkeeping
status: active
client: Acme
tags: [freelance]
where:
  - local: ~/Projects/cfo
cadence:
  - what: Monthly check
    rrule: FREQ=MONTHLY;BYMONTHDAY=5
    time: "09:00"
next:
  - task: Send review
    due: 2026-11-12
updated: 2026-11-05
---
## What it is
Books.`;

test('parses a valid PROJECT.md, unquoted YAML dates become strings', () => {
  const r = parseProjectMd(GOOD, 'x');
  if (!r.ok) throw new Error(r.errors.join());
  assert.equal(r.project.updated, '2026-11-05');
  assert.equal(r.project.next[0].due, '2026-11-12');
  assert.equal(r.project.cadence[0].duration, 30);
  assert.match(r.project.body, /^## What it is/);
});

test('reports every problem, with paths', () => {
  const r = parseProjectMd('---\nid: Bad Id\nstatus: live\nwhere: []\n---\n', 'x');
  if (r.ok) throw new Error("expected failure");
  const all = r.errors.join('\n');
  for (const f of ['id:', 'name:', 'status:', 'where:', 'updated:']) assert.ok(all.includes(f), f);
});

test('v1.2 progress: phases are "<name>: done|now|todo", "to do" reads as todo, and the result checks again', () => {
  const doc = (progress: string) => `---\nid: x\nname: X\nstatus: active\nwhere:\n  - local: ~/x\n${progress}updated: 2026-11-25\n---\n`;
  const r = parseProjectMd(doc('progress:\n  stage: build\n  phases:\n    - Plan: done\n    - Build: now\n    - Launch: To Do\n  waiting: me\n  blocked: the logo\n'), 'x');
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.project.progress, { stage: 'build', phases: [{ Plan: 'done' }, { Build: 'now' }, { Launch: 'todo' }], waiting: 'me', blocked: 'the logo' });
  assert.ok(Frontmatter.safeParse(JSON.parse(JSON.stringify(r.project))).success); // what mc push sends, checked by the hub
  assert.equal(parseProjectMd(doc(''), 'x').ok, true); // optional
  const bad = parseProjectMd(doc('progress:\n  phases:\n    - Plan: finished\n    - Build: now\n      Ship: todo\n'), 'x');
  assert.ok(!bad.ok && bad.errors.some((e) => e.startsWith('progress.phases.0.Plan')) && bad.errors.some((e) => e.startsWith('progress.phases.1:')));
});

test('missing frontmatter is an error, not a crash', () => {
  assert.equal(parseProjectMd('# just a readme', 'x').ok, false);
});

const ev = (session: string, ts: number, project = 'a', kind: ActivityEvent['kind'] = 'tick'): ActivityEvent => ({
  id: `${session}-${ts}`, session, project, kind, ts, cwd: '',
});

test('active time caps idle gaps', () => {
  // 10 min work, 8 h overnight idle, 5 min work → 10 + 15 (cap) + 5 = 30 min
  const t = activeSeconds([ev('s', 0, 'a', 'start'), ev('s', 600), ev('s', 600 + 8 * 3600), ev('s', 600 + 8 * 3600 + 300, 'a', 'end')]);
  assert.equal(t.get('a'), 600 + 900 + 300);
});

test('sessions are independent and order-insensitive', () => {
  const t = activeSeconds([ev('s2', 100, 'b'), ev('s1', 60), ev('s1', 0), ev('s2', 0, 'b')]);
  assert.equal(t.get('a'), 60);
  assert.equal(t.get('b'), 100);
});

test('momentum halves every half-life, and time alone never changes the order', () => {
  const D = 86400, now = 100 * D;
  // a: 1 h ending now-ish; b: 1 h a week ago (stretches of 15 min, the cap)
  const hour = (s: string, p: string, end: number) => [0, 900, 1800, 2700, 3600].map((o) => ev(s, end - 3600 + o, p));
  const evs = [...hour('s1', 'a', now), ...hour('s2', 'b', now - 7 * D)];
  const m = momentum(evs, now, 7);
  assert.ok(Math.abs(m.get('a')! - 0.998) < 0.001, `a=${m.get('a')}`); // its average age is 30 min
  assert.ok(Math.abs(m.get('b')! / m.get('a')! - 0.5) < 1e-9);
  const later = momentum(evs, now + 3 * D, 7); // a weekend passes: both shrink, ratio holds
  assert.ok(Math.abs(later.get('b')! / later.get('a')! - 0.5) < 1e-9);
  assert.ok(later.get('a')! < m.get('a')!);
  assert.equal(decay(-5, 7), 1); // future-dated time counts as fresh, never more
});

test('scan finds projects, skips nested ones, flags duplicates; projectForDir walks up', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-'));
  for (const dir of ['one', 'two', 'one/sub']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'one/PROJECT.md'), GOOD);
  writeFileSync(join(root, 'one/sub/PROJECT.md'), GOOD); // inside a project: ignored
  writeFileSync(join(root, 'two/PROJECT.md'), GOOD); // same id → duplicate
  const { results, duplicateIds } = scan([root]);
  assert.equal(results.length, 2);
  assert.deepEqual(duplicateIds, ['cfo']);
  mkdirSync(join(root, 'one/deep/er'), { recursive: true });
  assert.equal(projectForDir(join(root, 'one/deep/er'))?.id, 'cfo');
});

test('a session at the top of ~/Projects is Mission Control; other folders with no PROJECT.md stay unassigned', async () => {
  const { sessionProject } = await import('../src/scan.ts');
  const { sessionContext } = await import('../src/protocol.ts');
  const root = mkdtempSync(join(tmpdir(), 'mc-root-'));
  mkdirSync(join(root, 'group/new'), { recursive: true });
  mkdirSync(join(root, 'one/deep'), { recursive: true });
  writeFileSync(join(root, 'one/PROJECT.md'), GOOD);
  const was = process.env.MC_ROOTS;
  process.env.MC_ROOTS = root;
  try {
    assert.deepEqual(sessionProject(root), { id: 'mission-control', path: null, root: true });
    assert.deepEqual(sessionProject(join(root, 'group/new')), { id: 'unassigned', path: null, root: false });
    assert.equal(sessionProject(join(root, 'one/deep')).id, 'cfo');
  } finally {
    if (was === undefined) delete process.env.MC_ROOTS; else process.env.MC_ROOTS = was;
  }
  const atRoot = sessionContext(null, null, { root: true, session: 'a0c51cc2-x' });
  assert.match(atRoot, /counts toward mission-control/);
  assert.match(atRoot, /mc assign a0c51cc2-x <project>/);
  assert.doesNotMatch(atRoot, /PROJECT\.md/); // no "create one?" nudge at the root
  assert.match(sessionContext(null, null, { session: 's' }), /no PROJECT\.md[\s\S]*mc assign s <project>/);
});

test('parseMinutes accepts the forms people type', async () => {
  const { parseMinutes } = await import('../src/cli.ts');
  assert.deepEqual(['90', '90m', '1h', '1h30m', '1.5h', '0', 'abc', ''].map(parseMinutes), [90, 90, 60, 90, 90, null, null, null]);
});

test('session context: protocol always, inbox when present, a fallback when the hub is slow', async () => {
  const { sessionContext } = await import('../src/protocol.ts');
  assert.match(sessionContext(null, null), /no PROJECT\.md/);
  const withInbox = sessionContext('cfo', [{ id: 'm1', kind: 'task', body: 'Update next', createdAt: 0 }]);
  assert.match(withInbox, /Project "cfo"/);
  assert.match(withInbox, /m1 \(task\): Update next/);
  assert.match(sessionContext('cfo', null), /did not answer/);
  assert.doesNotMatch(sessionContext('cfo', []), /Inbox/);
  // Done/Dismiss already taken off PROJECT.md: said once, nothing for the session to ask about.
  const done = sessionContext('cfo', [], { removed: ['Send review'] });
  assert.match(done, /Off PROJECT\.md `next` already .*nothing to do\): "Send review"/);
  assert.doesNotMatch(done, /Inbox/);
});

test('project map: grouped by status, hub first, relative folders, hand-written text kept', async () => {
  const { renderProjects, writeMap, oneLiner, START } = await import('../src/map.ts');
  const { readFileSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'mc-map-'));
  mkdirSync(join(root, 'loose'));
  const mk = (id: string, status: string, rel: string): Parameters<typeof renderProjects>[0][number] => ({
    id, name: id.toUpperCase(), status: status as 'active', client: null as unknown as undefined, tags: ['passion'], where: [], cadence: [], next: [],
    updated: '2026-11-07', body: `## What it is\nThe ${id} thing. More detail here.\n\n## Notes\nx`, path: join(root, rel, 'PROJECT.md'),
  } as never);
  const ps = [mk('zeta', 'active', 'zeta'), mk('mission-control', 'active', 'mission-control'), mk('old', 'paused', 'group/old')];
  const md = renderProjects(ps, root);
  assert.match(md, /### Active \(2\)[\s\S]*MISSION-CONTROL[\s\S]*ZETA[\s\S]*### Paused \(1\)/);
  assert.match(md, /`group\/old\/`/);
  assert.match(md, /\*\*Not projects:\*\* `loose\/`/);
  assert.equal(oneLiner('## What it is\nOne. Two.'), 'One.');
  writeFileSync(join(root, 'README.md'), `# Mine\nhand text\n\n${START}\nold list\n<!-- PROJECTS:END -->\nfooter\n`);
  assert.equal(writeMap(root, ps), true);
  const out = readFileSync(join(root, 'README.md'), 'utf8');
  assert.match(out, /^# Mine\nhand text\n/);
  assert.match(out, /footer\n$/);
  assert.doesNotMatch(out, /old list/);
  assert.equal(writeMap(root, ps), false); // unchanged: no rewrite
});

test('midnightIn: the start of a day in a time zone; an impossible date is refused', async () => {
  const { midnightIn } = await import('../src/cli.ts');
  assert.equal(midnightIn('2026-11-24', 'Australia/Sydney'), Date.parse('2026-11-23T13:00:00Z') / 1000); // AEDT, +11
  assert.equal(midnightIn('2026-06-01', 'Australia/Sydney'), Date.parse('2026-05-31T14:00:00Z') / 1000); // AEST, +10
  assert.equal(midnightIn('2026-11-24', 'UTC'), Date.parse('2026-11-24T00:00:00Z') / 1000);
  assert.ok(Number.isNaN(midnightIn('2026-02-31', 'UTC')));
  assert.ok(Number.isNaN(midnightIn('2026-13-01', 'UTC')));
  assert.ok(Number.isNaN(midnightIn('yesterday', 'UTC')));
});

test('session context: with live sessions on, decisions are asked in a question box the page can answer', async () => {
  const { sessionContext } = await import('../src/protocol.ts');
  assert.doesNotMatch(sessionContext('cfo', []), /AskUserQuestion/);
  assert.match(sessionContext('cfo', [], { live: true, owner: 'Sam' }), /Sam to decide[\s\S]*AskUserQuestion/);
  assert.match(sessionContext(null, null, { live: true }), /no PROJECT\.md[\s\S]*AskUserQuestion/);
});

test('session context: the question-box rule only once the live hooks are installed, and at the root too', async () => {
  const { sessionContext } = await import('../src/protocol.ts');
  const { liveHooksInstalled } = await import('../src/setup.ts');
  const { MC_BIN } = await import('../src/config.ts');
  const dir = mkdtempSync(join(tmpdir(), 'mc-claude-'));
  assert.equal(liveHooksInstalled(dir), false, 'no settings');
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: '~/mc/bin/mc hook' }] }] } }));
  assert.equal(liveHooksInstalled(dir), false, 'live on but mc setup not run again');
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [{ command: '~/other/bin/mc hook', timeout: 1800 }] }] } }));
  assert.equal(liveHooksInstalled(dir), false, 'another setup\'s hook cannot answer from this hub');
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [{ command: `${MC_BIN} hook`, timeout: 1800 }] }] } }));
  assert.equal(liveHooksInstalled(dir), true);
  assert.match(sessionContext(null, null, { root: true, live: true }), /counts toward mission-control[\s\S]*AskUserQuestion/);
});
