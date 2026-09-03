'use strict';
/**
 * Bring the terminal that owns a Claude Code session to the front.
 *
 * Two different problems, two different mechanisms:
 *
 *  - Real terminal apps (iTerm2, Terminal.app) expose their sessions to
 *    AppleScript, including each one's tty, so we can select the exact tab.
 *
 *  - VS Code-family editors (Cursor, VS Code, Windsurf) do not: their
 *    integrated terminals are panes in a web view, invisible to AppleScript.
 *    For those we raise the right *window* with the editor's own CLI, and ask
 *    the companion extension (see extension/) to select the right *terminal*
 *    inside it. Without the extension installed we still raise the window,
 *    which is where we started.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { CLAUDE_DIR, JARVIS_DIR } = require('./paths');

const IDE_DIR = path.join(CLAUDE_DIR, 'ide');
const REQUEST = path.join(JARVIS_DIR, 'focus-request.json');
const ACK = path.join(JARVIS_DIR, 'focus-ack.json');

/** Process name -> the app name AppleScript knows it by. */
const TERMINALS = [
  [/iTerm2?$/i, 'iTerm'],
  [/(^|\/)Terminal$/i, 'Terminal'],
  [/ghostty/i, 'Ghostty'],
  [/wezterm/i, 'WezTerm'],
  [/kitty/i, 'kitty'],
  [/alacritty/i, 'Alacritty'],
  [/hyper/i, 'Hyper'],
  [/warp/i, 'Warp'],
  [/tabby/i, 'Tabby'],
  [/rio/i, 'Rio'],
  [/Cursor/i, 'Cursor'],
  [/Windsurf/i, 'Windsurf'],
  [/Code Helper|Visual Studio Code|(^|\/)Electron$/i, 'Visual Studio Code'],
];

/**
 * Editors whose terminals need the extension bridge, and where their CLI lives.
 *
 * Absolute paths, not bare names: a packaged macOS app inherits
 * /usr/bin:/bin:/usr/sbin:/sbin and nothing else, so `execFile('cursor', …)`
 * fails with ENOENT even though it works fine from a shell. That failure was
 * silent, which is why clicking a session focused the right terminal but never
 * brought the editor forward or switched Space.
 */
const EDITORS = {
  Cursor: [
    '/usr/local/bin/cursor',
    '/opt/homebrew/bin/cursor',
    '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
  ],
  'Visual Studio Code': [
    '/usr/local/bin/code',
    '/opt/homebrew/bin/code',
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
  ],
  Windsurf: [
    '/usr/local/bin/windsurf',
    '/opt/homebrew/bin/windsurf',
    '/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf',
  ],
};

/** First of the editor's candidate CLI paths that actually exists. */
function editorCli(app) {
  for (const p of EDITORS[app] || []) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* try the next one */ }
  }
  return null;
}

function ps(fields, pid) {
  try {
    return execFileSync('ps', ['-o', fields, '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** The tty a session is attached to, e.g. "/dev/ttys004". */
function ttyFor(pid) {
  const t = ps('tty=', pid);
  if (!t || t === '??' || t === '-') return null;
  return t.startsWith('/dev/') ? t : `/dev/${t}`;
}

/** Walk parents until we recognise a terminal emulator or editor. */
function findTerminal(pid) {
  let cur = Number(pid);
  for (let depth = 0; depth < 12 && cur > 1; depth++) {
    const line = ps('ppid=,comm=', cur);
    if (!line) break;
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) break;
    const ppid = Number(m[1]);
    const comm = m[2];
    for (const [re, app] of TERMINALS) {
      if (re.test(comm)) return { app, pid: cur, comm };
    }
    cur = ppid;
  }
  return null;
}

function osascript(script) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 5000 }, (err) => resolve(!err));
  });
}

// ------------------------------------------------------------ editor path ---

/**
 * Claude Code's IDE integration writes ~/.claude/ide/<port>.lock per editor
 * window, naming that window's workspace folders. We use it to find which
 * open folder a session lives under, so the editor CLI focuses the existing
 * window instead of opening a new one.
 */
function openWorkspaceFolders() {
  let files;
  try {
    files = fs.readdirSync(IDE_DIR);
  } catch {
    return [];
  }
  const folders = [];
  for (const f of files) {
    if (!f.endsWith('.lock')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(IDE_DIR, f), 'utf8'));
      if (j.pid && !alive(j.pid)) continue; // editor has since quit
      for (const w of j.workspaceFolders || []) {
        if (fs.existsSync(w)) folders.push({ folder: w, ide: j.ideName });
      }
    } catch {
      /* torn or stale lock */
    }
  }
  return folders;
}

