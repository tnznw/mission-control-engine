// Active time from raw session events. Wall time lies (sessions sit open overnight),
// so each gap between consecutive events in a session is capped at idleCap.
// The hub stores raw events and runs these same functions at query time.

export type EventKind = 'start' | 'tick' | 'end';
export interface ActivityEvent {
  id: string; // client uuid — makes uploads idempotent
  session: string;
  project: string; // project id, or 'unassigned'
  kind: EventKind;
  ts: number; // epoch seconds
  cwd: string;
}

export const DEFAULT_IDLE_CAP = 15 * 60;

/** One stretch of active time: a gap between consecutive events in a session, capped at idleCap,
 *  credited to the project of the event that opened it. */
export interface Stretch { project: string; start: number; seconds: number }

export function stretches(events: ActivityEvent[], idleCap = DEFAULT_IDLE_CAP): Stretch[] {
  const bySession = new Map<string, ActivityEvent[]>();
  for (const e of events) {
    const list = bySession.get(e.session) ?? [];
    list.push(e);
    bySession.set(e.session, list);
  }
  const out: Stretch[] = [];
  for (const list of bySession.values()) {
    list.sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < list.length; i++) {
      const seconds = Math.min(Math.max(0, list[i].ts - list[i - 1].ts), idleCap);
      if (seconds > 0) out.push({ project: list[i - 1].project, start: list[i - 1].ts, seconds });
    }
  }
  return out;
}

/** Seconds of active time per project. */
export function activeSeconds(events: ActivityEvent[], idleCap = DEFAULT_IDLE_CAP): Map<string, number> {
  const totals = new Map<string, number>();
  for (const s of stretches(events, idleCap)) totals.set(s.project, (totals.get(s.project) ?? 0) + s.seconds);
  return totals;
}

/** Weight of time worked `ageSeconds` ago: 1 when fresh, halving every `halfLifeDays`. */
export function decay(ageSeconds: number, halfLifeDays: number): number {
  return Math.pow(0.5, Math.max(0, ageSeconds) / (halfLifeDays * 86400));
}

/** Momentum per project, in hours: each stretch counts its hours times decay(age at its middle).
 *  Every project decays at the same rate, so only new work changes the order (docs/DASHBOARD.md). */
export function momentum(events: ActivityEvent[], now: number, halfLifeDays: number, idleCap = DEFAULT_IDLE_CAP): Map<string, number> {
  const totals = new Map<string, number>();
  for (const s of stretches(events, idleCap)) {
    const w = (s.seconds / 3600) * decay(now - (s.start + s.seconds / 2), halfLifeDays);
    totals.set(s.project, (totals.get(s.project) ?? 0) + w);
  }
  return totals;
}

export function hours(seconds: number): number {
  return Math.round((seconds / 3600) * 10) / 10;
}
