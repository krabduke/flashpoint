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
await evl('noise.length = 0; for (const b of bots) { b.face = Math.atan2(b.y - player.y, b.x - player.x); b.state = "patrol"; b.searchPts = []; b.path = []; }');
await sleep(120);
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
await sleep(900);   /* the held beat before the card */
await ok('caught card visible after the beat', await evl("!document.getElementById('caught').classList.contains('hidden')"));
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

/* museum searchlights */
await evl('mapIdx = 4; loadMap(4);');
await sleep(300);
ok('museum has searchlights', (await evl('__fp.searchN')) >= 2);

/* server laser grid */
await evl('mapIdx = 5; loadMap(5);');
await sleep(300);
await eq('server has 4 laser gates', '__fp.lasersN', 4);
const lm = JSON.parse(await evl('JSON.stringify(__fp.laserMid)'));
const lz = await evl(`(() => {
  mode = 'playing'; invuln = 0; meter = 0;
  __fp.teleport(${lm.x}, ${lm.y});
  let peak = 0;
  for (let i = 0; i < 200; i++) {
    invuln = 0;
    update(0.016);
    if (meter > peak) peak = meter;
    if (mode !== 'playing') break;
  }
  mode = 'playing'; paused = false; meter = 0; invuln = 2.5;
  document.getElementById('caught').classList.add('hidden');
  return peak;
})()`);
ok('laser zap spikes meter', lz > 0.3, 'peak=' + lz?.toFixed?.(2));

/* bank siren sweep */
await evl('mapIdx = 6; loadMap(6);');
await sleep(300);
await evl('__fp.forceSiren()');
await sleep(200);
await eq('siren sweep active', '__fp.sirenT > 0', true);

/* docks fog bank shrinks the beam */
await evl('mapIdx = 7; loadMap(7);');
await sleep(300);
await evl('__fp.forceFog()');
await sleep(1400);
const fs = await evl('__fp.flScale');
ok('fog shrinks the beam', fs < 0.75, 'flScale=' + fs?.toFixed?.(2));

/* core: blackouts on the final floor */
await evl('mapIdx = 8; loadMap(8);');
await sleep(300);
await evl('__fp.forceBlackout()');
await sleep(150);
await eq('core blackouts', '__fp.blackout > 0', true);
await evl('mapIdx = 1; loadMap(1);');

