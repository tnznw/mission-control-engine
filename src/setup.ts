// Getting someone else started (docs/SHELL.md).
//   mc init <folder>   makes their own Mission Control folder from starter/ and writes this laptop's
//                      settings. Refuses if a Mission Control is already set up here.
//   mc setup           connects Claude Code on this laptop: the hooks, the project-summary skill,
//                      leave to edit summaries kept in Mission Control, and (once there is a hub
//                      address and key) the mission-control MCP tools. Safe to run again; each step
//                      checks first. --dry-run says what it would do.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { configFile, ENGINE, MC_BIN, saveConfig, tilde } from './config.ts';

export interface InitOptions {
  owner: string;
  timezone: string;
  roots: string[]; // where their projects are; may be empty (Claude Code's history still finds them)
  today: string; // YYYY-MM-DD
}

const fill = (text: string, vars: Record<string, string>) => text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);

/** Make `dir` someone's Mission Control folder. Returns the files written. */
export function init(dir: string, o: InitOptions): string[] {
  const folder = resolve(dir);
  if (existsSync(configFile())) throw new Error(`Mission Control is already set up on this laptop (${tilde(configFile())}). Nothing changed.`);
  if (existsSync(folder) && readdirSync(folder).length) throw new Error(`${tilde(folder)} is not empty. Pick a new folder.`);
  const starter = join(ENGINE, 'starter');
  const vars = { OWNER: o.owner, TODAY: o.today, FOLDER: tilde(folder), MC: tilde(join(folder, 'bin', 'mc')), ENGINE: tilde(ENGINE) };
  const written: string[] = [];
  const put = (rel: string, text: string, mode?: number) => {
    const to = join(folder, rel);
    mkdirSync(join(to, '..'), { recursive: true });
    writeFileSync(to, text, mode ? { mode } : undefined);
    written.push(to);
  };
  put('CLAUDE.md', fill(readFileSync(join(starter, 'CLAUDE.md.tmpl'), 'utf8'), vars));
  put('README.md', fill(readFileSync(join(starter, 'README.md.tmpl'), 'utf8'), vars));
  put('.gitignore', readFileSync(join(starter, 'gitignore'), 'utf8'));
  // Mission Control's own summary is kept with the others, covering this folder.
  put('projects/mission-control/PROJECT.md', fill(readFileSync(join(starter, 'PROJECT.md.tmpl'), 'utf8'), vars));
  // bin/mc runs this engine, so the folder's CLAUDE.md can say `bin/mc` wherever the engine lives.
  put('bin/mc', `#!/bin/sh\nexec "${MC_BIN}" "$@"\n`, 0o755);
  saveConfig({
    owner: o.owner,
    timezone: o.timezone,
    roots: o.roots.map((r) => tilde(resolve(r))),
    summaries: tilde(join(folder, 'projects')),
    newSummaries: 'mission-control',
    map: false,
  });
  written.push(configFile());
  return written;
}

export interface Step { step: string; result: 'added' | 'already' | 'skipped'; note?: string }

export interface SetupOptions {
  dry: boolean;
  summaries: string; // Mission Control's summaries folder
  claudeDir?: string; // ~/.claude
  hub?: { url: string; token: string; tools?: boolean } | null; // tools false: the hub has no MCP tools
  mcp?: boolean; // run `claude mcp` (off in tests)
}

const EVENTS: [string, number][] = [['SessionStart', 5], ['UserPromptSubmit', 5], ['Stop', 5], ['SessionEnd', 10]];

