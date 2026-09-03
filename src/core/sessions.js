'use strict';
/**
 * Reads and watches Claude Code's live session registry.
 *
 * Claude Code maintains ~/.claude/sessions/<pid>.json for every running
 * session, and rewrites it whenever the session changes state. Each file:
 *
 *   { pid, sessionId, cwd, startedAt, version, kind, entrypoint,
 *     messagingSocketPath, name, status, statusUpdatedAt, updatedAt,
 *     waitingFor?, until?, formerNames?, bridgeSessionId? }
 *
 * status is one of: "idle" | "busy" | "waiting"
 * waitingFor is set alongside status === "waiting" (e.g. "input needed").
 *
 * We just watch the directory. No polling, no API calls, no tokens.
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { SESSIONS_DIR } = require('./paths');

/** Is this pid still alive? Session files linger after a session exits. */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check only
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // alive, just not ours to signal
  }
}

/** Turn an absolute cwd into a short project label. */
function projectName(cwd) {
  if (!cwd) return '?';
  return path.basename(cwd) || cwd;
}

function readAll() {
  let files;
  try {
    files = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return []; // Claude Code has never run, or a different config dir
  }

  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue; // skip the sibling .key files
    let raw;
    try {
      raw = fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8');
    } catch {
      continue; // rewritten out from under us; we'll catch it next tick
    }
    let s;
    try {
      s = JSON.parse(raw);
    } catch {
      continue; // torn read mid-write
    }
    if (!s || !isAlive(s.pid)) continue;

    out.push({
      pid: s.pid,
      sessionId: s.sessionId,
      name: s.name || `session-${s.pid}`,
      // Absent means you named it yourself: Claude Code only writes this field
      // when it made the name up. Do not default it.
      nameSource: s.nameSource ?? null,
      cwd: s.cwd,
      project: projectName(s.cwd),
      status: s.status || 'idle',
      waitingFor: s.waitingFor || null,
      until: s.until || null,
      kind: s.kind || 'interactive',
      entrypoint: s.entrypoint,
      version: s.version,
      startedAt: s.startedAt,
      updatedAt: s.updatedAt || s.statusUpdatedAt || s.startedAt,
      statusUpdatedAt: s.statusUpdatedAt,
      socket: s.messagingSocketPath,
    });
  }

  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

/**
 * Emits 'change' (debounced) whenever the session registry moves.
 * fs.watch on macOS is backed by FSEvents, so this is push, not poll.
 */
class SessionWatcher extends EventEmitter {
  constructor({ debounceMs = 60, sweepMs = 5000 } = {}) {
    super();
    this.debounceMs = debounceMs;
    this.sweepMs = sweepMs;
    this._timer = null;
    this._watcher = null;
    this._sweep = null;
  }

  start() {
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      this._watcher = fs.watch(SESSIONS_DIR, () => this._schedule());
    } catch (err) {
      this.emit('error', err);
    }
    // A session that dies takes its pid with it but leaves the file behind,
    // and no fs event fires. Sweep so dead sessions disappear on their own.
    this._sweep = setInterval(() => this.emit('change', readAll()), this.sweepMs);
    this._sweep.unref?.();
    this._schedule();
    return this;
  }

  _schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.emit('change', readAll()), this.debounceMs);
  }

  stop() {
    clearTimeout(this._timer);
    clearInterval(this._sweep);
    this._watcher?.close();
  }
}

module.exports = { readAll, isAlive, projectName, SessionWatcher };
