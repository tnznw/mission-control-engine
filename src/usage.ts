// AI usage from Claude Code's own transcripts: <claude dir>/projects/<folder>/<session>.jsonl, and
// subagents in <folder>/<session>/subagents/*.jsonl (their entries carry the parent's session id).
// Every assistant entry holds message.id, message.model and message.usage. The same response is
// written several times, so rows are keyed by message id and the hub ignores repeats.
//
// Transcripts are big (one long session is 35 MB) and only grow, so each file is read from where
// the last run stopped (byte offsets in usage-state.json). Runs in the background after a session
// ends (cli.ts hook), never inside one, and catches up any session that never ended cleanly.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readdirSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { UsageRow } from './cost.ts';
import type { ActivityEvent } from './time.ts';

export const transcriptRoot = () =>
  process.env.MC_TRANSCRIPTS ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');

/** Every transcript: <root>/<folder>/*.jsonl and <root>/<folder>/<session>/subagents/*.jsonl. */
export function transcriptFiles(root = transcriptRoot()): string[] {
  const out: string[] = [];
  const dirs = (p: string) => { try { return readdirSync(p, { withFileTypes: true }); } catch { return []; } };
  for (const folder of dirs(root)) {
    if (!folder.isDirectory()) continue;
    const fp = join(root, folder.name);
    for (const e of dirs(fp)) {
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(join(fp, e.name));
      else if (e.isDirectory()) {
        const sub = join(fp, e.name, 'subagents');
        for (const s of dirs(sub)) if (s.isFile() && s.name.endsWith('.jsonl')) out.push(join(sub, s.name));
      }
    }
  }
  return out;
}

export type RawUsage = Omit<UsageRow, 'project'> & { cwd: string };

/** Usage rows in a run of whole transcript lines. Skips other entries, errors ('<synthetic>')
 *  and anything before `since`; keeps one row per message id. */
export function parseUsage(text: string, since = 0): RawUsage[] {
  const rows = new Map<string, RawUsage>();
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue; // cheap test first: most lines are tool output
    let e: { type?: string; sessionId?: string; timestamp?: string; cwd?: string; message?: { id?: string; model?: string; usage?: Record<string, unknown> } };
    try { e = JSON.parse(line); } catch { continue; }
    const m = e.message, u = m?.usage;
    if (e.type !== 'assistant' || !m?.id || !u || !m.model || m.model === '<synthetic>' || !e.sessionId) continue;
    const ts = Math.floor(Date.parse(e.timestamp ?? '') / 1000);
    if (!(ts >= since)) continue;
    const n = (v: unknown) => (typeof v === 'number' && v > 0 ? Math.round(v) : 0);
    const cc = (u.cache_creation ?? {}) as Record<string, unknown>;
    const w5 = n(cc.ephemeral_5m_input_tokens), w1 = n(cc.ephemeral_1h_input_tokens);
    // Older transcripts give only the total written; price it as 5-minute (the API default).
    const unsplit = Math.max(0, n(u.cache_creation_input_tokens) - w5 - w1);
    rows.set(m.id, {
      id: m.id, session: e.sessionId, model: m.model, ts, cwd: e.cwd ?? '',
      input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens),
      cacheWrite5m: w5 + unsplit, cacheWrite1h: w1,
      webSearch: n((u.server_tool_use as Record<string, unknown> | undefined)?.web_search_requests),
      fast: u.speed === 'fast',
    });
  }
  return [...rows.values()];
}

const CHUNK = 8 << 20;

/** Read whole lines from byte `from` to the end of the file; returns the offset after the last
 *  complete line, so a line still being written is read next time. A file that shrank (rewritten)
 *  is read again from the start: repeats are harmless. */
export function readNewLines(path: string, from: number, onText: (text: string) => void): number {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    let pos = from > size ? 0 : from;
    let carry = Buffer.alloc(0);
    const buf = Buffer.alloc(Math.min(CHUNK, Math.max(1, size - pos)));
    while (pos < size) {
      const got = readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      if (got <= 0) break;
      pos += got;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, got)]) : buf.subarray(0, got);
      const nl = data.lastIndexOf(0x0a);
      if (nl >= 0) onText(data.toString('utf8', 0, nl)); // split on bytes, so no character is cut
      carry = Buffer.from(data.subarray(nl + 1));
    }
    return pos - carry.length;
  } finally {
    closeSync(fd);
  }
}

/** Which project each response belongs to, by the same rule as time: the project of the session's
 *  latest event at or before it (its first event if it came earlier). A session with no events
 *  (hooks not running then) falls back to the folder it ran in. */
export function attribute(rows: RawUsage[], events: ActivityEvent[], fallback: (cwd: string) => string): UsageRow[] {
  const bySession = new Map<string, ActivityEvent[]>();
  for (const e of events) {
    const l = bySession.get(e.session);
    if (l) l.push(e); else bySession.set(e.session, [e]);
  }
  for (const l of bySession.values()) l.sort((a, b) => a.ts - b.ts);
  const cwdProject = new Map<string, string>();
  return rows.map(({ cwd, ...r }) => {
    const list = bySession.get(r.session);
    let project: string;
    if (list) {
      let i = list.length - 1;
      while (i > 0 && list[i].ts > r.ts) i--;
      project = list[i].project;
    } else {
      project = cwdProject.get(cwd) ?? fallback(cwd);
      cwdProject.set(cwd, project);
    }
    return { ...r, project };
  });
}

interface State { since: number; files: Record<string, number> }

/** New usage rows from every transcript since the last run. `since` (epoch seconds) is fixed on
 *  the first run: the start of time tracking, so hours and dollars cover the same days. Call
 *  save() only once the rows are safely in the outbox. */
export function collect(stateFile: string, firstSince: () => number, root = transcriptRoot()): { rows: RawUsage[]; files: number; bytes: number; save: () => void } {
  let state: State;
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { state = { since: firstSince(), files: {} }; }
  const rows: RawUsage[] = [];
  let files = 0, bytes = 0;
  for (const f of transcriptFiles(root)) {
    let st;
    try { st = statSync(f); } catch { continue; }
    const from = state.files[f] ?? 0;
    if (st.size === from) continue;
    if (!(f in state.files) && st.mtimeMs / 1000 < state.since) { state.files[f] = st.size; continue; } // nothing in it is new enough
    try {
      const to = readNewLines(f, from, (text) => { for (const r of parseUsage(text, state.since)) rows.push(r); });
      files++; bytes += to - (from > st.size ? 0 : from);
      state.files[f] = to;
    } catch { /* unreadable this time: try again next run */ }
  }
  for (const f of Object.keys(state.files)) if (!existsSync(f)) delete state.files[f];
  return { rows, files, bytes, save: () => writeFileSync(stateFile, JSON.stringify(state)) };
}

/** Run fn unless another run holds the lock (a lock older than 10 minutes is a crashed run). */
export async function withLock<T>(lockFile: string, fn: () => Promise<T>): Promise<T | 'busy'> {
  try {
    closeSync(openSync(lockFile, 'wx'));
  } catch {
    let stale = false;
    try { stale = Date.now() - statSync(lockFile).mtimeMs > 10 * 60_000; } catch { stale = true; }
    if (!stale) return 'busy';
    try { unlinkSync(lockFile); closeSync(openSync(lockFile, 'wx')); } catch { return 'busy'; }
  }
  try {
    return await fn();
  } finally {
    try { unlinkSync(lockFile); } catch { /* gone already */ }
  }
}
