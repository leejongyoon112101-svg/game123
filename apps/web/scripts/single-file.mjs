/* global console */
// Inline the built JS and CSS into one HTML fragment (no <html>/<head>/<body>)
// suitable for hosting as a Claude Artifact or pasting anywhere.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist-artifact');
let html = readFileSync(resolve(dist, 'index.html'), 'utf8');

html = html.replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_, src) => {
  const js = readFileSync(resolve(dist, '.' + src), 'utf8').replace(/<\/script>/g, '<\\/script>');
  return `<script type="module">${js}</script>`;
});
html = html.replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_, href) => {
  const css = readFileSync(resolve(dist, '.' + href), 'utf8');
  return `<style>${css}</style>`;
});
// Strip the document skeleton: the host supplies doctype/html/head/body.
html = html
  .replace(/<!doctype html>\s*/i, '')
  .replace(/<html[^>]*>|<\/html>/gi, '')
  .replace(/<head>|<\/head>|<body>|<\/body>/gi, '')
  .replace(/<meta[^>]*>\s*/gi, '')
  .replace(/<link rel="icon"[^>]*>\s*/gi, '')
  .trim();
// Order: title, style, markup, script (the module script is deferred anyway).
const grab = (re) => { const m = html.match(re); if (m) html = html.replace(m[0], ''); return m ? m[0] : ''; };
const title = grab(/<title>[\s\S]*?<\/title>/);
const style = grab(/<style>[\s\S]*?<\/style>/);
const script = grab(/<script type="module">[\s\S]*?<\/script>/);
html = [title, style, html.trim(), script].join('\n');
const out = resolve(dist, 'warsim.html');
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} kB)`);
