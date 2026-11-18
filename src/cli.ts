// mc — Mission Control laptop client. See docs/ARCHITECTURE.md and docs/PROTOCOL.md.
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, projectForDir, sessionProject, defaultRoots } from './scan.ts';
import { writeMap } from './map.ts';
import { append, readAll, unsent, usageOutbox, MC_HOME } from './outbox.ts';
import { attribute, collect, withLock } from './usage.ts';
import { costOf, tokensOf, type UsageRow } from './cost.ts';
import { activeSeconds, hours, type EventKind } from './time.ts';
import { parseProjectMd, type Project } from './format.ts';
import { removeTasks } from './dismiss.ts';
import { sessionContext, type InboxMessage } from './protocol.ts';
import { config, reloadConfig, saveConfig, settings, tilde, type Config } from './config.ts';
import { discover } from './discover.ts';
import { describe, eventsToImport, init, rawConfig, setup } from './setup.ts';

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

/** "90", "90m", "1h", "1h30m", "1.5h" → minutes. */
export function parseMinutes(s: string): number | null {
  const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+)m?)?$/.exec(s.trim());
  if (!m || (!m[1] && !m[2])) return null;
  const total = Math.round(Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0));
  return total > 0 ? total : null;
}

/** `mc usage` in a detached process: reading transcripts must never hold up a session. */
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

/** One session as the hub's /sessions lists it. */
interface SessionRow { session: string; project: string; projects: { id: string; hours: number; usd: number }[]; cwd: string; start: number; end: number; hours: number; usd: number; moved: boolean }

const HOOK_KIND: Record<string, EventKind> = {
  SessionStart: 'start',
  UserPromptSubmit: 'tick',
  Stop: 'tick',
  SessionEnd: 'end',
};

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

  async which() {
    const p = projectForDir(process.cwd());
    console.log(p ? p.id : 'unassigned');
    return p ? 0 : 1;
  },

  // Called by Claude Code hooks. Must never fail or stall a session: every path returns 0.
  // SessionStart prints the protocol + this project's inbox (stdout becomes session context);
  // it makes ONE hub call, capped at 1.5 s, and carries on without it if the hub is slow.
  // SessionEnd sends this project's PROJECT.md and the queued time events.
  async hook() {
    try {
      const input = JSON.parse((await readStdin()) || '{}');
      const kind = HOOK_KIND[input.hook_event_name];
      if (!kind || !input.session_id) return 0;
      const cwd: string = input.cwd ?? process.cwd();
      const sp = sessionProject(cwd); // a project, mission-control at the top of ~/Projects, or unassigned
      append({ id: randomUUID(), session: input.session_id, project: sp.id, kind, ts: Math.floor(Date.now() / 1000), cwd: tilde(cwd) });

      if (kind === 'start') {
        // The inbox is for a project's own session: a root session works through the MCP tools.
        // Not connected to a hub yet (a new install): no inbox to fetch, so nothing to say about one.
        let inbox: InboxMessage[] | null = HUB ? null : [];
        if (sp.path && HUB) {
          inbox = await hubJson<{ messages: InboxMessage[] }>(`/messages?project=${encodeURIComponent(sp.id)}&status=open&direction=to_project`, undefined, 1500)
            .then((r) => r.messages)
            .catch(() => null);
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
  async usage(args) {
    const quiet = args.includes('--quiet');
    const r = await withLock(join(MC_HOME, 'usage.lock'), async () => {
      const events = readAll();
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
    console.log(`read ${(r.bytes / 1e6).toFixed(1)} MB from ${r.files} transcripts: ${r.found} responses; sent ${r.sent} to the hub${r.error ? ` (stopped: ${r.error})` : ''}`);
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

  // mc done <message id> [reply...]
  async done(args) {
    const [id, ...reply] = args;
    if (!id) throw new Error('usage: mc done <message id> [reply]');
    await hubJson(`/messages/${encodeURIComponent(id)}/done`, reply.length ? { reply: reply.join(' ') } : {});
    console.log('closed');
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
      else throw new Error('usage: mc config [owner <name> | timezone <Area/City> | roots <dir:dir> | newSummaries <mission-control|project>]');
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
    if (args.includes('--print')) { console.log(url); return 0; }
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
    const steps = setup({ dry, summaries: settings().summaries, hub: HUB && TOKEN ? { url: HUB, token: TOKEN, tools } : null, replace });
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
  report <flag|question|note> <text>   send something up to Mission Control
  log <1h30m> [note] [--date D] [--project id]   log time spent outside Claude Code
  scan                          validate every PROJECT.md
  which                         project id for this directory
  push                          send every project to the hub (and refresh ~/Projects/README.md)
  map                           refresh the project list in ~/Projects/README.md
  forget <id...> | --missing    clear deleted or merged projects off the hub's "not found" list
  flush                         send queued time events
  usage                         read Claude Code token use since the last run, send it to the hub
  sessions [--days 7] [--project id]   recent sessions: when, where, hours and API value
  assign <session> <project|--undo>    count a whole session toward another project
  time                          hours this month from the local log (--month YYYY-MM)
  discover [--days 90] [--json] projects worked on lately (Claude Code history, git repos) and their summaries
  init <folder> --owner "Name" [--timezone Area/City] [--roots ~/code:~/work] [--adopt]   make someone's own Mission Control folder (--adopt: switch an earlier one over)
  import-events [file]          bring an earlier setup's time events across (default ~/.mission-control/events.jsonl)
  connect <hub address> [--paste]   connect this laptop to a hub with its laptop key (never printed)
  open [--print]                open your page on the hub in the browser
  config [<key> <value>]        show or change this laptop's settings (owner, timezone, roots, newSummaries)
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
