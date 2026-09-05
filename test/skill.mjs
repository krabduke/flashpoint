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


/* Is there anything here to be GOOD at?
   The honest test of "interesting gameplay" I can run without a human is
   whether skill changes the outcome. Play the same twenty floors with the same
   tool and the same route, varying only the policy:

     beeline  - walk at the prize, take it, walk at the door. Ignore everything.
     careful  - back away from anything close, hold still while being looked at.
     dark     - careful, with the torch off, which is the whole risk/reward of
                carrying a light: you see less and you are lit less.

   If all three score the same, the stealth systems are decoration and the game
   is a walking simulator with a timer. The spread IS the answer. */
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: FILE + '?autostart&name=THIEF' });
for (let i = 0; i < 40; i++) { if (await evl('typeof loadMap') === 'function') break; await sleep(300); }
await sleep(500);
const SRC = `(() => {
 try {
  const route = (sx, sy, tx, ty) => {
    const s0 = cellOf(sx, sy), e0 = cellOf(tx, ty);
    const N = T.COLS * T.ROWS;
    const si = s0.gy*T.COLS+s0.gx, ei = e0.gy*T.COLS+e0.gx;
    const seen = new Uint8Array(N), from = new Int32Array(N).fill(-1);
    seen[si] = 1; const q = [si];
    for (let h = 0; h < q.length; h++) {
      const cur = q[h]; if (cur === ei) break;
      const x = cur % T.COLS, y = (cur - x) / T.COLS;
      for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx=x+dx, ny=y+dy;
        if (nx<0||ny<0||nx>=T.COLS||ny>=T.ROWS) continue;
        const j=ny*T.COLS+nx;
        if (seen[j] || isWallCell(nx,ny) || glassAt[j]) continue;
        seen[j]=1; from[j]=cur; q.push(j);
      }
    }
    if (!seen[ei]) return [];
    const path=[]; let c=ei;
    while (c>=0 && c!==si) { path.push(c); c=from[c]; }
    path.reverse();
    return path.map(i => ({x:(i%T.COLS+.5)*T.TILE, y:((i-i%T.COLS)/T.COLS+.5)*T.TILE}));
  };
  const nearestBot = () => {
    let d = 1e9, bx = 0, by = 0;
    for (const b of bots) { if (b.kind === 'sentry') continue;
      const dd = Math.hypot(b.x - player.x, b.y - player.y);
      if (dd < d) { d = dd; bx = b.x; by = b.y; } }
    return { d: d, x: bx, y: by };
  };
  const play = (f, policy) => {
    mapIdx=f; loop=0; loadMap(f);
    mode='playing'; paused=false; meter=0; alertLvl=0;
    __fp.setBriefing(false); __fp.giveTool('drill');
    beamOn = (policy !== 'dark');
    const p = __fp.prizeAt(); if (!p) return null;
    let tookAt = -1, outAt = -1, deadAt = -1, wp = [], wi = 0, repath = 0;
    let tgt = { x: p.x, y: p.y }, held = false, exitTgt = null, holdT = 0;
    for (let t = 0; t < 60 * 120; t++) {
      if (mode !== 'playing') { deadAt = +(t/60).toFixed(1); break; }
      if (mapIdx !== f) { outAt = +(t/60).toFixed(1); break; }
      if (!held && __fp.heldPrize) {
        held = true; tookAt = +(t/60).toFixed(1);
        let best = null, bl = 1e9;
        for (const e of exits) { const r0 = route(player.x, player.y, e.x, e.y);
          if (r0.length && r0.length < bl) { bl = r0.length; best = e; } }
        exitTgt = best || exits[0];
        tgt = { x: exitTgt.x, y: exitTgt.y };
        wp = []; wi = 0; repath = 0;
      }
      const nb = nearestBot();
      let hold = false, flee = null;
      if (policy === 'idle') { keys.left=keys.right=keys.up=keys.down=false; update(1/60); continue; }
      /* Shift is not sprint - fast is the default and Shift buys quiet. The
         first three policies all ran everywhere at full volume, which is the
         one trade-off the whole noise system is built on, unused. */
      keys.sprint = (policy === 'quiet' || policy === 'quietcareful');
      if (policy === 'careful' || policy === 'dark' || policy === 'quietcareful') {
        /* Contact is 26px. Fleeing at 90 meant fleeing constantly on a 28x18
           map and never arriving anywhere - that was a paralysed bot, not a
           careful one. 52 is close enough to matter and far enough to leave. */
        if (nb.d < 52) flee = nb;
        /* being looked at: stop feeding the meter and let it drain, but never
           stand in the open forever */
        else if (meter > 0.05 && !held && holdT < 90) { hold = true; holdT++; }
        else if (meter <= 0.05) holdT = 0;
      }
      const atPrize = !held && Math.hypot(player.x - p.x, player.y - p.y) < T.PRIZE_R * 0.5;
      __fp.holdCrack(atPrize);
      if (flee) {
        const ax = player.x - flee.x, ay = player.y - flee.y;
        keys.left = ax < -3; keys.right = ax > 3;
        keys.up = ay < -3; keys.down = ay > 3;
      } else if (hold || atPrize) {
        keys.left = keys.right = keys.up = keys.down = false;
      } else {
        if (repath <= 0 || wi >= wp.length) { wp = route(player.x, player.y, tgt.x, tgt.y); wi = 0; repath = 30; }
        repath--;
        const w = wp[wi] || tgt;
        const dx = w.x - player.x, dy = w.y - player.y;
        if (Math.hypot(dx, dy) < 14) wi++;
        keys.left = dx < -3; keys.right = dx > 3;
        keys.up = dy < -3; keys.down = dy > 3;
      }
      update(1/60);
    }
    keys.left = keys.right = keys.up = keys.down = false;
    __fp.holdCrack(false);
    return { floor: f+1, tookAt: tookAt, outAt: outAt, deadAt: deadAt };
  };
  const res = {};
  for (const policy of ['idle', 'beeline', 'careful', 'dark', 'quiet', 'quietcareful']) {
    res[policy] = [];
    for (let f = 0; f < MAPS.length; f++) { const r = play(f, policy); if (r) res[policy].push(r); }
  }
  return JSON.stringify(res);
 } catch (e) { return JSON.stringify({ threw: String(e && e.message) }); }
})()`;
const r = JSON.parse(await evl(SRC));
if (r.threw) { console.log('THREW ::', r.threw, r.st); process.exit(1); }
const sum = (rows) => ({
  took: rows.filter(x => x.tookAt >= 0).length,
  out:  rows.filter(x => x.outAt  >= 0).length,
  dead: rows.filter(x => x.deadAt >= 0).length,
  n: rows.length });
