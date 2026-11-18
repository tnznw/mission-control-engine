// Local, append-only logs. Hooks write here first so offline sessions are never lost; uploads to
// the hub are idempotent by id, and an offset file records how much has been sent.
//   outbox.jsonl  time events (sent by `mc flush`)
//   usage.jsonl   token counts per Claude response (sent by `mc usage`)
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ActivityEvent } from './time.ts';
import type { UsageRow } from './cost.ts';

export const MC_HOME = process.env.MC_HOME ?? join(homedir(), '.mission-control');

function makeOutbox<T>(name: string, sentName: string) {
  const file = () => join(MC_HOME, name);
  const sentFile = () => join(MC_HOME, sentName);
  const readAll = (): T[] => {
    if (!existsSync(file())) return [];
    return readFileSync(file(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as T];
        } catch {
          return []; // a torn final line from a killed hook: ignore
        }
      });
  };
  return {
    append(items: T[]): void {
      if (!items.length) return;
      mkdirSync(MC_HOME, { recursive: true });
      appendFileSync(file(), items.map((x) => JSON.stringify(x)).join('\n') + '\n');
    },
    readAll,
    /** Items not sent yet. markSent(n) records that the first n of them went (all by default). */
    unsent(): { items: T[]; markSent: (n?: number) => void } {
      const all = readAll();
      const offset = existsSync(sentFile()) ? Number(readFileSync(sentFile(), 'utf8')) || 0 : 0;
      const items = all.slice(offset);
      return { items, markSent: (n = items.length) => writeFileSync(sentFile(), String(offset + n)) };
    },
  };
}

const events = makeOutbox<ActivityEvent>('outbox.jsonl', 'sent-offset');
export const usageOutbox = makeOutbox<UsageRow>('usage.jsonl', 'usage-sent-offset');

export function append(e: ActivityEvent): void {
  events.append([e]);
}

export const readAll = events.readAll;

export function unsent(): { events: ActivityEvent[]; commit: () => void } {
  const u = events.unsent();
  return { events: u.items, commit: () => u.markSent() };
}
