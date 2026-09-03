'use strict';
/**
 * The state machine: turns raw session files + hook events into one pet state.
 *
 * Per-session states, and the priority the pet uses when several sessions
 * disagree (highest wins, same ordering Codex Pets settled on):
 *
 *   needs_input  you are blocking a session       <- loudest
 *   blocked      API error / rate limit
 *   ready        finished, and you haven't looked yet
 *   running      working
 *   idle         nothing to say                   <- quietest
 */
const { EventEmitter } = require('events');
const { SessionWatcher, readAll } = require('./sessions');
const { TranscriptWatcher } = require('./transcripts');

const PRIORITY = { needs_input: 4, blocked: 3, ready: 2, running: 1, idle: 0 };
const STATES = Object.keys(PRIORITY);

const LABEL = {
  needs_input: 'needs you',
  blocked: 'blocked',
  ready: 'ready',
  running: 'working',
  idle: 'idle',
};

class PetState extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, {unread:boolean, blocked:string|null, message:string|null, at:number}>} */
    this.marks = new Map(); // keyed by sessionId — survives session file churn
    this.sessions = [];
    this.overall = 'idle';
    this._watcher = null;
    this._transcripts = null;
  }

  start() {
    this._watcher = new SessionWatcher()
      .on('change', (list) => this._onSessions(list))
      .start();

    // Transcripts are the primary feed for "blocked" and "ready": they need
    // no hooks and no config, so they work for every session immediately.
    this._transcripts = new TranscriptWatcher()
      .on('api_error', (e) => this._onApiError(e))
      .on('turn_end', (e) => this._onTurnEnd(e))
      .on('assistant', (e) => this._onAssistant(e))
      .on('user', (e) => this._onUserMessage(e))
      .on('title', (e) => this._onTitle(e));

    this._onSessions(readAll());
    return this;
  }

  _mark(sessionId) {
    if (!this.marks.has(sessionId)) {
      this.marks.set(sessionId, { unread: false, blocked: null, message: null, at: 0, title: null });
    }
    return this.marks.get(sessionId);
  }

  _onSessions(list) {
    this._raw = list;
    this._transcripts?.sync(list);
    this._recompute();
  }

  // --------------------------------------------------- transcript signals ---

  /**
   * Claude Code emits an api_error per retry attempt, and recovers from most
   * of them by itself. transcripts.isBlocking() decides which ones actually
   * mean the session is stuck; the rest are recorded but stay quiet.
   */
  _onApiError({ sessionId, blocking, formatted, attempt, max }) {
    const m = this._mark(sessionId);
    m.lastError = { formatted, attempt, max, at: Date.now() };
    if (blocking) {
      m.blocked = blocking;
      m.at = Date.now();
      this._recompute();
    }
  }

  /** A turn that reaches the end is, by definition, no longer blocked. */
  _onTurnEnd({ sessionId }) {
    const m = this._mark(sessionId);
    m.unread = true;
    m.blocked = null;
    m.at = Date.now();
    this._recompute();
  }

  /** The `/resume` title, from the transcript. */
  _onTitle({ sessionId, title }) {
    const m = this._mark(sessionId);
    if (m.title === title) return;
    m.title = title;
    this._recompute();
  }

  _onAssistant({ sessionId, text }) {
    const m = this._mark(sessionId);
    m.message = text.replace(/\s+/g, ' ').slice(0, 240);
    // No _recompute: the message decorates the row, it does not change state.
  }

  /** You typed something, so you are clearly looking at this session. */
  _onUserMessage({ sessionId }) {
    const m = this._mark(sessionId);
    m.unread = false;
    m.blocked = null;
    this._recompute();
  }

  /** Mark a session as seen — clears its ready/blocked badge. */
  acknowledge(sessionId) {
    const m = this.marks.get(sessionId);
    if (!m) return;
    m.unread = false;
    m.blocked = null;
    this._recompute();
  }

  acknowledgeAll() {
    for (const m of this.marks.values()) {
      m.unread = false;
      m.blocked = null;
    }
    this._recompute();
  }

  _stateFor(s) {
    const m = this.marks.get(s.sessionId);

    // The session file is authoritative for "waiting" — Claude Code sets it
    // whenever it is parked on a permission prompt or a question.
    if (s.status === 'waiting') return 'needs_input';
    if (m?.blocked) return 'blocked';
    if (s.status === 'busy') return 'running';
    if (m?.unread) return 'ready';
    return 'idle';
  }

  _recompute() {
    const sessions = (this._raw || []).map((s) => {
      const m = this.marks.get(s.sessionId);
      const state = this._stateFor(s);
      // What to call this session in a list.
      //
      // A name you set yourself always wins. Otherwise Claude Code's derived
      // name is just the project plus two characters — the same for every
      // session in a repo — so prefer the title `/resume` shows, which
      // actually says what the conversation is about.
      const renamed = s.nameSource !== 'derived';
      const title = m?.title || null;
      return {
        ...s,
        state,
        title,
        display: renamed ? s.name : (title || s.name),
        renamed: !!renamed,
        label: LABEL[state],
        reason: s.waitingFor || m?.blocked || null,
        message: m?.message || null,
        unread: !!m?.unread,
      };
    });

    // Loudest session wins the pet's body.
    let overall = 'idle';
    for (const s of sessions) {
      if (PRIORITY[s.state] > PRIORITY[overall]) overall = s.state;
    }

    const changed =
      overall !== this.overall ||
      sessions.length !== this.sessions.length ||
      sessions.some((s, i) => {
        const p = this.sessions[i];
        return !p || p.sessionId !== s.sessionId || p.state !== s.state;
      });

    const prevOverall = this.overall;
    this.sessions = sessions;
    this.overall = overall;

    if (changed) {
      this.emit('change', { overall, prevOverall, sessions, counts: this.counts() });
    }
  }

  counts() {
    const c = Object.fromEntries(STATES.map((s) => [s, 0]));
    for (const s of this.sessions) c[s.state]++;
    return c;
  }

  snapshot() {
    return { overall: this.overall, sessions: this.sessions, counts: this.counts() };
  }

  stop() {
    this._watcher?.stop();
    this._transcripts?.stop();
  }
}

module.exports = { PetState, PRIORITY, STATES, LABEL };
