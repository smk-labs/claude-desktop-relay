# Testing on a second Claude Desktop profile, and the six ways I got it wrong

Written 2026-08-24, after a day of tests that answered the wrong question. Every
item here cost real time and every one of them produced a *confident* wrong
reading, which is worse than no reading.

## The checklist, if you read nothing else

1. Launch the window with the relay's own variables **stripped**.
2. Copy the login from the **live** profile, never from an old backup.
3. Prove the window's environment with `ps eww` before you trust any result.
4. Make the stand-in **stream**; never collect a reply and re-send it.
5. Know which window the prompt was typed into before reading the log.
6. Never start a real sign-in flow as a probe.

## 1. The window inherits your shell, and your shell is not clean

`nohup /Applications/Claude.app/... --user-data-dir=X &` run from a session that
already has `ALL_PROXY`, `NODE_EXTRA_CA_CERTS` and `ANTHROPIC_BASE_URL` gives the
test window all three. The profile's own store is then not the only source of
them, which is the whole thing being tested. It read as "SSL verification failed"
and looked like a finding about the design. It was a finding about my shell.

    env -u ALL_PROXY -u all_proxy -u HTTPS_PROXY -u https_proxy \
        -u NODE_EXTRA_CA_CERTS -u NODE_USE_SYSTEM_CA -u ANTHROPIC_BASE_URL \
        /Applications/Claude.app/Contents/MacOS/Claude --user-data-dir=X &

Then check it, because "I stripped them" is not evidence:

    ps eww -o command= -p <pid> | tr ' ' '\n' | grep -E '^(ANTHROPIC_BASE_URL|NODE_)'

## 2. The Code grants are not in the profile

The claude.ai session is a cookie in the profile. The **Code** grants are in the
machine's Keychain under `Claude Code-credentials`, and that entry is **not**
namespaced per profile: every profile on the machine shares it.

So copying an old backup profile's cookie gives a window whose cookie is one
account and whose Code grant is another. That mismatch is what "stale login" and
"it keeps asking me to sign in" actually were. Copy `Cookies`, `Cookies-journal`,
`Local State` and `config.json` from the **live** profile, so both halves name the
same account. Read only; never write into the live profile.

## 3. A stand-in that buffers is a stand-in that lies

The first reverse-proxy stand-in collected the whole reply and then wrote it.
Claude Code streams, so it timed out and retried ten times. Ten arrivals in the
log looked like the lever half-working. Pipe the reply through:

    out.once("response", (up) => { r.writeHead(up.statusCode, up.rawHeaders); up.pipe(r); })

## 4. Absence in a log is not absence in the world

One request in the stand-in's log while the user sees a full answer means the
answer came from somewhere else, not that the lever half-works. Ask which window
the prompt went into before reading anything into the counts. A test whose input
source is ambiguous has no output.

## 5. `lsof -sTCP:LISTEN` is not "is it up"

It missed a listener that was plainly accepting connections, and on the strength
of that I wrote that the machine's proxy was down. It was up the whole time.
`nc -z -w 2 127.0.0.1 <port>` answers the question that was actually being asked.

## 6. Two things that are never a probe

- **`claude setup-token`** opens a real authorization on the user's account in
  their browser. It is not a way to find out how the command behaves. Ask first.
- **`security find-generic-password -g`** prints the secret. The attributes are
  available without `-g`, and the attributes were all that was needed.

## The pattern under all six

Five of the six produced a confident wrong answer rather than an error, and the
one thing that would have caught every one of them is the same: **prove the test
environment before trusting what it says.** The relay's own suite already works
this way against a fake upstream. A second Desktop profile deserves the same
suspicion, and did not get it.
