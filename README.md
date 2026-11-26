# Mission Control engine

`mc`, the command behind Mission Control: one page over every project you work on with Claude Code.
What each one is, what's next, and where your hours go. Your Claude Code sessions keep a short
summary of each project and time themselves; `mc` sends both to your own page.

This repository is published from Mission Control's own one. Changes made here are overwritten.

## Install

You need Node 20 or later, git, and Claude Code. You also need an invite, which gives you your page
and a laptop key.

```sh
git clone https://github.com/tnznw/mission-control-engine ~/mission-control-engine
cd ~/mission-control-engine && npm install

~/mission-control-engine/bin/mc init ~/mission-control --owner "Your name"
# copy the laptop key from your invite page, then:
~/mission-control/bin/mc connect https://missioncontrol.tenzin.awesomate.app --paste

cd ~/mission-control && claude
# then say: set me up
```

"Set me up" connects Claude Code on this laptop, after showing you exactly what it will change. It
lists the projects you've worked on lately and asks which ones to include. Then it writes a short
summary of each, in your Mission Control folder, and sends them to your page. `mc open` opens the
page.

To update: `cd ~/mission-control-engine && git pull && npm install`.

Already set up a Mission Control of your own, for example from a setup prompt? Don't start a second
one: `mc init <that folder> --owner "Your name" --adopt` switches it to this engine, keeps your
project summaries where they are, and keeps what it replaces. The steps below cover it.

## Set up with Claude Code

You can hand all of it to Claude Code. First open your invite link in the browser and press "Create my
Mission Control". Then paste this into Claude Code, in any folder:

