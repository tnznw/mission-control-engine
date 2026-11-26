// The Mission Control protocol, as injected into every Claude Code session by the SessionStart
// hook. This is the ONE copy of the rules every project follows (docs/PROTOCOL.md explains them);
// projects never carry their own copy, so changing it here changes it everywhere.
// Keep it short: it is paid for in every session's context.
import { MC_BIN, settings, tilde } from './config.ts';

/** `dismissedTask`: the message stands for a task the owner marked done or dismissed on the dashboard. */
export interface InboxMessage { id: string; kind: string; body: string; createdAt: number; dismissedTask?: string }

const MC = tilde(MC_BIN); // ~/Projects/mission-control/bin/mc on the first install

/** `root`: the session started at the top of a projects folder (`rootDir`). `session`: its id, so its
 *  time can be moved. `removed`: dashboard Done/Dismiss tasks mc has already taken off PROJECT.md
 *  (their messages are left out of `inbox`; the push at session end closes them). `summary`: where
 *  this project's summary is kept when it is in Mission Control's folder, not the project's.
 *  `newSummaries`: Mission Control's summaries folder, when a new project's summary goes there.
 *  `owner` defaults to this laptop's settings (src/config.ts). */
export function sessionContext(
  projectId: string | null,
  inbox: InboxMessage[] | null,
  opts: { root?: boolean; rootDir?: string; session?: string; removed?: string[]; summary?: string; owner?: string; newSummaries?: string; live?: boolean } = {},
): string {
  const owner = opts.owner ?? settings().owner;
  // Live sessions: a question box can be answered from the dashboard, a question at the end of a
  // message cannot (src/live.ts).
  const ask = opts.live
    ? `- When you need ${owner} to decide something before you can go on, ask it with the AskUserQuestion tool (2 to 4 options, your recommendation first) instead of ending your message with the question: ${owner} can usually answer a question box from the Mission Control page, never a question in your message.`
    : '';
  const move = opts.session ? ` If the work turns out to be one project's, move this session's time there: ${MC} assign ${opts.session} <project>` : '';
  if (opts.root) {
    return `[Mission Control] This session started at ${opts.rootDir ?? 'the top of the projects folder'}, above every project, so it is a Mission Control session and its time counts toward mission-control. Work through the mission-control MCP tools (flags, whats_due, send_to_project, log_time); project work belongs in that project's own session.${move}\n${ask ? ask + '\n' : ''}`;
  }
  if (!projectId) {
    const where = opts.newSummaries ? ` Put it in Mission Control's folder, ${opts.newSummaries}/<id>/PROJECT.md, with this folder as its first \`where: - local:\` entry; put it in this folder instead only if ${owner} asks.` : '';
    return `[Mission Control] This folder has no PROJECT.md, so its time is logged as "unassigned". If this is real project work, offer once to create one with the project-summary skill.${where}${move}\n${ask ? ask + '\n' : ''}`;
  }
  const keep = opts.summary
    ? `- Keep this project's summary true. It is kept in Mission Control, not in this folder: ${opts.summary}. Before the session ends, if tasks were finished or new ones appeared, update its \`next\`, \`status\` and \`updated\` there (project-summary skill). It is sent to the hub when the session ends.`
    : `- Keep PROJECT.md true. Before the session ends, if tasks were finished or new ones appeared, update its \`next\`, \`progress\`, \`status\` and \`updated\` (project-summary skill). It is sent to the hub when the session ends.`;
  const lines = [
    `[Mission Control] Project "${projectId}" reports to ${owner}'s Mission Control hub. Protocol:`,
    `- Time is tracked automatically. Log work done outside Claude Code with: ${MC} log <1h30m> "<note>"`,
    keep,
    ...(ask ? [ask] : []),
    `- Report anything ${owner} must decide or know (blocked, deadline at risk, money, a client waiting): ${MC} report flag "<one line>". Use \`question\` for questions, \`note\` for FYI.`,
    `- "Ask/tell Mission Control …" means the mission-control MCP tools (flags, whats_due, send_to_project, log_time, time_report), from any project. Without them: ${MC} report note "<the request>".`,
  ];
  if (opts.removed?.length) {
    lines.push(`- Off PROJECT.md \`next\` already (${owner} marked them done or dismissed them on the dashboard; nothing to do): ${opts.removed.map((t) => `"${t.replace(/\s+/g, ' ').slice(0, 120)}"`).join('; ')}`);
  }
  if (inbox === null) {
    lines.push(`- Inbox: the hub did not answer in time. Check with: ${MC} inbox`);
  } else if (inbox.length) {
    // Tenzin, 2026-11-18 (docs/CONTROL-ROOM.md questions 5 and 8): act without asking, except outward-facing steps.
    lines.push(`- Inbox: ${inbox.length} open message(s) from Mission Control. Do them now, without asking ${owner} first: tasks, answers to questions, notes read. Ask before any outward-facing step: email, messages, publishing, deleting, spending money, or changing a live client account (reading one with read-only credentials is fine). Tell ${owner} in a line what you did, then close each with: ${MC} done <id> "<what you did>"`);
    // Whole (the hub keeps a message to 4000 characters): a caveat at its end must reach the session.
    for (const m of inbox) lines.push(`  • ${m.id} (${m.kind}): ${m.body.replace(/\s+/g, ' ').slice(0, 4000)}`);
  }
  return lines.join('\n') + '\n';
}
