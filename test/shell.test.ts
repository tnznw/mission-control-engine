// Mission Control for other people (docs/SHELL.md): settings, summaries kept in Mission Control,
// discover, init and setup. Every test works in a fresh temp folder with its own MC_HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reloadConfig, settings } from '../src/config.ts';
import { forgetKeptSummaries, openedIn, projectForDir, scan, scratchpadHome, sessionProject } from '../src/scan.ts';
import { sessionContext } from '../src/protocol.ts';
import { discover, repoOf, transcriptCwd } from '../src/discover.ts';
import { eventsToImport, init, setup } from '../src/setup.ts';
import { parseProjectMd } from '../src/format.ts';

const summary = (id: string, local: string) => `---
id: ${id}
name: ${id}
status: active
where:
  - local: ${local}
updated: 2026-11-18
---
`;

/** A fresh home with its own Mission Control settings. */
function world(cfg: Record<string, unknown> = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mc-shell-')));
  process.env.MC_HOME = join(home, '.mission-control');
  mkdirSync(process.env.MC_HOME, { recursive: true });
  if (Object.keys(cfg).length) writeFileSync(join(process.env.MC_HOME, 'config.json'), JSON.stringify(cfg));
  reloadConfig();
  forgetKeptSummaries();
  const mk = (rel: string, text?: string) => {
    const p = join(home, rel);
    mkdirSync(text === undefined ? p : join(p, '..'), { recursive: true });
    if (text !== undefined) writeFileSync(p, text);
    return p;
  };
  return { home, mk };
}

test('a session working in its own scratchpad counts toward the folder it started in', () => {
  const { home, mk } = world();
  writeFileSync(join(process.env.MC_HOME!, 'config.json'), JSON.stringify({ roots: [join(home, 'code')], summaries: join(home, 'mc/projects') }));
  reloadConfig();
  mk('code/my-app/PROJECT.md', summary('my-app', join(home, 'code/my-app')));
  mk('code/my/app'); // a dash read as a slash would land here: longer names are tried first
  mk('code/my.site/src/PROJECT.md', summary('site', join(home, 'code/my.site/src')));
  forgetKeptSummaries();
  const enc = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-');
  const temp = (start: string, rest = 'scratchpad') => mk(`tmp/claude-501/${enc(start)}/a19dd47d-c74a-4bd8-8817-703f80a41c98/${rest}`);

  assert.equal(scratchpadHome(temp(join(home, 'code/my-app'))), join(home, 'code/my-app'));
  assert.equal(sessionProject(temp(join(home, 'code/my-app'), 'scratchpad/test-run')).id, 'my-app');
  assert.equal(sessionProject(temp(join(home, 'code/my-app'), 'tasks')).id, 'my-app');
  assert.equal(sessionProject(temp(join(home, 'code/my.site/src'))).id, 'site'); // a dot is a dash too
  assert.equal(sessionProject(temp(join(home, 'code'))).id, 'mission-control'); // started above every project
  assert.equal(scratchpadHome(temp(join(home, 'code/gone'))), null); // its folder removed since
  assert.equal(sessionProject(temp(join(home, 'code/gone'))).id, 'unassigned');
  assert.equal(scratchpadHome(mk('tmp/claude-501/elsewhere')), null); // not a session's temp folder
});

test('the folder a session was opened in, read from where Claude Code keeps its transcript', () => {
  const { home, mk } = world();
  writeFileSync(join(process.env.MC_HOME!, 'config.json'), JSON.stringify({ roots: [join(home, 'code')], summaries: join(home, 'mc/projects') }));
  reloadConfig();
  mk('code/my-app/PROJECT.md', summary('my-app', join(home, 'code/my-app')));
  mk('code/my/app');
  mk('code/journal/PROJECT.md', summary('journal', join(home, 'code/journal')));
  forgetKeptSummaries();
  const enc = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-');
  const transcript = (start: string) => join(home, '.claude/projects', enc(start), 'a19dd47d-c74a-4bd8-8817-703f80a41c98.jsonl');
  const t = transcript(join(home, 'code/my-app'));
  assert.equal(openedIn(t, join(home, 'code/my-app')), join(home, 'code/my-app')); // still there: no walk
  assert.equal(openedIn(t, join(home, 'code/journal')), join(home, 'code/my-app')); // gone elsewhere: found on disk
  assert.equal(sessionProject(openedIn(t, join(home, 'code/journal'))!).id, 'my-app');
  assert.equal(openedIn(transcript(join(home, 'code/gone')), home), null);
  assert.equal(openedIn(join(home, 'notes.jsonl'), home), null); // not a session transcript
  assert.equal(openedIn(undefined, home), null);
});

