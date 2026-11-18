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

Hours are worked out on the page from the session events: the gaps between events, each capped at
15 minutes.

## Commands

```
mc init <folder> --owner "Name"   make your Mission Control folder
mc connect <address> --paste      connect this laptop with its key (read from the clipboard, never shown)
mc setup [--dry-run]              connect Claude Code on this laptop
mc discover                       projects worked on lately, and which have a summary
mc scan                           check every summary
mc push                           send every summary
mc open                           open your page
mc report flag|question|note "…"  put something under "Needs you" on your page
mc config [key value]             show or change settings (never shows your key)
```

## Uninstall

Restore `~/.claude/settings.json.bak-mission-control` (or remove the `bin/mc hook` entries and the
project-summary skill link), then delete `~/.mission-control`, your Mission Control folder, and
this one. On your page you can revoke the laptop's key.

The summary format is in [docs/PROJECT-FORMAT.md](docs/PROJECT-FORMAT.md).