console.log('policy     reached the prize   got out with it   caught');
for (const p of ['idle', 'beeline', 'careful', 'dark', 'quiet', 'quietcareful']) {
  const s = sum(r[p]);
  console.log(p.padEnd(10), `${s.took}/${s.n}`.padStart(15), `${s.out}/${s.n}`.padStart(17), `${s.dead}/${s.n}`.padStart(9));
}
console.log('');
const i0 = sum(r.idle), b = sum(r.beeline), c = sum(r.careful), d = sum(r.dark);
console.log(`CONTROL - a player who never moves: caught ${i0.dead}/${i0.n}. If that`);
console.log(`matches the others, the comparison is measuring the drones, not the play.`);
console.log('');
console.log(`careful vs beeline: ${c.out - b.out >= 0 ? '+' : ''}${c.out - b.out} floors escaped, ${c.dead - b.dead} change in deaths`);
console.log(`dark    vs beeline: ${d.out - b.out >= 0 ? '+' : ''}${d.out - b.out} floors escaped, ${d.dead - b.dead} change in deaths`);
/* Binary caught/not is the wrong question when everyone is caught eventually -
   the control proved that. How LONG you last is the thing policy can move. */
const med = (a) => { const s = a.slice().sort((x,y)=>x-y); return s.length ? +s[s.length>>1].toFixed(1) : 0; };
const lived = (rows) => rows.map(x => x.deadAt >= 0 ? x.deadAt : (x.outAt >= 0 ? x.outAt : 120));
console.log('policy     median survival   longest   reached prize (median s)');
for (const p of ['idle', 'beeline', 'careful', 'dark', 'quiet', 'quietcareful']) {
  const L = lived(r[p]);
  const tk = r[p].filter(x => x.tookAt >= 0).map(x => x.tookAt);
  console.log(p.padEnd(10), (med(L) + 's').padStart(15), (Math.max(...L) + 's').padStart(9),
    tk.length ? (med(tk) + 's').padStart(24) : '                       -');
}
const gain = med(lived(r.careful)) - med(lived(r.beeline));
const qgain = med(lived(r.quiet)) - med(lived(r.beeline));
console.log('');
console.log(`careful buys ${gain >= 0 ? '+' : ''}${gain.toFixed(1)}s over beeline`);
console.log(`moving QUIETLY buys ${qgain >= 0 ? '+' : ''}${qgain.toFixed(1)}s over the same route at full volume`);
console.log(`(idle baseline ${med(lived(r.idle))}s - anything at or under this is not skill, it is standing still)`);
process.exit(0);