test('a sibling git worktree counts toward the project it was made from, by its .git file or, once removed, by its name', () => {
  const { home, mk } = world();
  writeFileSync(join(process.env.MC_HOME!, 'config.json'), JSON.stringify({ roots: [join(home, 'code')], summaries: join(home, 'mc/projects') }));
  reloadConfig();
  mk('mc/projects/app/PROJECT.md', summary('app', join(home, 'code/app')));
  mk('mc/projects/app-admin/PROJECT.md', summary('app-admin', join(home, 'code/app-admin')));
  mk('.git/HEAD', 'ref: refs/heads/main\n'); // the home folder itself in git, as on some laptops
  mk('code/app/.git/worktrees/fix', '');
  mk('code/lead-fix/.git', `gitdir: ${join(home, 'code/app/.git/worktrees/fix')}\n`); // any name: the .git file says
  mk('code/lead-fix/src');
  forgetKeptSummaries();

  assert.equal(sessionProject(join(home, 'code/lead-fix/src')).id, 'app');
  assert.equal(sessionProject(join(home, 'code/app-topic')).id, 'app'); // removed: by name
  assert.equal(sessionProject(join(home, 'code/app-admin-v2')).id, 'app-admin'); // the longest name wins
  assert.equal(sessionProject(join(home, 'code/apple')).id, 'unassigned'); // a name, not a prefix
  assert.equal(sessionProject(join(home, 'code/app-admin')).id, 'app-admin'); // its own summary first
  mk('code/app-site/.git/HEAD', 'ref: refs/heads/main\n'); // its own repository: never guessed by name
  assert.equal(sessionProject(join(home, 'code/app-site')).id, 'unassigned');
  mk('code/app-mobile/src'); // a plain folder still here, no git: not guessed
  assert.equal(sessionProject(join(home, 'code/app-mobile/src')).id, 'unassigned');
  mk('code/rel-fix/.git', 'gitdir: ../app/.git/worktrees/rel\n'); // git 2.48+ relative pointer
  assert.equal(sessionProject(join(home, 'code/rel-fix')).id, 'app');
});

test('settings: a missing key means the first install, so it keeps working untouched', () => {
  world();
  const s = settings();
  assert.equal(s.owner, 'Tenzin');
  assert.equal(s.timezone, 'Australia/Melbourne');
  assert.equal(s.newSummaries, 'project');
  assert.equal(s.map, true);
  assert.match(s.summaries, /stubs$/);
});

test('a summary kept in Mission Control covers its folder; a nearer PROJECT.md wins, and a tie goes to the file in the folder', () => {
  const { home, mk } = world();
  writeFileSync(join(process.env.MC_HOME!, 'config.json'), JSON.stringify({ roots: [join(home, 'code')], summaries: join(home, 'mc/projects') }));
  reloadConfig();
  mk('mc/projects/app/PROJECT.md', summary('app', join(home, 'code/app')));
  mk('mc/projects/site/PROJECT.md', summary('site', '~/nowhere/site')); // ~ is the real home: covers nothing here
  mk('code/app/src');
  mk('code/app/sub/PROJECT.md', summary('sub', join(home, 'code/app/sub')));
  mk('code/app/sub/x');
  forgetKeptSummaries();

  assert.deepEqual(projectForDir(join(home, 'code/app/src')), { id: 'app', path: join(home, 'mc/projects/app/PROJECT.md'), kept: true });
  assert.equal(projectForDir(join(home, 'code/app/sub/x'))?.id, 'sub');
  assert.equal(projectForDir(join(home, 'code/other')), null);
  assert.equal(sessionProject(join(home, 'code/app')).kept, true);

  mk('code/app/PROJECT.md', summary('own', join(home, 'code/app')));
  assert.deepEqual(projectForDir(join(home, 'code/app/src')), { id: 'own', path: join(home, 'code/app/PROJECT.md') });

  // scan reads the roots and the summaries folder.
  const ids = scan().results.flatMap((r) => (r.ok ? [r.project.id] : [])).sort();
  assert.deepEqual(ids, ['app', 'own', 'site']); // code/app/sub is inside a project: not scanned
});

