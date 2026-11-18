// PROJECT.md v1.1: parse + validate. Spec: docs/PROJECT-FORMAT.md
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const isoDate = z
  .union([z.string(), z.date()])
  .transform((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v))
  .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'));

const whereEntry = z
  .record(z.string(), z.string())
  .refine((o) => Object.keys(o).length === 1, 'each where entry has exactly one key')
  .refine((o) => ['local', 'github', 'claude', 'chatgpt', 'url'].includes(Object.keys(o)[0]), 'where key must be local|github|claude|chatgpt|url');

export const Frontmatter = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be kebab-case'),
  name: z.string().min(1),
  status: z.enum(['active', 'paused', 'done', 'archived']),
  role: z.string().optional(),
  client: z.string().optional(),
  tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'tags are lowercase kebab-case')).default([]),
  where: z.array(whereEntry).min(1),
  cadence: z
    .array(
      z.object({
        what: z.string().min(1),
        rrule: z
          .string()
          .regex(/^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/, 'rrule starts with FREQ=DAILY|WEEKLY|MONTHLY|YEARLY (no DTSTART)')
          // Say which day: a rule without one would anchor to whatever date it is expanded from.
          .refine((r) => !/FREQ=WEEKLY/.test(r) || /BYDAY=/.test(r), 'weekly rules need BYDAY (e.g. BYDAY=MO)')
          .refine((r) => !/FREQ=MONTHLY/.test(r) || /BY(MONTH)?DAY=/.test(r), 'monthly rules need BYMONTHDAY or BYDAY (e.g. BYMONTHDAY=1)')
          .refine((r) => !/FREQ=YEARLY/.test(r) || /BYMONTH=/.test(r), 'yearly rules need BYMONTH'),
        time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        duration: z.number().int().positive().default(30),
        // v1.1: how Tenzin hears about it, and an optional report the message carries.
        notify: z.array(z.enum(['email', 'calendar'])).default(['calendar']),
        report: z.enum(['digest', 'hours']).optional(),
        tag: z.string().optional(), // report: hours → only projects with this tag
      }),
    )
    .default([]),
  next: z.array(z.object({ task: z.string().min(1), due: isoDate.optional() })).default([]),
  updated: isoDate,
});

export type Project = z.infer<typeof Frontmatter> & { body: string; path: string };

export type ParseResult = { ok: true; project: Project } | { ok: false; path: string; errors: string[] };

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseProjectMd(text: string, path: string): ParseResult {
  const m = FM.exec(text);
  if (!m) return { ok: false, path, errors: ['missing YAML frontmatter (--- ... ---)'] };
  let data: unknown;
  try {
    data = parseYaml(m[1]);
  } catch (e) {
    return { ok: false, path, errors: [`YAML: ${(e as Error).message.split('\n')[0]}`] };
  }
  const r = Frontmatter.safeParse(data);
  if (!r.success) {
    return { ok: false, path, errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  return { ok: true, project: { ...r.data, body: m[2].trim(), path } };
}
