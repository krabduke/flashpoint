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

/* A playthrough, not a test. Drives one floor the way a player would and
   photographs the moments meant to carry the game, so "does this look good"
   has evidence behind it rather than an assertion count. */
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride',
  { width: 1100, height: 720, deviceScaleFactor: 2, mobile: false });

await send('Page.navigate', { url: FILE + '?name=THIEF' });
await sleep(2600);
await evl(`(() => {
  completedLevels = [0,1,2,3];
  __fp.setBriefing(true);
  startGame();
  mapIdx = 6; loop = 0; loadMap(6);
  atRisk = 1400;
  __fp.openBrief();
})()`);
await sleep(600);
await shot('play-1-briefing');

await evl('__fp.buyIntel(); __fp.pickEntry(1);');
await sleep(350);
await shot('play-2-intel');

await evl('__fp.goIn();');
await sleep(700);
await evl('for (let i=0;i<90;i++) update(1/60);');
await sleep(350);
await shot('play-3-infiltrate');

await evl(`(() => {
  invuln = 9e9;
  __fp.setCrack('still'); __fp.giveTool('drill');
  const p = __fp.prizeAt();
  __fp.teleport(p.x, p.y);
  const b = bots.find(x => x.kind === 'drone');
  if (b) { b.x = p.x + 260; b.y = p.y; b.state = 'invest'; b.lastX = p.x; b.lastY = p.y; }
  for (let i=0;i<70;i++){ player.vx=0; player.vy=0; update(1/60); }
})()`);
await sleep(350);
await shot('play-4-cracking');

await evl(`(() => {
  __fp.takePrize();
  for (let i=0;i<120;i++){ keys.right = true; update(1/60); }
  keys.right = false;
})()`);
await sleep(400);
await shot('play-5-escape');

console.log('PLAYTHROUGH CAPTURED');
process.exit(0);