/** The most specific open workspace folder containing `cwd`. */
function workspaceFor(cwd) {
  if (!cwd) return null;
  const candidates = openWorkspaceFolders()
    .filter((w) => cwd === w.folder || cwd.startsWith(w.folder + path.sep))
    .sort((a, b) => b.folder.length - a.folder.length);
  return candidates[0] || null;
}

async function raiseEditorWindow(app, cwd) {
  const cli = editorCli(app);
  const ws = workspaceFor(cwd);

  // `cursor <folder>` / `code <folder>` picks out the window already showing
  // that folder, rather than opening a second one or guessing.
  let viaCli = false;
  if (cli && ws) {
    viaCli = await new Promise((resolve) => {
      execFile(cli, [ws.folder], { timeout: 5000 }, (err) => resolve(!err));
    });
  }

  // Then activate, always. Activation is what actually pulls you across
  // Spaces, and it is the only thing that works when the CLI is missing.
  const activated = await osascript(`tell application "${app}" to activate`);

  return { ok: viaCli || activated, viaCli, activated, cli };
}

/** Ask the companion extension to select the terminal owning `pid`. */
function requestTerminalFocus(pid) {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.mkdirSync(JARVIS_DIR, { recursive: true });
    fs.writeFileSync(REQUEST, JSON.stringify({ pid, nonce, at: Date.now() }));
  } catch {
    return null;
  }
  return nonce;
}

/** Wait briefly for whichever window owns that terminal to answer. */
async function waitForAck(nonce, timeoutMs = 1800) {
  if (!nonce) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const a = JSON.parse(fs.readFileSync(ACK, 'utf8'));
      if (a.nonce === nonce && a.ok) return a;
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  return null;
}

// ----------------------------------------------------------------- public ---

/**
 * Focus the terminal running `pid`. Resolves with what actually happened so
 * the UI can be honest when it only got partway.
 */
async function focusSession({ pid, cwd }) {
  if (process.platform !== 'darwin') {
    return { ok: false, reason: 'window focusing is macOS-only for now' };
  }

  const term = findTerminal(pid);
  if (!term) return { ok: false, reason: 'could not find the owning terminal' };

  const tty = ttyFor(pid);

  // --- VS Code family: raise the window, extension selects the terminal.
  if (EDITORS[term.app]) {
    const nonce = requestTerminalFocus(pid);
    const raised = await raiseEditorWindow(term.app, cwd);
    const ack = await waitForAck(nonce);
    return {
      ok: raised.ok,
      app: term.app,
      tty,
      exact: !!ack,
      terminal: ack?.terminal || null,
      // Report what actually happened rather than treating the extension's ack
      // as proof the window came forward — those are different things.
      raisedVia: raised.viaCli ? 'cli' : raised.activated ? 'activate' : 'nothing',
      cliPath: raised.cli,
      reason: raised.ok
        ? (ack ? null : 'extension not installed — raised the window only')
        : `could not bring ${term.app} forward`,
    };
  }

  // --- iTerm2: select the exact session by tty.
  if (term.app === 'iTerm' && tty) {
    const ok = await osascript(`
      tell application "iTerm"
        activate
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if tty of s is "${tty}" then
                select w
                select t
                select s
                return
              end if
            end repeat
          end repeat
        end repeat
      end tell`);
    if (ok) return { ok: true, app: term.app, tty, exact: true };
  }

  // --- Terminal.app: same idea, tabs carry a tty.
  if (term.app === 'Terminal' && tty) {
    const ok = await osascript(`
      tell application "Terminal"
        activate
        repeat with w in windows
          repeat with t in tabs of w
            if tty of t is "${tty}" then
              set selected tab of w to t
              set index of w to 1
              return
            end if
          end repeat
        end repeat
      end tell`);
    if (ok) return { ok: true, app: term.app, tty, exact: true };
  }

  // --- Anything else: raise the app and let the user find the tab.
  const ok = await osascript(`tell application "${term.app}" to activate`);
  return ok
    ? { ok: true, app: term.app, tty, exact: false }
    : { ok: false, reason: `could not activate ${term.app}`, app: term.app };
}

module.exports = { focusSession, findTerminal, ttyFor, workspaceFor, openWorkspaceFolders };
