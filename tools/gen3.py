#!/usr/bin/env python3
"""Generate the last three Flashpoint floors: THE FURNACE, THE STACKS, THE SPIRE.

Reuses tools/floorgen.py for the room-and-doorway layout and nothing else. The
placement, the sightline breaking and the open-cell trimming are done here,
because:

  * floorgen's _break_sightlines gives up on the first tile in a run that would
    split the floor. This one tries every tile in the run before conceding, so
    long runs actually get broken instead of surviving.
  * floorgen aims at 245-305 open tiles. These three have to land inside a much
    narrower band (230-260), so the open count is trimmed to an exact target
    with pillars that are connectivity-checked one at a time.
  * floorgen treats '#G$OM' as blocking. Doors block bodies too, so the full set
    '#G$OMD' is used everywhere here - including inside floorgen's own helpers,
    which read the module global.

Every count is exact or the attempt is thrown away. A floor that placed five of
six crates is a failed floor, never a quiet one.

tools/verify3.py re-checks the output from scratch and is the thing that decides
whether this worked.
"""
import json
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import floorgen as fg

COLS, ROWS = 28, 18
BLOCK = set('#G$OMD')        # everything that stops a body
SIGHT = set('#G$OM')         # what breaks a straight run, per the sightline rule

# floorgen's helpers read these module globals, so the full blocking set and a
# no-op sightline pass are installed before anything calls _layout. Breaking
# sightlines is done here instead, per floor, because THE STACKS wants its
# aisles long and floorgen would cut them all to 13.
fg.BLOCK = BLOCK
fg._break_sightlines = lambda g, rnd, limit=13: None

OUT = ('/private/tmp/claude-501/-Users-keenancasalegno-florasites-business/'
       '262f7775-823e-44dd-aa7e-e9f46161c14d/scratchpad/newmaps3.json')

SPECS = [
    dict(
        name='THE FURNACE', depth='FURNACE', theme='core',
        coins=16, bots=4, spd=1.46, flags={},
        specials={'O': 6, 'M': 3, 'L': 4, 'C': 2, '!': 3, 'x': 2},
        # cramped: small rooms, few extra links, hard sightline cap
        rooms=10, extra=2, sight=11, open=238,
        # cameras and plates to kill, and one way out of a room with no room
        gadgets='es', tries=4000,
    ),
    dict(
        name='THE STACKS', depth='STACKS', theme='warehouse',
        coins=17, bots=4, spd=1.47, flags={},
        specials={'O': 5, 'V': 4, 'L': 4, 'C': 2, 'G': 2, 'Y': 2, 'x': 2},
        # long aisles: wide rooms, sightline cap at the legal maximum
        rooms=9, extra=4, sight=15, open=250,
        # a decoy pulls a patrol off an aisle; an EMP answers the sentries
        gadgets='de', tries=4000,
    ),
    dict(
        name='THE SPIRE', depth='SPIRE', theme='city',
        coins=18, bots=4, spd=1.50, flags={'fog': True, 'siren': True, 'blackout': True},
        specials={'H': 3, 'N': 4, 'L': 2, 'V': 2, 'M': 2, '$': 1, 'Y': 2, 'x': 2},
        rooms=10, extra=3, sight=13, open=244,
        # muffle is the direct answer to three listeners; a flare is light you
        # own in a floor that keeps taking the lights away
        gadgets='hf', tries=14000,
    ),
]

NB = ((1, 0), (-1, 0), (0, 1), (0, -1))


def manh(a, b):
    return abs(a[0] - b[0]) + abs(a[1] - b[1])


def cheb(a, b):
    return max(abs(a[0] - b[0]), abs(a[1] - b[1]))


def dpx(a, b):
    """Distance between tile centres in pixels - centres are (x*40+20, y*40+20),
    so the +20 cancels and this is just 40x the euclidean tile distance."""
    return math.hypot((a[0] - b[0]) * 40.0, (a[1] - b[1]) * 40.0)


def opens(g, block=BLOCK):
    return {(x, y) for y in range(ROWS) for x in range(COLS) if g[y][x] not in block}


