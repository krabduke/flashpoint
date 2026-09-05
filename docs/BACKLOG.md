# Flashpoint — working backlog

The loop's state lives here. Each pass: take the **first unticked item**, build it,
prove it, commit, push, tick the box, append a line to the log at the bottom.

A session that dies mid-run loses nothing — the next one reads this file and
carries on. Nothing here depends on conversation context.

**Definition of done for every item:** `node test/flashpoint.cdp.mjs` prints
`ALL CHECKS PASSED`, and the change has a harness assertion of its own where the
behaviour is assertable. Visual work gets a screenshot check instead.

**Nineteen traps this harness sets, every one of them paid for:**

1. `update()` returns early unless `mode === 'playing' && !paused`. A block that
   gets the player caught leaves every later `drive()` running against a frozen
   game, which reads exactly like the feature under test doing nothing. Drain
   `meter` and set `invuln` before parking a drone next to the player, and put
   `mode` in the failure message. **This has now cost four separate blocks.** If
   a block deliberately fills the meter, give it a `revive()` that resets
   `mode`, `meter` and `invuln`, call it after every such run, and assert the
   mode at each stage so a frozen game cannot masquerade as a broken feature.
2. Own your state, do not inherit it. `loop`, `diffIdx`, `modIdx`, `endless` and
   `alertLvl` all survive into a block from the four hundred assertions before
   it, and each one changes how the game behaves.
3. The AI overrules a bare `b.state = ...` on the very next update. Re-assert it
   every frame, or drive the real behaviour instead of forcing it.
4. `PASS=0 FAIL=0` is not a pass. It means node never started — usually an
   identifier collision with one of the ~140 names already in the harness. Run
   `node --check test/flashpoint.cdp.mjs` before a three minute run, and grep
   the name first.
5. Build state through the real entry point. `startGame()` arms things
   `loadMap()` does not, so a block that calls loadMap directly inherits
   whatever the previous run left behind — which reads as the feature being
   broken rather than as the test skipping a step.
6. A whole-canvas pixel average dilutes anything local into noise. Sample the
   region the change is in, computing its screen position from the camera rather
   than assuming the middle. This has cost three separate assertions now.
7. When an assertion about a converging value fails, TRACE THE VALUE over time
   before theorising. A stall and a wander look identical in a single end-state
   reading and have completely different causes — J2 cost two wrong guesses and
   two full runs before a five-sample trail named it in one glance.
8. An exception thrown INSIDE a page evaluate does not reach `problems`, and the
   run still prints `FAIL=0` next to a `FATAL`. Read the FATAL line, not just
   the counts, and wrap a long evaluate in try/catch returning
   `e.message + e.stack.split('\n')[1]` — that named the file and line in one
   run instead of a bisect.
9. Per-floor arrays must be cleared BEFORE the tile loop that fills them.
   `safes = []` sat with the other resets further down `loadMap` and wiped every
   safe the tiles had just created — which reads exactly like the feature not
   working. Check where a new array's reset lands relative to line ~1426.
10. An assertion that measures a TOTAL and names one contributor is only true
    until something else starts contributing. K3 paying at `nextMap` broke two
    of K1's, correctly. Isolate the thing you name — zero the other contributors
    in setup — rather than widening the expected number.
11. Adding a gadget touches four things the harness knows about: the `#itemBar`
    markup, the gadget-count assertion, the pause screen's `CONTROLS` list, and
    that list's row count. F12's control-list check exists precisely to catch
    the third; do all four in the same edit.
12. Assert on the CHANNEL a feature governs, not on emergent behaviour. "Did
    anyone come to look" mixes sight and hearing; "how many times did the noise
    reach an ear" measures the jammer. And run a control alongside, so a low
    number means something — a jammed count ABOVE the unjammed one is what
    exposed the field being thrown in the wrong place.
13. Web Audio does not settle where you think. `setTargetAtTime` approaches its
   target exponentially and never reaches it, so assert an inaudible floor
   rather than `=== 0`, and give any rate you measure a window long enough that
   rounding is not deciding the ratio.

20. **validateMaps checks a more permissive world than the game runs.** It treats
    only `#`, `G` and `$` as blocking, but mirrors and doors stop the player too,
    and a drone cannot open a door at all. Eight hundred assertions were green
    while THE HOUSE held a locker sealed behind a mirror and THE BANK VAULT had a
    patrol waypoint behind a locked door - a drone assigned a beat it could never
    walk. Check reachability against what actually blocks, per actor: the player
    (mirrors and glass permanent, crates breakable, doors need a key) and the
    drones (doors always shut). And verify the key is not behind the door it
    opens, or the floor is unwinnable.

