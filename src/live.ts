// Live sessions (2026-11-24): what each open Claude Code session is doing, for the dashboard's
// cards of sessions waiting for the owner (the hub's /live routes).
//
// Off unless the settings say `live: true` (`mc config live on`): it sends Claude's last message
// off the laptop, which the engine's README promises other people it never does. The hooks never
// wait on the network for it: each update is written to its own file and sent by a detached
// `mc live-push`. The one exception is a permission request, whose hook waits for Allow or Deny
// from the dashboard while VS Code shows its own prompt; whichever is answered first wins.
//
// What was tested before this was built (2026-11-24, Claude Code 2.1.331 in VS Code): a reply sent
// back through a hook wakes a session, but Claude takes it as a background event, never as the
// owner's answer, so there is no free "reply" here. The Claude extension's link cannot open a running
// session either (it starts a new, empty one), so the dashboard only brings the window forward.
// A question box is different (tested 2026-11-24, 2.1.331): it raises a PermissionRequest while it is
// open, and a decision that allows it with `answers` in its input is taken as the owner's own answer.
// So a question can be answered from the dashboard, the same way as a permission request.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mcHome, tilde } from './config.ts';
import { cacheState, type CacheState } from './cache.ts';

export type LiveState = 'working' | 'waiting' | 'permission' | 'question' | 'ended';

/** One update, as the hub's POST /live takes it. `seq` is this laptop's clock in ms: the hub keeps
 *  the newest, so updates may arrive in any order. */
export interface LiveUpdate {
  session: string; project: string; cwd: string; state: LiveState; since: number; seq: number;
  text?: string;
  request?: { id: string; tool: string; summary: string };
  questions?: { question: string; options: string[]; multiSelect?: boolean }[];
  cache?: CacheState; // a session waiting on the owner: when its prompt cache closes (src/cache.ts)
  home?: string; // the project it was opened in, when it is working in another project's folder now
}

export interface HookInput {
  hook_event_name?: string; session_id?: string; cwd?: string; tool_name?: string;
  tool_input?: Record<string, unknown>; last_assistant_message?: string; transcript_path?: string;
}

/** The state a hook event puts its session in, or null for events live sessions don't follow. */
export function liveStateFor(input: HookInput): LiveState | null {
  switch (input.hook_event_name) {
    case 'UserPromptSubmit': return 'working';
    case 'Stop': return 'waiting';
    case 'SessionEnd': return 'ended';
    case 'PermissionRequest': return 'permission';
    // The question box: the turn does not end while it is open, so Stop never says so.
    case 'PreToolUse': return input.tool_name === 'AskUserQuestion' ? 'question' : null;
    case 'PostToolUse': return input.tool_name === 'AskUserQuestion' ? 'working' : null;
    default: return null;
  }
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** The end of a long message, which is where Claude's question usually is. */
export function lastPart(s: string, max = 3500): string {
  return s.length > max ? '…' + s.slice(-(max - 1)) : s;
}

/** What a tool wants to do, in a line or two, for a permission card. */
export function summarize(tool: string, input: Record<string, unknown> = {}): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  let s = '';
  if (tool === 'Bash') s = str('command');
  else if (['Edit', 'MultiEdit', 'Write', 'Read', 'NotebookEdit'].includes(tool)) s = tilde(str('file_path') || str('notebook_path'));
  else if (tool === 'WebFetch') s = str('url');
  else if (tool === 'WebSearch') s = str('query');
  if (!s) {
    try { s = JSON.stringify(input); } catch { s = ''; }
  }
  return clip(s, 1500);
}

/** A question box's questions and the labels of their options. */
export function questionsOf(input: Record<string, unknown> = {}): { question: string; options: string[]; multiSelect?: boolean }[] {
  const qs: unknown[] = Array.isArray(input.questions) ? input.questions : [];
  return qs.slice(0, 5).map((q) => {
    const o = (q ?? {}) as { question?: unknown; options?: unknown; multiSelect?: unknown };
    const opts: unknown[] = Array.isArray(o.options) ? o.options : [];
    return {
      question: clip(String(o.question ?? ''), 900),
      options: opts.slice(0, 10).map((x) => clip(String(typeof x === 'string' ? x : (x as { label?: unknown })?.label ?? ''), 280)),
      ...(o.multiSelect === true ? { multiSelect: true } : {}),
    };
  });
}