test('session rules name the owner, and say where a kept summary is and where new ones go', () => {
  world({ owner: 'Sam' });
  const kept = sessionContext('app', [], { summary: '~/mc/projects/app/PROJECT.md' });
  assert.match(kept, /reports to Sam's Mission Control hub/);
  assert.match(kept, /kept in Mission Control, not in this folder: ~\/mc\/projects\/app\/PROJECT\.md/);
  assert.match(kept, /Report anything Sam must decide/);
  assert.doesNotMatch(kept, /Tenzin/);
  assert.match(sessionContext('app', []), /Keep PROJECT\.md true/);
  const none = sessionContext(null, null, { newSummaries: '~/mc/projects' });
  assert.match(none, /Put it in Mission Control's folder, ~\/mc\/projects\/<id>\/PROJECT\.md/);
  assert.match(none, /only if Sam asks/);
  assert.match(sessionContext(null, null, { root: true, rootDir: '~/code' }), /started at ~\/code, above every project/);
});

test('discover: Claude Code history and git repos, folded into repositories, newest first', () => {
  const { home, mk } = world();
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(join(process.env.MC_HOME!, 'config.json'), JSON.stringify({ summaries: join(home, 'mc/projects') }));
  reloadConfig();
  // ~/code/app: a repository, worked on in a subfolder and in a worktree.
  mk('code/app/.git/logs/HEAD', '');
  mk('code/app/server');
  mk('code/app/.claude/worktrees/w/.git', `gitdir: ${join(home, 'code/app/.git/worktrees/w')}\n`);
  mk('mc/projects/app/PROJECT.md', summary('app', join(home, 'code/app')));
  // ~/work/acme/site: a repository nobody ran Claude Code in. ~/work/old: untouched for a year.
  mk('work/acme/site/.git/logs/HEAD', '');
  mk('work/old/.git/logs/HEAD', '');
  const yearAgo = now - 365 * 86400;
  utimesSync(join(home, 'work/old/.git/logs/HEAD'), yearAgo, yearAgo);
  // ~/notes: not a repository.
  mk('notes');
  // Claude Code's transcripts: one folder per cwd.
  const line = (cwd: string) => JSON.stringify({ type: 'user', cwd, sessionId: 's' }) + '\n';
  mk('claude/projects/a/1.jsonl', '{"type":"summary"}\n' + line(join(home, 'code/app/server')));
  mk('claude/projects/a/2.jsonl', line(join(home, 'code/app/server')));
  mk('claude/projects/b/1.jsonl', line(join(home, 'code/app/.claude/worktrees/w')));
  mk('claude/projects/c/1.jsonl', line(join(home, 'notes')));
  mk('claude/projects/d/1.jsonl', line(join(home, 'code'))); // a root: Mission Control's own
  mk('claude/projects/e/1.jsonl', line(join(home, 'gone'))); // deleted since
  forgetKeptSummaries();

  const found = discover({ roots: [join(home, 'code'), join(home, 'work')], days: 90, now, home, transcripts: join(home, 'claude/projects'), keepTemp: true });
  const by = Object.fromEntries(found.map((f) => [f.folder.slice(home.length + 1), f]));
  assert.deepEqual(Object.keys(by).sort(), ['code/app', 'notes', 'work/acme/site']);
  assert.equal(by['code/app'].sessions, 3);
  assert.equal(by['code/app'].git, true);
  assert.deepEqual(by['code/app'].summary, { id: 'app', path: join(home, 'mc/projects/app/PROJECT.md'), kept: true });
  assert.equal(by['work/acme/site'].group, 'acme');
  assert.equal(by['work/acme/site'].sessions, 0);
  assert.equal(by['notes'].git, false);
  assert.equal(by['notes'].summary, null);
  assert.ok(found.every((f, i) => i === 0 || found[i - 1].last >= f.last));
});

test('transcriptCwd and repoOf read what Claude Code and git leave behind', () => {
  const { home, mk } = world();
  mk('t.jsonl', JSON.stringify({ cwd: '/a "quoted"\\path' }) + '\n');
  assert.equal(transcriptCwd(join(home, 't.jsonl')), '/a "quoted"\\path');
  assert.equal(transcriptCwd(join(home, 'missing.jsonl')), null);
  mk('r/.git/HEAD', '');
  mk('r/a/b');
  assert.deepEqual(repoOf(join(home, 'r/a/b'), home), { root: join(home, 'r'), git: true });
  assert.deepEqual(repoOf(join(home, 'loose'), home), { root: join(home, 'loose'), git: false });
});

test('init makes a Mission Control folder and its settings, and refuses to overwrite either', () => {
  const { home } = world();
  const dir = join(home, 'mission-control');
  const files = init(dir, { owner: 'Sam', timezone: 'Europe/London', roots: [join(home, 'code')], today: '2026-11-18' });
  assert.ok(files.some((l) => /^wrote .*\/mission-control\/CLAUDE\.md$/.test(l)), files.join('\n'));
  const claude = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /Sam's Mission Control/);
  assert.doesNotMatch(claude, /\{\{\w+\}\}/);
  assert.ok(statSync(join(dir, 'bin/mc')).mode & 0o100);
  const own = parseProjectMd(readFileSync(join(dir, 'projects/mission-control/PROJECT.md'), 'utf8'), 'x');
  assert.ok(own.ok, JSON.stringify(own));
  const cfg = JSON.parse(readFileSync(join(process.env.MC_HOME!, 'config.json'), 'utf8'));
  assert.equal(cfg.owner, 'Sam');
  assert.equal(cfg.newSummaries, 'mission-control');
  assert.equal(cfg.map, false);
  assert.equal(statSync(join(process.env.MC_HOME!, 'config.json')).mode & 0o777, 0o600);

  // Its own folder now counts toward mission-control.
  reloadConfig();
  forgetKeptSummaries();
  assert.equal(projectForDir(dir)?.id, 'mission-control');

  assert.throws(() => init(join(home, 'another'), { owner: 'Sam', timezone: 'UTC', roots: [], today: '2026-11-18' }), /already set up/);
  const fresh = world(); // a laptop with no Mission Control yet, but a folder in the way
  fresh.mk('full/thing.txt', 'x');
  assert.throws(() => init(join(fresh.home, 'full'), { owner: 'Sam', timezone: 'UTC', roots: [], today: '2026-11-18' }), /not empty/);
  assert.equal(existsSync(join(process.env.MC_HOME!, 'config.json')), false);
});

test('setup connects Claude Code once, keeps what was there, and dry runs write nothing', () => {
  const { home, mk } = world();
  const claudeDir = join(home, '.claude');
  const theirs = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] }, permissions: { allow: ['Bash(ls:*)'] } };
  mk('.claude/settings.json', JSON.stringify(theirs));
  const summaries = join(home, 'mc/projects');

  const dry = setup({ dry: true, summaries, claudeDir, hub: null });
  assert.ok(dry.some((s) => s.result === 'added'));
  assert.deepEqual(JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')), theirs);
  assert.equal(existsSync(join(claudeDir, 'skills/project-summary')), false);

  const first = setup({ dry: false, summaries, claudeDir, hub: null });
  const s = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
  assert.equal(s.model, 'opus');
  assert.equal(s.hooks.Stop.length, 2); // theirs, then ours
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) assert.match(JSON.stringify(s.hooks[ev]), /bin\/mc hook/);
  assert.deepEqual(s.permissions.additionalDirectories, [summaries]);
  assert.ok(s.permissions.allow.includes('Bash(ls:*)'));
  assert.ok(s.permissions.allow.some((r: string) => /bin\/mc:\*\)$/.test(r)));
  assert.ok(existsSync(join(claudeDir, 'skills/project-summary/SKILL.md')));
  assert.ok(existsSync(join(claudeDir, 'settings.json.bak-mission-control')));
  assert.deepEqual(first.find((x) => x.step === 'mission-control tools')?.result, 'skipped');

  const before = readFileSync(join(claudeDir, 'settings.json'), 'utf8');
  const again = setup({ dry: false, summaries, claudeDir, hub: null });
  assert.ok(again.filter((x) => x.step !== 'mission-control tools').every((x) => x.result === 'already'), JSON.stringify(again));
  assert.equal(readFileSync(join(claudeDir, 'settings.json'), 'utf8'), before);

  writeFileSync(join(claudeDir, 'settings.json'), '{ not json');
  assert.throws(() => setup({ dry: false, summaries, claudeDir, hub: null }), /not valid JSON/);
});

