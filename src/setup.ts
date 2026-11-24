// Getting someone else started (docs/SHELL.md).
//   mc init <folder>          makes their own Mission Control folder from starter/ and writes this
//                             laptop's settings. Refuses if Mission Control is already set up here.
//   mc init <folder> --adopt  switches an earlier, home-made Mission Control (for example one built
//                             from a setup prompt) to this engine: that folder becomes the engine's,
//                             its summaries stay where they are, and what it replaces is kept.
//   mc setup [--replace]      connects Claude Code on this laptop: the hooks, the project-summary
//                             skill, leave to edit summaries, and (once there is a hub address and key)
//                             the mission-control MCP tools. Safe to run again. Another setup's hooks or
//                             skill are only swapped out with --replace. --dry-run says what it would do.
//   mc import-events [file]   brings an earlier setup's raw time events into this one's outbox.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { configFile, ENGINE, MC_BIN, mcHome, saveConfig, tilde, type Config } from './config.ts';
import type { ActivityEvent, EventKind } from './time.ts';

export interface InitOptions {
  owner: string;
  timezone: string;
  roots: string[]; // where their projects are; may be empty (Claude Code's history still finds them)
  today: string; // YYYY-MM-DD
  adopt?: boolean; // `folder` is an earlier Mission Control folder to switch over
}

const fill = (text: string, vars: Record<string, string>) => text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);

/** The config file as it is, or null if there is none. */
export function rawConfig(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(configFile(), 'utf8'));
  } catch {
    return existsSync(configFile()) ? {} : null;
  }
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

/** Move `path` aside to `<path>.before-engine` (or a dated name if that is taken). */
function keepAside(path: string): string {
  let to = `${path}.before-engine`;
  if (existsSync(to)) to = `${path}.before-engine-${stamp()}`;
  renameSync(path, to);
  return to;
}

/** Make `dir` someone's Mission Control folder, or (adopt) switch an earlier one over. Returns what
 *  was written or kept aside. */
export function init(dir: string, o: InitOptions): string[] {
  const folder = resolve(dir);
  const old = rawConfig();
  if (old && (old.owner || old.summaries)) throw new Error(`Mission Control is already set up on this laptop (${tilde(configFile())}). Nothing changed.`);
  if (old && !o.adopt) {
    throw new Error(
      `${tilde(configFile())} is from another Mission Control setup (it has ${Object.keys(old).join(', ') || 'nothing readable'}). Nothing changed.\n` +
        `To switch this laptop to the engine and keep that setup's projects: mc init <its Mission Control folder> --owner "Your name" --adopt`,
    );
  }
  if (o.adopt) {
    if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(`${tilde(folder)} is not a folder. --adopt takes the earlier Mission Control folder.`);
  } else if (existsSync(folder) && readdirSync(folder).length) {
    throw new Error(`${tilde(folder)} is not empty. Pick a new folder, or add --adopt if it is an earlier Mission Control folder.`);
  }

  const starter = join(ENGINE, 'starter');
  const vars = { OWNER: o.owner, TODAY: o.today, FOLDER: tilde(folder), MC: tilde(join(folder, 'bin', 'mc')), ENGINE: tilde(ENGINE) };
  const done: string[] = [];
  const put = (rel: string, text: string, mode?: number) => {
    const to = join(folder, rel);
    mkdirSync(dirname(to), { recursive: true });
    if (o.adopt && existsSync(to)) done.push(`kept ${tilde(keepAside(to))}`);
    writeFileSync(to, text, mode ? { mode } : undefined);
    done.push(`wrote ${tilde(to)}`);
  };

  put('CLAUDE.md', fill(readFileSync(join(starter, 'CLAUDE.md.tmpl'), 'utf8'), vars));
  // bin/mc runs this engine, so the folder's CLAUDE.md can say `bin/mc` wherever the engine lives.
  put('bin/mc', `#!/bin/sh\nexec "${MC_BIN}" "$@"\n`, 0o755);

  let settings: Config;
  if (o.adopt) {
    // The earlier setup keeps its summaries in each project's folder, and stubs in this folder's stubs/.
    // Its own PROJECT.md (if any) stays; otherwise this folder gets one.
    if (!existsSync(join(folder, 'PROJECT.md'))) put('PROJECT.md', fill(readFileSync(join(starter, 'PROJECT.md.tmpl'), 'utf8'), vars));
    mkdirSync(join(folder, 'stubs'), { recursive: true });
    const roots = (o.roots.length ? o.roots : [dirname(folder)]).map((r) => resolve(r));
    const readme = join(roots[0], 'README.md');
    settings = {
      owner: o.owner,
      timezone: o.timezone,
      roots: roots.map(tilde),
      summaries: tilde(join(folder, 'stubs')),
      newSummaries: 'project',
      // The earlier setup's project list in <root>/README.md, between the same markers: keep it current.
      map: existsSync(readme) && readFileSync(readme, 'utf8').includes('<!-- PROJECTS:START'),
    };
    if (old) {
      const to = keepAside(configFile());
      done.push(`kept ${tilde(to)}`);
    }
  } else {
    put('README.md', fill(readFileSync(join(starter, 'README.md.tmpl'), 'utf8'), vars));
    put('.gitignore', readFileSync(join(starter, 'gitignore'), 'utf8'));
    // Mission Control's own summary is kept with the others, covering this folder.
    put('projects/mission-control/PROJECT.md', fill(readFileSync(join(starter, 'PROJECT.md.tmpl'), 'utf8'), vars));
    settings = {
      owner: o.owner,
      timezone: o.timezone,
      roots: o.roots.map((r) => tilde(resolve(r))),
      summaries: tilde(join(folder, 'projects')),
      newSummaries: 'mission-control',
      map: false,
    };
  }
  saveConfig(settings);
  done.push(`wrote ${tilde(configFile())}`);
  return done;
}

