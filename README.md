# Jarvis

A desktop pet that shows the live state of every Claude Code session you have
running, floats above every window on every Space, and tells you the moment a
session is blocked waiting on you.

**Zero install into Claude Code.** No plugin, no hooks, no config changes — it
reads state Claude Code already writes to disk.

```
  JARVIS  NEEDS YOU   10 live sessions
  1 needs you  ·  2 working  ·  7 idle

  #  SESSION                        PROJECT                  STATE       AGE   NOTE
   1 > claude-pet-2f                claude_pet               WORKING     5m
   9 ! prediction-markets-backend-… prediction-markets-back… NEEDS YOU   3d    input needed
```

## How it knows, without asking

**Live status** comes from `~/.claude/sessions/<pid>.json`, which Claude Code
maintains for every running session:

```json
{ "pid": 86952, "sessionId": "…", "cwd": "…", "name": "claude-pet-2f",
  "status": "waiting", "waitingFor": "input needed", "updatedAt": 1787997308530 }
```

`status` is `idle | busy | waiting`. We watch that directory with `fs.watch`
(FSEvents on macOS), so it's push, not poll — **no API calls, no polling loop,
no tokens.** Session files outlive their process, so dead ones are filtered
with a `kill(pid, 0)` liveness check.

**Errors and turn completion** come from the transcript,
`~/.claude/projects/<slug>/<sessionId>.jsonl`, tailed from its current end:

| Transcript entry | Gives us |
|---|---|
| `{"subtype":"api_error","error":{…},"retryAttempt":1,"maxRetries":10}` | `blocked` |
| `{"subtype":"turn_duration","durationMs":…}` | `ready` — a turn just finished |
| `{"type":"assistant","message":{…}}` | the message shown on the row |
| `{"type":"user"}` | you're back; clear the badge |

### Blocked detection is deliberately conservative

Claude Code emits an `api_error` on **every retry attempt** and recovers from
most of them by itself, so treating any error as "blocked" would cry wolf
constantly. A session is only blocked when it's genuinely stuck:

```js
if (error.isNetworkDown)          return 'network down';
if (error.rateLimits)             return 'rate limited';
if (retryAttempt >= maxRetries)   return 'retries exhausted';
if (retryAttempt >= 3)            return `retrying (${retryAttempt}/${maxRetries})`;
return null;                      // still recovering — stay quiet
```

Any completed turn clears it.

## States

Highest priority wins the pet's body; the panel lists every session separately.

| State | Meaning |
|---|---|
| `needs_input` | a session is parked waiting on you — **loudest** |
| `blocked` | rate limited, network down, or retries exhausted |
| `ready` | finished, and you haven't looked yet |
| `running` | working |
| `idle` | nothing to say |

## Install

```bash
npm install
npm run build                  # -> dist/Jarvis-darwin-arm64/Jarvis.app
cp -r dist/Jarvis-darwin-arm64/Jarvis.app /Applications/
```

Launch it from Applications. It's an `LSUIElement` app: no Dock icon, no app
switcher entry, never steals focus. Use **Launch at login** in the menubar menu
to have it always there.

### Exact terminal focusing (optional, but it's the good part)

```bash
npm run install-extension      # into Cursor / VS Code / Windsurf
```

Without it, clicking a session raises your editor. With it, you land on the
**exact integrated terminal** that session is running in. Remove any time with
`npm run uninstall-extension`.

## Use

```bash
npm start                  # run from source
npm run status             # one-shot table
npm run watch              # live table in the terminal
node src/cli.js focus 3    # jump to session 3's terminal
node src/cli.js json       # machine-readable snapshot
```

**Click the pet** to open the session list. **Click a session** to jump to its
terminal. **Drag the pet** to move it; the position is remembered. The
**menubar icon is the pet's current state** and carries the same list.

## How "jump to the exact terminal" works

Three different mechanisms, because the editors don't agree on anything:

**iTerm2 / Terminal.app** expose every session to AppleScript along with its
tty, so we read the session's tty from `ps` and select that exact tab.

**Cursor / VS Code / Windsurf** don't — integrated terminals are panes in a web
view, invisible to AppleScript. So it takes two halves:

1. **The right window.** Claude Code's IDE integration writes
   `~/.claude/ide/<port>.lock` naming each editor window's workspace folders.
   We find the most specific open folder containing the session's cwd and run
   `cursor <folder>`, which focuses the existing window instead of opening a
   new one.

2. **The right terminal.** `extension/` is a small companion extension. Jarvis
   writes `~/.claude/jarvis/focus-request.json` with the Claude pid; every open
   window sees it, and each one walks the process tree upward from that pid:

   ```
   pid 86952  <- claude
   pid 86432  <- /bin/zsh                            <- Terminal.processId
   pid 3838   <- Cursor Helper: terminal pty-host
   pid 672    <- Cursor
   ```

   The VS Code API gives `Terminal.processId` for each terminal — the shell pid.
   Whichever window finds one of its terminals in that chain calls
   `terminal.show()` and writes an ack. Every other window ignores the request.

   A plain file is the transport on purpose: no ports, no auth, no handshake,
   and it reaches every window of every editor at once.

**Anything else** falls back to raising the app.

## Cost

Measured on this machine, all four Electron processes summed, idle with 10
sessions tracked:

| | CPU | 
|---|---|
| **Idle (pet breathing)** | **~2%** |
| During a 3s alert nudge | ~4% |
| Session panel open | ~4% |

