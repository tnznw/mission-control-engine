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
mc init <folder> --owner "Name"   make your Mission Control folder (--adopt: switch an earlier one over)
mc import-events [file]           bring an earlier setup's time log across
mc connect <address> --paste      connect this laptop with its key (read from the clipboard, never shown)
mc setup [--dry-run] [--replace]  connect Claude Code on this laptop
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
