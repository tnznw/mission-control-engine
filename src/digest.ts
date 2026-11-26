// Session digests (2026-11-26): what each Claude Code session was asked and what Claude answered at
// the end of each turn, trimmed and with secrets taken out, so the hub can write a short spoken
// summary of a session, a project or a day when the page asks (journal's hub, POST /summary).
// Raw material only: the hub writes the summaries. Off unless `mc config digests on`.
//
// Read a little at a time: a transcript can run to 100 MB over a session that stays open for days,
// so each session keeps its digest and how far its transcript was read (digests/<session>.json).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readNewLines } from './usage.ts';

export interface Turn { at: number; project: string; you: string; claude: string }
export interface Digest { session: string; title: string; home: string; turns: Turn[] }
interface State { offset: number; digest: Digest }

const YOU = 500; // characters of each prompt kept
const CLAUDE = 800; // of Claude's last reply each turn (its opening: replies lead with the outcome)
const FIRST = 4, LAST = 56; // turns kept of a long session: how it began, and the latest

/** Keys, tokens, private keys and `password = …` never leave the laptop in a digest. */
export function redact(t: string): string {
  return t
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key]')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[key]')
    .replace(/\b(?:ghp|gho|ghs|ghu|github_pat|glpat|xox[abpr])[_-][A-Za-z0-9_-]{16,}/g, '[token]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[token]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|token|secret|password|passwd|bearer)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1[hidden]')
    .replace(/([?&#](?:sk|key|api_key|apikey|token|access_token|auth|sig|signature|secret|password|code)=)[^&\s#)"']+/gi, '$1[hidden]')
    .replace(/\b[A-Za-z0-9+_=-]{40,}/g, '[long string]');
}

const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t);

/** The words of a prompt typed by the person, or '' for anything else that arrives as a user
 *  message: tool results, background-task notices, compaction summaries, slash-command output. */
export function promptText(r: Record<string, any>): string {
  if (r.isMeta || r.toolUseResult || r.isCompactSummary || r.isSidechain) return '';
  if (r.origin && typeof r.origin === 'object' && r.origin.kind && r.origin.kind !== 'human') return '';
  const c = r.message?.content;
  let t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n') : '';
  if (/^\s*(<(local-command|command-name|command-message|command-args|bash-|task-notification)|Caveat:|\[Request interrupted)/.test(t)) return '';
  t = t
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<(ide_selection|ide_opened_file|ide_diagnostics)>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<\/?pasted_content[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t;
}

/** Claude's words in an assistant message (its text, not its tool calls or thinking). */
function replyText(r: Record<string, any>): string {
  if (r.isSidechain) return '';
  const c = r.message?.content;
  return Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n').trim() : '';
}

/** Add a transcript's lines to a digest: each prompt opens a turn, Claude's last reply in it closes
 *  it (a later reply in the same turn replaces an earlier one), and the newest title wins. */
export function addLines(d: Digest, text: string, projectOf: (cwd: string) => string): void {
  for (const line of text.split('\n')) {
    // Most lines are tool calls and results: only these three kinds are worth parsing.
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes('"type":"ai-title"')) continue;
    let r: Record<string, any>;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.type === 'ai-title' && typeof r.aiTitle === 'string') { d.title = clip(r.aiTitle.trim(), 120); continue; }
    if (r.type === 'user') {
      const t = promptText(r);
      if (!t) continue;
      const at = Math.floor(Date.parse(r.timestamp) / 1000);
      d.turns.push({ at: Number.isFinite(at) ? at : 0, project: projectOf(String(r.cwd ?? '')), you: clip(redact(t), YOU), claude: '' });
    } else if (r.type === 'assistant' && d.turns.length) {
      const t = replyText(r);
      if (t) d.turns[d.turns.length - 1].claude = clip(redact(t.replace(/\s+/g, ' ')), CLAUDE);
    }
  }
  // A long session keeps how it began and its latest turns. The last turn stays open for its reply.
  if (d.turns.length > FIRST + LAST) d.turns = [...d.turns.slice(0, FIRST), ...d.turns.slice(-LAST)];
}

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The digests of every session whose transcript grew since `since` (epoch seconds), each read on
 *  from where it was last left. Subagent transcripts are not sessions of their own. */
export function digestsSince(
  files: string[], since: number, dir: string,
  projectOf: (cwd: string) => string, homeOf: (file: string) => string,
): { digests: Digest[]; save: () => void } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out: Digest[] = [], writes: [string, State][] = [];
  for (const f of files) {
    const session = basename(f, '.jsonl');
    if (!SESSION.test(session) || f.includes('/subagents/')) continue;
    let mtime = 0, size = 0;
    try { const s = statSync(f); mtime = s.mtimeMs / 1000; size = s.size; } catch { continue; }
    if (mtime < since) continue;
    const file = join(dir, `${session}.json`);
    const fresh = (): State => ({ offset: 0, digest: { session, title: '', home: homeOf(f), turns: [] } });
    let st = fresh();
    if (existsSync(file)) { try { st = JSON.parse(readFileSync(file, 'utf8')) as State; } catch { /* unreadable: read it again */ } }
    if (size < st.offset) st = fresh(); // rewritten shorter: start again, or its turns would repeat
    const before = st.offset;
    try {
      st.offset = readNewLines(f, st.offset, (text) => addLines(st.digest, text, projectOf));
    } catch { continue; }
    if (st.offset === before) continue;
    if (st.digest.turns.length) out.push(st.digest);
    writes.push([file, st]);
  }
  return { digests: out, save: () => { for (const [f, st] of writes) writeFileSync(f, JSON.stringify(st), { mode: 0o600 }); } };
}