test("the public app's copies of format.ts, time.ts and cost.ts match these, byte for byte", () => {
  const app = join(import.meta.dirname, '..', 'app', 'src', 'shared');
  if (!existsSync(app)) return; // the app folder is its own repository and may not be checked out
  for (const f of ['format.ts', 'time.ts', 'cost.ts']) {
    assert.equal(readFileSync(join(app, f), 'utf8'), readFileSync(join(import.meta.dirname, '..', 'src', f), 'utf8'), `app/src/shared/${f} differs from src/${f}`);
  }
});

test("setup leaves another Mission Control's hooks and skill alone, and --replace swaps them, keeping a copy", async () => {
  const { home, mk } = world();
  const claudeDir = join(home, '.claude');
  const theirs = '~/Projects/old-mission-control/bin/mc hook';
  mk('.claude/settings.json', JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: theirs, timeout: 5 }] }],
      Stop: [{ hooks: [{ type: 'command', command: theirs, timeout: 5 }, { type: 'command', command: 'say done' }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: theirs, timeout: 10 }] }],
    },
  }));
  mk('.claude/skills/project-summary/SKILL.md', 'their skill');
  const summaries = join(home, 'mc/projects');

  const left = setup({ dry: false, summaries, claudeDir, hub: null });
  assert.equal(left.find((x) => x.step === 'Claude Code hooks')?.result, 'skipped');
  assert.match(left.find((x) => x.step === 'Claude Code hooks')!.note!, /old-mission-control.*--replace/);
  assert.equal(left.find((x) => x.step === 'project-summary skill')?.result, 'skipped');
  let s = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
  const commands = (h: Record<string, { hooks: { command: string }[] }[]>) => new Set(Object.values(h).flat().flatMap((e) => e.hooks.map((x) => x.command)));
  assert.deepEqual([...commands(s.hooks)].sort(), ['say done', theirs]); // ours not added beside theirs
  assert.equal(readFileSync(join(claudeDir, 'skills/project-summary/SKILL.md'), 'utf8'), 'their skill');

  const swapped = setup({ dry: false, summaries, claudeDir, hub: null, replace: true });
  assert.equal(swapped.find((x) => x.step === 'Claude Code hooks')?.result, 'replaced');
  s = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(s.hooks), /old-mission-control/);
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) assert.match(JSON.stringify(s.hooks[ev]), /bin\/mc hook/);
  assert.match(JSON.stringify(s.hooks.Stop), /say done/); // someone else's hook in the same entry stays
  assert.equal(swapped.find((x) => x.step === 'project-summary skill')?.result, 'replaced');
  assert.notEqual(readFileSync(join(claudeDir, 'skills/project-summary/SKILL.md'), 'utf8'), 'their skill'); // now ours
  const kept = readdirSync(join(process.env.MC_HOME!, 'backup'));
  assert.equal(readFileSync(join(process.env.MC_HOME!, 'backup', kept[0], 'project-summary/SKILL.md'), 'utf8'), 'their skill');

  const again = setup({ dry: false, summaries, claudeDir, hub: null, replace: true });
  assert.ok(again.filter((x) => x.step !== 'mission-control tools').every((x) => x.result === 'already'), JSON.stringify(again));
});

