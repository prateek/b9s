// Builds the b9s web SPA into pkg/web/dist, which the Go binary embeds.
//
// dist is committed so `go build` needs no Node toolchain. dist/source.sha256
// records a hash of every input, and TestEmbeddedBundleIsCurrent in
// pkg/web recomputes it, so a source change without a rebuild fails the Go
// tests. Keep the input list and the hash format in step with that test.
//
// `node build.mjs --watch --out <dir>` is the live preview (make web-dev): it
// rebuilds into <dir> on every change under src/ or public/, and
// `b9s web --dev-assets <dir>` reloads the open browsers. It writes no
// source.sha256, because <dir> is never embedded.

import { build, context } from "esbuild";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { verifyBrowserRuntime } from "../scripts/build-browser.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({ options: { watch: { type: "boolean" }, out: { type: "string" }, native: { type: "boolean" }, 'read-only': { type: 'boolean' }, runtime: { type: "string" } } });
const dist = args.out ? resolve(args.out) : join(root, "..", "pkg", "web", "dist");
if (args.watch && !args.out) {
  console.error("build.mjs: --watch needs --out, so a live preview never rewrites the embedded bundle");
  process.exit(2);
}
if (args.native && (!args.out || !args.runtime)) throw Error('--native requires --out and --runtime');
const nativeRuntime = args.native ? verifyBrowserRuntime(resolve(args.runtime)) : undefined;
if (args['read-only'] && !args.native) throw Error('--read-only requires --native');
const define = { B9S_READ_ONLY: String(!!args['read-only']) };

mkdirSync(dist, { recursive: true });

const ctx = await context({
  define,
  plugins: args.native ? [{ name: 'browser-api', setup(build) {
    build.onResolve({ filter: /^\.\/api$/ }, () => ({ path: join(root, 'src', 'native-api.ts') }));
    if (args.native) build.onResolve({ filter: /^\.\/native-client\.mjs$/ }, () => ({ path: './native-client.mjs', external: true }));
  } }] : [],
  entryPoints: [join(root, "src", "main.ts")],
  bundle: true,
  minify: !args.watch,
  sourcemap: args.watch ? "inline" : false,
  format: "iife",
  target: ["es2020", "safari15"],
  outfile: join(dist, "app.js"),
  legalComments: "none",
  logLevel: "warning",
});

/** buildAll writes app.js and copies every file esbuild does not bundle. */
async function buildAll() {
  await ctx.rebuild();
  copyFileSync(join(root, "src", "app.css"), join(dist, "app.css"));
  copyFileSync(join(root, "src", "tokens.css"), join(dist, "tokens.css"));
  copyFileSync(join(root, "node_modules", "mermaid", "dist", "mermaid.min.js"), join(dist, "mermaid.min.js"));
  for (const name of readdirSync(join(root, "public"))) copyFileSync(join(root, "public", name), join(dist, name));
  if (args.native) {
    for (const name of ['native-client.mjs', 'native-store.mjs']) copyFileSync(join(root, 'src', name), join(dist, name));
    await build({
      entryPoints: [join(root, 'src', 'native-worker.mjs')], outfile: join(dist, 'native-worker.mjs'),
      bundle: true, format: 'esm', define, external: ['./wasm_exec.js', './native-store.mjs'],
    });
    for (const name of ['native.wasm.gz', 'runtime.json', 'wasm_exec.js']) {
      copyFileSync(join(resolve(args.runtime), name), join(dist, name));
    }
  }
  writeFileSync(join(dist, "icon-192.png"), icon(192));
  writeFileSync(join(dist, "icon-512.png"), icon(512));
  writeFileSync(join(dist, "apple-touch-icon.png"), icon(180));
  if (nativeRuntime) {
    const names = [
      'app.js', 'app.css', 'tokens.css', 'mermaid.min.js', ...readdirSync(join(root, 'public')),
      'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
      'native-client.mjs', 'native-worker.mjs', 'native-store.mjs',
      'native.wasm.gz', 'runtime.json', 'wasm_exec.js',
    ];
    const assets = Object.fromEntries(names.sort().map(name => [name, {
      sha256: createHash('sha256').update(readFileSync(join(dist, name))).digest('hex'),
      ...(name === 'native.wasm.gz' ? { decodedHash: nativeRuntime.wasm.sha256, decodedBytes: nativeRuntime.wasm.bytes } : {}),
    }]));
    const version = createHash('sha256').update(JSON.stringify(assets)).digest('hex');
    const template = readFileSync(join(root, 'src', 'native-offline-worker.js'), 'utf8');
    writeFileSync(join(dist, 'native-offline.js'), template.replace('/* BUILD */', `const BUILD = ${JSON.stringify({ version, assets })};`));
  }
}

await buildAll();

if (args.watch) {
  // An editor save fires several events; one rebuild per burst is enough.
  let timer;
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        await buildAll();
        console.log(`rebuilt ${relative(process.cwd(), dist) || "."} at ${new Date().toLocaleTimeString()}`);
      } catch (e) {
        // esbuild has printed the error; keep watching for the fix.
      }
    }, 50);
  };
  watch(join(root, "src"), { recursive: true }, changed);
  watch(join(root, "public"), { recursive: true }, changed);
  console.log(`watching web/src and web/public, writing ${dist}`);
} else {
  writeFileSync(join(dist, "source.sha256"), sourceHash(root) + "\n");
  await ctx.dispose();
}

/** sourceHash is the hash TestEmbeddedBundleIsCurrent recomputes. */
function sourceHash(dir) {
  const files = [];
  const walk = d => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(join(dir, "src"));
  walk(join(dir, "public"));
  files.push(join(dir, "build.mjs"), join(dir, "package-lock.json"));
  const rel = files.map(f => relative(dir, f).split(sep).join("/")).sort();
  const h = createHash("sha256");
  for (const r of rel) {
    const data = readFileSync(join(dir, r));
    h.update(r + "\n" + data.length + "\n");
    h.update(data);
  }
  return h.digest("hex");
}

/**
 * icon draws the app icon: the TUI accent as a rounded square with three
 * tree rows, the second one indented. PNG needs no image library.
 */
function icon(size) {
  const px = Buffer.alloc(size * size * 4);
  const bg = [0x16, 0x17, 0x1d], accent = [0xbd, 0x93, 0xf9], ink = [0x16, 0x17, 0x1d], cyan = [0x8b, 0xe9, 0xfd];
  const r = size * 0.22, pad = size * 0.06;
  const inRounded = (x, y) => {
    const lo = pad, hi = size - pad;
    if (x < lo || x > hi || y < lo || y > hi) return false;
    const cx = Math.min(Math.max(x, lo + r), hi - r), cy = Math.min(Math.max(y, lo + r), hi - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const bars = [
    { x: 0.24, y: 0.28, w: 0.52, c: ink },
    { x: 0.34, y: 0.45, w: 0.42, c: ink },
    { x: 0.34, y: 0.62, w: 0.30, c: cyan },
  ];
  const bh = size * 0.1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let c = bg;
      if (inRounded(x + 0.5, y + 0.5)) {
        c = accent;
        for (const b of bars) {
          const bx = b.x * size, by = b.y * size;
          if (x >= bx && x < bx + b.w * size && y >= by && y < by + bh) c = b.c;
        }
      }
      const o = (y * size + x) * 4;
      px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
    }
  }
  return png(size, size, px);
}

function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c;
}
