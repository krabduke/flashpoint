# Flashpoint — working backlog

The loop's state lives here. Each pass: take the **first unticked item**, build it,
prove it, commit, push, tick the box, append a line to the log at the bottom.

A session that dies mid-run loses nothing — the next one reads this file and
carries on. Nothing here depends on conversation context.

**Definition of done for every item:** `node test/flashpoint.cdp.mjs` prints
`ALL CHECKS PASSED`, and the change has a harness assertion of its own where the
behaviour is assertable. Visual work gets a screenshot check instead.

**Three traps this harness sets, all of them paid for:**

1. `update()` returns early unless `mode === 'playing' && !paused`. A block that
   gets the player caught leaves every later `drive()` running against a frozen
   game, which reads exactly like the feature under test doing nothing. Drain
   `meter` and set `invuln` before parking a drone next to the player, and put
   `mode` in the failure message.
2. Own your state, do not inherit it. `loop`, `diffIdx`, `modIdx`, `endless` and
   `alertLvl` all survive into a block from the four hundred assertions before
   it, and each one changes how the game behaves.
3. The AI overrules a bare `b.state = ...` on the very next update. Re-assert it
   every frame, or drive the real behaviour instead of forcing it.
4. `PASS=0 FAIL=0` is not a pass. It means node never started — usually an
   identifier collision with one of the ~140 names already in the harness. Run
   `node --check test/flashpoint.cdp.mjs` before a three minute run, and grep
   the name first.
5. Web Audio does not settle where you think. `setTargetAtTime` approaches its
   target exponentially and never reaches it, so assert an inaudible floor
   rather than `=== 0`, and give any rate you measure a window long enough that
   rounding is not deciding the ratio.

---

## A · Items and tools

- [x] A1 Torch battery — finite charge, drains lit, recovers off; `B` pickups
- [x] A2 Flares — throwable light, 11s, loud on landing
- [x] A3 Coin toss — spend a coin to make noise elsewhere
- [x] A4 Smoke pellet — a cloud that blocks drone line of sight
- [x] A5 EMP charge — kills lamps, lasers and cameras in radius for 5s
- [x] A6 Decoy — a dummy that drones investigate
- [x] A7 Magnet — pulls loose coins within 90px for 8s
- [x] A8 Lockpick — opens `D` doors, takes 1.5s standing still
- [x] A9 ~~Inventory + item switching~~ → **tappable item bar**. Rejected as specified: every gadget already has one key, so select-then-use would make each action slower. The real gap was touch, which has no keyboard and could not reach any gadget at all.
- [x] A10 Item pickups placed across all floors — and the kit made run-long, since a found flare is worthless if the next floor hands you two anyway

## B · Map elements

- [x] B1 `C` fixed camera — searchlight with `spin: 0`, aimed down its longest clear line
- [x] B2 `V` vent — player passes, drones cannot path through; carved from wall tiles so nothing can be disconnected
- [x] B3 `G` glass — blocks movement, not sight; done **without** touching losClear by making glass not-a-wall and stopping bodies instead
- [x] B4 `D` locked door + `K` key — done with A8; a lockpick with nothing to pick is half a feature
- [x] B5 `~` water — footsteps carry further, and soft shoes cannot silence a splash
- [x] B6 pressure plate — tile is `!` not `p`, since `P` is the spawn marker and the two are a trap to read
- [x] B7 `M` mirror — reflects your beam around a corner; done as a second light source, castCone untouched
- [x] B8 Destructible crates — break for a **bonus** coin, loudly; tile is `O`

## C · New floors

- [x] C1 Floor 10 · THE GALLERY — museum theme, 12 coins, 3 bots, siren
- [x] C2 Floor 11 · THE COLD STORE — docks theme, 13 coins, 3 bots, fog
- [x] C3 Floor 12 · THE PENTHOUSE — city theme, 14 coins, 4 bots, siren + blackout
- [x] C4 Un-hardcode "nine" — harness assertion, floor-grid CSS (now auto-fit), README in 5 places

## D · Systems

