"""Generate a connected 28x18 Flashpoint floor: rooms, corridors, then contents.
Deterministic per seed so a floor is reproducible."""
import random

COLS, ROWS = 28, 18

def carve(seed, rooms=7):
    rnd = random.Random(seed)
    g = [['#'] * COLS for _ in range(ROWS)]
    rects = []
    for _ in range(220):
        if len(rects) >= rooms: break
        w, h = rnd.randint(4, 8), rnd.randint(3, 5)
        x, y = rnd.randint(1, COLS - w - 1), rnd.randint(1, ROWS - h - 1)
        if any(not (x + w + 1 < rx or rx + rw + 1 < x or y + h + 1 < ry or ry + rh + 1 < y)
               for rx, ry, rw, rh in rects):
            continue
        rects.append((x, y, w, h))
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                g[yy][xx] = '.'
    # connect room centres in sequence with L-shaped corridors
    cs = [(x + w // 2, y + h // 2) for x, y, w, h in rects]
    for i in range(1, len(cs)):
        (x0, y0), (x1, y1) = cs[i - 1], cs[i]
        if rnd.random() < 0.5:
            for x in range(min(x0, x1), max(x0, x1) + 1): g[y0][x] = '.'
            for y in range(min(y0, y1), max(y0, y1) + 1): g[y][x1] = '.'
        else:
            for y in range(min(y0, y1), max(y0, y1) + 1): g[y][x0] = '.'
            for x in range(min(x0, x1), max(x0, x1) + 1): g[y1][x] = '.'
    for x in range(COLS): g[0][x] = '#'; g[ROWS - 1][x] = '#'
    for y in range(ROWS): g[y][0] = '#'; g[y][COLS - 1] = '#'
    return g, rects, cs

def reachable(g, start):
    seen = {start}; q = [start]
    while q:
        x, y = q.pop()
        for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
            n = (x + dx, y + dy)
            if 0 <= n[0] < COLS and 0 <= n[1] < ROWS and g[n[1]][n[0]] != '#' and n not in seen:
                seen.add(n); q.append(n)
    return seen

def build(seed, coins, extras=()):
    """extras: sequence of (char, count)."""
    for attempt in range(400):
        g, rects, cs = carve(seed + attempt * 977)
        floor = [(x, y) for y in range(ROWS) for x in range(COLS) if g[y][x] == '.']
        if len(floor) < 150: continue
        rnd = random.Random(seed + attempt)
        # spawn and exit in opposite corners of the reachable set
        start = min(floor, key=lambda p: p[0] + p[1])
        reach = reachable(g, start)
        if len(reach) < len(floor) * 0.95: continue
        ext = max(reach, key=lambda p: abs(p[0] - start[0]) + abs(p[1] - start[1]))
        g[start[1]][start[0]] = 'P'; g[ext[1]][ext[0]] = 'E'
        free = [p for p in sorted(reach) if g[p[1]][p[0]] == '.']
        rnd.shuffle(free)
        need = coins + sum(n for _, n in extras) + 5
        if len(free) < need + 10: continue
        it = iter(free)
        placed_coins = []
        for _ in range(coins):
            p = next(it); g[p[1]][p[0]] = 'c'; placed_coins.append(p)
        for ch, n in extras:
            for _ in range(n):
                p = next(it); g[p[1]][p[0]] = ch
        for _ in range(5):
            p = next(it); g[p[1]][p[0]] = 'L'
        # patrol routes on open, reachable floor
        opens = [p for p in sorted(reach) if g[p[1]][p[0]] == '.'
                 and all(g[p[1]+dy][p[0]+dx] != '#' for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)))]
        if len(opens) < 12: continue
        return [''.join(r) for r in g], opens, start
    raise RuntimeError('no layout for seed ' + str(seed))

def routes_for(opens, n_bots, rnd):
    """One loop per bot, spread across the floor."""
    out = []
    for b in range(n_bots):
        pts = sorted(opens, key=lambda p: (p[0] * 7 + p[1] * 13 + b * 31) % 97)[:5]
        # order into a rough loop so the bot walks a circuit rather than zig-zags
        cx = sum(p[0] for p in pts) / len(pts); cy = sum(p[1] for p in pts) / len(pts)
        import math
        pts.sort(key=lambda p: math.atan2(p[1] - cy, p[0] - cx))
        out.append([[p[0], p[1]] for p in pts])
    return out
