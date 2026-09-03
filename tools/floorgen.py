"""Generate a 28x18 Flashpoint floor that plays like a building.

The old generator carved big overlapping boxes and joined their centres, which
measured at up to 265 loops on a 300-tile floor - that is an open field with
pillars, not architecture - and left dead straight sightlines the full 26-tile
width of the map.

This one carves room INTERIORS separated by walls, then pierces those walls at
single tiles to make doorways. Chokepoints come for free, loops are added
deliberately rather than by accident, and long straight runs get broken.

Everything is scored against targets and the best of N candidates wins, so the
output is measurably better rather than differently random.
"""
import random
from collections import deque

COLS, ROWS = 28, 18
BLOCK = set('#G$OM')          # tiles a body cannot pass

# Measured against the twelve hand-made floors, which ran 41-265 loops on ~300
# open tiles - an open field with pillars. A room-and-doorway floor lands far
# lower, and coverage matters more than the loop count: weighting loops heavily
# and space lightly just optimises toward an emptier map.
# First attempt aimed at 185-265 open tiles and broke the game: the player
# spawned in a corner and moved 7px before hitting a wall, flanking could not
# find an open ring, D1 had no floor for the beam to land on, and every crate
# was reverted for sealing a route. This game needs SPACE as well as structure.
# Rooms are wide now and the target is 250-300, which is where the twelve
# hand-made floors sat; what changes is the sightlines and the loop count.
TARGET = dict(loops=(40, 130), sight=15, dead=5, openMin=245, openMax=305)


def _zones(rnd, cols, rws):
    """Split the interior into a grid of zones with jittered borders, so rooms
    cover the whole map and share walls the way rooms in a building do."""
    xs = [1]
    for i in range(1, cols):
        xs.append(round(1 + (COLS - 2) * i / cols) + rnd.randint(-1, 1))
    xs.append(COLS - 1)
    ys = [1]
    for i in range(1, rws):
        ys.append(round(1 + (ROWS - 2) * i / rws) + rnd.randint(-1, 1))
    ys.append(ROWS - 1)
    xs = sorted(set(xs)); ys = sorted(set(ys))
    out = []
    for j in range(len(ys) - 1):
        for i in range(len(xs) - 1):
            out.append((xs[i], ys[j], xs[i + 1] - xs[i], ys[j + 1] - ys[j]))
    return out


def _rooms(rnd, want):
    """Kept for callers that still want scattered rectangles."""
    out = []
    for _ in range(600):
        if len(out) >= want:
            break
        w = rnd.randint(4, 7)
        h = rnd.randint(3, 5)
        x = rnd.randint(2, COLS - w - 2)
        y = rnd.randint(2, ROWS - h - 2)
        if any(not (x + w + 1 < rx or rx + rw + 1 < x or y + h + 1 < ry or ry + rh + 1 < y)
               for rx, ry, rw, rh in out):
            continue
        out.append((x, y, w, h))
    return out


def _carve(g, rooms):
    for x, y, w, h in rooms:
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                g[yy][xx] = '.'


def _corridor(g, a, b, rnd):
    """An L between two points, carved as corridor. Returns tiles touched."""
    (x0, y0), (x1, y1) = a, b
    tiles = []
    if rnd.random() < 0.5:
        for x in range(min(x0, x1), max(x0, x1) + 1): tiles.append((x, y0))
        for y in range(min(y0, y1), max(y0, y1) + 1): tiles.append((x1, y))
    else:
        for y in range(min(y0, y1), max(y0, y1) + 1): tiles.append((x0, y))
        for x in range(min(x0, x1), max(x0, x1) + 1): tiles.append((x, y1))
    for (x, y) in tiles:
        if 1 <= x < COLS - 1 and 1 <= y < ROWS - 1:
            g[y][x] = '.'
    return tiles


def open_cells(g):
    return {(x, y) for y in range(ROWS) for x in range(COLS) if g[y][x] not in BLOCK}