- [x] D1 Drones notice your beam — time-based, so sweeping is safe and staring is not
- [x] D2 Heavy pockets — footstep radius scales with carried gold; 520 empty to 806 full
- [x] D3 Run alert level — persists across floors for the whole run, capped at 4 notches (+32%)
- [x] D4 Daily seed — gameplay RNG seeded from the date; cosmetic noise deliberately left unseeded
- [x] D5 Achievements — 12, each about a system this game has; per-floor flags answer the negative ones
- [x] D6 Difficulty modes — Casual / Standard / Blackout; standard is all-ones so the tuned game is untouched
- [x] D7 Endless modifiers — 8 rules, chosen from the loop number so a daily endless run matches
- [x] D8 Ghost replay — per-floor best route, quantised pairs, only a faster clear replaces one

## E · Bot AI

- [x] E1 Flanking — each radioed drone gets its own approach bearing and claims it, so they surround rather than queue
- [x] E2 Spiral search — golden-angle spiral out from last known, walkable points only, 9s cap
- [x] E3 Corner peeking — pause and sweep where a corridor turns or branches, with a cooldown
- [x] E4 Predictive intercept — 0.55s lead, falls back to your actual position when the lead is blocked
- [x] E5 Realistic give-up — rejoin the route at the nearest waypoint, then stay wary; fixed a 967px stale-waypoint walk
- [x] E6 Radio cooldown — 4.5s per drone, plus committed drones are not re-yanked; also clamped four drifting timers
- [x] E7 Hearing acuity per floor — 165px on the House to 268px in the Penthouse, +20% while wary
- [x] E8 Idle personality — per-drone sweep, pace, peek and loiter traits, drawn through rng() so dailies reproduce

## F · Look

- [x] F1 Drone sprite pass — the real fault was state-blindness, not detail; patrol/invest/chase now read at a glance
- [x] F2 Exit door — shutter door with ribs, frame, status lamp and light spilling through when it opens
- [x] F3 Coin sprite — 7 silhouettes across 12 floors: disc, chip, vial, gem, card, ingot, ring
- [x] F4 Caught sequence — 0.72s hold: their light floods in and the room closes down before the card lands
- [x] F5 Win screen — totals count up, a line saying how you did it, and the achievements that run earned
- [x] F6 Floor transitions — the screen opens from dark with the floor's name; swap stays instant so no flow changes
- [x] F7 Lighting falloff — one shared curve for every light: hot core, quick mid drop, long tail
- [x] F8 Fog rendering — 14 drifting banks tied to the beam choke; fog had no visual at all before this
- [x] F9 Rain — three depth bands, splashes where drops land, real-time motion, and it now runs on touch
- [x] F10 Memory afterglow — a fast warm trail over a slow amber survey; the old one froze at alpha 0.12 forever because 8-bit canvas alpha cannot take the last step down
- [x] F11 Screen shake — per-event amplitude, frequency, decay and push direction; found the caught shake never decayed at all because the decay sat behind update()'s early return
- [x] F12 Pause screen — run state, torch, alert, this floor's hazards and a full control reference; RESUME outranks ABANDON now instead of matching it

## G · Sound

- [x] G1 Drone vocalisations — rising as a drone warms, falling as it cools, inverse-square volume; a drone giving up had been silent, which is the most useful thing audio can say
- [x] G2 Room tone per theme — nine beds over hum pitch, beat rate and a filtered air layer the game never had; glides across on the stairs
- [x] G3 Chase stinger — a root climbing a fifth, a tritone held back until you are cornered, and the room bed ducking to make space; the bed got its own node so the duck and the theme cannot clobber each other
- [x] G4 Footstep material — seven materials off existing tiles and themes, no new tile needed; walking is audible to you and still silent to them
- [x] G5 Spatial panning — positional sounds pan by x offset from you, not from the screen; pan and distance stayed separate but the distance curve is now shared
- [x] G6 Coin pitch ladder — pentatonic, normalised so every floor's last coin lands on the octave; found and fixed a crate coin opening the exit early

## H · Interface