21. **Deleting a button could blank the whole page.** `bindBtn` called
    `$(id).addEventListener` with no null check, so removing the difficulty
    button threw at load, killed the script before `__fp` existed, and turned
    every one of 800 assertions into `undefined`. It reads as "nothing works"
    rather than "one button is gone". The boot assertion was the only line in
    that output pointing at the truth. bindBtn now returns early on a missing
    element - removing UI should cost one dead button, not the game.

22. **Assertions cannot see a layout.** 835 of them passed while the briefing's
    plan canvas floated over the floor name - you could read "TH..._T" of "THE
    BANK VAULT" - and while the GO button sat at y=792 in a 720px viewport. The
    cause was a global `canvas{position:absolute;inset:0}` written for the game
    viewport and inherited by a diagram. Drive the game and LOOK at it:
    test/playthrough.mjs photographs the five moments that carry a floor.

23. **An assertion scaled to the constant it guards cannot see that constant be
    wrong.** 'standing still during the escape costs you' waited
    `RESPONSE_EVERY * 2 + 1` seconds, so it passed at 14 - a value measurement
    later showed never fired once in twenty floors - and would have passed at
    900. A guard on a tuning number has to be anchored to something outside the
    number: here, the sprint time across the real prize-to-exit routes.

24. **pathFind is the DRONE's pathfinder, not the player's.** It refuses vents
    ("a drone does not fit") and glass. Steering a simulated player with it
    returns [] on floors 17, 19 and 20, and the fallback walks at the door
    through the walls - which is how an entire escape-length measurement came
    back meaningless. The player's rule is `bodyBlocked`: glass stops you, a
    vent does not. Simulate the player with the player's rule.

25. **A `> 0` filter swallows "impossible" and leaves the sentinel behind.**
    `if (d > 0 && d < bd)` skipped empty paths, so `bd` stayed at its 1e9
    initialiser and the report printed a 25,000,000-tile corridor. An
    unreachable target is a fact worth printing, not a zero worth skipping.
    Distinguish "no answer" from "an answer of zero" at the point of measuring.

