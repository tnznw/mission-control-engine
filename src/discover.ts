// mc discover: the projects someone is working on, found from how they work rather than from a
// folder layout Mission Control expects. Two sources:
//   - every folder Claude Code has run a session in (each transcript records its cwd), and
//   - git repositories under the configured roots, by their last commit or checkout.
// Each folder is folded into its git repository (a session in ~/code/app/server is ~/code/app's,
// a worktree is its main repository's), and folders that share a summary are one project.
// Read-only: it lists, the Mission Control agent proposes, and the person decides.
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { isInside, keptSummaries, projectForDir } from './scan.ts';
import { transcriptRoot } from './usage.ts';

export interface Found {
  folder: string;
  last: number; // epoch seconds: the newest Claude Code session or git activity
  sessions: number; // Claude Code sessions recorded there
  git: boolean;
  group: string | null; // the folder it sits in under a root (often the client or the area), else its parent
  summary: { id: string; path: string; kept: boolean } | null;
}

export interface DiscoverOptions {
  roots: string[];
  days: number;
  now: number; // epoch seconds
  transcripts?: string; // Claude Code's projects folder
  home?: string;
  skip?: string[]; // folders never listed, nor anything inside them
  keepTemp?: boolean; // list folders under the temp folders too (tests only)
}

const SKIP_NAMES = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.expo', 'vendor', 'Library']);
const GIT_DEPTH = 3;
const HEAD_BYTES = 256 * 1024;

const mtime = (p: string): number | null => {
  try {
    return Math.floor(statSync(p).mtimeMs / 1000);
  } catch {
    return null;
  }
};

/** The cwd a transcript records: its first `"cwd":"..."` in the first 256 KB. */
export function transcriptCwd(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.subarray(0, n).toString('utf8'));
    return m ? (JSON.parse(`"${m[1]}"`) as string) : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The repository `dir` belongs to: the nearest folder with .git below `home` (a worktree or
 *  submodule counts as its main repository); `dir` itself, git false, if none. */
export function repoOf(dir: string, home: string): { root: string; git: boolean } {
  for (let d = dir; d !== home && dirname(d) !== d; d = dirname(d)) {
    const g = join(d, '.git');
    try {
      const st = statSync(g);
      if (st.isDirectory()) return { root: d, git: true };
      if (st.isFile()) {
        const to = /^gitdir:\s*(.+)$/m.exec(readFileSync(g, 'utf8'))?.[1]?.trim();
        const main = to ? new RegExp(`^(.*)\\${sep}\\.git\\${sep}(worktrees|modules)\\${sep}`).exec(resolve(d, to)) : null;
        return { root: main ? main[1] : d, git: true };
      }
    } catch { /* no .git here */ }
  }
  return { root: dir, git: false };
}

/** Folders with Claude Code sessions: cwd, number of sessions, newest session. */
function fromTranscripts(root: string): { cwd: string; sessions: number; last: number }[] {
  const out: { cwd: string; sessions: number; last: number }[] = [];
  let folders: string[] = [];
  try {
    folders = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of folders) {
    const dir = join(root, name);
    let files: { f: string; t: number }[] = [];
    try {
      files = readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ f: join(dir, f), t: mtime(join(dir, f)) ?? 0 }))
        .sort((a, b) => b.t - a.t);
    } catch {
      continue;
    }
    if (!files.length) continue;
    const cwd = files.slice(0, 3).map((x) => transcriptCwd(x.f)).find(Boolean);
    if (cwd) out.push({ cwd, sessions: files.length, last: files[0].t });
  }
  return out;
}

/** Git repositories under `root`, up to three levels down, with their last commit or checkout. */
function gitRepos(root: string, depth = 0): { dir: string; last: number }[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  if (entries.includes('.git')) {
    const last = mtime(join(root, '.git', 'logs', 'HEAD')) ?? mtime(join(root, '.git', 'HEAD'));
    try {
      if (statSync(join(root, '.git')).isDirectory() && last) return [{ dir: root, last }];
    } catch { /* fall through */ }
    return [];
  }
  if (depth >= GIT_DEPTH) return [];
  const out: { dir: string; last: number }[] = [];
  for (const name of entries) {
    if (name.startsWith('.') || SKIP_NAMES.has(name)) continue;
    const p = join(root, name);
    try {
      if (statSync(p).isDirectory()) out.push(...gitRepos(p, depth + 1));
    } catch { /* unreadable */ }
  }
  return out;
}

/** Everything worked on in the last `days`, newest first. */
export function discover(o: DiscoverOptions): Found[] {
  const home = resolve(o.home ?? homedir());
  const since = o.now - o.days * 86400;
  const temp = o.keepTemp ? [] : [tmpdir(), '/tmp', '/private/tmp', '/private/var'];
  const skip = [...temp, join(home, '.claude'), ...(o.skip ?? [])].map((p) => resolve(p));
  const roots = o.roots.map((r) => resolve(r));
  const hidden = (p: string) => isInside(p, home) && relative(home, p).split(sep).some((s) => s.startsWith('.'));
  const listed = (p: string) => p !== home && dirname(p) !== p && !roots.includes(p) && !skip.some((s) => isInside(p, s)) && !hidden(p) && mtime(p) !== null;

  const byFolder = new Map<string, Found>();
  const add = (dir: string, sessions: number, last: number) => {
    const repo = repoOf(resolve(dir), home);
    if (!listed(repo.root)) return;
    const f = byFolder.get(repo.root);
    if (f) {
      f.sessions += sessions;
      f.last = Math.max(f.last, last);
    } else {
      byFolder.set(repo.root, { folder: repo.root, last, sessions, git: repo.git, group: null, summary: null });
    }
  };
  for (const t of fromTranscripts(o.transcripts ?? transcriptRoot())) add(t.cwd, t.sessions, t.last);
  for (const r of roots) for (const g of gitRepos(r)) add(g.dir, 0, g.last);

  // Folders that share a summary are one project, under the summary's own folder when it is one of them.
  const byProject = new Map<string, Found>();
  for (const f of byFolder.values()) {
    if (f.last < since) continue;
    const p = projectForDir(f.folder);
    f.summary = p ? { id: p.id, path: p.path, kept: Boolean(p.kept) } : null;
    const root = roots.find((r) => isInside(f.folder, r));
    const parent = dirname(f.folder);
    f.group = root ? (relative(root, f.folder).split(sep).length > 1 ? relative(root, f.folder).split(sep)[0] : null) : parent === home ? null : basename(parent);
    const key = p ? `id:${p.id}` : `dir:${f.folder}`;
    const seen = byProject.get(key);
    if (!seen) byProject.set(key, f);
    else {
      // The project's own folder (its summary's first entry) when one of the two is it, else the shorter.
      const ownFolder = p?.kept ? keptSummaries().find((k) => k.id === p.id && k.first)?.folder : undefined;
      const keep = f.folder === ownFolder ? f : seen.folder === ownFolder ? seen : seen.folder.length <= f.folder.length ? seen : f;
      const other = keep === seen ? f : seen;
      keep.sessions += other.sessions;
      keep.last = Math.max(keep.last, other.last);
      keep.git ||= other.git;
      byProject.set(key, keep);
    }
  }
  return [...byProject.values()].sort((a, b) => b.last - a.last);
}
