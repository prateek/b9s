import { chromium, webkit } from '../../web/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(process.env.B9S_RUNTIME_WORK || '.b9s-e2e/browser-runtimes');
const goroot = execFileSync('go', ['env', 'GOROOT'], { encoding: 'utf8' }).trim();
const server = createServer((req, res) => {
  if (req.url === '/') {
    res.setHeader('content-type', 'text/html');
    return res.end(`<title>Full Dolt WASM</title><pre id="result">Loading full Dolt WASM…</pre><script src="/wasm_exec.js"></script><script>
      const started=performance.now();
      window.go = new Go();
      go.env={DOLT_EVENTS_EMITTER:"null",HOME:"/tmp",TMPDIR:"/tmp"};
      WebAssembly.instantiateStreaming(fetch("/full.wasm"),go.importObject)
        .then(async ({instance})=>{await go.run(instance);window.fullResult={...JSON.parse(window.doltProbeResult||'{}'),ms:performance.now()-started};document.querySelector("pre").textContent=JSON.stringify(fullResult,null,2)})
        .catch(error=>{window.fullResult={error:String(error),ms:performance.now()-started};document.querySelector("pre").textContent=JSON.stringify(fullResult,null,2)});
    </script>`);
  }
  const path = req.url === '/full.wasm' ? `${root}/full.wasm` : req.url === '/wasm_exec.js' ? `${goroot}/lib/wasm/wasm_exec.js` : null;
  if (!path) { res.writeHead(404); return res.end(); }
  res.setHeader('content-type', req.url.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
  res.end(readFileSync(path));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const engineName = process.argv[2] || 'chromium';
const browser = await ({ chromium, webkit }[engineName]).launch({ headless: true });
const evidence = { engine: engineName, console: [] };
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('console', msg => { evidence.console.push(msg.text()); console.log(msg.text().slice(0, 600)); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.fullResult, null, { timeout: 120000 });
  evidence.result = await page.evaluate(() => window.fullResult);
  console.log(evidence.result);
  assert.equal(evidence.result.error, undefined);
  assert.match(evidence.result.commit, /^[a-z0-9]{32}$/);
  assert.deepEqual(evidence.result.sql.at(-2).rows, [
    ['probe-a', 'Native Dolt WASM', 'closed'],
    ['probe-b', 'Independent edit', 'open'],
  ]);
  await page.evaluate(result => {
    document.querySelector('pre').style.cssText = 'white-space:pre-wrap;font:14px system-ui';
    document.querySelector('pre').textContent = `Full Dolt directly in WASM\n\nInitial commit: ${result.commit}\n\n${result.sql.map(step => `${step.sql}\n${JSON.stringify(step.rows)}`).join('\n\n')}\n\nCompleted in ${result.ms.toFixed(0)} ms`;
  }, evidence.result);
  await page.screenshot({ path: `${root}/results/full-${engineName}.png`, fullPage: true });
} finally {
  writeFileSync(`${root}/results/full-${engineName}.json`, JSON.stringify(evidence, null, 2));
  await browser.close();
  server.close();
}