RSS reads ~300 MB across the four processes, but most of that is the shared
Electron framework counted once per process; the real private footprint is far
smaller.

Two things dominated before they were fixed, and both are worth knowing if you
change the UI:

1. **A permanently running CSS transform animation cost ~7% CPU on its own.**
   The alert nudge composites the whole transparent window at 60fps for as long
   as a session is waiting — which is most of the time. It now fires in ~3s
   bursts on a 30s cycle.
2. **`requestAnimationFrame` fires 60 times a second regardless.** The idle
   animation runs at 4fps, so 56 of every 60 wakeups did nothing. The sprite is
   now stepped by a timer at its own frame rate, and a single-frame animation
   schedules nothing at all.

There is no polling anywhere: session state and transcripts are watched via
FSEvents, and the tray only redraws when something actually changes.

## Making it yours

The sprite sheet and the app icon are **generated, not downloaded** —
`tools/lib/art.js` draws every frame from primitives and `tools/lib/pixel.js`
encodes the PNG by hand. No third-party art, no license, nothing to attribute.

```bash
npm run sprite    # redraw pets/jarvis/jarvis.png
npm run icon      # redraw build/icon.icns from the same code
```

### Colourising line art

`tools/make-helmet.js` turns a flat black-on-white line drawing into a
coloured, animated sheet. Nothing is hand-placed — the regions are found in
the image, so it works on any front-facing helmet or mask:

```bash
node tools/make-helmet.js path/to/lineart.jpg
```

1. Decode, and crop to the drawing's bounding box.
2. Binarise into line / not-line, then flood fill inward from the border to
   separate background from the enclosed regions.
3. Label every enclosed region and classify it by geometry — the eye slits are
   the wide, flat, mirrored pair in the upper-middle band; the gold faceplate
   is the central column top and bottom; everything else is red shell.
4. Paint with per-region gradients, a diagonal specular sheen, and an edge
   vignette, keeping the original linework as the outline.
5. Box-downscale to sprite size, blur the eye mask once for bloom, and render
   one row of frames per state — bob, eye-glow pulse, a scan bar sweeping the
   slits while working, an amber flash and shake when it needs you, a gold
   shimmer when it's done, and a dark flicker when it's blocked.

A pet can set `"rendering": "auto"` in its `pet.json` when it is a downscaled
detailed sprite rather than pixel art, which turns off nearest-neighbour
scaling so its edges don't crawl.

### Using a sheet you downloaded

```bash
npm run add-pet -- ~/Downloads/foxy.png --cols 6 --rows 5
```

It reads the PNG header for the real dimensions, works out the frame size,
scaffolds `pets/foxy/pet.json`, and prints the row mapping it guessed. If the
sheet orders its rows differently, edit the `row` numbers in that file. Pass
`--frames 4,8,4,6` when rows have different frame counts, and `--scale` to
control render size.

Any uniform grid works. Downloaded packs usually ship states like
idle / walk / attack / hurt / death, which map onto ours cleanly:

| Their row | Our state |
|---|---|
| idle | `idle` |
| walk or run | `running` |
| attack, or any "look at me" pose | `needs_input` |
| jump, celebrate, victory | `ready` |
| hurt or death | `blocked` |

To build one by hand instead, drop a folder in `pets/`:

```
pets/my-pet/
  pet.json
  my-pet.png
```

```json
{
  "id": "my-pet",
  "sheet": "my-pet.png",
  "frameWidth": 48, "frameHeight": 48, "scale": 2,
  "animations": {
    "idle":        { "row": 0, "frames": 4, "fps": 4  },
    "running":     { "row": 1, "frames": 6, "fps": 12 },
    "needs_input": { "row": 2, "frames": 4, "fps": 6  },
    "ready":       { "row": 3, "frames": 4, "fps": 5  },
    "blocked":     { "row": 4, "frames": 4, "fps": 3  }
  },
  "bubbles": { "needs_input": ["I need you"] }
}
```

One row per state, frames left to right, transparent PNG, every frame the same
size. Pick it from the menubar under **Pet**.

## Layout

```
src/core/sessions.js     read + watch ~/.claude/sessions, liveness filtering
src/core/transcripts.js  tail each session's transcript: errors, turn ends
src/core/state.js        merge both into one state machine
src/core/focus.js        process-tree walk, AppleScript, editor bridge
src/cli.js               the terminal UI
src/app/main.js          Electron: window flags, tray, notifications
src/app/renderer/        sprite animation, session panel, cursor hit-testing
extension/               VS Code companion for exact-terminal focus
tools/lib/art.js         the pet, drawn from primitives
tools/lib/pixel.js       canvas + hand-rolled PNG encoder
```

## The three lines that make it a pet

```js
win.setAlwaysOnTop(true, 'screen-saver');                           // above fullscreen apps
win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); // every Space
win.setIgnoreMouseEvents(true, { forward: true });                  // clicks pass through
```

`forward: true` keeps mousemove flowing to the renderer even while the window
ignores clicks, so it can hit-test the cursor and re-enable input only over the
pet itself.

## Platform status

| | |
|---|---|
| **macOS** | full support — all Spaces, fullscreen, exact-terminal focusing |
| **Windows** | window and tray work. `setVisibleOnAllWorkspaces` is a no-op, so it lives on one virtual desktop. Terminal focusing is macOS-only; the extension bridge would port, the AppleScript half would not. |
| **Linux** | X11 fine. Wayland cannot position windows or reliably keep them on top — needs a tray-only fallback. |