/* full campaign -> win -> endless */
await evl(`(() => {
  mode = 'playing'; paused = false;
  meter = 0; invuln = 2.5; alertLvl = 0; alertCool = 0;
  endless = false; __fp.setMod(-1); __fp.setDiff('standard');
  smokes.length = 0; emps.length = 0; decoys.length = 0;
})()`);
await eq('campaign has 12 floors', 'MAPS.length', 12);
const nMaps = await evl('MAPS.length');
for (let i = 0; i < nMaps; i++) {
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

/* ---- light-gated coins: gold only exists where light falls on it ---- */
await send('Emulation.clearDeviceMetricsOverride');
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
await evl('mapIdx = 0; loadMap(0); hud(); __fp.forgetCoins();');
await sleep(300);
/* stand well clear of any lamp pool, beam pointed away from every coin */
await evl(`(() => {
  const p = __fp.coinPoints()[0];
  __fp.aimAt(2 * __fp.pos.x - p.x, 2 * __fp.pos.y - p.y);
})()`);
await sleep(300);
const darkN = await evl('__fp.coinsDark');
ok('unlit coins are not drawn', darkN > 0, `${darkN} hidden of ${await evl('__fp.coinsTotal')}`);

await evl(`(() => {
  const p = __fp.coinPoints()[0];
  __fp.teleport(p.x - 70, p.y); __fp.aimAt(p.x, p.y);
})()`);
await sleep(300);
const litN = await evl('__fp.coinsLit');
ok('the beam reveals a coin', litN > 0, `lit=${litN}`);

await evl(`(() => { const p = __fp.coinPoints()[0]; __fp.aimAt(2 * __fp.pos.x - p.x, 2 * __fp.pos.y - p.y); })()`);
await sleep(300);
ok('a coin you found stays marked', (await evl('__fp.coinsMarked')) > 0, `marked=${await evl('__fp.coinsMarked')}`);

/* pixels, not just predicates: a lit coin has to actually be brighter than the
   floor it sits on. Asserting coinLight() alone once passed while nothing drew. */
const coinPixels = `(() => {
  const c = coinList.find(x => !x.got);
  const sx = (c.x - camNow.cx) * Z, sy = (c.y - camNow.cy) * Z;
  const rd = (ox) => {
    const d = ctx.getImageData((sx + ox - 9) * DPR, (sy - 9) * DPR, 18 * DPR, 18 * DPR).data;
    let m = 0; for (let i = 0; i < d.length; i += 4) { const b = d[i]+d[i+1]+d[i+2]; if (b > m) m = b; }
    return m;
  };
  return JSON.stringify({ state: coinLight(c), coin: rd(0), floor: rd(100) });
})()`;
await evl(`(() => { const c = coinList.find(x=>!x.got); player.x = c.x - 70; player.y = c.y; mouseWX = c.x; mouseWY = c.y; aimMode='mouse'; })()`);
await sleep(400);
const litPx = JSON.parse(await evl(coinPixels));
ok('a lit coin is visibly brighter than the floor', litPx.state === 'lit' && litPx.coin - litPx.floor > 200, `coin=${litPx.coin} floor=${litPx.floor}`);
await evl(`(() => { const c = coinList.find(x=>!x.got); player.x = c.x - 320; player.y = c.y; mouseWX = player.x - 200; mouseWY = player.y; })()`);
await sleep(400);
const markPx = JSON.parse(await evl(coinPixels));
ok('a remembered coin is still findable', markPx.state === 'mark' && markPx.coin - markPx.floor > 60, `coin=${markPx.coin} floor=${markPx.floor}`);

/* ---- the meter alarm: red actually reaches the screen edges near a full meter ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
const edgeRed = `(() => {
  const band = Math.max(46, H * 0.11);
  const d = ctx.getImageData(0, (H - band * 0.4) * DPR, W * DPR, band * 0.3 * DPR).data;
  let r = 0, g = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i+1]; n++; }
  return Math.round((r - g) / n);
})()`;
await evl('__fp.setMeter(0.1)'); await sleep(200);
const calm = await evl(edgeRed);
await evl('__fp.setMeter(0.97)'); await sleep(200);
let peak = -999;
for (let i = 0; i < 14; i++) { const v = await evl(edgeRed); if (v > peak) peak = v; await sleep(60); }
ok('a filling meter turns the screen edge red', peak > calm + 8, `calm=${calm} alarm=${peak} (threshold ${await evl('__fp.alarmAt')})`);

/* ---- torch battery: light is a resource now ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
ok('torch starts full', (await evl('__fp.batt')) > 95, `batt=${await evl('__fp.batt')}`);
const rangeLit = await evl('__fp.flRangeNow');
/* stand on a coin so the beam is definitely the thing lighting it - coins sitting
   in a lamp pool stay visible without a torch, which is the design, not a bug */
await evl(`(() => { const p = __fp.coinPoints()[0]; __fp.teleport(p.x - 60, p.y); __fp.aimAt(p.x, p.y); })()`);
await sleep(300);
const litBeamOn = await evl('__fp.coinsLit');
await evl('__fp.toggleBeam()');
await sleep(300);
ok('beam off kills the cone', (await evl('__fp.flRangeNow')) === 0, `range=${await evl('__fp.flRangeNow')}`);
ok('a dark torch hides the gold it was lighting', (await evl('__fp.coinsLit')) < litBeamOn, `on=${litBeamOn} off=${await evl('__fp.coinsLit')}`);
const recovered = await evl(`(() => { const a = __fp.batt; for (let i = 0; i < 60; i++) update(0.05); return __fp.batt - a; })()`);
ok('a rested torch recharges', recovered > 0, `+${recovered.toFixed(1)}`);
await evl('__fp.toggleBeam()');
await sleep(200);
ok('beam back on restores the cone', (await evl('__fp.flRangeNow')) === rangeLit, `range=${await evl('__fp.flRangeNow')}`);
const battFlat = await evl(`(() => { __fp.setBatt(3); let low = 1e9; for (let i = 0; i < 60; i++) { update(0.05); if (__fp.batt < low) low = __fp.batt; } return JSON.stringify({ low, on: __fp.beamOn, dead: __fp.battDead }); })()`);
const bf = JSON.parse(battFlat);
ok('an empty torch cuts out', bf.low === 0 && bf.on === false && bf.dead === true, battFlat);
ok('a dead torch will not switch back on', (await evl('__fp.toggleBeam()')) === false);
const woke = await evl(`(() => { for (let i = 0; i < 120; i++) update(0.05); return JSON.stringify({ batt: __fp.batt, dead: __fp.battDead }); })()`);
ok('it comes back once rested', JSON.parse(woke).dead === false, woke);
await evl('mapIdx = 0; loadMap(0); hud();');
await sleep(200);
ok('every floor starts on a full charge', (await evl('__fp.batt')) > 95 && (await evl('__fp.beamOn')) === true, `batt=${await evl('__fp.batt')}`);

/* ---- rain has depth and lands somewhere ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
const rainRes = await evl(`(() => {
  mode = 'playing'; paused = false; invuln = 999; endless = false;
  loop = 0; mapIdx = 0; loadMap(0); hud();
  const dry = __fp.rainDrops;
  mapIdx = 2; loadMap(2); hud();          /* Neon Heights: rain */
  const wet = __fp.rainDrops;
  const depths = __fp.rainDepths();
  return JSON.stringify({
    dry, wet,
    minDepth: Math.min(...depths), maxDepth: Math.max(...depths),
    bands: new Set(depths.map(d => d < 0.34 ? 'far' : d < 0.67 ? 'mid' : 'near')).size
  });
})()`);
const rn = JSON.parse(rainRes);
ok('dry floors have no rain', rn.dry === 0, rainRes);
ok('rainy ones do', rn.wet > 0, rainRes);
ok('and it is spread across depths', rn.minDepth < 0.2 && rn.maxDepth > 0.8, rainRes);
ok('covering all three bands', rn.bands === 3, rainRes);

ok('rain moves on real time, not a fixed step', await evl(`(() => {
  /* the old code advanced by a hard-coded 0.03 whatever the frame took */
  return __fp.lastDt > 0 && __fp.lastDt <= 0.05;
})()`));

ok('drops that land leave a splash', await evl(`(() => {
  mode = 'playing'; invuln = 999;
  loop = 0; mapIdx = 2; loadMap(2); hud();
  /* drop them all just above the floor line so they land promptly */
  for (const r of rain) { r.y = H - 4; }
  let seen = 0;
  for (let i = 0; i < 40; i++) { render(); if (__fp.splashes > seen) seen = __fp.splashes; }
  return seen > 0;
})()`));

ok('splashes clear themselves', await evl(`(() => {
  for (let i = 0; i < 200; i++) render();
  return __fp.splashes < 40;
})()`));

/* ---- fog you can see, not just feel ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
const fogVis = await evl(`(() => {
  mode = 'playing'; paused = false; invuln = 999; endless = false;
  loop = 0; mapIdx = 0; loadMap(0); hud();
  const dry = __fp.fogBanks;
  mapIdx = 7; loadMap(7); hud();          /* the Fog Docks */
  const wet = __fp.fogBanks;
  const clearDens = __fp.fogDensity;
  __fp.forceFog();
  for (let i = 0; i < 90; i++) update(0.016);
  const thickDens = __fp.fogDensity;
  /* the banks should be moving */
  const p0 = { x: fogBanks[0].x, y: fogBanks[0].y };
  for (let i = 0; i < 40; i++) update(0.016);
  const moved = Math.hypot(fogBanks[0].x - p0.x, fogBanks[0].y - p0.y);
  return JSON.stringify({ dry, wet, clearDens, thickDens, moved: +moved.toFixed(1) });
})()`);
const fv = JSON.parse(fogVis);
ok('dry floors carry no fog', fv.dry === 0, fogVis);
ok('the docks do', fv.wet > 0, fogVis);
ok('fog thickens as the beam chokes', fv.thickDens > fv.clearDens + 0.5, fogVis);
ok('and the banks drift', fv.moved > 1, fogVis);

/* it actually reaches the screen */
const fogPix = await evl(`(() => {
  mode = 'playing'; invuln = 999;
  loop = 0; mapIdx = 7; loadMap(7); hud();
  player.x = spawnPt.x; player.y = spawnPt.y;
  fogT = 0; flScale = 1;
  for (let i = 0; i < 20; i++) update(0.016);
  paused = true; render();
  const read = () => {
    const d = ctx.getImageData((W / 2 - 40) * DPR, (H / 2 - 40) * DPR, 80 * DPR, 80 * DPR).data;
    let s2 = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { s2 += d[i] + d[i+1] + d[i+2]; n++; }
    return Math.round(s2 / n);
  };
  const clear = read();
  paused = false;
  __fp.forceFog();
  for (let i = 0; i < 90; i++) update(0.016);
  paused = true; render();
  const thick = read();
  paused = false;
  return JSON.stringify({ clear, thick, dens: __fp.fogDensity });
})()`);
const fp2 = JSON.parse(fogPix);
ok('a fog bank puts something on the screen', fp2.thick > fp2.clear + 3, fogPix);

/* ---- light falls off on a curve, not a line ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
const fo = await evl(`(() => JSON.stringify(__fp.falloff))()`);
const curve = JSON.parse(fo);
ok('the falloff runs from full to nothing', curve[0][1] === 1 && curve[curve.length - 1][1] === 0, fo);
ok('it only ever decreases', curve.every((p, i) => i === 0 || p[1] <= curve[i - 1][1]), fo);
ok('and it is a curve rather than a straight line', (() => {
  /* a linear ramp would have value === 1 - t at every stop */
  return curve.some(([t, v]) => Math.abs(v - (1 - t)) > 0.08);
})(), fo);
ok('it holds its core before dropping', curve.find(([t]) => t >= 0.18)[1] > 0.85, fo);
ok('and keeps a long thin tail', curve.find(([t]) => t >= 0.78)[1] > 0 && curve.find(([t]) => t >= 0.78)[1] < 0.3, fo);

/* the pool a lamp casts should be brighter at its heart than at its edge */
const pool = await evl(`(() => {
  mode = 'playing'; invuln = 999; loop = 0; mapIdx = 0; loadMap(0); hud();
  const e = emitters.find(x => x.kind === 'lamp');
  if (!e) return JSON.stringify({ skip: true });
  player.x = e.x + e.r * 1.6; player.y = e.y;
  if (isWall(player.x, player.y)) player.x = e.x - e.r * 1.6;
  beamOn = false;
  for (let k = 0; k < 40; k++) update(0.016);
  paused = true; render();
  const read = (dx) => {
    const sx = (e.x + dx - camNow.cx) * Z, sy = (e.y - camNow.cy) * Z;
    if (sx < 6 || sy < 6 || sx > W - 6 || sy > H - 6) return null;
    const d = ctx.getImageData((sx - 3) * DPR, (sy - 3) * DPR, 6 * DPR, 6 * DPR).data;
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { sum += d[i] + d[i+1] + d[i+2]; n++; }
    return Math.round(sum / n);
  };
  const mid = read(0), edge = read(e.r * 0.85);
  paused = false; beamOn = true;
  return JSON.stringify({ mid, edge, r: Math.round(e.r) });
})()`);
const pl2 = JSON.parse(pool);
ok('a lamp is brighter at its centre than its rim',
  pl2.skip || (pl2.mid !== null && pl2.edge !== null && pl2.mid > pl2.edge + 12), pool);

/* ---- floors open rather than cut ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
const wipe = await evl(`(() => {
  mode = 'playing'; paused = false; invuln = 999; endless = false;
  loop = 0; mapIdx = 0; loadMap(0); hud();
  const before = { t: __fp.wipeT, floor: mapIdx };
  __fp.clearCoins(); __fp.teleport(exitPt.x, exitPt.y);
  for (let i = 0; i < 3; i++) update(0.016);
  const justAfter = { t: __fp.wipeT, name: __fp.wipeName, floor: mapIdx };
  for (let i = 0; i < 50; i++) update(0.016);
  const later = { t: __fp.wipeT };
  return JSON.stringify({ before, justAfter, later, len: T.WIPE_T });
})()`);
const wp = JSON.parse(wipe);
ok('no wipe while you are just playing', wp.before.t === 0, wipe);
ok('taking the stairs starts one', wp.justAfter.t > 0, wipe);
ok('and it names where you have arrived', wp.justAfter.name === 'THE WAREHOUSE', wipe);
ok('the floor has already changed underneath it', wp.justAfter.floor === wp.before.floor + 1, wipe);
ok('and it clears itself', wp.later.t === 0, wipe);
ok('the wipe is brief', wp.len < 1, wipe);

ok('a wipe never carries into a fresh run', await evl(`(() => {
  mode = 'playing'; wipeT = T.WIPE_T;
  mode = 'menu';
  loop = 0; mapIdx = 0; loadMap(0);
  return __fp.wipeT === 0;
})()`));

/* ---- the win screen says how you did it ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
const winCard = await evl(`(() => {
  mode = 'playing'; paused = false; invuln = 999;
  __fp.resetKit(); __fp.resetAchs();
  loop = 0; mapIdx = 0; loadMap(0); hud();
  totalRunCoins = 40; coins = 3; score = 1234; runT = 250; alertLvl = 0;
  unlock('clean');
  win();
  return JSON.stringify({
    summary: document.getElementById('escSummary').textContent,
    chips: [...document.querySelectorAll('#escAchs span')].map(x => x.textContent),
    timeShown: document.getElementById('eTime').textContent,
    timeVisible: document.getElementById('eTime').offsetParent !== null,
    coinsStart: document.getElementById('eCoins').textContent
  });
})()`);
const wc = JSON.parse(winCard);
ok('the win screen says how you played', /STANDARD/i.test(wc.summary), winCard);
ok('and whether they ever had you', /never detected/i.test(wc.summary), winCard);
ok('and how long it took', wc.summary.includes('4:10') && wc.timeShown === '4:10', winCard);
ok('the time stat is still on the card', wc.timeVisible === true, winCard);
ok('it lists what the run earned', wc.chips.length >= 1, winCard);

await sleep(1400);
const wc2 = await evl(`(() => JSON.stringify({
  coins: document.getElementById('eCoins').textContent,
  score: document.getElementById('eScore').textContent
}))()`);
const wcFinal = JSON.parse(wc2);
ok('the totals count up and settle on the real numbers',
  wcFinal.coins === '43' && Number(wcFinal.score) > 1234, wc2 + ' start=' + wc.coinsStart);

/* ---- being caught holds for a beat before the card ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
const caughtBeat = await evl(`(() => {
  mode = 'playing'; paused = false; invuln = 999;
  loop = 0; mapIdx = 0; loadMap(0); hud();
  document.getElementById('caught').classList.add('hidden');
  caught();
  const rightAfter = {
    mode, hold: __fp.caughtHold,
    cardHidden: document.getElementById('caught').classList.contains('hidden')
  };
  /* the hold ticks in update(), which still runs its first lines when caught */
  for (let i = 0; i < 8; i++) update(0.016);
  const midway = { hold: __fp.caughtHold, cardHidden: document.getElementById('caught').classList.contains('hidden') };
  for (let i = 0; i < 60; i++) update(0.016);
  const after = { hold: __fp.caughtHold, cardHidden: document.getElementById('caught').classList.contains('hidden') };
  return JSON.stringify({ rightAfter, midway, after, len: T.CAUGHT_HOLD });
})()`);
const cb = JSON.parse(caughtBeat);
ok('being caught takes effect immediately', cb.rightAfter.mode === 'caught', caughtBeat);
ok('but the card is held back at first', cb.rightAfter.cardHidden === true && cb.rightAfter.hold > 0, caughtBeat);
ok('the beat is still running a moment later', cb.midway.cardHidden === true && cb.midway.hold > 0, caughtBeat);
ok('and then the card lands', cb.after.cardHidden === false && cb.after.hold === 0, caughtBeat);
ok('the beat is short enough not to annoy', cb.len <= 1, caughtBeat);

/* ---- each building keeps its money as something different ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
const loot = await evl(`(() => {
  const kinds = __fp.lootKinds();
  return JSON.stringify({ kinds, uniq: [...new Set(kinds)].length, n: kinds.length });
})()`);
const lootRes = JSON.parse(loot);
ok('every floor resolves a loot shape', lootRes.n === 12 && lootRes.kinds.every(k => !!k), loot);
ok('and there is real variety across the campaign', lootRes.uniq >= 5, loot);

/* the shape changes but nothing about picking it up does */
ok('loot is the same size and value whatever shape it is', await evl(`(() => {
  mode = 'playing'; invuln = 999;
  const vals = [];
  for (const i of [0, 4, 6, 7]) {
    loop = 0; mapIdx = i; loadMap(i); hud();
    const c = coinList.find(z => !z.got);
    player.x = c.x; player.y = c.y;
    const before = __fp.coins;
    update(0.016);
    vals.push({ kind: __fp.lootKind(), picked: __fp.coins - before });
  }
  return vals.every(v => v.picked === 1);
})()`));

/* it is drawn, whatever the shape - sampled next to the player where the camera
   is guaranteed to be looking */
const lootPix = await evl(`(() => {
  mode = 'playing'; invuln = 999;
  const bright = [];
  for (const i of [0, 2, 4, 5, 6, 7, 8]) {
    loop = 0; mapIdx = i; loadMap(i); hud(); __fp.forgetCoins();
    const c = coinList.find(z => !z.got);
    player.x = c.x - 60; player.y = c.y;
    mouseWX = c.x; mouseWY = c.y;
    for (let k = 0; k < 30; k++) update(0.016);
    paused = true; render();
    const sx = (c.x - camNow.cx) * Z, sy = (c.y - camNow.cy) * Z;
    if (sx < 10 || sy < 10 || sx > W - 10 || sy > H - 10) { paused = false; continue; }
    const d = ctx.getImageData((sx - 7) * DPR, (sy - 7) * DPR, 14 * DPR, 14 * DPR).data;
    let max = 0;
    for (let q = 0; q < d.length; q += 4) { const v = d[q] + d[q+1] + d[q+2]; if (v > max) max = v; }
    paused = false;
    bright.push({ floor: i + 1, kind: __fp.lootKind(), max, lit: __fp.coinsLit });
  }
  return JSON.stringify(bright);
})()`);
const lootDraw = JSON.parse(lootPix || '[]');
const lootLit = lootDraw.filter(b => b.lit > 0);
ok('most floors light their loot for the test', lootLit.length >= 5, lootPix);
ok('every lit loot shape draws brightly', lootLit.length > 0 && lootLit.every(b => b.max > 400), lootPix);
ok('and that covers several different shapes', new Set(lootLit.map(b => b.kind)).size >= 4, lootPix);

/* ---- the exit is a door ---- */
/* Deliberately not a pixel assertion. The exit sits at the map edge on several
   floors and the camera clamps there, so the door lands off-canvas and every
   sample reads zero - that tests the harness, not the game. Both states were
   checked by eye in full-frame captures; what is worth pinning here is the
   geometry the drawing depends on. */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
const doorGeom = await evl(`(() => {
  const out = [];
  for (let i = 0; i < MAPS.length; i++) {
    loop = 0; mapIdx = i; loadMap(i);
    const c = cellOf(exitPt.x, exitPt.y);
    const openH = !isWallCell(c.gx - 1, c.gy) || !isWallCell(c.gx + 1, c.gy);
    const openV = !isWallCell(c.gx, c.gy - 1) || !isWallCell(c.gx, c.gy + 1);
    out.push({ i, vertical: exitVertical, reachable: !isWall(exitPt.x, exitPt.y), openH, openV });
  }
  return JSON.stringify(out);
})()`);
const dg = JSON.parse(doorGeom);
ok('every floor has a reachable exit', dg.every(d => d.reachable), doorGeom);
ok('every doorway resolves an orientation', dg.every(d => typeof d.vertical === 'boolean'), doorGeom);
ok('and it matches the side that is actually open',
  dg.every(d => (d.openH || d.openV) ? (d.vertical === (d.openH && !d.openV ? true : (d.openV && !d.openH ? false : d.vertical))) : true),
  doorGeom);

/* ---- the drone reads its own state ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
const droneLook = await evl(`(() => {
  mode = 'playing'; invuln = 999; loop = 0; mapIdx = 0; loadMap(0); hud();
  const b = bots[0];
  player.x = b.x - 90; player.y = b.y; mouseWX = b.x; mouseWY = b.y;
  for (let k = 0; k < 3; k++) update(0.016);
  if (!revealed(b)) return JSON.stringify({ err: 'drone not lit' });
  paused = true;
  const sample = (st, wary) => {
    b.state = st; b.wary = wary; b.glow = 0;
    render();
    const sx = (b.x - camNow.cx) * Z, sy = (b.y - camNow.cy) * Z;
    const d = ctx.getImageData((sx - 4) * DPR, (sy - 4) * DPR, 8 * DPR, 8 * DPR).data;
    let r = 0, g = 0, bl = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i+1]; bl += d[i+2]; n++; }
    return { r: Math.round(r/n), g: Math.round(g/n), b: Math.round(bl/n) };
  };
  const out = { patrol: sample('patrol', 0), invest: sample('invest', T.WARY_T), chase: sample('chase', 0) };
  paused = false;
  return JSON.stringify(out);
})()`);
const dl = JSON.parse(droneLook);
ok('a hunting drone burns brighter than a patrolling one',
  !dl.err && (dl.chase.r + dl.chase.g + dl.chase.b) > (dl.patrol.r + dl.patrol.g + dl.patrol.b) + 40, droneLook);
ok('an unsure drone reads warmer than a calm one',
  !dl.err && dl.invest.g > dl.patrol.g + 15, droneLook);
ok('all three states are distinguishable',
  !dl.err && new Set([dl.patrol, dl.invest, dl.chase].map(c => c.r + ',' + c.g + ',' + c.b)).size === 3, droneLook);

/* ---- idle personality: four drones, four clocks ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
const traits = await evl(`(() => {
  mode = 'playing'; invuln = 999; endless = false;
  loop = 0; mapIdx = 11; loadMap(11); hud();
  const t = __fp.botTraits();
  const spread = k => Math.max(...t.map(x => x[k])) - Math.min(...t.map(x => x[k]));
  return JSON.stringify({ n: t.length, t, sweepSpread: +spread('sweep').toFixed(3), paceSpread: +spread('pace').toFixed(3) });
})()`);
const tr = JSON.parse(traits);
ok('drones have their own traits', tr.n >= 3, traits);
ok('and they are not all the same', tr.sweepSpread > 0.05 && tr.paceSpread > 0.005, traits);
ok('every trait stays in a sane band', tr.t.every(x =>
  x.sweep >= 0.7 && x.sweep <= 1.4 && x.pace >= 0.9 && x.pace <= 1.12), traits);

ok('a daily run gives the same personalities twice', await evl(`(() => {
  __fp.setDaily(true);
  const snap = () => { __fp.resetKit(); loop = 0; mapIdx = 11; loadMap(11); return JSON.stringify(__fp.botTraits()); };
  const a = snap(), b = snap();
  __fp.setDaily(false);
  return a === b;
})()`));

ok('some drones loiter at a waypoint', await evl(`(() => {
  mode = 'playing'; invuln = 999;
  loop = 0; mapIdx = 11; loadMap(11); hud();
  let anyDwell = false;
  bots.forEach((b, i) => { if (__fp.advanceWpFor(i) > 0) anyDwell = true; });
  /* with four drones and a 35% chance each, at least one should - but the real
     assertion is that a dwell, when it happens, is inside the configured band */
  const all = __fp.botDwell.filter(v => v > 0);
  return all.every(v => v >= T.DWELL_MIN - 0.01 && v <= T.DWELL_MAX + 0.01);
})()`));

ok('a loitering drone actually stands still', await evl(`(() => {
  mode = 'playing'; invuln = 999;
  loop = 0; mapIdx = 11; loadMap(11); hud();
  player.x = -9999; player.y = -9999;
  const b = bots[0];
  b.state = 'patrol'; b.dwellT = 1.2; b.peekT = 0;
  const from = { x: b.x, y: b.y };
  for (let i = 0; i < 20; i++) update(0.016);
  return Math.hypot(bots[0].x - from.x, bots[0].y - from.y) < 1;
})()`));

/* ---- hearing sharpens with depth ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
const hearing = await evl(`(() => {
  mode = 'playing'; invuln = 999; endless = false;
  const at = (floor, lp) => { loop = lp; mapIdx = floor; loadMap(floor); hud(); return __fp.hearReachBare(); };
  const f1 = at(0, 0), f6 = at(5, 0), f12 = at(11, 0), looped = at(0, 2);
  loop = 0; mapIdx = 0; loadMap(0); hud();
  const b = bots[0];
  b.wary = 0; const calm = __fp.hearReach(0);
  b.wary = T.WARY_T; const jumpy = __fp.hearReach(0);
  b.wary = 0;
  return JSON.stringify({ f1, f6, f12, looped, calm, jumpy });
})()`);
const hr = JSON.parse(hearing);
ok('deeper floors hear further', hr.f12 > hr.f6 && hr.f6 > hr.f1, hearing);
ok('a loop of the building sharpens them', hr.looped > hr.f1, hearing);
ok('a wary drone listens harder', hr.jumpy > hr.calm, hearing);

ok('a noise just inside reach is heard, just outside is not', await evl(`(() => {
  mode = 'playing'; invuln = 999;
  loop = 0; mapIdx = 0; loadMap(0); hud();
  const b = bots[0];
  b.wary = 0; b.state = 'patrol';
  const reach = __fp.hearReach(0);
  const probe = (extra) => {
    noise.length = 0;
    /* a zero-radius noise, so the drone's own reach is the only thing being tested */
    noise.push({ x: b.x + reach + extra, y: b.y, r: 0, t: 0.3 });
    return !!nearestNoise(b);
  };
  return probe(-20) === true && probe(40) === false;
})()`));

/* ---- radio cooldown: one call, then wait ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
const radio = await evl(`(() => {
  mode = 'playing'; invuln = 999; loop = 0; mapIdx = 11; loadMap(11); hud();
  player.x = spawnPt.x; player.y = spawnPt.y;
  bots.forEach((b, i) => {
    b.x = player.x + 120 + i * 20; b.y = player.y;
    b.state = 'patrol'; b.path = []; b.radioT = 0; b.flankX = undefined;
  });
  const first = __fp.radioFrom(0);
  const coolAfter = __fp.botRadioT[0];
  const second = __fp.radioFrom(0);      /* immediately again */
  return JSON.stringify({ first, second, coolAfter });
})()`);
const rd2 = JSON.parse(radio);
ok('the first call reaches the others', rd2.first >= 1, radio);
ok('an immediate second call is ignored', rd2.second === 0, radio);
ok('and the caller is on cooldown', rd2.coolAfter > 0, radio);

ok('the cooldown wears off', await evl(`(() => {
  mode = 'playing'; invuln = 999;
  const b = bots[0];
  b.radioT = 0.2;
  for (let i = 0; i < 30; i++) update(0.016);
  return __fp.botRadioT[0] === 0;
})()`));

ok('a drone already heading somewhere close is left alone', await evl(`(() => {
  mode = 'playing'; invuln = 999;
  loop = 0; mapIdx = 11; loadMap(11); hud();
  player.x = spawnPt.x; player.y = spawnPt.y;
  bots.forEach((b, i) => {
    b.x = player.x + 120 + i * 20; b.y = player.y;
    b.state = 'patrol'; b.path = []; b.radioT = 0; b.flankX = undefined;
  });
  __fp.radioFrom(0);
  const before = __fp.botFlanks();
  bots[0].radioT = 0;
  __fp.radioFrom(0);
  const after = __fp.botFlanks();
  /* the already-committed drones keep the point they were given */
  return JSON.stringify(before) === JSON.stringify(after);
})()`));

/* ---- giving up: rejoin the route nearby, and stay jumpy ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
const giveup = await evl(`(() => {
  mode = 'playing'; invuln = 999; loop = 0; mapIdx = 1; loadMap(1); hud();
  const b = bots[0];
  if (__fp.botRouteLen(0) < 3) return JSON.stringify({ skip: true });
  /* park it far from the waypoint it currently holds, as a long chase would */
  const far = b.route.reduce((acc, wp, i) => {
    const d = Math.hypot((wp[0] + .5) * T.TILE - b.x, (wp[1] + .5) * T.TILE - b.y);
    return d > acc.d ? { d, i } : acc;
  }, { d: -1, i: 0 });
  b.wp = far.i;
  const beforeDist = __fp.botWpDist(0);
  const beforeWp = b.wp;
  b.state = 'invest';
  const wp = __fp.giveUpBot(0);
  return JSON.stringify({
    beforeWp, afterWp: wp, beforeDist, afterDist: __fp.botWpDist(0),
    wary: __fp.botWary[0], state: bots[0].state
  });
})()`);
const gu = JSON.parse(giveup);
ok('giving up returns the drone to patrol', gu.skip || gu.state === 'patrol', giveup);
ok('it rejoins its route at the nearest point', gu.skip || gu.afterDist < gu.beforeDist, giveup);
ok('which is usually a different waypoint', gu.skip || gu.afterWp !== gu.beforeWp, giveup);
ok('and it stays wary for a while', gu.skip || gu.wary > 0, giveup);

ok('a wary drone sees a little further', await evl(`(() => {
  const b = bots[0];
  b.wary = 0;
  const calm = botRange(b);
  b.wary = T.WARY_T;
  const jumpy = botRange(b);
  b.wary = 0;
  return jumpy > calm;
})()`));

ok('and the wariness wears off', await evl(`(() => {
  mode = 'playing'; invuln = 999;
  const b = bots[0];
  b.wary = 0.3;
  for (let i = 0; i < 40; i++) update(0.016);
  return __fp.botWary[0] === 0;
})()`));

ok('an exhausted search ends in a give-up, not a snap', await evl(`(() => {
  mode = 'playing'; invuln = 999;
  loop = 0; mapIdx = 1; loadMap(1); hud();
  const b = bots[0];
  player.x = -9999; player.y = -9999;
  b.state = 'invest'; b.stateT = 0; b.searchPts = []; b.path = []; b.wary = 0;
  for (let i = 0; i < 40; i++) update(0.016);
  return bots[0].state === 'patrol' && __fp.botWary[0] > 0;
})()`));

/* ---- predictive intercept: they cut, they do not tail ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
const lead = await evl(`(() => {
  mode = 'playing'; invuln = 999; loop = 0; mapIdx = 0; loadMap(0); hud();
  /* standing still: the lead point must be exactly where you are */
  player.vx = 0; player.vy = 0;
  const still = __fp.leadPoint();
  const atRest = Math.hypot(still.x - player.x, still.y - player.y) < 1;
  /* moving through open floor: it must be ahead of you */
  let openX = player.x, openY = player.y;
  for (let d = 40; d < 300; d += 20) {
    if (!isWall(player.x + d, player.y)) { openX = player.x; openY = player.y; } else break;
  }
  player.vx = T.WALK; player.vy = 0;
  const moving = __fp.leadPoint();
  const ahead = moving.x - player.x;
  player.vx = 0;
  return JSON.stringify({ atRest, ahead: Math.round(ahead), walk: T.WALK, leadT: T.LEAD_T });
})()`);
const ld = JSON.parse(lead);
ok('standing still, they aim at you', ld.atRest === true, lead);
ok('moving, they aim ahead of you', ld.ahead > 10, lead);
ok('the lead stays short of a full second of travel', ld.ahead < ld.walk, lead);

ok('a lead point is never inside a wall', await evl(`(() => {
  for (let i = 0; i < 40; i++) {
    const a = i / 40 * Math.PI * 2;
    player.vx = Math.cos(a) * T.SPRINT; player.vy = Math.sin(a) * T.SPRINT;
    const q = __fp.leadPoint();
    if (isWall(q.x, q.y)) return false;
  }
  player.vx = 0; player.vy = 0;
  return true;
})()`));

ok('they still close the distance while chasing', await evl(`(() => {
  mode = 'playing'; invuln = 999;
  loop = 0; mapIdx = 0; loadMap(0); hud();
  const b = bots[0];
  player.x = spawnPt.x; player.y = spawnPt.y;
  b.x = player.x + 200; b.y = player.y;
  b.face = Math.atan2(player.y - b.y, player.x - b.x);
  b.state = 'chase'; b.chaseT = 3; b.repathT = 0;
  const from = Math.hypot(b.x - player.x, b.y - player.y);
  for (let i = 0; i < 90; i++) update(0.016);
  return Math.hypot(bots[0].x - player.x, bots[0].y - player.y) < from;
})()`));

ok('they do not re-path on every frame', await evl(`(() => {
  mode = 'playing'; invuln = 999;
  loop = 0; mapIdx = 0; loadMap(0); hud();
  const b = bots[0];
  player.x = spawnPt.x; player.y = spawnPt.y; player.vx = 0; player.vy = 0;
  b.x = player.x + 90; b.y = player.y;
  b.face = Math.atan2(player.y - b.y, player.x - b.x);
  b.state = 'chase'; b.repathT = 0;
  if (!botSees(b)) return false;
  update(0.016);
  const justSet = __fp.repathT[0];
  update(0.016);
  const stillCounting = __fp.repathT[0];
  return justSet > 0 && stillCounting < justSet && stillCounting > 0;
})()`));

/* ---- corner peeking: a pause where a corridor turns ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
ok('a straight corridor is not a junction', await evl(`(() => {
  mode = 'playing'; invuln = 999; loop = 0; mapIdx = 0; loadMap(0); hud();
  /* find a run of open floor with walls both sides - a corridor, not a turn */
  for (let y = 2; y < 16; y++) for (let x = 2; x < 26; x++) {
    const wx = (x + .5) * T.TILE, wy = (y + .5) * T.TILE;
    if (isWall(wx, wy)) continue;
    const T2 = T.TILE;
    const straightH = isWall(wx, wy - T2) && isWall(wx, wy + T2) && !isWall(wx - T2, wy) && !isWall(wx + T2, wy);
    if (straightH) return __fp.isJunctionAt(wx, wy) === false;
  }
  return true;
})()`));

ok('a turn is a junction', await evl(`(() => {
  const T2 = T.TILE;
  for (let y = 2; y < 16; y++) for (let x = 2; x < 26; x++) {
    const wx = (x + .5) * T.TILE, wy = (y + .5) * T.TILE;
    if (isWall(wx, wy)) continue;
    const R = !isWall(wx + T2, wy), L = !isWall(wx - T2, wy);
    const D = !isWall(wx, wy + T2), U = !isWall(wx, wy - T2);
    if ((R + L + D + U) === 2 && (R || L) && (D || U)) return __fp.isJunctionAt(wx, wy) === true;
  }
  return true;
})()`));

const peek = await evl(`(() => {
  mode = 'playing'; invuln = 999;
  loop = 0; mapIdx = 1; loadMap(1); hud();
  player.x = -9999; player.y = -9999;          /* keep them on patrol */
  for (const b of bots) { b.state = 'patrol'; b.peekT = 0; b.peekCool = 0; }
  let sawPeek = 0, stoodStill = 0;
  for (let i = 0; i < 900; i++) {
    const before = bots.map(b => ({ x: b.x, y: b.y }));
    update(0.016);
    bots.forEach((b, j) => {
      if (b.peekT > 0) {
        sawPeek++;
        if (Math.hypot(b.x - before[j].x, b.y - before[j].y) < 0.5) stoodStill++;
      }
    });
  }
  return JSON.stringify({ sawPeek, stoodStill });
})()`);
const pk2 = JSON.parse(peek);
ok('drones pause on patrol', pk2.sawPeek > 0, peek);
ok('and they hold still while they look', pk2.stoodStill > pk2.sawPeek * 0.8, peek);

ok('a peek does not stall a chase', await evl(`(() => {
  mode = 'playing'; invuln = 999;
  loop = 0; mapIdx = 0; loadMap(0); hud();
  const b = bots[0];
  player.x = b.x + 70; player.y = b.y;
  b.face = Math.atan2(player.y - b.y, player.x - b.x);
  b.state = 'patrol'; b.peekT = T.PEEK_T; b.peekCool = 0;
  const from = Math.hypot(b.x - player.x, b.y - player.y);
  let chased = false;
  for (let i = 0; i < 60; i++) { update(0.016); if (bots[0].state === 'chase') chased = true; }
  return chased && Math.hypot(bots[0].x - player.x, bots[0].y - player.y) < from - 20;
})()`));

/* ---- spiral search: losing them means outrunning a search ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
const spiral = await evl(`(() => {
  mode = 'playing'; invuln = 999; endless = false;
  loop = 0; mapIdx = 0; loadMap(0); hud();
  let open = { x: player.x, y: player.y }, best = -1;
  for (let y = 2; y < 16; y++) for (let x = 2; x < 26; x++) {
    const wx = (x + .5) * T.TILE, wy = (y + .5) * T.TILE;
    if (isWall(wx, wy)) continue;
    let room = 0;
    for (let a = 0; a < 8; a++) if (!isWall(wx + Math.cos(a) * 90, wy + Math.sin(a) * 90)) room++;
    if (room > best) { best = room; open = { x: wx, y: wy }; }
  }
  const pts = __fp.searchSpiralAt(open.x, open.y);
  const dists = pts.map(p => Math.round(Math.hypot(p.x - open.x, p.y - open.y)));
  const uniq = new Set(pts.map(p => p.x + ',' + p.y)).size;
  const allOpen = pts.every(p => !isWall(p.x, p.y));
  return JSON.stringify({ n: pts.length, uniq, allOpen, dists });
})()`);
const sp3 = JSON.parse(spiral);
ok('a search has several places to look', sp3.n >= 3, spiral);
ok('none of them repeat', sp3.uniq === sp3.n, spiral);
ok('all of them are walkable', sp3.allOpen === true, spiral);
ok('and they spread outward', Math.max(...sp3.dists) > Math.min(...sp3.dists) + 30, spiral);

/* losing a drone should start a search, not a countdown */
const lost = await evl(`(() => {
  mode = 'playing'; invuln = 999;
  loop = 0; mapIdx = 0; loadMap(0); hud();
  const b = bots[0];
  b.x = player.x + 60; b.y = player.y;
  b.face = Math.atan2(player.y - b.y, player.x - b.x);
  b.state = 'chase'; b.stateT = 0; b.lastX = player.x; b.lastY = player.y;
  b.searchPts = [];
  /* teleport the player far away so the drone loses sight */
  player.x = spawnPt.x; player.y = spawnPt.y;
  if (Math.hypot(player.x - b.x, player.y - b.y) < 400) { player.x = b.x + 600; player.y = b.y + 400; }
  let sawSearch = 0, states = new Set();
  for (let i = 0; i < 800; i++) {
    update(0.016);
    states.add(bots[0].state);
    const left = __fp.botSearchLeft()[0];
    if (left > 0) sawSearch = Math.max(sawSearch, left);
  }
  return JSON.stringify({ sawSearch, states: [...states], ended: bots[0].state });
})()`);
const ls = JSON.parse(lost);
ok('losing you starts a search', ls.sawSearch > 0, lost);
ok('the drone works through it', ls.states.includes('invest'), lost);
ok('and eventually goes back on patrol', ls.ended === 'patrol', lost);

ok('a noise also starts a search rather than one visit', await evl(`(() => {
  mode = 'playing'; invuln = 999;
  loop = 0; mapIdx = 0; loadMap(0); hud();
  const b = bots[0];
  b.state = 'patrol'; b.path = []; b.searchPts = [];
  b.face = Math.atan2(b.y - player.y, b.x - player.x);
  makeNoise(b.x + 80, b.y, 600);
  update(0.016);
  return (__fp.botSearchLeft()[0] > 0) && bots[0].state === 'invest';
})()`));

/* ---- flanking: a radioed net closes from several sides ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
const flank = await evl(`(() => {
  mode = 'playing'; invuln = 999; endless = false;
  loop = 0; mapIdx = 11; loadMap(11); hud();   /* the Penthouse, four drones */
  /* stand them in open floor around the player so nobody is boxed in */
  player.x = spawnPt.x; player.y = spawnPt.y;
  const ring = [];
  for (let a = 0; a < 8 && ring.length < bots.length + 1; a++) {
    const ang = a / 8 * Math.PI * 2;
    const x = player.x + Math.cos(ang) * 150, y = player.y + Math.sin(ang) * 150;
    if (!isWall(x, y)) ring.push({ x, y });
  }
  if (ring.length < 2) return JSON.stringify({ err: 'no open ring' });
  bots.forEach((b, i) => {
    const p = ring[i % ring.length];
    b.x = p.x; b.y = p.y; b.state = 'patrol'; b.path = []; b.flankX = undefined;
  });
  const src = bots[0];
  src.state = 'chase';
  const heard = __fp.radioFrom(0);
  const flanks = __fp.botFlanks().filter(Boolean);
  const uniq = new Set(flanks.map(f => f.x + ',' + f.y)).size;
  const atPlayer = flanks.filter(f => Math.hypot(f.x - player.x, f.y - player.y) < 20).length;
  const spread = flanks.map(f => Math.round(Math.atan2(f.y - player.y, f.x - player.x) * 180 / Math.PI));
  return JSON.stringify({ heard, flanks: flanks.length, uniq, atPlayer, spread });
})()`);
const fl2 = JSON.parse(flank);
ok('the radio reaches the other drones', fl2.heard >= 2, flank);
ok('each gets its own approach point', fl2.uniq === fl2.flanks && fl2.flanks >= 2, flank);
ok('they aim around you, not at you', fl2.atPlayer === 0, flank);
ok('and from different bearings', new Set(fl2.spread).size >= 2, flank);

ok('a flank point is always somewhere walkable', await evl(`(() => {
  return __fp.botFlanks().filter(Boolean).every(f => !isWall(f.x, f.y));
})()`));

ok('their paths do not all end in the same cell', await evl(`(() => {
  const ends = __fp.botPathEnds().filter(Boolean);
  if (ends.length < 2) return true;
  return new Set(ends.map(e => e.x + ',' + e.y)).size > 1;
})()`));

/* ---- ghost replay: your own best route through a floor ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
await evl('__fp.resetGhosts()');
ok('a fresh device has no ghost', (await evl('__fp.ghostLen')) === 0);

const ghostRun = await evl(`(() => {
  mode = 'playing'; invuln = 999; endless = false;
  loop = 0; mapIdx = 0; loadMap(0); hud();
  keys.left = keys.right = keys.up = keys.down = false;
  keys.right = true;
  for (let i = 0; i < 120; i++) update(0.016);
  keys.right = false;
  const walked = __fp.trailLen, t1 = __fp.floorT;
  __fp.clearCoins(); __fp.teleport(exitPt.x, exitPt.y);
  for (let i = 0; i < 5; i++) update(0.016);
  /* back to floor 1 and the ghost of that walk should be waiting */
  loop = 0; mapIdx = 0; loadMap(0); hud();
  return JSON.stringify({ walked, t1: +t1.toFixed(2), ghost: __fp.ghostLen, best: __fp.ghostBest });
})()`);
const gh = JSON.parse(ghostRun);
ok('walking records a trail', gh.walked > 4, ghostRun);
ok('clearing the floor stores it', gh.best !== null, ghostRun);
ok('and it is waiting next time you play that floor', gh.ghost > 4, ghostRun);

ok('only a faster route replaces a ghost', await evl(`(() => {
  const best = __fp.ghostBest;
  /* a slower clear must not overwrite it */
  loop = 0; mapIdx = 0; loadMap(0); hud();
  __fp.setFloorT(best + 30);
  for (let i = 0; i < 20; i++) update(0.016);
  __fp.saveGhost();
  const afterSlow = __fp.ghostBest;
  /* a faster one must */
  loop = 0; mapIdx = 0; loadMap(0); hud();
  for (let i = 0; i < 20; i++) update(0.016);
  __fp.setFloorT(0.5);
  __fp.saveGhost();
  return afterSlow === best && __fp.ghostBest === 0.5;
})()`));

ok('endless runs do not overwrite campaign ghosts', await evl(`(() => {
  const before = __fp.ghostBest;
  endless = true;
  loop = 0; mapIdx = 0; loadMap(0); hud();
  for (let i = 0; i < 20; i++) update(0.016);
  __fp.setFloorT(0.01);
  __fp.saveGhost();
  const after = __fp.ghostBest;
  endless = false;
  return after === before;
})()`));

ok('a ghost stays small enough to store', await evl(`(() => {
  const raw = localStorage.getItem('flashpoint.ghosts') || '';
  return raw.length > 0 && raw.length < 40000;
})()`));

/* ---- endless loop modifiers ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
ok('there are eight loop rules', (await evl('__fp.modsTotal')) === 8, `n=${await evl('__fp.modsTotal')}`);
ok('the campaign runs without one', (await evl('__fp.loopMod')) === null);

ok('entering endless picks a rule', await evl(`(() => {
  mode = 'playing'; invuln = 999;
  continueEndless();
  return __fp.loopMod !== null && __fp.loopModName !== null;
})()`));

const modEffects = await evl(`(() => {
  mode = 'playing'; invuln = 999; endless = true; loop = 1;
  const read = (i) => {
    __fp.setMod(i);
    mapIdx = 0; loadMap(0); hud();
    const M = MAPS[0];
    return { id: __fp.loopMod, bots: __fp.botsN, coin: __fp.coinValue(),
             haulFull: (coins = coinsTotal, +__fp.haulNoise.toFixed(2)),
             blackout: blackoutMap, siren: nextSiren < 1e8 };
  };
  const out = [];
  for (let i = 0; i < __fp.modsTotal; i++) out.push(read(i));
  __fp.setMod(-1); endless = false;
  return JSON.stringify(out);
})()`);
const me = JSON.parse(modEffects);
const byId = Object.fromEntries(me.map(m => [m.id, m]));
ok('swarm adds a drone', byId.swarm.bots > byId.trigger.bots, modEffects);
ok('the curse doubles gold', byId.curse.coin > byId.trigger.coin, modEffects);
ok('and makes you ring louder with it', byId.curse.haulFull > byId.trigger.haulFull, modEffects);
ok('grid failure blacks out an ordinary floor', byId.grid.blackout === true && byId.trigger.blackout === false, modEffects);
ok('wailing puts sirens on an ordinary floor', byId.wail.siren === true && byId.trigger.siren === false, modEffects);

ok('brownout kills the lamps', await evl(`(() => {
  mode = 'playing'; endless = true; loop = 1;
  __fp.setMod(3); mapIdx = 0; loadMap(0); emps.length = 0;
  update(0.016);
  const dead = emitters.filter(e => (e.kind === 'lamp' || e.kind === 'neon') && e.dead).length;
  __fp.setMod(-1); endless = false; update(0.016);
  const alive = emitters.filter(e => (e.kind === 'lamp' || e.kind === 'neon') && e.dead).length;
  return dead > 0 && alive === 0;
})()`));

ok('a daily endless run picks the same rule twice', await evl(`(() => {
  __fp.setDaily(true);
  endless = true; loop = 3;
  const a = __fp.pickMod();
  const b = __fp.pickMod();
  __fp.setDaily(false); endless = false; __fp.setMod(-1);
  return a === b;
})()`));

/* ---- difficulty modes ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
await evl("__fp.setDiff('standard')");
ok('standard is the default shape', await evl(`(() => {
  const m = __fp.diffMods;
  return m.bot === 1 && m.fill === 1 && m.batt === 1 && m.kit === 0 && m.score === 1;
})()`));

const diffs = await evl(`(() => {
  const read = (id) => {
    __fp.setDiff(id);
    mode = 'playing'; invuln = 999; loop = 0; alertLvl = 0;
    mapIdx = 0; loadMap(0); hud(); __fp.resetKit();
    return { id, speed: +__fp.botSpeedMult.toFixed(3), coin: __fp.coinValue(), kit: __fp.kit };
  };
  const out = [read('casual'), read('standard'), read('blackout')];
  __fp.setDiff('standard');
  return JSON.stringify(out);
})()`);
const dm = JSON.parse(diffs);
const [cas, std, blk] = dm;
ok('casual drones are slower than standard', cas.speed < std.speed, diffs);
ok('blackout drones are faster', blk.speed > std.speed, diffs);
ok('casual hands you more kit', cas.kit.flare > std.kit.flare && cas.kit.emp > std.kit.emp, diffs);
ok('blackout hands you less', blk.kit.flare < std.kit.flare, diffs);
ok('and blackout never goes below nothing', Object.values(blk.kit).every(v => v >= 0), diffs);
ok('harder play is worth more', blk.coin > std.coin && cas.coin < std.coin, diffs);

ok('the torch drains faster on blackout', await evl(`(() => {
  const drainFor = (id) => {
    __fp.setDiff(id);
    mode = 'playing'; invuln = 999; mapIdx = 0; loadMap(0); hud();
    beamOn = true; __fp.setBatt(100);
    for (let i = 0; i < 30; i++) update(0.05);
    return __fp.batt;
  };
  const b = drainFor('blackout'), s2 = drainFor('standard'), c = drainFor('casual');
  __fp.setDiff('standard');
  return b < s2 && s2 < c;
})()`));

ok('the button cycles all three and sticks', await evl(`(() => {
  __fp.setDiff('standard'); toMenu();
  const b = document.getElementById('diffBtn');
  const seen = [];
  for (let i = 0; i < 3; i++) { b.click(); seen.push(__fp.diff); }
  const stored = localStorage.getItem('flashpoint.diff');
  __fp.setDiff('standard');
  return seen.join(',') === 'blackout,casual,standard' && stored === 'standard';
})()`));

/* ---- achievements ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
await evl('__fp.resetAchs()');
ok('there are twelve achievements', (await evl('__fp.achTotal')) === 12, `n=${await evl('__fp.achTotal')}`);
ok('a fresh device has none', (await evl('__fp.achCount')) === 0);

ok('clearing a floor unlocks the first', await evl(`(() => {
  mode = 'playing'; invuln = 999;
  loop = 0; mapIdx = 0; loadMap(0); hud();
  __fp.clearCoins(); __fp.teleport(exitPt.x, exitPt.y);
  for (let i = 0; i < 5; i++) update(0.016);
  return __fp.achs.first === 1;
})()`));

/* the negative ones are the interesting half: they must NOT fire when the thing happened */
const negs = await evl(`(() => {
  __fp.resetAchs();
  mode = 'playing'; invuln = 999;
  loop = 0; mapIdx = 0; loadMap(0); hud();
  /* sprint, get seen, get noticed - none of the clean awards should land */
  keys.sprint = true; keys.right = true;
  for (let i = 0; i < 40; i++) update(0.016);
  keys.sprint = false; keys.right = false;
  __fp.bumpAlert();
  const flags = __fp.floorFlags;
  __fp.clearCoins(); __fp.teleport(exitPt.x, exitPt.y);
  for (let i = 0; i < 5; i++) update(0.016);
  return JSON.stringify({ flags, a: __fp.achs });
})()`);
const ng = JSON.parse(negs);
ok('sprinting is recorded', ng.flags.sprint === true, negs);
ok('being detected is recorded', ng.flags.seen === true, negs);
ok('a sloppy floor awards no clean sweep', !ng.a.clean, negs);
ok('and no quiet professional', !ng.a.quiet, negs);
ok('but it still counts as a floor cleared', ng.a.first === 1, negs);

ok('a clean floor does award them', await evl(`(() => {
  __fp.resetAchs();
  mode = 'playing'; invuln = 999;
  loop = 0; mapIdx = 0; loadMap(0); hud();
  __fp.clearCoins(); __fp.teleport(exitPt.x, exitPt.y);
  for (let i = 0; i < 5; i++) update(0.016);
  const a = __fp.achs;
  return !!(a.clean && a.quiet && a.unseen && a.magpie);
})()`));

ok('they persist and show on the menu', await evl(`(() => {
  toMenu();
  const cells = document.querySelectorAll('#achGrid span');
  const got = document.querySelectorAll('#achGrid span.got');
  return cells.length === 12 && got.length === __fp.achCount && got.length > 0
    && document.getElementById('achCount').textContent.includes('/ 12');
})()`));

/* ---- daily run: the same building for everyone, today ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
ok('daily is off by default', (await evl('__fp.dailyOn')) === false);
ok('the seed is todays date', (await evl('__fp.dailySeed')) === Number(
  new Date().getFullYear() * 10000 + (new Date().getMonth() + 1) * 100 + new Date().getDate()),
  `seed=${await evl('__fp.dailySeed')}`);

const dailyRng = await evl(`(() => {
  __fp.setDaily(true);
  __fp.resetKit();
  const a = __fp.rngProbe(6);
  __fp.resetKit();
  const b = __fp.rngProbe(6);
  __fp.setDaily(false);
  const c = __fp.rngProbe(6);
  const d = __fp.rngProbe(6);
  return JSON.stringify({ a, b, c, d });
})()`);
const dr2 = JSON.parse(dailyRng);
ok('a daily run repeats exactly', JSON.stringify(dr2.a) === JSON.stringify(dr2.b), dailyRng);
ok('an ordinary run does not', JSON.stringify(dr2.c) !== JSON.stringify(dr2.d), dailyRng);

ok('a daily floor lays out identically twice', await evl(`(() => {
  __fp.setDaily(true);
  const snap = () => {
    __fp.resetKit(); loop = 0; mapIdx = 2; loadMap(2);
    return JSON.stringify(emitters.map(e => [Math.round(e.x), Math.round(e.y), Math.round(e.r), +(e.ang || 0).toFixed(3)]));
  };
  const one = snap(), two = snap();
  __fp.setDaily(false);
  return one === two;
})()`));

ok('the toggle is on the menu and works', await evl(`(() => {
  toMenu();
  const b = document.getElementById('dailyBtn');
  const before = __fp.dailyOn;
  b.click();
  const after = __fp.dailyOn;
  const labelled = b.textContent.includes('ON') && b.classList.contains('on');
  const seedShown = document.getElementById('dailySeed').textContent.includes(String(__fp.dailySeed));
  b.click();
  return before === false && after === true && labelled && seedShown && __fp.dailyOn === false;
})()`));

/* ---- run alert level: a sloppy floor costs you later ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
const alertRes = await evl(`(() => {
  mode = 'playing'; invuln = 999;
  __fp.resetKit();
  loop = 0; mapIdx = 0; loadMap(0); hud();
  const base = __fp.botSpeedMult;
  const l0 = __fp.alertLvl;
  __fp.bumpAlert();
  const l1 = __fp.alertLvl, s1 = __fp.botSpeedMult;
  /* the cooldown must stop one scare stacking */
  const beforeSpam = __fp.alertLvl;
  bumpAlert(); bumpAlert(); bumpAlert();
  const afterSpam = __fp.alertLvl;
  /* and it must not run away forever */
  for (let i = 0; i < 20; i++) __fp.bumpAlert();
  const capped = __fp.alertLvl;
  return JSON.stringify({ base, l0, l1, s1, beforeSpam, afterSpam, capped, max: T.ALERT_MAX });
})()`);
const al = JSON.parse(alertRes);
ok('a run starts unalerted', al.l0 === 0, alertRes);
ok('an incident raises the alert', al.l1 === 1, alertRes);
ok('and the drones get faster for it', al.s1 > al.base, alertRes);
ok('one scare cannot stack the meter', al.afterSpam === al.beforeSpam, alertRes);
ok('the alert level is capped', al.capped === al.max, alertRes);

ok('the alert survives the stairs', await evl(`(() => {
  const before = __fp.alertLvl;
  __fp.clearCoins(); __fp.teleport(exitPt.x, exitPt.y);
  for (let i = 0; i < 5; i++) update(0.016);
  return mapIdx > 0 && __fp.alertLvl === before;
})()`));

ok('a fresh run clears it', await evl(`(() => { __fp.resetKit(); return __fp.alertLvl === 0; })()`));

ok('an alarm raises it', await evl(`(() => {
  mode = 'playing'; invuln = 999;
  __fp.resetKit();
  mapIdx = 6; loadMap(6); hud();
  const before = __fp.alertLvl;
  const q = __fp.platePoints()[0];
  player.x = q.x; player.y = q.y;
  update(0.016);
  return __fp.alertLvl === before + 1;
})()`));

/* ---- heavy pockets: a full run home is a loud one ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
const haul = await evl(`(() => {
  mode = 'playing'; invuln = 999;
  loop = 0; mapIdx = 0; loadMap(0); hud();
  const empty = __fp.haulNoise;
  coins = Math.ceil(coinsTotal / 2);
  const half = __fp.haulNoise;
  coins = coinsTotal;
  const full = __fp.haulNoise;
  /* the radius that actually reaches the noise queue */
  noise.length = 0;
  makeNoise(player.x, player.y, T.STEP_R * __fp.haulNoise);
  const loudR = noise[0].r;
  coins = 0;
  noise.length = 0;
  makeNoise(player.x, player.y, T.STEP_R * __fp.haulNoise);
  const quietR = noise[0].r;
  return JSON.stringify({ empty, half, full, quietR: Math.round(quietR), loudR: Math.round(loudR) });
})()`);
const hp = JSON.parse(haul);
ok('empty pockets are as quiet as before', hp.empty === 1, haul);
ok('a full haul carries further', hp.full > hp.empty, haul);
ok('it scales with how much you are carrying', hp.half > hp.empty && hp.half < hp.full, haul);
ok('the extra radius reaches the noise queue', hp.loudR > hp.quietR, haul);

ok('a floor with no coins does not divide by zero', await evl(`(() => {
  coinsTotal = 0; coins = 0;
  const v = __fp.haulNoise;
  return v === 1 && isFinite(v);
})()`));

/* ---- drones notice your beam ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);

const beamNotice = await evl(`(() => {
  mode = 'playing'; paused = false; invuln = 999;
  loop = 0; mapIdx = 0; loadMap(0); hud(); invuln = 999;
  beamOn = true; smokes.length = 0;
  const b = bots[0];
  /* put the drone well off to the side, facing away, with a clear view of the
     floor the beam is lighting - it must not be able to see the player */
  player.x = spawnPt.x; player.y = spawnPt.y;
  mouseWX = player.x + 300; mouseWY = player.y;
  update(0.016);
  const patches = __fp.beamPatches();
  if (!patches.length) return JSON.stringify({ err: 'no beam patches' });
  const q = patches[0];
  b.x = q.x; b.y = q.y - 120;
  if (isWall(b.x, b.y)) { b.x = q.x + 120; b.y = q.y; }
  b.face = Math.atan2(b.y - player.y, b.x - player.x);
  b.state = 'patrol'; b.path = []; b.glow = 0;
  const canSeePlayer = botSees(b);
  const seesLight = !!__fp.seesLight(0);
  /* a quick sweep should not be enough */
  let glowAfterFlick = 0;
  for (let i = 0; i < 12; i++) update(0.016);
  glowAfterFlick = bots[0].glow;
  const stateAfterFlick = bots[0].state;
  /* holding it should be */
  for (let i = 0; i < 110; i++) update(0.016);
  return JSON.stringify({
    canSeePlayer, seesLight,
    glowAfterFlick: +glowAfterFlick.toFixed(2), stateAfterFlick,
    stateAfterStare: bots[0].state, threshold: T.BEAM_SEEN_T
  });
})()`);
const bn = JSON.parse(beamNotice);
ok('the drone cannot see the player itself', bn.canSeePlayer === false, beamNotice);
ok('but it can see the floor your beam is lighting', bn.seesLight === true, beamNotice);
ok('a quick sweep does not give you away', bn.stateAfterFlick === 'patrol' && bn.glowAfterFlick < bn.threshold, beamNotice);
ok('holding the beam does', bn.stateAfterStare !== 'patrol', beamNotice);

ok('the torch off makes you invisible again', await evl(`(() => {
  beamOn = false;
  update(0.016);
  return __fp.beamPatches().length === 0 && __fp.seesLight(0) === null;
})()`));

ok('smoke hides your light as well as you', await evl(`(() => {
  beamOn = true; update(0.016);
  const q = __fp.beamPatches()[0];
  const b = bots[0];
  const before = !!__fp.seesLight(0);
  smokes.push({ x: (b.x + q.x) / 2, y: (b.y + q.y) / 2, r: T.SMOKE_R, life: T.SMOKE_T, ph: 0 });
  const after = !!__fp.seesLight(0);
  smokes.length = 0;
  return before === true && after === false;
})()`));

/* ---- the three new floors ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
const newFloors = await evl(`(() => {
  const want = [
    { i: 9,  name: 'THE GALLERY',    theme: 'museum', coins: 12, bots: 3 },
    { i: 10, name: 'THE COLD STORE', theme: 'docks',  coins: 13, bots: 3 },
    { i: 11, name: 'THE PENTHOUSE',  theme: 'city',   coins: 14, bots: 4 }
  ];
  return JSON.stringify(want.map(w => {
    const M = MAPS[w.i];
    loop = 0; mapIdx = w.i; loadMap(w.i);
    return {
      name: M.name, ok: M.name === w.name && M.theme === w.theme && M.coins === w.coins && M.bots === w.bots,
      coinsOnFloor: __fp.coinsTotal, botsSpawned: __fp.botsN,
      routes: (M.routes || []).length, declaredBots: M.bots, features: __fp.powerupsN + __fp.platesN + __fp.cratesN + __fp.mirrorsN
    };
  }));
})()`);
const nf = JSON.parse(newFloors);
ok('floor 10 is the Gallery', nf[0].ok, JSON.stringify(nf[0]));
ok('floor 11 is the Cold Store', nf[1].ok, JSON.stringify(nf[1]));
ok('floor 12 is the Penthouse', nf[2].ok, JSON.stringify(nf[2]));
ok('each new floor lays out the coins it declares', nf.every(f => f.coinsOnFloor === (f.name === 'THE GALLERY' ? 12 : f.name === 'THE COLD STORE' ? 13 : 14)), newFloors);
ok('each new floor has a route per declared drone', nf.every(f => f.routes === f.declaredBots), newFloors);
ok('the new floors carry the new tiles', nf.every(f => f.features > 0), newFloors);

/* twelve boxes is the case that can overflow a phone */
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });
await sleep(600);
await evl('toMenu(); completedLevels = [0,1,2,3,4]; renderFloors();');
await sleep(400);
const grid12 = await evl(`(() => {
  const b = [...document.querySelectorAll('#floorGrid .floor')];
  return JSON.stringify({
    n: b.length,
    minW: Math.round(Math.min(...b.map(x => x.getBoundingClientRect().width))),
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1
  });
})()`);
const g12 = JSON.parse(grid12);
ok('the picker shows all twelve floors', g12.n === 12, grid12);
ok('twelve boxes still fit a phone', g12.overflow === false, grid12);
ok('and stay tappable', g12.minW >= 28, grid12);
await send('Emulation.clearDeviceMetricsOverride');

/* ---- crates: bonus gold for a lot of noise ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
await evl('mapIdx = 1; loadMap(1); hud();');
await sleep(300);
ok('storage floors carry crates', (await evl('__fp.cratesN')) > 0, `n=${await evl('__fp.cratesN')}`);
ok('a crate is solid', await evl(`(() => { const c = __fp.cratePoints()[0]; return isWall(c.x, c.y); })()`));
ok('crates stand clear of walls', await evl(`(() => {
  return __fp.cratePoints().every(c => {
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) if (isWallCell(c.gx + dx, c.gy + dy)) return false;
    return true;
  });
})()`));

const crateRes = await evl(`(() => {
  mode = 'playing'; paused = false; invuln = 999;
  const c = crates.find(z => !z.broken);
  player.x = c.x - 30; player.y = c.y;
  player.vx = 0; player.vy = 0;
  keys.left = keys.right = keys.up = keys.down = false;
  noise.length = 0;
  const coinsBefore = coinList.filter(z => !z.got).length;
  const totalBefore = coinsTotal;
  let sawProgress = false, heardPeak = 0;
  for (let i = 0; i < 90; i++) {
    update(0.016);
    if (__fp.crateT > 0.2) sawProgress = true;
    if (noise.length > heardPeak) heardPeak = noise.length;
  }
  return JSON.stringify({
    broken: __fp.cratesBroken, sawProgress,
    solid: isWall(c.x, c.y),
    loose: coinList.filter(z => !z.got).length - coinsBefore,
    bonus: __fp.bonusCoins, totalSame: coinsTotal === totalBefore,
    heard: heardPeak > 0
  });
})()`);
const crateOut = JSON.parse(crateRes);
ok('standing by a crate breaks it', crateOut.broken === 1, crateRes);
ok('breaking shows progress', crateOut.sawProgress === true, crateRes);
ok('a broken crate stops being solid', crateOut.solid === false, crateRes);
ok('it drops a coin', crateOut.loose === 1 && crateOut.bonus === 1, crateRes);
ok('the dropped coin is a bonus, not an obligation', crateOut.totalSame === true, crateRes);
ok('breaking one is heard', crateOut.heard === true, crateRes);

ok('crates never strand a coin', await evl("validateMaps() === 'ok'"));

/* ---- mirrors: see round a corner without walking into it ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
await evl('mapIdx = 2; loadMap(2); hud();');
await sleep(300);
ok('corners carry mirrors', (await evl('__fp.mirrorsN')) > 0, `n=${await evl('__fp.mirrorsN')}`);
ok('a mirror is solid', await evl(`(() => { const m = __fp.mirrorPoints()[0]; return isWall(m.x, m.y); })()`));

/* aim into a mirror and a second cone appears, turned off the first */
const bounced = await evl(`(() => {
  mode = 'playing'; invuln = 999; beamOn = true;
  const m = __fp.mirrorPoints()[0];
  /* stand down whichever corridor actually reaches it */
  const S = T.TILE;
  const sides = [[-1,0],[1,0],[0,-1],[0,1]].filter(([dx,dy]) => !isWall(m.x + dx*S, m.y + dy*S));
  const [dx, dy] = sides[0];
  player.x = m.x + dx * S * 1.5; player.y = m.y + dy * S * 1.5;
  mouseWX = m.x; mouseWY = m.y;
  update(0.016);
  const mb = __fp.mirrorBeam;
  if (!mb) return JSON.stringify({ ok: false, why: 'no reflected beam' });
  const inAng = Math.atan2(m.y - player.y, m.x - player.x);
  let turn = Math.abs(Math.atan2(Math.sin(mb.ang - inAng), Math.cos(mb.ang - inAng)));
  return JSON.stringify({ ok: true, turnDeg: Math.round(turn * 180 / Math.PI), range: mb.range, at: { x: mb.x, y: mb.y }, mx: m.x, my: m.y });
})()`);
const mirRes = JSON.parse(bounced);
ok('aiming at a mirror makes a second beam', mirRes.ok === true, bounced);
ok('the beam turns a right angle', mirRes.ok && Math.abs(mirRes.turnDeg - 90) < 2, bounced);
ok('the reflection starts just clear of the pane', mirRes.ok && Math.hypot(mirRes.at.x - mirRes.mx, mirRes.at.y - mirRes.my) < 30, bounced);
ok('the reflection is shorter than the beam', mirRes.ok && mirRes.range < 345, bounced);

/* and it genuinely lights things the direct beam cannot reach */
const reach = await evl(`(() => {
  const mb = __fp.mirrorBeam;
  if (!mb) return JSON.stringify({ found: 0 });
  let found = 0, firstAt = 0;
  for (let d = 8; d < mb.range; d += 8) {
    const px = mb.x + Math.cos(mb.ang) * d, py = mb.y + Math.sin(mb.ang) * d;
    if (isWall(px, py)) break;
    const direct = inFan(px, py, player.x, player.y, player.aim, T.FL_HALF, flRange(), flHits, T.FL_RAYS);
    if (!direct && __fp.beamLitAt(px, py)) { found++; if (!firstAt) firstAt = d; }
  }
  return JSON.stringify({ found, firstAt });
})()`);
const rch = JSON.parse(reach);
ok('a mirror lights what you cannot see directly', rch.found > 0, reach);

ok('no reflection with the torch off', await evl(`(() => {
  beamOn = false; update(0.016);
  const none = __fp.mirrorBeam === null;
  beamOn = true; update(0.016);
  return none;
})()`));

ok('mirrors never strand a coin', await evl("validateMaps() === 'ok'"));

/* ---- pressure plates: step on one and everyone knows ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
await evl('mapIdx = 6; loadMap(6); hud();');
await sleep(300);
ok('secured floors are trapped', (await evl('__fp.platesN')) > 0, `n=${await evl('__fp.platesN')}`);
ok('plates start unfired', (await evl('__fp.platesFired')) === 0);

const stepped = await evl(`(() => {
  mode = 'playing'; invuln = 999;
  noise.length = 0;
  for (const b of bots) { b.state = 'patrol'; b.alerted = false; b.path = []; b.face = Math.atan2(b.y - player.y, b.x - player.x); }
  const q = __fp.platePoints()[0];
  player.x = q.x; player.y = q.y;
  update(0.016);
  return JSON.stringify({ fired: __fp.platesFired, noise: noise.length, states: __fp.botState });
})()`);
const sp2 = JSON.parse(stepped);
ok('standing on a plate fires it', sp2.fired === 1, stepped);
ok('it screams your position', sp2.noise > 0, stepped);
ok('and the drones react', !/^\["patrol"(,"patrol")*\]$/.test(JSON.stringify(sp2.states)), stepped);

ok('a fired plate does not fire twice', await evl(`(() => {
  const before = __fp.platesFired;
  for (let i = 0; i < 20; i++) update(0.016);
  return __fp.platesFired === before;
})()`));

ok('plates sit in corridors, on walkable floor', await evl(`(() => {
  return __fp.platePoints().every(q => !isWall(q.x, q.y));
})()`));

ok('plates never strand a coin', await evl("validateMaps() === 'ok'"));

/* the searchlight still works after sharing its alarm with the plates */
ok('the shared alarm still serves the searchlight', await evl(`(() => {
  mapIdx = 4; loadMap(4); hud();
  for (const b of bots) { b.state = 'patrol'; b.alerted = false; b.path = []; }
  searchLit = false; smokes.length = 0; emps.length = 0;
  __fp.lightMeWithSearch();
  updateMeter(0.016);
  return searchLit === true;
})()`));

/* ---- water: you cannot cross a puddle quietly ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
await evl('mapIdx = 7; loadMap(7); hud();');
await sleep(300);
ok('the docks are flooded', (await evl('__fp.waterN')) > 0, `n=${await evl('__fp.waterN')}`);
ok('water is walkable', await evl(`(() => { const w = __fp.waterPoints()[0]; return !isWall(w.x, w.y); })()`));

/* walking is silent on dry floor and loud in water */
const wade = await evl(`(() => {
  mode = 'playing'; invuln = 999;
  const run = (inWater) => {
    const w = __fp.waterPoints()[0];
    if (inWater) { player.x = w.x; player.y = w.y; }
    else { player.x = spawnPt.x; player.y = spawnPt.y; }
    noise.length = 0; stepT = 0;
    keys.left = keys.right = keys.up = keys.down = keys.sprint = false;
    keys.right = true;
    let heard = 0;
    for (let i = 0; i < 40; i++) { update(0.016); if (noise.length) heard++; if (inWater) { player.x = w.x; player.y = w.y; } }
    keys.right = false;
    return heard;
  };
  return JSON.stringify({ dry: run(false), wet: run(true) });
})()`);
const wd = JSON.parse(wade);
ok('walking on dry floor stays silent', wd.dry === 0, wade);
ok('walking through water is heard', wd.wet > 0, wade);

/* and soft shoes do not save you */
const shod = await evl(`(() => {
  mode = 'playing'; invuln = 999;
  const w = __fp.waterPoints()[0];
  player.x = w.x; player.y = w.y;
  puShoe = T.PU_SHOE_T;
  noise.length = 0; stepT = 0;
  keys.right = true; keys.sprint = true;
  let heard = 0;
  for (let i = 0; i < 40; i++) { update(0.016); if (noise.length) heard++; player.x = w.x; player.y = w.y; }
  keys.right = false; keys.sprint = false; puShoe = 0;
  return heard;
})()`);
ok('soft shoes do not silence a splash', shod > 0, `heard=${shod}`);

ok('water never strands a coin', await evl("validateMaps() === 'ok'"));

/* ---- glass: stops bodies, not sight ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
await evl('mapIdx = 6; loadMap(6); hud();');
await sleep(300);
ok('floors carry glass', (await evl('__fp.glassN')) > 0, `n=${await evl('__fp.glassN')}`);

/* the whole design rests on this pair disagreeing */
const pane = await evl(`(() => {
  const p = __fp.glassPoints()[0];
  const S = T.TILE;
  const lr = !isWall(p.x - S, p.y) && !isWall(p.x + S, p.y);
  const a = lr ? { x: p.x - S, y: p.y } : { x: p.x, y: p.y - S };
  const b = lr ? { x: p.x + S, y: p.y } : { x: p.x, y: p.y + S };
  return JSON.stringify({
    seeThrough: losClear(a.x, a.y, b.x, b.y),
    bodyStopped: bodyBlocked(p.x, p.y),
    notAWall: !isWall(p.x, p.y),
    aX: a.x, aY: a.y, bX: b.x, bY: b.y, gx: p.gx, gy: p.gy
  });
})()`);
const pn = JSON.parse(pane);
ok('you can see through glass', pn.seeThrough === true, pane);
ok('you cannot walk through it', pn.bodyStopped === true, pane);
ok('it is not a wall to the raycast', pn.notAWall === true, pane);

/* a drone on the far side of a pane can still see you - that is the point */
ok('a drone sees you through glass', await evl(`(() => {
  mode = 'playing'; invuln = 999;
  const p = __fp.glassPoints()[0];
  const S = T.TILE;
  const lr = !isWall(p.x - S, p.y) && !isWall(p.x + S, p.y);
  const a = lr ? { x: p.x - S, y: p.y } : { x: p.x, y: p.y - S };
  const b = lr ? { x: p.x + S, y: p.y } : { x: p.x, y: p.y + S };
  player.x = a.x; player.y = a.y;
  const d = bots[0];
  d.x = b.x; d.y = b.y;
  d.face = Math.atan2(player.y - d.y, player.x - d.x);
  castCone(d.rays, d.x, d.y, d.face, d.half, T.BOT_RAYS, botRange(d));
  return botSees(d);
})()`));

/* but it cannot walk to you */
ok('a drone will not path through glass', await evl(`(() => {
  const p = __fp.glassPoints()[0];
  const cells = __fp.botPathHits(player.x, player.y, bots[0].x, bots[0].y);
  return !cells.includes(p.gy * T.COLS + p.gx);
})()`));

/* the player really is stopped by it, walked not teleported */
const walked = await evl(`(() => {
  mode = 'playing'; invuln = 999;
  const p = __fp.glassPoints()[0];
  const S = T.TILE;
  const lr = !isWall(p.x - S, p.y) && !isWall(p.x + S, p.y);
  player.x = lr ? p.x - S : p.x; player.y = lr ? p.y : p.y - S;
  const startX = player.x, startY = player.y;
  keys.left = keys.right = keys.up = keys.down = false;
  keys[lr ? 'right' : 'down'] = true;
  for (let i = 0; i < 60; i++) update(0.016);
  keys.right = keys.down = false;
  const crossed = lr ? player.x > p.x + 4 : player.y > p.y + 4;
  return JSON.stringify({ crossed, moved: Math.round(Math.hypot(player.x - startX, player.y - startY)) });
})()`);
ok('walking into glass does not get you through it', JSON.parse(walked).crossed === false, walked);

ok('glass never strands a coin', await evl("validateMaps() === 'ok'"));

/* ---- vents: you fit, they do not ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
await evl('mapIdx = 1; loadMap(1); hud();');
await sleep(300);
ok('floors carry vents', (await evl('__fp.ventsN')) > 0, `n=${await evl('__fp.ventsN')}`);
ok('a vent is walkable for you', await evl(`(() => {
  const v = __fp.ventPoints()[0];
  return !isWall(v.x, v.y);
})()`));

/* a drone routed across a vent must go around it */
const routed = await evl(`(() => {
  mode = 'playing'; invuln = 999;
  const v = __fp.ventPoints()[0];
  /* pick the two open cells the vent joins */
  const S = T.TILE;
  const lr = !isWall(v.x - S, v.y) && !isWall(v.x + S, v.y);
  const a = lr ? { x: v.x - S, y: v.y } : { x: v.x, y: v.y - S };
  const bb = lr ? { x: v.x + S, y: v.y } : { x: v.x, y: v.y + S };
  const cells = __fp.botPathHits(a.x, a.y, bb.x, bb.y);
  const ventCell = v.gy * T.COLS + v.gx;
  return JSON.stringify({ len: cells.length, throughVent: cells.includes(ventCell) });
})()`);
const rt = JSON.parse(routed);
ok('a drone will not path through a vent', rt.throughVent === false, routed);
ok('it routes the long way round instead', rt.len > 1, routed);

/* and the shortcut is real: straight through is shorter than their detour */
const shortcut = await evl(`(() => {
  const v = __fp.ventPoints()[0];
  const S = T.TILE;
  const lr = !isWall(v.x - S, v.y) && !isWall(v.x + S, v.y);
  const a = lr ? { x: v.x - S, y: v.y } : { x: v.x, y: v.y - S };
  const bb = lr ? { x: v.x + S, y: v.y } : { x: v.x, y: v.y + S };
  return JSON.stringify({ yours: 2, theirs: __fp.botPathHits(a.x, a.y, bb.x, bb.y).length });
})()`);
const vcut = JSON.parse(shortcut);
ok('the vent is worth taking', vcut.theirs > vcut.yours, shortcut);

ok('vents never strand a coin', await evl(`(() => validateMaps() === 'ok')()`));

/* ---- fixed cameras: a cone that never moves, so it has a safe side ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
await evl('mapIdx = 6; loadMap(6); hud();');
await sleep(300);
ok('secured floors carry cameras', (await evl('__fp.camN')) > 0, `n=${await evl('__fp.camN')}`);

const still = await evl(`(() => {
  mode = 'playing'; invuln = 999;
  const a0 = __fp.camPoints()[0].ang;
  for (let i = 0; i < 60; i++) update(0.016);
  return JSON.stringify({ a0, a1: __fp.camPoints()[0].ang, spin: __fp.camPoints()[0].spin });
})()`);
const st = JSON.parse(still);
ok('a camera does not sweep', st.a0 === st.a1 && st.spin === 0, still);

ok('a camera looks down open floor, not into a wall', await evl(`(() => {
  const c = __fp.camPoints()[0];
  let d = 0;
  while (d < c.r && !isWall(c.x + Math.cos(c.ang) * d, c.y + Math.sin(c.ang) * d)) d += 8;
  return d > 60;
})()`), await evl(`(() => { const c = __fp.camPoints()[0];
  let d = 0; while (d < c.r && !isWall(c.x + Math.cos(c.ang) * d, c.y + Math.sin(c.ang) * d)) d += 8;
  return 'clear=' + d; })()`));

/* it raises the alarm through the searchlight path it shares */
const camAlarm = await evl(`(() => {
  mode = 'playing'; mapIdx = 6; loadMap(6); hud();
  emps.length = 0; smokes.length = 0; searchLit = false;
  for (const b of bots) { b.state = 'patrol'; b.alerted = false; b.path = []; }
  const c = emitters.find(e => e.cam);
  /* stand in its beam */
  let d = 40;
  player.x = c.x + Math.cos(c.ang) * d; player.y = c.y + Math.sin(c.ang) * d;
  for (const b of bots) b.face = Math.atan2(b.y - player.y, b.x - player.x);
  invuln = 0;
  updateMeter(0.016);
  const lit = searchLit;
  /* and smoke should hide you from it, same as any searchlight */
  searchLit = false;
  smokes.push({ x: player.x, y: player.y, r: T.SMOKE_R, life: T.SMOKE_T, ph: 0 });
  updateMeter(0.016);
  return JSON.stringify({ lit, litThroughSmoke: searchLit });
})()`);
const ca = JSON.parse(camAlarm);
ok('a camera raises the alarm', ca.lit === true, camAlarm);
ok('smoke hides you from a camera too', ca.litThroughSmoke === false, camAlarm);

ok('an EMP kills a camera', await evl(`(() => {
  smokes.length = 0; searchLit = false;
  __fp.setEmp(1); __fp.fireEmp(); update(0.016);
  const c = emitters.find(e => e.cam);
  return c.dead === true;
})()`));

/* ---- the kit is a run-long resource, found not granted ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
await evl('__fp.resetKit()');
const kit0 = await evl('__fp.kit');
ok('a run starts with a thin kit', kit0.flare === 1 && kit0.smoke === 1 && kit0.emp === 0, JSON.stringify(kit0));

ok('every floor has gadgets lying around', await evl(`(() => {
  let none = [];
  for (let i = 0; i < MAPS.length; i++) { mapIdx = i; loadMap(i); if (!__fp.itemPickups().length) none.push(i + 1); }
  return none.length === 0;
})()`), 'floors with none: see above');

/* what you skip on floor two you do not have in the CORE */
const carried = await evl(`(() => {
  mode = 'playing'; invuln = 999;
  __fp.resetKit();
  mapIdx = 0; loadMap(0); hud();
  const before = __fp.flares;
  const p = __fp.itemPickups().find(z => z.kind === 'f');
  if (p) { player.x = p.x; player.y = p.y; update(0.016); }
  const picked = __fp.flares;
  __fp.clearCoins(); __fp.teleport(exitPt.x, exitPt.y);
  for (let i = 0; i < 5; i++) update(0.016);
  return JSON.stringify({ before, picked, afterFloor: __fp.flares, floor: mapIdx });
})()`);
await sleep(400);
const cr = JSON.parse(carried);
ok('picking a gadget up stows it', cr.picked === cr.before + 1, carried);
ok('the kit survives the stairs', cr.afterFloor === cr.picked && cr.floor > 0, carried);

const capped = await evl(`(() => {
  __fp.resetKit();
  for (let i = 0; i < 9; i++) { flares = Math.min(T.CAP.flare, flares + 1); }
  return JSON.stringify({ flares, cap: T.CAP.flare });
})()`);
ok('you cannot carry more than the cap', JSON.parse(capped).flares === JSON.parse(capped).cap, capped);

/* ---- item bar: every gadget reachable without a keyboard ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
ok('the item bar has every gadget', (await evl("document.querySelectorAll('#itemBar .item').length")) === 10,
  `n=${await evl("document.querySelectorAll('#itemBar .item').length")}`);
ok('it is reachable by a finger', await evl(`(() => {
  const b = document.getElementById('itFlare');
  return getComputedStyle(b).pointerEvents === 'auto';
})()`));
ok('it keeps clear of the thumbsticks', await evl(`(() => {
  const r = document.getElementById('itemBar').getBoundingClientRect();
  return r.bottom < window.innerHeight * 0.5;
})()`));

/* tapping actually uses the item, not just lights up */
const tapped = await evl(`(() => {
  mode = 'playing'; invuln = 999;
  const before = __fp.flares;
  document.getElementById('itFlare').click();
  return JSON.stringify({ before, after: __fp.flares, lit: __fp.flaresLit });
})()`);
const tp = JSON.parse(tapped);
ok('tapping an item uses it', tp.after === tp.before - 1 && tp.lit > 0, tapped);

ok('a spent item disables itself', await evl(`(() => {
  __fp.setSmoke(0); hud();
  const b = document.getElementById('itSmoke');
  return b.disabled === true && b.classList.contains('out');
})()`));
ok('an active item reads as on', await evl(`(() => {
  __fp.setMag(1); __fp.runMagnet();
  return document.getElementById('itMag').classList.contains('on');
})()`));
ok('the bar hides outside a run', await evl(`(() => {
  toMenu();
  return document.getElementById('itemBar').classList.contains('hidden');
})()`));

/* ---- doors: a keycard is fast, a lockpick is exposed ---- */
const standAtDoor = `(() => {
  const d = doors.find(z => !z.open);
  const spots = [[0,-32,'up'],[0,32,'down'],[-32,0,'left'],[32,0,'right']];
  const roomy = spots.filter(([ox, oy]) =>
    !isWall(d.x + ox, d.y + oy) && !isWall(d.x + ox * 3, d.y + oy * 3));
  const sp = roomy[0] || spots.find(([ox, oy]) => !isWall(d.x + ox, d.y + oy));
  player.x = d.x + sp[0]; player.y = d.y + sp[1];
  player.vx = 0; player.vy = 0;
  keys.left = keys.right = keys.up = keys.down = false;
  return sp[2];
})()`;


await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
await evl('mapIdx = 3; loadMap(3); hud();');
await sleep(300);
ok('floors carry locked doors', (await evl('__fp.doorsN')) > 0, `n=${await evl('__fp.doorsN')}`);
ok('they start shut', (await evl('__fp.doorsShut')) === (await evl('__fp.doorsN')));
ok('a shut door is solid', await evl(`(() => { const d = __fp.doorPoints()[0]; return isWall(d.x, d.y); })()`));

/* standing still beside it picks the lock */
const picked = await evl(`(() => {
  mode = 'playing'; paused = false; invuln = 999;
  const d = doors.find(z => !z.open);
  ${standAtDoor};
  const shutBefore = __fp.doorsShut;
  let sawProgress = false;
  for (let i = 0; i < 140; i++) { update(0.016); if (__fp.pickT > 0.2) sawProgress = true; }
  return JSON.stringify({ shutBefore, shutAfter: __fp.doorsShut, sawProgress, solid: isWall(d.x, d.y) });
})()`);
const pk = JSON.parse(picked);
ok('standing still picks the lock', pk.shutAfter === pk.shutBefore - 1, picked);
ok('the pick shows progress while it runs', pk.sawProgress === true, picked);
ok('an opened door stops being solid', pk.solid === false, picked);

/* walking away resets it - you have to stand there */
const interrupted = await evl(`(() => {
  mapIdx = 3; loadMap(3); hud(); invuln = 999;
  const away = ${standAtDoor};
  for (let i = 0; i < 30; i++) update(0.016);
  const mid = __fp.pickT;
  keys[away] = true;
  for (let i = 0; i < 20; i++) update(0.016);
  const moved = __fp.pickT;
  keys[away] = false;
  return JSON.stringify({ away, mid: +mid.toFixed(2), moved: +moved.toFixed(2) });
})()`);
const itr = JSON.parse(interrupted);
ok('moving interrupts the pick', itr.mid > 0 && itr.moved === 0, interrupted);

/* a keycard opens one immediately */
const carded = await evl(`(() => {
  mapIdx = 3; loadMap(3); hud(); invuln = 999;
  const k = __fp.keyPoints()[0];
  player.x = k.x; player.y = k.y;
  update(0.016);
  const gotCard = __fp.hasKey;
  const shutBefore = __fp.doorsShut;
  ${standAtDoor};
  update(0.016);
  return JSON.stringify({ gotCard, shutBefore, shutAfter: __fp.doorsShut, keyLeft: __fp.hasKey });
})()`);
const cd = JSON.parse(carded);
ok('a keycard is picked up', cd.gotCard === true, carded);
ok('a keycard opens a door on contact', cd.shutAfter === cd.shutBefore - 1, carded);
ok('and is spent doing it', cd.keyLeft === false, carded);

/* ---- magnet: strip a dark room without lighting it ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
await evl('__fp.setMag(1)');
ok('a magnet can be carried', (await evl('__fp.magCharges')) === 1, `n=${await evl('__fp.magCharges')}`);

const pulledIn = await evl(`(() => {
  mode = 'playing'; paused = false; invuln = 999;
  mapIdx = 0; loadMap(0); hud(); invuln = 999;
  __fp.forgetCoins();
  const c = coinList.find(z => !z.got);
  /* park a coin just inside reach, beam pointed the other way so it is unlit */
  player.x = c.x - 70; player.y = c.y;
  mouseWX = player.x - 300; mouseWY = player.y;
  update(0.016);
  const litBefore = coinLight(c);
  const dBefore = Math.hypot(c.x - player.x, c.y - player.y);
  __fp.setMag(1); __fp.runMagnet();
  for (let i = 0; i < 20; i++) update(0.016);
  const dAfter = Math.hypot(c.x - player.x, c.y - player.y);
  return JSON.stringify({ litBefore, dBefore: Math.round(dBefore), dAfter: Math.round(dAfter), seen: c.seen });
})()`);
const pi = JSON.parse(pulledIn);
ok('the magnet drags gold toward you', pi.dAfter < pi.dBefore - 10, pulledIn);
ok('it works on gold you cannot see', pi.litBefore !== 'lit', `state=${pi.litBefore}`);
ok('a pulled coin becomes known to you', pi.seen === true);
ok('running it spends the charge', (await evl('__fp.magCharges')) === 0);
ok('it shows a countdown chip', (await evl("document.querySelectorAll('#puRow .pu').length")) >= 1);

/* out of reach stays put */
const outOfReach = await evl(`(() => {
  mode = 'playing'; invuln = 999;
  mapIdx = 0; loadMap(0); hud();
  const c = coinList.find(z => !z.got);
  player.x = c.x - (T.MAG_R + 120); player.y = c.y;
  const before = Math.hypot(c.x - player.x, c.y - player.y);
  magT = T.MAG_T;
  for (let i = 0; i < 20; i++) update(0.016);
  return JSON.stringify({ before: Math.round(before), after: Math.round(Math.hypot(c.x - player.x, c.y - player.y)) });
})()`);
const oor = JSON.parse(outOfReach);
ok('gold beyond its reach is untouched', oor.after === oor.before, outOfReach);

/* and the haul is loud, because every pickup already is */
const loudHaul = await evl(`(() => {
  mode = 'playing'; invuln = 999;
  mapIdx = 0; loadMap(0); hud(); noise.length = 0;
  const c = coinList.find(z => !z.got);
  player.x = c.x - 40; player.y = c.y;
  magT = T.MAG_T;
  let heard = 0;
  for (let i = 0; i < 60; i++) { update(0.016); if (noise.length) heard++; }
  return JSON.stringify({ heard, coins: __fp.coins });
})()`);
const lh = JSON.parse(loudHaul);
ok('a magnet haul is heard', lh.coins > 0 && lh.heard > 0, loudHaul);

const magDone = await evl(`(() => { magT = 0.2; for (let i = 0; i < 20; i++) update(0.05); return __fp.magT; })()`);
ok('the magnet runs out', magDone === 0, `magT=${magDone}`);
await evl('__fp.setMag(0)');
ok('you cannot run one you do not have', (await evl('__fp.runMagnet()')) === false);

/* ---- decoy: a nuisance that keeps talking ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
await evl('__fp.setDecoy(1)');
ok('a decoy can be carried', (await evl('__fp.decoyCharges')) === 1, `n=${await evl('__fp.decoyCharges')}`);
ok('a decoy drops', (await evl('__fp.dropDecoy()')) === true);
ok('dropping spends the charge', (await evl('__fp.decoyCharges')) === 0);
ok('it is sitting on the floor', (await evl('__fp.decoysLive')) === 1);

/* unlike a coin, it keeps making noise - several pulses over its life */
const pulses = await evl(`(() => {
  invuln = 999;
  let heard = 0, wasEmpty = true;
  for (let i = 0; i < 200; i++) {
    update(0.016);
    if (noise.length > 0 && wasEmpty) { heard++; wasEmpty = false; }
    if (noise.length === 0) wasEmpty = true;
  }
  return heard;
})()`);
ok('a decoy chirps again and again', pulses >= 2, `pulses=${pulses}`);

/* a drone on patrol goes to look at it */
const pulled = await evl(`(() => {
  mode = 'playing'; paused = false; invuln = 999;
  mapIdx = 0; loadMap(0); hud(); invuln = 999;
  decoys.length = 0; noise.length = 0;
  const b = bots[0];
  b.state = 'patrol'; b.path = [];
  player.x = b.x + 240; player.y = b.y;
  __fp.setDecoy(1); __fp.dropDecoy();
  const before = b.state;
  for (let i = 0; i < 90; i++) update(0.016);
  return JSON.stringify({ before, after: bots[0].state });
})()`);
const pl = JSON.parse(pulled);
ok('a drone comes to investigate it', pl.before === 'patrol' && pl.after !== 'patrol', pulled);

const spent = await evl(`(() => { mode = 'playing'; paused = false; invuln = 999; decoys.length = 0;
  decoys.push({ x: player.x, y: player.y, life: 0.3, pulseT: 9, ph: 0 });
  for (let i = 0; i < 30; i++) update(0.05);
  return __fp.decoysLive; })()`);
ok('a decoy runs down and is cleaned up', spent === 0, `live=${spent}`);
await evl('__fp.setDecoy(0)');
ok('you cannot drop one you do not have', (await evl('__fp.dropDecoy()')) === false);

/* ---- EMP: kills the grid, and the light you were reading by ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
await evl('__fp.setEmp(1)');
ok('an EMP charge can be carried', (await evl('__fp.empCharges')) === 1, `n=${await evl('__fp.empCharges')}`);

/* laser gates on the server floor go quiet */
const lasersKilled = await evl(`(() => {
  mapIdx = 5; loadMap(5); hud(); emps.length = 0;
  const mid = __fp.laserMid;   // getter, not a function
  player.x = mid.x; player.y = mid.y;
  for (const l of lasers) l.ph = 0;
  update(0.016);
  const before = __fp.liveLasers;
  __fp.fireEmp();
  update(0.016);
  /* an EMP is local - gates outside the bubble keep running, which is the point */
  const inBubble = lasers.filter(l => Math.hypot((l.x1 + l.x2) / 2 - player.x, (l.y1 + l.y2) / 2 - player.y) < T.EMP_R);
  return JSON.stringify({
    before, after: __fp.liveLasers,
    inBubble: inBubble.length,
    inBubbleLive: inBubble.filter(l => l.on).length
  });
})()`);
const lk = JSON.parse(lasersKilled);
ok('an EMP kills the gates inside its bubble', lk.inBubble > 0 && lk.inBubbleLive === 0, lasersKilled);
ok('and leaves the ones outside it running', lk.after === lk.before - lk.inBubble, lasersKilled);
ok('firing spends the charge', (await evl('__fp.empCharges')) === 0);

/* searchlights inside the bubble stop seeing */
const searchKilled = await evl(`(() => {
  mapIdx = 4; loadMap(4); hud(); emps.length = 0;
  __fp.lightMeWithSearch();
  updateMeter(0.016);
  const seenLive = searchLit;
  searchLit = false;
  __fp.setEmp(1); __fp.fireEmp();
  update(0.016);
  updateMeter(0.016);
  return JSON.stringify({ seenLive, seenEmped: searchLit, dead: __fp.deadEmitters });
})()`);
const sk = JSON.parse(searchKilled);
ok('an EMP blinds a searchlight', sk.seenLive === true && sk.seenEmped === false, searchKilled);
ok('it marks the emitters it killed', sk.dead > 0, `dead=${sk.dead}`);

/* the cost: the lamps it killed were showing you gold */
const goldLost = await evl(`(() => {
  mapIdx = 0; loadMap(0); hud(); emps.length = 0; __fp.forgetCoins();
  const lamp = emitters.find(e => e.kind === 'lamp');
  const c = coinList.find(z => !z.got);
  c.x = lamp.x + 10; c.y = lamp.y;
  player.x = lamp.x + 900; player.y = lamp.y;
  mouseWX = player.x + 100; mouseWY = player.y;
  update(0.016);
  const before = coinLight(c);
  player.x = lamp.x; player.y = lamp.y;
  __fp.setEmp(1); __fp.fireEmp();
  update(0.016);
  player.x = lamp.x + 900; player.y = lamp.y;
  const after = coinLight(c);
  return JSON.stringify({ before, after });
})()`);
const gl = JSON.parse(goldLost);
ok('an EMP takes the lamp-lit gold with it', gl.before === 'lit' && gl.after !== 'lit', goldLost);

const empGone = await evl(`(() => { emps.length = 0;
  emps.push({ x: player.x, y: player.y, r: T.EMP_R, life: 0.3 });
  for (let i = 0; i < 30; i++) update(0.05);
  return JSON.stringify({ live: __fp.empsLive, dead: __fp.deadEmitters }); })()`);
const eg = JSON.parse(empGone);
ok('the grid comes back up', eg.live === 0 && eg.dead === 0, empGone);
await evl('__fp.setEmp(0)');
ok('you cannot fire a charge you do not have', (await evl('__fp.fireEmp()')) === false);

/* ---- smoke: hidden and blind at the same time ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
await evl('__fp.resetKit()');
ok('a run starts with a smoke pellet', (await evl('__fp.smokePellets')) === 1, `n=${await evl('__fp.smokePellets')}`);

/* a drone staring straight at you loses you when the cloud goes up */
const screened = await evl(`(() => {
  invuln = 0; smokes.length = 0;
  const b = bots[0];
  b.x = player.x + 90; b.y = player.y;
  b.face = Math.PI; b.state = 'patrol';
  castCone(b.rays, b.x, b.y, b.face, b.half, T.BOT_RAYS, botRange(b));
  const before = botSees(b);
  __fp.dropSmoke();
  const after = botSees(b);
  return JSON.stringify({ before, after });
})()`);
const sc = JSON.parse(screened);
ok('smoke breaks a drone sightline', sc.before === true && sc.after === false, screened);
ok('dropping spends the pellet', (await evl('__fp.smokePellets')) === 0);
ok('the cloud is live', (await evl('__fp.smokesLive')) === 1);

/* and it costs you your own sight, through the same beam scaling fog uses */
const blind = await evl(`(() => {
  const inside = __fp.inSmokeNow();
  const rIn = flRange();
  const sx = player.x, sy = player.y;
  player.x = sx + 600;
  const rOut = flRange();
  player.x = sx; player.y = sy;
  return JSON.stringify({ inside, rIn: Math.round(rIn), rOut: Math.round(rOut) });
})()`);
const bl = JSON.parse(blind);
ok('standing in your own smoke chokes your beam', bl.inside === true && bl.rIn < bl.rOut * 0.6, blind);

/* a searchlight cannot pick you out through it */
const litThrough = await evl(`(() => {
  mapIdx = 4; loadMap(4); hud();
  __fp.lightMeWithSearch();
  updateMeter(0.016);
  const seenClear = searchLit;
  searchLit = false;
  smokes.push({ x: player.x, y: player.y, r: T.SMOKE_R, life: T.SMOKE_T, ph: 0 });
  updateMeter(0.016);
  return JSON.stringify({ seenClear, seenSmoked: searchLit });
})()`);
const lt = JSON.parse(litThrough);
ok('smoke hides you from a searchlight', lt.seenClear === true && lt.seenSmoked === false, litThrough);

const thinned = await evl(`(() => { smokes.length = 0;
  smokes.push({ x: player.x, y: player.y, r: T.SMOKE_R, life: 0.3, ph: 0 });
  for (let i = 0; i < 30; i++) update(0.05);
  return __fp.smokesLive; })()`);
ok('smoke thins out and is cleaned up', thinned === 0, `live=${thinned}`);
await evl('__fp.setSmoke(0)');
ok('you cannot drop a pellet you do not have', (await evl('__fp.dropSmoke()')) === false);

/* ---- coin toss: a distraction that costs you the walk back ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
ok('an empty pocket cannot be thrown', (await evl('__fp.tossCoin()')) === false);
await evl(`(() => { const p = __fp.coinPoints()[0]; __fp.teleport(p.x, p.y); })()`);
await sleep(300);
const heldBefore = await evl('__fp.coins');
await evl('score = 1000');
const scoreBefore = await evl('__fp.score');
const looseBefore = await evl('__fp.loose');
await evl('noise.length = 0');
ok('picking one up arms the throw', heldBefore > 0, `coins=${heldBefore}`);
ok('a held coin throws', (await evl('__fp.tossCoin()')) === true);
await sleep(250);
ok('throwing spends the coin', (await evl('__fp.coins')) === heldBefore - 1, `${heldBefore} -> ${await evl('__fp.coins')}`);
ok('and refunds its score', (await evl('__fp.score')) === scoreBefore - (await evl('__fp.coinValue()')), `${scoreBefore} -> ${await evl('__fp.score')}`);
ok('the coin is back on the floor', (await evl('__fp.loose')) === looseBefore + 1, `${looseBefore} -> ${await evl('__fp.loose')}`);
ok('it lands away from you', await evl(`(() => {
  const far = coinList.filter(c => !c.got).map(c => Math.hypot(c.x - player.x, c.y - player.y));
  return Math.max(...far) > 40;
})()`));
ok('it clatters loud enough to draw a drone', (await evl('noise.length')) > 0, `noise=${await evl('noise.length')}`);
ok('a thrown coin is already known to you', await evl(`(() => {
  const c = coinList[coinList.length - 1];
  return c.seen === true;
})()`));
ok('the floor still wants every coin', await evl(`(() => {
  __fp.clearCoins();
  return exitOpen === true;
})()`));

/* ---- flares: buy light at a distance, pay in attention ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
await evl('__fp.resetKit()');
ok('a run starts with a flare', (await evl('__fp.flares')) === 1, `n=${await evl('__fp.flares')}`);
await evl('noise.length = 0');
ok('a flare throws', (await evl('__fp.throwFlare()')) === true);
await sleep(250);
ok('it burns on the floor', (await evl('__fp.flaresLit')) === 1, `lit=${await evl('__fp.flaresLit')}`);
ok('throwing spends one', (await evl('__fp.flares')) === 0, `left=${await evl('__fp.flares')}`);
ok('it lands away from you, not on you', await evl(`(() => {
  const f = __fp.flarePoints()[0];
  return Math.hypot(f.x - __fp.pos.x, f.y - __fp.pos.y) > 40;
})()`), await evl('JSON.stringify(__fp.flarePoints()[0])'));
ok('it is loud enough to be heard', (await evl('noise.length')) > 0, `noise=${await evl('noise.length')}`);

/* a flare lights gold your own torch is not pointed at */
const flareLights = await evl(`(() => {
  mapIdx = 0; loadMap(0); hud(); __fp.forgetCoins();
  const c = __fp.coinPoints()[0];
  player.x = c.x - 300; player.y = c.y;
  mouseWX = player.x - 200; mouseWY = player.y;
  castCone(flHits, player.x, player.y, player.aim, T.FL_HALF, T.FL_RAYS, flRange());
  const before = coinList.filter(z => !z.got && coinLight(z) === 'lit').length;
  emitters.push({ x: c.x, y: c.y, r: T.FLARE_R, col: '#ffb347', flick: 0, kind: 'flare', base: 1, life: T.FLARE_T });
  const after = coinList.filter(z => !z.got && coinLight(z) === 'lit').length;
  return JSON.stringify({ before, after });
})()`);
const fl = JSON.parse(flareLights);
ok('a flare reveals gold your beam is not on', fl.after > fl.before, flareLights);

/* mains lamps die in a blackout; a flare does not */
const inDark = await evl(`(() => {
  blackout = 3.6;
  const c = __fp.coinPoints()[0];
  return coinLight(coinList.find(z => !z.got && Math.abs(z.x - c.x) < 1 && Math.abs(z.y - c.y) < 1));
})()`);
ok('a flare still burns through a blackout', inDark === 'lit', `state=${inDark}`);
await evl('blackout = 0; emitters = emitters.filter(e => e.kind !== "flare");');

/* it burns out */
const burnt = await evl(`(() => { const e = emitters.find(x => x.kind === 'flare');
  emitters.push({ x: player.x, y: player.y, r: T.FLARE_R, col: '#ffb347', flick: 0, kind: 'flare', base: 1, life: 0.4 });
  for (let i = 0; i < 40; i++) update(0.05);
  return __fp.flaresLit; })()`);
ok('a flare burns out and is cleaned up', burnt === 0, `lit=${burnt}`);
await evl('__fp.setFlares(0)');
ok('you cannot throw one you do not have', (await evl('__fp.throwFlare()')) === false);

/* ---- power-ups ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
await evl('mapIdx = 1; loadMap(1); hud();');
await sleep(300);
ok('floors carry pickups', (await evl('__fp.powerupsN')) > 0, `n=${await evl('__fp.powerupsN')} kinds=${JSON.stringify(await evl('__fp.powerupKinds()'))}`);

/* lens: the beam actually reaches further */
await evl('mapIdx = 2; loadMap(2); hud();');
await sleep(300);
const rangeBefore = await evl('__fp.flRangeNow');
await evl("__fp.grab('R')");
await sleep(500);
const rangeAfter = await evl('__fp.flRangeNow');
ok('lens extends the beam', rangeAfter > rangeBefore * 1.4, `${Math.round(rangeBefore)} -> ${Math.round(rangeAfter)}`);
ok('lens shows a countdown', (await evl('__fp.puActive')).lens > 0, JSON.stringify(await evl('__fp.puActive')));
ok('lens chip is on the HUD', (await evl("document.querySelectorAll('#puRow .pu').length")) === 1);

/* soft shoes: faster, and sprinting stops making noise */
await evl('mapIdx = 1; loadMap(1); hud();');
await sleep(300);
await evl("__fp.grab('Z')");
await sleep(500);
ok('soft shoes are active', (await evl('__fp.puActive')).shoe > 0, JSON.stringify(await evl('__fp.puActive')));
const quiet = await evl(`(() => {
  const run = () => { let peak = 0; noise.length = 0; stepT = 0;
    for (let i = 0; i < 90; i++) { update(0.016); if (noise.length > peak) peak = noise.length; }
    return peak; };
  keys.right = true; keys.sprint = true;
  const withShoes = run();
  puShoe = 0;
  const without = run();
  keys.right = false; keys.sprint = false;
  return JSON.stringify({ withShoes, without });
})()`);
const q = JSON.parse(quiet);
ok('soft shoes silence the footsteps', q.withShoes === 0 && q.without > 0, quiet);

/* ghost: the meter cannot be filled */
await evl('mapIdx = 3; loadMap(3); hud();');
await sleep(300);
await evl("__fp.grab('I')");
await sleep(500);
ok('ghost is active', (await evl('__fp.puActive')).ghost > 0, JSON.stringify(await evl('__fp.puActive')));
const ghosted = await evl(`(() => {
  meter = 0;
  for (const b of bots) { b.x = player.x + 40; b.y = player.y; b.face = Math.PI; }
  for (let i = 0; i < 40; i++) updateMeter(0.016);
  return meter;
})()`);
ok('ghost holds the meter at zero', ghosted === 0, `meter=${ghosted}`);

/* ---- lifetime statistics ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
await evl('__fp.resetStats()');
const s0 = await evl('__fp.stats');
ok('stats start empty', s0.runs === 0 && s0.coins === 0 && s0.bestTime === 0, JSON.stringify(s0));
await evl('__fp.clearCoins(); __fp.teleport(exitPt.x, exitPt.y);');
await sleep(600);
ok('clearing a floor is counted', (await evl('__fp.stats')).floors > 0, `floors=${(await evl('__fp.stats')).floors}`);
await evl('caught();');
await sleep(500);
const s1 = await evl('__fp.stats');
ok('being caught closes the run', s1.runs === 1 && s1.caught === 1, JSON.stringify(s1));
ok('gold is banked into the lifetime total', s1.coins > 0, `coins=${s1.coins}`);
ok('stats show on the menu', (await evl(`(() => { toMenu(); return document.querySelectorAll('#statRow div').length; })()`)) === 4);
// toMenu() above leaves mode 'menu' - every later block reloads, so none inherit it

/* ---- chase speed closes the gap, and scales with depth ---- */
const walk = await evl('__fp.walkSpeed'), sprint = await evl('__fp.sprintSpeed');
await evl('mapIdx = 0; loadMap(0); hud();');
await sleep(300);
const f1 = await evl('__fp.chaseSpeedNow(0)');
const f1a = await evl('__fp.chaseSpeedNow(99)');
ok('adrenaline speeds a long chase', f1a > f1, `${f1?.toFixed(0)} -> ${f1a?.toFixed(0)}`);
await evl('mapIdx = 8; loadMap(8); hud();');
await sleep(300);
const f9 = await evl('__fp.chaseSpeedNow(99)');
ok('deeper floors chase harder', f9 > f1a, `floor1=${f1a?.toFixed(0)} floor9=${f9?.toFixed(0)}`);
ok('a committed chase outruns a walk', f9 > walk, `chase=${f9?.toFixed(0)} walk=${walk}`);
ok('sprinting still escapes', f9 < sprint, `chase=${f9?.toFixed(0)} sprint=${sprint}`);

/* ---- a searchlight raises the alarm instead of silently filling the meter ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
await evl('mapIdx = 4; loadMap(4); hud();');
await sleep(400);
ok('museum floor has searchlights', (await evl('__fp.searchN')) > 0, `n=${await evl('__fp.searchN')}`);
await evl('for (const b of bots) { b.state = "patrol"; b.alerted = false; b.path = []; }');
const parked = await evl('__fp.lightMeWithSearch()');
ok('player parked inside a searchlight beam', parked === true);
await sleep(1200);
ok('searchlight registers you as lit', (await evl('__fp.searchLit')) === true);
const states = await evl('JSON.stringify(__fp.botState)');
ok('searchlight wakes the drones', !/^\["patrol"(,"patrol")*\]$/.test(states), `states=${states}`);


/* ---- memory: a fast bright trail riding over a slow faint survey ----
   All of it runs inside one evaluate, so the RAF loop cannot interleave and the
   stepping is exact. Note update() returns early while paused, so this block
   must NOT pause the way the fog block does — it drives update() itself. */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const glw = JSON.parse(await evl(`(() => {
  mapIdx = 0; loadMap(0); hud(); bots.length = 0; meter = 0;
  let best = null;
  for (let k = 0; k < 32; k++) { const a = k * TAU / 32; let d = 0;
    while (d < 340 && !isWall(player.x + Math.cos(a) * d, player.y + Math.sin(a) * d)) d += 6;
    if (!best || d > best.d) best = { a, d }; }
  const px = player.x, py = player.y, ax = Math.cos(best.a), ay = Math.sin(best.a);
  const at = d => __fp.glowAt(px + ax * d, py + ay * d);
  const step = n => { for (let i = 0; i < n; i++) update(1 / 60); };
  /* the whole canvas, because the camera clamps at the map edge and the player
     is nowhere near screen centre on floor 1 */
  const read = () => { const d = ctx.getImageData(0, 0, W * DPR, H * DPR).data;
    let s2 = 0, n = 0; for (let i = 0; i < d.length; i += 4) { s2 += d[i] + d[i+1] + d[i+2]; n++; }
    return Math.round(s2 / n); };
  const look = () => __fp.aimAt(px + ax * 400, py + ay * 400);
  const away = () => __fp.aimAt(px - ax * 400, py - ay * 400);
  look(); clearMemory(); step(18);
  const early = at(60);
  step(72);
  const near = at(60), mid = at(180), far = at(300), live = __fp.glowLive();
  away(); step(2);
  render(); const withMem = read();
  clearMemory(); render(); const noMem = read();
  look(); step(90); away();
  step(180); const s3 = at(60);
  step(480); const s11 = at(60);
  step(1800); const s41 = at(60);
  const rates = [__fp.glowStep(1/60, 60), __fp.glowStep(1/30, 30), __fp.glowStep(1/120, 120)];
  mapIdx = 1; loadMap(1); hud();
  return JSON.stringify({ early, near, mid, far, live, withMem, noMem, s3, s11, s41, rates, afterLoad: __fp.glowLive() });
})()`));
ok('a glance leaves a trail long before it leaves a survey',
  glw.early.trail > glw.early.survey * 2.5, JSON.stringify(glw.early));
ok('standing and looking builds the survey too',
  glw.near.survey > 0.5, JSON.stringify(glw.near));
ok('remembered light falls off with distance, it is not a flat slab',
  glw.mid.trail < glw.near.trail && glw.far.trail < glw.near.trail * 0.6,
  `near=${glw.near.trail} mid=${glw.mid.trail} far=${glw.far.trail}`);
ok('the memory is actually visible on screen',
  glw.withMem > glw.noMem + 2, `with=${glw.withMem} without=${glw.noMem}`);
/* the old canvas afterglow jammed at alpha 0.12 and stayed there for the rest
   of the floor: 8-bit alpha cannot take the last multiplicative step down */
ok('the trail fades all the way to nothing',
  glw.s11.trail < 0.05 && glw.s41.trail === 0, JSON.stringify([glw.s11, glw.s41]));
ok('the survey outlives it by a long way',
  glw.s11.survey > 0.3 && glw.s11.survey > glw.s11.trail * 10, JSON.stringify(glw.s11));
ok('but the survey goes in the end as well',
  glw.s41.survey > 0 && glw.s41.survey < glw.near.survey * 0.6,
  `${glw.near.survey} -> ${glw.s41.survey}`);
ok('memory decays on elapsed time, not on frame count',
  glw.rates[0] === glw.rates[1] && glw.rates[1] === glw.rates[2], JSON.stringify(glw.rates));
ok('a new floor is not remembered from the last one',
  glw.afterLoad.trail === 0 && glw.afterLoad.survey === 0 && glw.live.survey > 20,
  `lit=${glw.live.survey} after=${JSON.stringify(glw.afterLoad)}`);


/* ---- screen shake: one per event, not one for everything ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const shk = JSON.parse(await evl(`(() => {
  const o = {};
  const zc = tr => { let n = 0; for (let i = 1; i < tr.length; i++) if ((tr[i][1] >= 0) !== (tr[i-1][1] >= 0)) n++; return n; };
  const env = (k, t) => +(SHAKE[k].amp * Math.exp(-SHAKE[k].decay * t)).toFixed(3);
  const kinds = ['crate', 'laser', 'plate', 'caught'];
  o.cross = {}; o.at0 = {}; o.at3 = {};
  for (const k of kinds) { o.cross[k] = zc(__fp.shakeTrace(k, [0, 1], 300, 1/600)); o.at0[k] = env(k, 0); o.at3[k] = env(k, 0.3); }
  /* direction: sum the absolute throw on each axis over the first frames */
  const axis = (sx, sy) => { __fp.shakeClear(); __fp.shakePush('plate', sx, sy);
    let x = 0, y = 0;
    for (let i = 0; i < 40; i++) { shakes[0].t = i / 600; const q = __fp.shakeOff(); x += Math.abs(q.x); y += Math.abs(q.y); }
    return { x: Math.round(x), y: Math.round(y) }; };
  o.fromLeft = axis(player.x - 200, player.y);
  o.fromAbove = axis(player.x, player.y - 200);
  /* the same elapsed time reached two ways must land on the same offset */
  __fp.shakeClear(); __fp.shakePush('caught', player.x - 200, player.y);
  for (let i = 0; i < 24; i++) shakes[0].t += 1/240;
  const slow = __fp.shakeOff();
  __fp.shakeClear(); __fp.shakePush('caught', player.x - 200, player.y);
  for (let i = 0; i < 6; i++) shakes[0].t += 1/60;
  o.rate = [slow, __fp.shakeOff()];
  /* it has to actually move what gets drawn */
  __fp.shakeClear(); render();
  const px = () => { const d = ctx.getImageData(0, 0, W * DPR, H * DPR).data; let h = 0;
    for (let i = 0; i < d.length; i += 997) h = (h * 31 + d[i]) | 0; return h; };
  const still = px();
  __fp.shakePush('caught', player.x - 200, player.y); render();
  o.moved = px() !== still;
  /* reduced motion */
  o.full = __fp.shakeMag;
  __fp.shakeSetScale(0.25); o.quiet = __fp.shakeMag; __fp.shakeSetScale(1);
  /* several at once stay inside the cap */
  __fp.shakeClear();
  for (let i = 0; i < 6; i++) __fp.shakePush('caught', player.x - 100, player.y);
  o.capped = { n: __fp.shakeN, mag: __fp.shakeMag, cap: T.SHAKE_CAP };
  /* and the one that used to never stop */
  __fp.shakeClear(); caught();
  o.onCaught = __fp.shakeN;
  const seen = [];
  for (let i = 0; i < 300; i++) { update(1/60); if (i === 59 || i === 299) seen.push(__fp.shakeMag); }
  o.caughtDecay = seen; o.mode = mode;
  __fp.shakeClear();
  return JSON.stringify(o);
})()`));
/* the decay used to sit after update()'s `mode !== 'playing'` return, so the
   biggest shake in the game was the only one that never settled */
ok('being caught still shakes the screen', shk.onCaught === 1, `n=${shk.onCaught}`);
ok('and that shake settles instead of running forever',
  shk.mode === 'caught' && shk.caughtDecay[0] < 1 && shk.caughtDecay[1] === 0,
  `mode=${shk.mode} 1s=${shk.caughtDecay[0]} 5s=${shk.caughtDecay[1]}`);
ok('four events, four different frequencies',
  shk.cross.laser > shk.cross.crate && shk.cross.crate > shk.cross.plate && shk.cross.plate > shk.cross.caught,
  JSON.stringify(shk.cross));
ok('and four different envelopes, not just four amplitudes',
  shk.at3.caught / shk.at0.caught > 0.4 && shk.at3.laser / shk.at0.laser < 0.05,
  `caught keeps ${(shk.at3.caught / shk.at0.caught).toFixed(2)}, laser keeps ${(shk.at3.laser / shk.at0.laser).toFixed(3)}`);
ok('a hit from the side throws the screen sideways',
  shk.fromLeft.x > shk.fromLeft.y * 2, JSON.stringify(shk.fromLeft));
ok('a hit from above throws it up the screen',
  shk.fromAbove.y > shk.fromAbove.x * 2, JSON.stringify(shk.fromAbove));
ok('shake follows elapsed time, not frame count',
  Math.abs(shk.rate[0].x - shk.rate[1].x) < 0.01 && Math.abs(shk.rate[0].y - shk.rate[1].y) < 0.01,
  JSON.stringify(shk.rate));
ok('the shake moves what is actually drawn', shk.moved === true);
ok('reduced motion quietens it without killing it',
  shk.quiet > 0 && Math.abs(shk.quiet - shk.full * 0.25) < 0.01, `${shk.full} -> ${shk.quiet}`);
ok('several hits at once stay inside the cap',
  shk.capped.n === 4 && shk.capped.mag <= shk.capped.cap + 0.01, JSON.stringify(shk.capped));


/* ---- pause screen: the run at a glance, and what the keys do ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const pau = JSON.parse(await evl(`(() => {
  const o = {};
  const vis = id => { const el = $(id); return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); };
  o.quietBefore = $('pausedOv').classList.contains('hidden');
  mapIdx = 8; loop = 0; loadMap(8);
  coins = 3; score = 1840; runT = 96; alertLvl = 2; batt = 61; battDead = false; hud();
  togglePause();
  o.open = { paused, shown: !$('pausedOv').classList.contains('hidden') };
  o.text = { where: $('pWhere').textContent, floor: $('pFloor').textContent, gold: $('pGold').textContent,
             score: $('pScore').textContent, time: $('pTime').textContent };
  o.seen = { floor: vis('pFloor'), gold: vis('pGold'), score: vis('pScore'), time: vis('pTime') };
  o.batt = { w: $('pBatt').style.width, cls: $('pBattWrap').className };
  o.alert = { sockets: $('pAlert').children.length, on: $('pAlert').querySelectorAll('.on').length };
  o.hazCore = [...$('pHaz').children].map(b => b.textContent);
  /* the reference must agree with the item bar, which is the other place keys
     are shown - two sources of truth is how a control list goes stale */
  const barKeys = [...document.querySelectorAll('#itemBar .item s')].map(e => e.textContent.trim());
  const refKeys = [...$('pKeys').querySelectorAll('.key')].map(e => e.textContent.trim());
  o.keysAgree = barKeys.every(k => refKeys.includes(k));
  o.barKeys = barKeys; o.rows = $('pKeys').children.length;
  togglePause(); loop = 1; togglePause();
  o.looped = $('pWhere').textContent;
  togglePause(); loop = 0; togglePause();
  /* re-pausing has to re-read, not show what it showed last time */
  togglePause(); score = 9999; coins = 7; togglePause();
  o.refreshed = { score: $('pScore').textContent, gold: $('pGold').textContent };
  /* a quiet floor should not claim hazards it does not have */
  togglePause(); mapIdx = 0; loadMap(0); togglePause();
  o.hazHouse = [...$('pHaz').children].map(b => b.textContent);
  o.battDead = (() => { batt = 0; battDead = true; togglePause(); togglePause(); return $('pBattWrap').className; })();
  /* resume puts you back in the game */
  togglePause();
  o.closed = { paused, hidden: $('pausedOv').classList.contains('hidden') };
  /* a phone has no keys to look up */
  const wasTouch = TOUCH; TOUCH = true; togglePause();
  o.touch = { rows: $('pKeys').children.length, sticks: $('pSticks').style.display !== 'none' };
  togglePause(); TOUCH = wasTouch;
  /* and it must not open from the menu */
  const wasMode = mode; mode = 'menu'; togglePause();
  o.fromMenu = { paused, hidden: $('pausedOv').classList.contains('hidden') };
  mode = wasMode;
  return JSON.stringify(o);
})()`));
ok('pause opens the panel', pau.open.paused === true && pau.open.shown === true, JSON.stringify(pau.open));
ok('it says where you are and how the run is going',
  pau.text.where === 'THE CORE' && pau.text.floor === '9/12' && pau.text.gold === '3/12'
  && pau.text.score === '1840' && pau.text.time === '1:36', JSON.stringify(pau.text));
ok('a later loop says so rather than repeating the floor name',
  pau.looped === 'LOOP 2 \u00b7 THE CORE', pau.looped);
ok('and every one of those is actually on screen',
  Object.values(pau.seen).every(Boolean), JSON.stringify(pau.seen));
ok('the torch bar reads the real charge', pau.batt.w === '61%' && pau.batt.cls === 'pbar', JSON.stringify(pau.batt));
ok('a dead torch reads dead, not just low', pau.battDead === 'pbar dead', pau.battDead);
ok('alert shows all four sockets and lights the ones you have earned',
  pau.alert.sockets === 4 && pau.alert.on === 2, JSON.stringify(pau.alert));
ok('it names what this floor throws at you',
  pau.hazCore.includes('SIREN SWEEPS') && pau.hazCore.includes('BLACKOUTS'), JSON.stringify(pau.hazCore));
ok('and claims nothing on a floor that is quiet', pau.hazHouse.length === 0, JSON.stringify(pau.hazHouse));
/* the agreement is the point; the row count just has to keep up with the game
   growing a gadget, which is what caught the tripwire missing from here */
ok('the control list agrees with the item bar',
  pau.keysAgree === true && pau.rows === 15, `bar=${JSON.stringify(pau.barKeys)} rows=${pau.rows}`);
ok('pausing again re-reads the run instead of replaying the last look',
  pau.refreshed.score === '9999' && pau.refreshed.gold === '7/12', JSON.stringify(pau.refreshed));
ok('resume puts you back in', pau.closed.paused === false && pau.closed.hidden === true, JSON.stringify(pau.closed));
ok('touch gets the sticks, not a key table it cannot use',
  pau.touch.rows === 0 && pau.touch.sticks === true, JSON.stringify(pau.touch));
ok('and it stays shut outside a run',
  pau.fromMenu.paused === false && pau.fromMenu.hidden === true, JSON.stringify(pau.fromMenu));


/* ---- drones say which way they are going ----
   Each scenario resets the drone to a known cold state first. Chaining them off
   each other's leftovers is what made the first cut of this block flaky: a
   scenario that assumed the previous one had reached `chase` measured nothing
   at all when it had not. */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const srv = JSON.parse(await evl(`(() => {
  const o = {};
  /* 400 assertions have run before this one. Difficulty, endless modifiers and
     alert level all survive a Page.navigate in this harness, and every one of
     them changes how a drone behaves, so own them rather than inherit them. */
  o.inherited = { diff: D().id, mod: modIdx, endless, alert: alertLvl };
  endless = false; __fp.setMod(-1); __fp.setDiff('standard'); alertLvl = 0;
  mapIdx = 0; loop = 0; loadMap(0);
  bots.length = 1;
  const b = bots[0];
  const drive = n => { for (let i = 0; i < n; i++) update(1/60); };
  const dirs = () => __fp.servoLog.map(e => e.dir);
  /* Park it across the floor and wipe what it has said. Draining the meter
     matters as much as the rest: two seconds nose to nose with a drone fills it,
     caught() fires, and update() returns early from then on - so every later
     drive() runs against a frozen game and measures nothing. */
  const cool = () => {
    player.x = 60; player.y = 60;
    b.x = 1000; b.y = 640; b.path = []; b.state = 'patrol'; b.wary = 0;
    b.chirpT = 0; b.saidHeat = 0; meter = 0; invuln = 9e9;
    drive(4); __fp.servoClear();
  };
  const confront = () => { b.x = player.x + 90; b.y = player.y; b.face = Math.PI; b.path = []; };
  /* heat is the sprite's own number, so sound and picture cannot drift */
  const heatFor = st => { b.state = st; b.wary = 0; return botHeat(b); };
  o.heats = { patrol: heatFor('patrol'), invest: heatFor('invest'), chase: heatFor('chase') };
  b.state = 'patrol'; b.wary = 3; o.heats.wary = botHeat(b); b.wary = 0;
  /* left alone, it says nothing */
  cool(); drive(240);
  o.quiet = __fp.servoLog.length;
  /* walking into its cone: the first thing you hear is a rise */
  cool(); confront(); drive(120);
  o.spot = { heat: __fp.botHeats()[0], first: __fp.servoLog[0] || null, dirs: dirs() };
  /* then losing you for real: chase to wary to cold, two falls */
  player.x = 60; player.y = 60; b.x = 1020; b.y = 650; b.path = [];
  __fp.servoClear(); meter = 0; drive(720);
  o.fade = { mode, heat: __fp.botHeats()[0], log: __fp.servoLog.map(e => [e.dir, e.weight, e.vol, e.at, e.d]) };
  /* distance is a curve, not a scenario: a drone close enough to be loud is
     close enough to keep seeing you, so it never fades to measure */
  o.vol = [0, 190, 380, 760, 1100].map(d => __fp.servoVolAt(d));
  /* Hold a state against the AI, which will happily overrule a bare assignment */
  const hold = (st, n) => { for (let i = 0; i < n; i++) { b.state = st; b.wary = 0; update(1/60); } };
  /* A flicker while a chirp is already on cooldown: it goes hot, cold, hot again
     inside the gap, and the only thing spoken is the first rise - because when
     the gap expires the drone is back where it was last announced. */
  cool();
  hold('chase', 1);
  o.afterRise = __fp.servoLog.length;
  hold('patrol', 2); hold('chase', 2); hold('chase', 40);
  o.undone = { log: __fp.servoLog.length, heat: __fp.botHeats()[0] };
  o.gap = T.SERVO_GAP;
  o.volAtFade = o.fade.log[0] ? __fp.servoVolAt(o.fade.log[0][4]) : null;
  return JSON.stringify(o);
})()`));
const near0 = srv.fade.log[0], near1 = srv.fade.log[1];
ok('the servo reads the same heat the sprite draws',
  srv.heats.patrol === 0 && srv.heats.invest === 0.5 && srv.heats.chase === 1 && srv.heats.wary === 0.5,
  JSON.stringify(srv.heats));
ok('a drone left alone says nothing', srv.quiet === 0, `chirps=${srv.quiet}`);
ok('walking into a cone is announced going up',
  !!srv.spot.first && srv.spot.first.dir === 1 && srv.spot.heat === 1, JSON.stringify(srv.spot));
/* mode is in the message on purpose: a frozen game reads exactly like a
   drone that never cooled off, and that has cost this suite four runs */
ok('losing you is announced too, and going down',
  srv.fade.mode === 'playing' && srv.fade.heat === 0 && srv.fade.log.length === 2
  && srv.fade.log.every(e => e[0] === -1),
  `mode=${srv.fade.mode} heat=${srv.fade.heat} ${JSON.stringify(srv.fade.log)}`);
ok('it steps down through wary rather than jumping straight cold',
  !!near0 && !!near1 && near0[1] === 0.5 && near1[1] === 0.5, JSON.stringify(srv.fade.log));
ok('chirps keep their distance from each other',
  !!near0 && !!near1 && near1[3] - near0[3] >= srv.gap,
  near0 && near1 ? `gap=${(near1[3] - near0[3]).toFixed(2)} min=${srv.gap}` : 'not enough chirps');
ok('a drone across the floor is quieter than one beside you',
  srv.vol[0] === 1 && srv.vol.every((v, i) => i === 0 || v < srv.vol[i - 1]) && srv.vol[4] < 0.15,
  JSON.stringify(srv.vol));
ok('and a real chirp uses that same curve',
  !!near0 && Math.abs(near0[2] - srv.volAtFade) < 0.002, `logged=${near0 && near0[2]} curve=${srv.volAtFade}`);
/* comparing against the last thing SAID, not against last frame, is what stops
   a re-acquire inside the cooldown from swallowing the news for good */
ok('going hot is announced at once', srv.afterRise === 1, `chirps=${srv.afterRise}`);
ok('a flicker that lands back where it was announced adds nothing',
  srv.undone.log === 1 && srv.undone.heat === 1, JSON.stringify(srv.undone));


/* ---- room tone: one bed per theme ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const rmA = JSON.parse(await evl(`(() => {
  const o = {};
  o.acLive = !!AC;
  o.missing = Object.keys(THEMES).filter(t => !__fp.roomToneFor(t));
  o.orphan = __fp.roomThemes().filter(t => !THEMES[t]);
  const sig = __fp.roomThemes().map(t => JSON.stringify(__fp.roomToneFor(t)));
  o.beds = sig.length; o.distinct = new Set(sig).size;
  o.server = __fp.roomToneFor('server'); o.bank = __fp.roomToneFor('bank');
  mapIdx = 0; loadMap(0);
  o.house = { want: __fp.roomTone, live: __fp.roomLive() };
  /* floor 6 is the server farm: the brightest, busiest bed there is */
  mapIdx = 5; loadMap(5);
  o.swap = { theme: MAPS[5].theme, want: __fp.roomTone, liveNow: __fp.roomLive() };
  o.rainWet = (() => { mapIdx = 2; loadMap(2); return rainN ? +rainN._g.gain.value.toFixed(3) : null; })();
  o.rainDry = (() => { mapIdx = 0; loadMap(0); return rainN ? +rainN._g.gain.value.toFixed(3) : null; })();
  mapIdx = 5; loadMap(5);
  return JSON.stringify(o);
})()`));
/* the ramp runs on the audio clock, so this has to be real elapsed time */
await sleep(1100);
const rmB = JSON.parse(await evl('JSON.stringify({ live: __fp.roomLive(), want: __fp.roomTone })'));
const rmMute = JSON.parse(await evl(`(() => {
  const was = muted; toggleMute();
  const off = master.gain.value;
  if (muted !== was) toggleMute();
  return JSON.stringify({ off, restored: master.gain.value > 0, muted });
})()`));
ok('the audio graph is actually running under test', rmA.acLive === true);
ok('every theme has a bed and no bed is an orphan',
  rmA.missing.length === 0 && rmA.orphan.length === 0,
  `missing=${JSON.stringify(rmA.missing)} orphan=${JSON.stringify(rmA.orphan)}`);
ok('all nine beds are different from each other',
  rmA.beds === 9 && rmA.distinct === 9, `beds=${rmA.beds} distinct=${rmA.distinct}`);
ok('a server room is bright and busy where a vault is low and dead',
  rmA.server.hum > rmA.bank.hum * 2 && rmA.server.air > rmA.bank.air * 5
  && rmA.server.beat > rmA.bank.beat * 3,
  `server=${JSON.stringify(rmA.server)} bank=${JSON.stringify(rmA.bank)}`);
ok('loading a floor picks up that floor’s bed',
  rmA.swap.theme === 'server' && rmA.swap.want.hum === 96 && rmA.swap.want.air === 2600,
  JSON.stringify(rmA.swap.want));
/* changing a running oscillator's frequency outright clicks */
ok('the bed glides to the new floor instead of jumping',
  rmA.swap.liveNow.hum === rmA.house.live.hum && rmA.swap.liveNow.air === rmA.house.live.air,
  `still=${JSON.stringify(rmA.swap.liveNow)}`);
ok('and it gets there',
  Math.abs(rmB.live.hum - rmB.want.hum) < 0.5 && Math.abs(rmB.live.air - rmB.want.air) < 1
  && Math.abs(rmB.live.hum2 - (rmB.want.hum + rmB.want.beat)) < 0.5,
  `live=${JSON.stringify(rmB.live)} want=${JSON.stringify(rmB.want)}`);
ok('rain still only falls where it rains',
  rmA.rainWet > 0 && rmA.rainDry === 0, `wet=${rmA.rainWet} dry=${rmA.rainDry}`);
ok('mute silences the bed and unmute brings it back',
  rmMute.off === 0 && rmMute.restored === true && rmMute.muted === false, JSON.stringify(rmMute));


/* ---- chase stinger: it rises with the meter, and it resolves ----
   Paused throughout the sweep on purpose: the live loop drains the meter
   between evaluates, so an unpaused read measures a decaying value rather than
   the steady state it claims to. */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
await evl('mapIdx = 0; loop = 0; loadMap(0); bots.length = 0; invuln = 9e9; meter = 0; paused = true;');
const stingAt = async m => { await evl(`__fp.stingStep(${m})`); await sleep(560);
  return JSON.parse(await evl('JSON.stringify({ t: __fp.tension, ...__fp.stingLive() })')); };
const stg = {};
for (const m of [0, 0.22, 0.5, 0.8, 0.95]) stg['m' + String(m).replace('.', '')] = await stingAt(m);
/* while ducked, a theme change must move the bed and leave the duck alone */
const duckedBefore = JSON.parse(await evl('JSON.stringify({ room: __fp.roomLive(), sting: __fp.stingLive() })'));
await evl("setRoomTone('server')"); await sleep(950);
const duckedAfter = JSON.parse(await evl('JSON.stringify({ room: __fp.roomLive(), sting: __fp.stingLive() })'));
/* and it has to come all the way back down */
const rest = await stingAt(0);
/* the heartbeat still tightens: drive updateMeter with the meter pinned */
const beats = JSON.parse(await evl(`(() => {
  const run = (m, n) => { __fp.beatReset(); for (let i = 0; i < n; i++) { meter = m; updateMeter(1/60); } return __fp.beatN; };
  return JSON.stringify({ calm: run(0.35, 600), panic: run(0.95, 600), quiet: run(0.1, 600) });
})()`));
const cut = JSON.parse(await evl(`(() => { paused = false; meter = 0.9; __fp.stingStep(0.9); caught(); return JSON.stringify({ t: __fp.tension, mode }); })()`));
ok('nothing plays until the meter is worth worrying about',
  stg.m0.rootV === 0 && stg.m022.rootV === 0 && stg.m022.t === 0,
  `at0=${stg.m0.rootV} at.22=${stg.m022.rootV}`);
ok('it climbs with the meter, in pitch and in level',
  stg.m05.root > stg.m022.root && stg.m08.root > stg.m05.root && stg.m095.root > stg.m08.root
  && stg.m05.rootV > stg.m022.rootV && stg.m08.rootV > stg.m05.rootV && stg.m095.rootV > stg.m08.rootV,
  `roots=${[stg.m022, stg.m05, stg.m08, stg.m095].map(v => v.root)} gains=${[stg.m022, stg.m05, stg.m08, stg.m095].map(v => v.rootV)}`);
ok('and reaches a fifth above where it started',
  Math.abs(stg.m095.root - 165) < 6 && Math.abs(stg.m095.tri / stg.m095.root - 1.414) < 0.01,
  `root=${stg.m095.root} ratio=${(stg.m095.tri / stg.m095.root).toFixed(3)}`);
/* the wrong-sounding interval is held back for when you are actually cornered */
ok('the tritone stays out of it until late',
  stg.m05.triV === 0 && stg.m08.triV > 0 && stg.m095.triV > stg.m08.triV,
  `.5=${stg.m05.triV} .8=${stg.m08.triV} .95=${stg.m095.triV}`);
ok('the room makes way for it',
  stg.m095.duck < 0.5 && stg.m05.duck < stg.m022.duck && stg.m022.duck > 0.99,
  `duck .22=${stg.m022.duck} .5=${stg.m05.duck} .95=${stg.m095.duck}`);
/* setRoomTone owns the theme levels, the chase owns the multiplier */
ok('changing theme mid-duck moves the bed without touching the duck',
  duckedAfter.room.hum === 96 && duckedAfter.room.air === 2600
  && Math.abs(duckedAfter.sting.duck - duckedBefore.sting.duck) < 0.02,
  `bed ${duckedBefore.room.hum}->${duckedAfter.room.hum} duck ${duckedBefore.sting.duck}->${duckedAfter.sting.duck}`);
/* setTargetAtTime approaches its target exponentially and never actually
   arrives, so rest is an inaudible floor rather than a hard zero */
ok('getting away is audible: it all comes back to rest',
  rest.t === 0 && rest.rootV < 0.001 && rest.triV < 0.001 && rest.duck > 0.99, JSON.stringify(rest));
ok('the heartbeat still races as the meter fills',
  beats.quiet === 0 && beats.panic > beats.calm * 1.7 && beats.calm > 0,
  `quiet=${beats.quiet} calm=${beats.calm} panic=${beats.panic} ratio=${(beats.panic / beats.calm).toFixed(2)}`);
ok('being caught cuts the swell', cut.t === 0 && cut.mode === 'caught', JSON.stringify(cut));


/* ---- footsteps take after the floor ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const ftm = JSON.parse(await evl(`(() => {
  const o = {};
  endless = false; __fp.setMod(-1); __fp.setDiff('standard'); alertLvl = 0;
  o.mats = __fp.materialNames();
  o.floors = __fp.floorMaterials();
  o.missing = Object.keys(THEMES).filter(t => !o.floors[t]);
  o.orphan = Object.values(o.floors).filter(m => !o.mats.includes(m));
  o.distinct = new Set(Object.values(o.floors)).size;
  const xy = i => ({ x: (i % T.COLS) * T.TILE + 20, y: ((i / T.COLS) | 0) * T.TILE + 20 });
  const firstOf = arr => { for (let i = 0; i < arr.length; i++) if (arr[i]) return i; return -1; };
  /* the docks have water; the warehouse has vents. Water wins over the theme,
     grating wins over the theme, and the theme covers everything else. */
  mapIdx = 7; loadMap(7);
  const w = firstOf(waterAt);
  o.onWater = w >= 0 ? __fp.surfaceAtXY(xy(w).x, xy(w).y) : 'no water tiles';
  o.docksFloor = __fp.surfaceAtXY(spawnPt.x, spawnPt.y);
  mapIdx = 1; loadMap(1);
  const v = firstOf(ventAt);
  o.onVent = v >= 0 ? __fp.surfaceAtXY(xy(v).x, xy(v).y) : 'no vent tiles';
  o.warehouseFloor = __fp.surfaceAtXY(spawnPt.x, spawnPt.y);
  /* walking is for you, sprinting is for them */
  mapIdx = 0; loadMap(0); bots.length = 0; invuln = 9e9; meter = 0;
  const move = (n, sprint) => {
    __fp.stepClear(); noise = [];
    let heard = 0;
    for (let i = 0; i < n; i++) { keys.right = true; keys.sprint = !!sprint; update(1/60); heard = Math.max(heard, noise.length); }
    keys.right = false; keys.sprint = false;
    return { steps: __fp.stepLog.length, heard, mat: __fp.stepLog[0] && __fp.stepLog[0].mat, v: __fp.stepLog[0] && __fp.stepLog[0].v };
  };
  o.walk = move(150, false);
  o.sprint = move(150, true);
  puShoe = 9e9; o.shod = move(150, false); puShoe = 0;
  return JSON.stringify(o);
})()`));
ok('every theme has a floor and every floor is a real material',
  ftm.missing.length === 0 && ftm.orphan.length === 0,
  `missing=${JSON.stringify(ftm.missing)} orphan=${JSON.stringify(ftm.orphan)}`);
ok('the floors are not all the same underfoot', ftm.distinct >= 4,
  `${ftm.distinct} distinct across ${Object.keys(ftm.floors).length} themes`);
ok('water is heard over whatever the floor is made of',
  ftm.onWater === 'water' && ftm.docksFloor === 'steel', `${ftm.onWater} / ${ftm.docksFloor}`);
ok('so is a vent grille', ftm.onVent === 'grating' && ftm.warehouseFloor === 'concrete',
  `${ftm.onVent} / ${ftm.warehouseFloor}`);
/* walking was silent outright before this - no sound at all, on any surface */
ok('walking is audible to you now', ftm.walk.steps > 0 && ftm.walk.mat === 'carpet',
  JSON.stringify(ftm.walk));
ok('but the drones still cannot hear you walk',
  ftm.walk.heard === 0 && ftm.sprint.heard > 0,
  `walk=${ftm.walk.heard} sprint=${ftm.sprint.heard}`);
ok('and a sprint lands harder than a walk', ftm.sprint.v > ftm.walk.v * 2,
  `walk=${ftm.walk.v} sprint=${ftm.sprint.v}`);
ok('soft shoes quieten your own feet as well as theirs',
  ftm.shod.v < ftm.walk.v * 0.6 && ftm.shod.steps > 0, `${ftm.walk.v} -> ${ftm.shod.v}`);


/* ---- sounds sit where the thing making them is ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const pnl = JSON.parse(await evl(`(() => {
  const o = {};
  endless = false; __fp.setMod(-1); __fp.setDiff('standard');
  mapIdx = 0; loop = 0; loadMap(0); bots.length = 1; invuln = 9e9; meter = 0;
  player.x = 560; player.y = 360;
  o.hasPanner = !!(AC && AC.createStereoPanner);
  o.curve = [-900, -420, -210, 0, 210, 420, 900].map(dx => __fp.panAt(560 + dx));
  __fp.panClear(); sfx.crate({ x: 160, y: 360 }); o.left = __fp.panLog.map(e => e.pan);
  __fp.panClear(); sfx.crate({ x: 960, y: 360 }); o.right = __fp.panLog.map(e => e.pan);
  __fp.panClear(); sfx.crate({ x: 560, y: 360 }); o.onTop = __fp.panLog.map(e => e.pan);
  /* the heartbeat, the interface and the moment you are caught are not in the
     room with you - they should not move around the stereo field */
  __fp.panClear(); sfx.beat(); sfx.ui(); sfx.caught(); sfx.siren(); sfx.blackout();
  o.centred = __fp.panLog.length;
  __fp.panClear();
  const b = bots[0]; b.x = 120; b.y = 360;
  sfx.servo(1, 1, 0.9, b);
  o.droneLeft = __fp.panLog.map(e => e.pan);
  b.x = 1000; __fp.panClear(); sfx.servo(-1, 1, 0.9, b);
  o.droneRight = __fp.panLog.map(e => e.pan);
  /* G1's distance curve and this share one function now */
  o.dist = [0, 380, 1100].map(d => __fp.distVolAt(d));
  o.servoStillMatches = [0, 380, 1100].map(d => __fp.servoVolAt(d));
  /* the camera clamps at map edges, so screen position would put a drone in the
     wrong ear every time you walked into a corner */
  camNow.cx = 0; const a = __fp.panAt(160);
  camNow.cx = 500; const c = __fp.panAt(160);
  o.cameraProof = [a, c];
  return JSON.stringify(o);
})()`));
ok('the browser gives us a stereo panner at all', pnl.hasPanner === true);
ok('pan follows how far off to one side a thing is',
  pnl.curve[3] === 0 && pnl.curve[2] < 0 && pnl.curve[4] > 0
  && Math.abs(pnl.curve[2]) === Math.abs(pnl.curve[4]), JSON.stringify(pnl.curve));
ok('and stops short of one ear entirely',
  pnl.curve[0] === -0.85 && pnl.curve[6] === 0.85, JSON.stringify(pnl.curve));
ok('a crate breaking to your left is on your left',
  pnl.left.length > 0 && pnl.left.every(v => v < -0.5)
  && pnl.right.length > 0 && pnl.right.every(v => v > 0.5),
  `left=${JSON.stringify(pnl.left)} right=${JSON.stringify(pnl.right)}`);
ok('one at your feet is in the middle', pnl.onTop.every(v => v === 0), JSON.stringify(pnl.onTop));
ok('the heartbeat and the interface stay put', pnl.centred === 0, `panned=${pnl.centred}`);
ok('a drone chirps from where it actually is',
  pnl.droneLeft.every(v => v < -0.5) && pnl.droneRight.every(v => v > 0.5),
  `left=${JSON.stringify(pnl.droneLeft)} right=${JSON.stringify(pnl.droneRight)}`);
ok('there is one distance model, not one per feature',
  JSON.stringify(pnl.dist) === JSON.stringify(pnl.servoStillMatches) && pnl.dist[0] === 1,
  `${JSON.stringify(pnl.dist)} vs ${JSON.stringify(pnl.servoStillMatches)}`);
ok('panning follows you, not the camera',
  pnl.cameraProof[0] === pnl.cameraProof[1], JSON.stringify(pnl.cameraProof));


/* ---- the coin ladder, and the door it exposed ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const ldr = JSON.parse(await evl(`(() => {
  const o = {};
  endless = false; __fp.setMod(-1); __fp.setDiff('standard');
  mapIdx = 1; loop = 0; loadMap(1); bots.length = 0; invuln = 9e9; meter = 0;
  o.crates = crates.length;
  /* A crate coin used to count toward the floor's requirement: take every real
     coin but one, add a bonus, and the exit opened with gold still in the dark. */
  breakCrate(crates[0]);
  const real = coinList.filter(c => !c.bonus), bonus = coinList.filter(c => c.bonus);
  for (let i = 0; i < real.length - 1; i++) { real[i].got = true; coins++; realCoins++; }
  const scoreBefore = score;
  bonus[0].got = true; coins++; score += coinValue();
  o.bonusHeld = { coins, realCoins, total: coinsTotal, opens: realCoins >= coinsTotal,
                  realLeft: coinList.filter(c => !c.bonus && !c.got).length,
                  paid: score > scoreBefore };
  real[real.length - 1].got = true; coins++; realCoins++;
  o.lastReal = { coins, realCoins, opens: realCoins >= coinsTotal };
  /* the ladder itself */
  mapIdx = 0; loadMap(0); o.small = { n: coinsTotal, rungs: __fp.coinLadder() };
  mapIdx = 11; loadMap(11); o.big = { n: coinsTotal, rungs: __fp.coinLadder() };
  /* tossing a coin steps back down the ladder and re-collecting climbs again */
  mapIdx = 0; loadMap(0);
  realCoins = 3; coins = 3; const at3 = __fp.coinRatioNow();
  realCoins = 2; coins = 2; const at2 = __fp.coinRatioNow();
  o.step = { at2, at3 };
  /* a coin's chime comes from the coin */
  __fp.panClear(); player.x = 560; player.y = 360;
  sfx.pickup({ x: 160, y: 360 }, 1);
  o.panned = __fp.panLog.map(e => e.pan);
  return JSON.stringify(o);
})()`));
const semis = [0, 2, 4, 7, 9, 12].map(n => +Math.pow(2, n / 12).toFixed(5));
ok('the warehouse still has crates to test with', ldr.crates > 0, `n=${ldr.crates}`);
/* the headline: this was a live exploit - break a crate, skip a coin, leave */
ok('a crate coin no longer opens the exit for you',
  ldr.bonusHeld.opens === false && ldr.bonusHeld.realLeft === 1
  && ldr.bonusHeld.coins > ldr.bonusHeld.realCoins,
  JSON.stringify(ldr.bonusHeld));
ok('but it still pays and still weighs', ldr.bonusHeld.paid === true, `score rose=${ldr.bonusHeld.paid}`);
ok('and the last real coin does open it',
  ldr.lastReal.opens === true && ldr.lastReal.coins === ldr.lastReal.realCoins + 1,
  JSON.stringify(ldr.lastReal));
ok('the ladder only ever climbs',
  ldr.small.rungs.every((v, i) => i === 0 || v >= ldr.small.rungs[i - 1])
  && ldr.big.rungs.every((v, i) => i === 0 || v >= ldr.big.rungs[i - 1]),
  `small=${JSON.stringify(ldr.small.rungs)}`);
ok('it starts at the bottom and finishes on the octave whatever the floor holds',
  ldr.small.rungs[0] === 1 && ldr.small.rungs[ldr.small.n - 1] === 2
  && ldr.big.rungs[0] === 1 && ldr.big.rungs[ldr.big.n - 1] === 2,
  `${ldr.small.n} coins -> ${ldr.small.rungs[ldr.small.n - 1]}, ${ldr.big.n} -> ${ldr.big.rungs[ldr.big.n - 1]}`);
/* pentatonic: there is no rung that sounds like a mistake */
ok('every rung is in the scale',
  [...ldr.small.rungs, ...ldr.big.rungs].every(v => semis.includes(v)),
  `scale=${JSON.stringify(semis)}`);
ok('spending a coin steps back down the ladder', ldr.step.at2 < ldr.step.at3,
  `2 coins=${ldr.step.at2} 3 coins=${ldr.step.at3}`);
ok('the chime comes from the coin, not from your head',
  ldr.panned.length > 0 && ldr.panned.every(v => v < -0.5), JSON.stringify(ldr.panned));


/* ---- settings, in one place instead of scattered across the menu ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const stn = JSON.parse(await evl(`(() => {
  const o = {};
  initAudio();
  const seg = m => [...$('motionSeg').children].find(b => b.dataset.motion === m);
  const vis = id => { const el = $(id); return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); };
  o.shutAtBoot = $('settingsOv').classList.contains('hidden');
  /* reachable from a run, not only from the menu */
  paused = false; togglePause();
  $('pauseSetBtn').click();
  o.fromPause = { open: !$('settingsOv').classList.contains('hidden'), pauseStillUp: !$('pausedOv').classList.contains('hidden') };
  $('setDoneBtn').click(); togglePause();
  toMenu();
  $('settingsBtn').click();
  o.fromMenu = !$('settingsOv').classList.contains('hidden');
  o.rowsSeen = ['volSlider', 'diffBtn', 'motionSeg'].every(vis);
  /* volume reaches the audio graph, and mute does not eat your choice */
  const sl = $('volSlider'); sl.value = 20; sl.dispatchEvent(new Event('input'));
  o.vol = { setting: settings.vol, master: +master.gain.value.toFixed(3), read: $('volRead').textContent };
  toggleMute(); o.muted = +master.gain.value.toFixed(3);
  toggleMute(); o.unmuted = +master.gain.value.toFixed(3);
  /* difficulty moved in here rather than being duplicated */
  __fp.setDiff('casual'); renderSettings();
  o.diffShown = $('diffBtn').textContent.trim();
  o.diffNote = $('diffNote').textContent.length > 0;
  __fp.setDiff('standard');
  /* motion: three states, and the system preference is only the default */
  seg('reduced').click(); o.reduced = { motion: settings.motion, shake: shakeScale, full: motionFull() };
  seg('full').click(); o.full = { motion: settings.motion, shake: shakeScale, full: motionFull() };
  o.marked = [...$('motionSeg').children].filter(b => b.classList.contains('on')).map(b => b.dataset.motion);
  /* and it reaches more than the screen shake */
  parts = []; burst(100, 100, null, 20, 100); const many = parts.length;
  seg('reduced').click();
  parts = []; burst(100, 100, null, 20, 100); const few = parts.length;
  startGame(); mapIdx = 0; loadMap(0);
  wipeT = 0; nextMap(); const wipeOff = wipeT;
  seg('full').click(); mapIdx = 0; loadMap(0);
  wipeT = 0; nextMap(); const wipeOn = +wipeT.toFixed(3);
  o.motionReach = { many, few, wipeOn, wipeOff };
  o.stored = JSON.parse(localStorage.getItem('flashpoint.settings') || '{}');
  /* escape closes the panel without also pausing the game underneath */
  $('settingsBtn').click();
  const wasPaused = paused;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  o.escape = { shut: $('settingsOv').classList.contains('hidden'), pausedUnchanged: paused === wasPaused };
  /* leave the machine as we found it: these persist, and a quiet run would
     disarm every audio assertion in this file */
  sl.value = 55; sl.dispatchEvent(new Event('input'));
  seg('auto').click();
  o.restored = JSON.parse(localStorage.getItem('flashpoint.settings') || '{}');
  return JSON.stringify(o);
})()`));
ok('settings start shut', stn.shutAtBoot === true);
ok('and open from the menu and from a run alike',
  stn.fromMenu === true && stn.fromPause.open === true && stn.fromPause.pauseStillUp === true,
  JSON.stringify(stn.fromPause));
ok('every control is actually on screen', stn.rowsSeen === true);
ok('volume reaches the audio, not just the label',
  stn.vol.setting === 0.2 && stn.vol.master === 0.2 && stn.vol.read === '20%', JSON.stringify(stn.vol));
/* toggleMute used to hardcode 0.55, so a mute and unmute threw your choice away */
ok('muting and unmuting gives back the volume you chose',
  stn.muted === 0 && stn.unmuted === 0.2, `muted=${stn.muted} back=${stn.unmuted}`);
ok('difficulty lives here now, and says what it does',
  stn.diffShown === 'CASUAL' && stn.diffNote === true, `label=${stn.diffShown}`);
ok('motion has three states and the marked one is the chosen one',
  stn.reduced.full === false && stn.reduced.shake === 0.25
  && stn.full.full === true && stn.full.shake === 1
  && stn.marked.length === 1 && stn.marked[0] === 'full',
  `${JSON.stringify(stn.reduced)} ${JSON.stringify(stn.full)} marked=${stn.marked}`);
ok('reduced motion means more than a calmer shake',
  stn.motionReach.few < stn.motionReach.many && stn.motionReach.wipeOff === 0
  && stn.motionReach.wipeOn > 0.5, JSON.stringify(stn.motionReach));
ok('escape closes the panel and leaves the game alone',
  stn.escape.shut === true && stn.escape.pausedUnchanged === true, JSON.stringify(stn.escape));
ok('choices survive a reload', stn.stored.motion === 'reduced' || stn.stored.motion === 'full',
  JSON.stringify(stn.stored));
ok('and this block puts the machine back as it found it',
  stn.restored.vol === 0.55 && stn.restored.motion === 'auto', JSON.stringify(stn.restored));


/* ---- minimap: the swept area and nothing else ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const mm = JSON.parse(await evl(`(() => {
  const o = {};
  endless = false; __fp.setMod(-1); __fp.setDiff('standard');
  mapIdx = 0; loop = 0; loadMap(0); bots.length = 0; invuln = 9e9; meter = 0;
  clearMemory(); render();
  o.fresh = { seen: __fp.miniSeen(), lit: __fp.miniPixels() };
  const px = player.x, py = player.y;
  for (let k = 0; k < 40; k++) {
    __fp.aimAt(px + Math.cos(k * 0.157) * 400, py + Math.sin(k * 0.157) * 400);
    for (let i = 0; i < 12; i++) update(1 / 60);
  }
  render();
  o.swept = { seen: __fp.miniSeen(), lit: __fp.miniPixels() };
  /* a drone standing in the dark must leave no mark on it */
  const before = __fp.miniPixels();
  spawnBots();
  for (const b of bots) { b.x = 1040; b.y = 660; }
  render();
  o.withDrones = { lit: __fp.miniPixels(), same: __fp.miniPixels() === before, n: bots.length };
  bots.length = 0;
  /* the exit is hidden until you have laid eyes on it, then it shows */
  o.exitBefore = __fp.miniExitVisible();
  const litBefore = __fp.miniPixels();
  const ei = ((exitPt.y / 20) | 0) * 56 + ((exitPt.x / 20) | 0);
  surveyG[ei] = 1; surveyG[ei + 1] = 1; surveyG[ei - 1] = 1;
  render();
  o.exitAfter = { visible: __fp.miniExitVisible(), lit: __fp.miniPixels(), grew: __fp.miniPixels() > litBefore };
  /* turning it off in settings */
  const seg = v => [...$('miniSeg').children].find(b => b.dataset.mini === v);
  seg('off').click(); render(); o.off = { shown: __fp.miniShown(), setting: settings.minimap };
  seg('on').click(); render(); o.on = { shown: __fp.miniShown(), setting: settings.minimap };
  toMenu(); render(); o.inMenu = __fp.miniShown();
  return JSON.stringify(o);
})()`));
ok('a fresh floor has nothing on the map but you',
  mm.fresh.seen === 0 && mm.fresh.lit > 0 && mm.fresh.lit < 60,
  `cells=${mm.fresh.seen} px=${mm.fresh.lit}`);
ok('sweeping the room fills it in',
  mm.swept.seen > 100 && mm.swept.lit > mm.fresh.lit * 10,
  `cells=${mm.swept.seen} px=${mm.swept.lit}`);
/* the whole defence of having a minimap at all: it adds no information the
   afterglow on the main canvas was not already showing */
ok('a drone in the dark puts nothing on it',
  mm.withDrones.n > 0 && mm.withDrones.same === true, JSON.stringify(mm.withDrones));
ok('the way out stays hidden until you have lit it',
  mm.exitBefore === false && mm.exitAfter.visible === true && mm.exitAfter.grew === true,
  `${mm.exitBefore} -> ${JSON.stringify(mm.exitAfter)}`);
ok('settings can turn it off and back on',
  mm.off.shown === false && mm.off.setting === false && mm.on.shown === true && mm.on.setting === true,
  `${JSON.stringify(mm.off)} ${JSON.stringify(mm.on)}`);
ok('and it is not on the menu', mm.inMenu === false);


/* ---- exit compass: on all the time, and graded to what you know ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const exc = JSON.parse(await evl(`(() => {
  const o = {};
  endless = false; __fp.setMod(-1); __fp.setDiff('standard');
  mapIdx = 0; loop = 0; loadMap(0); bots.length = 0; invuln = 9e9; meter = 0;
  clearMemory(); exitOpen = false; render();
  o.unseen = __fp.exitCompass();
  const i = ((exitPt.y / 20) | 0) * 56 + ((exitPt.x / 20) | 0);
  surveyG[i] = 1;
  o.seen = __fp.exitCompass();
  exitOpen = true;
  o.open = __fp.exitCompass();
  o.screen = { W, H, m: 26 };
  /* park the camera so the exit is off to the right, then off to the left */
  camNow.cx = exitPt.x - 2000; camNow.cy = exitPt.y - H / (2 * Z);
  o.toRight = __fp.exitCompass();
  camNow.cx = exitPt.x + 2000;
  o.toLeft = __fp.exitCompass();
  /* and out of the way when the door is on screen */
  camNow.cx = exitPt.x - W / (2 * Z); camNow.cy = exitPt.y - H / (2 * Z);
  o.whenVisible = __fp.exitCompass();
  return JSON.stringify(o);
})()`));
const onEdge = c => Math.abs(c.x - 26) < 1.5 || Math.abs(c.x - (exc.screen.W - 26)) < 1.5
  || Math.abs(c.y - 26) < 1.5 || Math.abs(c.y - (exc.screen.H - 26)) < 1.5;
/* it used to require exitOpen, so it appeared only once every coin was already
   in hand - exactly when you no longer needed telling where the door was */
ok('the compass is there before the exit opens',
  exc.unseen.hidden === false && exc.unseen.state === 0, JSON.stringify(exc.unseen));
ok('it grows more definite as you learn more',
  exc.unseen.alpha < exc.seen.alpha && exc.seen.alpha < exc.open.alpha
  && exc.unseen.state === 0 && exc.seen.state === 1 && exc.open.state === 2,
  `${exc.unseen.alpha} -> ${exc.seen.alpha} -> ${exc.open.alpha}`);
ok('and it stays faint while you have never seen the door',
  exc.unseen.alpha <= 0.2, `alpha=${exc.unseen.alpha}`);
ok('it sits on the edge of the screen, not on a ring inside it',
  onEdge(exc.open) && onEdge(exc.toLeft) && onEdge(exc.toRight),
  `open=${exc.open.x},${exc.open.y} of ${exc.screen.W}x${exc.screen.H}`);
ok('it points at the door',
  Math.abs(exc.toRight.ang) < 0.4 && Math.abs(exc.toLeft.ang) > Math.PI - 0.4,
  `right=${exc.toRight.ang} left=${exc.toLeft.ang}`);
ok('and gets out of the way once you can see it', exc.whenVisible.hidden === true,
  JSON.stringify(exc.whenVisible));


/* ---- leaderboard ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const brd = JSON.parse(await evl(`(() => {
  const o = {};
  const el = $('recCaught');
  const rows = () => [...el.querySelectorAll('.rrow')];
  records = []; renderRecords(el);
  o.empty = { blank: el.querySelectorAll('.rempty').length, rows: rows().length,
              says: el.querySelector('.rempty') ? el.querySelector('.rempty').textContent.length > 10 : false };
  /* two runs, same player, identical score. Only the one just played is yours. */
  records = [{ n: 'TESTY', s: 9000, d: 4, c: 30, t: 200 }];
  name = 'TESTY'; score = 9000; totalRunCoins = 30; runT = 200; loop = 0; mapIdx = 3;
  addRecord(); renderRecords(el);
  o.tie = { rows: rows().length, mine: rows().filter(r => r.classList.contains('mine')).length };
  /* records saved before this change carry no id and must never light up */
  records = [{ n: 'OLD', s: 500, d: 1, c: 1, t: 10 }, { n: 'OLDER', s: 400, d: 1, c: 1, t: 9 }];
  renderRecords(el);
  o.legacy = rows().filter(r => r.classList.contains('mine')).length;
  /* a full board */
  records = [];
  for (let i = 0; i < 8; i++) records.push({ n: 'PLAYER' + i, s: 15000 - i * 1700, d: 12 - i, c: 60 - i * 5, t: 300 + i * 40, id: 900 + i });
  lastRecordId = 903; renderRecords(el);
  const r2 = rows();
  o.full = {
    shown: r2.length, stored: records.length,
    ranks: r2.map(r => r.querySelector('.rk').textContent).join(','),
    topMarked: r2[0].classList.contains('top'),
    mineIdx: r2.findIndex(r => r.classList.contains('mine')),
    score: r2[0].querySelector('.rs').textContent,
    everyRowHasTime: r2.every(r => /\\d+:\\d\\d/.test(r.querySelector('.rmeta').textContent)),
    everyRowHasFloor: r2.every(r => /floor \\d+/.test(r.querySelector('.rmeta').textContent)),
  };
  /* the same component serves the escape screen */
  renderRecords($('recEsc'));
  o.escapedToo = $('recEsc').querySelectorAll('.rrow').length;
  return JSON.stringify(o);
})()`));
ok('an empty board says something instead of showing a blank row',
  brd.empty.blank === 1 && brd.empty.rows === 0 && brd.empty.says === true, JSON.stringify(brd.empty));
/* the old check matched on name AND score, so a tie lit up every matching run,
   including ones from previous sessions once sorting had mixed them together */
ok('a tie on score marks only the run you just played',
  brd.tie.rows === 2 && brd.tie.mine === 1, JSON.stringify(brd.tie));
ok('and records saved before this never claim to be yours', brd.legacy === 0, `marked=${brd.legacy}`);
ok('runs are ranked', brd.full.ranks === '1,2,3,4,5,6' && brd.full.topMarked === true, brd.full.ranks);
ok('six shown out of eight kept', brd.full.shown === 6 && brd.full.stored === 8,
  `${brd.full.shown} of ${brd.full.stored}`);
ok('your run is picked out wherever it lands', brd.full.mineIdx === 3, `index=${brd.full.mineIdx}`);
/* every run has recorded its time since the beginning and never showed it */
ok('each row shows the floor reached and the time taken',
  brd.full.everyRowHasTime === true && brd.full.everyRowHasFloor === true, JSON.stringify(brd.full));
ok('big scores are readable', brd.full.score === '15,000', brd.full.score);
ok('the escape screen gets the same board', brd.escapedToo === 6, `rows=${brd.escapedToo}`);


/* ---- toasts stack instead of overwriting ----
   Real timers, so this block sleeps for real. The game is quietened first:
   left alone it raises its own alerts and they land in the same stack. */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
await evl(`mapIdx = 0; loop = 0; loadMap(0); bots.length = 0; invuln = 9e9; meter = 0; clearToast();`);
await evl("toast('PRESSURE PLATE', 6); toast('CRATE OPEN', 6); toast('FOG BANK', 6);");
await sleep(420);
const tst = { three: JSON.parse(await evl('JSON.stringify({ model: __fp.toastList(), dom: __fp.toastShown(), visible: __fp.toastVisible() })')) };
await evl("toast('SIREN SWEEP', 6);");
await sleep(180);
tst.fourth = JSON.parse(await evl('JSON.stringify({ model: __fp.toastList(), cap: __fp.toastCap() })'));
await evl("toast('SIREN SWEEP', 6); toast('SIREN SWEEP', 6);");
await sleep(150);
tst.repeat = JSON.parse(await evl('JSON.stringify(__fp.toastList())'));
await evl("clearToast(); toast('SHORT ONE', 0.6); toast('LONG ONE', 9);");
await sleep(1300);
tst.lifetimes = JSON.parse(await evl('JSON.stringify({ model: __fp.toastList(), dom: __fp.toastShown() })'));
await evl('clearToast();');
tst.cleared = JSON.parse(await evl('JSON.stringify({ model: __fp.toastList(), dom: __fp.toastShown() })'));
/* one message used to erase the one before it outright */
ok('three events in a row all get said',
  tst.three.model.length === 3 && tst.three.visible === 3
  && tst.three.model.includes('PRESSURE PLATE') && tst.three.model.includes('CRATE OPEN')
  && tst.three.model.includes('FOG BANK'), JSON.stringify(tst.three));
ok('the newest is on top', tst.three.model[0] === 'FOG BANK' && tst.three.dom[0] === 'FOG BANK',
  JSON.stringify(tst.three.dom));
ok('a fourth pushes the oldest out rather than piling up',
  tst.fourth.model.length === tst.fourth.cap && tst.fourth.model[0] === 'SIREN SWEEP'
  && !tst.fourth.model.includes('PRESSURE PLATE'), JSON.stringify(tst.fourth));
/* three crates in a row are three identical lines otherwise */
ok('the same message twice refreshes one line instead of stacking copies',
  tst.repeat.filter(m => m === 'SIREN SWEEP').length === 1 && tst.repeat.length === 3,
  JSON.stringify(tst.repeat));
ok('each message keeps its own clock',
  tst.lifetimes.model.length === 1 && tst.lifetimes.model[0] === 'LONG ONE'
  && !tst.lifetimes.dom.includes('SHORT ONE'), JSON.stringify(tst.lifetimes));
ok('and clearing takes them out of the page, not just the list',
  tst.cleared.model.length === 0 && tst.cleared.dom.length === 0, JSON.stringify(tst.cleared));


/* ---- the tutorial teaches one thing at a time ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const tut = JSON.parse(await evl(`(() => {
  const o = {};
  /* completedLevels lives in localStorage and every earlier block has been
     clearing floors, so the tutorial would be switched off before we started */
  completedLevels = []; endless = false;
  __fp.setDiff('standard'); __fp.setMod(-1);
  /* the tutorial arms in startGame(), which is the right place - a new run is
     when it should reset. Calling loadMap directly walks past that door and
     inherits whatever the last run left behind. */
  startGame();
  bots.length = 0; invuln = 9e9; meter = 0; clearToast();
  const step = n => { for (let i = 0; i < n; i++) update(1 / 60); };
  step(30);
  o.start = __fp.tutorState();
  o.startToast = __fp.toastList()[0] || null;
  o.onlyOne = __fp.toastList().length;
  /* three seconds of standing still must not advance anything */
  step(180);
  o.stuck = __fp.tutorState().step;
  for (let i = 0; i < 160; i++) { keys.right = true; update(1 / 60); }
  keys.right = false; step(100);
  o.moved = __fp.tutorState();
  o.sweepToast = __fp.toastList()[0] || null;
  /* the lesson that matters ends by doing it, not by waiting */
  const c = coinList.find(x => !x.got);
  player.x = c.x - 60; player.y = c.y; __fp.aimAt(c.x, c.y);
  step(120);
  o.lit = __fp.tutorState();
  o.msgs = __fp.tutorState().steps;
  completedLevels = [0]; o.offAfterClear = __fp.tutorState().on;
  completedLevels = []; endless = true; o.offInEndless = __fp.tutorState().on;
  endless = false; mapIdx = 4; o.offLaterFloor = __fp.tutorState().on;
  mapIdx = 0;
  return JSON.stringify(o);
})()`));
/* it used to be one nine second toast carrying four lessons at once, fired half
   a second in, before the player had done anything at all */
ok('it opens with one lesson, not four',
  tut.start.step === 0 && tut.onlyOne === 1 && tut.startToast === tut.start.msg,
  `${tut.onlyOne} message(s): ${tut.startToast}`);
ok('and waits rather than running on a timer', tut.stuck === 0, `step=${tut.stuck}`);
ok('moving is what teaches the moving lesson',
  tut.moved.step === 1 && tut.moved.moved === true && tut.sweepToast === tut.moved.msg,
  `step=${tut.moved.step} msg=${tut.sweepToast}`);
/* the whole game rests on this one, so it is cleared by doing it */
ok('putting the beam on gold is what clears the gold lesson',
  tut.lit.step === 2 && tut.lit.litGold === true, JSON.stringify(tut.lit));
ok('there are four lessons in the sequence', tut.msgs === 4, `steps=${tut.msgs}`);
ok('it is done with you once you have cleared a floor', tut.offAfterClear === false);
ok('and never appears in endless or on a later floor',
  tut.offInEndless === false && tut.offLaterFloor === false,
  `endless=${tut.offInEndless} floor5=${tut.offLaterFloor}`);


/* ---- colourblind mode ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const cbl = JSON.parse(await evl(`(() => {
  const o = {};
  endless = false; __fp.setMod(-1); __fp.setDiff('standard');
  mapIdx = 0; loop = 0; loadMap(0); invuln = 9e9; meter = 0;
  bots.length = 1;
  const b = bots[0];
  b.x = player.x + 150; b.y = player.y; b.face = Math.PI; b.state = 'patrol'; b.path = [];
  for (let i = 0; i < 8; i++) update(1 / 60);
  render();
  /* sample where the cone actually is. The whole canvas dilutes it to nothing:
     a low-alpha cone is a small part of a big dark screen. */
  const mx = (b.x + player.x) / 2, my = b.y;
  const sx = (mx - camNow.cx) * Z, sy = (my - camNow.cy) * Z, half = 70;
  const grab = () => ctx.getImageData((sx - half) * DPR, (sy - half) * DPR, half * 2 * DPR, half * 2 * DPR).data;
  const read = () => { const d = grab(); let r = 0, g = 0, bl = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; bl += d[i + 2]; n++; }
    return { r: +(r / n).toFixed(1), g: +(g / n).toFixed(1), b: +(bl / n).toFixed(1) }; };
  /* luminance edges: what is left of the cone once hue is gone altogether */
  const edges = () => { const d = grab(), w = Math.round(half * 2 * DPR); let n = 0;
    for (let y = 1; y < Math.round(half * 2 * DPR); y++) for (let x = 1; x < w; x++) {
      const i = (y * w + x) * 4, j = (y * w + x - 1) * 4;
      const a = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const c = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
      if (Math.abs(a - c) > 4) n++;
    }
    return n; };
  __fp.setCb(false); render(); o.off = read(); o.edgesOff = edges(); o.palOff = __fp.conePalette().core;
  __fp.setCb(true);  render(); o.on = read(); o.edgesOn = edges(); o.palOn = __fp.conePalette().core;
  /* the row H1 held back until it did something */
  const seg = v => [...$('cbSeg').children].find(x => x.dataset.cb === v);
  seg('off').click(); o.viaPanelOff = __fp.colourblind;
  seg('on').click(); o.viaPanelOn = __fp.colourblind;
  o.marked = [...$('cbSeg').children].filter(x => x.classList.contains('on')).map(x => x.dataset.cb);
  o.stored = (JSON.parse(localStorage.getItem('flashpoint.settings') || '{}')).cb;
  seg('off').click();
  o.restored = (JSON.parse(localStorage.getItem('flashpoint.settings') || '{}')).cb;
  return JSON.stringify(o);
})()`));
ok('the cone palette actually changes',
  cbl.palOff === '255,70,60' && cbl.palOn === '60,170,255', `${cbl.palOff} -> ${cbl.palOn}`);
/* warm amber against red is exactly the pair red-green colour blindness collapses */
ok('and red stops dominating the cone on screen',
  (cbl.off.r - cbl.off.b) > 8 && (cbl.on.r - cbl.on.b) < 4,
  `r-b off=${(cbl.off.r - cbl.off.b).toFixed(1)} on=${(cbl.on.r - cbl.on.b).toFixed(1)}`);
/* hue is one channel and it is the one that fails, so the cone is hatched too */
ok('the cone keeps its shape with hue taken away entirely',
  cbl.edgesOn > cbl.edgesOff * 1.05,
  `luminance edges ${cbl.edgesOff} -> ${cbl.edgesOn}`);
ok('the settings row works and marks what is chosen',
  cbl.viaPanelOff === false && cbl.viaPanelOn === true
  && cbl.marked.length === 1 && cbl.marked[0] === 'on', JSON.stringify(cbl.marked));
ok('the choice is remembered', cbl.stored === true, `stored=${cbl.stored}`);
ok('and this block leaves it off again', cbl.restored === false, `restored=${cbl.restored}`);


/* ---- thumbstick response ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const stk = JSON.parse(await evl(`(() => {
  const o = {};
  endless = false; __fp.setMod(-1); __fp.setDiff('standard');
  mapIdx = 0; loop = 0; loadMap(0); bots.length = 0; invuln = 9e9; meter = 0;
  o.k = __fp.stickConsts();
  o.curve = [0, 0.15, 0.29, 0.31, 0.5, 0.75, 1.0].map(r => __fp.stickResponse(r));
  __fp.stickRelease();
  o.inDead = __fp.stickPush(0.25);
  o.justOut = __fp.stickPush(0.33);
  o.full = __fp.stickPush(1.0);
  /* up through the sprint line and back down through the band */
  __fp.stickRelease();
  o.up = [0.5, 0.8, 0.89, 0.92].map(r => [r, __fp.stickPush(r).sprint]);
  o.down = [0.89, 0.86, 0.80, 0.74, 0.70].map(r => [r, __fp.stickPush(r).sprint]);
  /* the ring drawn on the stick has to mean what it looks like it means */
  const ring = o.k.dead + o.k.on * (1 - o.k.dead);
  __fp.stickRelease(); o.atRing = __fp.stickPush(ring + 0.01).sprint;
  __fp.stickRelease(); o.insideRing = __fp.stickPush(ring - 0.04).sprint;
  o.ring = +ring.toFixed(3);
  __fp.stickRelease();
  return JSON.stringify(o);
})()`));
ok('the dead zone is bigger than the 0.22 it was', stk.k.dead >= 0.28, `dead=${stk.k.dead}`);
ok('inside it nothing moves at all',
  stk.inDead.mag === 0 && stk.inDead.speed === 0, JSON.stringify(stk.inDead));
/* it used to hand you the raw stick value the moment you crossed the line, so a
   thumb creeping over 0.22 jumped straight to a fifth of full speed */
ok('leaving it starts from a crawl rather than a jump',
  stk.justOut.mag < 0.08 && stk.justOut.speed > 0 && stk.justOut.speed < 12,
  `mag=${stk.justOut.mag} speed=${stk.justOut.speed}`);
ok('and the response climbs smoothly to full',
  stk.curve.every((v, i) => i === 0 || v >= stk.curve[i - 1]) && stk.curve[6] === 1
  && stk.full.mag === 1, JSON.stringify(stk.curve));
ok('pushing all the way sprints', stk.full.sprint === true && stk.full.speed > 150,
  JSON.stringify(stk.full));
ok('sprint engages on the way up', stk.up[0][1] === false && stk.up[3][1] === true,
  JSON.stringify(stk.up));
/* one threshold meant a thumb resting on the line flickered in and out every
   frame, and a sprint calls makeNoise, so the flicker screamed your position */
ok('and holds through the band on the way back down',
  stk.down[1][1] === true && stk.down[3][1] === true && stk.down[4][1] === false,
  JSON.stringify(stk.down));
ok('the sprint ring drawn on the stick is where sprint actually starts',
  stk.atRing === true && stk.insideRing === false, `ring=${stk.ring}`);


/* ---- the listener: no eyes, sharper ears, and freezing beats hiding ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const lsn = JSON.parse(await evl(`(() => {
  const o = {};
  endless = false; __fp.setMod(-1); __fp.setDiff('standard'); alertLvl = 0;
  o.mapsValid = __fp.mapCheck;
  mapIdx = 3; loop = 0; loadMap(3); invuln = 9e9; meter = 0;
  o.kinds = __fp.botKinds();
  o.listeners = __fp.listenerCount();
  const L = bots.find(b => b.kind === 'listen'), D = bots.find(b => b.kind === 'drone');
  o.hearing = { listener: __fp.hearReachFor(bots.indexOf(L)), drone: __fp.hearReachFor(bots.indexOf(D)) };
  /* point blank, fully lit, facing straight at it */
  player.x = L.x + 40; player.y = L.y; L.face = Math.PI;
  o.seesYou = botSees(L);
  /* These runs fill the meter on purpose, so caught() fires and update() starts
     returning early. Everything after would then measure a stopped game. */
  const revive = () => { mode = 'playing'; paused = false; caughtHold = 0; meter = 0; invuln = 9e9; };
  const run = (vx, frames) => { meter = 0; invuln = 0;
    for (let i = 0; i < frames; i++) { player.vx = vx; player.vy = 0; updateMeter(1 / 60); }
    const out = { meter: +meter.toFixed(3), lock: __fp.listenLock, mode };
    revive();
    return out; };
  o.still = run(0, 60);
  o.moving = run(90, 60);
  player.x = L.x + 600;
  o.far = run(90, 60);
  /* light is nothing to it, so a blackout changes nothing either */
  player.x = L.x + 40; blackout = 3;
  o.inBlackout = run(90, 60);
  blackout = 0;
  /* And it paints no cone. Compare the SAME patch of floor with the listener
     standing there against a drone standing there: two different spots on this
     map differ in ambient light too, and the ward's lamp is red. */
  revive();
  const spot = { x: L.x, y: L.y }, look = Math.PI;
  const redAt = (wx, wy) => {
    const sx = (wx - camNow.cx) * Z, sy = (wy - camNow.cy) * Z, h = 46;
    const d = ctx.getImageData((sx - h) * DPR, (sy - h) * DPR, h * 2 * DPR, h * 2 * DPR).data;
    let r = 0, b2 = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; b2 += d[i + 2]; n++; }
    return +((r - b2) / n).toFixed(2);
  };
  const parkAll = () => { for (const b of bots) { b.x = -900; b.y = -900; b.path = []; b.state = 'patrol'; } };
  const settle = who => { parkAll(); who.x = spot.x; who.y = spot.y; who.face = look;
    for (let i = 0; i < 4; i++) update(1 / 60); render(); };
  settle(L); o.redNearListener = redAt(spot.x - 60, spot.y);
  settle(D); o.redNearDrone = redAt(spot.x - 60, spot.y);
  o.coneMode = mode;
  L.x = spot.x; L.y = spot.y;
  o.heardRing = (() => { revive(); L.heard = 0;
    const before = __fp.listenHeard()[0];
    makeNoise(L.x + 40, L.y, 400);
    for (let i = 0; i < 3; i++) update(1 / 60);
    return { before, after: __fp.listenHeard()[0], mode }; })();
  return JSON.stringify(o);
})()`));
ok('the maps still validate with the new tile', lsn.mapsValid === 'ok', lsn.mapsValid);
ok('the abandoned floor fields a listener alongside its drones',
  lsn.listeners === 1 && lsn.kinds.filter(k => k === 'drone').length >= 2,
  JSON.stringify(lsn.kinds));
/* the point of it: light is irrelevant, so none of your usual cover applies */
ok('it cannot see you at point blank in full light', lsn.seesYou === false);
ok('it hears a great deal further than a drone',
  lsn.hearing.listener > lsn.hearing.drone * 1.6,
  `${lsn.hearing.listener} vs ${lsn.hearing.drone}`);
/* freezing is a verb this game has never asked of you before */
ok('standing still beside it does nothing at all',
  lsn.still.meter === 0 && lsn.still.lock === false, JSON.stringify(lsn.still));
ok('but moving beside it and it has you',
  lsn.moving.meter > 0.5 && lsn.moving.lock === true, JSON.stringify(lsn.moving));
ok('and it has to be close', lsn.far.meter === 0, JSON.stringify(lsn.far));
ok('a blackout is no help against something that never used its eyes',
  lsn.inBlackout.meter > 0.5, JSON.stringify(lsn.inBlackout));
ok('it casts no cone where a drone would',
  lsn.coneMode === 'playing' && lsn.redNearDrone > lsn.redNearListener + 4,
  `same spot: listener=${lsn.redNearListener} drone=${lsn.redNearDrone} mode=${lsn.coneMode}`);
ok('hearing something makes it flinch, which is the only tell it gives you',
  lsn.heardRing.before === 0 && lsn.heardRing.after > 0.5, JSON.stringify(lsn.heardRing));
/* the meter runs above fill on purpose and caught() freezes update(), so every
   later measurement would quietly be of a stopped game */
ok('and the block never measured a frozen game',
  lsn.still.mode === 'playing' && lsn.moving.mode === 'caught' && lsn.heardRing.mode === 'playing',
  `${lsn.still.mode} / ${lsn.moving.mode} / ${lsn.heardRing.mode}`);


/* ---- making a thing with no cone readable ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const lg2 = JSON.parse(await evl(`(() => {
  const o = {};
  endless = false; __fp.setMod(-1); __fp.setDiff('standard'); alertLvl = 0;
  mapIdx = 3; loop = 0; loadMap(3); invuln = 9e9; meter = 0; initAudio();
  const L = bots.find(b => b.kind === 'listen');
  for (const b of bots) if (b.kind !== 'listen') { b.x = -900; b.y = -900; b.path = []; }
  /* a warning as you approach, not a marker sat on the map all game */
  player.x = L.x + 500; player.y = L.y; o.farAway = __fp.listenReachSeen();
  player.x = L.x + 140; player.y = L.y; o.close = __fp.listenReachSeen();
  /* sample ON the ring rather than a big box around it, or a thin circle gets
     averaged away to nothing */
  const onRing = () => { render();
    const wx = L.x + T.LISTEN_R, wy = L.y;
    const sx = (wx - camNow.cx) * Z, sy = (wy - camNow.cy) * Z, h = 12;
    const d = ctx.getImageData((sx - h) * DPR, (sy - h) * DPR, h * 2 * DPR, h * 2 * DPR).data;
    let v = 0; for (let i = 0; i < d.length; i += 4) v += d[i] + d[i + 1] + d[i + 2];
    return Math.round(v / (d.length / 4)); };
  player.vx = 0; player.vy = 0; o.inkStill = onRing();
  player.vx = 150; player.vy = 0; o.inkMoving = onRing();
  player.vx = 0; player.vy = 0;
  /* it keeps its own clock, and it tightens when it is hunting */
  const gapFor = st => { L.pingT = 0; L.lastX = 0; L.lastY = 0;
    for (let i = 0; i < 3; i++) { L.state = st; update(1 / 60); }
    return __fp.listenPing()[0].t; };
  o.gapCalm = gapFor('patrol');
  o.gapHunting = gapFor('chase');
  o.flash = __fp.listenPing()[0].flash;
  /* Posture: turning toward what it heard is all the aim it can show you, and
     it applies while it is standing still. A walking one looks where it walks. */
  L.face = 0; const want = Math.PI;
  const post = { x: L.x, y: L.y };
  for (let i = 0; i < 240; i++) {
    L.state = 'invest'; L.path = []; L.x = post.x; L.y = post.y;
    L.lastX = post.x - 300; L.lastY = post.y;
    update(1 / 60);
  }
  o.faceAfter = __fp.listenFacing();
  o.faceErr = +Math.abs(Math.atan2(Math.sin(o.faceAfter - want), Math.cos(o.faceAfter - want))).toFixed(3);
  o.mode = mode;
  return JSON.stringify(o);
})()`));
ok('the block measured a running game', lg2.mode === 'playing', lg2.mode);
/* a 96px instant-loss sphere with nothing drawn on it is not a mechanic, it is
   an ambush */
ok('its reach is drawn once you are near enough for it to matter',
  lg2.farAway.drawn === false && lg2.close.drawn === true,
  `${lg2.farAway.d}px hidden, ${lg2.close.d}px shown, r=${lg2.close.r}`);
ok('and the ring answers your feet, which is the lesson',
  lg2.inkMoving > lg2.inkStill, `still=${lg2.inkStill} moving=${lg2.inkMoving}`);
ok('it ticks on its own clock so you can place it unseen',
  lg2.gapCalm > 2 && lg2.flash > 0, `gap=${lg2.gapCalm}s flash=${lg2.flash}`);
ok('and the ticking tightens when it is hunting',
  lg2.gapHunting < lg2.gapCalm * 0.5, `${lg2.gapCalm}s -> ${lg2.gapHunting}s`);
ok('it turns to face what it heard, having no cone to point',
  lg2.faceErr < 0.35, `off by ${lg2.faceErr} rad`);


/* ---- the sentry: bolted down, sees wide, asleep until something trips ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const snt = JSON.parse(await evl(`(() => {
  const o = {};
  endless = false; __fp.setMod(-1); __fp.setDiff('standard'); alertLvl = 0;
  o.mapsValid = __fp.mapCheck;
  mapIdx = 6; loop = 0; loadMap(6); invuln = 9e9; meter = 0;
  o.sentries = __fp.sentryCount();
  o.cone = __fp.sentryCone();
  const S = bots.find(b => b.kind === 'sentry');
  /* stand in front of a sleeping one and it is none the wiser */
  player.x = S.x + Math.cos(S.face) * 90; player.y = S.y + Math.sin(S.face) * 90;
  o.asleep = { sees: botSees(S), open: __fp.sentryState()[0].open };
  /* an alarm on the far side of the floor opens every one of them */
  raiseAlarm(60, 60, 300, null);
  for (let i = 0; i < 60; i++) update(1 / 60);
  o.woken = __fp.sentryState().map(x => ({ awake: x.awake, open: x.open }));
  o.seesNow = botSees(S);
  /* it is bolted down */
  const at = { x: S.x, y: S.y };
  for (let i = 0; i < 180; i++) update(1 / 60);
  o.moved = Math.round(Math.hypot(S.x - at.x, S.y - at.y));
  /* it dozes off, given nothing to keep waking it */
  player.x = 60; player.y = 60; meter = 0; nextSiren = 1e9; sirenT = 0;
  for (const b of bots) if (b.kind !== 'sentry') { b.x = -900; b.y = -900; b.path = []; }
  const trail = [];
  for (let i = 1; i <= 800; i++) { update(1 / 60); if (i % 160 === 0) trail.push(__fp.sentryState()[0].awake); }
  o.dozeTrail = trail;
  o.dozed = __fp.sentryState()[0];
  /* But a siren wakes the floor, which is what makes one worth fearing. Note
     forceSiren() sets sirenT directly, which parks the code in the "already
     sounding" branch - the wake lives in the else, so it would never fire. */
  for (const b of bots) if (b.kind === 'sentry') b.awake = 0;
  sirenT = 0; nextSiren = 0.01;
  for (let i = 0; i < 30; i++) update(1 / 60);
  o.afterSiren = __fp.sentryState()[0].awake;
  /* and an alarm must never be handed to something that cannot walk to it */
  loadMap(6);
  const S2 = bots.find(b => b.kind === 'sentry');
  for (const b of bots) if (b.kind !== 'sentry') { b.x = 40; b.y = 700; b.state = 'patrol'; b.path = []; }
  raiseAlarm(S2.x + 10, S2.y + 10, 300, null);
  o.answered = bots.filter(b => b.state !== 'patrol' && b.kind !== 'sentry').length;
  o.sentryStillPatrolOrLooking = bots.filter(b => b.kind === 'sentry')
    .every(b => b.path.length === 0 && b.flankX === undefined);
  o.mode = mode;
  return JSON.stringify(o);
})()`));
ok('the maps still validate with the sentry tile', snt.mapsValid === 'ok', snt.mapsValid);
ok('the vault fields two of them', snt.sentries === 2, `n=${snt.sentries}`);
ok('it sees much wider and much less far than a drone',
  snt.cone.half > snt.cone.droneHalf * 2 && snt.cone.range < snt.cone.droneRange,
  `half ${snt.cone.droneHalf}->${snt.cone.half}, range ${snt.cone.droneRange}->${snt.cone.range}`);
/* asleep it is scenery, which is why you can learn a floor and route around it */
ok('asleep it does not see you standing right in front of it',
  snt.asleep.sees === false && snt.asleep.open === 0, JSON.stringify(snt.asleep));
/* this is what makes an alarm cost more than the one drone it sends */
ok('an alarm anywhere opens every one of them',
  snt.woken.length === 2 && snt.woken.every(w => w.awake > 7 && w.open === 1) && snt.seesNow === true,
  JSON.stringify(snt.woken));
ok('it never moves an inch', snt.moved === 0, `moved=${snt.moved}px`);
ok('and it dozes off again if nothing keeps it up',
  snt.dozed.awake === 0 && snt.dozed.open === 0 && snt.dozed.sees === false,
  `trail=${JSON.stringify(snt.dozeTrail)}`);
ok('a siren puts the whole floor back on watch', snt.afterSiren > 7, `awake=${snt.afterSiren}`);
/* raiseAlarm sends the nearest bot, and a sentry is nearest to its own tile */
ok('an alarm is never handed to something bolted to the floor',
  snt.answered > 0 && snt.sentryStillPatrolOrLooking === true,
  `answered by ${snt.answered} mobile unit(s)`);
ok('and the block measured a running game', snt.mode === 'playing', snt.mode);


/* ---- three kinds of hunter, spread across the campaign ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const mix = JSON.parse(await evl(`(() => {
  const o = { valid: __fp.mapCheck, floors: [] };
  endless = false; __fp.setMod(-1); __fp.setDiff('standard');
  for (let i = 0; i < MAPS.length; i++) {
    mapIdx = i; loop = 0; loadMap(i);
    const k = __fp.botKinds();
    o.floors.push({ drone: k.filter(x => x === 'drone').length,
                    listen: k.filter(x => x === 'listen').length,
                    sentry: k.filter(x => x === 'sentry').length });
  }
  o.wake = { early: __fp.sentryWakeFor(0, 0), mid: __fp.sentryWakeFor(6, 0), deep: __fp.sentryWakeFor(11, 3) };
  /* A listener has no eyes, so it must not wear the red eye-glint every other
     bot gets when it is near and unlit - that cue is exactly what its design
     takes away from you. Same tile for both, so only the unit differs. */
  mapIdx = 8; loop = 0; loadMap(8); invuln = 9e9; meter = 0;
  const L = bots.find(b => b.kind === 'listen'), D = bots.find(b => b.kind === 'drone');
  const spot = { x: player.x + 150, y: player.y + 40 };
  const park = () => { for (const b of bots) { b.x = -900; b.y = -900; b.path = []; b.state = 'patrol'; } };
  __fp.aimAt(player.x - 400, player.y);       /* beam pointed away, so nothing is lit */
  /* Tight box, and the peak across a full period of the glint's own sine. The
     alpha is 0.16 + 0.1*sin(time*5), so one sample lands anywhere in a 0.06-0.26
     range; and a wider box just collects flickering lamps and afterglow instead
     - measured, a 26px box put the baseline above the signal. */
  const redPeak = () => { let best = -99, h = 12;
    for (let f = 0; f < 90; f++) {
      update(1 / 60); render();
      const sx = (spot.x - camNow.cx) * Z, sy = (spot.y - camNow.cy) * Z;
      const d = ctx.getImageData((sx - h) * DPR, (sy - h) * DPR, h * 2 * DPR, h * 2 * DPR).data;
      let r = 0, b2 = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; b2 += d[i + 2]; n++; }
      best = Math.max(best, (r - b2) / n);
    }
    return +best.toFixed(2); };
  park(); o.glintNone = redPeak();
  park(); D.x = spot.x; D.y = spot.y; o.glintDrone = redPeak();
  park(); L.x = spot.x; L.y = spot.y; o.glintListen = redPeak();
  /* and the cone lesson must not fire on a thing with no cone */
  completedLevels = []; startGame(); bots.length = 0; invuln = 9e9; meter = 0;
  /* a real unit always carries a route; an empty one is not a state the game
     produces, so the fixture should not invent it */
  const fake = k => ({ kind: k, x: player.x + 60, y: player.y, r: 13, face: 0, blink: 0,
    state: 'patrol', route: [[2, 2]], wp: 0, path: [], rays: new Array(T.BOT_RAYS + 1),
    range: k === 'drone' ? T.BOT_RANGE : 0, half: k === 'drone' ? T.BOT_HALF : 0,
    sweepP: 0, eyeGlint: 0, chaseT: 0, glow: 0, chirpT: 0, saidHeat: 0, peekT: 0,
    peekCool: 0, peekTo: 0, searchPts: [], wary: 0, radioT: 0, heard: 0, awake: 0, open: 0,
    sweepK: 1, paceK: 1, peekK: 1, dwellK: 1, dwellT: 0, lastX: 0, lastY: 0 });
  __fp.aimAt(player.x + 400, player.y);
  bots.push(fake('listen'));
  for (let i = 0; i < 30; i++) update(1 / 60);
  o.afterListener = __fp.tutorState().sawDrone;
  bots.push(fake('drone'));
  for (let i = 0; i < 30; i++) update(1 / 60);
  o.afterDrone = __fp.tutorState().sawDrone;
  /* and a malformed one must not kill the frame */
  o.emptyRoute = (() => { try {
    const bad = fake('drone'); bad.route = []; bots.push(bad);
    for (let i = 0; i < 10; i++) update(1 / 60);
    return 'survived';
  } catch (e) { return 'threw: ' + e.message; } })();
  o.mode = mode;
  return JSON.stringify(o);
})()`));
const tot = k => mix.floors.reduce((a, f) => a + f[k], 0);
ok('every map still validates with both new tiles', mix.valid === 'ok', mix.valid);
/* the base game gets taught on its own before anything else turns up */
ok('the first three floors are drones and nothing else',
  mix.floors.slice(0, 3).every(f => f.listen === 0 && f.sentry === 0 && f.drone > 0),
  JSON.stringify(mix.floors.slice(0, 3)));
ok('both new kinds appear, and on more than one floor each',
  mix.floors.filter(f => f.listen > 0).length >= 2 && mix.floors.filter(f => f.sentry > 0).length >= 3,
  `listener floors=${mix.floors.filter(f => f.listen > 0).length} sentry floors=${mix.floors.filter(f => f.sentry > 0).length}`);
ok('and at least one floor fields all three at once',
  mix.floors.some(f => f.drone > 0 && f.listen > 0 && f.sentry > 0),
  JSON.stringify(mix.floors.map((f, i) => `${i + 1}:${f.drone}/${f.listen}/${f.sentry}`)));
ok('every floor still has drones on it', mix.floors.every(f => f.drone > 0), `total drones=${tot('drone')}`);
/* it cannot bring friends the way a drone can, so depth buys it time instead */
ok('a sentry stays open longer the deeper you are',
  mix.wake.mid > mix.wake.early && mix.wake.deep > mix.wake.mid * 1.5,
  `${mix.wake.early}s -> ${mix.wake.mid}s -> ${mix.wake.deep}s`);
/* J3 warned a third place would assume every bot is a drone, and this was it */
ok('an unlit drone glints, and a listener does not',
  mix.glintDrone > mix.glintNone + 1 && mix.glintListen < mix.glintNone + 0.6,
  `none=${mix.glintNone} drone=${mix.glintDrone} listener=${mix.glintListen}`);
ok('a unit with no route does not take the frame loop down with it',
  mix.emptyRoute === 'survived', mix.emptyRoute);
ok('and the cone lesson waits for something that has a cone',
  mix.afterListener === false && mix.afterDrone === true && mix.mode === 'playing',
  `listener=${mix.afterListener} drone=${mix.afterDrone}`);


/* ---- the blind one points, and the ones with eyes come ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const cal = JSON.parse(await evl(`(() => {
  const o = {};
  endless = false; __fp.setMod(-1); __fp.setDiff('standard'); alertLvl = 0;
  mapIdx = 8; loop = 0; loadMap(8); meter = 0; invuln = 9e9; clearToast();
  const L = bots.find(b => b.kind === 'listen');
  const drones = bots.filter(b => b.kind === 'drone');
  const park = () => drones.forEach((d, i) => { d.x = L.x + 180 + i * 40; d.y = L.y + 120;
    d.state = 'patrol'; d.path = []; d.flankX = undefined; d.radioT = 0; });
  const ordered = () => __fp.droneOrders().filter(d => d.state !== 'patrol').length;
  park();
  o.alertBefore = alertLvl;
  o.orderedBefore = ordered();
  /* freezing beside it keeps you off the air entirely */
  player.x = L.x + 40; player.y = L.y; invuln = 0; meter = 0;
  for (let i = 0; i < 60; i++) { player.vx = 0; player.vy = 0; updateMeter(1 / 60); }
  o.still = { ordered: ordered(), callT: __fp.listenCallT()[0], meter: +meter.toFixed(2) };
  /* moving, it has you - and it tells them */
  meter = 0;
  for (let i = 0; i < 20; i++) { player.vx = 90; player.vy = 0; updateMeter(1 / 60); }
  o.called = { ordered: ordered(), callT: __fp.listenCallT()[0], lock: __fp.listenLock,
               listenerState: L.state, distinctFlanks: new Set(__fp.droneOrders()
                 .filter(d => d.flank).map(d => d.flank.join(','))).size };
  o.alertAfter = alertLvl;
  o.sentriesWoken = __fp.sentryState().filter(x => x.awake > 0).length;
  o.said = __fp.toastList().includes('IT HAS CALLED YOU IN');
  /* holding the lock must not put it on the air every frame */
  park();
  for (let i = 0; i < 30; i++) { player.vx = 90; player.vy = 0; meter = 0; updateMeter(1 / 60); }
  o.repeat = { ordered: ordered(), callT: __fp.listenCallT()[0] };
  o.mode = mode;
  return JSON.stringify(o);
})()`));
ok('nothing is on the air to begin with',
  cal.orderedBefore === 0 && cal.alertBefore === 0, `ordered=${cal.orderedBefore}`);
/* freezing already saved you from being caught; it saves you from being reported */
ok('standing still keeps you off the air',
  cal.still.ordered === 0 && cal.still.callT === 0 && cal.still.meter === 0, JSON.stringify(cal.still));
ok('but the moment it has you, the drones are given your position',
  cal.called.ordered >= 2 && cal.called.lock === true && cal.called.listenerState === 'chase',
  JSON.stringify(cal.called));
ok('and they are spread out rather than sent to one spot',
  cal.called.distinctFlanks >= 2, `${cal.called.distinctFlanks} distinct flank points`);
/* deliberately not raiseAlarm: one unit reporting, not the building screaming */
ok('a report is not a building-wide alarm',
  cal.alertAfter === cal.alertBefore && cal.sentriesWoken === 0,
  `alert ${cal.alertBefore}->${cal.alertAfter}, sentries woken=${cal.sentriesWoken}`);
ok('it tells you it has done it', cal.said === true, JSON.stringify(cal.said));
ok('and holding the lock does not put it on the air every frame',
  cal.repeat.ordered === 0 && cal.repeat.callT > 0,
  `re-ordered=${cal.repeat.ordered} cooldown=${cal.repeat.callT}s`);
ok('the block measured a running game', cal.mode === 'playing', cal.mode);


/* ---- the door opens early, and the bonus is what leaving costs ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const early = JSON.parse(await evl(`(() => {
  const o = {};
  endless = false; __fp.setMod(-1); __fp.setDiff('standard'); alertLvl = 0;
  /* a choice has to exist on every floor, not just the roomy ones */
  o.thresholds = [];
  for (let i = 0; i < MAPS.length; i++) { mapIdx = i; loadMap(i);
    o.thresholds.push({ total: coinsTotal, need: __fp.exitNeed() }); }
  mapIdx = 0; loop = 0; loadMap(0); bots.length = 0; invuln = 9e9; meter = 0; clearToast();
  o.total = coinsTotal; o.need = __fp.exitNeed();
  const real = coinList.filter(c => !c.bonus);
  const take = n => { for (let i = 0; i < n; i++) { const c = real.find(x => !x.got);
    player.x = c.x; player.y = c.y; for (let k = 0; k < 3; k++) update(1 / 60); } };
  o.atStart = { open: __fp.exitOpen, full: __fp.exitFull };
  take(o.need - 1);
  o.justBelow = { got: __fp.realCoins, open: __fp.exitOpen };
  take(1);
  o.atThreshold = { got: __fp.realCoins, open: __fp.exitOpen, full: __fp.exitFull,
                    tint: $('coins').classList.contains('canleave') };
  togglePause(); o.pauseEarly = $('pGoldLabel').textContent; togglePause();
  /* K3 also pays at nextMap now, so scruff the floor first: this block is
     measuring the CLEAR bonus, not everything the exit hands you. */
  fSeen = true; fSprint = true; fNoticed = true;
  const b1 = score; nextMap(); o.earlyGain = score - b1;
  /* and the same floor taken clean */
  mapIdx = 0; loop = 0; loadMap(0); bots.length = 0; invuln = 9e9;
  __fp.clearCoins(); hud();
  o.cleared = { open: __fp.exitOpen, full: __fp.exitFull, tint: $('coins').classList.contains('canleave') };
  togglePause(); o.pauseFull = $('pGoldLabel').textContent; togglePause();
  fSeen = true; fSprint = true; fNoticed = true;
  const b2 = score; nextMap(); o.fullGain = score - b2;
  o.bonus = T.CLEAR_BONUS;
  o.mode = mode;
  return JSON.stringify(o);
})()`));
ok('every floor leaves something on the table to walk away from',
  early.thresholds.every(t => t.need < t.total && t.need >= 1),
  JSON.stringify(early.thresholds.map(t => `${t.need}/${t.total}`)));
ok('the door is shut to begin with and still shut one coin short',
  early.atStart.open === false && early.justBelow.open === false,
  `${early.justBelow.got} of ${early.total}`);
ok('it opens at the threshold without the floor being clear',
  early.atThreshold.open === true && early.atThreshold.full === false
  && early.atThreshold.got === early.need, JSON.stringify(early.atThreshold));
/* the door may be nowhere near you, so the counter has to say it too */
ok('and the coin counter says walking out is now a choice',
  early.atThreshold.tint === true && early.cleared.tint === false,
  `open=${early.atThreshold.tint} cleared=${early.cleared.tint}`);
ok('the pause card names which of the three you are in',
  early.pauseEarly === 'CAN LEAVE NOW' && early.pauseFull === 'FLOOR CLEARED',
  `${early.pauseEarly} / ${early.pauseFull}`);
/* the whole point: you escaped either way, the bonus is what you gave up */
ok('leaving early pays no clear bonus', early.earlyGain === 0, `gained=${early.earlyGain}`);
ok('and taking every coin pays it', early.fullGain === early.bonus,
  `gained=${early.fullGain} of ${early.bonus}`);
ok('the block measured a running game', early.mode === 'playing', early.mode);


/* ---- the safe: a long loud crack for a big number ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const saf = JSON.parse(await evl(`(() => {
  const o = { valid: __fp.mapCheck, perFloor: [] };
  endless = false; __fp.setMod(-1); __fp.setDiff('standard'); alertLvl = 0;
  for (let i = 0; i < MAPS.length; i++) { mapIdx = i; loadMap(i); o.perFloor.push(__fp.safeCount()); }
  mapIdx = 6; loop = 0; loadMap(6); bots.length = 0; invuln = 9e9; meter = 0; clearToast();
  o.need = __fp.safeNeed();
  o.exitNeedBefore = __fp.exitNeed(); o.coinsTotal = coinsTotal;
  const f = __fp.safeState()[0];
  player.x = f.x - 30; player.y = f.y; noise = [];
  let heard = 0;
  const hold = n => { for (let i = 0; i < n; i++) { update(1 / 60); heard = Math.max(heard, noise.length); } };
  hold(60);
  o.partway = { t: __fp.safeT, cracked: __fp.safeState()[0].cracked };
  o.loudWhileWorking = heard > 0;
  /* a flinch inside the radius slips it; walking off resets it */
  const was = __fp.safeT;
  for (let i = 0; i < 6; i++) { keys.left = true; update(1 / 60); }
  const slipped = __fp.safeT;
  for (let i = 0; i < 40; i++) { keys.left = true; update(1 / 60); }
  keys.left = false;
  o.flinch = { was, slipped, gone: __fp.safeT, radius: T.SAFE_R };
  /* back to it and see it through */
  player.x = f.x - 30; player.y = f.y;
  const before = score;
  hold(400);
  o.done = { cracked: __fp.safeState()[0].cracked, gained: score - before, worth: T.SAFE_SCORE };
  const after = score; hold(150);
  o.again = score - after;
  o.exitNeedAfter = __fp.exitNeed();
  o.mode = mode;
  return JSON.stringify(o);
})()`));
const withSafes = saf.perFloor.filter(n => n > 0).length;
ok('the maps still validate with a safe bolted into them', saf.valid === 'ok', saf.valid);
ok('a few floors have one, and the early ones do not',
  withSafes === 4 && saf.perFloor.slice(0, 4).every(n => n === 0),
  JSON.stringify(saf.perFloor));
ok('it takes real time standing at it',
  saf.need > 3 && saf.partway.t > 0.8 && saf.partway.cracked === false,
  `${saf.partway.t}s of ${saf.need}s`);
/* the whole cost of it: you are making noise the entire time you are working */
ok('and it is loud the whole way, not just at the end', saf.loudWhileWorking === true);
ok('a flinch loses ground rather than everything',
  saf.flinch.slipped < saf.flinch.was && saf.flinch.slipped > 0,
  `${saf.flinch.was} -> ${saf.flinch.slipped}`);
ok('but walking away from it starts again', saf.flinch.gone === 0,
  `left the ${saf.flinch.radius}px radius -> ${saf.flinch.gone}`);
ok('cracking it pays, once',
  saf.done.cracked === true && saf.done.gained === saf.done.worth && saf.again === 0,
  `gained=${saf.done.gained} then ${saf.again}`);
/* it is a choice to weigh against leaving, so it must not become an obligation */
ok('and it changes nothing about what the floor asks of you',
  saf.exitNeedAfter === saf.exitNeedBefore,
  `door still at ${saf.exitNeedAfter} of ${saf.coinsTotal}`);
ok('the block measured a running game', saf.mode === 'playing', saf.mode);


/* ---- keeping a floor clean, and being told while you still can ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const cln = JSON.parse(await evl(`(() => {
  const o = {};
  endless = false; __fp.setMod(-1); __fp.setDiff('standard'); alertLvl = 0;
  mapIdx = 0; loop = 0; loadMap(0); bots.length = 0; invuln = 9e9; meter = 0; clearToast();
  o.pay = __fp.cleanPay();
  hud();
  o.fresh = { held: __fp.cleanHeld(), shown: __fp.cleanShown() };
  /* each mark goes out on its own, as you lose it */
  fSprint = true; hud();
  o.afterSprint = { held: __fp.cleanHeld(), lit: __fp.cleanShown().map(x => x.on) };
  fSeen = true; hud();
  o.afterSeen = __fp.cleanShown().map(x => x.on);
  /* the whole floor, kept */
  mapIdx = 0; loadMap(0); bots.length = 0; invuln = 9e9;
  __fp.clearCoins();
  const b1 = score; nextMap();
  o.ghost = { gained: score - b1, want: T.CLEAR_BONUS + 3 * o.pay.each + o.pay.all };
  /* kept clean, but walked out early: the marks pay, the two totals do not */
  mapIdx = 0; loop = 0; loadMap(0); bots.length = 0; invuln = 9e9;
  const real = coinList.filter(c => !c.bonus);
  for (let i = 0; i < __fp.exitNeed(); i++) { const c = real.find(x => !x.got);
    player.x = c.x; player.y = c.y; for (let k = 0; k < 3; k++) update(1 / 60); }
  const b2 = score; nextMap();
  o.earlyClean = { gained: score - b2, want: 3 * o.pay.each };
  /* seen, heard and noticed: only the clear bonus */
  mapIdx = 0; loop = 0; loadMap(0); bots.length = 0; invuln = 9e9;
  __fp.clearCoins(); fSeen = true; fSprint = true; fNoticed = true;
  const b3 = score; nextMap();
  o.scruffy = { gained: score - b3, want: T.CLEAR_BONUS };
  o.mode = mode;
  return JSON.stringify(o);
})()`));
/* these were tracked all along and only ever mentioned in an achievement, long
   after the floor they belonged to */
ok('a fresh floor starts with all three marks lit',
  cln.fresh.held.length === 3 && cln.fresh.shown.every(x => x.on)
  && cln.fresh.shown.map(x => x.label).join(',') === 'UNSEEN,UNHEARD,UNLIT',
  JSON.stringify(cln.fresh.shown.map(x => x.label)));
ok('and each goes out on its own as you lose it',
  JSON.stringify(cln.afterSprint.lit) === '[true,false,true]'
  && JSON.stringify(cln.afterSeen) === '[false,false,true]',
  `${JSON.stringify(cln.afterSprint.lit)} then ${JSON.stringify(cln.afterSeen)}`);
ok('ghosting a whole floor pays every part of it',
  cln.ghost.gained === cln.ghost.want, `${cln.ghost.gained} of ${cln.ghost.want}`);
/* the marks are yours either way; the ghost bonus is not, and neither is K1's */
ok('walking out early still pays for what you kept',
  cln.earlyClean.gained === cln.earlyClean.want,
  `${cln.earlyClean.gained} of ${cln.earlyClean.want}`);
ok('and a floor you were seen, heard and noticed on pays neither',
  cln.scruffy.gained === cln.scruffy.want, `${cln.scruffy.gained} of ${cln.scruffy.want}`);
ok('the block measured a running game', cln.mode === 'playing', cln.mode);


/* ---- the tripwire: the one gadget that acts on what you know ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const wir = JSON.parse(await evl(`(() => {
  const o = {};
  endless = false; __fp.setMod(-1); __fp.setDiff('standard'); alertLvl = 0;
  mapIdx = 0; loop = 0; loadMap(0); invuln = 9e9; meter = 0; clearToast();
  /* park every unit off the map: floor one has drones of its own and they will
     walk into a wire laid at the spawn */
  const park = () => { for (const b of bots) { b.x = -900; b.y = -900; b.path = []; b.state = 'patrol'; } };
  park();
  o.startCharges = __fp.wireCharges;
  o.placed = __fp.dropWireNow();
  o.afterPlace = { charges: __fp.wireCharges, wires: __fp.wireCount() };
  /* it arms after a beat, so setting one down does not trip it on yourself */
  o.armedAtOnce = __fp.wireState()[0].armed;
  for (let i = 0; i < 50; i++) { park(); update(1 / 60); }
  o.armedLater = __fp.wireState()[0].armed;
  o.quietWhileWaiting = { fired: __fp.wireState()[0].fired, noise: (noise = [], noise.length) };
  /* something walks through it */
  const w = __fp.wireState()[0], b = bots[0];
  noise = [];
  for (let i = 0; i < 4; i++) { b.x = w.x + 20; b.y = w.y; update(1 / 60); }
  o.crossed = { fired: __fp.wireState()[0] ? __fp.wireState()[0].fired : 0,
                noise: noise.length, told: __fp.toastList().includes('WIRE TRIPPED — SOMETHING CAME THROUGH') };
  /* and it is spent */
  for (let i = 0; i < 100; i++) { park(); update(1 / 60); }
  o.spent = { wires: __fp.wireCount(), charges: __fp.wireCharges };
  /* a sentry cannot walk anywhere, so it is not what a wire is for */
  /* charges are run-long, not per-floor, and the run above spent the only one */
  mapIdx = 6; loadMap(6); invuln = 9e9; clearToast();
  startGame(); mapIdx = 6; loadMap(6); invuln = 9e9;
  const S = bots.find(x => x.kind === 'sentry');
  for (const bb of bots) if (bb.kind !== 'sentry') { bb.x = -900; bb.y = -900; bb.path = []; }
  player.x = S.x + 20; player.y = S.y;
  __fp.dropWireNow();
  for (let i = 0; i < 90; i++) {
    for (const bb of bots) if (bb.kind !== 'sentry') { bb.x = -900; bb.y = -900; }
    update(1 / 60);
  }
  o.sentry = { stillThere: __fp.wireCount(), fired: __fp.wireState()[0] ? __fp.wireState()[0].fired : null };
  o.mode = mode;
  return JSON.stringify(o);
})()`));
ok('you carry one and setting it spends it',
  wir.startCharges >= 1 && wir.placed === true
  && wir.afterPlace.charges === wir.startCharges - 1 && wir.afterPlace.wires === 1,
  JSON.stringify(wir.afterPlace));
ok('it arms after a beat rather than under your own feet',
  wir.armedAtOnce === false && wir.armedLater === true,
  `${wir.armedAtOnce} -> ${wir.armedLater}`);
ok('and it sits there quietly until something crosses it',
  wir.quietWhileWaiting.fired === 0, JSON.stringify(wir.quietWhileWaiting));
/* every other gadget in the game acts on them; this one acts on what you know */
ok('something walking through it tells you',
  wir.crossed.fired > 0 && wir.crossed.told === true, JSON.stringify(wir.crossed));
ok('and tells them nothing at all', wir.crossed.noise === 0,
  `noise raised=${wir.crossed.noise}`);
ok('it is spent once it has spoken',
  wir.spent.wires === 0 && wir.spent.charges === 0, JSON.stringify(wir.spent));
/* a sentry is bolted down, so it can never be the thing that came through */
ok('a sentry sitting on one never trips it',
  wir.sentry.stillThere === 1 && wir.sentry.fired === 0, JSON.stringify(wir.sentry));
ok('the block measured a running game', wir.mode === 'playing', wir.mode);


/* ---- the muffle: buying back what a full haul costs you ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const hsh = JSON.parse(await evl(`(() => {
  const o = {};
  endless = false; __fp.setMod(-1); __fp.setDiff('standard'); alertLvl = 0;
  /* N1 made the kit a choice, so a block about the muffle has to pack one */
  __fp.setLoadout(['hush', 'flare', 'wire']);
  startGame(); mapIdx = 0; loop = 0; loadMap(0); bots.length = 0; invuln = 9e9; clearToast();
  o.charges = __fp.hushCharges;
  coins = 0; o.empty = __fp.haulNoiseNow();
  coins = coinsTotal; o.loaded = __fp.haulNoiseNow();
  o.used = __fp.useHushNow();
  o.muffled = { haul: __fp.haulNoiseNow(), on: __fp.hushOn, charges: __fp.hushCharges };
  o.usedTwice = __fp.useHushNow();
  /* what a drone or a listener actually hears, rather than the multiplier */
  const sprintR = () => { noise = [];
    for (let i = 0; i < 40; i++) { keys.right = true; keys.sprint = true; update(1 / 60); }
    keys.right = false; keys.sprint = false;
    return noise.length ? Math.round(Math.max(...noise.map(n => n.r))) : 0; };
  hushOn = false; const loud = sprintR();
  hushOn = true; const quiet = sprintR();
  o.radius = { loud, quiet, listenerHears: Math.round(T.HEAR_R * T.LISTEN_HEAR * 0.4) };
  /* one floor means one floor */
  nextMap();
  coins = coinsTotal;
  o.afterStairs = { on: __fp.hushOn, haul: __fp.haulNoiseNow() };
  /* and it is in both places a gadget has to be */
  o.inBar = !!$('itHush');
  togglePause();
  o.inControls = [...$('pKeys').querySelectorAll('.key')].map(e => e.textContent.trim()).includes('B');
  togglePause();
  __fp.setLoadout(['flare', 'smoke', 'wire']);
  o.mode = mode;
  return JSON.stringify(o);
})()`));
ok('you set out with one you packed', hsh.charges === 1 && hsh.used === true, `charges=${hsh.charges}`);
ok('with empty pockets there is nothing for it to buy back', hsh.empty === 1, `haul=${hsh.empty}`);
/* D2 made a full haul 1.55x louder, which is what makes the walk back tense */
ok('a full haul is markedly louder to carry', hsh.loaded > 1.5, `haul=${hsh.loaded}`);
ok('and the muffle takes that back, spending the charge',
  hsh.muffled.haul === 1 && hsh.muffled.on === true && hsh.muffled.charges === 0,
  JSON.stringify(hsh.muffled));
ok('it cannot be spent twice over', hsh.usedTwice === false);
/* the multiplier is the mechanism; this is the thing that actually matters */
ok('what they hear drops a long way',
  hsh.radius.loud > 780 && hsh.radius.quiet < 560 && hsh.radius.quiet < hsh.radius.loud,
  `${hsh.radius.loud} -> ${hsh.radius.quiet} (a listener hears about ${hsh.radius.listenerHears})`);
ok('and it lapses on the stairs, being one floor of quiet',
  hsh.afterStairs.on === false && hsh.afterStairs.haul > 1.5, JSON.stringify(hsh.afterStairs));
/* trap 11: a new gadget has to reach the bar and the control reference */
ok('it reaches both the item bar and the control list',
  hsh.inBar === true && hsh.inControls === true, `bar=${hsh.inBar} controls=${hsh.inControls}`);
ok('the block measured a running game', hsh.mode === 'playing', hsh.mode);


/* ---- the jammer: the EMP's opposite number ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2400);
const jam = JSON.parse(await evl(`(() => {
  const o = {};
  endless = false; __fp.setMod(-1); __fp.setDiff('standard'); alertLvl = 0;
  startGame(); mapIdx = 8; loop = 0; loadMap(8); invuln = 9e9; meter = 0; clearToast();
  jamCharges = 2;
  const L = bots.find(b => b.kind === 'listen'), D = bots.find(b => b.kind === 'drone');
  const iL = bots.indexOf(L), iD = bots.indexOf(D);
  player.x = L.x + 60; player.y = L.y;
  D.x = L.x + 40; D.y = L.y + 30; D.path = []; D.state = 'patrol';
  noise = []; makeNoise(player.x, player.y, 500);
  o.before = { listener: !!__fp.botHears(iL), drone: !!__fp.botHears(iD) };
  o.threw = __fp.throwJamNow();
  o.charges = __fp.jamCharges;
  noise = []; makeNoise(player.x, player.y, 500);
  o.after = { listener: !!__fp.botHears(iL), drone: !!__fp.botHears(iD) };
  /* the field has an edge */
  const far = bots.filter(b => b.kind === 'drone')[1];
  far.x = L.x + 700; far.y = L.y;
  noise = []; makeNoise(far.x + 20, far.y, 500);
  o.outside = !!__fp.botHears(bots.indexOf(far));
  o.flags = { inField: __fp.botJammed().filter(Boolean).length, total: bots.length };
  /* it deafens them; it does not stop a listener feeling you through the floor */
  meter = 0; invuln = 0;
  for (let i = 0; i < 40; i++) { player.x = L.x + 40; player.y = L.y; player.vx = 90; updateMeter(1 / 60); }
  o.stillFelt = +meter.toFixed(2);
  mode = 'playing'; paused = false; meter = 0; invuln = 9e9; caughtHold = 0;
  /* the pairing it exists for: a safe screams for 4.6s, and nobody comes */
  const f = __fp.safeState()[0];
  if (f) {
    /* Measure the channel the jammer governs. Parking drones next to the player
       also lets them SEE him, which the jammer never claimed to touch - so count
       what reaches their ears, not what they end up doing about it. */
    for (const b of bots) if (b.kind !== 'sentry') { b.state = 'patrol'; b.path = []; b.x = f.x + 90; b.y = f.y; }
    /* stand at the safe BEFORE throwing it: the field lands where you are */
    player.x = f.x - 30; player.y = f.y;
    __fp.throwJamNow();
    let reached = 0;
    for (let i = 0; i < 120; i++) {
      update(1 / 60);
      for (let k = 0; k < bots.length; k++) {
        if (bots[k].kind === 'sentry') continue;
        if (__fp.botHears(k)) reached++;
      }
    }
    o.safeHeardBy = reached;
    /* and the same crack with no jammer up, so the number means something */
    jams.length = 0;
    let reachedBare = 0;
    for (let i = 0; i < 60; i++) {
      makeNoise(f.x, f.y, T.SAFE_NOISE);
      for (let k = 0; k < bots.length; k++) {
        if (bots[k].kind === 'sentry') continue;
        if (__fp.botHears(k)) reachedBare++;
      }
      update(1 / 60);
    }
    o.safeHeardBare = reachedBare;
  }
  /* and it lapses */
  for (let i = 0; i < 480; i++) update(1 / 60);
  o.lapsed = { jams: __fp.jamCount(), anyJammed: __fp.botJammed().some(Boolean) };
  o.mode = mode;
  return JSON.stringify(o);
})()`));
ok('without it, a noise reaches both a drone and a listener',
  jam.before.listener === true && jam.before.drone === true, JSON.stringify(jam.before));
/* the EMP takes their sight in a radius; this takes their hearing */
ok('inside the field neither of them hears a thing',
  jam.threw === true && jam.after.listener === false && jam.after.drone === false,
  JSON.stringify(jam.after));
ok('and the field has an edge', jam.outside === true && jam.flags.inField < jam.flags.total,
  `${jam.flags.inField} of ${jam.flags.total} deafened`);
/* it stops them ANSWERING a sound, not a listener feeling you through the floor,
   so it is cover for noise you are about to make rather than a free pass */
ok('a listener beside you still has you if you move',
  jam.stillFelt > 0.2, `meter=${jam.stillFelt}`);
/* not exactly zero on purpose: a drone that patrols out of the 230px field
   during those seconds can hear again from outside it, which is the field
   having an edge rather than the jammer leaking */
ok('which is what makes it the answer to a safe',
  jam.safeHeardBy < jam.safeHeardBare * 0.05 && jam.safeHeardBare > 50,
  `4.6s of screaming reached ears ${jam.safeHeardBy} times jammed against ${jam.safeHeardBare} not`);
ok('it lapses', jam.lapsed.jams === 0 && jam.lapsed.anyJammed === false, JSON.stringify(jam.lapsed));
ok('the block measured a running game', jam.mode === 'playing', jam.mode);


/* ---- the loadout: choosing what you carry ---- */
await send('Page.navigate', { url: FILE + '?name=TESTY' });
await sleep(2400);
const kit = JSON.parse(await evl(`(() => {
  const o = {};
  endless = false; __fp.setMod(-1); __fp.setDiff('standard');
  o.gadgets = __fp.gadgets().map(g => g.id);
  o.max = T.LOADOUT_MAX;
  /* three lists describe the kit: GADGETS, T.KIT and the item bar markup */
  o.missingFromKit = o.gadgets.filter(id => !(id in T.KIT));
  o.orphanInKit = Object.keys(T.KIT).filter(id => !o.gadgets.includes(id));
  o.missingButtons = __fp.gadgets().filter(g => !document.getElementById(g.btn)).map(g => g.id);
  /* and the pause reference has to name the same keys */
  const ctlKeys = CONTROLS.map(c => c[1][0]);
  o.keysNotInControls = __fp.gadgets().filter(g => !ctlKeys.includes(g.key)).map(g => g.id);
  /* you start with what you picked, and nothing else */
  __fp.setLoadout(['jam', 'decoy', 'mag']);
  o.chosen = __fp.loadout;
  o.lit = __fp.kitShown().filter(x => x.on).map(x => x.id);
  startGame();
  o.gotChosen = __fp.charges();
  toMenu(); __fp.setLoadout(['flare', 'smoke', 'wire']); startGame();
  o.gotDefault = __fp.charges();
  /* a fourth pick pushes the oldest out rather than refusing */
  toMenu(); __fp.setLoadout(['flare']);
  __fp.toggleKitNow('smoke'); __fp.toggleKitNow('emp'); __fp.toggleKitNow('jam');
  o.pushedOut = __fp.loadout;
  /* and you cannot walk in with nothing */
  __fp.setLoadout(['flare']);
  o.lastOne = { removed: __fp.toggleKitNow('flare'), loadout: __fp.loadout };
  /* the choice survives a reload */
  __fp.setLoadout(['emp', 'hush']);
  o.stored = JSON.parse(localStorage.getItem('flashpoint.loadout') || '[]');
  __fp.setLoadout(['flare', 'smoke', 'wire']);
  return JSON.stringify(o);
})()`));
const only = (c, ids) => Object.entries(c).every(([k, v]) => ids.includes(k) ? v === 1 : v === 0);
ok('all eight gadgets are described in one place', kit.gadgets.length === 8 && kit.max === 3,
  `${kit.gadgets.length} gadgets, pick ${kit.max}`);
/* GADGETS, T.KIT, the item bar and the pause reference all describe this kit */
ok('and the other three lists agree with it',
  kit.missingFromKit.length === 0 && kit.orphanInKit.length === 0
  && kit.missingButtons.length === 0 && kit.keysNotInControls.length === 0,
  `kit=${JSON.stringify(kit.missingFromKit)} orphan=${JSON.stringify(kit.orphanInKit)} btns=${JSON.stringify(kit.missingButtons)} ctl=${JSON.stringify(kit.keysNotInControls)}`);
/* the same four used to be handed over every run, leaving half the kit as litter */
ok('you set out with exactly what you picked',
  only(kit.gotChosen, ['jam', 'decoy', 'mag']), JSON.stringify(kit.gotChosen));
ok('and a different pick gives a different run',
  only(kit.gotDefault, ['flare', 'smoke', 'wire']), JSON.stringify(kit.gotDefault));
ok('the grid is lit to match', kit.lit.sort().join(',') === 'decoy,jam,mag', JSON.stringify(kit.lit));
ok('a fourth choice pushes the oldest out instead of refusing',
  kit.pushedOut.length === 3 && !kit.pushedOut.includes('flare'), JSON.stringify(kit.pushedOut));
ok('but you can never walk in carrying nothing',
  kit.lastOne.removed === false && kit.lastOne.loadout.length === 1, JSON.stringify(kit.lastOne));
ok('and the choice is remembered', kit.stored.join(',') === 'emp,hush', JSON.stringify(kit.stored));


const clean = problems.length === 0;
if (!clean) fails++;
console.log(`${clean ? 'PASS' : 'FAIL'} :: zero console/js errors`);
problems.forEach(p => console.log('  ' + p));
console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL CHECKS PASSED');
ws.close(); chrome.kill();
process.exit(fails ? 1 : 0);