/** The update a hook event makes, or null when it makes none. */
export function updateFor(input: HookInput, project: string, now = Date.now()): LiveUpdate | null {
  // A question box asks for permission while it is open: the dashboard can answer it.
  const asking = input.hook_event_name === 'PermissionRequest' && input.tool_name === 'AskUserQuestion';
  const state = asking ? 'question' : liveStateFor(input);
  if (!state || !input.session_id) return null;
  const u: LiveUpdate = { session: input.session_id, project, cwd: input.cwd ?? '', state, since: Math.floor(now / 1000), seq: now };
  if (state === 'waiting') u.text = lastPart(input.last_assistant_message ?? '');
  if (state === 'question') u.questions = questionsOf(input.tool_input);
  if (state === 'permission' || asking) u.request = { id: randomUUID(), tool: input.tool_name ?? 'a tool', summary: asking ? '' : summarize(input.tool_name ?? '', input.tool_input) };
  if (state === 'waiting' || state === 'permission' || state === 'question') {
    const c = cacheState(input.transcript_path);
    if (c) u.cache = c;
  }
  return u;
}

const liveDir = () => join(mcHome(), 'live');

/** Send an update from a detached process, so the hook returns at once. Each update gets its own
 *  file, so two in quick succession never overwrite each other. */
export function sendInBackground(u: LiveUpdate): void {
  mkdirSync(liveDir(), { recursive: true, mode: 0o700 });
  const file = join(liveDir(), `${u.seq}-${randomUUID().slice(0, 8)}.json`);
  writeFileSync(file, JSON.stringify(u), { mode: 0o600 });
  const mc = fileURLToPath(new URL('../bin/mc', import.meta.url));
  const child = spawn('/bin/sh', [mc, 'live-push', file], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

/** What one send came to: the hub has it, or not; whether sending it again could help; and whether
 *  the hub is down (unreachable, or not answering as itself), so the other sends should wait too. */
export type PushOutcome = { sent: true } | { sent: false; retry: boolean; down: boolean; why: string };

/** A hub's answer to POST /live. Only its own JSON counts as taken: while the hub restarts for a
 *  deploy its address can answer with a page instead. A 4xx other than 408/429 will not change on
 *  a resend (an update it calls invalid, a token it refuses), so that one is dropped. A JSON error
 *  is about this update alone (one the database refuses, say), so the others still go. */
export function pushOutcome(status: number, type: string | null): PushOutcome {
  const ok = status >= 200 && status < 300, json = (type ?? '').includes('json');
  if (ok && json) return { sent: true };
  const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
  return { sent: false, retry: !permanent, down: !json, why: ok ? `answered ${status} with ${type || 'no type'}, not the hub's JSON` : `hub answered ${status}` };
}

const LEFT_KEPT_MS = 86_400_000; // the hub stops showing a session silent for a day
const IN_FLIGHT_MS = 30_000; // a newer file may still be on its way with its own push
const RESENDS_PER_PUSH = 20;

/** `mc live-push <file>`: send this update, then any earlier one whose send failed, deleting each
 *  file only once the hub has it. Until 2026-11-26 every file went whether it was sent or not, so
 *  one lost send (a session's "finished" or "ended", say while the hub restarted for a deploy) left
 *  it on the page as Working for a day. The hub keeps only the newest seq per session, so a resend
 *  is harmless and only a session's newest leftover is worth sending, so one the hub keeps refusing
 *  is gone at that session's next update. With the hub down, the rest wait for the next push; each
 *  failure is one line in live-errors.log. */
export async function pushFile(file: string, post: (u: LiveUpdate) => Promise<PushOutcome>, now = Date.now()): Promise<{ sent: number; failed: number }> {
  const drop = (p: string) => rmSync(p, { force: true });
  const read = (p: string): LiveUpdate | null => {
    try { const u = JSON.parse(readFileSync(p, 'utf8')) as LiveUpdate; return u && u.session ? u : null; } catch { return null; }
  };
  const own = read(file);
  const queue: { path: string; u: LiveUpdate }[] = [];
  if (own) queue.push({ path: file, u: own });
  else drop(file);
  const best = new Map<string, { path: string; u: LiveUpdate; seq: number }>();
  let names: string[] = [];
  try { names = readdirSync(liveDir()); } catch { /* no leftovers */ }
  for (const f of names) {
    const path = join(liveDir(), f), seq = Number(f.split('-')[0]);
    if (path === file) continue;
    if (!(seq > 0) || seq < now - LEFT_KEPT_MS) { drop(path); continue; }
    if (seq > now - IN_FLIGHT_MS) continue;
    const u = read(path);
    if (!u || (own && u.session === own.session && u.seq <= own.seq)) { drop(path); continue; }
    const b = best.get(u.session);
    if (b && b.seq >= seq) { drop(path); continue; }
    if (b) drop(b.path);
    best.set(u.session, { path, u, seq });
  }
  queue.push(...[...best.values()].sort((a, b) => a.seq - b.seq).slice(-RESENDS_PER_PUSH));
  let sent = 0, failed = 0;
  for (const { path, u } of queue) {
    let r: PushOutcome;
    try { r = await post(u); } catch (e) { r = { sent: false, retry: true, down: true, why: e instanceof Error ? e.message : String(e) }; }
    if (r.sent) { sent++; drop(path); continue; }
    failed++;
    logFailure(`${new Date(now).toISOString()} ${u.session.slice(0, 8)} ${u.state} ${r.retry ? 'kept to resend' : 'dropped'}: ${r.why}`);
    if (!r.retry) drop(path);
    if (r.down) break;
  }
  return { sent, failed };
}

/** One line per failed send, so the next lost update has a reason on record. Kept small. */
function logFailure(line: string): void {
  try {
    const f = join(mcHome(), 'live-errors.log');
    appendFileSync(f, line + '\n', { mode: 0o600 });
    if (statSync(f).size > 64_000) writeFileSync(f, readFileSync(f, 'utf8').split('\n').slice(-200).join('\n'));
  } catch { /* the log helps; it never fails a push */ }
}

export interface DecisionCalls {
  post: (u: LiveUpdate) => Promise<boolean>;
  poll: (session: string, request: string) => Promise<{ pending: boolean; decision: 'allow' | 'deny' | null; answers?: unknown } | null>;
  /** The question box's own input, which an answer from the dashboard goes back into. */
  input?: Record<string, unknown>;
  /** True once the request was answered in Claude Code's own prompt (see watchAnswer). */
  answered?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
}

/** How a wait ended: decided on the dashboard, answered in Claude Code's prompt, the wait ran out,
 *  or none (the hub could not be reached, or the session moved on). */
export type DecisionEnd = 'decided' | 'answered' | 'expired' | 'none';

/** The PermissionRequest hook: put the request on the dashboard, then wait for Allow or Deny there.
 *  `out` is what the hook prints: the decision, or '' to leave it to Claude Code's own prompt. */
export async function awaitDecision(u: LiveUpdate, calls: DecisionCalls, waitMs = 29 * 60_000, everyMs = 2000): Promise<{ out: string; end: DecisionEnd }> {
  const none = { out: '', end: 'none' as const };
  if ((u.state !== 'permission' && u.state !== 'question') || !u.request) return none;
  if (!(await calls.post(u).catch(() => false))) return none;
  const sleep = calls.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await sleep(everyMs);
    // Claude Code does not stop this hook when its own prompt is answered (tested 2026-11-24): the
    // hook would wait until the session's turn ended, with the card still up.
    if (calls.answered?.()) return { out: '', end: 'answered' };
    const r = await calls.poll(u.session, u.request.id).catch(() => null);
    if (!r) continue; // a network blip: ask again
    if (!r.pending) return none;
    if (u.state === 'question') {
      if (r.decision === 'deny') return { out: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Dismissed from Mission Control.' } } }), end: 'decided' };
      if (r.decision !== 'allow') continue;
      const updatedInput = answered(calls.input, r.answers);
      // Allowed without usable answers (a hub that only knows Allow): leave it to Claude Code's box.
      return updatedInput ? { out: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput } } }), end: 'decided' } : none;
    }
    if (r.decision === 'allow' || r.decision === 'deny') {
      const decision = r.decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied from Mission Control.' };
      return { out: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }), end: 'decided' };
    }
  }
  // Answered in Claude Code during the last poll: say so, or the card would come back stale.
  return { out: '', end: calls.answered?.() ? 'answered' : 'expired' };
}