export interface Step { step: string; result: 'added' | 'already' | 'skipped' | 'replaced'; note?: string }

export interface SetupOptions {
  dry: boolean;
  summaries: string; // Mission Control's summaries folder
  claudeDir?: string; // ~/.claude
  hub?: { url: string; token: string; tools?: boolean } | null; // tools false: the hub has no MCP tools
  mcp?: boolean; // run `claude mcp` (off in tests)
  replace?: boolean; // swap out another setup's hooks and skill
  live?: boolean; // live sessions on (settings().live): add their hooks too
}

type HookEvent = { event: string; timeout: number; matcher?: string };
const EVENTS: HookEvent[] = [
  { event: 'SessionStart', timeout: 5 }, { event: 'UserPromptSubmit', timeout: 5 }, { event: 'Stop', timeout: 5 }, { event: 'SessionEnd', timeout: 10 },
];
/* Live sessions (src/live.ts), only when switched on. A permission request waits up to half an hour
   for Allow or Deny from the dashboard while Claude Code shows its own prompt; the question box is
   followed open and closed. */
const LIVE_EVENTS: HookEvent[] = [
  { event: 'PermissionRequest', timeout: 1800 },
  { event: 'PreToolUse', matcher: 'AskUserQuestion', timeout: 10 },
  { event: 'PostToolUse', matcher: 'AskUserQuestion', timeout: 10 },
];
const hookName = (e: HookEvent) => (e.matcher ? `${e.event} (${e.matcher})` : e.event);