26. **Three plausible causes, all wrong, before the right one.** The floor-20
    empty path was blamed on exits-on-wall-tiles, then exits-on-vent-tiles, then
    a broken level - each checked and refuted - before the real answer: the only
    way out is a duct, and no drone fits. Ask the question the code actually
    asks (reachability under the drone's own rule) instead of testing
    hypotheses about it one at a time.

27. **A harness-derived script run from /tmp loads nothing.** The header
    resolves `FILE` as `new URL('../index.html', import.meta.url)`, so a copy in
    /tmp points at /index.html and every eval fails with a bare "loadMap is not
    defined". Scratch copies of the harness belong in test/.

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
- [x] H4 Leaderboard screen — two tiers per run with rank, floor, gold and the time that had been recorded and never shown; the new-record highlight matched on name+score and lit up ties
- [x] H5 Toast queue — a capped stack rather than a queue, since a queue would report events four seconds late; repeats refresh one line instead of stacking copies
- [x] H6 Tutorial pass — four staged lessons instead of one nine-second wall of capitals; the gold lesson clears by putting your beam on a coin, not by a timer
- [x] H7 Colourblind mode — blue cones AND hatching, because hue is the one channel that fails; its settings row lands here now that it does something
- [x] H8 Mobile controls — the dead zone was a cliff that handed you the raw value on crossing, and sprint had no hysteresis, so a resting thumb flickered you in and out of making noise

---

# Round two

Sections A–H are done (64/64). Measured before writing this: `update()` costs
0.042ms on floor 1 and 0.129ms on floor 12 at loop 3 with six drones, against a
16.7ms frame budget. Under 1%. Headless has no compositor so the render figures
are draw-call submission rather than paint, but the JS side has enormous room.
**So there is no optimisation section here — the budget is not the constraint,
and inventing one would have been work for its own sake.**

The real gap after 64 items: every enemy in the game is the same drone. E1–E8
made them clever but there is still exactly one kind of threat, and the entire
noise system — footsteps, water, carried weight, crates, tossed coins — exists
only to attract something that hunts by sight.

## J · A second kind of hunter

- [x] J1 `H` listener — no cone at all, hears at 337 to a drone's 193, and knows
      you only while you are moving. Freezing is the counterplay, and a blackout
      is no help against something that never used its eyes.
- [x] J2 Listener made legible — its reach is drawn once you are near enough for
      it to matter and brightens when you move; slow panned sonar so you can
      place one unseen; it turns to face what it heard. Found two real defects:
      two faceToward calls fighting, and an idle sweep on a thing with no cone.
- [x] J3 `Y` sentry — bolted down, wide short cone, deaf, asleep until an alarm; every one on the floor opens for 9s, so an alarm costs more than the drone it sends
- [x] J4 Mixed floors — drones alone for three floors, a listener from four,
      sentries from six, all three on the Core; sentry wake scales with depth.
      The predicted third `of bots` defect was real: the red eye glint was being
      drawn on listeners, handing you the very cue their design removes.
- [x] J5 They tell each other — a listener with a lock puts your position out to
      every drone in range, once every 6.5s. Deliberately not `raiseAlarm`: no
      alert bump, no sentries woken. One unit reporting, not the building.

## K · Risk against reward

- [x] K1 The exit opens early at a price — the door unlocks at two thirds and the
      clear bonus is what you forfeit by walking out. Asserted that every floor
      leaves something on the table, since ceil(n*0.66)==n for tiny floors.
- [x] K2 `$` safe — 900 for 4.6s of standing still while it broadcasts your position every half second; optional, and asserted not to change what the floor asks
- [x] K3 Clean-floor bonus — UNSEEN/UNHEARD/UNLIT lit in the HUD while you hold them, 200 each on the way out and 400 more for all three with every coin; one CLEAN definition drives both the display and the payout

## L · More to carry

- [x] L1 Tripwire on `T` — the first gadget that acts on what you know rather than on them: silent, invisible to them, arms after 0.6s, and a bolted-down sentry can never be what came through
- [x] L2 Muffle on `B` — cancels D2's haul penalty for one floor; sprint noise 806 down to 520, which is the difference between trackable and not against a listener's 337
- [x] L3 Jammer on `J` — the EMP's opposite number: deafens them in a radius. Stops them answering a sound, not a listener feeling you through the floor. Cracking a safe inside one reached ears twice against 240 times without

## M · Blocked

- [ ] M1 Supabase leaderboard + login. **Blocked, not forgotten**: the MCP server
      in `~/florasites-business/.mcp.json` has never been authenticated, so there
      are no credentials to build against. Needs Keenan to run `/mcp`. Note also
      that client-computed scores cannot be made tamper-proof; a global board
      will need server-side validation or an honest disclaimer.

---

# Round three

Sections J, K and L are done (11/12; M1 is blocked on auth, not on work).
Surveyed before writing this, and two gaps stand out — both of them about choice
the game does not currently offer.

**Eight gadgets exist and you always start with the same four.** flare, smoke,
wire and hush are handed to you; emp, decoy, magnet and jammer have to be found.
What you bring is never a decision.

**Eight endless modifiers exist, built and asserted in D7, and the campaign never
touches them** — `MOD()` returns `{}` unless `endless`. So twelve floors run
byte-identical every single time. The expensive half of that feature is already
written.

## N · What you bring

- [x] N1 Loadout — pick three of the eight before a run, rather than being handed
      four. The kit tables and the item bar already exist; this is the choice.
- [x] N2 Loadout has a cost — better kit for a harder building, so picking is a
      trade rather than a wishlist
- [x] N3 The menu says what each one is for, since half of them are now only
      meaningful against a specific hunter

## P · A building that is not the same twice

- [x] P1 Campaign conditions — let the D7 modifiers apply to a normal run, chosen
      per floor rather than per loop, so floor 7 is not the same floor 7
- [x] P2 Say which condition is on, on the floor card and in the pause briefing
- [x] P3 Conditions that suit the floor — no BROWNOUT on a floor whose whole
      point is its lamps; pick from what actually makes that floor different
- [x] P4 A daily run pins its conditions to the seed, so the same day is the
      same building for everyone

## Q · What the run was

- [x] Q1 The escape screen tells the story: floors ghosted, safes cracked, gold
      left behind, conditions survived
- [x] Q2 Per-floor breakdown, since a twelve floor run currently collapses to
      three numbers
- [x] Q3 The caught screen should say what got you — which kind, and on what

## R · Reach

- [x] R1 Hold-to-crack as an alternative to stand-still, for anyone who cannot
      hold a stick perfectly steady for four and a half seconds
- [x] R2 Interface scale, since the HUD is 9px type on a phone

---

# S · Mobile, properly

Asked directly whether it works on a phone, and measured rather than answered.
It does not. Rendered at 390x844 with real DPR and touch emulation:

- **The map fills 40% of the screen.** `Z = min(W,H)/620` gives 0.629 on a phone,
  so the visible world is 620x1342 while the map is 720 tall — it sits in a band
  at the top with 390px of dead blue beneath it.
- **The item bar runs off the right edge.** It starts at x=251 and is 196 wide on
  a 390 viewport, so COIN, MAGNET and everything after are unreachable.
- **Every item button is 46x20.** Ten of them, all under the 44px touch minimum.
- **The left HUD column is clipped**, the alert row cut off mid-word.
- **The tutorial says "WASD TO MOVE · THE MOUSE AIMS YOUR BEAM"** on a touch
  device.
- **The start screen overflows**: 886px of content in an 844px viewport.

- [x] S1 Fill the screen — zoom so the map covers the viewport in either
      orientation, without changing desktop
- [x] S2 The bar shows what you carry — N1 means you hold three gadgets, not
      nine, so stop drawing buttons for things you have none of
- [x] S3 Touch targets that can be hit — 44px minimum on anything tappable
- [x] S4 The HUD fits the width it has
- [x] S5 Say the right thing on a phone — the tutorial and any copy naming keys
- [x] S6 The menu fits, or scrolls like it means to
- [x] S7 A mobile block in the harness, so this cannot rot again

---


## T · Five more floors

- [x] T1 Floor 13 · THE ATRIUM — museum, 14 coins, glass walls you must walk around
- [x] T2 Floor 14 · THE SUBLEVEL — server, 15 coins, vents the drones cannot use
- [x] T3 Floor 15 · THE CISTERN — docks, 15 coins, fog over water that gives you away
- [x] T4 Floor 16 · THE ARCHIVE — bank, 16 coins, two safes, three sentries, a siren
- [x] T5 Floor 17 · THE ROOST — city, 16 coins, blackout and three listeners

## U · Fifteen more features

Five of these were already specified and unbuilt (N2, P1-P4); ten are new. Each
one reuses a system that already exists rather than adding a parallel one -
that has been the pattern that works in this codebase.

- [x] U1  Loadout has a cost, so picking is a real trade (was N2)
- [x] U2  Campaign conditions — the 8 endless modifiers apply to a normal run (was P1)
- [x] U3  Say which condition is on, on the floor card and in the pause briefing (was P2)
- [x] U4  Conditions that suit the floor — no BROWNOUT where the lights are already out (was P3)
- [x] U5  A daily run pins its conditions to the seed (was P4)
- [x] U6  `A` lockers — step in and vanish; you cannot see out either
- [x] U7  Shift change — patrols swap routes mid-floor, so a memorised beat stops being free
- [x] U8  Blueprint pickup — reveals the floor's walls on the minimap, never the drones
- [x] U9  `J` jewels — high value, silent to carry, always behind glass or a safe
- [x] U10 A prize on the deep floors — optional, guarded, worth going out of your way for — **superseded**: every floor carries a prize, not just the deep ones
- [x] U11 Two exits on some floors — one close and watched, one far and quiet
- [x] U12 Ghost streak — consecutive ghosted floors multiply, and the run says so
- [x] U13 Last-seen marker — the minimap shows where they think you are, not where you are
- [x] U14 Noise rings — a brief ring showing how far the sound you just made carried
- [x] U15 A choice at the stairs — one of three boons between floors — **superseded**: the choice moved to the fence between contracts, bought out of the take

## V · Three more floors

- [x] V1 Floor 18 · THE FURNACE — core, cramped, cover everywhere and nowhere to run
- [x] V2 Floor 19 · THE STACKS — warehouse, long aisles broken by what you can hide behind
- [x] V3 Floor 20 · THE SPIRE — city, the last floor: fog, blackout and a siren together

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
- 2026-09-03 · H4 · ranked two-tier board, time finally displayed, record identity by id so ties cannot false-match, 9 assertions
- 2026-09-03 · H5 · three toasts at once, newest on top, own clocks, repeats coalesce, 6 assertions
- 2026-09-03 · H6 · staged tutorial, the gold lesson cleared by doing it, 7 assertions; test had to be routed through startGame rather than loadMap
- 2026-09-03 · H7 · colourblind cones by hue and hatching, red dominance +14 to +1, luminance edges 1093 to 1213, 6 assertions
- 2026-09-03 · H8 · rescaled dead zone, sprint hysteresis 0.85/0.62, stick rings derived from the real thresholds, 8 assertions — **section H complete, backlog empty**
- 2026-09-03 · J1 · the listener: no cone, hears 1.75x, caught by movement not by sight, 10 assertions; both failures were the caught-freeze and an unequal pixel comparison
- 2026-09-03 · J2 · reach ring that answers your feet, panned sonar tick, lock-on posture, 6 assertions; fixed duelling faceToward calls and an idle sweep on a coneless thing
- 2026-09-03 · J3 · sentries on the vault, alarms open the whole floor for 9s, 10 assertions; fixed alarms being handed to something bolted down and sentries eating flank slots in the radio net
- 2026-09-03 · J4 · units spread across all twelve floors, glint and tutorial fixed for coneless units, empty route guarded against taking the frame loop down, 9 assertions
- 2026-09-03 · J5 · listeners call drones in on a 6.5s cooldown without raising the building, 8 assertions — **section J complete**
- 2026-09-03 · K1 · door at two thirds, clear bonus forfeited by leaving early, amber counter and pause label as tells, 8 assertions
- 2026-09-03 · K2 · safes on four floors, loud throughout, flinch slips and leaving resets, 9 assertions; placement now runs validateMaps' own flood fill before accepting a tile
- 2026-09-03 · K3 · three clean marks live in the HUD, 200 each and 400 for the set, 6 assertions; K1's two assertions corrected to isolate the clear bonus — **section K complete**
- 2026-09-03 · L1 · tripwire on T, silent to them and spent when it speaks, 8 assertions; F12's anti-drift check caught the pause reference missing it
- 2026-09-03 · L2 · muffle cancels the weight penalty for a floor, 806 to 520 sprint radius, 9 assertions; all four gadget touchpoints done in one edit this time
- 2026-09-03 · L3 · jammer deafens in a radius, pairs with the safe, 7 assertions — **section L complete**

13. **Check the whole loop before calling a tile dead.** I read the first forty
    lines of `loadMap`'s tile loop, saw no branch for `f`, `d` or `m`, and wrote
    that THE PENTHOUSE carried three meaningless characters. Line 1654 handles
    all seven of them - `'fsedmhj'.includes(ch)` - and they are the gadget drops.
    The five new floors then shipped with none, because I had "corrected" them
    out of the alphabet. Grep the whole function, not the part you sampled.
14. **Reachability is not one question, it is three.** The pillar pass checked that
    coins and the exit stayed reachable and still broke eleven assertions, because
    patrol waypoints live in `routes` and never appear in `rows` — so a "bare floor
    only" check cannot see them. Validate against everything the game requires of a
    cell, not against the things that happen to be visible in the grid.

15. **A hook that already exists silently wins, and blames the harness.** I added
    `safeT() { return safeT; }` to `__fp` without checking; `get safeT()` was
    already defined further down the same literal, and the later key won. Every
    existing test kept passing, because they read `__fp.safeT` as a property -
    only my new `__fp.safeT()` threw, and the failure surfaced as
    `FATAL :: "undefined" is not valid JSON`, which reads like a broken
    assertion rather than a duplicate key. Grep for the hook name before adding
    one, and remember an evaluate that throws returns undefined rather than
    reporting anything.
16. **A FATAL stops the run where it stands.** The suite died at assertion 627 of
    ~660, so the entire mobile block never executed and the run said nothing
    about the thing it was added to check. A green count is not coverage - check
    the run reached the end.
17. **A hidden element measures 0x0, and every layout assertion against it
    passes.** Two of the fourteen mobile checks went green while looking at
    nothing: the caught card is held hidden by `caughtHold`, and `#kitWhat`
    lives on the start overlay, which is hidden mid-run. `right: 0 <= 390` is
    true, and so is `0 > 0 + 1` being false, so "fits the phone" and "not
    clipped" both passed on a box that was never rendered. The tell is a zero
    in the reported numbers. Any assertion on geometry needs a control that the
    thing had a size at all - and it is worth reading the numbers a passing
    assertion prints, not just its colour.
- 2026-09-03 · T1-T5 · five floors via tools/floorgen.py, campaign now 17; each one built around a single structural idea, 19 assertions. Fixed three count-coupled assertions and a spawn-clearance break where static listeners sat 89px from the player
- 2026-09-03 · Q1-Q3 · runLog per floor, the escape card lists all seventeen with ghost marks, the caught card names what got you and how far from the exit, 11 assertions
- 2026-09-03 · N3 · every gadget says what it does, checked against the code rather than its toast; one shared line so a tap describes as well as picks, 6 assertions
- 2026-09-03 · R1 · hold-to-crack on Z, movement no longer slips progress; disabled on touch so a desktop preference cannot brick a phone safe, 6 assertions
- 2026-09-03 · R2 · interface scale 100/125/150% via zoom on the HUD, default unchanged, 4 assertions
- 2026-09-03 · mobile · 16 assertions inside the 390x844 phone block covering all five features. Two of them first passed while measuring hidden 0x0 elements; both now reveal the element and carry a control that it had a size at all
- 2026-09-03 · U1 · the kit costs points not slots (5 to spend, 1-3 each); one affordable() shared by the storage loader and the hook, so a kit saved before the budget cannot smuggle itself into a run, 5 assertions
- 2026-09-03 · U12 · ghost streak, +0.5 per consecutive clean floor, capped at 3x, best run shown on the escape card, 5 assertions
- 2026-09-03 · U14 · noise rings at the exact radius the drones test against; reduced motion gets the circle without the sweep, 3 assertions
- 2026-09-03 · U2-U5 · the eight loop rules become choosable conditions on a campaign run; a condition the floor already satisfies is swapped for the next that bites; a daily pins and locks it, 8 assertions
- 2026-09-03 · V1-V3 · THE FURNACE, THE STACKS, THE SPIRE; generated by a subagent under a seven-rule spec and validated twice - by its own verifier and independently by mine. Campaign now ends on floor 20, 7 assertions
- 2026-09-03 · visual · one light direction across every map with contact shadow on all four sides; bloom; a colour grade per theme so nine buildings stop being one room repainted; a walk cycle driven by DISTANCE so it cannot moonwalk; a coat that trails travel rather than aim; drone downwash and port/starboard nav lights, 6 assertions
- 2026-09-03 · audio · a convolver per theme with a procedural impulse - a sealed vault at 0.35s against a warehouse ringing for 2.4s; one send off sinkAt so the whole floor sits in one room, 2 assertions
- 2026-09-03 · hud · the interface gets out of the way of the player: the toast flips to the bottom when you are at the top of the map, and each readout fades only when you are actually under it. Reported from a screenshot - the message was parked exactly where you stand, 3 assertions

18. **Column alignment can be load-bearing in a pattern.** A regex inserting a
    field after `\n  <theme>: {` hit the acoustics table instead of the palette
    table for exactly one theme. Both tables have the same keys, but the
    acoustics table is column-aligned - `house:     {` - so the padding
    protected every entry from matching a single-space pattern. Except
    `warehouse`, the longest name, which needs no padding. Anchor on something
    structural, not on whitespace that happens to differ.
19. **Atmosphere must never undo legibility.** A per-theme colour grade put warm
    light back into the drone cone that colourblind mode exists to take red out
    of - measured as red-minus-blue 5.1 where the mode requires under 4. The fix
    is for the new thing to stand down, never for the accessibility threshold to
    move. Any full-frame effect needs checking against the modes that exist to
    control colour.
- 2026-09-03 · audio · distance now takes loudness AND brightness: 17000Hz at your feet, 1547Hz at 900px, floored at 0.16 so nothing is ever fully silent. Positional sound was panned but never attenuated, so a crate across the building was as loud as one at your elbow, 4 assertions
- 2026-09-03 · visual · wake rings where you wade, light shafts from lamps, 2 assertions

20. **A full-frame effect eats information, not just mood.** A multiply pass
    darkens by scaling, so it compresses every difference in the frame
    proportionally - the map-memory overlay's margin fell from 3 luminance units
    to exactly 2 and landed on its threshold. The colour grade had already done
    the same thing to colourblind mode. Fix by moving the character into the
    additive pass, which adds without compressing, rather than by moving the
    threshold. Neither regression would have been visible in a screenshot.
21. **Grep for an identifier, do not guess its pattern.** `grep -c "const hear "`
    cannot match `const hearing` - the trailing space makes a longer name
    invisible - so a clean zero meant nothing and the run died on a collision.
    Extract every declared name and test membership instead.

22. **A tight render loop measures the compositor, not the game.** Calling
    render() 240 times synchronously reported 13.6ms mean and a 100ms p95, which
    reads as a serious stutter. Driven by real requestAnimationFrame instead,
    the same floor with the same code holds median 16.7ms, p99 16.8ms and ZERO
    frames over 33ms - a locked 60fps, and that is with GPU acceleration
    disabled. A loop that never yields makes the compositor batch its work and
    dumps it on whichever iteration triggers the flush. Measure frames the way
    frames actually happen, and check the GPU flag before believing any canvas
    number: --disable-gpu alone moved render mean from 0.22ms to 13.6ms.

18. **Defining a name that already exists is silent, and JavaScript picks the
    later one.** A new movement verb called `burst()` replaced the particle
    emitter of the same name across the whole game - every visual burst became a
    player dash that set `fSprint`, made noise and drew nothing. Nine assertions
    failed in four unrelated areas and none of them named the cause; the tell was
    `burst(prize.x, prize.y, glowGoldS, 30, 260)` passing five arguments to a
    function that takes none. Same failure as the duplicate `__fp.safeT` hook.
    Grep the identifier before defining it - function, hook, or const.
19. **Assert the setup before asserting the behaviour.** Five failures in the
    screen-beats block were all the measurement: a whole-canvas average, a control
    taken in a different phase, a control patch containing a lamp, a ring sampled
    on the sprite's own frame, and a subject that was never in shot because
    `camNow` is lerped inside `render()` and stepping `update()` moves the camera
    not at all. One line checking that the setup did what you think turns each of
    these from a mystery into a message.
- 2026-09-04 · redesign · being seen starts a hunt instead of ending the run; the prize opens the exit and gold became optional score; greed costs speed; the escape act climbs and takes the dark away; three screen beats; three heist tools; a dash. Removed EXIT_EARLY, CLEAR_BONUS's all-coins demand, fSeen being set by bumpAlert, and a duplicate exit chevron
- 2026-09-04 · contracts · twenty floors are five contracts of four, each ending at a fence: bank it or leave it on the table, +25% per contract cleared, and being taken loses whatever was still on it, 7 assertions
- 2026-09-04 · shop · kit is bought at the fence out of the take, so buying banks less and the contract asks three questions instead of one; a full gadget refuses the sale, 5 assertions
- 2026-09-04 · U7 · shift change around 52s (+/-14 jitter): drones rotate onto each other's routes by INDEX, since a drone's route is not the same array object as the one in MAPS and indexOf answers -1, 5 assertions
- 2026-09-04 · U13 · the minimap marks where they think you are, averaged from the same lastX/lastY the search AI steers on, and only while someone is actually looking, 2 assertions
- 2026-09-04 · harness · boot is waited on rather than timed. A fixed 2200ms sleep before the first assertion had been a bet on how long the page takes to load, and the bet got tighter every time the game grew - it lost today with ReferenceError: __fp is not defined
- 2026-09-04 · P1-P4 · found already built and never ticked: condition chips on the menu, wipeCond on the floor card, MOD() named in the pause briefing with (SWAPPED), modClash() refusing a condition a floor already does, and a daily run seeding its condition from the date. Verified in the source and in five harness references before ticking
- 2026-09-05 · story · twenty named prizes with a line each and five clients whose briefs cool as the night goes on, surfaced on the floor card and at the fence. Nothing new to read: the same beats, now with a reason
- 2026-09-05 · U6 · 60 lockers, three a floor, in nooks. Hiding is a gamble - whether it saves you was decided a moment earlier by whether anything had eyes on you, and something that watched you climb in comes and opens it, 6 assertions
- 2026-09-05 · U9 · 33 jewels behind glass, in safes or down dead ends: worth four coins and heard at 608 against a coin's 380, 4 assertions
- 2026-09-05 · U8 · a floor plan on every floor, drawn under your own memory of the building - walls only, never a drone, which is the line between a map and a radar, 2 assertions
- 2026-09-05 · trap · T.COIN_R does not exist and 'distance > undefined' is false, so the jewel guard never skipped: every jewel on every floor was taken on frame one, each firing a 608 noise. Four unrelated AI timing blocks failed from phantom noise. Sixth name-I-assumed of the session
- 2026-09-05 · U11 · a second way out on the twelve deep floors, 662-1092px from the first. exitPt keeps meaning one point - the NEAREST one - so the trigger, compass, beacon and minimap never had to learn about the second door, 6 assertions
- 2026-09-05 · maps · measured before changing: every floor already has 41-217 independent loops, so no floor is a corridor tree and a chase always has somewhere to go. Left alone
- 2026-09-05 · maps · the real gap was tools bought blind: 18 of 20 floors gave at least one of them nothing to do. 8 safes and 12 doors added from the second contract on. Every door is placed only where the floor stays fully connected with it treated as solid, so it is a locked shortcut and never a gate. THE COLD STORE fits neither and keeps none
- 2026-09-05 · assertion · 'safes stay scarce' rewritten a second time. Scarcity stopped being the rule when a drill became buyable - a tool costing 780 cannot meet four floors with nothing to open. What survives is that the first contract has none
- 2026-09-05 · balance · MEASURED, after getting it wrong twice. A player fleeing straight away from the nearest hunter from 300px is caught on 17 of 19 floors, between 1.9s and 14.5s; two floors allow a clean escape. Contact-death did NOT delete the failure state - running blindly is not enough, which is what the flanking and cornering AI was always for. Fastest catches are the dead-end-heavy floors (THE STACKS 1.9s, THE COLD STORE 2.0s), which is the design working
- 2026-09-05 · trap · three attempts at that measurement, all wrong in the SETUP. Drones at 70px against a 26px contact radius; then a 'fleeing' player that ran in the first open direction regardless of the threat. Both produced confident numbers. Both were caught by checking the result against arithmetic I could do independently: 0.7s to close 274px is impossible at 199px/s. A measurement you cannot sanity-check against something you already know is worth nothing
- 2026-09-05 · verify · a pessimistic reachability pass found two things 842 assertions did not: a locker on THE HOUSE sealed behind a mirror, and a THE BANK VAULT patrol waypoint behind a locked door that no drone can open. Both fixed. The third flag was correct design - a coin IS locked away there, and the keycard is on the near side, which was checked rather than assumed
- 2026-09-05 · cut · six features out: difficulty modes, endless, ghost replay, the daily run, the fake drone hiding, and the glint that only existed to hint at the drone you could not see. ~250 lines of test removed with them - a suite that keeps testing an unreachable feature passes against dead code and makes a removal look finished when it is not
- 2026-09-05 · change · drones and sentries are always drawn. Their cone was drawn unconditionally and AFTER the darkness composite, so hiding the body advertised the position and hid only the thing you needed to read. Listeners have no cone and stay hidden, which is a real mechanic
- 2026-09-05 · change · the prize is marked on the minimap from the first second. Wandering was search, not skill, and the dullest part of the loop; a floor is a routing problem now
- 2026-09-05 · briefing · a floor opens on a plan: the building drawn from the same grid the game walks on, three computed doors each carrying distance-to-prize and nearest-patrol, and the chosen one lit. Gated behind a flag the harness turns off, because it parks the game in mode 'brief' where update() returns early
- 2026-09-05 · knock · noise became a verb. Free, 300px, 2.6s cooldown, deliberately quieter than a sprint. Found a real bug doing it: knockCool was in the decay and not in loadMap's reset, so a cooldown survived the stairs
- 2026-09-05 · intel · the building is free and the people in it cost 320 out of the take, so the money answers three questions instead of two: bank it, arm yourself, or know what you are walking into
- 2026-09-05 · trap · drawPlan was the third name collision of the session after burst() and safeT. Naming a function for what it does without grepping whether something already does it is now the single most expensive habit in this project
- 2026-09-05 · looked at it · a playthrough script that drives one floor and photographs the briefing, the infiltration, the crack and the escape. Found three things the suite could not: the plan canvas positioned absolute by a global rule and covering the title, the GO button below the fold, and an escape act visually identical to the quiet half
- 2026-09-05 · escape · the lights now genuinely come up (0.34 -> 0.19 ambient), the room warms, and alarm bars sweep top and bottom. Measured against the quiet half: 11x warmer, 73% brighter
- 2026-09-05 · balance · 2064982 · tools measured across 20 floors: the quiet lance opened 5 where the loud drill opened 12, so it goes near-silent (60) and quicker (3.8s); bare hands 7.5s→4.2s because 7.5 opened 1 floor in 20
- 2026-09-05 · response · 44231fc · RESPONSE_EVERY 14→5. It had never fired: the way out is 21 tiles ≈ 4s at a sprint. Swept 14/8/6/5/4 against clean and fumbled escapes; 5 gives 3/20 clean vs 19/20 fumbled. Old guard scaled with the constant so it passed at any value; replaced with one anchored to the real routes. Also settled floors 17/19 (vault behind a vent) and 20 (out through a duct) as design, not breakage
- 2026-09-05 · floor · 6b620b9 · per-tile 12% colour coin-flip → two-octave value noise on a 5-tile lattice, and the 4-sided tile outline → 2 sides at half weight. A room reads as a surface instead of a checkerboard. Contract economy pinned: break-even survival per push 30/37/39/40%
- 2026-09-05 · torch · 0c441bf · the player's light bubble was gated on flHits.length, a stale ray count, so dousing the torch changed the picture by ±1 while detection correctly went to zero. It now follows beamOn and collapses to 30px/0.34 — dark, but still findable
- 2026-09-05 · depth · route width measured across 20 floors (median 3.05 tiles abreast, 1 single-file) and pinned with 5 assertions; skill gradient measured — quiet+careful buys +68% survival over naive play; the old "seen = dead" rule is gone, meter >= 1 now calls identify() not caught()
