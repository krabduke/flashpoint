# Flashpoint

> A heist in a world with no light — only two 30° cones. Yours is white. Theirs is red.

A tiny, pretty, no-build browser stealth-arcade game — one HTML file, zero
dependencies, no image or audio assets. Everything is drawn and synthesized at
runtime.

![Flashpoint — a flashlight sweep reveals a patroller's red cone](docs/screenshot.png)

## The game

Sweep a dark complex of rooms, aisles and neon streets with your flashlight,
grab every coin, and reach the door — while security drones patrol with their
own 30° vision cones. The layout is always faintly readable, but **the hunters
and the gold both hide in the dark** — your beam is the only thing that reveals
either. They see what their light sees, and nothing else.

- **True occlusion** — both cones are raycasts. A corner between you and a
  red beam is a corner between you and a red beam. Peek around it with the
  mouse without leaning your body into the light.
- **Gold does not glow** — an unlit coin is not on your screen at all. Sweep a
  room to find its coins; once your beam has touched one it stays pinned as a
  ring you can navigate back to. Stand close and you'll catch a faint glint off
  one you haven't found yet. Coins sitting in a lamp pool are visible without
  your torch — and standing in that pool is what gets you caught.
- **You are carrying it** — the satchel on your back fills with gold as the floor
  empties, so a glance at yourself tells you how much of the haul is already on
  you and how much of the room is left to sweep.
- **Sound is a currency** — sprinting and grabbing coins make noise. Bots hear
  noise, walk to it, and swing their cones while investigating. Walk (or tilt
  the stick a little) to go quiet.
- **The torch runs out** — about 45 seconds of continuous light, recovering
  slowly while it is off. Sweeping a room costs you something now, so the question
  stops being "where is the gold" and becomes "where can I afford to look". Run it
  flat and it cuts out until it has rested. `B` cells top it back up.
- **Flares buy light at a distance** — two per floor, thrown with `Q`. One lights
  a room for eleven seconds so you can read its gold without spending torch on
  it, and it keeps burning through a blackout when every mains lamp is dead. It
  also lands loudly, and drones walk toward light. You are buying sight with
  attention.
- **Throw a coin to be somewhere else** — `E` lobs one you are carrying. It
  clatters where it lands and drones walk to noise. The floor still wants every
  coin, though, so you have moved gold you need toward the thing now coming to
  look at it.
- **Smoke hides you from yourself too** — one pellet a floor, dropped at your
  feet with `X`. Nothing sees through it: not a drone's cone, not a searchlight.
  But you are standing in the same cloud, so your own beam chokes to a stub while
  you are inside it. Cover and blindness are the same nine seconds.
- **An EMP costs you the lights** — one charge a floor on `C`. Everything
  electric inside the bubble stops for five and a half seconds: lamps, neon,
  cameras, laser gates. It is local, so gates outside it keep running. And the
  lamps it kills were the ones showing you where the gold was.
- **A decoy keeps talking** — one a floor on `V`. A thrown coin is a single
  clatter and they drift back; a decoy chirps every second or so for twelve, which
  is long enough to walk a corridor they were standing in.
- **The magnet does not need to see** — eight seconds of dragging any loose coin
  within reach toward you, lit or not, which is how you strip a black room
  without spending torch on it. Every coin it lands still fires the pickup noise,
  so a big haul is a loud one.
- **Locked doors take a card or a wait** — four floors seal a corridor behind a
  lock. A keycard found elsewhere opens one the moment you reach it. Without one
  you pick it, which takes a second and a half of standing perfectly still in a
  doorway, and moving cancels it. There is always a way through, so no floor can
  strand you.
- **The kit is yours for the whole run** — you start with one flare and one smoke
  pellet, and everything else is found. Twenty gadgets lie scattered across the
  nine floors, one on the House and four in the CORE, and what you carry goes
  down the stairs with you. A flare you skipped on floor two is a flare you do
  not have when the lights go out.
- **Cameras never move, so they have a safe side** — the secured floors mount
  fixed lenses on the walls, each looking down its longest clear line. Unlike a
  sweeping searchlight there is no waiting for it to pass: you learn the angle
  and take the other route. They are on the same circuit as everything else, so
  smoke breaks their line and an EMP puts them out.
- **Light is a liability** — standing in a lamp or neon pool makes the meter
  fill faster. The darkness that hides you from them is also what blinds you.
- **Memory** — what your beam recently lit stays faintly burned into your view,
  so sweeping is mapping.
- **They get better as you go deeper** — a drone that spots you accelerates the
  longer it holds you, floor by floor, until only a sprint escapes it. From the
  Museum down they run a radio net: one drone seeing you sends the rest.
  Searchlights are part of that net — stand in one and it screams your position.
- **Three things worth crossing a dark room for** — power-ups carry their own
  light, so you can see them from across a black floor. **Lens** stretches the
  beam by 60% for 14s, which is how you clear a big room fast now that gold needs
  lighting. **Soft shoes** make you 32% quicker *and* silence your sprint for 11s
  — the only time running is free. **Ghost** freezes the detection meter for 8s.
- **Caught = run over.** One meter-fill and it's done. Nine floors to clear,
  then endless loops. Your name rides on a device-local leaderboard (no login,
  no accounts, nothing leaves the browser).

## The nine floors

| # | Floor | Light | Threat |
|---|-------|-------|--------|
| 1 | The House | warm lamps, TV flicker | 1 slow patroller |
| 2 | The Warehouse | swaying hang-lamps, dust shafts | 1 fast patroller |
| 3 | Neon Heights | rain, flickering neon pools | 2 bots, crossing loops |
| 4 | The Abandoned | near-dark, random 4s blackouts | 2 bots in the black |
| 5 | The Museum | marble slabs, golden calm | 2 bots + **sweeping searchlights** + a fixed camera |
| 6 | The Server Farm | cold raised panels, LED racks | 2 bots + **pulsing laser gates** — a live beam spikes detection and screams your position |
| 7 | The Bank Vault | brass-lit vault rooms | 3 bots + **siren sweeps** — periodically every drone wakes and its cone grows |
| 8 | The Fog Docks | rain, amber dock lamps | 3 bots + **fog banks** — your beam strangles to a candle for six seconds |
| 9 | The CORE | red emergency gloom | 3 fast bots + blackouts + sirens + searchlights. Everything listens. |

Clear all nine → **YOU ESCAPED** → endless mode: the rotation repeats, loops
add bots and speed, and your best depth per device is kept.

## Controls

| | Desktop | Mobile / tablet |
|---|---|---|
| Move | `WASD` / arrows | **left thumb** floating stick |
| Sneak | (walk = quiet already) | tilt the stick a **little** |
| Sprint (loud) | `Shift` | stretch the stick **all the way** |
| Aim beam | **mouse** | **right thumb** stick (aim holds when you let go) |
| Ping of doubt | — | just stop moving |
| Torch on/off | `F` | HUD buttons |
| Throw a flare | `Q` | HUD buttons |
| Throw a coin | `E` | HUD buttons |
| Drop smoke | `X` | HUD buttons |
| Fire an EMP | `C` | HUD buttons |
| Set a decoy | `V` | HUD buttons |
| Run the magnet | `G` | HUD buttons |
| Any gadget | the key shown on it | **tap it in the item bar** |
| Mute / pause | `M` / `P` | HUD buttons |
| Restart | `R`, or `Space` on the card | tap the button |

Portrait works; landscape is the intended view. Touch devices get their own
DPR cap and particle budgets automatically. Haptics fire where supported
(Android) when a cone touches you and on capture.

## How it works

- **Lighting stack**: the world renders under a soft darkness layer, punched
  open by the flashlight fan and lamp pools. The exit beacon and your thief ride
  *above* the darkness and stay readable; drones and coins render only where
  light actually reaches them — your cone, or a lamp pool. Darkness means "one of
  them might be standing right there, and so might the money".
- **Vision**: both cones are grid raycasts; detection = in-cone + clear LOS +
  distance. Bots path with A* on the 28×18 tile grid; the bot that heard you
  walks to the noise, not to you — you are never aimbot-tracked, only hunted.
- **Maps** are ASCII tile strings (validated for connectivity at boot and by
  the test harness: exit reachable, every coin reachable, every route
  waypoint walkable).
- **Audio** is a small WebAudio synth (drone, heartbeat that follows the
  detection meter, sirens, footsteps, rain noise bed) — no files.
- Test hooks: `?autostart` starts a run immediately, `?name=ROBBIE` sets the
  runner name. Harmless in normal play; used by the CI-style harness.

## Run it

Open `index.html` in any browser. Done. Or `npx serve .`

**Hosting on Vercel** (or Netlify/GitHub Pages): this is a static single file —
import this repo, framework preset *Other*, build command empty, output
directory `.` — deploy. (GitHub Pages is already enabled on this repo:
https://krabduke.github.io/flashpoint/)

## Tests

```sh
node test/flashpoint.cdp.mjs
```

A dependency-free CDP harness (Node ≥ 22, native WebSocket) drives real
headless Chrome through the real game loop and asserts actual state:
map connectivity (all nine floors), mouse aim, live coin pickup, cone
detection filling → caught → card, LOS hiding draining, searchlight exposure,
laser-gate zap, siren sweep, fog beam-shrink, blackouts, full campaign → win →
endless escalation, leaderboard persistence, twin thumbstick touch lifecycle,
portrait viewport, and zero console errors.

It also asserts pixels where a predicate is not enough: that a lit coin is
actually brighter than the floor beside it, that a remembered one stays findable,
and that a filling meter really does turn the screen edge red.

## What it remembers

A lifetime record sits under the floor picker: runs played, campaigns cleared,
best clear time, and total gold lifted. It lives in `localStorage` beside the
leaderboard — same promise, nothing leaves the device.

## Privacy

No accounts, no network, no telemetry. Name and leaderboard live in
`localStorage` on the player's own device.

## License

MIT — see [LICENSE](LICENSE).
