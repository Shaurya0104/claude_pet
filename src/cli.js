#!/usr/bin/env node
'use strict';
/**
 * jarvis — terminal view of every live Claude Code session.
 *
 *   jarvis status     one-shot table
 *   jarvis watch      live table, redraws on change
 *   jarvis up         launch the desktop pet
 *   jarvis focus <n>  bring session n's terminal to the front
 *   jarvis json       machine-readable snapshot
 */
const path = require('path');
const { spawn } = require('child_process');
const { PetState } = require('./core/state');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c('2'), bold = c('1');
const red = c('31'), green = c('32'), yellow = c('33'), blue = c('34'), cyan = c('36'), grey = c('90');

const STYLE = {
  needs_input: { icon: '!', paint: yellow, text: 'NEEDS YOU' },
  blocked:     { icon: 'x', paint: red,    text: 'BLOCKED'   },
  ready:       { icon: '*', paint: green,  text: 'READY'     },
  running:     { icon: '>', paint: cyan,   text: 'WORKING'   },
  idle:        { icon: '.', paint: grey,   text: 'idle'      },
};

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function pad(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}

function render(snap) {
  const { sessions, counts, overall } = snap;
  const lines = [];

  const head = STYLE[overall];
  lines.push('');
  lines.push(
    `  ${bold('JARVIS')}  ${head.paint(head.text)}   ` +
      dim(`${sessions.length} live session${sessions.length === 1 ? '' : 's'}`)
  );

  const parts = [];
  for (const k of ['needs_input', 'blocked', 'ready', 'running', 'idle']) {
    if (counts[k]) parts.push(STYLE[k].paint(`${counts[k]} ${STYLE[k].text.toLowerCase()}`));
  }
  if (parts.length) lines.push('  ' + dim(parts.join(dim('  ·  '))));
  lines.push('');

  if (!sessions.length) {
    lines.push(dim('  no Claude Code sessions running'));
    lines.push('');
    return lines.join('\n');
  }

  lines.push(
    dim(`  #  ${pad('SESSION', 46)} ${pad('PROJECT', 22)} ${pad('STATE', 11)} ${pad('AGE', 5)} NOTE`)
  );

  sessions.forEach((s, i) => {
    const st = STYLE[s.state];
    const note = s.reason || (s.message ? s.message.replace(/\s+/g, ' ').slice(0, 46) : '');
    lines.push(
      `  ${dim(String(i + 1).padStart(2))} ${st.paint(st.icon)} ` +
        `${pad(s.display || s.name, 44)} ${dim(pad(s.project, 22))} ` +
        `${st.paint(pad(st.text, 11))} ${dim(pad(ago(s.updatedAt), 5))} ${dim(note)}`
    );
  });

  lines.push('');
  return lines.join('\n');
}

async function main() {
  const cmd = process.argv[2] || 'status';
  const state = new PetState().start();
  await new Promise((r) => setTimeout(r, 250)); // let the first read land

  if (cmd === 'status') {
    console.log(render(state.snapshot()));
    state.stop();
    process.exit(0);
  }

  if (cmd === 'json') {
    console.log(JSON.stringify(state.snapshot(), null, 2));
    state.stop();
    process.exit(0);
  }

  if (cmd === 'watch') {
    const draw = () => {
      process.stdout.write('\x1b[2J\x1b[H');
      process.stdout.write(render(state.snapshot()));
      process.stdout.write(dim('  ctrl-c to quit\n'));
    };
    state.on('change', draw);
    draw();
    setInterval(draw, 1000).unref?.();
    process.on('SIGINT', () => {
      process.stdout.write('\x1b[?25h\n');
      process.exit(0);
    });
    process.stdout.write('\x1b[?25l'); // hide cursor
    return;
  }

  if (cmd === 'focus') {
    const n = Number(process.argv[3]);
    const s = state.snapshot().sessions[n - 1];
    if (!s) {
      console.error(`no session #${process.argv[3]}`);
      process.exit(1);
    }
    const { focusSession } = require('./core/focus');
    const r = await focusSession(s);
    console.log(r.ok ? `focused ${s.name} in ${r.app}${r.exact ? ' (exact tab)' : ''}` : `could not focus: ${r.reason}`);
    process.exit(r.ok ? 0 : 1);
  }

  if (cmd === 'up') {
    const root = path.join(__dirname, '..');
    const electron = require(path.join(root, 'node_modules', 'electron'));
    const child = spawn(electron, [root], { detached: true, stdio: 'ignore' });
    child.unref();
    console.log('jarvis is awake');
    process.exit(0);
  }

  console.log('usage: jarvis [status|watch|json|focus <n>|up]');
  process.exit(1);
}

main();
