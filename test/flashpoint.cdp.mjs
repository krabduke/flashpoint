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
await eq('campaign has 9 floors', 'MAPS.length', 9);
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

/* ---- smoke: hidden and blind at the same time ---- */
await send('Page.navigate', { url: FILE + '?autostart&name=TESTY' });
await sleep(2200);
ok('you carry one pellet', (await evl('__fp.smokePellets')) === 1, `n=${await evl('__fp.smokePellets')}`);

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
ok('you start a floor with flares', (await evl('__fp.flares')) === 2, `n=${await evl('__fp.flares')}`);
await evl('noise.length = 0');
ok('a flare throws', (await evl('__fp.throwFlare()')) === true);
await sleep(250);
ok('it burns on the floor', (await evl('__fp.flaresLit')) === 1, `lit=${await evl('__fp.flaresLit')}`);
ok('throwing spends one', (await evl('__fp.flares')) === 1);
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
ok('floors carry power-ups', (await evl('__fp.powerupsN')) > 0, `n=${await evl('__fp.powerupsN')} kinds=${JSON.stringify(await evl('__fp.powerupKinds()'))}`);

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
