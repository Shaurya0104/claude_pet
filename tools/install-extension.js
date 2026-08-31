#!/usr/bin/env node
'use strict';
/**
 * Installs the Jarvis Focus extension into every VS Code-family editor found.
 *
 *   node tools/install-extension.js            install
 *   node tools/install-extension.js --remove   uninstall
 *
 * It is two files copied into the editor's own extensions directory — the
 * same place a .vsix unpacks to. Removing the folder removes it completely.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', 'extension');
const { version } = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
const FOLDER = `jarvis.jarvis-focus-${version}`;

const EDITORS = [
  ['Cursor', path.join(os.homedir(), '.cursor', 'extensions')],
  ['VS Code', path.join(os.homedir(), '.vscode', 'extensions')],
  ['VS Code Insiders', path.join(os.homedir(), '.vscode-insiders', 'extensions')],
  ['Windsurf', path.join(os.homedir(), '.windsurf', 'extensions')],
];

const remove = process.argv.includes('--remove');
let touched = 0;

for (const [name, dir] of EDITORS) {
  if (!fs.existsSync(dir)) continue;

  // Clear out any version of ours first, so upgrades don't leave duplicates.
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith('jarvis.jarvis-focus-')) {
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  }

  if (remove) {
    console.log(`removed from ${name}`);
    touched++;
    continue;
  }

  const dest = path.join(dir, FOLDER);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ['package.json', 'extension.js']) {
    fs.copyFileSync(path.join(SRC, f), path.join(dest, f));
  }
  console.log(`installed into ${name}  ->  ${dest}`);
  touched++;
}

if (!touched) {
  console.log('No VS Code-family editor found. Nothing to do.');
} else if (!remove) {
  console.log('\nReload your editor to activate it:');
  console.log('  Cmd+Shift+P  ->  "Developer: Reload Window"   (each window)');
  console.log('\nVerify with: Cmd+Shift+P -> "Jarvis: List Terminals and their PIDs"');
}
