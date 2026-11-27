---
name: project-summary
description: Create or update the PROJECT.md summary for the current project (Mission Control hub format). Use at the end of a working session, when a project has no PROJECT.md, or when the user says "update the project summary", "what's this project about", "add a recurring check-in".
---

# Project summary

Format spec: `docs/PROJECT-FORMAT.md` in the Mission Control engine, the folder that holds the `bin/mc`
named in the [Mission Control] note at the start of the session (on Tenzin's laptop:
~/Projects/mission-control/docs/PROJECT-FORMAT.md). Read it before writing.

## Where the summary is
The [Mission Control] note says. Either it is `PROJECT.md` at this project's root, or it is kept in
Mission Control's folder (`<summaries>/<id>/PROJECT.md`) and names this folder in a
`where: - local:` entry (the first is the project's own folder; a project may list more). Edit it
where it is. Never make a second copy, and never reorder its folders.

## No summary yet
1. Read CLAUDE.md, README, any PLAN/STATUS file, `git remote -v`, last commit date.
2. Draft it where the [Mission Control] note says new summaries go; if it says nothing, at the repo
   root. A summary kept in Mission Control lists this folder first: `where: - local: <this folder>`.
   Mark guessed `role`/`client`/`tags` with `# guess`.
3. Show the user the frontmatter and ask about each `# guess` line before saving.

## End of session
Update only: `next` (add what's now pending, delete what was finished), `status` if it changed,
`progress` (below), `updated` to today. Do not rewrite the prose sections unless asked. Then run `<that bin/mc> scan`
and fix any error it reports for this file.

## Progress
`progress` says where the project stands. Keep it true every time you update `next`:
- `phases`: the project's few big steps, in order (`- Build: now`). Mark one `done` when it is
  finished, move `now` on. If there is no `progress` yet, propose phases from the plan, README or
  what the session did, and ask the owner before saving them. A project with no end (support, the
  books) has only a `stage` such as `ongoing`.
- `waiting: me` only while the next step needs the owner (a decision, a login, something to send);
  a name while it waits on someone else; delete it when nobody. `blocked`: one line on what, or delete.

## Cadences
A recurring duty ("check the books monthly") becomes a `cadence` entry with an RFC 5545
`rrule` (no DTSTART, and it must name its day: `BYDAY=MO`, `BYMONTHDAY=1`), a `time` in the
owner's local time, `duration` in minutes, and `notify: [email]`, `[calendar]` or both. Ask the
owner how they want to hear about it. A summary email is `report: digest` or `report: hours` (+ `tag`).
Nothing else is needed: the hub's one engine sends it.
