'use strict';
/**
 * Jarvis Focus — the missing half of "click a session, land on its terminal".
 *
 * AppleScript can raise Cursor/VS Code, but it cannot reach inside and select
 * one integrated terminal: those are panes in a web view, not scriptable UI
 * objects. The extension host can, because `Terminal.processId` gives us the
 * pid of each terminal's shell.
 *
 * So: Jarvis writes ~/.claude/jarvis/focus-request.json with the pid of the
 * Claude Code process it wants. Every open window sees it, walks the process
 * tree up from that pid, and whichever window owns a terminal in that chain
 * calls terminal.show(). Everyone else ignores it.
 *
 * A plain file is the transport on purpose: no ports, no auth, no handshake,
 * and it works across every window of every VS Code-family editor at once.
 */
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const DIR = path.join(CLAUDE_DIR, 'jarvis');
const REQUEST = path.join(DIR, 'focus-request.json');
const ACK = path.join(DIR, 'focus-ack.json');

const MAX_AGE_MS = 8000; // ignore anything stale, e.g. left over from a crash

let out;
let watcher;
let lastNonce = null;

function log(msg) {
  out?.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function ppid(pid) {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve(null);
      const n = Number(String(stdout).trim());
      resolve(Number.isInteger(n) && n > 1 ? n : null);
    });
  });
}

/** Every pid from `pid` up to init, so we can test terminal ownership. */
async function ancestry(pid) {
  const chain = [];
  let cur = Number(pid);
  for (let i = 0; i < 24 && Number.isInteger(cur) && cur > 1; i++) {
    chain.push(cur);
    cur = await ppid(cur);
    if (cur === null) break;
  }
  return new Set(chain);
}

async function focusTerminalFor(pid) {
  const chain = await ancestry(pid);
  for (const term of vscode.window.terminals) {
    let tpid;
    try {
      tpid = await term.processId;
    } catch {
      continue;
    }
    if (tpid && chain.has(tpid)) {
      term.show(false); // false => actually take keyboard focus
      return term;
    }
  }
  return null;
}

async function handleRequest() {
  let req;
  try {
    req = JSON.parse(fs.readFileSync(REQUEST, 'utf8'));
  } catch {
    return;
  }
  if (!req || !req.pid) return;
  if (req.nonce && req.nonce === lastNonce) return;      // already handled
  if (Date.now() - (req.at || 0) > MAX_AGE_MS) return;   // stale
  lastNonce = req.nonce;

  const term = await focusTerminalFor(req.pid);
  if (!term) {
    log(`pid ${req.pid}: not in this window`);
    return;
  }

  log(`pid ${req.pid}: focused terminal "${term.name}"`);
  try {
    fs.writeFileSync(
      ACK,
      JSON.stringify({
        nonce: req.nonce,
        ok: true,
        terminal: term.name,
        window: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null,
        at: Date.now(),
      })
    );
  } catch {
    /* the ack is best-effort; the focus already happened */
  }
}

function activate(context) {
  out = vscode.window.createOutputChannel('Jarvis Focus');
  context.subscriptions.push(out);
  log('active');

  try {
    fs.mkdirSync(DIR, { recursive: true });
  } catch {
    /* nothing we can do */
  }

  let timer = null;
  try {
    watcher = fs.watch(DIR, (_e, name) => {
      if (name && name !== 'focus-request.json') return;
      clearTimeout(timer);
      timer = setTimeout(() => handleRequest().catch(() => {}), 20);
    });
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch (err) {
    log(`watch failed: ${err.message}`);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('jarvis.listTerminals', async () => {
      const rows = [];
      for (const t of vscode.window.terminals) {
        let pid = null;
        try {
          pid = await t.processId;
        } catch { /* still starting */ }
        rows.push(`${t.name} — pid ${pid}`);
      }
      log(rows.join('\n') || 'no terminals');
      out.show();
    })
  );
}

function deactivate() {
  try {
    watcher?.close();
  } catch { /* already gone */ }
}

module.exports = { activate, deactivate };