def metrics(g):
    cells = open_cells(g)
    edges = 0
    deg = {}
    for (x, y) in cells:
        d = 0
        for dx, dy in ((1, 0), (0, 1), (-1, 0), (0, -1)):
            if (x + dx, y + dy) in cells:
                d += 1
                if (dx, dy) in ((1, 0), (0, 1)):
                    edges += 1
        deg[(x, y)] = d
    loops = edges - len(cells) + 1
    dead = sum(1 for p in deg if deg[p] == 1)
    sight = 0
    for y in range(ROWS):
        run = 0
        for x in range(COLS):
            run = run + 1 if (x, y) in cells else 0
            sight = max(sight, run)
    for x in range(COLS):
        run = 0
        for y in range(ROWS):
            run = run + 1 if (x, y) in cells else 0
            sight = max(sight, run)
    return dict(open=len(cells), loops=loops, dead=dead, sight=sight)


def reach(g, start):
    cells = open_cells(g)
    if start not in cells:
        return {}
    seen = {start: 0}
    q = deque([start])
    while q:
        x, y = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            n = (x + dx, y + dy)
            if n in cells and n not in seen:
                seen[n] = seen[(x, y)] + 1
                q.append(n)
    return seen


def _break_sightlines(g, rnd, limit=13):
    """Drop a pillar into any straight run longer than the limit."""
    for _ in range(60):
        cells = open_cells(g)
        worst = None
        for y in range(1, ROWS - 1):
            run = []
            for x in range(COLS):
                if (x, y) in cells:
                    run.append((x, y))
                else:
                    if len(run) > limit and (worst is None or len(run) > worst[0]):
                        worst = (len(run), list(run))
                    run = []
            if len(run) > limit and (worst is None or len(run) > worst[0]):
                worst = (len(run), list(run))
        for x in range(1, COLS - 1):
            run = []
            for y in range(ROWS):
                if (x, y) in cells:
                    run.append((x, y))
                else:
                    if len(run) > limit and (worst is None or len(run) > worst[0]):
                        worst = (len(run), list(run))
                    run = []
            if len(run) > limit and (worst is None or len(run) > worst[0]):
                worst = (len(run), list(run))
        if not worst:
            return
        run = worst[1]
        mid = run[len(run) // 2 + rnd.randint(-1, 1)]
        before = [r[:] for r in g]
        g[mid[1]][mid[0]] = '#'
        # never let a pillar split the floor in two
        cells = open_cells(g)
        if cells:
            any_cell = next(iter(cells))
            if len(reach(g, any_cell)) != len(cells):
                for y in range(ROWS):
                    g[y] = before[y]
                return


def _layout(seed, rooms_want, extra_links):
    """Rooms carved inside zones, joined by single-tile doorways. The doorway is
    the whole point: it is a chokepoint you have to commit to, where the old
    generator's overlapping boxes let you drift past anything."""
    rnd = random.Random(seed)
    g = [['#'] * COLS for _ in range(ROWS)]
    cols = 4 if rooms_want <= 9 else 5
    rws = 3
    zones = _zones(rnd, cols, rws)
    rooms = []
    for (zx, zy, zw, zh) in zones:
        if zw < 4 or zh < 3:
            rooms.append(None); continue
        # one wall between rooms, not two: the room fills its zone bar the
        # right and bottom edges, which become the shared walls
        x = zx
        y = zy
        w = zw - 1
        h = zh - 1
        if w < 2 or h < 2:
            rooms.append(None); continue
        # one zone in twelve stays solid, so the floor is not a perfect lattice
        if rnd.random() < 0.06:
            rooms.append(None); continue
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                g[yy][xx] = '.'
        rooms.append((x, y, w, h))

    live = [(i, r) for i, r in enumerate(rooms) if r]
    if len(live) < 5:
        return None

    def door(a, b):
        """Pierce the wall between two rooms at one tile."""
        ax, ay, aw, ah = a
        bx, by, bw, bh = b
        ox0, ox1 = max(ax, bx), min(ax + aw, bx + bw)
        oy0, oy1 = max(ay, by), min(ay + ah, by + bh)
        if ox1 - ox0 >= 1 and (by > ay + ah - 1 or ay > by + bh - 1):
            x = rnd.randrange(ox0, ox1)
            y0, y1 = (ay + ah, by - 1) if by > ay else (by + bh, ay - 1)
            for y in range(min(y0, y1), max(y0, y1) + 1):
                g[y][x] = '.'
            return True
        if oy1 - oy0 >= 1 and (bx > ax + aw - 1 or ax > bx + bw - 1):
            y = rnd.randrange(oy0, oy1)
            x0, x1 = (ax + aw, bx - 1) if bx > ax else (bx + bw, ax - 1)
            for x in range(min(x0, x1), max(x0, x1) + 1):
                g[y][x] = '.'
            return True
        return False

    # spanning pass: every room gets at least one way in
    for k in range(1, len(rooms)):
        if not rooms[k]: continue
        for prev in (k - 1, k - cols):
            if prev >= 0 and rooms[prev] and door(rooms[prev], rooms[k]):
                break
        else:
            for j, r in live:
                if j != k and door(r, rooms[k]):
                    break
    # a handful of extra doors so you can circle a patrol rather than reverse
    for _ in range(extra_links):
        a, b = rnd.sample([r for _, r in live], 2)
        door(a, b)

    for x in range(COLS):
        g[0][x] = '#'; g[ROWS - 1][x] = '#'
    for y in range(ROWS):
        g[y][0] = '#'; g[y][COLS - 1] = '#'

    # Repair rather than reject. Discarding an unconnected layout meant the
    # survivors were the sparse ones - a third of the map came out solid - so
    # anything still cut off gets a corridor to the main body instead.
    for _ in range(12):
        cells = open_cells(g)
        if not cells:
            return None
        seen = reach(g, next(iter(cells)))
        if len(seen) == len(cells):
            break
        stray = next(p for p in cells if p not in seen)
        anchor = min(seen, key=lambda q: abs(q[0] - stray[0]) + abs(q[1] - stray[1]))
        _corridor(g, stray, anchor, rnd)
    cells = open_cells(g)
    if not cells or len(reach(g, next(iter(cells)))) != len(cells):
        return None
    _break_sightlines(g, rnd)
    return g, [r for _, r in live], rnd


def _score(g):
    m = metrics(g)
    s = 0.0
    lo, hi = TARGET['loops']
    if m['loops'] < lo: s += (lo - m['loops']) * 1.0
    if m['loops'] > hi: s += (m['loops'] - hi) * 1.0
    if m['sight'] > TARGET['sight']: s += (m['sight'] - TARGET['sight']) * 5.0
    if m['dead'] > TARGET['dead']: s += (m['dead'] - TARGET['dead']) * 3.0
    # a floor that does not use its own space is the worst outcome here
    if m['open'] < TARGET['openMin']: s += (TARGET['openMin'] - m['open']) * 2.5
    if m['open'] > TARGET['openMax']: s += (m['open'] - TARGET['openMax']) * 1.0
    return s, m


def _far_pair(g):
    """Spawn and exit as far apart as the floor allows."""
    cells = list(open_cells(g))
    best = None
    for _ in range(40):
        a = random.choice(cells)
        d = reach(g, a)
        if not d: continue
        b = max(d, key=lambda p: d[p])
        if best is None or d[b] > best[0]:
            best = (d[b], a, b)
    return (best[1], best[2]) if best else (cells[0], cells[-1])


def _elbow(g, p):
    """How many open tiles sit within two steps - room to actually move."""
    cells = open_cells(g)
    return sum(1 for dx in range(-2, 3) for dy in range(-2, 3)
               if (p[0] + dx, p[1] + dy) in cells)


def _put(g, cells, ch, n, rnd, avoid, near=None, mind=0):
    """Place n of ch on free floor, optionally near a set of anchors."""
    placed = []
    pool = [p for p in cells if g[p[1]][p[0]] == '.' and p not in avoid]
    if near:
        pool.sort(key=lambda p: min(abs(p[0]-a[0]) + abs(p[1]-a[1]) for a in near))
    else:
        rnd.shuffle(pool)
    for p in pool:
        if len(placed) >= n: break
        if mind and placed and min(abs(p[0]-q[0]) + abs(p[1]-q[1]) for q in placed) < mind: continue
        if any(abs(p[0]-a[0]) + abs(p[1]-a[1]) < 2 for a in avoid): continue
        g[p[1]][p[0]] = ch
        placed.append(p)
    return placed


def _blocking_ok(g, spawn):
    """After placing blockers, is everything that matters still reachable?"""
    d = reach(g, spawn)
    for y in range(ROWS):
        for x in range(COLS):
            if g[y][x] in 'cE' and (x, y) not in d:
                return False
    return True


def _routes(g, rooms, spawn, n, rnd):
    """One patrol per bot, touring room centres it can actually reach."""
    d = reach(g, spawn)
    centres = [c for c in [(x + w // 2, y + h // 2) for x, y, w, h in rooms] if c in d]
    if len(centres) < 3:
        centres = [p for p in d if d[p] > 4][:8]
    out = []
    for i in range(n):
        pts = centres[:]
        rnd.shuffle(pts)
        pts = pts[:max(4, min(6, len(pts)))]
        pts.sort(key=lambda p: (p[1] // 6, p[0] if (p[1] // 6) % 2 == 0 else -p[0]))
        out.append([[p[0], p[1]] for p in pts] + [[pts[0][0], pts[0][1]]])
    return out


def make(seed, coins, bots, rooms=8, extra=3, specials=None, tries=90):
    """Best-of-N floor. `specials` is {char: count} for tiles beyond the basics."""
    specials = specials or {}
    best = None
    for t in range(tries):
        built = _layout(seed * 1000 + t, rooms, extra)
        if not built: continue
        g, rects, rnd = built
        sc, m = _score(g)
        if best is None or sc < best[0]:
            best = (sc, g, rects, rnd, m)
        if sc == 0: break
    if best is None: return None
    sc, g, rects, rnd, m = best
    g = [row[:] for row in g]
    cells = list(open_cells(g))

    spawn, exitp = _far_pair(g)
    # A corner you cannot walk out of is not a spawn - but neither is a roomy
    # tile next door to the exit. Take the best elbow room among tiles that are
    # still most of the floor away from the door.
    d = reach(g, exitp)
    far = max(d.values()) if d else 0
    room = [p for p in open_cells(g) if d.get(p, 0) > far * 0.72]
    if room:
        spawn = max(room, key=lambda p: _elbow(g, p))
    g[spawn[1]][spawn[0]] = 'P'
    g[exitp[1]][exitp[0]] = 'E'
    avoid = {spawn, exitp}

    lamps = _put(g, cells, 'L', max(3, coins // 3), rnd, avoid, mind=4)
    # a third of the gold sits in lamplight: a free hint and a trap at once
    litwant = max(1, round(coins / 3))
    lit = _put(g, cells, 'c', litwant, rnd, avoid | set(lamps), near=lamps, mind=2)
    dark = _put(g, cells, 'c', coins - litwant, rnd, avoid | set(lamps) | set(lit), mind=3)
    avoid |= set(lamps) | set(lit) | set(dark)

    for ch, count in specials.items():
        got = []
        for _ in range(count):
            # one at a time, so a single bad spot does not throw the others away
            before = [r[:] for r in g]
            one = _put(g, cells, ch, 1, rnd, avoid | set(got), mind=3)
            if not one:
                break
            if ch in BLOCK and not _blocking_ok(g, spawn):
                for y in range(ROWS): g[y] = before[y]
                continue
            got += one
        avoid |= set(got)

    _put(g, cells, 'x', 6, rnd, avoid, mind=2)
    routes = _routes(g, rects, spawn, bots, rnd)
    return dict(rows=[''.join(r) for r in g], routes=routes, metrics=metrics(g), score=sc)