def bfs(g, start):
    cells = opens(g)
    if start not in cells:
        return {}
    seen = {start: 0}
    q = [start]
    i = 0
    while i < len(q):
        x, y = q[i]
        i += 1
        for dx, dy in NB:
            n = (x + dx, y + dy)
            if n in cells and n not in seen:
                seen[n] = seen[(x, y)] + 1
                q.append(n)
    return seen


def whole(g):
    """One connected piece of floor. Held as an invariant from the layout all
    the way through placement, which is what makes every coin, the exit, every
    drop and every waypoint reachable by construction."""
    cells = opens(g)
    if not cells:
        return False
    return len(bfs(g, min(cells))) == len(cells)


def runs_over(g, limit):
    """Every straight open run longer than `limit`, rows and columns both."""
    cells = opens(g, SIGHT)
    out = []
    for y in range(ROWS):
        run = []
        for x in range(COLS + 1):
            if x < COLS and (x, y) in cells:
                run.append((x, y))
            else:
                if len(run) > limit:
                    out.append(run)
                run = []
    for x in range(COLS):
        run = []
        for y in range(ROWS + 1):
            if y < ROWS and (x, y) in cells:
                run.append((x, y))
            else:
                if len(run) > limit:
                    out.append(run)
                run = []
    return out


def break_runs(g, limit, rounds=400):
    for _ in range(rounds):
        over = runs_over(g, limit)
        if not over:
            return True
        run = max(over, key=len)
        mid = len(run) // 2
        for i in sorted(range(len(run)), key=lambda i: (abs(i - mid), i)):
            x, y = run[i]
            if g[y][x] != '.':
                continue
            g[y][x] = '#'
            if whole(g):
                break
            g[y][x] = '.'
        else:
            return False          # this run cannot be broken without splitting the floor
    return not runs_over(g, limit)


def trim(g, rnd, target):
    """Pillar the floor down to exactly `target` open cells."""
    cells = sorted(opens(g))
    n = len(cells)
    if n < target:
        return False
    rnd.shuffle(cells)
    for (x, y) in cells:
        if n <= target:
            break
        if g[y][x] != '.':
            continue
        g[y][x] = '#'
        if whole(g):
            n -= 1
        else:
            g[y][x] = '.'
    return n == target


def elbow(g, p):
    """Open tiles within two steps - whether there is room to actually move."""
    cells = opens(g)
    return sum(1 for dx in range(-2, 3) for dy in range(-2, 3)
               if (p[0] + dx, p[1] + dy) in cells)


def neigh(p):
    return {(p[0] + dx, p[1] + dy) for dx, dy in NB}


def put(g, ch, n, rnd, taken, mind=0, keepout=(), near=None, neard=3):
    """Place exactly n of ch on plain floor, or place none and say so.

    keepout is a list of (tile, pixels) the placement must stay clear of.
    A blocker that would cut the floor in two is rejected and another tile
    tried, so the connectivity invariant survives placement."""
    pool = [(x, y) for y in range(ROWS) for x in range(COLS)
            if g[y][x] == '.' and (x, y) not in taken]
    if near:
        pool = [p for p in pool if min(cheb(p, a) for a in near) <= neard]
    rnd.shuffle(pool)
    got = []
    for p in pool:
        if len(got) >= n:
            break
        if g[p[1]][p[0]] != '.':
            continue
        if mind and got and min(manh(p, q) for q in got) < mind:
            continue
        if any(dpx(p, k) < px for k, px in keepout):
            continue
        g[p[1]][p[0]] = ch
        if ch in BLOCK and not whole(g):
            g[p[1]][p[0]] = '.'
            continue
        got.append(p)
    if len(got) < n:
        for (x, y) in got:
            g[y][x] = '.'
        return None
    return got


def put_try(g, ch, n, rnd, taken, minds, **kw):
    """Same, walking the spacing down rather than failing on a tight floor."""
    for m in minds:
        got = put(g, ch, n, rnd, taken, mind=m, **kw)
        if got is not None:
            return got
    return None


