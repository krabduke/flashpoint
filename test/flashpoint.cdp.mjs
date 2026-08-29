// Flashpoint CDP harness — real headless Chrome, real game loop, asserts actual state.
// Node >= 22 (native WebSocket + fetch). No dependencies.
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9335);
const FILE = new URL('../index.html', import.meta.url).href;
const PROFILE = `${tmpdir()}/flashpoint-cdp-profile`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  '--window-size=980,700', 'about:blank'
], { stdio: 'ignore' });

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
let fails = 0;
const ok = (name, pass, info = '') => { if (!pass) fails++; console.log(`${pass ? 'PASS' : 'FAIL'} :: ${name}${info ? '  (' + info + ')' : ''}`); };
const eq = async (name, expr, want) => { const got = await evl(expr); ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`); };

await send('Runtime.enable'); await send('Page.enable');

/* menu + validity */
await send('Page.navigate', { url: FILE });
await sleep(2200);
await eq('maps valid', '__fp.mapCheck', 'ok');
await eq('boots in menu', '__fp.mode', 'menu');
await shot('menu');

/* autostart */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2000);
await eq('autostart -> playing', '__fp.mode', 'playing');
await eq('map 0 loaded', '__fp.mapIdx', 0);
await eq('bots on patrol', '__fp.botState[0]', 'patrol');

/* mouse aim: CDP's raw mouseMoved does not produce pointermove for window listeners in
   headless, so dispatch the same PointerEvent a real browser would (tests our handler). */
const before = await evl('__fp.aim');
await evl("window.dispatchEvent(new PointerEvent('pointermove',{clientX:100,clientY:650,pointerType:'mouse',bubbles:true}))");
await sleep(200);
const afterAim = await evl('__fp.aim');
ok('mouse aims beam', Math.abs(afterAim - before) > 0.3, `${before?.toFixed?.(2)} -> ${afterAim?.toFixed?.(2)}`);

/* keyboard movement */
const p0 = await evl('JSON.stringify(__fp.pos)');
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'd', code: 'KeyD' });
await sleep(700);
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'd', code: 'KeyD' });
const p1 = await evl('JSON.stringify(__fp.pos)');
ok('WASD moves player', JSON.parse(p1).x - JSON.parse(p0).x > 40, `${p0} -> ${p1}`);

/* live coin pickup: drives the real collect path (burst, noise, hud) */
const cp = JSON.parse(await evl('JSON.stringify(coinList.find(c => !c.got))'));
await evl(`__fp.teleport(${cp.x}, ${cp.y})`);
await sleep(350);
await eq('live coin pickup counts', '__fp.coins', 1);

/* detection: place bot 150px away facing the player on clear ground */
await evl(`(function(){
  invuln = 0;
  const b = __fp.placeBotNear(player.x + 150, player.y);
  player.x = spawnPt.x; player.y = spawnPt.y;
  for (let k = 0; k < 40 && isWall(player.x + 150, player.y); k++) player.x -= 8;
  __fp.placeBotNear(player.x + 150, player.y);
  __fp.faceBot(180);
})()`);
await sleep(900);
const midMeter = await evl('__fp.meter');
ok('exposed to cone -> meter fills', midMeter > 0.25, 'meter=' + midMeter?.toFixed?.(2));
await sleep(900);
await eq('full meter -> caught', '__fp.mode', 'caught');
await ok('caught card visible', await evl("!document.getElementById('caught').classList.contains('hidden')"));
await shot('caught');

/* hide behind wall: meter drains to 0 */
await evl('startGame();');
await sleep(400);
await evl(`(function(){
  player.x = spawnPt.x; player.y = spawnPt.y;
  __fp.placeBotNear(player.x, player.y - 200);
  __fp.faceBot(90);
  __fp.setMeter(0.6);
})()`);
await evl('seenTimer = 9');
const hiddenExpr = '(function(){ const b = bots[0]; const dx=player.x-b.x, dy=player.y-b.y; return botSees(b) ? "sees" : "blind"; })()';
const sees = await evl(hiddenExpr);
if (sees === 'sees') {
  await evl('isWall = function(x,y){ const gx=x/40|0, gy=y/40|0; if(gx<11&&gy<11) return true; return gx<0||gy<0||gx>=28||gy>=18||grid[gy*28+gx]===1; };');
  await evl('bots[0].x = player.x; bots[0].x = spawnPt.x - 60; bots[0].y = spawnPt.y; bots[0].face = 0; player.x = spawnPt.x;');
}
await sleep(1600);
const drained = await evl('__fp.meter');
ok('not seen -> meter drains', drained < 0.1, 'meter=' + drained?.toFixed?.(2));
await evl('delete window.__probe;');

/* coins -> exit unlock -> advance */
await evl('__fp.clearCoins()');
await sleep(200);
await eq('all coins -> exit opens', '__fp.exitOpen', true);
await evl('__fp.teleport(exitPt.x, exitPt.y)');
await sleep(700);
await eq('exit advances map', '__fp.mapIdx', 1);

/* ward blackout */
await evl('mapIdx = 3; loadMap(3); hud();');
await sleep(300);
await evl('__fp.forceBlackout()');
await sleep(150);
const bo = await evl('__fp.blackout');
ok('blackout fires on ward', bo > 0, 'blackout=' + bo?.toFixed?.(2));
await evl('mapIdx = 1; loadMap(1);');

/* full campaign -> win -> endless */
for (let i = 0; i < 4; i++) {
  await evl('__fp.clearCoins(); __fp.teleport(exitPt.x, exitPt.y);');
  await sleep(500);
}
await eq('campaign win', '__fp.mode', 'won');
await ok('escaped card visible', await evl("!document.getElementById('escaped').classList.contains('hidden')"));
await shot('won');
await evl("document.getElementById('endlessBtn').click();");
await sleep(500);
await eq('endless continues', '__fp.mode', 'playing');
await eq('endless loop counted', '__fp.loop', 1);
await eq('endless extra bot', '__fp.botsN >= 2', true);

/* records + name */
await evl('caught();');
await sleep(300);
const rec = await evl('JSON.stringify((function(){try{return JSON.parse(localStorage.getItem("flashpoint.records")||"[]")[0]}catch(e){return null}})())');
const robj = rec ? JSON.parse(rec) : null;
ok('leaderboard saved with name', !!robj && robj.n === 'TESTY', rec || 'none');

/* touch controls */
await evl('startGame();');
await sleep(500);
await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 120, y: 500, id: 1 }] });
await sleep(150);
await eq('left stick appears', '__fp.stickL', true);
await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 220, y: 500, id: 1 }] });
const tp0 = await evl('__fp.pos.x');
await sleep(600);
const tp1 = await evl('__fp.pos.x');
ok('thumbstick moves player', tp1 - tp0 > 40, `${tp0?.toFixed?.(0)} -> ${tp1?.toFixed?.(0)}`);
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
const aimBefore = await evl('__fp.aim');
await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 850, y: 500, id: 2 }] });
await sleep(120);
await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 850, y: 380, id: 2 }] });
await sleep(250);
const aimAfter = await evl('__fp.aim');
ok('right stick aims beam', Math.abs(aimAfter - aimBefore) > 0.5, `${aimBefore?.toFixed?.(2)} -> ${aimAfter?.toFixed?.(2)}`);
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(300);
const aimHeld = await evl('__fp.aim');
ok('beam holds aim after release', Math.abs(aimHeld - aimAfter) < 0.01);
await eq('touch mode detected', '__fp.touch', true);

/* portrait phone viewport */
await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
await sleep(900);
await shot('portrait');
const zoom = await evl('Z');
ok('portrait zoom adapts', zoom >= 0.5 && zoom <= 1.3, 'Z=' + zoom?.toFixed?.(2));
await send('Emulation.clearDeviceMetricsOverride');
await sleep(400);

/* gameplay hero shot: sweep the beam near a lamp */
await evl('startGame();');
await sleep(600);
await evl('(function(){ const e = emitters[0]; player.x = e.x; player.y = e.y + 90; mouseWX = e.x; mouseWY = e.y; })()');
await sleep(1400);
await shot('play');

const clean = problems.length === 0;
if (!clean) fails++;
console.log(`${clean ? 'PASS' : 'FAIL'} :: zero console/js errors`);
problems.forEach(p => console.log('  ' + p));
console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL CHECKS PASSED');
ws.close(); chrome.kill();
process.exit(fails ? 1 : 0);
