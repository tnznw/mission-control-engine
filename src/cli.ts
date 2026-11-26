// mc — Mission Control laptop client. See docs/ARCHITECTURE.md and docs/PROTOCOL.md.
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, projectForDir, sessionProject, defaultRoots, worktreeHome, scratchpadHome, openedIn } from './scan.ts';
import { writeMap } from './map.ts';
import { append, readAll, unsent, usageOutbox, MC_HOME } from './outbox.ts';
import { attribute, collect, transcriptFiles, withLock } from './usage.ts';
import { digestsSince } from './digest.ts';
import { costOf, tokensOf, type UsageRow } from './cost.ts';
import { activeSeconds, hours, type EventKind } from './time.ts';
import { parseProjectMd, type Project } from './format.ts';
import { removeTasks } from './dismiss.ts';
import { sessionContext, type InboxMessage } from './protocol.ts';
import { config, MC_BIN, mcHome, reloadConfig, saveConfig, settings, tilde, type Config } from './config.ts';
import { discover } from './discover.ts';
import { describe, eventsToImport, init, liveHooksInstalled, rawConfig, setup } from './setup.ts';
import { accountLabels, claudeStatePath, currentAccount, readAccounts, updateAccounts, vsCodeAccount } from './account.ts';
import { awaitDecision, pushFile, pushOutcome, sendInBackground, updateFor, watchAnswer, type HookInput, type LiveUpdate } from './live.ts';
import { cacheState, cacheWarning } from './cache.ts';
import { limitDirs, readLimits } from './limits.ts';
import { allRunning, board, checkExtras, readExtras, subagentWorkers } from './workers.ts';
import { messageText, noteSession, recheckStart, relayPass, type Down } from './relay.ts';

// Hub address + token: env wins, else ~/.mission-control/config.json (chmod 600, never committed).
const cfg = config();
const HUB = process.env.MC_HUB_URL ?? cfg.hubUrl; // e.g. https://missioncontrol.tenzin.awesomate.app/api/hub
const TOKEN = process.env.MC_HUB_TOKEN ?? cfg.hubToken;
const TZ = settings().timezone;

/** Rebuild the project list in ~/Projects/README.md from the PROJECT.md files. Local only, and only
 *  where the settings ask for it (the first install; `mc init` turns it off). */
function refreshMap(): string | null {
  if (!settings().map) return null;
  const root = process.env.MC_MAP_ROOT ?? defaultRoots()[0];
  const projects = scan().results.flatMap((r) => (r.ok ? [r.project] : []));
  return writeMap(root, projects) ? join(root, 'README.md') : null;
}

async function hub(path: string, body?: unknown, timeoutMs = 5000): Promise<Response> {
  if (!HUB || !TOKEN) throw new Error('hub not configured: ~/.mission-control/config.json needs hubUrl + hubToken');
  return fetch(HUB + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function hubJson<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const res = await hub(path, body, timeoutMs);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`hub ${path}: ${res.status} ${(data as { error?: string }).error ?? ''}`.trim());
  return data as T;
}

/** The project for the current directory, or exit with a clear message. */
function here(): { id: string; path: string } {
  const p = projectForDir(process.cwd());
  if (!p) throw new Error('no PROJECT.md here or above — create one first (project-summary skill)');
  return p;
}

/** Midnight starting 'YYYY-MM-DD' in time zone `tz`, as epoch seconds; NaN for a date that isn't real. */
export function midnightIn(day: string, tz: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return NaN;
  const utc = Date.parse(day + 'T00:00:00Z');
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== day) return NaN; // 2026-02-31
  const local = (t: number) => Date.parse(new Date(t).toLocaleString('en-US', { timeZone: tz }) + ' UTC');
  const t = utc - (local(utc) - utc); // that zone's offset, then once more across a DST change
  return Math.floor((utc - (local(t) - t)) / 1000);
}

/** "90", "90m", "1h", "1h30m", "1.5h" → minutes. */
export function parseMinutes(s: string): number | null {
  const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+)m?)?$/.exec(s.trim());
  if (!m || (!m[1] && !m[2])) return null;
  const total = Math.round(Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0));
  return total > 0 ? total : null;
}

/** A command in a detached process, once per `every` seconds: `mc limits` starts Claude Code once
 *  per account, the feed reads GitHub. The first hook in each slot claims it by creating the slot's
 *  file (exclusive create, so two hooks at once start one run); earlier slots' files are removed. */
function inBackgroundEvery(name: string, every: number, argv: string[], now = Date.now()): void {
  const dir = join(mcHome(), `${name}-slots`);
  const slot = String(Math.floor(now / 1000 / every));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { closeSync(openSync(join(dir, slot), 'wx')); } catch { return; } // taken: this slot has its run
  // Only earlier slots: a late hook from an earlier slot must not free this one.
  for (const f of readdirSync(dir)) if (Number(f) < Number(slot)) rmSync(join(dir, f), { force: true });
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
const MC_SH = () => fileURLToPath(new URL('../bin/mc', import.meta.url));
// A hub that answered 404 to a claim has no relay (an older hub): asked again an hour later.
const NO_CLAIMS = () => join(mcHome(), 'hub-no-claim');
const hubClaims = () => { try { return Date.now() - statSync(NO_CLAIMS()).mtimeMs > 3_600_000; } catch { return true; } };
const noClaims = () => { try { writeFileSync(NO_CLAIMS(), ''); } catch { /* asked again next time */ } };

/** The environment for a command mc runs for the person (a feeder, an answer command): none of the
 *  hook's Claude Code session variables, and no API key, so a command that runs claude uses the
 *  subscription in its own sign-in, as every session here does. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(ANTHROPIC_API_KEY|CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_CONFIG_DIR)$/.test(k)) env[k] = v;
  return env;
}

/** Run a command (no shell unless argv says so) in the home folder with cleanEnv, in its own process
 *  group so the time limit stops its children too. code is null when it could not run to an end. */
function runArgv(argv: string[], o: { timeoutMs: number }): Promise<{ code: number | null; why: string; out: string; late?: boolean }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: homedir(), env: cleanEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: null, why: `could not start: ${(e as Error).message}`, out: '' });
    }
    let out = '', late = false;
    child.stdout!.on('data', (d) => { out = (out + d).slice(-40000); });
    child.stderr!.on('data', (d) => { out = (out + d).slice(-40000); });
    const timer = setTimeout(() => { late = true; try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } }, o.timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, why: `could not start: ${e.message}`, out }); });
    // Its own exit, not the pipes closing: a child it left running must not hold the answer up.
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (late) return resolve({ code: null, why: `stopped after ${o.timeoutMs / 1000} s`, out, late: true });
      setTimeout(() => resolve(code === null ? { code: null, why: `killed (${signal})`, out, late: true } : { code, why: '', out }), 50); // the last output
    });
  });
}
const EXAMPLE_ANSWER = '["python3", "/path/tracker.py", "answer", "--", "{id}", "{answer}"]';
const WORKERS_FILE = () => join(mcHome(), 'workers-extra.json');

