'use strict';
/**
 * Tails each live session's transcript.
 *
 * Claude Code appends every event to ~/.claude/projects/<slug>/<sessionId>.jsonl.
 * Three entry kinds carry everything the pet needs, with no hooks and no
 * config changes:
 *
 *   {"type":"system","subtype":"api_error","level":"error",
 *    "error":{"message","status","formatted","isNetworkDown","rateLimits"},
 *    "retryAttempt":1,"maxRetries":10, ...}
 *
 *   {"type":"system","subtype":"turn_duration","durationMs":156190, ...}
 *
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"…"}]}, ...}
 *
 * api_error fires on every retry, so a single one is noise — Claude Code
 * retries up to maxRetries on its own. We only call a session "blocked" when
 * the retries are actually failing (see isBlocking below).
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { PROJECTS_DIR } = require('./paths');

/** Claude Code slugifies the cwd for the project directory name. */
function slugify(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

/** Locate a session's transcript. Derive it, then fall back to a scan. */
function transcriptPath(sessionId, cwd) {
  if (!sessionId) return null;
  const direct = path.join(PROJECTS_DIR, slugify(cwd), `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  let dirs;
  try {
    dirs = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = path.join(PROJECTS_DIR, d, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * The human-readable title Claude Code shows in `/resume`.
 *
 * It lives in the transcript as `{"type":"ai-title","aiTitle":"…"}` and is
 * rewritten as the conversation develops, so the last one wins. Sessions too
 * young to have been titled fall back to their most recent prompt.
 *
 * Only the tail of the file is read — transcripts run to megabytes, and the
 * newest title is by definition near the end.
 */
const TAIL_BYTES = 512 * 1024;

function scanTail(file, bytes) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - bytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();          // the first line is a fragment
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

function pickTitle(lines) {
  let title = null;
  let prompt = null;
  for (const line of lines) {
    // Cheap reject before parsing: these two types are rare in a transcript.
    if (!line.includes('"ai-title"') && !line.includes('"last-prompt"')) continue;
    try {
      const d = JSON.parse(line);
      if (d.type === 'ai-title' && d.aiTitle) title = d.aiTitle;
      else if (d.type === 'last-prompt' && d.lastPrompt) prompt = d.lastPrompt;
    } catch { /* torn line */ }
  }
  return { title, prompt };
}

function readTitle(file) {
  try {
    let { title, prompt } = pickTitle(scanTail(file, TAIL_BYTES));
    // A title written early in a long session can fall outside the tail.
    if (!title && fs.statSync(file).size > TAIL_BYTES) {
      title = pickTitle(fs.readFileSync(file, 'utf8').split('\n')).title;
    }
    if (title) return title;
    if (prompt) {
      const one = prompt.replace(/\s+/g, ' ').trim();
      return one.length > 60 ? `${one.slice(0, 57)}…` : one;
    }
  } catch { /* unreadable or gone */ }
  return null;
}

/**
 * Does this api_error mean the session is actually stuck, rather than
 * mid-retry? Claude Code recovers from most of these on its own.
 */
function isBlocking(entry) {
  const e = entry.error || {};
  if (e.isNetworkDown) return 'network down';
  if (e.rateLimits) return 'rate limited';
  const attempt = entry.retryAttempt || 0;
  const max = entry.maxRetries || 0;
  if (max && attempt >= max) return e.formatted || 'retries exhausted';
  // Still retrying, but deep enough in that it is worth surfacing.
  if (attempt >= 3) return e.formatted || `retrying (${attempt}/${max})`;
  return null;
}

/** Pull the plain text out of an assistant entry. */
function assistantText(entry) {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((c) => c && c.type === 'text' && c.text)
    .map((c) => c.text)
    .join(' ')
    .trim();
  return text || null;
}

/** Follows one file from its current end. */
class FileTail extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.pos = 0;
    this.partial = '';
    this._watcher = null;
    this._timer = null;
  }

  start() {
    try {
      this.pos = fs.statSync(this.file).size; // only care about what happens next
    } catch {
      this.pos = 0;
    }
    try {
      this._watcher = fs.watch(this.file, () => this._schedule());
    } catch {
      /* file vanished; the owner will drop us on the next sweep */
    }
    return this;
  }

  _schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._drain(), 40);
  }

  _drain() {
    let st;
    try {
      st = fs.statSync(this.file);
    } catch {
      return;
    }
    if (st.size < this.pos) this.pos = 0;
    if (st.size === this.pos) return;

    let text = '';
    try {
      const fd = fs.openSync(this.file, 'r');
      const buf = Buffer.alloc(st.size - this.pos);
      fs.readSync(fd, buf, 0, buf.length, this.pos);
      fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch {
      return;
    }
    this.pos = st.size;

    const lines = (this.partial + text).split('\n');
    this.partial = lines.pop() || '';
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      try {
        this.emit('entry', JSON.parse(s));
      } catch {
        /* torn line */
      }
    }
  }

  stop() {
    clearTimeout(this._timer);
    this._watcher?.close();
  }
}

/**
 * Keeps one FileTail per live session and republishes normalised events:
 *   'turn_end'   { sessionId, durationMs }
 *   'api_error'  { sessionId, blocking, status, formatted, attempt, max }
 *   'assistant'  { sessionId, text }
 *   'user'       { sessionId }
 */
class TranscriptWatcher extends EventEmitter {
  constructor() {
    super();
    this.tails = new Map(); // sessionId -> FileTail
  }

  /** Reconcile the set of tails against the live session list. */
  sync(sessions) {
    const live = new Set();

    for (const s of sessions) {
      live.add(s.sessionId);
      if (this.tails.has(s.sessionId)) continue;
      const file = transcriptPath(s.sessionId, s.cwd);
      if (!file) continue;

      // Titles already in the file, before we start following it.
      const existing = readTitle(file);
      if (existing) this.emit('title', { sessionId: s.sessionId, title: existing });

      const tail = new FileTail(file);
      tail.on('entry', (entry) => this._onEntry(s.sessionId, entry));
      tail.start();
      this.tails.set(s.sessionId, tail);
    }

    for (const [id, tail] of this.tails) {
      if (!live.has(id)) {
        tail.stop();
        this.tails.delete(id);
      }
    }
  }

  _onEntry(sessionId, entry) {
    if (entry.isSidechain) return; // subagent chatter, not the main thread

    if (entry.type === 'system' && entry.subtype === 'api_error') {
      const blocking = isBlocking(entry);
      this.emit('api_error', {
        sessionId,
        blocking,
        status: entry.error?.status,
        formatted: entry.error?.formatted,
        attempt: entry.retryAttempt,
        max: entry.maxRetries,
      });
      return;
    }

    if (entry.type === 'system' && entry.subtype === 'turn_duration') {
      this.emit('turn_end', { sessionId, durationMs: entry.durationMs });
      return;
    }

    if (entry.type === 'ai-title' && entry.aiTitle) {
      this.emit('title', { sessionId, title: entry.aiTitle });
      return;
    }

    if (entry.type === 'assistant') {
      const text = assistantText(entry);
      if (text) this.emit('assistant', { sessionId, text });
      return;
    }

    if (entry.type === 'user' && !entry.isMeta) {
      this.emit('user', { sessionId });
    }
  }

  stop() {
    for (const t of this.tails.values()) t.stop();
    this.tails.clear();
  }
}

module.exports = { TranscriptWatcher, transcriptPath, isBlocking, slugify, readTitle };
