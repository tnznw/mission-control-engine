// Background workers (2026-11-24): the Claude Code sessions started with `claude --bg`, as
// `claude agents` lists them for each sign-in folder on the laptop, with how hard each is working
// (its responses and tokens per model in the last ten minutes, from its transcripts; the hub prices
// them) and, from a status feeder, the workstream each is building and the work waiting for a free
// slot. A worker named <slug> or <slug>-<n> belongs to the workstream with that slug.
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expand } from './config.ts';
import { claudeBin } from './limits.ts';
import { parseUsage } from './usage.ts';

export interface Stream { slug: string; name: string; project?: string; stage?: string; done?: number; open?: number; total?: number; next?: string }
export interface Queued { slug?: string; name: string; project?: string; waiting?: string; planned?: boolean } // waiting: 'me', someone named, or none; planned: whether its plan exists (left out: not known)
export interface Extras { slots?: number; streams?: Stream[]; queue?: Queued[]; ops?: string; at?: number } // ops: the project whose session runs the workers
/** Tokens for one model (and fast mode or not) over the last ten minutes: the hub prices them. */
export interface Tokens { model: string; fast: boolean; input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; webSearch: number }
export interface Worker {
  name: string; status: string; project: string; since: number;
  session?: string; // a background session's own id: the page lists it here, not again as a working session
  parent?: string; // a subagent worker's: the session that started it, the one that can restart it
  last: number | null; responses10: number; tokens10: Tokens[];
  workstream?: string; slug?: string; stage?: string; done?: number; open?: number; total?: number; next?: string;
}
export interface Board { slots: number | null; workers: Worker[]; queue: Queued[]; ops?: string; opsSession?: string }
export interface Agent { name?: string; kind?: string; status?: string | null; cwd?: string; sessionId?: string; startedAt?: number; root?: string; files?: string[]; pid?: number; parent?: string }

/** Whether a process runs (signal 0 checks without sending anything); no pid given counts as alive. */
export function alive(pid: unknown): boolean {
  if (typeof pid !== 'number' || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === 'EPERM'; }
}

export const RECENT = 600; // seconds of work counted as "now"
export const EXTRAS_KEPT = 24 * 3600; // a feeder silent for a day: its workstreams and queue are dropped

/** Where a sign-in folder keeps its transcripts ('' is Claude Code's default, ~/.claude). */
export const projectsOf = (dir: string) => {
  const p = join(dir || join(homedir(), '.claude'), 'projects');
  try { return realpathSync(p); } catch { return p; }
};

/** The sessions alive under one sign-in folder (interactive and background), or null when
 *  `claude agents` could not say (failed, too slow, no Claude Code): then nothing is known, not
 *  "none". A status is not proof of life: a session whose daemon went away keeps its last status on
 *  disk, so its process must be running too. */
export function listAgents(dir: string, list = (env: NodeJS.ProcessEnv) => spawnSync(claudeBin(), ['agents', '--json', '--all'], { encoding: 'utf8', timeout: 20_000, env })): Agent[] | null {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(ANTHROPIC_API_KEY|CLAUDECODE|CLAUDE_CODE_(?!EXECPATH).*|CLAUDE_CONFIG_DIR)$/.test(k)) env[k] = v;
  if (dir) env.CLAUDE_CONFIG_DIR = dir;
  const r = list(env);
  if (r.status !== 0) return null;
  try {
    const all: Agent[] = JSON.parse(r.stdout);
    if (!Array.isArray(all)) return null;
    return all.filter((a) => a.status && a.sessionId && alive(a.pid)).map((a) => ({ ...a, root: projectsOf(dir) }));
  } catch {
    return null;
  }
}

/** The background sessions (claude --bg) running now under one sign-in folder; null as listAgents. */
export function runningAgents(dir: string, list?: Parameters<typeof listAgents>[1]): Agent[] | null {
  const all = listAgents(dir, list);
  return all && all.filter((a) => a.kind === 'background' && a.name);
}

/** Every sign-in folder's background workers, each session once, and the ids of every session
 *  alive (an orchestrator's subagents count only while it is); null if any folder could not be
 *  read, so a half list is never sent as the whole board. */
export function allRunning(dirs: string[], read: (dir: string) => Agent[] | null = (d) => listAgents(d)): { running: Agent[]; live: Set<string> } | null {
  const seen = new Map<string, Agent>();
  const live = new Set<string>();
  for (const d of dirs) {
    const list = read(d);
    if (!list) return null;
    for (const a of list) {
      live.add(a.sessionId!);
      if (a.kind === 'background' && a.name && !seen.has(a.sessionId!)) seen.set(a.sessionId!, a);
    }
  }
  return { running: [...seen.values()], live };
}

