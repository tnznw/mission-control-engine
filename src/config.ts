// This laptop's Mission Control settings: ~/.mission-control/config.json (chmod 600: it holds the
// hub token, so never print or commit it). Every key is optional. A missing key means the first
// install, Tenzin's own (Tenzin, Melbourne, ~/Projects, stubs/, the README map), so that install
// keeps working untouched; `mc init` writes every key for anyone else (docs/SHELL.md).
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Config {
  hubUrl?: string; // e.g. https://missioncontrol.tenzin.awesomate.app/api/hub
  hubToken?: string;
  owner?: string; // the person the session rules name ("report anything <owner> must decide")
  timezone?: string; // IANA, for dates shown on this laptop
  roots?: string[]; // folders scanned for PROJECT.md files kept inside their projects
  summaries?: string; // the folder of summaries kept in Mission Control, away from their projects
  newSummaries?: 'mission-control' | 'project'; // where a new project's summary goes by default
  map?: boolean; // keep the project list in <first root>/README.md
  live?: boolean; // live sessions on the dashboard: sends each session's state and Claude's last message (src/live.ts)
  cacheWarn?: boolean; // hold back the first message after a session's prompt cache closed, once, with its cost (src/cache.ts)
  limits?: boolean; // each Claude account's usage limits to the hub, read every few minutes (src/limits.ts)
  accountDirs?: string[]; // the sign-in folders to read limits from: 'default' is Claude Code's own, '<dir>/*' each folder in it
  workers?: boolean; // the background workers (claude --bg) to the hub every two minutes (src/workers.ts)
  digests?: boolean; // each session's prompts and Claude's replies, trimmed, to the hub for summaries (src/digest.ts)
  feed?: string; // a status feeder: a command run every ten minutes that sends mc progress and mc workers --extras
  workerSubagents?: string[]; // subagents folders where an orchestrating session's workers run (src/workers.ts subagentWorkers)
  workerAgentType?: string; // the agent type those workers have ('*': any; none set: subagents are not read)
  answer?: string[]; // how an answer given on the page reaches its question: a command, {id} and {answer} filled in (mc answers)
}

/** This engine: src/, bin/mc, starter/, the project-summary skill. */
export const ENGINE = resolve(import.meta.dirname, '..');
export const MC_BIN = join(ENGINE, 'bin', 'mc');

export const expand = (p: string) => p.replace(/^~(?=$|\/)/, homedir());
export const tilde = (p: string) => (p === homedir() || p.startsWith(homedir() + '/') ? '~' + p.slice(homedir().length) : p);

export const mcHome = () => process.env.MC_HOME ?? join(homedir(), '.mission-control');
export const configFile = () => join(mcHome(), 'config.json');

let cached: Config | null = null;

export function config(): Config {
  if (!cached) {
    try {
      cached = JSON.parse(readFileSync(configFile(), 'utf8')) as Config;
    } catch {
      cached = {};
    }
  }
  return cached;
}

/** Forget the cached file (tests, and after saveConfig). */
export function reloadConfig(): void {
  cached = null;
}

/** Merge `patch` into the config file, keeping every other key (the token included), mode 600. */
export function saveConfig(patch: Partial<Config>): void {
  let current: Config = {};
  try {
    current = JSON.parse(readFileSync(configFile(), 'utf8')) as Config;
  } catch { /* new file */ }
  mkdirSync(mcHome(), { recursive: true, mode: 0o700 });
  writeFileSync(configFile(), JSON.stringify({ ...current, ...patch }, null, 2) + '\n', { mode: 0o600 });
  chmodSync(configFile(), 0o600);
  cached = null;
}

/** The settings with their defaults filled in. */
export function settings() {
  const c = config();
  return {
    owner: c.owner ?? 'Tenzin',
    timezone: c.timezone ?? 'Australia/Melbourne',
    roots: (c.roots ?? ['~/Projects']).map((r) => resolve(expand(r))),
    summaries: resolve(expand(c.summaries ?? join(ENGINE, 'stubs'))),
    newSummaries: c.newSummaries ?? 'project',
    map: c.map ?? true,
    live: c.live ?? false, // off unless switched on: it sends Claude's messages off the laptop
    cacheWarn: c.cacheWarn ?? false, // off unless switched on: it changes what pressing send does
    limits: c.limits ?? false, // off unless switched on: it starts Claude Code once per account every few minutes
    accountDirs: c.accountDirs ?? ['default'],
    workers: c.workers ?? false,
    digests: c.digests ?? false, // off unless switched on: it sends what sessions were asked off the laptop
    feed: c.feed ?? '',
    workerSubagents: Array.isArray(c.workerSubagents) && c.workerSubagents.every((x) => typeof x === 'string') ? c.workerSubagents : [],
    workerAgentType: typeof c.workerAgentType === 'string' ? c.workerAgentType : '',
    answer: Array.isArray(c.answer) && c.answer.every((x) => typeof x === 'string') ? c.answer : [],
  };
}
