// Flashpoint CDP harness — real headless Chrome, real game loop, asserts actual state.
// Node >= 22 (native WebSocket + fetch). No dependencies.
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// A fixed port lets a crashed run's Chrome linger and be re-attached to by the next
// run, which then tests a stale page and reports already-fixed errors. Pick a free one.
const PORT = Number(process.env.PORT || 0) || await (async () => {
  const { createServer } = await import('node:net');
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => res(port)); });
  });
})();
const FILE = new URL('../index.html', import.meta.url).href;
const PROFILE = `${tmpdir()}/flashpoint-cdp-profile`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  '--window-size=980,700', 'about:blank'
], { stdio: 'ignore' });
/* never leave a headless Chrome holding the debug port, whatever kills this run */
const killChrome = () => { try { chrome.kill(); } catch (e) {} };
process.on('exit', killChrome);
process.on('uncaughtException', e => { console.log('FATAL ::', e && e.message); killChrome(); process.exit(1); });
process.on('unhandledRejection', e => { console.log('FATAL ::', e && e.message); killChrome(); process.exit(1); });

let target = null;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(400);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find(t => t.type === 'page');
  } catch (e) {}
}
if (!target) { console.log('FATAL :: no devtools page'); chrome.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0;
const waiting = new Map();
const problems = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') problems.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').split('\n')[0]);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push('CONSOLE: ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200));
};
const send = (method, params = {}) => new Promise(res => { const i = ++mid; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evl = async expr => {
  const m = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const p = m.result;
  if (p?.exceptionDetails) problems.push('EVAL: ' + (p.exceptionDetails.exception?.description || '').split('\n')[0]);
  return p?.result?.value;
};
const shot = async name => {
  const m = await send('Page.captureScreenshot', { format: 'png' });
  if (m.result?.data) { writeFileSync(`${tmpdir()}/fp-${name}.png`, Buffer.from(m.result.data, 'base64')); console.log(`  shot :: fp-${name}.png`); }
};


/* The bot experiment failed to answer whether the game has depth: an idle
   control survived 34s against 5s for every active policy, so the metric was
   dominated by exposure, not decisions. But it pointed at the right question.
   All three policies shared ONE route - shortest path, drones ignored - so none
   of them could express the skill this genre actually runs on, which is choosing
   where to walk.

   So measure whether that choice exists. Take the shortest route spawn->prize,
   delete those tiles, and ask for a route again. A floor that still answers has
   a genuinely separate way round; a floor that does not is a corridor with
   scenery. Repeat to count how many independent ways in a floor offers. */
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: FILE + '?autostart&name=THIEF' });
for (let i = 0; i < 40; i++) { if (await evl('typeof loadMap') === 'function') break; await sleep(300); }
await sleep(500);
const SRC = `(() => {
 try {
  const rows = [];
  for (let f = 0; f < MAPS.length; f++) {
    mapIdx = f; loop = 0; loadMap(f);
    const p = __fp.prizeAt(); if (!p) continue;
    const N = T.COLS * T.ROWS;
    const walk = (gx, gy) => !isWallCell(gx, gy) && !glassAt[gy*T.COLS+gx];
    const field = (wx, wy) => {
      const c = cellOf(wx, wy);
      const d = new Int32Array(N).fill(-1);
      const si = c.gy*T.COLS+c.gx; d[si] = 0;
      const q = [si];
      for (let h = 0; h < q.length; h++) {
        const cur = q[h], x = cur % T.COLS, y = (cur - x) / T.COLS;
        for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx=x+dx, ny=y+dy;
          if (nx<0||ny<0||nx>=T.COLS||ny>=T.ROWS) continue;
          const j2 = ny*T.COLS+nx;
          if (d[j2] >= 0 || !walk(nx,ny)) continue;
          d[j2] = d[cur] + 1; q.push(j2);
        }
      }
      return d;
    };
    const dS = field(player.x, player.y), dP = field(p.x, p.y);
    const pc = cellOf(p.x, p.y);
    const best = dS[pc.gy*T.COLS+pc.gx];
    if (best < 0) continue;
    /* A tile is USEFUL if standing on it does not cost you much: the trip
       through it is within a fifth of the best possible trip. Count them, and
       measure how wide the route is on average - total useful tiles divided by
       the length of the shortest route. 1.0 means a single-file corridor with
       no choice at all; 3 means three tiles abreast of viable ground. */
    let useful = 0;
    for (let k = 0; k < N; k++) {
      if (dS[k] < 0 || dP[k] < 0) continue;
      if (dS[k] + dP[k] <= best * 1.2) useful++;
    }
    let open = 0;
    for (let gy = 0; gy < T.ROWS; gy++) for (let gx = 0; gx < T.COLS; gx++) if (walk(gx,gy)) open++;
    rows.push({ floor: f+1, best: best, useful: useful,
                width: +(useful / Math.max(1, best)).toFixed(2),
                share: +(100 * useful / open).toFixed(0), open: open });
  }
  return JSON.stringify(rows);
 } catch (e) { return JSON.stringify({ threw: String(e && e.message) }); }
})()`;
const rows = JSON.parse(await evl(SRC));
if (rows.threw) { console.log('THREW ::', rows.threw); process.exit(1); }
console.log('floor   shortest   tiles worth using   route width   % of floor in play');
for (const r of rows) console.log(
  String(r.floor).padStart(4), String(r.best).padStart(10), String(r.useful).padStart(19),
  String(r.width).padStart(13), (r.share + '%').padStart(19));
const w = rows.map(r => r.width).sort((a,b)=>a-b);
console.log('');
console.log(`route width: median ${w[w.length>>1]}, range ${w[0]}-${w[w.length-1]}`);
console.log(`single-file floors (width < 1.5, no real choice): ${rows.filter(r=>r.width<1.5).length}/${rows.length}`);
console.log(`floors with broad choice (width >= 3): ${rows.filter(r=>r.width>=3).length}/${rows.length}`);
process.exit(0);
