// The Claude account signed in to Claude Code on this laptop, read from Claude Code's own state file
// at each hook. Several people can share one laptop, each signing in to their own account: every
// session event carries the account, so time and AI use count toward whoever was signed in. Only a
// short hash of the account id leaves the laptop. The names and emails seen stay here, in
// ~/.mission-control/accounts.json (0600), and the person names each account with `mc account name`.
import { createHash } from 'node:crypto';
import { chmodSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MC_HOME } from './outbox.ts';

export interface SeenAccount { email: string; name: string; org: string; first: number; last: number; label?: string }

const claudeState = () => process.env.MC_CLAUDE_STATE ?? join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');
export const claudeStatePath = claudeState;
const accountsFile = () => join(process.env.MC_HOME ?? MC_HOME, 'accounts.json');

export const accountId = (uuid: string) => createHash('sha256').update(uuid).digest('hex').slice(0, 12);

/** VS Code's settings are JSON with comments and trailing commas (and may be empty, or start with a
 *  byte-order mark): all taken out outside strings, then parsed. */
export function jsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { const j = (/^"(?:[^"\\]|\\.)*"/.exec(text.slice(i))?.[0] ?? '"').length; out += text.slice(i, i + j); i += j - 1; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 1; continue; }
    if (c === ',') {
      // A comma with only space and comments before the closing bracket is a trailing one.
      const rest = text.slice(i + 1).replace(/^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/, '');
      if (rest[0] === '}' || rest[0] === ']') continue;
    }
    out += c;
  }
  const body = out.replace(/^﻿/, '').trim();
  return body ? JSON.parse(body) : {};
}

/** The account VS Code's Claude panel is set to on this laptop: the sign-in folder that VS Code's
 *  user settings give the panel (claudeCode.environmentVariables, CLAUDE_CONFIG_DIR), or the main
 *  one. This is what the person is signed in to, whatever other sessions (another window, a
 *  background agent) run under. undefined: no VS Code with the Claude extension here; null: the
 *  settings could not be read, or name a folder that is not a full path. */
export function vsCodeAccount(
  settingsFile = process.env.MC_VSCODE_SETTINGS ?? join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json'),
  home = homedir(),
  extensions = process.env.MC_VSCODE_EXTENSIONS ?? join(homedir(), '.vscode', 'extensions'),
): string | null | undefined {
  let text: string;
  try { text = readFileSync(settingsFile, 'utf8'); } catch { return undefined; }
  // VS Code used only as an editor says nothing about which account Claude uses.
  try { if (!readdirSync(extensions).some((d) => d.startsWith('anthropic.claude-code-'))) return undefined; } catch { return undefined; }
  let dir = '';
  try {
    const env = (jsonc(text) as Record<string, unknown>)['claudeCode.environmentVariables'];
    const set = Array.isArray(env) ? env.find((e: { name?: string; value?: string }) => e?.name === 'CLAUDE_CONFIG_DIR')?.value : undefined;
    dir = typeof set === 'string' ? set : '';
  } catch { return null; }
  // The extension hands the value to Claude Code as it is: only a full path is one we can follow.
  if (dir && !dir.startsWith('/')) return null;
  try {
    const uuid = JSON.parse(readFileSync(join(dir || home, '.claude.json'), 'utf8')).oauthAccount?.accountUuid;
    return typeof uuid === 'string' && uuid ? accountId(uuid) : null;
  } catch { return null; }
}

/** The accounts seen; {} only when there is no file yet. Anything else unreadable throws, so a hook
 *  never rewrites the file from nothing and loses the names. */
export function readAccounts(): Record<string, SeenAccount> {
  let text: string;
  try { text = readFileSync(accountsFile(), 'utf8'); } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return {};
    throw e;
  }
  return JSON.parse(text);
}

/** Change accounts.json: read it again just before writing, so a name given meanwhile is kept. */
export function updateAccounts(change: (seen: Record<string, SeenAccount>) => void): Record<string, SeenAccount> {
  const seen = readAccounts();
  change(seen);
  saveAccounts(seen);
  return seen;
}

/** Written whole and renamed into place, so a reader never sees half a file. */
export function saveAccounts(seen: Record<string, SeenAccount>): void {
  const tmp = `${accountsFile()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(seen, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, accountsFile());
}

/** The account signed in now, as its short id; '' when Claude Code's state can't be read. A new
 *  account, or one not noted for an hour, is written to accounts.json (at most once an hour). */
export function currentAccount(now = Math.floor(Date.now() / 1000)): string {
  // Claude Code's state file can be megabytes: parse it only when it changed (a hook runs on
  // every prompt), remembering the answer by its size and time in a small cache beside accounts.json.
  const file = claudeState();
  let key: string;
  try { const st = statSync(file); key = `${file}:${st.size}:${st.mtimeMs}`; } catch { return ''; }
  const cacheFile = join(process.env.MC_HOME ?? MC_HOME, 'account-cache.json');
  try {
    const c = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (c.key === key && typeof c.id === 'string') { note(c.id, c.o, now); return c.id; }
  } catch { /* no cache yet */ }
  let o: { accountUuid?: string; emailAddress?: string; fullName?: string; organizationName?: string } | undefined;
  try { o = JSON.parse(readFileSync(file, 'utf8')).oauthAccount; } catch { return ''; }
  const id = o?.accountUuid ? accountId(o.accountUuid) : '';
  const who = o ? { email: o.emailAddress ?? '', name: o.fullName ?? '', org: o.organizationName ?? '' } : null;
  try { writeFileSync(cacheFile, JSON.stringify({ key, id, o: who }), { mode: 0o600 }); } catch { /* next time */ }
  if (id) note(id, who, now);
  return id;
}

/** Note an account as seen: when new, or not noted for an hour. */
function note(id: string, who: { email: string; name: string; org: string } | null, now: number): void {
  if (!id || !who) return;
  try {
    const s = readAccounts()[id];
    if (s && now - s.last <= 3600) return;
    updateAccounts((seen) => { seen[id] = { ...seen[id], ...who, first: seen[id]?.first ?? now, last: now }; });
  } catch { /* unreadable or busy: noted next time; the id still goes with the event */ }
}

/** The names the person gave, for the hub: id and label only, never an email. */
export const accountLabels = (seen = readAccounts()) =>
  Object.entries(seen).flatMap(([id, a]) => (a.label ? [{ id, label: a.label }] : []));
