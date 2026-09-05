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


/* Is the 25% depth bonus doing anything? Banking ENDS the run (jobBank sets
   mode='won'), so `banked` is always zero at a push decision and every push
   risks the whole run. Work out, from the floors' own coin counts and values,
   what survival odds a push has to beat to be the right call. A curve that
   climbs means the deep contracts are content a rational player never sees. */
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: FILE + '?autostart&name=THIEF' });
for (let i = 0; i < 40; i++) { if (await evl('typeof loadMap') === 'function') break; await sleep(300); }
await sleep(400);
const out = await evl(`(() => {
 try {
  const floors = [];
  for (let f = 0; f < MAPS.length; f++) {
    mapIdx = f; loop = 0; loadMap(f);
    /* coinValue() reads mapIdx, so it is already the value for THIS floor */
    const real = coinList.filter(c => !c.bonus).length;
    floors.push({ f: f+1, coins: real, each: coinValue(),
                  take: real * coinValue() + T.PRIZE_SCORE });
  }
  /* group into contracts exactly as jobEnd does */
  const jobs = [];
  for (let j = 0; j * T.JOB_LEN < floors.length; j++) {
    const slice = floors.slice(j * T.JOB_LEN, (j+1) * T.JOB_LEN);
    jobs.push({ job: j+1, floors: slice.map(s=>s.f),
                earn: slice.reduce((a,s)=>a+s.take, 0) });
  }
  let cum = 0;
  for (const j of jobs) { cum += j.earn; j.atRisk = cum;
    j.mult = 1 + T.JOB_BONUS * (j.job - 1);
    j.bankNow = Math.round(cum * j.mult); }
  return JSON.stringify({ floors, jobs, perPoint: T.SHOP_PER_POINT, intel: T.INTEL_PATROLS });
 } catch (e) { return JSON.stringify({ threw: e.message }); }
})()`);
const d = JSON.parse(out);
if (d.threw) { console.log('THREW ::', d.threw); process.exit(1); }
console.log('floor  coins  each   take');
for (const f of d.floors) console.log(String(f.f).padStart(4), String(f.coins).padStart(6),
  String(f.each).padStart(6), String(f.take).padStart(7));
console.log('');
console.log('contract  floors        earns   at risk   x mult   bank now   push must beat');
for (let i = 0; i < d.jobs.length; i++) {
  const j = d.jobs[i], nx = d.jobs[i+1];
  const need = nx ? (j.bankNow / nx.bankNow) : null;
  console.log(String(j.job).padStart(8), (' ' + j.floors[0] + '-' + j.floors[j.floors.length-1]).padEnd(8),
    String(j.earn).padStart(11), String(j.atRisk).padStart(9),
    ('  x' + j.mult.toFixed(2)).padStart(9), String(j.bankNow).padStart(10),
    nx ? ('        ' + (need*100).toFixed(0) + '% survival') : '        (nothing after this)');
}
const needs = [];
for (let i = 0; i < d.jobs.length - 1; i++) needs.push(d.jobs[i].bankNow / d.jobs[i+1].bankNow);
console.log('');
console.log('break-even survival odds per push:', needs.map(n => (n*100).toFixed(0)+'%').join('  '));
const rising = needs.every((n,i) => i === 0 || n >= needs[i-1] - 0.02);
console.log(rising
  ? 'RISING or flat: each push asks for at least as much as the last.'
  : 'falling: deeper pushes are easier bets than shallow ones.');
console.log('spread ' + (Math.min(...needs)*100).toFixed(0) + '% - ' + (Math.max(...needs)*100).toFixed(0) + '%');
console.log('');
console.log(`a gadget costs ${d.perPoint}/point, patrol intel ${d.intel}`);
console.log(`contract 1 earns ${d.jobs[0].earn} - that is ${(d.jobs[0].earn/d.intel).toFixed(1)}x the intel price`);
process.exit(0);
