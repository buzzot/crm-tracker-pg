'use strict';
// Copies CDN assets from node_modules to public/vendor/ + public/fonts/
// so the app serves everything locally — zero external requests at runtime.
// Runs automatically after `npm install` via the postinstall script hook.

const fs   = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function cp(src, dest) {
  const srcAbs  = path.join(root, src);
  const destAbs = path.join(root, dest);
  if (!fs.existsSync(srcAbs)) {
    console.warn('[copy-vendor] skip (not found):', src);
    return;
  }
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  const stat = fs.statSync(srcAbs);
  if (stat.isDirectory()) {
    fs.cpSync(srcAbs, destAbs, { recursive: true });
  } else {
    fs.copyFileSync(srcAbs, destAbs);
  }
  console.log('[copy-vendor] copied:', dest);
}

// ── Bootstrap CSS + JS ────────────────────────────────────────────────────────
cp('node_modules/bootstrap/dist/css/bootstrap.min.css',
   'public/vendor/bootstrap.min.css');
cp('node_modules/bootstrap/dist/js/bootstrap.bundle.min.js',
   'public/vendor/bootstrap.bundle.min.js');

// ── Bootstrap Icons ───────────────────────────────────────────────────────────
// CSS expects ./fonts/ relative to itself, so copy both into public/vendor/
cp('node_modules/bootstrap-icons/font/bootstrap-icons.min.css',
   'public/vendor/bootstrap-icons.min.css');
cp('node_modules/bootstrap-icons/font/fonts',
   'public/vendor/fonts');

// ── Inter font (self-hosted via @fontsource/inter) ────────────────────────────
// @fontsource ships one CSS file per weight that references woff2 in ./files/
// We copy the files/ dir and build a single combined CSS that points to /fonts/
const interWeights = [400, 500, 600, 700];
const filesDir = path.join(root, 'node_modules/@fontsource/inter/files');
const fontsDest = path.join(root, 'public/fonts');
fs.mkdirSync(fontsDest, { recursive: true });

let interCss = '';
interWeights.forEach(w => {
  const filename = `inter-latin-${w}-normal.woff2`;
  const src = path.join(filesDir, filename);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(fontsDest, filename));
    interCss += `@font-face{font-family:'Inter';font-style:normal;font-weight:${w};font-display:swap;src:url('/fonts/${filename}') format('woff2');}\n`;
    console.log('[copy-vendor] copied: public/fonts/' + filename);
  } else {
    console.warn('[copy-vendor] inter woff2 not found:', filename);
  }
});

if (interCss) {
  fs.writeFileSync(path.join(fontsDest, 'inter.css'), interCss);
  console.log('[copy-vendor] written: public/fonts/inter.css');
}

console.log('[copy-vendor] done');