> Set me up on Mission Control. Clone https://github.com/tnznw/mission-control-engine into
> ~/mission-control-engine (git pull if it's already there), run npm install in it, then follow
> "Steps for Claude" in its README.md. My name is <your name>.

The only thing you do yourself is copy your laptop key when Claude asks. Claude reads it from the
clipboard, and it never goes into the chat.

### Steps for Claude

Tell the person in a line what you did after each step.

1. **Check** Node 20 or later and git.
2. **Look for an earlier Mission Control** on this laptop, and say what you find:
   - `~/.mission-control/config.json`;
   - hooks in `~/.claude/settings.json` that run some `…/bin/mc hook`;
   - `~/.claude/skills/project-summary`;
   - a Mission Control folder (often `~/Projects/mission-control`), with `PROJECT.md` files in the
     projects beside it.
3. **Make their Mission Control folder.**
   - **Nothing earlier:** `~/mission-control-engine/bin/mc init ~/mission-control --owner "<name>"`.
   - **An earlier, home-made one:** with their OK, run
     `~/mission-control-engine/bin/mc init <that folder> --owner "<name>" --adopt`. What happens:
     - its project summaries stay where they are;
     - its `CLAUDE.md`, `bin/mc` and settings are kept beside the new ones, as `*.before-engine`;
     - if it kept a time log, `<folder>/bin/mc import-events` brings the earlier hours across.

     Commands only the home-made one had (such as `mc due` or `mc send`) are gone: say so, and say
     that the page shows what's next instead. If `~/Projects/CLAUDE.md` or other notes name those
     commands, offer to update them.
4. **Connect.** Ask them to copy the laptop key from their invite page. Never ask for it in the chat.
   Then run `<folder>/bin/mc connect https://missioncontrol.tenzin.awesomate.app --paste`.
5. **Connect Claude Code.** Run `<folder>/bin/mc setup --dry-run` and say what it will change, then
   run `<folder>/bin/mc setup`. If it reports another setup's hooks or skill, ask, then run it with
   `--replace`, which keeps a copy of what it swaps out.
6. **Hand over.** Tell them to open the Mission Control folder in VS Code, or `cd` there and run
   `claude`, and say "set me up". That folder's CLAUDE.md finds their projects, writes the missing
   summaries, and sends everything to their page.
7. **Live sessions, only if they ask for them.** Tell them what it sends (see "Live sessions"
   below), then run `<folder>/bin/mc config live on` and `<folder>/bin/mc setup`. If their Claude
   Code will not let you change its hooks, ask them to run `<folder>/bin/mc setup` in a terminal.

## What it does on your laptop

- **`mc init`** makes your Mission Control folder: `CLAUDE.md` (which makes Claude your Mission
  Control agent there), `projects/` (one summary per project), and `bin/mc`. Your settings go in
  `~/.mission-control/config.json` (readable by you only).
- **`mc setup`** shows a dry run first. It adds to `~/.claude/settings.json`, after a backup:
  - hooks that time each Claude Code session and give it Mission Control's short rules;
  - leave to edit your summaries folder and to run `mc` without asking each time;
  - a link to the project-summary skill.
- **`mc discover`** reads only the start of each Claude Code transcript (`~/.claude/projects`), to
  learn which folders you work in, and git's own files under the folders you name. It writes nothing.
- **After each session** it reads the token counts Claude Code recorded in its transcripts since the
  last run. It keeps the counts only, never the conversation.

Nothing is written into your project folders unless you ask for a summary to live there.

## What it sends to your page

- **Your project summaries:** the YAML header and the short body of each `PROJECT.md`. Your
  laptop's absolute paths are dropped.
- **Session events:** a session id, the project id, the kind (start, prompt, stop, end), a time,
  and the folder.
- **Token counts per Claude response:** the message id, the model, the counts, and the session.
  These are numbers only, never the conversation.
- **Anything a session reports with `mc report`.**
- **Only with live sessions on:** each open session's state, Claude's last message while it waits
  for you, what a permission request wants to run, a question box's questions, and the session's
  folder. See "Live sessions".

Hours are worked out on the page from the session events: the gaps between events, each capped at
15 minutes.

## Live sessions (optional)

Your page can show which Claude Code sessions are waiting for you, and let you answer their
permission requests from there, from your phone too:

- **Waiting for you:** the end of Claude's last message, and for how long.
- **Needs permission:** what Claude wants to run, with **Allow** and **Deny**. Claude Code shows its
  own prompt as well; whichever you answer first wins.
- **Asking you:** a question box's question and options.
- **Open in VS Code** brings the project's window forward. The session is one of its Claude tabs.

Claude Code takes a reply sent back through a hook as a background event, never as your own
answer, so a reply typed on the page goes as a **message** instead: the relay below.

**The relay: sending a message to a project's session.** Your page can send a message to a
project (a blocked worker's "Send to …" button, or a reply on a waiting session's card). A
watcher started at each Stop (`bin/mc-inbox-wait`, a background hook that may wake its session)
waits for messages until the session's next Stop. Once a minute this laptop fetches the messages
no session has claimed, and claims each on your page for a session whose watcher is running: the
one the message names, else the project's most recent, in any Claude sign-in on the laptop. Only
one claim wins, on any laptop. The watcher wakes the session with it within about 15 seconds, and
the session does it as it does an inbox message, then closes it with `mc done <id> "<what it
did>"`. Your page shows each message as sent, with a session, and done with that reply. One no
session can take yet waits for a session of the project to stop, or for its next session, which
claims it at its start. A message is never taken from a session that saw it; one put for a
session whose watcher stopped before taking it is given back. One named for a session that has
ended stays with it: withdraw it on the page and send it again. A watcher
stops when its session ends, at its next Stop, or after 12 hours.

It is off unless you switch it on, because it sends Claude's messages off your laptop. Your page
keeps each one only while the session waits on it, and forgets a session three days after it
was last heard from. To switch it on:

```sh
~/mission-control/bin/mc config live on
~/mission-control/bin/mc setup     # adds four hooks; shows them first with --dry-run
```

The hooks: a permission request waits up to 30 minutes for your answer on the page, and a question
box is followed while it is open. Every other update is sent in the background, so no session waits
on the network for it. `mc config live off` stops it.

## Commands

```
mc init <folder> --owner "Name"   make your Mission Control folder (--adopt: switch an earlier one over)
mc import-events [file]           bring an earlier setup's time log across
mc connect <address> --paste      connect this laptop with its key (read from the clipboard, never shown)
mc setup [--dry-run] [--replace]  connect Claude Code on this laptop
mc discover                       projects worked on lately, and which have a summary
mc scan                           check every summary
mc push                           send every summary
mc open                           open your page
mc report flag|question|note "…"  put something under "Needs you" on your page
mc config [key value]             show or change settings (never shows your key); live on|off
mc account [list | name <id> <name>]   the Claude account signed in; every one seen here; name one
mc usage --since YYYY-MM-DD       also count AI use from before Mission Control, once
mc progress < file.json           where every project stands, from one status feeder
mc limits [--push]                each account's usage limits (session, weekly, per model)
mc workers [--push]               background workers (claude --bg) running now, and the queue
mc answers [--apply]              answers given on your page to a feeder's questions
mc digests [--since YYYY-MM-DD]   what each session was asked and answered, for your page's summaries
mc relays                         hand messages sent from your page to the sessions waiting for them
```

**Several people on one laptop.** Each person signs in to Claude Code with their own account. Every
session is counted toward the account signed in at the time, so your page splits hours and AI spend
by account. `mc account list` shows the accounts seen on this laptop with their emails (those stay
here); `mc account name <id> "Sam"` gives one the name your page shows.

**Background workers.** `mc config workers on` sends the Claude Code sessions started with
`claude --bg` to your page every two minutes: each one's status, how long it has run, its API cost and
responses in the last ten minutes, and when it last answered. A status feeder can add which
workstream each worker builds (a worker named `<slug>` or `<slug>-<n>` belongs to workstream
`<slug>`), its steps, the work waiting for a slot and the number of slots:
`mc workers --extras < file.json` with `{"slots": 8, "streams": [{"slug", "name", "project", "stage",
"done", "open", "total", "next"}], "queue": [{"name", "slug", "project", "waiting", "planned"}]}`, where `waiting` is
`me`, someone named, or left out when nobody is holding it up (longer values are cut to what the
hub takes). `planned` is true when the item's plan exists, so a worker can start on it, and false
when it needs a plan first; a hub page that reads it counts only planned items as ready. Left out,
it is not known, and the item counts as ready as before. `mc config feed
"<command>"` runs a feeder every ten minutes. Workers an orchestrating session runs as its own background subagents (the
Agent tool) count too: `mc config worker-subagents '<glob>:<glob>'` names their `subagents` folders
(`*` within a folder name) and `mc config worker-type <agent type>` the agent type they run as (`'*'`
for any type, so every background agent a session starts counts). Each
background subagent of that type is a worker while its session is alive, it has not ended on a final
reply, and its transcript grew in the last 15 minutes (or, inside one tool call such as a CI watch, in
the last 3 hours). It is named by its slug when the description reads `<slug> worker` (`site-b3 worker`
is `site-b3`), else by the description.

**Answering from your page.** A feeder's progress can carry the questions its sessions are waiting
on, each with an `id`, its `text`, any `options` and a short `context`. Your page lists them with
their options and a box for your own words. `mc config answer '["python3", "/path/feeder.py",
"answer", "--", "{id}", "{answer}"]'` tells this laptop how to hand an answer back (the `--` keeps an
answer starting with a dash from reading as an option): every minute the hooks fetch new answers and
run that command with `{id}` and `{answer}` filled in, each only as an argument of its own (so an answer
is always one argument), never through a shell.
Exit 0 is handed over, another exit or running out of time refused (shown on the page, which then
takes a new answer); a command that could not start is tried again. A session blocked waiting on its question fires no hooks, so
a feeder's own wait should run `mc answers --apply` too (tracker.py ask --wait does, every minute).

**Summaries.** `mc config digests on` sends each session's prompts and Claude's last reply each
turn, trimmed and with keys, tokens and passwords taken out, to your hub every ten minutes while it
works and at its end. A hub that writes summaries (a sentence or a paragraph about a day, a project
or a session, read aloud on the page) works from these. The first run reads the last two weeks;
`mc digests --since <date>` reads further back.

**Usage limits.** `mc config limits on` sends each account's session, weekly and per-model limits to
your page, the figures the Claude panel shows, every five minutes while you work. Mission Control asks
Claude Code for them (no tokens are spent), once for each sign-in folder in `mc config accounts`
(quote it: `mc config accounts 'default:~/.claude-profiles/*'`):
`default` is Claude Code's own sign-in, and `~/.claude-profiles/*` is every folder in it that has one
(one per account, each set with CLAUDE_CONFIG_DIR). Only the account's short id, its plan name (such
as team) and the figures leave the laptop. The Refresh button on your page asks this laptop to read them again: the hooks
check for it at most once a minute, when a Claude Code session here does something.
On macOS, each reading also says which account VS Code's Claude panel is set to (the CLAUDE_CONFIG_DIR in
VS Code's user settings for the Claude extension, or the main sign-in): your page marks that one
"signed in now". Without it, the page falls back to the account of the last session that did
anything, which a background agent or another window can move.

**Progress.** A status feeder (a project tracker, a script over your plans) sends `mc progress` the
whole list each time: `{"projects": [{"project": "<id>", "stage": "build", "percent": 40, "next":
"…", "waiting": "me", "questions": [{"text": "…", "asked": <epoch>}], "workstreams": [{"name":
"…", "stage": "Build", "done": 4, "open": 1, "total": 11}], "asOf": <epoch>}]}`. A project left out
loses its progress, so use one feeder per person. `mc which <dir...>` maps folders to project ids.

## Uninstall

Restore `~/.claude/settings.json.bak-mission-control` (or remove the `bin/mc hook` entries and the
project-summary skill link), then delete `~/.mission-control`, your Mission Control folder, and
this one. On your page you can revoke the laptop's key.

The summary format is in [docs/PROJECT-FORMAT.md](docs/PROJECT-FORMAT.md).