type HookEntry = { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] };

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

  // 1. Hooks: time tracking, the session rules and the inbox. Ours run this engine's bin/mc; another
  //    `…/bin/mc hook` belongs to another setup and would double every event, so it is swapped out
  //    only with --replace, and ours are not added beside it.
  const cmd = `${tilde(MC_BIN)} hook`;
  // Also ours: a hook whose bin/mc is a Mission Control folder's own bin/mc, which runs this engine
  // (`mc init` writes one; after --adopt an earlier setup's hooks point at it).
  const wrapper = (path: string) => {
    try {
      return readFileSync(path.replace(/^~(?=\/)/, homedir()), 'utf8').includes(`exec "${MC_BIN}"`);
    } catch {
      return false;
    }
  };
  const ours = (c?: string) => !!c && (c === cmd || c === `${MC_BIN} hook` || (/^\S+\/bin\/mc\s+hook$/.test(c.trim()) && wrapper(c.trim().split(/\s+/)[0])));
  const other = (c?: string) => !!c && /\/bin\/mc\s+hook\b/.test(c) && !ours(c);
  const hooks: Record<string, HookEntry[]> = (s.hooks ??= {});
  const others = new Set<string>();
  for (const ev of Object.keys(hooks)) for (const e of hooks[ev] ?? []) for (const h of e.hooks ?? []) if (other(h.command)) others.add(h.command!);
  if (others.size && !o.replace) {
    steps.push({ step: 'Claude Code hooks', result: 'skipped', note: `another Mission Control's hooks are installed (${[...others].join(', ')}). mc setup --replace swaps them for this one` });
  } else {
    if (others.size) {
      for (const ev of Object.keys(hooks)) {
        hooks[ev] = (hooks[ev] ?? [])
          .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !other(h.command)) }))
          .filter((e) => e.hooks.length);
        if (!hooks[ev].length) delete hooks[ev];
      }
      changed = true;
    }
    const wanted = o.live ? [...EVENTS, ...LIVE_EVENTS] : EVENTS;
    const missing = wanted.filter((w) => !(hooks[w.event] ?? []).some((e) => (e.matcher ?? '') === (w.matcher ?? '') && (e.hooks ?? []).some((h) => ours(h.command))));
    for (const w of missing) (hooks[w.event] ??= []).push({ ...(w.matcher ? { matcher: w.matcher } : {}), hooks: [{ type: 'command', command: cmd, timeout: w.timeout }] });
    if (missing.length) changed = true;
    steps.push({
      step: 'Claude Code hooks',
      result: others.size ? 'replaced' : missing.length ? 'added' : 'already',
      note: others.size ? `${[...others].join(', ')} swapped for ${cmd}` : missing.length ? missing.map(hookName).join(', ') : undefined,
    });
  }

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

  // 3. The project-summary skill, linked so it stays in step with the engine. Another one is moved to
  //    ~/.mission-control/backup/ with --replace, never deleted.
  const link = join(claude, 'skills', 'project-summary');
  const mine = join(ENGINE, '.claude', 'skills', 'project-summary');
  let present = false;
  try {
    lstatSync(link);
    present = true;
  } catch { /* none */ }
  let isMine = false;
  try {
    isMine = present && realpathSync(link) === realpathSync(mine);
  } catch { /* a broken link: not ours */ }
  if (isMine) steps.push({ step: 'project-summary skill', result: 'already' });
  else if (present && !o.replace) steps.push({ step: 'project-summary skill', result: 'skipped', note: `a different one is installed (${tilde(link)}). mc setup --replace keeps a copy in ${tilde(join(mcHome(), 'backup'))} and links this one` });
  else {
    let note = tilde(link);
    if (!o.dry) {
      if (present) {
        const to = join(mcHome(), 'backup', stamp(), 'project-summary');
        mkdirSync(dirname(to), { recursive: true });
        try {
          renameSync(link, to);
        } catch {
          cpSync(link, to, { recursive: true });
          rmSync(link, { recursive: true, force: true });
        }
        note = `the earlier one kept in ${tilde(to)}`;
      }
      mkdirSync(join(claude, 'skills'), { recursive: true });
      symlinkSync(mine, link);
    }
    steps.push({ step: 'project-summary skill', result: present ? 'replaced' : 'added', note });
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
  steps.map((x) => `${(dry && (x.result === 'added' || x.result === 'replaced') ? `would ${x.result === 'added' ? 'add' : 'swap'}` : x.result).padEnd(9)} ${x.step}${x.note ? `: ${x.note}` : ''}`).join('\n');

const KIND: Record<string, EventKind> = { start: 'start', sessionstart: 'start', tick: 'tick', userpromptsubmit: 'tick', prompt: 'tick', stop: 'tick', end: 'end', sessionend: 'end' };

/** One line of an earlier setup's event log as an event here, or null if it can't be read as one.
 *  Field names vary between home-made setups, so the usual spellings are all accepted. */
export function eventFromLine(line: string): ActivityEvent | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const pick = (...keys: string[]) => keys.map((k) => o[k]).find((v) => v !== undefined && v !== null && v !== '');
  const session = pick('session', 'session_id', 'sessionId');
  const project = pick('project', 'project_id', 'projectId');
  const kindRaw = String(pick('kind', 'event', 'type', 'hook_event_name') ?? '').toLowerCase().replace(/[^a-z]/g, '');
  let ts = pick('ts', 'time', 'timestamp', 'at');
  if (typeof ts === 'string') ts = /^\d+(\.\d+)?$/.test(ts) ? Number(ts) : /\dT\d/.test(ts) ? Date.parse(ts) / 1000 : NaN;
  if (typeof ts === 'number' && ts > 1e12) ts = ts / 1000; // milliseconds
  if (typeof session !== 'string' || typeof project !== 'string' || typeof ts !== 'number' || !Number.isFinite(ts) || ts < 1e9) return null;
  const id = pick('id', 'event_id', 'uuid');
  return {
    id: `imported-${typeof id === 'string' || typeof id === 'number' ? id : createHash('sha256').update(line).digest('hex').slice(0, 24)}`,
    session,
    project,
    kind: KIND[kindRaw] ?? 'tick',
    ts: Math.floor(ts),
    cwd: String(pick('cwd', 'dir', 'folder') ?? ''),
  };
}

/** Events from an earlier setup's log that aren't in this outbox yet. */
export function eventsToImport(text: string, have: Set<string>): { events: ActivityEvent[]; skipped: number } {
  const events: ActivityEvent[] = [];
  let skipped = 0;
  const seen = new Set(have);
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const e = eventFromLine(line);
    if (!e) skipped++;
    else if (!seen.has(e.id)) {
      seen.add(e.id);
      events.push(e);
    }
  }
  return { events, skipped };
}
