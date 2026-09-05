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


/* The escape measured at a median of four seconds, which is not an act, it is a
   doorstep. Before believing any of the tuning built on top of it, measure the
   thing itself: how far IS the prize from the way out? No player, no patrols,
   no simulation - just the floor's own geometry through its own pathfinder. */
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: FILE + '?autostart&name=THIEF' });
await sleep(2600);
const out = await evl(`(() => {
 try {
  const rows = [];
  const len = (path) => { let d = 0; for (let i = 1; i < path.length; i++)
    d += Math.hypot(path[i].x - path[i-1].x, path[i].y - path[i-1].y); return d; };
  for (let f = 0; f < MAPS.length; f++) {
    mapIdx = f; loop = 0; loadMap(f);
    const p = __fp.prizeAt();
    if (!p || !exits.length) continue;
    /* the door a fleeing player would actually pick: nearest by path, not by
       crow-flight, because a wall between you and a close exit is not close */
    let best = null, bd = 1e9;
    for (const e of exits) {
      const d = len(pathFind(p.x, p.y, e.x, e.y));
      if (d > 0 && d < bd) { bd = d; best = e; }
    }
    /* and the way IN, for scale: the walk from spawn to the prize is the
       infiltration, and the two halves should not be wildly lopsided */
    const inLen = len(pathFind(player.x, player.y, p.x, p.y));
    rows.push({ floor: f+1,
                outTiles: +(bd / T.TILE).toFixed(1),
                inTiles: +(inLen / T.TILE).toFixed(1),
                exits: exits.length,
                outSecs: +(bd / T.SPRINT).toFixed(1),
                inSecs: +(inLen / T.SPRINT).toFixed(1) });
  }
  return JSON.stringify(rows);
 } catch (e) { return JSON.stringify({ threw: e.message, stack: (e.stack||'').split('\\n')[1] }); }
})()`);
const rows = JSON.parse(out);
if (rows.threw) { console.log('THREW ::', rows.threw, rows.stack); process.exit(1); }
console.log('floor  in(tiles)  out(tiles)   in(s)  out(s)  exits   out/in');
for (const r of rows) console.log(
  String(r.floor).padStart(4), String(r.inTiles).padStart(10), String(r.outTiles).padStart(11),
  String(r.inSecs).padStart(8), String(r.outSecs).padStart(7), String(r.exits).padStart(6),
  '  ' + (r.inTiles ? (r.outTiles / r.inTiles).toFixed(2) : '-'));
const ratio = rows.map(r => r.outTiles / r.inTiles).sort((a,b)=>a-b);
const outT = rows.map(r => r.outTiles).sort((a,b)=>a-b);
console.log('');
console.log(`way out: median ${outT[outT.length>>1]} tiles, range ${outT[0]}-${outT[outT.length-1]}`);
console.log(`out/in ratio: median ${ratio[ratio.length>>1].toFixed(2)} (1.0 = both halves the same length)`);
console.log(`floors where the way out is under half the way in: ${rows.filter(r => r.outTiles < r.inTiles/2).length}/${rows.length}`);
process.exit(0);
