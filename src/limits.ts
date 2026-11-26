// Each Claude account's usage limits (2026-11-24): the session (5-hour) and weekly windows, and any
// kept for one model (Fable), as the Claude panel in VS Code shows them. Asked of Claude Code itself
// over its control channel (`get_usage`, what the panel asks), which spends no tokens. skip_behaviors
// keeps it to about a second; without it Claude Code reads every transcript first (35 s here).
// One Claude Code per sign-in folder (CLAUDE_CONFIG_DIR), so several accounts on one laptop are
// each read with their own sign-in. Only the account's short hash and the figures leave the laptop.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { accountId } from './account.ts';
import { expand } from './config.ts';

export interface LimitWindow { kind: string; label: string; percent: number; resetsAt: number | null; active: boolean }
export interface AccountLimits { id: string; plan: string | null; windows: LimitWindow[]; at: number }

/** The sign-in folders to read: '' is Claude Code's default sign-in (no CLAUDE_CONFIG_DIR, state in
 *  ~/.claude.json); a folder ending in /* is each folder in it that has a sign-in. */
export function limitDirs(entries: string[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e === '' || e === 'default') { out.push(''); continue; }
    if (e.endsWith('/*')) {
      const parent = resolve(expand(e.slice(0, -2)));
      let names: string[] = [];
      try { names = readdirSync(parent).sort(); } catch { continue; }
      for (const n of names) {
        const d = join(parent, n);
        try { if (statSync(d).isDirectory() && existsSync(join(d, '.claude.json'))) out.push(d); } catch { /* gone */ }
      }
      continue;
    }
    out.push(resolve(expand(e)));
  }
  return [...new Set(out)];
}

/** The account signed in to a sign-in folder, as its short id; null when there is none. */
export function accountIn(dir: string): string | null {
  try {
    const o = JSON.parse(readFileSync(join(dir || homedir(), '.claude.json'), 'utf8')).oauthAccount;
    return o?.accountUuid ? accountId(o.accountUuid) : null;
  } catch {
    return null;
  }
}

const secs = (iso: unknown) => {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

/** The windows in Claude Code's answer to get_usage, as the panel lists them. */
export function parseUsage(r: any): { plan: string | null; windows: LimitWindow[] } | null {
  const rl = r?.rate_limits;
  if (!r || !rl) return null;
  const windows: LimitWindow[] = [];
  if (Array.isArray(rl.limits)) {
    for (const l of rl.limits) {
      // One odd window must not cost the whole push (the hub checks every one): finite, and named.
      if (!Number.isFinite(l?.percent) || typeof l?.kind !== 'string' || !l.kind.trim()) continue;
      const model = l.scope?.model?.display_name;
      const period = l.kind.startsWith('session') ? 'session' : 'weekly';
      const label = l.kind === 'session' ? 'Session' : l.kind === 'weekly_all' ? 'Weekly' : typeof model === 'string' && model ? `${model} ${period}` : l.kind.replace(/_/g, ' ');
      windows.push({ kind: String(l.kind).slice(0, 40), label: label.slice(0, 60), percent: Math.max(0, Math.min(100, l.percent)), resetsAt: secs(l.resets_at), active: !!l.is_active });
    }
  } else {
    for (const [kind, label] of [['five_hour', 'Session'], ['seven_day', 'Weekly']] as const) {
      const w = rl[kind];
      if (Number.isFinite(w?.utilization)) windows.push({ kind, label, percent: Math.max(0, Math.min(100, w.utilization)), resetsAt: secs(w.resets_at), active: false });
    }
  }
  return { plan: typeof r.subscription_type === 'string' ? r.subscription_type.slice(0, 40) : null, windows };
}

/** The Claude Code to ask: the one running this hook (a VS Code session's own, which need not be on
 *  PATH), else `claude` on PATH. */
export const claudeBin = () => process.env.CLAUDE_CODE_EXECPATH && existsSync(process.env.CLAUDE_CODE_EXECPATH) ? process.env.CLAUDE_CODE_EXECPATH : 'claude';

/** Claude Code's answer to get_usage for one sign-in folder, or why there is none (not signed in,
 *  too slow, no Claude Code). It runs with no settings, hooks, MCP servers or session file of its own, so it is
 *  never counted as a session, and never with ANTHROPIC_API_KEY, which would read the API key's
 *  limits instead of the subscription's. */
export type Asked = { usage: any } | { error: string };
export function askUsage(dir: string, timeoutMs = 20_000, bin = claudeBin()): Promise<Asked> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^(ANTHROPIC_API_KEY|CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_CONFIG_DIR)$/.test(k)) env[k] = v;
    if (dir) env.CLAUDE_CONFIG_DIR = dir;
    let done = false, buf = '';
    const finish = (v: Asked) => { if (done) return; done = true; clearTimeout(timer); try { p.kill(); } catch { /* gone */ } resolve(v); };
    const p = spawn(bin, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--disable-slash-commands', '--no-chrome', '--no-session-persistence'], { env, cwd: tmpdir(), stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => finish({ error: `no answer in ${timeoutMs / 1000} s` }), timeoutMs);
    p.on('error', (e) => finish({ error: `could not start Claude Code (${bin}): ${e.message}` }));
    p.on('exit', (code) => finish({ error: `Claude Code stopped (exit ${code}) without an answer` }));
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.type === 'control_response' && m.response?.request_id === 'usage') finish(m.response.subtype === 'success' ? { usage: m.response.response } : { error: String(m.response.error ?? 'Claude Code refused get_usage').slice(0, 200) });
        } catch { /* not ours */ }
      }
    });
    p.stdin.on('error', () => {});
    p.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } }) + '\n');
    p.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage', skip_behaviors: true } }) + '\n');
  });
}

/** Every account's limits, one sign-in folder at a time; an account signed in to two folders once.
 *  `missed` says, per folder, why it gave none. */
export async function readLimits(dirs: string[], ask: (dir: string) => Promise<Asked> = (d) => askUsage(d), now = () => Math.floor(Date.now() / 1000)): Promise<{ accounts: AccountLimits[]; missed: { dir: string; why: string }[] }> {
  const seen = new Set<string>();
  const accounts: AccountLimits[] = [];
  const missed: { dir: string; why: string }[] = [];
  for (const dir of dirs) {
    const id = accountIn(dir);
    if (!id) { missed.push({ dir, why: 'no signed-in account' }); continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    const a = await ask(dir);
    const u = 'usage' in a ? parseUsage(a.usage) : null;
    if (u && u.windows.length) accounts.push({ id, ...u, at: now() });
    else missed.push({ dir, why: 'error' in a ? a.error : 'no limits in the answer (an API key, or a plan without them)' });
  }
  return { accounts, missed };
}
