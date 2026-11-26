// Find PROJECT.md files under the configured roots and resolve cwd → project.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { basename, join, dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { parseProjectMd, type ParseResult } from './format.ts';
import { expand, settings } from './config.ts';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.expo', '.next', 'drafts']);
const MAX_DEPTH = 2; // ~/Projects/<project>/PROJECT.md, plus one nested level

/** The folders scanned: the roots (summaries kept inside their projects), then Mission Control's
 *  own summaries folder (stubs/ on the first install). MC_ROOTS overrides both. */
export function defaultRoots(): string[] {
  const env = process.env.MC_ROOTS;
  if (env) return env.split(':').map((p) => resolve(expand(p)));
  const s = settings();
  return [...s.roots, s.summaries];
}

/** Is `p` the folder `dir` or inside it? */
export function isInside(p: string, dir: string): boolean {
  const rel = relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** A summary kept in Mission Control's summaries folder, and the project folder it covers. */
export interface KeptSummary { id: string; path: string; folder: string }

const keptCache = new Map<string, KeptSummary[]>();

/** Summaries in Mission Control's folder that name a project folder (their first `local` entry).
 *  A session anywhere in that folder counts toward that project. Read once per process. */
export function keptSummaries(dir = settings().summaries): KeptSummary[] {
  let hit = keptCache.get(dir);
  if (!hit) {
    hit = [];
    for (const f of findProjectFiles(dir)) {
      try {
        const r = parseProjectMd(readFileSync(f, 'utf8'), f);
        const local = r.ok ? r.project.where.find((w) => 'local' in w)?.local : undefined;
        if (r.ok && local) hit.push({ id: r.project.id, path: f, folder: resolve(expand(local)) });
      } catch { /* unreadable: skip */ }
    }
    keptCache.set(dir, hit);
  }
  return hit;
}

/** Tests write new summaries between calls. */
export function forgetKeptSummaries(): void {
  keptCache.clear();
}

export function findProjectFiles(root: string, depth = 0): string[] {
  if (!existsSync(root)) return [];
  const own = join(root, 'PROJECT.md');
  // A project's own subfolders are not scanned: one PROJECT.md per tree.
  if (depth > 0 && existsSync(own)) return [own];
  if (depth >= MAX_DEPTH + 1) return [];
  const out: string[] = depth === 0 && existsSync(own) ? [own] : [];
  for (const name of readdirSync(root)) {
    if (SKIP.has(name) || name.startsWith('.')) continue;
    const p = join(root, name);
    try {
      const dotGit = join(p, '.git');
      if (existsSync(dotGit) && statSync(dotGit).isFile()) continue; // a git worktree: a second copy of a project
      if (statSync(p).isDirectory()) out.push(...findProjectFiles(p, depth + 1));
    } catch {
      /* unreadable entry: skip */
    }
  }
  return out;
}

export function scan(roots = defaultRoots()): { results: ParseResult[]; duplicateIds: string[] } {
  const files = [...new Set(roots.flatMap((r) => findProjectFiles(r)))];
  const results = files.map((f) => parseProjectMd(readFileSync(f, 'utf8'), f));
  const seen = new Map<string, number>();
  for (const r of results) if (r.ok) seen.set(r.project.id, (seen.get(r.project.id) ?? 0) + 1);
  return { results, duplicateIds: [...seen].filter(([, n]) => n > 1).map(([id]) => id) };
}

/** The hub's own project. A session started at the top of ~/Projects, above every project, is a
 *  Mission Control session (~/Projects/CLAUDE.md), so its time counts here. */
export const HUB_PROJECT = 'mission-control';

/** Is `cwd` one of the scan roots itself (~/Projects), not a folder inside one? */
export function isScanRoot(cwd: string, roots = defaultRoots()): boolean {
  const d = resolve(cwd);
  return roots.some((r) => resolve(r) === d);
}

/** What a session in `cwd` counts toward: the nearest PROJECT.md; mission-control at the top of
 *  ~/Projects; otherwise 'unassigned' (a group folder such as clients/acme, or a new one,
 *  where the session is asked whether to create a PROJECT.md). */
export function sessionProject(cwd: string): { id: string; path: string | null; root: boolean; kept?: true } {
  const start = scratchpadHome(cwd) ?? cwd; // working in its own temp folder: where it started
  const home = projectForDir(start) ? null : worktreeHome(start);
  const p = projectForDir(home ?? start);
  if (p) return { ...p, root: false };
  if (isScanRoot(start)) return { id: HUB_PROJECT, path: null, root: true };
  return { id: 'unassigned', path: null, root: false };
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TEMP = new RegExp(`/claude-\\d+/(-[^/]+)/${UUID}(?:/|$)`, 'i');
const encoded = (name: string) => name.replace(/[^A-Za-z0-9]/g, '-');

/** The folder a session started in, when `cwd` is that session's own Claude Code temp folder (its
 *  scratchpad, or its tasks): <tmp>/claude-<uid>/<start folder>/<session id>/…, the start folder
 *  written with every character but letters and digits as '-'. Null when `cwd` is no such folder
 *  or the start folder is gone. */
export function scratchpadHome(cwd: string): string | null {
  const m = TEMP.exec(resolve(cwd).split(sep).join('/'));
  return m ? findEncoded(m[1]) : null;
}

const TRANSCRIPT = new RegExp(`/projects/(-[^/]+)/${UUID}\\.jsonl$`, 'i');

/** The folder a session was opened in: Claude Code keeps its transcript at
 *  <config>/projects/<that folder, encoded as above>/<session id>.jsonl. `cwd` is tried first, the
 *  usual answer, so the disk is only walked once a session has gone elsewhere. Null when unknown. */
export function openedIn(transcriptPath: string | undefined, cwd?: string): string | null {
  if (!transcriptPath) return null;
  const m = TRANSCRIPT.exec(transcriptPath.split(sep).join('/'));
  if (!m) return null;
  if (cwd && encoded(resolve(cwd)) === m[1]) return resolve(cwd);
  return findEncoded(m[1]);
}

/** The folder on disk that a Claude Code folder name stands for. A dash may be a slash or part of a
 *  name, so it is found by walking from /, longer names first. Null when it is gone. */
function findEncoded(enc: string): string | null {
  const walk = (dir: string, rest: string, depth: number): string | null => {
    if (!rest) return dir;
    if (depth > 24) return null;
    let names: string[];
    try { names = readdirSync(dir); } catch { return null; }
    for (const name of names.sort((a, b) => b.length - a.length)) {
      const e = encoded(name);
      if (rest !== e && !rest.startsWith(e + '-')) continue;
      const p = join(dir, name);
      try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
      const found = walk(p, rest.slice(e.length + 1), depth + 1);
      if (found) return found;
    }
    return null;
  };
  try { return walk(sep, enc.slice(1), 0); } catch { return null; }
}

/** The main checkout a git worktree outside it was made from: `git worktree add ../app-topic` puts
 *  parallel work beside the project's folder, where no summary covers it. Its .git file names the
 *  main checkout; one already removed (read later from a transcript) goes by its name, `app-topic`
 *  beside a kept summary's folder `app` (summaries in a project's own folder are not matched by
 *  name), the longest such name winning. Null when neither. */
export function worktreeHome(cwd: string): string | null {
  for (let d = resolve(cwd); ; d = dirname(d)) {
    let st;
    try { st = statSync(join(d, '.git')); } catch { st = null; }
    if (st) {
      if (st.isDirectory()) break; // a checkout (even one far up, like a home folder kept in git)
      let text = '';
      try { text = readFileSync(join(d, '.git'), 'utf8'); } catch { return null; } // unreadable: not a worktree we can follow
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
      const git = m ? resolve(d, m[1]) : ''; // git 2.48+ can write it relative
      const at = git.lastIndexOf(`${sep}.git${sep}worktrees${sep}`);
      return at > 0 ? git.slice(0, at) : null;
    }
    if (dirname(d) === d) break;
  }
  const d = resolve(cwd);
  let best: string | null = null;
  for (const k of keptSummaries()) {
    const parent = dirname(k.folder) + sep;
    if (!d.startsWith(parent)) continue;
    const top = d.slice(parent.length).split(sep)[0];
    if (!top.startsWith(basename(k.folder) + '-') || (best && k.folder.length <= best.length)) continue;
    // Only a folder that is gone: one still here has its own .git (a worktree's pointer was read
    // above; a directory is a repository of its own) or is a plain folder, and neither is guessed.
    if (existsSync(join(parent, top))) continue;
    best = k.folder;
  }
  return best;
}

/** The project `cwd` belongs to: the nearest ancestor holding a PROJECT.md, or a summary kept in
 *  Mission Control whose folder holds `cwd`, whichever folder is nearer (a tie goes to the file in
 *  the folder). Null if neither, or if the nearest PROJECT.md is invalid. `kept`: the summary is
 *  in Mission Control's folder, not the project's. */
export function projectForDir(cwd: string): { id: string; path: string; kept?: true } | null {
  const d = resolve(cwd);
  const own = nearestProjectMd(d);
  const kept = keptSummaries()
    .filter((k) => isInside(d, k.folder))
    .sort((a, b) => b.folder.length - a.folder.length)[0];
  if (kept && (!own || kept.folder.length > own.dir.length)) return { id: kept.id, path: kept.path, kept: true };
  return own?.id ? { id: own.id, path: own.path } : null;
}

function nearestProjectMd(start: string): { dir: string; path: string; id: string | null } | null {
  let dir = start;
  for (;;) {
    const f = join(dir, 'PROJECT.md');
    if (existsSync(f)) {
      const r = parseProjectMd(readFileSync(f, 'utf8'), f);
      return { dir, path: f, id: r.ok ? r.project.id : null };
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