test("after --adopt, the earlier setup's hooks run this engine through its bin/mc, so setup counts them as its own", () => {
  const { home, mk } = world({ timezone: 'UTC' });
  const folder = join(home, 'Projects/mission-control');
  mk('Projects/mission-control/bin/mc', 'old');
  init(folder, { owner: 'Kaden', timezone: 'UTC', roots: [], today: '2026-11-18', adopt: true });
  const theirs = `${folder}/bin/mc hook`; // now the adopted folder's own bin/mc, which runs this engine
  mk('.claude/settings.json', JSON.stringify({ hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'].map((ev) => [ev, [{ hooks: [{ type: 'command', command: theirs }] }]])) }));
  const steps = setup({ dry: false, summaries: join(folder, 'stubs'), claudeDir: join(home, '.claude'), hub: null });
  assert.equal(steps.find((x) => x.step === 'Claude Code hooks')?.result, 'already'); // no second set beside them
});

test('init --adopt switches an earlier Mission Control folder to the engine and keeps what it replaces', () => {
  const { home, mk } = world({ timezone: 'Europe/London', scanRoot: '~/Projects', idleCap: 900 });
  const folder = join(home, 'Projects/mission-control');
  mk('Projects/mission-control/CLAUDE.md', 'their agent');
  mk('Projects/mission-control/bin/mc', '#!/bin/sh\necho theirs\n');
  mk('Projects/mission-control/PROJECT.md', summary('mission-control', folder));
  mk('Projects/mission-control/stubs/notes/PROJECT.md', summary('notes', '~/nowhere'));
  mk('Projects/app/PROJECT.md', summary('app', join(home, 'Projects/app')));
  mk('Projects/README.md', '# Projects\n<!-- PROJECTS:START -->\n<!-- PROJECTS:END -->\n');

  assert.throws(() => init(join(home, 'new-mc'), { owner: 'Kaden', timezone: 'UTC', roots: [], today: '2026-11-18' }), /another Mission Control setup[\s\S]*--adopt/);

  const done = init(folder, { owner: 'Kaden', timezone: 'Europe/London', roots: [], today: '2026-11-18', adopt: true });
  assert.ok(done.some((l) => /kept .*CLAUDE\.md\.before-engine/.test(l)));
  assert.equal(readFileSync(join(folder, 'CLAUDE.md.before-engine'), 'utf8'), 'their agent');
  assert.match(readFileSync(join(folder, 'bin/mc.before-engine'), 'utf8'), /echo theirs/);
  assert.match(readFileSync(join(folder, 'bin/mc'), 'utf8'), /exec ".*bin\/mc"/);
  assert.match(readFileSync(join(folder, 'CLAUDE.md'), 'utf8'), /Kaden's Mission Control/);
  assert.equal(readFileSync(join(folder, 'PROJECT.md'), 'utf8'), summary('mission-control', folder)); // theirs stays
  assert.deepEqual(JSON.parse(readFileSync(join(process.env.MC_HOME!, 'config.json.before-engine'), 'utf8')), { timezone: 'Europe/London', scanRoot: '~/Projects', idleCap: 900 });

  const cfg = JSON.parse(readFileSync(join(process.env.MC_HOME!, 'config.json'), 'utf8'));
  assert.equal(cfg.owner, 'Kaden');
  assert.equal(cfg.newSummaries, 'project');
  assert.equal(cfg.map, true);
  assert.equal(cfg.scanRoot, undefined); // a fresh file, not merged into theirs
  reloadConfig();
  forgetKeptSummaries();
  assert.deepEqual(settings().roots, [join(home, 'Projects')]);
  const ids = scan().results.flatMap((r) => (r.ok ? [r.project.id] : [])).sort();
  assert.deepEqual(ids, ['app', 'mission-control', 'notes']);
  assert.throws(() => init(folder, { owner: 'Kaden', timezone: 'UTC', roots: [], today: '2026-11-18', adopt: true }), /already set up/);
});

test("import-events reads an earlier setup's log, whatever it called its fields, once", () => {
  const lines = [
    JSON.stringify({ id: 'a1', session_id: 's1', project_id: 'app', event: 'SessionStart', ts: 1_800_000_000, cwd: '~/Projects/app' }),
    JSON.stringify({ id: 'a2', sessionId: 's1', projectId: 'app', type: 'UserPromptSubmit', timestamp: 1_800_000_300_000 }), // milliseconds
    JSON.stringify({ id: 'a3', session: 's1', project: 'app', kind: 'end', time: '2027-01-15T03:00:00Z' }),
    JSON.stringify({ session: 's2', project: 'web', kind: 'start', ts: 1_800_000_000 }), // no id: one from the line
    JSON.stringify({ session: 's3', kind: 'start', ts: 1_800_000_000 }), // no project
    JSON.stringify({ id: 'x', session: 's4', project: 'app', kind: 'start', ts: '2026-11-18' }), // a bare date: not a time
    'not json',
  ];
  const { events, skipped } = eventsToImport(lines.join('\n'), new Set(['imported-a1']));
  assert.equal(skipped, 3);
  assert.deepEqual(events.map((e) => [e.id.startsWith('imported-'), e.session, e.project, e.kind, e.ts]), [
    [true, 's1', 'app', 'tick', 1_800_000_300],
    [true, 's1', 'app', 'end', Date.parse('2027-01-15T03:00:00Z') / 1000],
    [true, 's2', 'web', 'start', 1_800_000_000],
  ]);
  assert.deepEqual(eventsToImport(lines[0], new Set()).events[0], { id: 'imported-a1', session: 's1', project: 'app', kind: 'start', ts: 1_800_000_000, cwd: '~/Projects/app' });
  const twice = eventsToImport(lines.join('\n') + '\n' + lines[3], new Set());
  assert.equal(twice.events.length, 4); // the repeated line once
});
