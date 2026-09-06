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
    // macOS caches an app's icon against its bundle id, and Notification
    // Center reads it from that cache rather than the bundle. An early build
    // of this app shipped with no icon at all, and the generic one it was
    // registered with survived every later build and every lsregister reset.
    // A fresh identifier is the only thing that reliably clears it.
    appBundleId: 'com.shaurya.jarvis',
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

  // macOS caches an app's icon against its bundle id, and Notification Center
  // reads it from there rather than from the bundle each time. An early build
  // of this app shipped without an icon, and that generic one stuck — so
  // re-register the bundle and nudge the notification daemon on every build.
  try {
    const lsregister = '/System/Library/Frameworks/CoreServices.framework/'
      + 'Frameworks/LaunchServices.framework/Support/lsregister';
    execFileSync('touch', [app]);
    execFileSync(lsregister, ['-f', app], { stdio: 'ignore' });
    execFileSync('killall', ['usernoted'], { stdio: 'ignore' });
    console.log('re-registered with Launch Services');
  } catch {
    console.log('could not re-register with Launch Services (icons may be stale)');
  }

  console.log(`\nbuilt ${app}`);
  console.log('\nInstall it with:');
  console.log(`  cp -r "${app}" /Applications/`);
})();
