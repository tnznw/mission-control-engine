// Mission Control for other people (docs/SHELL.md): settings, summaries kept in Mission Control,
// discover, init and setup. Every test works in a fresh temp folder with its own MC_HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reloadConfig, settings } from '../src/config.ts';
import { forgetKeptSummaries, projectForDir, scan, sessionProject } from '../src/scan.ts';
import { sessionContext } from '../src/protocol.ts';
import { discover, repoOf, transcriptCwd } from '../src/discover.ts';
import { init, setup } from '../src/setup.ts';
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
  assert.ok(files.includes(join(dir, 'CLAUDE.md')));
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

test("the public app's copies of format.ts and time.ts match these, byte for byte", () => {
  const app = join(import.meta.dirname, '..', 'app', 'src', 'shared');
  if (!existsSync(app)) return; // the app folder is its own repository and may not be checked out
  for (const f of ['format.ts', 'time.ts']) {
    assert.equal(readFileSync(join(app, f), 'utf8'), readFileSync(join(import.meta.dirname, '..', 'src', f), 'utf8'), `app/src/shared/${f} differs from src/${f}`);
  }
});
