"""Rewrite map rows by INDEX. Maps contain identical rows, so replacing by
content silently edits the wrong line - which is how mirrors ended up in
dead-ends instead of the corners they were chosen for."""
import re

ROW_RE = re.compile(r"'([^']{28})'")

def load(path):
    src = open(path, encoding='utf-8').read()
    blocks = list(re.finditer(r"(\{ name: '([^']+)'.*?rows: \[)(.*?)(\n  \], routes)", src, re.S))
    return src, blocks

def rows_of(block):
    return ROW_RE.findall(block.group(3))

def write(path, src, edits):
    """edits: {block_index: [28-char rows]} - rebuilt positionally."""
    src2, blocks = src, None
    _, blocks = load_from(src)
    out = []
    last = 0
    for i, b in enumerate(blocks):
        if i not in edits:
            continue
        rows = edits[i]
        for r in rows:
            assert len(r) == 28, (i, len(r), r)
        body = b.group(3)
        pieces, pos, n = [], 0, 0
        for m in ROW_RE.finditer(body):
            pieces.append(body[pos:m.start(1)])
            pieces.append(rows[n]); n += 1
            pos = m.end(1)
        pieces.append(body[pos:])
        newbody = ''.join(pieces)
        assert n == len(rows), (n, len(rows))
        out.append((b.start(3), b.end(3), newbody))
    res, cur = [], 0
    for st, en, nb in sorted(out):
        res.append(src[cur:st]); res.append(nb); cur = en
    res.append(src[cur:])
    open(path, 'w', encoding='utf-8').write(''.join(res))

def load_from(src):
    blocks = list(re.finditer(r"(\{ name: '([^']+)'.*?rows: \[)(.*?)(\n  \], routes)", src, re.S))
    return src, blocks