/** A session's transcripts: its own and its subagents', wherever its folder (a worktree) put them. */
export function sessionFiles(session: string, root: string): string[] {
  const out: string[] = [];
  let folders: string[] = [];
  try { folders = readdirSync(root); } catch { return out; }
  for (const f of folders) {
    const own = join(root, f, `${session}.jsonl`);
    try { if (statSync(own).isFile()) out.push(own); } catch { /* not here */ }
    const subs = join(root, f, session, 'subagents');
    try { for (const s of readdirSync(subs)) if (s.endsWith('.jsonl')) out.push(join(subs, s)); } catch { /* none */ }
  }
  return out;
}

/** The end of a file: a busy file's last 4 MB (ten minutes of a busy session), a quiet one's last
 *  256 KB (enough for its last response). */
function tail(path: string, now: number): string {
  try {
    const st = statSync(path);
    const bytes = st.mtimeMs / 1000 >= now - RECENT ? 4 << 20 : 256 << 10;
    const from = Math.max(0, st.size - bytes);
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(st.size - from);
      readSync(fd, buf, 0, buf.length, from);
      return buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** Responses and tokens per model in the last RECENT seconds, and the time of the newest response.
 *  A subagent's file untouched for RECENT seconds has nothing recent and is skipped. */
export function activity(files: string[], now: number, skipQuiet = true): { responses10: number; tokens10: Tokens[]; last: number | null } {
  let responses10 = 0, last: number | null = null;
  const by = new Map<string, Tokens>();
  for (const f of files) {
    if (skipQuiet && f.includes('/subagents/')) {
      try { if (statSync(f).mtimeMs / 1000 < now - RECENT) continue; } catch { continue; }
    }
    for (const r of parseUsage(tail(f, now), 0)) {
      last = Math.max(last ?? 0, r.ts);
      if (r.ts < now - RECENT) continue;
      responses10++;
      const k = r.model + (r.fast ? ' fast' : '');
      const t = by.get(k) ?? { model: r.model, fast: r.fast, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0 };
      t.input += r.input; t.output += r.output; t.cacheRead += r.cacheRead;
      t.cacheWrite5m += r.cacheWrite5m; t.cacheWrite1h += r.cacheWrite1h; t.webSearch += r.webSearch;
      by.set(k, t);
    }
  }
  return { responses10, tokens10: [...by.values()], last };
}

/** The workstream a worker builds: the longest slug its name is, or starts with followed by a dash. */
export function streamOf(name: string, streams: Stream[]): Stream | undefined {
  let best: Stream | undefined;
  for (const s of streams) {
    if (s.slug && (name === s.slug || name.startsWith(s.slug + '-')) && s.slug.length > (best?.slug.length ?? 0)) best = s;
  }
  return best;
}

/** The board the page shows: each running worker with its workstream, and the queue. */
const parentOf = (a: Agent) => (a.kind === 'subagent' && typeof a.parent === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(a.parent) ? a.parent : undefined);

/** `lastOps`: the session that ran the workers last time, used while none runs (the caller keeps it
 *  only while that session is alive). */
export function board(agents: Agent[], extras: Extras, projectOf: (cwd: string) => string, now: number, files = sessionFiles, lastOps?: string): Board {
  const fresh = !extras.at || now - extras.at < EXTRAS_KEPT;
  const streams = fresh ? extras.streams ?? [] : [];
  const claimed = new Set(agents.flatMap((a) => a.files ?? []));
  const own = (a: Agent) => files(a.sessionId!, a.root ?? projectsOf('')).filter((f) => { try { return !claimed.has(realpathSync(f)); } catch { return true; } });
  const workers = agents.map((a): Worker => {
    const s = streamOf(a.name!, streams);
    const w: Worker = {
      name: a.name!.slice(0, 100),
      status: String(a.status).slice(0, 20),
      project: s?.project ?? (a.cwd ? projectOf(a.cwd) : 'unassigned'),
      since: Math.floor((a.startedAt ?? now * 1000) / 1000),
      // A subagent's sessionId is its transcript's path, not a session id: never sent. An id over the
      // hub's 100 characters is left out rather than cut, since a cut id would match nothing.
      ...(a.kind !== 'subagent' && a.sessionId && a.sessionId.length <= 100 ? { session: a.sessionId } : {}),
      ...(parentOf(a) ? { parent: parentOf(a) } : {}),
      ...(a.files ? activity(a.files, now, false) : activity(own(a), now)),
    };
    if (s) Object.assign(w, { workstream: s.name, slug: s.slug, stage: s.stage, done: s.done, open: s.open, total: s.total, next: s.next });
    return w;
  });
  // Waiting for a slot: what the feeder queued, less anything a worker already took.
  const busy = new Set(workers.map((w) => w.slug).filter(Boolean));
  const queue = (fresh ? extras.queue ?? [] : []).filter((q) => !q.slug || !busy.has(q.slug));
  // The session that started the newest worker: messages about workers go to it, not to whichever
  // session of the project happens to be newest. With none running, the one given (kept from before).
  const opsSession = agents.filter((a) => parentOf(a)).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).map(parentOf)[0] ?? lastOps;
  return { slots: fresh ? extras.slots ?? null : null, workers: workers.sort((a, b) => a.since - b.since), queue, ...(fresh && extras.ops ? { ops: extras.ops } : {}), ...(opsSession ? { opsSession } : {}) };
}

/** A feeder's extras, checked before they are kept: anything else in them is a feeder's mistake. */
export function checkExtras(x: unknown): Extras {
  const bad = (why: string) => { throw new Error(`mc workers --extras: ${why}. It takes {"slots": 8, "streams": [{"slug", "name", ...}], "queue": [{"name", "slug"?, "project"?, "waiting"?, "planned"?}]}`); };
  if (typeof x !== 'object' || x === null || Array.isArray(x)) bad('not a JSON object');
  const o = x as Record<string, unknown>;
  if (o.slots !== undefined && o.slots !== null && !(Number.isInteger(o.slots) && (o.slots as number) > 0)) bad('slots is not a whole number above 0');
  const str = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  if (o.streams !== undefined && !(Array.isArray(o.streams) && o.streams.every((s) => s && typeof s === 'object' && str((s as Stream).slug) && str((s as Stream).name)))) bad('streams is not a list of workstreams with a slug and a name');
  if (o.queue !== undefined && !(Array.isArray(o.queue) && o.queue.every((q) => q && typeof q === 'object' && str((q as Queued).name)))) bad('queue is not a list of items with a name');
  if ((o.slots as number) > 100) bad('slots is over 100');
  // Cut to what the hub takes, so one long name never costs a whole push.
  const cut = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);
  const count = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? Math.min(v as number, 1000) : undefined);
  const drop = <T extends object>(x: T) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)) as T;
  const streams = ((o.streams as Stream[] | undefined) ?? []).map((s) => drop({
    slug: cut(s.slug, 200)!, name: cut(s.name, 200)!, project: cut(s.project, 100), stage: cut(s.stage, 100),
    done: count(s.done), open: count(s.open), total: count(s.total), next: cut(s.next, 300),
  }));
  if (((o.queue as Queued[] | undefined) ?? []).slice(0, 300).some((q) => q.planned !== undefined && typeof q.planned !== 'boolean')) bad('a queue item\'s planned is not true or false');
  const queue = ((o.queue as Queued[] | undefined) ?? []).slice(0, 300).map((q) => drop({ name: cut(q.name, 200)!, slug: cut(q.slug, 200), project: cut(q.project, 100), waiting: cut(q.waiting, 100), planned: q.planned }));
  return { slots: (o.slots as number | undefined) ?? undefined, streams, queue, ...(cut(o.ops, 100) ? { ops: cut(o.ops, 100) } : {}) };
}

