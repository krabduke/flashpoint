#!/usr/bin/env python3
"""Independent check of newmaps3.json against all seven floor rules.

Deliberately shares NO code with tools/gen3.py or tools/floorgen.py - it
re-derives the blocking set, the flood fill, the run scan and every count from
the JSON alone. If the generator and this file agree, they agree by being right,
not by calling the same helper.

Prints one line per floor and then either ALL THREE VALID or INVALID: <reason>.
"""
import json
import math
import os
import sys
from collections import deque

PATH = ('/private/tmp/claude-501/-Users-keenancasalegno-florasites-business/'
        '262f7775-823e-44dd-aa7e-e9f46161c14d/scratchpad/newmaps3.json')

W, H = 28, 18
BLOCKING = set('#G$OMD')        # everything that stops a body
RUNBLOCK = set('#G$OM')         # what breaks a straight run, per rule 6
DROPS = set('fsedmhj')
LEGAL = set('#.PEcLNSCGOM!~VHY$DKBRZIx') | DROPS

# the fixed parameters the three floors were commissioned with
WANT = [
    dict(name='THE FURNACE', depth='FURNACE', theme='core', coins=16, bots=4,
         spd=1.46, flags={}),
    dict(name='THE STACKS', depth='STACKS', theme='warehouse', coins=17, bots=4,
         spd=1.47, flags={}),
    dict(name='THE SPIRE', depth='SPIRE', theme='city', coins=18, bots=4,
         spd=1.50, flags={'fog': True, 'siren': True, 'blackout': True}),
]

fails = []


def bad(i, msg):
    fails.append('floor %d (%s): %s' % (i, WANT[i]['name'], msg))


def centre(t):
    """The game reads a tile's centre as (x*40+20, y*40+20)."""
    return (t[0] * 40 + 20, t[1] * 40 + 20)


def px(a, b):
    ca, cb = centre(a), centre(b)
    return math.hypot(ca[0] - cb[0], ca[1] - cb[1])


