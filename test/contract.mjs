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

/* Can a whole contract actually be played? Not "does each system work" - four
   floors, a prize on each, a fence in the middle, and the arithmetic adding up
   across all of it. Drives A* to the case and then to the nearest exit. */
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: FILE + '?autostart&name=THIEF' });
await sleep(2600);
const out = await evl(`(() => {
 try {
  const log = [];
  __fp.setBriefing(false);
  mode='playing'; paused=false; __fp.resetRunLog();
  mapIdx=0; loop=0; loadMap(0); invuln=9e9;
  for (let f = 0; f < 5; f++) {
    /* loadMap resets invuln to 2.5 every floor, so a run that means to measure
       the SHAPE of a contract has to re-arm it - otherwise the drill's own noise
       brings somebody over and the measurement becomes a death. */
    invuln = 9e9; mode = 'playing'; paused = false;
    const p = __fp.prizeAt();
    if (!p) { log.push({ floor: f+1, err: 'no prize' }); break; }
    __fp.giveTool('drill'); __fp.setCrack('still');
    /* walk to the case */
    __fp.teleport(p.x, p.y);
    let t = 0;
    for (let i = 0; i < 900 && !__fp.heldPrize; i++) {
      player.vx=0; player.vy=0; update(1/60); t = i/60;
    }
    const took = __fp.heldPrize;
    /* and out */
    const e = __fp.nearestExit();
    __fp.teleport(e.x, e.y);
    const before = mapIdx, card0 = __fp.jobCardShown();
    for (let i = 0; i < 30; i++) update(1/60);
    const card = __fp.jobCardShown();
    log.push({ floor: f+1, name: MAPS[before].name, took, crackSecs: +t.toFixed(1),
      left: mapIdx !== before || card, fence: card, job: __fp.job() });
    if (card) { __fp.pushOn(); invuln = 9e9; }
    if (mode !== 'playing') { mode = 'playing'; invuln = 9e9; }
  }
  return JSON.stringify({ log, mode });
 } catch (e) { return JSON.stringify({ threw: e.message }); }
})()`);
console.log(out);
process.exit(0);