def make_routes(g, rects, spawn, exitp, n, rnd):
    """One patrol per bot, touring places worth walking past.

    Waypoints are drawn from the single open component, so they are on
    non-blocking tiles and reachable by construction - the failure the brief
    calls out is a waypoint that was never checked against the grid at all."""
    cells = opens(g)
    cand = []
    for (x, y, w, h) in rects:
        c = (x + w // 2, y + h // 2)
        if c in cells and c not in (spawn, exitp) and c not in cand:
            cand.append(c)
    # a room centre can end up under a crate; top the list up with floor tiles
    # spread as far from what is already chosen as possible
    pool = sorted(p for p in cells if p not in (spawn, exitp) and p not in cand)
    while len(cand) < 9 and pool:
        pick = max(pool, key=lambda p: (min([manh(p, q) for q in cand], default=99), p))
        cand.append(pick)
        pool.remove(pick)
    if len(cand) < 5:
        return None
    dist = {c: bfs(g, c) for c in cand}
    out = []
    for _ in range(n):
        pts = cand[:]
        rnd.shuffle(pts)
        pts = pts[:rnd.choice((5, 6))]
        tour = [pts[0]]
        left = pts[1:]
        while left:
            cur = tour[-1]
            nxt = min(left, key=lambda p: (dist[cur].get(p, 9999), p))
            tour.append(nxt)
            left.remove(nxt)
        # the beat must not begin on the player's doorstep; the game rotates the
        # route looking for the same 300px, so give it a start that already is
        starts = [j for j in range(len(tour)) if dpx(tour[j], spawn) > 330]
        if not starts:
            return None
        j = starts[0]
        tour = tour[j:] + tour[:j]
        out.append([[p[0], p[1]] for p in tour])
    return out


def gate(spec, rows, routes):
    """The generator's own gate. verify3.py re-checks all of this from scratch
    with its own code; this only exists to stop a bad candidate winning."""
    g = [list(r) for r in rows]
    flat = ''.join(rows)
    if len(rows) != 18 or any(len(r) != 28 for r in rows):
        return 'shape'
    if flat.count('P') != 1 or flat.count('E') != 1:
        return 'P/E'
    if flat.count('c') != spec['coins']:
        return 'coins'
    for ch, k in spec['specials'].items():
        if flat.count(ch) != k:
            return 'specials ' + ch
    spawn = next((x, y) for y in range(ROWS) for x in range(COLS) if g[y][x] == 'P')
    exitp = next((x, y) for y in range(ROWS) for x in range(COLS) if g[y][x] == 'E')
    d = bfs(g, spawn)
    for y in range(ROWS):
        for x in range(COLS):
            if g[y][x] in 'cE' or g[y][x] in 'fsedmhj':
                if (x, y) not in d:
                    return 'unreachable'
    if len(routes) != spec['bots']:
        return 'route count'
    for rt in routes:
        for p in rt:
            if tuple(p) not in d:
                return 'waypoint'
        if dpx(tuple(rt[0]), spawn) <= 300:
            return 'route start'
    for y in range(ROWS):
        for x in range(COLS):
            if g[y][x] in 'HY' and dpx((x, y), spawn) <= 300:
                return 'static bot at spawn'
    drops = [(x, y) for y in range(ROWS) for x in range(COLS) if g[y][x] in 'fsedmhj']
    if len(drops) != 2:
        return 'drops'
    if dpx(drops[0], drops[1]) < 240 or any(dpx(p, spawn) < 120 for p in drops):
        return 'drop spacing'
    if runs_over(g, 15):
        return 'sightline'
    n = len(opens(g))
    if not (230 <= n <= 260):
        return 'open ' + str(n)
    return None


def assemble(spec, seed):
    rnd = random.Random(seed * 7919 + 13)
    built = fg._layout(seed, spec['rooms'], spec['extra'])
    if not built:
        return None
    g = [row[:] for row in built[0]]
    rects = built[1]
    if not break_runs(g, spec['sight']):
        return None
    blockers = sum(v for k, v in spec['specials'].items() if k in BLOCK)
    if not trim(g, rnd, spec['open'] + blockers):
        return None
    cells = opens(g)

    # spawn and exit at opposite ends: a double BFS sweep finds the diameter
    d1 = bfs(g, min(cells))
    exitp = max(d1, key=lambda p: (d1[p], p))
    de = bfs(g, exitp)
    far = max(de.values())
    if far < 20:
        return None
    room = [p for p in de if de[p] >= far * 0.8]
    spawn = max(room, key=lambda p: (elbow(g, p), de[p], p))
    # a corner you cannot walk out of is not a spawn
    if elbow(g, spawn) < 11:
        return None
    g[spawn[1]][spawn[0]] = 'P'
    g[exitp[1]][exitp[0]] = 'E'

    taken = {spawn, exitp}
    ring = taken | neigh(spawn) | neigh(exitp)
    lamps = []
    # blockers first (they are the placements that can fail), then lights, then
    # the static bots that owe the spawn a wide berth, then the rest
    rank = {c: (0 if c in BLOCK else 1 if c in 'LN' else 2 if c in 'HY' else 3)
            for c in spec['specials']}
    for ch in sorted(spec['specials'], key=lambda c: (rank[c], c)):
        kw = {}
        if ch in 'HY':
            kw['keepout'] = [(spawn, 340.0)]
        got = put_try(g, ch, spec['specials'][ch], rnd,
                      ring if ch in BLOCK else taken, (4, 3, 2, 1), **kw)
        if got is None:
            return None
        taken |= set(got)
        ring |= set(got)
        if ch in 'LN':
            lamps += got

    # a third of the gold sits in lamplight: a free hint and a trap at once
    lit_n = max(1, round(spec['coins'] / 3))
    lit = put_try(g, 'c', lit_n, rnd, taken, (3, 2, 1), near=lamps, neard=3) if lamps else None
    if lit is None:
        lit = put_try(g, 'c', lit_n, rnd, taken, (3, 2, 1))
        if lit is None:
            return None
    taken |= set(lit)
    dark = put_try(g, 'c', spec['coins'] - lit_n, rnd, taken, (3, 2, 1))
    if dark is None:
        return None
    taken |= set(dark)

    ga, gb = spec['gadgets']
    d1g = put(g, ga, 1, rnd, taken, keepout=[(spawn, 190.0)])
    if d1g is None:
        return None
    taken |= set(d1g)
    d2g = put(g, gb, 1, rnd, taken, keepout=[(spawn, 190.0), (d1g[0], 310.0)])
    if d2g is None:
        return None
    taken |= set(d2g)

    routes = make_routes(g, rects, spawn, exitp, spec['bots'], rnd)
    if routes is None:
        return None

    rows = [''.join(r) for r in g]
    if gate(spec, rows, routes) is not None:
        return None
    d = bfs(g, spawn)
    oc = opens(g)
    corridor = sum(1 for p in oc
                   if sum(1 for dx, dy in NB if (p[0] + dx, p[1] + dy) in oc) <= 2)
    # A camera in a room you never enter is decoration. Reward the candidates
    # that put their watchers on the walk you actually have to make: the cells
    # lying on SOME shortest route from the spawn to the door.
    de2 = bfs(g, exitp)
    span = d[exitp]
    near = set()
    for p in d:
        if de2.get(p, 1e9) + d[p] == span:
            for dx in range(-3, 4):
                for dy in range(-3, 4):
                    near.add((p[0] + dx, p[1] + dy))
    watch = sum(1 for y in range(ROWS) for x in range(COLS)
                if g[y][x] in 'HYC' and (x, y) in near)
    return dict(score=span + 0.3 * corridor + 2.0 * watch, rows=rows, routes=routes,
                walk=span, sight=max([len(r) for r in runs_over(g, 0)] or [0]),
                openn=len(oc), watch=watch)


def build(spec):
    best = None
    for t in range(spec['tries']):
        got = assemble(spec, t + 1)
        if got and (best is None or got['score'] > best['score']):
            best = got
    return best


def main():
    out = []
    for spec in SPECS:
        got = build(spec)
        if got is None:
            print('FAILED to generate ' + spec['name'])
            return 1
        print('%-12s open=%d walk=%d sight=%d watched=%d score=%.1f'
              % (spec['name'], got['openn'], got['walk'], got['sight'],
                 got['watch'], got['score']))
        out.append(dict(name=spec['name'], depth=spec['depth'], theme=spec['theme'],
                        coins=spec['coins'], bots=spec['bots'], spd=spec['spd'],
                        flags=spec['flags'], rows=got['rows'], routes=got['routes']))
    with open(OUT, 'w') as f:
        json.dump(out, f, indent=1)
    print('wrote ' + OUT)
    return 0


if __name__ == '__main__':
    sys.exit(main())
