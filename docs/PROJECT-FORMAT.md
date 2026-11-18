# PROJECT.md format (v1.1)

Every project has one `PROJECT.md`, at its root or kept in Mission Control (see "Where it lives").
The hub indexes the YAML frontmatter;
the body is for humans and for Claude. Keep the whole file under ~60 lines: it is a
summary, not documentation. Detail belongs in the project's own CLAUDE.md / README.

## Example

```markdown
---
id: acme-website              # unique, kebab-case, never changes (time logs key on it)
name: Acme website rebuild
status: active                # active | paused | done | archived
role: Developer               # what you are on this project
client: Acme                  # who it is for; "personal" if nobody
tags: [freelance]             # free labels; hour reports can group by tag
where:                        # every place the project lives; first is primary
  - local: ~/Projects/acme/website
  - github: acme/website
  - claude: https://claude.ai/project/...
  - chatgpt: https://chatgpt.com/g/...
cadence:                      # recurring duties → check-ins
  - what: Monthly invoice
    rrule: FREQ=MONTHLY;BYMONTHDAY=1   # RFC 5545, same as Google Calendar
    time: "09:00"                      # local time on the hub
    duration: 30                       # minutes
    notify: [email, calendar]          # how the owner hears about it (default: [calendar])
next:                         # upcoming one-off tasks, soonest first
  - task: Send the homepage draft to Jo
    due: 2026-11-12
updated: 2026-11-05           # set by whoever last edited it
---

## What it is
Two or three sentences: the purpose and the current state.

## What it needs from me
The standing responsibilities, in plain words.

## Notes
Anything a future session needs that isn't obvious from the code.
```

## Rules

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Stable key for time logs and calendar events. Renaming the folder never changes it. |
| `name`, `status`, `updated` | yes | |
| `role`, `client` | no | `client` = who it's for (`personal` if nobody). Hour reports group by client, tag or project. |
| `tags` | no | Lowercase kebab-case labels, such as `freelance`, `friend`, `passion` or `study`. A project can carry several; it then counts toward each tag's hours. |
| `where` | yes | At least one entry. Projects with no folder (Claude/ChatGPT only) get a **stub**: a summary kept in Mission Control with no `local` entry (see "Where it lives"). |
| `cadence` | no | Each project's own check-ins. `rrule` is RFC 5545 without `DTSTART`, and must name its day: weekly needs `BYDAY`, monthly `BYMONTHDAY` or `BYDAY`, yearly `BYMONTH`. `time` is local time on the hub (Melbourne on Tenzin's; default 08:00 for emails). `notify`: `email` and/or `calendar` (default `[calendar]`). Optional `report`: `digest` (needs-you flags, the week ahead, hours by tag) or `hours` (hours per project, with `tag` to filter); a report covers the time since this check-in last ran. |
| `next` | no | `due` is optional. Done items are deleted, not ticked — history lives in git. |

## Where it lives

In one of two places. Neither changes the fields above.

- **In the project's folder**, at its root. A session anywhere in the folder counts toward it. All of
  Tenzin's projects work this way. The scan finds these up to two levels inside a root (the `roots`
  setting, `~/Projects` by default).
- **Kept in Mission Control**, at `<summaries>/<id>/PROJECT.md`. Its first `where: - local:` entry
  names the project's folder, and a session anywhere in that folder counts toward it. The summaries
  folder is `stubs/` on Tenzin's install and `projects/` in a folder made by `mc init`. A stub with no
  `local` entry covers no folder (a Claude- or ChatGPT-only project).

When both apply, the nearer folder wins, and a tie goes to the file in the project's folder. New
summaries go where the `newSummaries` setting says (`mc config`). See [SHELL.md](SHELL.md).

## Who writes it

Claude drafts it on first contact and updates `next`, `status` and `updated` at the end of
a session (the `project-summary` skill). The owner edits freely; Claude never rewrites
sections it wasn't asked about.

## Changes

- **v1.1 (2026-11-06):** cadence `notify`, `report`, `tag`; rules must name their day. All
  check-ins run through one engine (hub `POST /tick`, called by one n8n workflow every 5 minutes).
