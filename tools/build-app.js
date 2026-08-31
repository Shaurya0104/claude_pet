#!/usr/bin/env node
'use strict';
/**
 * Packages Jarvis into dist/Jarvis.app.
 *
 * LSUIElement makes it an accessory app: no Dock icon, no app switcher entry,
 * never steals focus — it lives in the menubar and on top of your screen,
 * which is what a pet should do.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { packager } = require('@electron/packager');

const ROOT = path.join(__dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

(async () => {
  // The icon is generated, so a clean checkout can build without one lying around.
  if (!fs.existsSync(path.join(ROOT, 'build', 'icon.icns'))) {
    console.log('building icon…');
    execFileSync(process.execPath, [path.join(__dirname, 'make-icon.js')], { stdio: 'inherit' });
  }

  const paths = await packager({
    dir: ROOT,
    out: path.join(ROOT, 'dist'),
    name: 'Jarvis',
    platform: process.env.JARVIS_PLATFORM || 'darwin',
    arch: process.env.JARVIS_ARCH || process.arch,
    icon: path.join(ROOT, 'build', 'icon'), // packager appends .icns
    appBundleId: 'dev.jarvis.pet',
    appVersion: version,
    appCopyright: '',
    overwrite: true,
    prune: true,
    extendInfo: {
      LSUIElement: 1,                 // menubar accessory, no Dock icon
      NSHighResolutionCapable: true,
    },
    ignore: [
      /^\/dist/,
      /^\/build/,
      /^\/\.git/,
      /^\/extension/,
      /^\/tools/,
      /^\/README\.md$/,
    ],
  });

  const app = path.join(paths[0], 'Jarvis.app');

  // Ad-hoc signature: required for arm64 binaries to launch, and it stops
  // macOS calling the app "damaged" when you move it to /Applications.
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' });
    console.log('ad-hoc signed');
  } catch {
    console.log('codesign failed (the app will still run locally)');
  }

  console.log(`\nbuilt ${app}`);
  console.log('\nInstall it with:');
  console.log(`  cp -r "${app}" /Applications/`);
})();
