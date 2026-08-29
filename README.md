# Flashpoint

> A heist in a world with no light — only two 30° cones. Yours is white. Theirs is red.

A tiny, pretty, no-build browser stealth-arcade game — one HTML file, zero
dependencies, no image or audio assets. Everything is drawn and synthesized at
runtime.

![Flashpoint — a flashlight sweep reveals a patroller's red cone](docs/screenshot.png)

## The game

Sweep a dark complex of rooms, aisles and neon streets with your flashlight,
grab every coin, and reach the door — while security drones patrol with their
own 30° vision cones. The layout is always faintly readable; **only the hunters
hide in the dark** — your beam is the only thing that reveals them. They see
what their light sees, and nothing else.

- **True occlusion** — both cones are raycasts. A corner between you and a
  red beam is a corner between you and a red beam. Peek around it with the
  mouse without leaning your body into the light.
- **Sound is a currency** — sprinting and grabbing coins make noise. Bots hear
  noise, walk to it, and swing their cones while investigating. Walk (or tilt
  the stick a little) to go quiet.
- **Light is a liability** — standing in a lamp or neon pool makes the meter
  fill faster. The darkness that hides you from them is also what blinds you.
- **Memory** — what your beam recently lit stays faintly burned into your view,
  so sweeping is mapping.
- **Caught = run over.** One meter-fill and it's done. Four floors to clear,
  then endless loops. Your name rides on a device-local leaderboard (no login,
  no accounts, nothing leaves the browser).

## The four floors

| # | Floor | Light | Threat |
|---|-------|-------|--------|
| 1 | The House | warm lamps, TV flicker | 1 slow patroller |
| 2 | The Warehouse | swaying hang-lamps, dust shafts | 1 fast patroller |
| 3 | Neon Heights | rain, flickering neon pools | 2 bots, crossing loops |
| 4 | The Abandoned | near-dark, random 4s blackouts | 2 bots in the black |

Clear all four → **YOU ESCAPED** → endless mode: the rotation repeats, loops
add bots and speed, and your best depth per device is kept.

## Controls

| | Desktop | Mobile / tablet |
|---|---|---|
| Move | `WASD` / arrows | **left thumb** floating stick |
| Sneak | (walk = quiet already) | tilt the stick a **little** |
| Sprint (loud) | `Shift` | stretch the stick **all the way** |
| Aim beam | **mouse** | **right thumb** stick (aim holds when you let go) |
| Ping of doubt | — | just stop moving |
| Mute / pause | `M` / `P` | HUD buttons |
| Restart | `R`, or `Space` on the card | tap the button |

Portrait works; landscape is the intended view. Touch devices get their own
DPR cap and particle budgets automatically. Haptics fire where supported
(Android) when a cone touches you and on capture.

## How it works

- **Lighting stack**: the world renders under a soft darkness layer, punched
  open by the flashlight fan and lamp pools. Coins, the exit beacon and your
  diver ride *above* the darkness — always readable — while drones render only
  inside your occluded raycast cone. Darkness means "one of them might be
  standing right there".
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
map connectivity, mouse aim, WASD + thumbstick movement, cone detection
filling → caught → card, LOS hiding draining, coin → exit → advance,
ward blackouts, full campaign → win → endless escalation, leaderboard
persistence, touch stick lifecycle, portrait viewport, zero console errors.

## Privacy

No accounts, no network, no telemetry. Name and leaderboard live in
`localStorage` on the player's own device.

## License

MIT — see [LICENSE](LICENSE).