/** Connect Claude Code on this laptop. Writes settings.json only if something changed, after a backup. */
export function setup(o: SetupOptions): Step[] {
  const claude = o.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const file = join(claude, 'settings.json');
  const steps: Step[] = [];
  let s: Record<string, any> = {};
  try {
    s = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    if (existsSync(file)) throw new Error(`${tilde(file)} is not valid JSON; fix it first. Nothing changed.`);
  }
  let changed = false;

  // 1. Hooks: time tracking, the session rules and the inbox. Any existing `bin/mc hook` counts.
  const cmd = `${tilde(MC_BIN)} hook`;
  const hooks = (s.hooks ??= {});
  const missing = EVENTS.filter(([ev]) => !JSON.stringify(hooks[ev] ?? []).includes('/bin/mc hook'));
  for (const [ev, timeout] of missing) (hooks[ev] ??= []).push({ hooks: [{ type: 'command', command: cmd, timeout }] });
  if (missing.length) changed = true;
  steps.push({ step: 'Claude Code hooks', result: missing.length ? 'added' : 'already', note: missing.length ? missing.map(([e]) => e).join(', ') : undefined });

  // 2. Sessions may edit summaries kept in Mission Control's folder, and run mc, without asking each time.
  const perms = (s.permissions ??= {});
  const dirs: string[] = (perms.additionalDirectories ??= []);
  const summaries = resolve(o.summaries);
  if (!dirs.some((d) => resolve(d.replace(/^~(?=$|\/)/, homedir())) === summaries)) {
    dirs.push(summaries);
    changed = true;
    steps.push({ step: 'Leave to edit summaries', result: 'added', note: tilde(summaries) });
  } else steps.push({ step: 'Leave to edit summaries', result: 'already' });
  const allow: string[] = (perms.allow ??= []);
  const rules = [`Bash(${tilde(MC_BIN)}:*)`, `Bash(${MC_BIN}:*)`].filter((r) => !allow.includes(r));
  allow.push(...rules);
  if (rules.length) changed = true;
  steps.push({ step: 'Leave to run mc', result: rules.length ? 'added' : 'already' });

  if (changed && !o.dry) {
    mkdirSync(claude, { recursive: true });
    if (existsSync(file)) copyFileSync(file, file + '.bak-mission-control');
    writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
  }

  // 3. The project-summary skill, linked so it stays in step with the engine.
  const link = join(claude, 'skills', 'project-summary');
  if (existsSync(link)) steps.push({ step: 'project-summary skill', result: 'already' });
  else {
    if (!o.dry) {
      mkdirSync(join(claude, 'skills'), { recursive: true });
      symlinkSync(join(ENGINE, '.claude', 'skills', 'project-summary'), link);
    }
    steps.push({ step: 'project-summary skill', result: 'added', note: tilde(link) });
  }

  // 4. The mission-control MCP tools, for every session (user scope). Needs the hub address and key.
  if (!o.hub) steps.push({ step: 'mission-control tools', result: 'skipped', note: 'not connected to a hub yet' });
  else if (o.hub.tools === false) steps.push({ step: 'mission-control tools', result: 'skipped', note: 'this hub has no tools yet' });
  else if (o.mcp === false) steps.push({ step: 'mission-control tools', result: 'skipped', note: 'left out' });
  else if (spawnSync('claude', ['mcp', 'get', 'mission-control'], { stdio: 'ignore' }).status === 0) steps.push({ step: 'mission-control tools', result: 'already' });
  else {
    if (!o.dry) {
      // The key goes straight to Claude Code's own config; it is never printed.
      const r = spawnSync('claude', ['mcp', 'add', '--transport', 'http', '-s', 'user', 'mission-control', `${o.hub.url}/mcp`, '--header', `Authorization: Bearer ${o.hub.token}`], { stdio: 'ignore' });
      if (r.status !== 0) throw new Error('`claude mcp add` failed: is Claude Code installed and on PATH? The other steps are done.');
    }
    steps.push({ step: 'mission-control tools', result: 'added', note: `${o.hub.url}/mcp` });
  }
  return steps;
}

export const describe = (steps: Step[], dry: boolean) =>
  steps.map((x) => `${(dry && x.result === 'added' ? 'would add' : x.result).padEnd(9)} ${x.step}${x.note ? `: ${x.note}` : ''}`).join('\n');

