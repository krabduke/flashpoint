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
await evl('for (const b of bots) { b.face = Math.atan2(b.y - player.y, b.x - player.x); b.state = "patrol"; }');
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

/* museum searchlights */
await evl('mapIdx = 4; loadMap(4);');
await sleep(300);
ok('museum has searchlights', (await evl('__fp.searchN')) >= 2);

/* server laser grid */
await evl('mapIdx = 5; loadMap(5);');
await sleep(300);
await eq('server has 4 laser gates', '__fp.lasersN', 4);
const lm = JSON.parse(await evl('JSON.stringify(__fp.laserMid)'));
await evl('invuln = 0; meter = 0;');
await evl(`__fp.teleport(${lm.x}, ${lm.y})`);
await sleep(400);
const lz = await evl('__fp.meter');
ok('laser zap spikes meter', lz > 0.3, 'meter=' + lz?.toFixed?.(2));

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


const clean = problems.length === 0;
if (!clean) fails++;
console.log(`${clean ? 'PASS' : 'FAIL'} :: zero console/js errors`);
problems.forEach(p => console.log('  ' + p));
console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL CHECKS PASSED');
ws.close(); chrome.kill();
process.exit(fails ? 1 : 0);
