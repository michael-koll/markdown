const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true
};

(async () => {
  if (watch) {
    const extension = await esbuild.context(options);
    const webview = await esbuild.context({ ...options, entryPoints: ['src/webview.ts'], outfile: 'dist/webview.js', platform: 'browser', target: 'es2022' });
    await Promise.all([extension.watch(), webview.watch()]);
    console.log('Watching extension sources…');
  } else {
    await Promise.all([
      esbuild.build(options),
      esbuild.build({ ...options, entryPoints: ['src/webview.ts'], outfile: 'dist/webview.js', platform: 'browser', target: 'es2022' })
    ]);
  }
})().catch(error => { console.error(error); process.exit(1); });
