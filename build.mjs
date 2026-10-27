// Build script: bundles src/ with esbuild into dist/, copies public/ (filling in the version),
// and zips dist/ into latest.zip (used by the Standard Notes desktop app for offline install).
//   node build.mjs                 production build
//   node build.mjs --dev --serve   dev build, watch + serve dist/ on http://localhost:8085
import * as esbuild from 'esbuild';
import { zipSync } from 'fflate';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const args = new Set(process.argv.slice(2));
const dev = args.has('--dev');
const serve = args.has('--serve');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;

const DIST = 'dist';

function copyPublic() {
  for (const name of readdirSync('public')) {
    const text = readFileSync(join('public', name), 'utf8').replaceAll('$VERSION$', version);
    writeFileSync(join(DIST, name), text);
  }
  // dev host (mock Standard Notes) is handy to ship in dev builds only
  if (dev) cpSync('dev/host.html', join(DIST, 'host.html'));
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function makeZip() {
  const files = {};
  for (const p of walk(DIST)) {
    const rel = relative(DIST, p).split('\\').join('/');
    if (rel === 'latest.zip' || rel === 'host.html') continue;
    files[rel] = new Uint8Array(readFileSync(p));
  }
  writeFileSync(join(DIST, 'latest.zip'), zipSync(files, { level: 9 }));
}

const htmlPlugin = {
  name: 'html',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      const outputs = Object.keys(result.metafile.outputs).map((p) => p.replace(/^dist\//, ''));
      const js = outputs.find((p) => p.endsWith('.js'));
      const css = outputs.find((p) => p.endsWith('.css'));
      let html = readFileSync('src/index.html', 'utf8');
      html = html.replace('<!--CSS-->', css ? `<link rel="stylesheet" href="./${css}">` : '');
      html = html.replace('<!--JS-->', `<script type="module" src="./${js}"></script>`);
      writeFileSync(join(DIST, 'index.html'), html);
      copyPublic();
      makeZip();
      console.log(`[build] ${new Date().toLocaleTimeString()} v${version} -> ${js}${css ? ', ' + css : ''}`);
    });
  },
};

// empty dist/ rather than deleting the folder, so a server running from it keeps working
mkdirSync(DIST, { recursive: true });
for (const name of readdirSync(DIST)) rmSync(join(DIST, name), { recursive: true, force: true });

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outdir: DIST,
  entryNames: dev ? '[name]' : '[name].[hash]',
  format: 'esm',
  target: ['es2020', 'chrome90', 'safari15'],
  minify: !dev,
  sourcemap: dev,
  metafile: true,
  legalComments: 'none',
  loader: { '.css': 'css' },
  define: { __VERSION__: JSON.stringify(version) },
  plugins: [htmlPlugin],
  logLevel: 'warning',
});

if (serve) {
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: DIST, port: 8085, cors: { origin: '*' } });
  console.log(`[dev] serving dist/ on http://localhost:${port}  (mock Standard Notes host: /host.html)`);
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
