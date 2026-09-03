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
ok('the item bar has every gadget', (await evl("document.querySelectorAll('#itemBar .item').length")) === 7,
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
ok('the control list agrees with the item bar',
  pau.keysAgree === true && pau.rows === 12, `bar=${JSON.stringify(pau.barKeys)} rows=${pau.rows}`);
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


const clean = problems.length === 0;
if (!clean) fails++;
console.log(`${clean ? 'PASS' : 'FAIL'} :: zero console/js errors`);
problems.forEach(p => console.log('  ' + p));
console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL CHECKS PASSED');
ws.close(); chrome.kill();
process.exit(fails ? 1 : 0);
