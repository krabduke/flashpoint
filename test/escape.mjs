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


/* How long IS an escape? RESPONSE_EVERY says the building gets angrier every
   14 seconds once you are carrying, and ALERT_MAX caps it at four. Both numbers
   were guesses. If the average run out is eight seconds the clock never ticks
   and the escape has no pressure at all; if it is ninety, the cap is hit long
   before the door and the last minute is flat. Measure the run, then judge. */
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: FILE + '?autostart&name=THIEF' });
await sleep(2600);
const out = await evl(`(() => {
 try {
  /* Steer with the PLAYER's rule, not pathFind's. pathFind is the drone's: it
     refuses vents and glass, so on floors 17, 19 and 20 it returns nothing at
     all and a simulated escape falls back to walking at the door through the
     walls. That is what made the first pass of this measurement worthless. */
  const route = (sx, sy, tx, ty) => {
    const s0 = cellOf(sx, sy), e0 = cellOf(tx, ty);
    const N = T.COLS * T.ROWS, from = new Int32Array(N).fill(-1);
    const si = s0.gy * T.COLS + s0.gx, ei = e0.gy * T.COLS + e0.gx;
    const seen = new Uint8Array(N); seen[si] = 1;
    const q = [si];
    for (let h = 0; h < q.length; h++) {
      const cur = q[h]; if (cur === ei) break;
      const x = cur % T.COLS, y = (cur - x) / T.COLS;
      for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x+dx, ny = y+dy;
        if (nx<0||ny<0||nx>=T.COLS||ny>=T.ROWS) continue;
        const j = ny*T.COLS+nx;
        if (seen[j] || isWallCell(nx,ny) || glassAt[j]) continue;
        seen[j] = 1; from[j] = cur; q.push(j);
      }
    }
    if (!seen[ei]) return [];
    const path = []; let c = ei;
    while (c >= 0 && c !== si) { path.push(c); c = from[c]; }
    path.reverse();
    return path.map(i => ({ x: (i % T.COLS + .5) * T.TILE, y: ((i - i % T.COLS) / T.COLS + .5) * T.TILE }));
  };
  const rows = [];
  for (let f = 0; f < MAPS.length; f++) {
    mapIdx = f; loop = 0; loadMap(f);
    mode='playing'; paused=false; meter=0; alertLvl=0; invuln=0;
    __fp.setBriefing(false);
    const p = __fp.prizeAt();
    if (!p) continue;
    /* let the patrols leave their spawn points before anything is measured */
    __fp.teleport(p.x + 900, p.y + 900);
    for (let w = 0; w < 60 * (6 + (f % 5) * 3); w++) update(1/60);
    __fp.teleport(p.x, p.y);
    /* Was a drone already standing on the plinth? That death is about the
       floor, not the escape, and it drowned the first pass. */
    let near0 = 1e9;
    for (const b of bots) if (b.kind !== 'sentry')
      near0 = Math.min(near0, Math.hypot(b.x - p.x, b.y - p.y));
    takePrize();
    const bumps = [];
    const lvl0 = alertLvl;
    /* pick the door by route length, and commit to it the way a player would */
    let tgtE = null, tgtLen = 1e9, wp = [];
    for (const e of exits) {
      const r0 = route(p.x, p.y, e.x, e.y);
      if (r0.length && r0.length < tgtLen) { tgtLen = r0.length; tgtE = e; wp = r0; }
    }
    if (!tgtE) { rows.push({ floor: f+1, noRoute: 1 }); continue; }
    let ticks = 0, wi = 0, repath = 0, done = 0;
    for (; ticks < 60 * 90; ticks++) {
      if (mapIdx !== f) { done = 1; break; }
      if (mode !== 'playing') { done = -1; break; }
      if (repath <= 0 || wi >= wp.length) {
        wp = route(player.x, player.y, tgtE.x, tgtE.y); wi = 0; repath = 30;
      }
      repath--;
      const tgt = wp[wi] || tgtE;
      const dx = tgt.x - player.x, dy = tgt.y - player.y;
      if (Math.hypot(dx, dy) < 14) wi++;
      keys.left = dx < -3; keys.right = dx > 3;
      keys.up = dy < -3; keys.down = dy > 3;
      const before = alertLvl;
      update(1/60);
      if (alertLvl > before) bumps.push(+(ticks/60).toFixed(1));
    }
    keys.left = keys.right = keys.up = keys.down = false;
    rows.push({ floor: f+1, secs: +(ticks/60).toFixed(1), done, tiles: tgtLen,
                clear: near0 > 420, lvl0, lvlEnd: alertLvl, bumps,
                maxed: alertLvl >= T.ALERT_MAX });
  }
  return JSON.stringify(rows);
 } catch (e) { return JSON.stringify({ threw: e.message, stack: (e.stack||'').split('\\n')[1] }); }
})()`);
const rows = JSON.parse(out);
if (rows.threw) { console.log('THREW ::', rows.threw, rows.stack); process.exit(1); }
console.log('floor  tiles  secs   out?  clear  lvl     bumps');
for (const r of rows) {
  if (r.noRoute) { console.log(String(r.floor).padStart(4), '   no route to any exit'); continue; }
  console.log(String(r.floor).padStart(4), String(r.tiles).padStart(6), String(r.secs).padStart(6),
    (r.done === 1 ? ' yes' : r.done === -1 ? 'DEAD' : 'hung').padStart(7),
    String(r.clear).padStart(6), (r.lvl0 + '->' + r.lvlEnd).padStart(6), '  ', JSON.stringify(r.bumps));
}
/* only floors where nobody was standing on the plinth say anything about the escape */
const fair = rows.filter(r => !r.noRoute && r.clear);
const outs = fair.filter(r => r.done === 1);
const secs = outs.map(r => r.secs).sort((a,b) => a-b);
console.log('');
console.log(`fair starts (nobody on the plinth): ${fair.length}/${rows.length}`);
console.log(`escaped ${outs.length}/${fair.length}  median ${secs.length ? secs[secs.length>>1] : 0}s  range ${secs[0]}-${secs[secs.length-1]}s`);
console.log(`the response clock  fired at all: ${outs.filter(r => r.bumps.length).length}/${outs.length}`);
console.log(`maxed the alert before the door: ${outs.filter(r => r.maxed).length}/${outs.length}`);
console.log(`problems: ${problems.length}`, problems.slice(0,3));
process.exit(0);