/** `mc usage` in a detached process: reading transcripts must never hold up a session. */
function inBackground(argv: string[]): void {
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

function usageInBackground(): void {
  const mc = fileURLToPath(new URL('../bin/mc', import.meta.url));
  const child = spawn('/bin/sh', [mc, 'usage', '--quiet'], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

/** Take tasks Tenzin marked done or dismissed on the dashboard off a PROJECT.md (src/dismiss.ts).
 *  Returns the project as it now reads, or null if nothing changed. Never throws. */
function dropTasks(path: string, tasks: string[]): Project | null {
  try {
    if (!tasks.length) return null;
    const r = removeTasks(readFileSync(path, 'utf8'), tasks);
    if (!r) return null;
    writeFileSync(path, r.text);
    const p = parseProjectMd(r.text, path);
    return p.ok ? p.project : null;
  } catch {
    return null;
  }
}

/** Which of `tasks` the PROJECT.md at `path` no longer lists. */
function offFile(path: string, tasks: string[]): string[] {
  try {
    const r = parseProjectMd(readFileSync(path, 'utf8'), path);
    return r.ok ? tasks.filter((t) => !r.project.next.some((x) => x.task === t)) : [];
  } catch {
    return [];
  }
}

const USAGE_BATCH = 2000;
const DIGEST_BATCH = 5; // sessions per POST /digests: each is up to ~80 KB

/** One session as the hub's /sessions lists it. */
interface SessionRow { session: string; project: string; projects: { id: string; hours: number; usd: number }[]; cwd: string; start: number; end: number; hours: number; usd: number; moved: boolean }

const HOOK_KIND: Record<string, EventKind> = {
  SessionStart: 'start',
  UserPromptSubmit: 'tick',
  Stop: 'tick',
  SessionEnd: 'end',
};

/** A permission request, on the dashboard until Allow or Deny there, or until Claude Code's own
 *  prompt is answered (seen in the transcript: Claude Code does not stop this hook then). Either
 *  way the session is working again, and the dashboard hears so at once. */
async function permissionHook(u: LiveUpdate, input: HookInput): Promise<string> {
  const working = () => {
    try { sendInBackground({ ...u, state: 'working', request: undefined, since: Math.floor(Date.now() / 1000), seq: Date.now() }); } catch { /* best effort */ }
  };
  const stopped = () => { working(); process.exit(0); };
  process.once('SIGTERM', stopped);
  process.once('SIGINT', stopped);
  const { out, end } = await awaitDecision(u, {
    post: (x) => hub('/live', x, 3000).then((r) => r.ok),
    poll: (session, request) => hubJson<{ pending: boolean; decision: 'allow' | 'deny' | null; answers?: unknown }>(`/live/${encodeURIComponent(session)}/decision?request=${encodeURIComponent(request)}`, undefined, 5000),
    answered: watchAnswer(input.transcript_path, input.tool_name ?? '', input.tool_input),
    input: input.tool_input,
  });
  process.off('SIGTERM', stopped);
  process.off('SIGINT', stopped);
  if (end === 'expired') {
    // No longer listening: the card keeps the request, without buttons that would do nothing.
    const left = u.state === 'question' ? { ...u, request: undefined }
      : { ...u, state: 'waiting' as const, request: undefined, text: `Waiting in Claude Code for permission to use ${u.request?.tool ?? 'a tool'}:\n${u.request?.summary ?? ''}` };
    const cache = cacheState(input.transcript_path) ?? undefined; // half an hour on: the cache has moved
    try { sendInBackground({ ...left, cache, seq: Date.now() }); } catch { /* best effort */ }
  } else if (end !== 'none') working();
  return out;
}

/** The clipboard's text (macOS, Wayland, X11, Windows); never printed. */
function readClipboard(): string {
  const tries: [string, string[]][] = [['pbpaste', []], ['wl-paste', ['--no-newline']], ['xclip', ['-selection', 'clipboard', '-o']], ['powershell', ['-NoProfile', '-Command', 'Get-Clipboard']]];
  for (const [cmd, args] of tries) {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  throw new Error('could not read the clipboard: copy the key first, or run without --paste to type it');
}

/** A line typed without echo (or piped in). */
async function askHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return (await readStdin()).split('\n')[0] ?? '';
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const done = (err?: Error) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stdout.write('\n');
      if (err) reject(err); else resolve(value);
    };
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const commands: Record<string, (args: string[]) => Promise<number>> = {
  async scan() {
    const { results, duplicateIds } = scan();
    for (const r of results) {
      if (r.ok) console.log(`ok   ${r.project.id.padEnd(28)} ${r.project.status.padEnd(8)} ${tilde(r.project.path)}`);
      else console.log(`FAIL ${tilde(r.path)}\n     ${r.errors.join('\n     ')}`);
    }
    for (const id of duplicateIds) console.log(`FAIL duplicate id: ${id}`);
    const bad = results.filter((r) => !r.ok).length + duplicateIds.length;
    console.log(`\n${results.length} files, ${bad} problems`);
    return bad ? 1 : 0;
  },

  // mc which [dir...]: the project id for each folder (default: this one), one per line, in order.
  async which(args) {
    const dirs = args.length ? args : [process.cwd()];
    let missed = 0;
    for (const d of dirs) {
      const w = projectForDir(resolve(d)) ? null : worktreeHome(resolve(d)); // as sessions are counted
      const p = projectForDir(w ?? resolve(d));
      if (!p) missed++;
      console.log(p ? p.id : 'unassigned');
    }
    return missed ? 1 : 0;
  },

  // Called by Claude Code hooks. Must never fail or stall a session: every path returns 0.
  // SessionStart prints the protocol + this project's inbox (stdout becomes session context);
  // it makes ONE hub call, capped at 1.5 s, and carries on without it if the hub is slow.
  // SessionEnd sends this project's PROJECT.md and the queued time events.
  // With live sessions on (src/live.ts), each prompt, stop, question box and end also sends the
  // session's state, from a detached process; a permission request waits for the dashboard.
  async hook() {
    try {
      const input = JSON.parse((await readStdin()) || '{}');
      if (!input.session_id) return 0;
      const cwd: string = input.cwd ?? process.cwd();
      const sp = sessionProject(cwd); // a project, mission-control at the top of ~/Projects, or unassigned
      // The first message after the session's prompt cache closed: held back once, with its cost
      // (src/cache.ts). Local only: the transcript's tail and a marker file.
      if (input.hook_event_name === 'UserPromptSubmit' && settings().cacheWarn) {
        const warn = cacheWarning(cacheState(input.transcript_path), input.session_id, Math.floor(Date.now() / 1000), join(mcHome(), 'cache'));
        if (warn) {
          await new Promise<void>((r) => process.stdout.write(warn, () => r()));
          return 0;
        }
      }
      // A session working in its own scratchpad shows the folder it started in (the page's Open).
      const live = settings().live && HUB ? updateFor({ ...input, cwd: scratchpadHome(cwd) ?? cwd }, sp.id) : null;
      // One working in another project's folder (an aletheia session asked to do something in
      // journal) also says where it was opened: the card reads "aletheia, working in journal".
      if (live) {
        const opened = openedIn(input.transcript_path, cwd);
        const home = opened ? sessionProject(opened).id : null;
        if (home && home !== sp.id && home !== 'unassigned') live.home = home;
      }
      if (input.hook_event_name === 'PermissionRequest') {
        const out = live ? await permissionHook(live, { ...input, cwd }) : '';
        // Written before the exit, or the decision could be lost on the way to Claude Code.
        if (out) await new Promise<void>((r) => process.stdout.write(out, () => r()));
        return 0;
      }
      if (live) {
        try { sendInBackground(live); } catch { /* the dashboard misses one update; the next replaces it */ }
      }
      const kind = HOOK_KIND[input.hook_event_name];
      if (!kind) return 0;
      append({ id: randomUUID(), session: input.session_id, project: sp.id, kind, ts: Math.floor(Date.now() / 1000), cwd: tilde(cwd), account: currentAccount() });
      // The relay finds a project's open sessions by these notes (src/relay.ts).
      if (settings().live) { try { noteSession(mcHome(), input.session_id, sp.id, kind === 'end', Math.floor(Date.now() / 1000)); } catch { /* next event notes it */ } }
      if (HUB) {
        const s = settings();
        try {
          if (s.limits) inBackgroundEvery('limits', 300, ['/bin/sh', MC_SH(), 'limits', '--push', '--quiet']);
          if (s.workers) inBackgroundEvery('workers', 120, ['/bin/sh', MC_SH(), 'workers', '--push', '--quiet']);
          if (s.feed) inBackgroundEvery('feed', 600, ['/bin/sh', MC_SH(), 'feed-run']);
          if (s.answer.length) inBackgroundEvery('answers', 60, ['/bin/sh', MC_SH(), 'answers', '--apply', '--quiet']);
          // Asked on the page for fresh figures (Refresh on Claude accounts): read them now, not in five minutes.
          if (s.limits) inBackgroundEvery('asks', 60, ['/bin/sh', MC_SH(), 'asks', '--quiet']);
          // Messages sent from the page to a project's session: put where that session waits for them.
          if (s.live) inBackgroundEvery('relays', 60, ['/bin/sh', MC_SH(), 'relays', '--quiet']);
          // What each session was asked and answered, for the page's summaries; again at its end.
          if (s.digests && kind !== 'end') inBackgroundEvery('digests', 600, ['/bin/sh', MC_SH(), 'digests', '--quiet']);
          if (s.digests && kind === 'end') inBackground(['/bin/sh', MC_SH(), 'digests', '--quiet']);
        } catch { /* next event tries again */ }
      }

      if (kind === 'start') {
        // The inbox is for a project's own session: a root session works through the MCP tools.
        // Not connected to a hub yet (a new install): no inbox to fetch, so nothing to say about one.
        let inbox: InboxMessage[] | null = HUB ? null : [];
        if (sp.path && HUB) {
          // With the relay (live on), the session claims what it is shown, so no other session is
          // handed the same; a claim whose answer is lost to the 1.5 s cap is asked again by the
          // relay, which hands those over at the session's stop. Live off: the plain list, every
          // start, until a session closes each with mc done. One call either way: a hub without
          // claims answers 404, and is asked for the plain list for the next hour.
          inbox = settings().live && hubClaims()
            ? await hub('/messages/claim', { project: sp.id, session: input.session_id }, 1500).then(async (r) => {
              if (r.status === 404) { noClaims(); return null; }
              if (!r.ok) throw new Error(String(r.status));
              return ((await r.json()) as { messages: InboxMessage[] }).messages;
            }).catch(() => {
              try { recheckStart(mcHome(), input.session_id, sp.id); } catch { /* the page can Close them */ }
              return null;
            })
            : await hubJson<{ messages: InboxMessage[] }>(`/messages?project=${encodeURIComponent(sp.id)}&status=open&direction=to_project`, undefined, 1500)
              .then((r) => r.messages).catch(() => null);
        }
        // Done/Dismiss from the dashboard: take those lines off PROJECT.md here (a local edit, no
        // network), so the session neither asks Tenzin about them nor writes them back.
        let removed: string[] = [];
        if (sp.path && inbox) {
          const dismissed = inbox.flatMap((m) => (m.dismissedTask ? [m.dismissedTask] : []));
          dropTasks(sp.path, dismissed);
          removed = offFile(sp.path, dismissed);
          inbox = inbox.filter((m) => !m.dismissedTask || !removed.includes(m.dismissedTask));
        }
        const s = settings();
        process.stdout.write(sessionContext(sp.path ? sp.id : null, inbox, {
          root: sp.root,
          rootDir: sp.root ? tilde(cwd) : undefined,
          session: input.session_id,
          removed,
          summary: sp.kept && sp.path ? tilde(sp.path) : undefined,
          newSummaries: s.newSummaries === 'mission-control' ? tilde(s.summaries) : undefined,
          live: s.live && !!HUB && liveHooksInstalled(),
        }));
      }

      if (kind === 'end' && HUB) {
        if (sp.path) {
          const r = parseProjectMd(readFileSync(sp.path, 'utf8'), sp.path);
          // The hub answers with any dismissed task the file still has: take it off and send again.
          const res = r.ok ? await hubJson<{ dismissed?: string[] }>('/project', r.project).catch(() => null) : null;
          const fixed = res?.dismissed?.length ? dropTasks(sp.path, res.dismissed) : null;
          if (fixed) await hub('/project', fixed).catch(() => null);
        }
        await commands.flush([]).catch(() => 0);
      }
      if (kind === 'end') {
        try { refreshMap(); } catch { /* the map is a nicety; never let it touch the session */ }
        try { usageInBackground(); } catch { /* next session end catches up */ }
      }
    } catch {
      /* swallow: Mission Control must never break a session */
    }
    return 0;
  },

  // mc workers [--push] [--quiet]: the background workers running now, how hard each is working,
  // and the queue (src/workers.ts). mc workers --extras < file.json: a feeder's workstreams, queue
  // and slot count, kept for the next push.
  async workers(args) {
    if (args.includes('--extras')) {
      let raw: unknown;
      try { raw = JSON.parse((await readStdin()) || '{}'); } catch { throw new Error('mc workers --extras: not JSON'); }
      const x = checkExtras(raw);
      writeFileSync(WORKERS_FILE(), JSON.stringify({ ...x, at: Math.floor(Date.now() / 1000) }), { mode: 0o600 });
      console.log(`kept ${x.streams!.length} workstreams and ${x.queue!.length} queued`);
      return 0;
    }
    // Every sign-in folder's workers (each account's claude --bg sessions are listed under its own).
    const sessions = allRunning(limitDirs(settings().accountDirs));
    // And the workers an orchestrating session runs as its own background subagents.
    const s = settings();
    const agents = sessions && [...sessions.running, ...(s.workerSubagents.length && s.workerAgentType ? subagentWorkers(s.workerSubagents, s.workerAgentType, Math.floor(Date.now() / 1000), sessions.live) : [])];
    if (!agents) {
      if (!args.includes('--quiet')) console.log('Could not list the background workers (claude agents failed or was too slow). Nothing sent.');
      return 1;
    }
    // The session that runs the workers, kept between runs: while no worker runs (the moment the page
    // asks it to start queued work) it is still the one to tell, as long as it is alive.
    const opsFile = join(mcHome(), 'ops-session');
    let lastOps: string | undefined;
    try { const v = readFileSync(opsFile, 'utf8').trim(); if (sessions!.live.has(v)) lastOps = v; } catch { /* none yet */ }
    const b = board(agents, readExtras(WORKERS_FILE()), (cwd) => sessionProject(worktreeHome(cwd) ?? cwd).id, Math.floor(Date.now() / 1000), undefined, lastOps);
    if (b.opsSession) { try { writeFileSync(opsFile, b.opsSession, { mode: 0o600 }); } catch { /* next run */ } }
    if (!args.includes('--quiet')) {
      console.log(`${b.workers.length} running${b.slots ? ` of ${b.slots} slots` : ''}, ${b.queue.length} queued`);
      for (const w of b.workers) {
        const cost = w.tokens10.reduce((sum, t) => sum + (costOf({ ...t, id: '', session: '', project: '', ts: 0 }) ?? 0), 0);
        console.log(`  ${w.name.padEnd(30)} ${w.status.padEnd(8)} ${(w.workstream ?? w.project).slice(0, 40).padEnd(40)} $${cost.toFixed(2)}/10 min${w.total ? `  step ${w.done ?? 0}/${w.total}` : ''}`);
      }
      for (const q of b.queue) console.log(`  queued: ${q.name}${q.planned === true ? ' (planned)' : q.planned === false ? ' (needs a plan)' : ''}`);
    }
    if (args.includes('--push') && HUB) {
      const r = await hub('/workers', { ...b, at: Math.floor(Date.now() / 1000) }, 10_000).catch(() => null);
      if (!args.includes('--quiet')) console.log(r?.ok ? 'sent to the hub' : `the hub did not take it${r ? ` (${r.status}: ${(await r.text()).slice(0, 300)})` : ''}`);
      if (!r?.ok) return 1;
    }
    return 0;
  },

  // mc answers [--apply] [--quiet]: answers given on the page to a feeder's questions (mc progress
  // sends them with an id). --apply hands each to the answer command (mc config answer), with {id}
  // and {answer} filled in as separate arguments, never through a shell, then tells the hub: handed
  // over (exit 0) or refused (any other exit: answered already, no such question). One that could
  // not run (timed out, killed, no such program) stays waiting for the next run. One run at a time.
  // From the hooks every minute, and from a feeder's own wait (tracker.py ask --wait).
  async answers(args) {
    const quiet = args.includes('--quiet');
    if (!HUB) throw new Error('not connected to a hub (mc connect)');
    const done = await withLock(join(mcHome(), 'answers.lock'), async () => {
      const r = await hubJson<{ answers: { id: string; project: string; answer: string }[] }>('/answers', undefined, 10_000);
      const cmd = settings().answer;
      // Handed over but the hub did not hear: said again, never handed over twice.
      const keptFile = join(mcHome(), 'answers-handed.json');
      let kept: Record<string, { ok: boolean; note: string }> = {};
      try { kept = JSON.parse(readFileSync(keptFile, 'utf8')); } catch { /* none yet */ }
      // Keyed by project, question and the answer itself: a replacement answer is a new one.
      const keyOf = (a: { id: string; project: string; answer: string }) => JSON.stringify([a.project, a.id, a.answer]);
      const listed = new Set(r.answers.map(keyOf));
      for (const k of Object.keys(kept)) if (!listed.has(k)) delete kept[k]; // the hub has it, or it was replaced
      const keep = () => writeFileSync(keptFile, JSON.stringify(kept), { mode: 0o600 });
      for (const a of r.answers) {
        const k = keyOf(a);
        if (!quiet) console.log(`${a.project} ${a.id}: ${a.answer.replace(/\s+/g, ' ').slice(0, 120)}`);
        if (!args.includes('--apply')) continue;
        if (!cmd.length) throw new Error(`no answer command: mc config answer '${EXAMPLE_ANSWER}'`);
        try {
          if (!kept[k]) {
            // Whole arguments only, so an answer is always one argument and never part of a shell line.
            const argv = cmd.map((x) => (x === '{id}' ? a.id : x === '{answer}' ? a.answer : x));
            const run = await runArgv(argv, { timeoutMs: 30_000 });
            if (run.code === null && !run.late) { // could not start: try again next time
              if (!quiet) console.log(`  not handed over yet: ${run.why}`);
              continue;
            }
            // A command that ran out of time may have taken it: reported refused, never run again for it.
            kept[k] = run.code === 0 ? { ok: true, note: '' } : { ok: false, note: (run.late ? run.why : run.out.trim() || `exit ${run.code}`).slice(-300) };
            keep();
          }
          const told = await hub(`/answers/${encodeURIComponent(a.id)}/applied`, { project: a.project, ...kept[k] }, 10_000).catch(() => null);
          if (told?.ok || told?.status === 404) { delete kept[k]; keep(); }
          if (!quiet) console.log(told?.ok ? '  done' : told?.status === 404 ? '  the hub no longer has it waiting' : '  the hub did not hear yet: said again next run');
        } catch (e) {
          if (!quiet) console.log(`  skipped: ${(e as Error).message}`);
        }
      }
      if (!quiet && !r.answers.length) console.log('No answers waiting.');
      return 0;
    });
    if (done === 'busy' && !quiet) console.log('Another mc answers is running.');
    return 0;
  },

  // mc asks [--quiet]: what the page asked this laptop for since it last sent it (the Refresh button on
  // Claude accounts asks for every account's limits), done now. A hub without /asks: nothing asked.
  async asks(args) {
    if (!HUB) return 0;
    const quiet = args.includes('--quiet');
    const res = await hub('/asks', undefined, 10_000).catch((e: Error) => e);
    if (res instanceof Error || (!res.ok && res.status !== 404)) {
      if (!quiet) console.log(`Could not ask the hub: ${res instanceof Error ? res.message : `${res.status}`}`);
      return 0;
    }
    const r = (res.ok ? await res.json().catch(() => ({})) : {}) as { limits?: boolean; limitsAsked?: number | null };
    // An ask without its time could never be answered (the hub clears an ask by its time): left alone.
    if (!r.limits || !(Number(r.limitsAsked) > 0)) { if (!quiet) console.log('Nothing asked.'); return 0; }
    if (!settings().limits) { if (!quiet) console.log('Your page asked for fresh limits, but limits are off on this laptop (mc config limits on).'); return 0; }
    // The ask's time goes back with the push, so the hub clears that ask and no other.
    await commands.limits(['--push', '--answers', String(r.limitsAsked ?? 0), ...(quiet ? ['--quiet'] : [])]);
    return 0;
  },

  // mc feed-run: the status feeder (mc config feed), from the hooks every ten minutes. It runs in
  // the home folder with none of the session's Claude Code variables, at most five minutes, and
  // its output goes to ~/.mission-control/feed.log, so a failing feeder can be looked into.
  async ['feed-run']() {
    const feed = settings().feed;
    if (!feed) return 0;
    const started = new Date().toISOString();
    const run = await runArgv(['/bin/sh', '-c', feed], { timeoutMs: 300_000 });
    writeFileSync(join(mcHome(), 'feed.log'), `${started} ${feed}\n${run.code === null ? run.why : `exit ${run.code}`}\n${run.out}`, { mode: 0o600 });
    return run.code ?? 1;
  },

  // mc limits [--push] [--quiet]: each account's usage limits, read from Claude Code (src/limits.ts)
  // for every sign-in folder in the settings (mc config accounts); --push sends them to the hub.
  async limits(args) {
    const quiet = args.includes('--quiet');
    const i = args.indexOf('--answers');
    const answers = i >= 0 ? Number(args[i + 1]) || 0 : 0; // the page's ask this run answers (mc asks)
    // One reading at a time: the five-minute run and a Refresh can fall in the same minute.
    const read = await withLock(join(mcHome(), 'limits.lock'), () => readLimits(limitDirs(settings().accountDirs)));
    if (read === 'busy') { if (!quiet) console.log('Another mc limits is reading the accounts now.'); return 0; }
    const { accounts: all, missed } = read;
    if (!quiet) {
      let seen: ReturnType<typeof readAccounts> = {};
      try { seen = readAccounts(); } catch { /* names are only for show */ }
      const when = (t: number | null) => (t ? new Date(t * 1000).toLocaleString('en-AU', { timeZone: settings().timezone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : 'not started');
      for (const a of all) {
        console.log(`${(seen[a.id]?.label ?? a.id).padEnd(20)} ${a.plan ?? ''}`);
        for (const w of a.windows) console.log(`  ${w.label.padEnd(16)} ${String(Math.round(w.percent)).padStart(3)}%  resets ${when(w.resetsAt)}`);
      }
      for (const m of missed) console.log(`${tilde(m.dir || '~ (default sign-in)')}: ${m.why}`);
      if (!all.length && !missed.length) console.log('No sign-in folders found in ' + settings().accountDirs.join(', '));
    }
    // An ask is answered even when no account could be read, so a Refresh never repeats every minute.
    if (args.includes('--push') && HUB && (all.length || answers)) {
      const signedIn = vsCodeAccount();
      const r = await hub('/limits', { accounts: all, ...(answers ? { answers } : {}), ...(signedIn !== undefined ? { signedIn } : {}) }, 10_000).catch(() => null);
      if (!quiet) console.log(r?.ok ? `sent ${all.length} account(s) to the hub` : 'the hub did not take them');
    }
    return 0;
  },

  // One live-session update, sent from a detached process by the hook (src/live.ts). Silent.
  async ['live-push'](args) {
    if (!args[0]) return 0;
    await pushFile(args[0], async (u) => {
      const r = await hub('/live', u, 5000);
      return pushOutcome(r.status, r.headers.get('content-type'));
    }).catch(() => null);
    return 0;
  },

  async flush() {
    const { events, commit } = unsent();
    if (!events.length) return 0;
    await hubJson('/activity', { events });
    commit();
    console.log(`sent ${events.length} events`);
    return 0;
  },

  // Token counts from Claude Code transcripts since the last run, attributed to projects by the
  // same session events as time, queued in usage.jsonl and sent to the hub (which prices them).
  // The SessionEnd hook runs this in the background; run it by hand to catch up or to check.
  // --since YYYY-MM-DD also reads transcripts from that day on, once: AI use from before Mission
  // Control was set up, counted toward projects by folder (there are no session events to go by).
  async usage(args) {
    const quiet = args.includes('--quiet');
    const si = args.indexOf('--since');
    const since = si >= 0 ? args[si + 1] : undefined;
    const sinceTs = since ? midnightIn(since, TZ) : NaN;
    if (si >= 0 && !Number.isFinite(sinceTs)) throw new Error('usage: mc usage --since YYYY-MM-DD (a real date)');
    let backfilled = 0;
    const r = await withLock(join(MC_HOME, 'usage.lock'), async () => {
      const events = readAll();
      if (since) {
        const file = join(MC_HOME, 'usage-backfill-state.json');
        rmSync(file, { force: true });
        const back = collect(file, () => sinceTs);
        // Only what the regular reading never covered: anything from its start on is counted already.
        let from = events[0]?.ts ?? Math.floor(Date.now() / 1000);
        try { from = JSON.parse(readFileSync(join(MC_HOME, 'usage-state.json'), 'utf8')).since ?? from; } catch { /* first run */ }
        const older = back.rows.filter((x) => x.ts < from);
        usageOutbox.append(attribute(older, events, (cwd) => sessionProject(cwd).id));
        backfilled = older.length;
        rmSync(file, { force: true });
      }
      const { rows, files, bytes, save } = collect(join(MC_HOME, 'usage-state.json'), () => events[0]?.ts ?? Math.floor(Date.now() / 1000));
      usageOutbox.append(attribute(rows, events, (cwd) => sessionProject(cwd).id));
      save();
      let sent = 0, error = '';
      if (HUB) {
        const { items, markSent } = usageOutbox.unsent();
        try {
          for (; sent < items.length; sent += Math.min(USAGE_BATCH, items.length - sent)) {
            await hubJson('/usage', { rows: items.slice(sent, sent + USAGE_BATCH) }, 30_000);
            markSent(Math.min(sent + USAGE_BATCH, items.length));
          }
        } catch (e) {
          error = e instanceof Error ? e.message : String(e); // kept in the outbox for next time
        }
      }
      return { found: rows.length, files, bytes, sent, error };
    });
    if (quiet) return 0;
    if (r === 'busy') { console.log('another mc usage is running'); return 0; }
    console.log(`read ${(r.bytes / 1e6).toFixed(1)} MB from ${r.files} transcripts: ${r.found} responses${backfilled ? ` (and ${backfilled} from --since ${since})` : ''}; sent ${r.sent} to the hub${r.error ? ` (stopped: ${r.error})` : ''}`);
    // This month from the local log, at API prices (the hub's reports are the real ones).
    const month = new Date().toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 7);
    const seen = new Map<string, UsageRow>();
    for (const x of usageOutbox.readAll()) if (new Date(x.ts * 1000).toLocaleDateString('en-CA', { timeZone: TZ }).startsWith(month)) seen.set(x.id, x);
    const byProject = new Map<string, { usd: number; tokens: number }>();
    for (const x of seen.values()) {
      const t = byProject.get(x.project) ?? { usd: 0, tokens: 0 };
      t.usd += costOf(x) ?? 0; t.tokens += tokensOf(x);
      byProject.set(x.project, t);
    }
    console.log(`\n${month}, at API prices (not what you're billed):`);
    for (const [p, t] of [...byProject].sort((a, b) => b[1].usd - a[1].usd)) console.log(`${p.padEnd(28)} ${('$' + t.usd.toFixed(2)).padStart(9)}  ${(t.tokens / 1e6).toFixed(1).padStart(6)}M tokens`);
    return r.error ? 1 : 0;
  },

  // mc digests [--since YYYY-MM-DD] [--quiet]: what each session was asked and what Claude answered
  // at the end of each turn, trimmed and with secrets taken out (src/digest.ts), sent to the hub so
  // the page can summarise a session, a project or a day. The hooks run it every ten minutes and at
  // each session's end with `mc config digests on`. The first run reads the last two weeks;
  // --since reads from an earlier day too.
  async digests(args) {
    const quiet = args.includes('--quiet');
    const si = args.indexOf('--since');
    const since = si >= 0 ? args[si + 1] : undefined;
    const sinceTs = since ? midnightIn(since, TZ) : NaN;
    if (si >= 0 && !Number.isFinite(sinceTs)) throw new Error('usage: mc digests [--since YYYY-MM-DD] (a real date)');
    if (!HUB) throw new Error('not connected to a hub: mc connect <address>');
    const r = await withLock(join(MC_HOME, 'digests.lock'), async () => {
      const stateFile = join(MC_HOME, 'digests-state.json');
      const started = Math.floor(Date.now() / 1000);
      let last = started - 14 * 86400;
      try { last = JSON.parse(readFileSync(stateFile, 'utf8')).since ?? last; } catch { /* first run: two weeks back */ }
      const from = Number.isFinite(sinceTs) ? Math.min(sinceTs, last) : last;
      const known = new Map<string, string>();
      const projectOf = (cwd: string) => {
        if (!cwd) return 'unassigned';
        let id = known.get(cwd);
        if (!id) { id = sessionProject(cwd).id; known.set(cwd, id); }
        return id;
      };
      const homeOf = (file: string) => { const o = openedIn(file); return o ? sessionProject(o).id : ''; };
      // A minute's overlap: a transcript written while the last run read it is read on from its offset.
      const { digests, save } = digestsSince(transcriptFiles(), from - 60, join(MC_HOME, 'digests'), projectOf, homeOf);
      let sent = 0;
      for (; sent < digests.length; sent += Math.min(DIGEST_BATCH, digests.length - sent)) {
        await hubJson('/digests', { digests: digests.slice(sent, sent + DIGEST_BATCH) }, 30_000);
      }
      save(); // only once all went: a failed send reads the same lines again next time
      writeFileSync(stateFile, JSON.stringify({ since: started }), { mode: 0o600 });
      return { sent };
    });
    if (quiet) return 0;
    if (r === 'busy') { console.log('another mc digests is running'); return 0; }
    console.log(`sent ${r.sent} session digest${r.sent === 1 ? '' : 's'} to the hub`);
    return 0;
  },

  // mc sessions [--days 7] [--project id]: recent Claude Code sessions, hours and API value.
  async sessions(args) {
    const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
    const q = new URLSearchParams({ days: opt('--days') ?? '7' });
    const project = opt('--project');
    if (project) q.set('project', project);
    const { sessions } = await hubJson<{ sessions: SessionRow[] }>(`/sessions?${q}`);
    if (!sessions.length) console.log('No sessions in that window.');
    const at = (ts: number, o: Intl.DateTimeFormatOptions) => new Date(ts * 1000).toLocaleString('en-AU', { timeZone: TZ, ...o });
    for (const s of sessions) {
      const split = s.projects.length > 1 ? `  [${s.projects.map((p) => `${p.id} ${p.hours} h`).join(', ')}]` : '';
      console.log(`${s.session.slice(0, 8)}  ${at(s.start, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} to ${at(s.end, { hour: 'numeric', minute: '2-digit' })}  ${String(s.hours).padStart(4)} h  ${('$' + s.usd.toFixed(2)).padStart(8)}  ${s.project}${s.moved ? ' (moved)' : ''}  ${s.cwd}${split}`);
    }
    return 0;
  },

  // mc assign <session> <project> | mc assign <session> --undo: count a whole session's time and
  // API value toward another project. The raw log stays; the hub applies the move in every report.
  async assign(args) {
    const [session, project] = args;
    if (!session || !project) throw new Error('usage: mc assign <session id or its first 8 characters> <project id>   (or --undo)');
    const res = await hub(`/sessions/${encodeURIComponent(session)}/move`, { project: project === '--undo' ? null : project });
    const r = (await res.json().catch(() => ({}))) as { session?: string; project?: string; hours?: number; usd?: number; error?: string };
    if (!res.ok) throw new Error(r.error ?? `hub: ${res.status}`);
    console.log(`session ${r.session!.slice(0, 8)} (${r.hours} h, $${r.usd!.toFixed(2)}) now counts toward ${r.project}`);
    return 0;
  },

  async push() {
    const { results, duplicateIds } = scan();
    if (results.some((r) => !r.ok) || duplicateIds.length) {
      console.error('refusing to push: run `mc scan` and fix the problems first');
      return 1;
    }
    const projects = results.flatMap((r) => (r.ok ? [r.project] : []));
    const res = await hubJson<{ dismissed?: Record<string, string[]> }>('/index', { projects });
    console.log(`pushed ${projects.length} projects`);
    // The names given to Claude accounts (mc account name). A hub without accounts answers 404: fine.
    let labels: { id: string; label: string }[] = [];
    try { labels = accountLabels(); } catch { /* accounts.json unreadable: names go with a later push */ }
    if (labels.length) await hubJson('/accounts', { accounts: labels }).catch(() => null);
    // Tasks marked done or dismissed on the dashboard come off each PROJECT.md, then that project goes again.
    for (const [id, tasks] of Object.entries(res.dismissed ?? {})) {
      const p = projects.find((x) => x.id === id);
      const fixed = p ? dropTasks(p.path, tasks) : null;
      if (fixed) {
        await hubJson('/project', fixed);
        console.log(`took ${p!.next.length - fixed.next.length} done or dismissed task(s) off ${tilde(p!.path)}`);
      } else if (p) console.log(`${tilde(p.path)} still has dismissed task(s) mc could not take off safely: ${tasks.join('; ')}`);
    }
    refreshMap();
    return 0;
  },

  // mc forget <id...> | --missing — clear deleted or merged projects off the hub's "not found" list.
  // The hub refuses any project that is still present, so this can't drop a live one.
  async forget(args) {
    let ids = args.filter((a) => !a.startsWith('--'));
    if (args.includes('--missing')) {
      const { projects } = await hubJson<{ projects: { id: string; missing: boolean }[] }>('/projects');
      ids = [...ids, ...projects.filter((p) => p.missing).map((p) => p.id)];
    }
    if (!ids.length) throw new Error('usage: mc forget <id> [id...]  or  mc forget --missing');
    let bad = 0;
    for (const id of [...new Set(ids)]) {
      const res = await hub(`/projects/${encodeURIComponent(id)}/forget`, {});
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) console.log(`forgot ${id}`);
      else { bad++; console.log(`kept   ${id}: ${data.error ?? res.status}`); }
    }
    return bad ? 1 : 0;
  },

  // Rebuild the project list in ~/Projects/README.md (push and every SessionEnd do this too).
  async map() {
    const changed = refreshMap();
    console.log(changed ? `updated ${tilde(changed)}` : 'project map already up to date');
    return 0;
  },

  // This project's open messages from Mission Control.
  async inbox() {
    const p = here();
    const { messages } = await hubJson<{ messages: InboxMessage[] }>(`/messages?project=${encodeURIComponent(p.id)}&status=open&direction=to_project`);
    if (!messages.length) console.log(`No open messages for ${p.id}.`);
    for (const m of messages) console.log(`${m.id}  ${m.kind}: ${m.body}`);
    return 0;
  },

  // mc relays: messages sent from the page down to a project's sessions (src/relay.ts). Run once a
  // minute by the hooks and by waiting sessions' inbox watchers.
  async relays(args) {
    if (!HUB || !settings().live || !hubClaims()) return 0; // a hub without claims has no relay
    const quiet = args.includes('--quiet');
    const claims = {
      claim: (id: string, session: string) => hub(`/messages/${encodeURIComponent(id)}/claim`, { session }, 10_000).then(async (r) => {
        if (r.status === 404) { noClaims(); throw new Error('this hub has no relay'); }
        if (!r.ok) throw new Error(`hub claim: ${r.status}`);
        return ((await r.json()) as { claimed?: boolean }).claimed === true;
      }),
      // Kept and tried again next pass when the hub does not answer.
      release: (id: string, session: string) => hubJson<{ released: boolean }>(`/messages/${encodeURIComponent(id)}/release`, { session }, 10_000).then((x) => x.released === true),
      startClaim: (project: string, session: string) => hubJson<{ messages: Down[] }>('/messages/claim', { project, session }, 10_000).then((x) => x.messages),
    };
    const r = await withLock(join(mcHome(), 'relays.lock'), async () => {
      const { messages } = await hubJson<{ messages: Down[] }>('/messages?status=open&direction=to_project', undefined, 10_000);
      return relayPass(mcHome(), messages, Math.floor(Date.now() / 1000), (m) => messageText(m, tilde(MC_BIN), settings().owner), claims);
    }).catch((e: Error) => { if (!quiet) console.error(e.message); return null; });
    if (r === 'busy') { if (!quiet) console.log('Another mc relays is running.'); return 0; }
    if (r && !quiet) {
      for (const q of r.queued) console.log(`${q.id} -> session ${q.session}`);
      for (const id of r.released) console.log(`${id} given back: its session stopped waiting`);
      if (!r.queued.length && !r.released.length) console.log('Nothing to hand over.');
    }
    return 0;
  },

  // mc done <message id> [reply...]
  async done(args) {
    const [id, ...reply] = args;
    if (!id) throw new Error('usage: mc done <message id> [reply]');
    await hubJson(`/messages/${encodeURIComponent(id)}/done`, reply.length ? { reply: reply.join(' ') } : {});
    console.log('closed');
    return 0;
  },

  // mc progress < progress.json: where every project stands, from a status feeder such as a project
  // tracker (engine/README.md, "Progress"). The whole list each time: a project left out loses its row.
  async progress(args) {
    const text = await readStdin();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = null; }
    // The hub replaces the whole list: refuse anything that isn't one, rather than clear it.
    const list = (body as { projects?: unknown } | null)?.projects;
    if (!Array.isArray(list) || !list.every((p) => typeof (p as { project?: unknown })?.project === 'string')) {
      throw new Error('mc progress reads JSON on stdin: {"projects": [{"project": "<id>", ...}, ...]}. Nothing sent.');
    }
    if (!list.length && !args.includes('--clear')) throw new Error('no projects in it: that would clear your page\'s progress. Add --clear if that is what you want. Nothing sent.');
    const r = await hubJson<{ projects: number }>('/progress', body, 30_000);
    console.log(`sent progress for ${r.projects} projects`);
    return 0;
  },

  // mc account | mc account list | mc account name <id> <label>: the Claude accounts signed in to
  // Claude Code on this laptop (src/account.ts). Emails stay here; the hub gets the names given.
  async account(args) {
    const [sub, id, ...words] = args;
    if (sub === 'name') {
      if (!id || !readAccounts()[id] || !words.join(' ').trim()) throw new Error('usage: mc account name <id> <name>   (the ids: mc account list)');
      const seen = updateAccounts((all) => { all[id].label = words.join(' ').trim().slice(0, 80); });
      // A hub without /accounts yet (404): the name is saved here and goes with a later push.
      const sent = HUB ? await hubJson('/accounts', { accounts: accountLabels(seen) }).then(() => true, () => false) : false;
      console.log(`${id} is now "${seen[id].label}"${sent ? ' here and on your page' : ' here; your page gets it on a later mc push'}`);
      return 0;
    }
    const now = currentAccount();
    if (sub === 'list') {
      const all = readAccounts();
      if (!Object.keys(all).length) console.log('No Claude account seen yet.');
      for (const [k, a] of Object.entries(all).sort((x, y) => y[1].last - x[1].last)) {
        const when = new Date(a.last * 1000).toLocaleDateString('en-CA', { timeZone: TZ });
        console.log(`${k}${k === now ? ' *' : '  '} ${(a.label ?? '(no name)').padEnd(16)} ${a.email.padEnd(32)} ${a.org}  last seen ${when}`);
      }
      return 0;
    }
    if (!now) { console.log('No Claude account signed in (or Claude Code\'s state file could not be read).'); return 1; }
    const a = readAccounts()[now];
    console.log(`${now}  ${a?.label ?? '(no name: mc account name ' + now + ' <name>)'}  ${a?.email ?? ''}`);
    // Claude Code's sign-in for this shell: CLAUDE_CONFIG_DIR picks another person's, if set.
    console.log(`(signed in according to ${tilde(claudeStatePath())})`);
    return 0;
  },

  // mc report <flag|question|note> <text...>  — send something up to Mission Control.
  async report(args) {
    const [kind, ...words] = args;
    if (!['flag', 'question', 'note'].includes(kind) || !words.length) throw new Error('usage: mc report <flag|question|note> <text>');
    const p = here();
    const m = await hubJson<{ id: string }>('/messages', { project: p.id, direction: 'to_mc', kind, body: words.join(' ') });
    console.log(`reported to Mission Control (${m.id})`);
    return 0;
  },

  // mc log <1h30m|90> [note...] [--date YYYY-MM-DD] [--project id] — time spent outside Claude Code.
  async log(args) {
    const opt = (name: string) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
    const date = opt('--date');
    const projectId = opt('--project') ?? here().id;
    const [amount, ...note] = args;
    const minutes = amount ? parseMinutes(amount) : null;
    if (!minutes) throw new Error('usage: mc log <1h30m|90m|1.5h> [note] [--date YYYY-MM-DD] [--project id]');
    const t = await hubJson<{ date: string }>('/time/manual', { project: projectId, minutes, note: note.join(' '), ...(date ? { date } : {}) });
    console.log(`logged ${minutes} min on ${projectId} for ${t.date}`);
    return 0;
  },

  // mc discover [--days 90] [--json]: the projects worked on lately, from Claude Code's session
  // history and the git repositories under the roots, with the summary each has (if any).
  async discover(args) {
    const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
    const days = Number(opt('--days') ?? 90);
    const s = settings();
    const found = discover({ roots: s.roots, days, now: Math.floor(Date.now() / 1000), skip: [s.summaries] });
    if (args.includes('--json')) {
      console.log(JSON.stringify(found.map((f) => ({ ...f, folder: tilde(f.folder), summary: f.summary && { ...f.summary, path: tilde(f.summary.path) } })), null, 2));
      return 0;
    }
    if (!found.length) console.log(`Nothing worked on in the last ${days} days.`);
    const day = (ts: number) => new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: s.timezone });
    for (const f of found) {
      const has = f.summary ? `${f.summary.id}${f.summary.kept ? ' (kept)' : ''}` : 'no summary';
      console.log(`${day(f.last)}  ${String(f.sessions).padStart(4)} ${f.sessions === 1 ? 'session ' : 'sessions'}  ${has.padEnd(30)} ${tilde(f.folder)}${f.group ? `  [${f.group}]` : ''}${f.git ? '' : '  (not git)'}`);
    }
    return 0;
  },

  // mc init <folder> --owner "Name" [--timezone Area/City] [--roots ~/code:~/work] [--adopt]: make this
  // person's own Mission Control folder and settings, or (--adopt) switch an earlier, home-made
  // Mission Control folder to this engine. Then: open Claude Code there.
  async init(args) {
    const adopt = args.includes('--adopt');
    args = args.filter((a) => a !== '--adopt');
    const opt = (name: string) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
    const owner = opt('--owner');
    // Adopting: keep the earlier setup's timezone if it had a valid one.
    const oldTz = adopt ? rawConfig()?.timezone : undefined;
    const validTz = (z: unknown) => { try { return typeof z === 'string' && !!new Intl.DateTimeFormat('en', { timeZone: z }); } catch { return false; } };
    const timezone = opt('--timezone') ?? (validTz(oldTz) ? (oldTz as string) : Intl.DateTimeFormat().resolvedOptions().timeZone);
    const roots = (opt('--roots') ?? '').split(':').filter(Boolean);
    const [dir] = args;
    if (!dir || !owner) throw new Error('usage: mc init <folder> --owner "Your name" [--timezone Area/City] [--roots ~/code:~/work] [--adopt]');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
    for (const line of init(dir, { owner, timezone, roots, today, adopt })) console.log(line);
    if (adopt && existsSync(join(MC_HOME, 'events.jsonl'))) console.log(`\nEarlier hours: mc import-events brings ${tilde(join(MC_HOME, 'events.jsonl'))} across.`);
    console.log(`\nNext: copy your laptop key, then mc connect <address> --paste. Then cd ${tilde(dir.replace(/\/+$/, ''))} && claude, and say "set me up".`);
    return 0;
  },

  // mc import-events [file]: bring an earlier Mission Control's raw time events (one JSON object per
  // line; default ~/.mission-control/events.jsonl) into this outbox, so earlier hours reach the hub.
  // Safe to run again: events already here are skipped.
  async 'import-events'(args) {
    const file = args[0] ?? join(MC_HOME, 'events.jsonl');
    if (!existsSync(file)) throw new Error(`no event log at ${tilde(file)}`);
    const { events, skipped } = eventsToImport(readFileSync(file, 'utf8'), new Set(readAll().map((e) => e.id)));
    for (const e of events) append(e);
    console.log(`imported ${events.length} events from ${tilde(file)}${skipped ? ` (${skipped} lines could not be read as events)` : ''}`);
    if (events.length && HUB) console.log('They go to the hub with the next mc flush (or at the end of your next session).');
    return 0;
  },

  // mc config [<key> <value>]: show this laptop's settings, or change one. Never shows the key.
  async config(args) {
    const [key, value] = args;
    if (key) {
      const set: Partial<Config> = {};
      if (key === 'owner' && value) set.owner = value;
      else if (key === 'timezone' && value) {
        try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { throw new Error(`unknown timezone: ${value} (e.g. Australia/Melbourne)`); }
        set.timezone = value;
      } else if (key === 'roots' && value !== undefined) set.roots = value.split(':').filter(Boolean);
      else if (key === 'newSummaries' && (value === 'mission-control' || value === 'project')) set.newSummaries = value;
      else if (key === 'live' && (value === 'on' || value === 'off')) set.live = value === 'on';
      else if (key === 'cachewarn' && (value === 'on' || value === 'off')) set.cacheWarn = value === 'on';
      else if (key === 'limits' && (value === 'on' || value === 'off')) set.limits = value === 'on';
      else if (key === 'accounts' && value) set.accountDirs = value.split(':').filter(Boolean);
      else if (key === 'workers' && (value === 'on' || value === 'off')) set.workers = value === 'on';
      else if (key === 'digests' && (value === 'on' || value === 'off')) set.digests = value === 'on';
      else if (key === 'feed' && value !== undefined) set.feed = value;
      else if (key === 'worker-subagents' && value !== undefined) {
        const list = value.split(':').filter(Boolean);
        // Hooks run mc from every project's folder: a relative pattern would mean a different place each time.
        if (list.some((x) => !x.startsWith('/') && !x.startsWith('~/'))) throw new Error('mc config worker-subagents takes absolute or ~/ patterns, e.g. "~/.claude/projects/*/*/subagents"');
        set.workerSubagents = list;
      }
      else if (key === 'worker-type' && value !== undefined) set.workerAgentType = value;
      else if (key === 'answer' && value !== undefined) {
        let argv: unknown;
        try { argv = JSON.parse(value || '[]'); } catch { throw new Error(`mc config answer takes a JSON list: '${EXAMPLE_ANSWER}'`); }
        if (!Array.isArray(argv) || !argv.every((x) => typeof x === 'string')) throw new Error('mc config answer takes a JSON list of strings');
        if (argv.length && (!argv[0] || !argv.includes('{answer}'))) throw new Error(`mc config answer needs a program first and {answer} as an argument of its own, e.g. '${EXAMPLE_ANSWER}'`);
        set.answer = argv as string[];
      }
      else throw new Error('usage: mc config [owner <name> | timezone <Area/City> | roots <dir:dir> | newSummaries <mission-control|project> | live <on|off> | cachewarn <on|off> | limits <on|off> | accounts "<default:dir:dir/*>" (quoted, so the shell leaves the * alone) | workers <on|off> | digests <on|off> | worker-subagents "<glob:glob>" | worker-type <agent type, or * for any> | feed "<command>" | answer [\"cmd\", \"{id}\", \"{answer}\"] (a JSON list)]');
      saveConfig(set);
    }
    const s = settings();
    const hubNote = HUB ? `connected to ${HUB}${TOKEN ? '' : ' (no key)'}` : 'not connected';
    console.log([
      `owner         ${s.owner}`,
      `timezone      ${s.timezone}`,
      `roots         ${s.roots.map(tilde).join(', ') || '(none)'}`,
      `summaries     ${tilde(s.summaries)}`,
      `new summaries ${s.newSummaries === 'mission-control' ? 'kept in Mission Control' : "in the project's own folder"}`,
      `readme map    ${s.map ? 'on' : 'off'}`,
      `live sessions ${s.live ? "on: each session's state and Claude's last message go to the hub (mc setup adds their hooks)" : 'off'}`,
      `cache warning ${s.cacheWarn ? 'on: the first message after a session\'s prompt cache closed is held back once, with its cost' : 'off'}`,
      `workers       ${s.workers ? 'on: the background workers go to the hub every two minutes' : 'off'}`,
      `digests       ${s.digests ? "on: each session's prompts and Claude's replies, trimmed, go to the hub for summaries" : 'off'}`,
      `subagents     ${s.workerSubagents.length && s.workerAgentType ? `${s.workerAgentType === '*' ? 'background subagents of any type' : `${s.workerAgentType} subagents`} in ${s.workerSubagents.join(', ')}` : 'none'}`,
      `feed          ${s.feed ? `every ten minutes: ${s.feed}` : 'none'}`,
      `answer        ${s.answer.length ? `every minute, answers from the page go to: ${s.answer.join(' ')}` : 'none'}`,
      `limits        ${s.limits ? `on: each account's usage limits go to the hub every few minutes, from ${s.accountDirs.join(', ')}` : 'off'}`,
      `hub           ${hubNote}`,
    ].join('\n'));
    return 0;
  },

  // mc connect <hub address> [--paste] [--replace]: connect this laptop to a Mission Control hub with
  // its laptop key (from the page you joined on). The key comes from the clipboard (--paste), MC_KEY,
  // or is typed without echo. It goes straight into the settings file and is never printed.
  async connect(args) {
    let url = args.find((a) => !a.startsWith('--'))?.replace(/\/+$/, '');
    if (!url) throw new Error('usage: mc connect <https://…/api/hub> [--paste]');
    if (!/\/api\/hub$/.test(url)) url += '/api/hub';
    if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) throw new Error('the hub address must start with https://');
    if (cfg.hubUrl && cfg.hubUrl !== url && !args.includes('--replace')) {
      throw new Error(`this laptop already sends to ${cfg.hubUrl}. Nothing changed. Add --replace to switch it to ${url}.`);
    }
    const key = (process.env.MC_KEY ?? (args.includes('--paste') ? readClipboard() : await askHidden('Laptop key (it won\'t show as you type): '))).trim();
    if (!/^\S{20,}$/.test(key)) throw new Error('that does not look like a laptop key (they start with mcl_). Nothing changed.');
    const res = await fetch(`${url}/whoami`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) }).catch((e: Error) => {
      throw new Error(`could not reach ${url}: ${e.message}`);
    });
    const who = (await res.json().catch(() => ({}))) as { name?: string; error?: string };
    if (!res.ok || !who.name) throw new Error(`${url} did not accept that key (${res.status}${who.error ? `: ${who.error}` : ''}). Nothing changed.`);
    saveConfig({ hubUrl: url, hubToken: key });
    reloadConfig();
    console.log(`Connected to ${new URL(url).host} as ${who.name}.`);
    console.log('Next: mc setup (once on this laptop), then mc push. mc open shows your page.');
    return 0;
  },

  // mc open [--print]: open your page in the browser, with a fresh link from the hub.
  async open(args) {
    const { url } = await hubJson<{ url: string }>('/page-link', { label: hostname().slice(0, 80) || 'mc open' });
    // The link holds a page token, and a page token can send messages that sessions act on. A Claude
    // Code session (CLAUDECODE set) never gets it in its output: it can open the browser, not print.
    if (args.includes('--print')) {
      if (process.env.CLAUDECODE) { console.error('mc open --print is refused inside a Claude Code session: the link would let the session send messages as you. Run mc open (it opens your browser) or run --print in your own terminal.'); return 1; }
      console.log(url);
      return 0;
    }
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    const child = spawn(opener, [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => console.error(`could not open a browser; run mc open --print for the link`));
    child.unref();
    console.log('Opened your page in the browser.');
    return 0;
  },

  // mc setup [--dry-run] [--replace]: connect Claude Code on this laptop (hooks, skill, leave to edit summaries,
  // the mission-control tools once connected). Safe to run again.
  async setup(args) {
    const dry = args.includes('--dry-run');
    const replace = args.includes('--replace');
    // A hub can say it has no MCP tools yet (the public one, for now): then none are added.
    const info = HUB ? await fetch(`${HUB}/info`, { signal: AbortSignal.timeout(3000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null;
    const tools = (info as { features?: { tools?: boolean } } | null)?.features?.tools !== false;
    const steps = setup({ dry, summaries: settings().summaries, hub: HUB && TOKEN ? { url: HUB, token: TOKEN, tools } : null, replace, live: settings().live && !!HUB });
    console.log(describe(steps, dry));
    return 0;
  },

  // Local report from the outbox. Usage: mc time [--month YYYY-MM] [--idle-cap MIN]
  async time(args) {
    const month = args[args.indexOf('--month') + 1] ?? new Date().toISOString().slice(0, 7);
    const capArg = args.indexOf('--idle-cap');
    const cap = capArg >= 0 ? Number(args[capArg + 1]) * 60 : undefined;
    const events = readAll().filter((e) => new Date(e.ts * 1000).toISOString().startsWith(month));
    const totals = [...activeSeconds(events, cap)].sort((a, b) => b[1] - a[1]);
    if (!totals.length) console.log(`no activity logged for ${month}`);
    for (const [p, s] of totals) console.log(`${p.padEnd(28)} ${hours(s).toFixed(1).padStart(6)} h`);
    return 0;
  },
};

const HELP = `mc <command>
  inbox                         open messages from Mission Control for this project
  done <id> [reply]             close a message, with a reply
  relays                        hand messages from the page to this laptop's waiting sessions (hooks run it)
  report <flag|question|note> <text>   send something up to Mission Control
  log <1h30m> [note] [--date D] [--project id]   log time spent outside Claude Code
  scan                          validate every PROJECT.md
  which [dir...]                project id for each folder (default: this one)
  push                          send every project to the hub (and refresh ~/Projects/README.md)
  map                           refresh the project list in ~/Projects/README.md
  forget <id...> | --missing    clear deleted or merged projects off the hub's "not found" list
  flush                         send queued time events
  usage [--since YYYY-MM-DD]    read Claude Code token use since the last run, send it to the hub (--since: also older use, once)
  progress < file.json          send where every project stands (stage, workstreams, questions) from a status feeder
  account [list | name <id> <name>]   the Claude account signed in now; every one seen here; name one for your page
  sessions [--days 7] [--project id]   recent sessions: when, where, hours and API value
  assign <session> <project|--undo>    count a whole session toward another project
  time                          hours this month from the local log (--month YYYY-MM)
  discover [--days 90] [--json] projects worked on lately (Claude Code history, git repos) and their summaries
  init <folder> --owner "Name" [--timezone Area/City] [--roots ~/code:~/work] [--adopt]   make someone's own Mission Control folder (--adopt: switch an earlier one over)
  import-events [file]          bring an earlier setup's time events across (default ~/.mission-control/events.jsonl)
  connect <hub address> [--paste]   connect this laptop to a hub with its laptop key (never printed)
  open [--print]                open your page on the hub in the browser
  config [<key> <value>]        show or change this laptop's settings (owner, timezone, roots, newSummaries, live, cachewarn, limits, accounts, workers, digests, feed, answer)
  limits [--push]               each Claude account's usage limits (session, weekly, per model); --push sends them to the hub
  workers [--push]              the background workers running now and the queue; --extras < file.json takes a feeder's workstreams
  answers [--apply]             answers given on the page to a feeder's questions; --apply hands them to mc config answer
  setup [--dry-run] [--replace] connect Claude Code here: hooks, skill, summaries, the mission-control tools (--replace: swap out another setup's)
  hook                          (Claude Code hooks only; reads JSON on stdin)`;

// Run only as the CLI, not when a test imports parseMinutes.
if (process.argv[1] && /cli\.ts$|\/mc$/.test(process.argv[1])) {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  const fn = commands[cmd];
  if (!fn) {
    console.log(HELP);
    process.exit(cmd === 'help' ? 0 : 1);
  }
  fn(rest).then(
    (code) => process.exit(code),
    (e) => {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(1);
    },
  );
}