def tiles(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def check(i, M):
    w = WANT[i]
    for k in ('name', 'depth', 'theme', 'coins', 'bots', 'spd'):
        if M.get(k) != w[k]:
            bad(i, 'field %s is %r, wanted %r' % (k, M.get(k), w[k]))
    if M.get('flags') != w['flags']:
        bad(i, 'flags %r, wanted %r' % (M.get('flags'), w['flags']))

    rows = M.get('rows') or []

    # ---- rule 1: shape, one P, one E, exact coin count -------------------
    if len(rows) != H:
        bad(i, 'rule 1: %d rows, wanted 18' % len(rows))
        return None
    for y, r in enumerate(rows):
        if len(r) != W:
            bad(i, 'rule 1: row %d is %d chars, wanted 28' % (y, len(r)))
            return None
    flat = ''.join(rows)
    stray = sorted(set(flat) - LEGAL)
    if stray:
        bad(i, 'characters outside the alphabet: %r' % stray)
    if flat.count('P') != 1:
        bad(i, "rule 1: %d 'P'" % flat.count('P'))
    if flat.count('E') != 1:
        bad(i, "rule 1: %d 'E'" % flat.count('E'))
    if flat.count('c') != w['coins']:
        bad(i, 'rule 1: %d coins, wanted %d' % (flat.count('c'), w['coins']))
    if flat.count('P') != 1 or flat.count('E') != 1:
        return None

    at = {}
    for y in range(H):
        for x in range(W):
            at.setdefault(rows[y][x], []).append((x, y))
    spawn = at['P'][0]
    exitp = at['E'][0]

    # ---- rule 2: flood fill from P over the FULL blocking set ------------
    seen = set()
    if rows[spawn[1]][spawn[0]] not in BLOCKING:
        seen.add(spawn)
        q = deque([spawn])
        while q:
            x, y = q.popleft()
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < W and 0 <= ny < H and (nx, ny) not in seen \
                        and rows[ny][nx] not in BLOCKING:
                    seen.add((nx, ny))
                    q.append((nx, ny))
    if exitp not in seen:
        bad(i, 'rule 2: exit unreachable')
    for c in at.get('c', []):
        if c not in seen:
            bad(i, 'rule 2: coin at %s unreachable' % (c,))
    drops = [p for ch in DROPS for p in at.get(ch, [])]
    for p in drops:
        if p not in seen:
            bad(i, 'rule 2: gadget drop at %s unreachable' % (p,))

    # ---- rule 3: one route per bot, every waypoint open and reached ------
    routes = M.get('routes') or []
    if len(routes) != w['bots']:
        bad(i, 'rule 3: %d routes, wanted %d' % (len(routes), w['bots']))
    for ri, rt in enumerate(routes):
        if len(rt) < 2:
            bad(i, 'rule 3: route %d has %d waypoints' % (ri, len(rt)))
        for p in rt:
            if not (isinstance(p, list) and len(p) == 2):
                bad(i, 'rule 3: route %d waypoint %r malformed' % (ri, p))
                continue
            x, y = p
            if not (0 <= x < W and 0 <= y < H):
                bad(i, 'rule 3: route %d waypoint %r outside the rows' % (ri, p))
                continue
            if rows[y][x] in BLOCKING:
                bad(i, 'rule 3: route %d waypoint %r on %r' % (ri, p, rows[y][x]))
            elif (x, y) not in seen:
                bad(i, 'rule 3: route %d waypoint %r unreachable' % (ri, p))

    # ---- rule 4: 300px of clear air around the spawn ---------------------
    nearest_static = None
    for ch in 'HY':
        for p in at.get(ch, []):
            d = px(p, spawn)
            if nearest_static is None or d < nearest_static[0]:
                nearest_static = (d, ch, p)
            if d <= 300:
                bad(i, "rule 4: '%s' at %s is %.0fpx from spawn" % (ch, p, d))
    for ri, rt in enumerate(routes):
        if not rt:
            continue
        d = px((rt[0][0], rt[0][1]), spawn)
        if d <= 300:
            bad(i, 'rule 4: route %d starts %.0fpx from spawn' % (ri, d))

    # ---- rule 5: two drops, 6 tiles apart, 3 tiles off the spawn ---------
    if len(drops) != 2:
        bad(i, 'rule 5: %d gadget drops, wanted 2' % len(drops))
    else:
        if tiles(drops[0], drops[1]) < 6:
            bad(i, 'rule 5: drops %.2f tiles apart' % tiles(drops[0], drops[1]))
        for p in drops:
            if tiles(p, spawn) < 3:
                bad(i, 'rule 5: drop %s is %.2f tiles from spawn' % (p, tiles(p, spawn)))

    # ---- rule 6: no unbroken open run longer than 15 ---------------------
    longest = 0
    for y in range(H):
        run = 0
        for x in range(W):
            run = run + 1 if rows[y][x] not in RUNBLOCK else 0
            longest = max(longest, run)
    for x in range(W):
        run = 0
        for y in range(H):
            run = run + 1 if rows[y][x] not in RUNBLOCK else 0
            longest = max(longest, run)
    if longest > 15:
        bad(i, 'rule 6: longest open run is %d' % longest)

    # ---- rule 7: 230-260 open cells --------------------------------------
    openn = sum(1 for y in range(H) for x in range(W) if rows[y][x] not in BLOCKING)
    if not 230 <= openn <= 260:
        bad(i, 'rule 7: %d open cells' % openn)

    return dict(openn=openn, longest=longest, reached=len(seen),
                nearest=nearest_static, drops=drops, spawn=spawn, exitp=exitp)


def main():
    if not os.path.exists(PATH):
        print('INVALID: %s does not exist' % PATH)
        return 1
    with open(PATH) as f:
        maps = json.load(f)
    if not isinstance(maps, list) or len(maps) != 3:
        print('INVALID: expected an array of 3 floors, got %r' % type(maps).__name__)
        return 1
    for i, M in enumerate(maps):
        st = check(i, M)
        if st is None:
            print('%-12s UNCHECKABLE - see reasons below' % maps[i].get('name', '?'))
            continue
        n = st['nearest']
        print('%-12s open=%-3d longest-run=%-2d reached=%-3d coins=%-2d routes=%d '
              'nearest-static=%s' %
              (M['name'], st['openn'], st['longest'], st['reached'],
               ''.join(M['rows']).count('c'), len(M.get('routes') or []),
               ('%.0fpx (%s at %s)' % (n[0], n[1], n[2])) if n else 'none'))
    if fails:
        print('INVALID: ' + fails[0])
        for f in fails[1:]:
            print('         ' + f)
        return 1
    print('ALL THREE VALID')
    return 0


if __name__ == '__main__':
    sys.exit(main())