/** The question box's input with the dashboard's answers in it, keyed by each question's full text
 *  as Claude Code expects; null unless every question has an answer. The dashboard sends them in
 *  question order, since what it shows of a question may be cut short. */
export function answered(input: Record<string, unknown> | undefined, answers: unknown): Record<string, unknown> | null {
  const qs: unknown[] = Array.isArray(input?.questions) ? input.questions : [];
  if (!qs.length || !Array.isArray(answers) || answers.length !== qs.length) return null;
  const out: Record<string, string> = {};
  for (const [i, q] of qs.entries()) {
    const text = (q as { question?: unknown })?.question, given = answers[i];
    // Several picks of a multiSelect question come joined by ", " (Claude Code's own form); a list is joined here.
    const a = Array.isArray(given) && given.every((x) => typeof x === 'string') ? given.join(', ') : given;
    if (typeof text !== 'string' || typeof a !== 'string' || !a.trim()) return null;
    out[text] = a.trim().slice(0, 3200);
  }
  return { ...input, answers: out };
}

/** What identifies a tool call: its command, file or address, else its whole input. */
function callKey(tool: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  const key = tool === 'Bash' ? o.command
    : tool === 'Edit' ? [o.file_path, o.old_string]
    : ['MultiEdit', 'Write', 'Read', 'NotebookEdit'].includes(tool) ? o.file_path ?? o.notebook_path
    : tool === 'WebFetch' ? o.url
    : tool === 'WebSearch' ? o.query
    : o;
  return JSON.stringify(key ?? o);
}

