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

/* Balance: is a loud tool a CHOICE or a death sentence? Stand at the case on
   every floor with no protection and drill, then do the same with the lance.
   A tool that always gets you killed is not an option, it is a trap. */
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: FILE + '?autostart&name=THIEF' });
await sleep(2600);
const out = await evl(`(() => {
 try {
  const run = (tool) => {
    const rows = [];
    for (let f = 0; f < MAPS.length; f++) {
      mapIdx = f; loop = 0; loadMap(f);
      mode='playing'; paused=false; meter=0; alertLvl=0; invuln=0;
      __fp.setBriefing(false); __fp.setCrack('still'); __fp.giveTool(tool);
      const p = __fp.prizeAt();
      if (!p) continue;
      /* Let the floor breathe. Teleporting in at t=0 measures every patrol
         standing on its spawn point, which is one instant a player never
         experiences - they arrive when they choose, and can wait for a beat to
         pass. Nineteen of twenty floors looked 'guarded' purely because of this. */
      __fp.teleport(p.x + 900, p.y + 900);
      for (let w = 0; w < 60 * (6 + (f % 5) * 3); w++) update(1/60);
      __fp.teleport(p.x, p.y);
      /* Was somebody already standing there? Those catches are about the floor,
         not the tool, and they were drowning the comparison. */
      let near0 = 1e9;
      for (const b of bots) if (b.kind !== 'sentry')
        near0 = Math.min(near0, Math.hypot(b.x - p.x, b.y - p.y));
      let caughtAt = -1, drew = 0;
      for (let i = 0; i < 900 && !__fp.heldPrize; i++) {
        player.vx=0; player.vy=0; update(1/60);
        drew = Math.max(drew, __fp.comingForYou());
        if (mode !== 'playing') { caughtAt = +(i/60).toFixed(1); break; }
      }
      rows.push({ floor: f+1, took: __fp.heldPrize, caughtAt,
                  clear: near0 > 420, drew });
    }
    return rows;
  };
  const drill = run('drill');
  const lance = run('lance');
  const hands = run('none');
  return JSON.stringify({ drill, lance, hands });
 } catch (e) { return JSON.stringify({ threw: e.message }); }
})()`);
console.log(out);
process.exit(0);