- [x] H1 Settings panel — volume (new), difficulty (moved in, not duplicated) and three-state motion, reachable from the menu and from a paused run. **Colourblind deliberately left to H7**: a toggle that only writes to localStorage is a control that lies about what is possible
- [x] H2 Minimap of swept area — draws F10's survey grid and strictly nothing else; asserted that drones in the dark leave no mark on it
- [x] H3 Exit compass — the arrow existed but was gated on exitOpen, so it arrived only after every coin was collected; permanent now and graded to what you know
- [ ] H4 Leaderboard screen — currently a cramped table
- [ ] H5 Toast queue — messages currently overwrite each other
- [ ] H6 Tutorial pass — teach light-gated gold properly
- [ ] H7 Colourblind mode — red cones are the whole game; add its row to the settings panel built in H1 as part of this
- [ ] H8 Mobile controls — bigger dead zones, better sprint threshold

---

## Log

Append one line per completed item: `date · id · commit · note`.

- 2026-09-02 · seeded · fd5652d · backlog written
- 2026-09-02 · A1 · torch battery, F toggles, `B` cells, HUD bar, 10 assertions
- 2026-09-02 · A2 · flares on Q, 2 per floor, survive blackouts, 10 assertions
- 2026-09-02 · A3 · coin toss on E, coin lands and stays collectible, 10 assertions
- 2026-09-02 · A4 · smoke on X, blocks drones and searchlights, chokes your own beam, 8 assertions
- 2026-09-02 · A5 · EMP on C, local bubble kills lamps/lasers/cameras, 8 assertions
- 2026-09-02 · A6 · decoy on V, chirps every 1.15s for 12s, pulls drones off patrol, 8 assertions
- 2026-09-02 · A7 · magnet on G, 8s pull within 96px, works on unlit gold, 9 assertions
- 2026-09-02 · A8+B4 · doors, keycards, lock picking on 4 floors, 10 assertions; de-flaked the patrol test
- 2026-09-02 · A9 · item bar (7 gadgets, tappable, clear of thumbsticks), 7 assertions; toMenu now refreshes the HUD
- 2026-09-02 · A10 · 20 pickups across 9 floors, kit carries between floors with caps, 6 assertions
- 2026-09-02 · B1 · 6 cameras on 4 secured floors, wall-mounted, auto-aimed, 6 assertions
- 2026-09-02 · B2 · 8 vents on 4 floors; drone detour measured at 18 cells vs your 2, 6 assertions
- 2026-09-02 · B3 · 5 panes on Bank Vault + CORE; raycast untouched, 8 assertions
- 2026-09-02 · B5 · 16 water tiles on the Ward and Docks; walking wet is heard, soft shoes do not help, 6 assertions
- 2026-09-02 · B6 · 10 plates on 4 secured floors; raiseAlarm() extracted and now shared with the searchlight, 9 assertions
- 2026-09-02 · B7 · 8 mirrors in corners; found and fixed a map-writer bug that had been placing features on the wrong rows, 9 assertions
- 2026-09-02 · B8 · 9 crates on 4 floors, bonus coin outside coinsTotal, 10 assertions — **section B complete**
- 2026-09-02 · C1-C4 · three generated floors via tools/genmap.py, campaign now 12 floors, 9 assertions — **section C complete**
- 2026-09-02 · D1 · drones investigate lit floor after 1.15s of clear view; smoke and a dark torch both hide it, 6 assertions
- 2026-09-02 · D2 · haulNoise() scales step and splash radius up to 1.55x, 5 assertions
- 2026-09-02 · D3 · alert level 0-4, +8% drone speed each, survives the stairs, 8 assertions
- 2026-09-02 · D4 · daily run toggle + seed display, mulberry32 from YYYYMMDD, 6 assertions
- 2026-09-03 · D5 · 12 achievements + menu grid, 10 assertions; de-flaked the pre-existing laser test
- 2026-09-03 · D6 · three modes across 6 shared numbers, score scales 0.7/1/1.5, 10 assertions; speedMult() extracted so the hook cannot drift
- 2026-09-03 · D7 · 8 loop rules reusing existing systems, shown in the HUD, 10 assertions — **section D complete**
- 2026-09-03 · D8 · ghost trails per floor, 8 assertions; fixed laser gates ignoring the spawn grace period and de-flaked the campaign block — **section D complete**
- 2026-09-03 · E1 · flankPoint() with claim avoidance; 3 drones, 3 distinct points, 3 bearings, 6 assertions
- 2026-09-03 · E2 · drones search 4-5 points outward before giving up; also closed a state leak my own laser de-flake introduced, 8 assertions
- 2026-09-03 · E3 · drones stop and look at junctions; 156 peek frames measured, all stationary, 5 assertions
- 2026-09-03 · E4 · drones cut corners rather than tail; A* throttled to 4.5Hz per drone, 6 assertions
- 2026-09-03 · E5 · giveUp() rejoins route nearby (967px walk removed) + 7s wary period, 6 assertions
- 2026-09-03 · E6 · radio cooldown 4.5s, re-target guard, negative timers clamped, 5 assertions
- 2026-09-03 · E7 · hearR() scales with floor, loop and wariness, 4 assertions
- 2026-09-03 · E8 · four drones, four distinct clocks, 6 assertions — **section E complete**
- 2026-09-03 · F1 · drone redrawn with per-state lens ramp, vent, rotors and rim; pixel-asserted as three distinct states
- 2026-09-03 · F2 · exit redrawn as a two-leaf shutter, orientation from the open axis; verified by screenshot (camera clamps at map edges, so pixel sampling tests the harness not the game), 3 geometry assertions
- 2026-09-03 · F3 · per-theme loot shapes, same size and value; brightness asserted on lit samples, 5 assertions
- 2026-09-03 · F4 · caughtHold ticks before update's early return; 5 assertions, plus the pre-existing card check now waits for the beat
- 2026-09-03 · F5 · counted totals + run summary + earned-achievement chips; caught a regression where my own edit hid the TIME stat, 6 assertions
- 2026-09-03 · F6 · 0.62s opening wipe on floor advance only, 7 assertions
- 2026-09-03 · F7 · FALLOFF applied to torch, bubble, lamps, searchlights and warm wash; lamp centre 264 vs rim 65, 6 assertions
- 2026-09-03 · F8 · fog banks roll through the room, screen brightness 67 clear vs 108 thick, 5 assertions
- 2026-09-03 · F9 · 96 drops across 3 bands, splash rings, fixed a frame-rate-dependent 0.03 step, 7 assertions
- 2026-09-03 · F10 · two float fields replace the canvas, trail half-life 1.7s over a survey at 34s; found the afterglow had been jamming at 0.12 and never fading, 9 assertions
- 2026-09-03 · F11 · four events, four textures (laser 30 crossings to caught's 8), directional push, reduced-motion respected on the canvas at last, 10 assertions
- 2026-09-03 · F12 · pause becomes a briefing card, 13 assertions; one pins the control list against the item bar so the two cannot drift — **section F complete**
- 2026-09-03 · G1 · servo chirps on every heat change, botHeat() shared with the sprite, 8 assertions; five runs, every failure in the test rather than the game
- 2026-09-03 · G2 · nine room tones, server farm at 96Hz against the vault at 34Hz, 0.8s glide, 9 assertions
- 2026-09-03 · G3 · chase swell over the heartbeat, tritone late, bed ducks to 45%, 9 assertions; the heartbeat itself is finally tested too
- 2026-09-03 · G4 · material per theme plus water and vent grating, walking finally makes a sound without making noise, 8 assertions
- 2026-09-03 · G5 · stereo panning for the sounds that are in the room, centred for the ones that are not, servoVol generalised to distVol, 9 assertions
- 2026-09-03 · G6 · pentatonic coin ladder, and split coins from realCoins after finding a bonus coin could open the exit with gold still on the floor, 9 assertions — **section G complete**
- 2026-09-03 · H1 · one settings panel, volume wired through mute properly, reduced motion reaches particles and wipes as well as shake, 11 assertions
- 2026-09-03 · H2 · minimap off the survey grid, walls only where swept, exit only once seen, off-switchable, 6 assertions
- 2026-09-03 · H3 · exit compass permanent, three states by what you have seen, genuinely edge-anchored, 6 assertions
