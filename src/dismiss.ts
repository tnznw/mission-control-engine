// Done or Dismiss on the dashboard, applied on the laptop: take those tasks off a PROJECT.md's
// `next` without a session having to ask. The hub never edits project files; mc does, here, when
// a session starts or ends (the hook) and on `mc push`. The next push then settles the dismissal.
//
// The edit is surgical: only the lines of the matching `next` items are cut, so comments, quoting
// and the order of everything else stay byte for byte. It is checked by parsing the result: the
// project must come out identical apart from the removed tasks, or the file is left alone (its
// own session can still do it by hand from the inbox message).
import { parseDocument, isMap, isSeq } from 'yaml';
import { parseProjectMd } from './format.ts';

const OPEN = /^---\r?\n/;
const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Text with every `next` item whose task is exactly one of `tasks` removed, and which came off;
 *  null when none matched or the file can't be edited safely. */
export function removeTasks(text: string, tasks: string[]): { text: string; removed: string[] } | null {
  const open = OPEN.exec(text), m = FM.exec(text);
  const before = parseProjectMd(text, '');
  if (!open || !m || !before.ok || !tasks.length) return null;
  const start = open[0].length, fm = m[1];
  const next = parseDocument(fm).get('next', true);
  if (!isSeq(next) || next.flow) return null;

  const want = new Set(tasks), cuts: [number, number][] = [], removed: string[] = [];
  for (const item of next.items) {
    if (!isMap(item) || !item.range) continue;
    const task = item.get('task');
    if (typeof task !== 'string' || !want.has(task)) continue;
    const lineStart = fm.lastIndexOf('\n', item.range[0] - 1) + 1;
    if (!/^[ \t]*-[ \t]+$/.test(fm.slice(lineStart, item.range[0]))) return null; // "- task:" is not on its own line
    let end = item.range[1];
    while (end > item.range[0] && /\s/.test(fm[end - 1])) end--;
    const nl = fm.indexOf('\n', end);
    // The last item of the frontmatter has no newline after it: take the one before instead.
    cuts.push(nl < 0 ? [Math.max(0, lineStart - 1), fm.length] : [lineStart, nl + 1]);
    removed.push(task);
  }
  if (!cuts.length) return null;

  let out = fm;
  for (const [a, b] of cuts.reverse()) out = out.slice(0, a) + out.slice(b);
  // Every task gone: `next:` with nothing under it would be null, which the format rejects.
  if (removed.length === next.items.length) out = out.replace(/^next:[ \t]*$/m, 'next: []');

  const result = text.slice(0, start) + out + text.slice(start + fm.length);
  const after = parseProjectMd(result, '');
  const gone = new Set(removed);
  const expected = { ...before.project, next: before.project.next.filter((t) => !gone.has(t.task)) };
  if (!after.ok || JSON.stringify(after.project) !== JSON.stringify(expected)) return null;
  return { text: result, removed };
}
