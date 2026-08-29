# 0016. A Window is opened by the machine, never run by us

2026-08-26

## What was decided

On macOS a Window is started with `/usr/bin/open -n -a <bundle> --env ... --args
--user-data-dir=<folder>`, and never by running
`Claude.app/Contents/MacOS/Claude` ourselves. On Windows the executable is started
directly, because there the launcher already sits inside the user's own session.

## The bug this exists to stop, and how long it hid

A profile opened from the launcher came up very slowly and loaded nothing: the
conversation list appeared, the project and its git status appeared, and every
chat in it said "No messages yet". It survived two rounds of fixing that were
aimed at the wrong thing, and it is worth writing down what each round actually
proved, because all three traps are still there for the next person.

**Trap one: a Window inherits whatever starts it.** Handing it the launcher's own
environment put a Code session's variables inside an application:
`ANTHROPIC_BASE_URL`, `API_TIMEOUT_MS=900000`, `MCP_CONNECTION_NONBLOCKING`,
`MCP_SERVER_CONNECTION_BATCH_SIZE`, `CLAUDECODE`, `AI_AGENT`, `MallocNanoZone`.
A list of names to drop is always one name behind, so what may travel is named
instead. `src/profiles/internal/environment.ts`.

**Trap two, and this was the real one: running the executable is not launching the
application.** Measured with the two Windows side by side:

| | the Window the machine started | the Window we ran |
| --- | --- | --- |
| parent | `launchd` | the relay's launchd agent |
| `XPC_SERVICE_NAME` | `application.com.anthropic.claudefordesktop.<numbers>` | `com.claude-desktop-relay.agent.8980` |
| `__CFBundleIdentifier` | `com.anthropic.claudefordesktop` | absent |

An app started as a child of a launchd agent stays inside that agent's job. It
never gets an application job of its own, and an application job is how macOS
decides what an app may do while it is not in front. That is the slowness, and no
amount of environment work touches it. `open` had been used by the first launcher
and was dropped for two reasons that both have answers: it activated whatever was
already running, which is `-n`, and it carried no environment, which is `--env`.

**Trap three, which only a measurement finds: `open` hands the application the
environment `open` itself was run with.** The first Window opened the new way came
up holding the Code session's variables again, with none of them named after
`--env`. So the built environment is given to `open` as its own, and `--env`
carries only what is being set on purpose.

## How to tell in one line, next time

```bash
ps -Ewwwp $(pgrep -f "user-data-dir=<folder>" | head -1) -o args=
```

Two names decide it. `XPC_SERVICE_NAME` beginning `application.` and a
`__CFBundleIdentifier` that is present mean the machine launched it. Our agent's
label there, or no bundle identifier at all, means we ran it and it will be slow.
The rest of that line is the environment, which is the answer to trap one: it
should hold the same fourteen names the user's own Window holds and not one more.

## The empty chats, which took three tries to see

A conversation's title lives in the Desktop folder and its messages live in a
Claude Code transcript. ADR 0014 gives a relayed Window its own `CLAUDE_CONFIG_DIR`
so those transcripts land in `code-config`, away from the user's own.

**The app does not read them there.** The spawned Code session honours
`CLAUDE_CONFIG_DIR` and writes to `code-config/projects`, and the desktop side reads
history from `~/.claude/projects`, a fixed path. So a relayed Window records every
conversation and then shows all of them as "No messages yet", while the list itself
is fine because the list comes from the Desktop folder.

It is the same split in the plugin screen: `~/.claude/plugins` is read whatever the
config directory says, which is why a Window whose own plugin file is `{}` shows
the user's thirty-four.

Proved by removing the workaround and watching the history empty again, twice.

The fix is one symlink rather than a copy that has to be repeated for every new
chat: `code-config/projects` **is** `~/.claude/projects`. The two paths are one
directory, so a session writes where the app reads, and the isolation that
matters (plugins, settings, MCP servers) stays.

```bash
ln -s ~/.claude/projects ~/.claude-relayed/code-config/projects
```

Transcript bodies being shared costs nothing: which conversations a Window offers
comes from its own Desktop folder, so the other Window still lists only its own.

Two wrong turns on the way here, both worth naming. The store was read from a
session in the **billing** Window, where ADR 0014 says there is nothing of ours to
find, and the missing names were read as the app having stopped applying them.
And when the transcripts turned out to be in `code-config` after all, that was read
as proof the isolation worked, when what it proved was only that the *writing* side
works.

## The rule this leaves behind

Do not believe a variable arrived because it was set. Read it back from the thing
that was supposed to receive it: `ps -Ewww` for a Window, `env` inside a session.
Both faults above were invisible from the writing side and obvious from the
reading side.
