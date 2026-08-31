'use strict';
const os = require('os');
const path = require('path');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

module.exports = {
  CLAUDE_DIR,
  // Claude Code writes one file per live session here. This is our primary feed.
  SESSIONS_DIR: path.join(CLAUDE_DIR, 'sessions'),
  // Transcripts, one dir per project, one .jsonl per session.
  PROJECTS_DIR: path.join(CLAUDE_DIR, 'projects'),
  // Our own state: hook events land here, settings live beside them.
  JARVIS_DIR: path.join(CLAUDE_DIR, 'jarvis'),
  EVENTS_FILE: path.join(CLAUDE_DIR, 'jarvis', 'events.jsonl'),
  SETTINGS_FILE: path.join(CLAUDE_DIR, 'jarvis', 'settings.json'),
  PETS_DIR: path.join(__dirname, '..', '..', 'pets'),
};