export function readExtras(file: string): Extras {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

/** Paths matching a pattern whose `*` stands for any part of one folder name (no `**`). */
export function expandGlob(pattern: string): string[] {
  const parts = resolve(expand(pattern)).split('/');
  let found = [parts[0] === '' ? '/' : parts[0]];
  for (const part of parts.slice(1)) {
    if (!part) continue;
    if (!part.includes('*')) { found = found.map((f) => join(f, part)); continue; }
    const re = new RegExp('^' + part.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    found = found.flatMap((f) => { try { return readdirSync(f).filter((n) => re.test(n)).map((n) => join(f, n)); } catch { return []; } });
  }
  return found.filter((f) => { try { statSync(f); return true; } catch { return false; } });
}

export const SUBAGENT_QUIET = 15 * 60; // a subagent silent this long is not counted as running
export const SUBAGENT_TOOL_MAX = 3 * 3600; // unless it is inside one tool call (a CI watch, a long test run), up to this

/** The first line of a file, however long (a subagent's first line carries its whole prompt). */
function firstLine(path: string, cap = 1 << 20): string {
  const fd = openSync(path, 'r');
  try {
    let text = '';
    const b = Buffer.alloc(16384);
    for (let at = 0; at < cap; at += b.length) {
      const n = readSync(fd, b, 0, b.length, at);
      if (!n) break;
      text += b.subarray(0, n).toString('utf8');
      const i = text.indexOf('\n');
      if (i >= 0) return text.slice(0, i);
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

/** Workers an orchestrating session runs as its own background subagents (the Agent tool): each one
 *  whose meta file says background and has the worker agent type ('*': any type, so every background
 *  agent a session starts counts), whose transcript grew in the last
 *  SUBAGENT_QUIET seconds and does not end on a final reply, named by the first word of its
 *  description, its folder the one its latest turn ran in. */
export function subagentWorkers(patterns: string[], agentType: string, now: number, live?: Set<string>): Agent[] {
  const seen = new Set<string>();
  const found: Agent[] = [];
  for (const dir of patterns.flatMap(expandGlob)) {
    // <project>/<session>/subagents: they run inside that session, so only while it is alive.
    if (live && !live.has(basename(dirname(dir)))) continue;
    let names: string[] = [];
    try { names = readdirSync(dir).filter((n) => n.endsWith('.meta.json')); } catch { continue; }
    for (const n of names) {
      const meta = join(dir, n), transcript = meta.replace(/\.meta\.json$/, '.jsonl');
      let real: string, st;
      try { real = realpathSync(transcript); st = statSync(real); } catch { continue; }
      if (seen.has(real)) continue; // one folder linked from several sign-ins
      seen.add(real);
      const quiet = now - st.mtimeMs / 1000;
      if (quiet > SUBAGENT_TOOL_MAX) continue;
      let m: unknown;
      try { m = JSON.parse(readFileSync(meta, 'utf8')); } catch { continue; }
      const o = (m && typeof m === 'object' ? m : {}) as { agentType?: unknown; description?: unknown; requestShape?: unknown; finished?: unknown };
      if ((agentType !== '*' && o.agentType !== agentType) || o.requestShape !== 'background' || typeof o.description !== 'string' || !o.description.trim()) continue;
      if (o.finished === true) continue; // Claude Code marks a finished subagent in its meta file
      const lines = tail(real, now).trim().split('\n');
      let last: { type?: string; cwd?: string; message?: { stop_reason?: string } } | null = null;
      for (let i = lines.length - 1; i >= 0 && !last; i--) {
        try { const e = JSON.parse(lines[i]); if (e.type === 'assistant' || e.type === 'user') last = e; } catch { /* a cut line */ }
      }
      const stop = last?.type === 'assistant' ? last.message?.stop_reason : undefined;
      if (stop && stop !== 'tool_use') continue; // a final reply (end_turn, stop_sequence, max_tokens): it finished
      // Quiet for a while: still running only while it waits inside one tool call.
      if (quiet > SUBAGENT_QUIET && stop !== 'tool_use') continue;
      let started = st.birthtimeMs || st.mtimeMs;
      try { const t = Date.parse(JSON.parse(firstLine(real)).timestamp); if (t) started = t; } catch { /* the file's own time */ }
      // Its folder now (the worktree it works in), for the project when no workstream names one.
      // Named by its slug when the description reads '<slug> worker ...', else by the description.
      const slug = /^(\S+)\s+worker\b/i.exec(o.description.trim());
      // <session>/subagents/: the session that started it, the one that runs the workers.
      const parent = basename(dirname(dir)); // as the liveness check names it: a linked folder's real path may not
      found.push({ name: (slug ? slug[1] : o.description.trim()).slice(0, 100), kind: 'subagent', status: 'busy', cwd: last?.cwd ?? '', sessionId: real, startedAt: started, files: [real], ...(/^[A-Za-z0-9_-]{1,100}$/.test(parent) ? { parent } : {}) });
    }
  }
  // One row per name: a worker started again replaces the one before.
  const newest = new Map<string, Agent>();
  for (const a of found) if (!newest.has(a.name!) || (a.startedAt ?? 0) > (newest.get(a.name!)!.startedAt ?? 0)) newest.set(a.name!, a);
  return [...newest.values()];
}
