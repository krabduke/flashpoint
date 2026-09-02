# Flashpoint — working backlog

The loop's state lives here. Each pass: take the **first unticked item**, build it,
prove it, commit, push, tick the box, append a line to the log at the bottom.

A session that dies mid-run loses nothing — the next one reads this file and
carries on. Nothing here depends on conversation context.

**Definition of done for every item:** `node test/flashpoint.cdp.mjs` prints
`ALL CHECKS PASSED`, and the change has a harness assertion of its own where the
behaviour is assertable. Visual work gets a screenshot check instead.

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
- [ ] D6 Difficulty modes — Casual / Standard / Blackout
- [ ] D7 Endless modifiers — one random rule per loop
- [ ] D8 Ghost replay — your best run's path drawn faintly behind you

## E · Bot AI

- [ ] E1 Flanking — a radioed drone takes a different route to the same place
- [ ] E2 Spiral search — investigate outward from last known, not just to a point
- [ ] E3 Corner peeking — pause and sweep at junctions
- [ ] E4 Predictive intercept — chase where you are going, not where you were
- [ ] E5 Realistic give-up — drift back to patrol via the last noise, not instantly
- [ ] E6 Radio cooldown — stop every drone re-broadcasting the same sighting
- [ ] E7 Hearing acuity per floor — deeper drones hear further
- [ ] E8 Idle personality — small per-drone variation in sweep and pause

## F · Look

- [ ] F1 Drone sprite pass — match the quality of the redrawn thief
- [ ] F2 Exit door — a real door, not a beacon blob
- [ ] F3 Coin sprite — distinct silhouette per floor theme
- [ ] F4 Caught sequence — a held beat before the card
- [ ] F5 Win screen — a proper payoff, currently plain
- [ ] F6 Floor transitions — a wipe rather than a hard cut
- [ ] F7 Lighting falloff — softer, less linear
- [ ] F8 Fog rendering — volumetric rather than flat alpha
- [ ] F9 Rain — depth layers and splash
- [ ] F10 Memory afterglow — warmer, longer, more legible
- [ ] F11 Screen shake — tune per event, currently uniform
- [ ] F12 Pause screen — currently bare

## G · Sound

- [ ] G1 Drone vocalisations — a servo chirp on state change
- [ ] G2 Room tone per theme — a bed that changes with the floor
- [ ] G3 Chase stinger — music that rises with the meter
- [ ] G4 Footstep material — carpet, concrete, water, grating
- [ ] G5 Spatial panning — pan by x offset from the player
- [ ] G6 Coin pitch ladder — rising pitch as a floor empties

## H · Interface

- [ ] H1 Settings panel — volume, difficulty, reduced motion, colourblind
- [ ] H2 Minimap of swept area — built from the memory canvas
- [ ] H3 Exit compass — permanent, subtle, edge-anchored
- [ ] H4 Leaderboard screen — currently a cramped table
- [ ] H5 Toast queue — messages currently overwrite each other
- [ ] H6 Tutorial pass — teach light-gated gold properly
- [ ] H7 Colourblind mode — red cones are the whole game
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
