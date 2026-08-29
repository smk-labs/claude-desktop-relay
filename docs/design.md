# The interface, decided

Plain-language: what the app looks like and what it answers, settled in four rounds of
questions rather than discovered while building. Nothing here is a suggestion.

## Shape

Two surfaces, one source. A **web page** the relay serves on its own port, and a **tray
icon** whose menu is the daily path. The page is one codebase and works on macOS and
Windows from the first day; the tray shell is thin, per-platform, reads the same local
API, and can be dropped without breaking anything. macOS tray first.

## The tray menu

Very minimal, four things: the Seat paying now, the next few Seats as one click each,
on and off, and a link that opens the page. Nothing else. A system menu is not a place
for a table.

The icon is a **patch cord**: two dots and a short cord between them. It carries four
states by *shape* as well as colour, because colour alone is unreliable on a light or
dark bar and for some eyes.

- **Off** — cord apart, grey. The relay is up and doing nothing; the Window account pays.
- **On** — cord connected. A Seat is paying and the mechanism is healthy.
- **Strained** — cord connected, amber. The Seat is running out, or it just rotated.
- **Broken** — cord severed, red. The mechanism is dead, or the wrong Seat paid.

## The page, top to bottom

Order is the hierarchy: the further down, the less often you look. Less important
sections collapse or sit behind a tab.

1. Which Windows are open, and who is paying.
2. The current Seat: room left, when it resets.
3. The next few Seats worth switching to.
4. Every Seat, sorted by value.
5. Analytics.
6. The log.
7. Mode and settings.

One column, about 900px, read top to bottom. Two columns only where the hierarchy is
genuinely equal and the things relate; a grid everywhere would destroy the order above.
Theme follows the system, light and dark, with no manual switch.

## A Seat, summarised and expanded

Every Seat is one card per account × organization, expandable.

**Summarised** is one line and four things: the Seat's name, its plan size as a small
badge, one bar for the weekly share with its percent, and the reset as "in 3 hours"
rather than a clock time. The five-hour window is deliberately not on the first line:
weekly is what decides, and two bars across a long list becomes a texture the eye
stops reading.

**Expanded** is the full picture, the way claude-deck and Anthropic's own view show it:
both windows with exact percents and reset times; any per-model cap, which is the only
place a scoped limit appears; plan size and seat type with the full email and
organization; the token equivalent and the cost equivalent; when this Seat last paid and
last refused; and the state of its credential, including the last verdict the server
gave. That last one answers "why was this Seat not chosen", which nothing else can.

## Switching

A click is **in force now**. There is no pending state, no "apply now" and no estimate
beforehand, because a Payer you chose that was not paying yet is harder to hold in your
head than the saving it bought. Switching mid-conversation re-sends that conversation
uncached to the new organization, and the log says so after the fact:

    14:26:04  switched  Acme-2, 6.25x, in force now, 2 conversations re-cached

## Sorting, and the numbers behind it

Sorted by value, using claude-deck's own formula carried over rather than re-derived:
plan multiplier times remaining weekly share, divided by hours until that week resets
raised to a power, adjusted by how the five-hour window's remaining share compares with
the share of that window still ahead.

Its constants are **exposed, not hidden**: a small disclosure with the urgency exponent,
the multiplier weight and the use-it-or-lose-it factor, each showing its default beside
it and a reset. Changing them re-ranks live so the effect is visible, and never touches
the history. The history is counting; these are taste.

No filter builder in the first version. Sorting plus the named groupings the page
already has is enough for a list this size.

## Empty and broken states

Each says what happened and what to do, never just that something is absent.

- **No Seats yet** — the collection command, verbatim.
- **No stats** — rows stay, percents read "unknown". Never zero: zero means measured.
- **Mechanism broken** — a bar above everything naming what broke and the command for it.
- **Everything spent** — says the Window account is paying now, with the nearest reset.

## The log pane

Inside the page, collapsible, newest at the bottom like a chat. Two levels: meaningful
events by default (a switch, a Refusal, an error, an unverified exchange) and every
exchange behind a toggle, because those are two different jobs. A line cap drops the
oldest. It fills while the page is open and starts clean on a refresh.

## Live, but the layout holds still

Numbers, state and the log update themselves. **The order does not.** If the ranking
changes, rows do not move under the cursor; the new order applies on the next refresh.
Clicking something that moved a moment earlier is the worst bug this page can have.

## Identity

Display name **Relay**. Warm neutral palette, generous space, a restrained accent used
only where it carries meaning, and readable type — near the Claude family without
borrowing its marks. Its own logo and icon.

## Not in the first version

Trend charts over time (totals only), saved filter expressions, the Windows tray shell,
and a separate analytics tab. Each can be added later without rewriting anything, which
is the test for leaving something out.

## Out of scope, deliberately

The page does not manage logins. It manages Payers. It may *state* which account a
Window is signed in as; signing in belongs to Claude Desktop.

One Payer covers one relay, and since ADR 0014 that is already one Window. The
relayed Window has its own home, so its own Mode and its own Payer; the Window you
work in is not relayed at all and has no Payer to show. So the page a person opens
is the relayed Window's page, and the "choice affects both Windows" sentence this
paragraph used to carry is gone: there is nothing to warn about.

What is still not built is telling two *relayed* Windows apart from one relay. That
needs walking from a connection to a process to its parent Window, and it is not
needed while the answer is one relay per Window.
