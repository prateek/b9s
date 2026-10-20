import init from '/doltlite/sqlite3.mjs';
import '/wasm_exec.js';

let db, sqlite;
const trace = [];
function adapt(sql) {
  return sql.replace(/\bNOW\(\d?\)/gi, "strftime('%Y-%m-%d %H:%M:%f','now')")
    .replace(/<=>/g, ' IS ')
    .replace(/\bUTC_TIMESTAMP\(\d?\)/gi, "strftime('%Y-%m-%d %H:%M:%f','now')")
    .replace(/\s+FOR UPDATE\b/gi, '')
    .replace(/\bINSERT IGNORE\b/gi, 'INSERT OR IGNORE')
    .replace(/\bJSON_EXTRACT\b/gi, 'mysql_json_extract')
    .replace(/\bUPDATE (\w+) (\w+) SET /gi, 'UPDATE $1 AS $2 SET ')
    .replace(/(\bSET|,)\s+[si]\.(\w+)\s*=/gi, '$1 $2 =');
}
globalThis.probeSQL = input => {
  const { sql, args } = JSON.parse(input);
  const translated = adapt(sql);
  try {
    const rows = [], columns = [];
    db.exec({ sql: translated, bind: args.map(v => v?.$int64 ? BigInt(v.$int64) : typeof v === 'boolean' ? Number(v) : v), rowMode: 'array', resultRows: rows, columnNames: columns });
    trace.push({ sql, translated, args, rows: rows.length });
    return JSON.stringify({ rows, columns, changes: db.changes() }, (_, v) => typeof v === 'bigint' ? { $int64: v.toString() } : v);
  } catch (error) {
    trace.push({ sql, translated, args, error: String(error) });
    return JSON.stringify({ error: String(error) });
  }
};
function liteDDL(ddl) {
  return ddl.split('\n').filter(line => !/^\s*(KEY|INDEX)\s/i.test(line)).join('\n')
    .replace(/\bUNIQUE KEY `[^`]+`/g, 'UNIQUE')
    .replace(/\bON UPDATE CURRENT_TIMESTAMP(?:\(\d\))?/gi, '')
    .replace(/\bCOLLATE [\w]+/gi, '')
    .replace(/\bCHARACTER SET [\w]+/gi, '')
    .replace(/\bAUTO_INCREMENT/gi, '')
    .replace(/\bunsigned\b/gi, '')
    .replace(/\b(?:longtext|mediumtext)\b/gi, 'TEXT')
    .replace(/\b(?:enum|set)\([^)]*\)/gi, 'TEXT')
    .replace(/\bCOMMENT\s+'(?:[^']|'')*'/gi, '')
    .replace(/\bCURRENT_TIMESTAMP\(\d\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/,\s*\)/g, ')')
    .replace(/\)\s*ENGINE=[\s\S]*$/i, ')');
}
async function persisted(mode, bytes) {
  const request = indexedDB.open('beads-core-probe', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('images');
  const idb = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const tx = idb.transaction('images', mode);
  const store = tx.objectStore('images');
  const op = bytes ? store.put(bytes, 'main') : store.get('main');
  const value = await new Promise((resolve, reject) => { op.onsuccess = () => resolve(op.result); op.onerror = () => reject(op.error); });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  idb.close();
  return value;
}
const ready = (async () => {
  sqlite = await init();
  const saved = await persisted('readonly');
  if (saved) sqlite.capi.sqlite3_js_posix_create_file('/beads.db', saved);
  db = new sqlite.oo1.DB('/beads.db', 'c');
  db.createFunction({ name: 'uuid', xFunc: () => crypto.randomUUID() });
  db.createFunction({ name: 'mysql_json_extract', xFunc: (_, text, path) => {
    if (text === null) return null;
    if (!/^\$\.[a-zA-Z_][a-zA-Z_0-9]*$/.test(path)) throw Error(`Unsupported probe JSON path: ${path}`);
    const value = JSON.parse(text)[path.slice(2)];
    return value === undefined ? null : JSON.stringify(value);
  } });
  db.createFunction({ name: 'json_unquote', xFunc: (_, text) => {
    if (text === null) return null;
    const value = JSON.parse(text);
    return typeof value === 'string' ? value : JSON.stringify(value);
  } });
  if (!saved) {
    const schema = await (await fetch('/schema.json')).json();
    for (const [table, ddl] of Object.entries(schema)) {
      if (table.startsWith('dolt_')) continue;
      try { db.exec(liteDDL(ddl)); }
      catch (error) { throw Error(`${table}: ${error}\n${liteDDL(ddl)}`); }
    }
    db.exec("INSERT INTO config (`key`,value) VALUES ('issue_prefix','probe'); SELECT dolt_config('user.name','Browser probe'); SELECT dolt_config('user.email','probe@example.invalid'); SELECT dolt_commit('-A','-m','schema')");
  }
  const go = new Go();
  const wasm = await WebAssembly.instantiateStreaming(fetch('/lite.wasm'), go.importObject);
  go.run(wasm.instance).catch(error => console.error(error));
})();
self.onmessage = async ({ data }) => {
  try {
    await ready;
    if (data.op === 'trace') return self.postMessage({ trace });
    if (data.op === 'sql') return self.postMessage(JSON.parse(probeSQL(JSON.stringify({ sql: data.sql, args: [] }))));
    if (data.op === 'save') {
      db.exec("SELECT dolt_commit('-A','-m','Beads browser workflow')");
      const bytes = sqlite.capi.sqlite3_js_db_export(db);
      await persisted('readwrite', bytes);
      return self.postMessage({ bytes: bytes.length });
    }
    const start = performance.now();
    const result = JSON.parse(beadsProbe(JSON.stringify(data)));
    self.postMessage({ ...result, ms: performance.now() - start, lastSQL: trace.slice(-3) });
  } catch (error) { self.postMessage({ error: String(error), trace }); }
};
