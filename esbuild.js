// @ts-check
/** 构建脚本：一份产物给扩展宿主（CJS/Node），一份给 webview（IIFE/Browser）。 */
const esbuild = require('esbuild');
const { mkdirSync, copyFileSync } = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const minify = args.includes('--minify');

const extRoot = __dirname;
const dist = path.join(extRoot, 'dist');

function copyTemplate() {
  mkdirSync(path.join(dist, 'webview'), { recursive: true });
  copyFileSync(
    path.join(extRoot, 'src', 'webview', 'index.html'),
    path.join(dist, 'webview', 'index.html')
  );
  console.log('[build] copied webview/index.html');
}

/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: [path.join(extRoot, 'src', 'extension.ts')],
  bundle: true,
  outfile: path.join(dist, 'extension.js'),
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  sourcemap: !minify,
  minify,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const webviewOptions = {
  entryPoints: [path.join(extRoot, 'src', 'webview', 'main.tsx')],
  bundle: true,
  outfile: path.join(dist, 'webview', 'webview.js'),
  format: 'iife',
  platform: 'browser',
  target: ['chrome114', 'safari14', 'firefox108'],
  jsx: 'automatic',
  // webview 不开 sourcemap：避免 DevTools 拉取 .map 触发 CSP 报错噪音
  sourcemap: false,
  minify,
  loader: { '.css': 'css' },
  logLevel: 'info',
};

async function buildOne(options) {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  } else {
    await esbuild.build(options);
  }
}

(async () => {
  copyTemplate();
  await Promise.all([buildOne(extensionOptions), buildOne(webviewOptions)]);
  if (!watch) console.log('[build] done');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