/** Whether a permission request has been answered in Claude Code's own prompt. The hook is not told
 *  which tool call it is for, but the call is in the session's transcript already (same tool, same
 *  input); once the prompt is answered, allowed or denied, the call's result follows it there.
 *  Reads only what the transcript gains, from the last 512 KB on. Never throws. */
export function watchAnswer(transcript: string | undefined, tool: string, input: unknown): () => boolean {
  if (!transcript) return () => false;
  const want = callKey(tool, input);
  let offset = 0, rest = '', id: string | null = null, done = false;
  try { offset = Math.max(0, statSync(transcript).size - 512 * 1024); } catch { return () => false; }
  const check = (): boolean => {
    if (done) return true;
    try {
      const size = statSync(transcript).size;
      if (size <= offset) return false;
      const fd = openSync(transcript, 'r');
      const buf = Buffer.alloc(size - offset);
      try { readSync(fd, buf, 0, buf.length, offset); } finally { closeSync(fd); }
      offset = size;
      const lines = (rest + buf.toString('utf8')).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) {
        let e: { type?: string; message?: { content?: unknown } };
        try { e = JSON.parse(line); } catch { continue; } // the cut first line
        const blocks = Array.isArray(e.message?.content) ? (e.message!.content as Record<string, unknown>[]) : [];
        for (const b of blocks) {
          // The newest matching call is this request's: an earlier one with the same input (the
          // same command run twice) and its result do not count.
          if (e.type === 'assistant' && b.type === 'tool_use' && b.name === tool && callKey(tool, b.input) === want) { id = String(b.id); done = false; }
          if (e.type === 'user' && b.type === 'tool_result' && id && b.tool_use_id === id) done = true;
        }
      }
    } catch { /* unreadable for now: try again next time */ }
    return done;
  };
  check(); // find the call while it is fresh
  return check;
}
