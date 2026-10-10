/**
 * Pair every shape of a thin and a thick version of the same design, then blend:
 *   new = thick + lam * (thick - aligned(thin)),  lam = (T - tThick) / (tThick - tThin)
 * Any joint that fits in both files (a linear relation between points) fits at every T.
 * Layout follows the thick file; each part keeps its centre there.
 */
import type { Cmd, Doc, El, Pt } from './svg.ts';

export type Box = [number, number, number, number];
type Map2 = (p: Pt) => Pt;

export interface Pair { a: El; b: El; pa: Pt[]; pb: Pt[]; cmds: Cmd[]; map: Map2; part: Box }
export interface Match { pairs: Pair[]; worst: { box: Box; key: string; dev: number }[]; errors: string[] }

const dist = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const area = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);
const centroid = (ps: Pt[]): Pt => {
  let x = 0, y = 0;
  for (const p of ps) { x += p[0]; y += p[1]; }
  return [x / ps.length, y / ps.length];
};

export function bbox(el: El): Box {
  const r = el.r;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of el.pts) { x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r); }
  return [x0, y0, x1, y1];
}

export interface Node { el: El; box: Box; kids: El[] }

/** Top-level parts, each with the shapes whose box lies inside it. */
export function group(els: El[]): Node[] {
  const bs = els.map(bbox), tol = 1e-3;
  const parent = els.map((_, i) => {
    let best = -1;
    for (let j = 0; j < els.length; j++) {
      const a = bs[i], b = bs[j];
      if (j !== i && b[0] - tol <= a[0] && b[1] - tol <= a[1] && a[2] <= b[2] + tol && a[3] <= b[3] + tol &&
          area(b) > area(a) && (best < 0 || area(b) < area(bs[best]))) best = j;
    }
    return best;
  });
  const root = (i: number): number => (parent[i] < 0 ? i : root(parent[i]));
  const nodes = new Map<number, Node>();
  els.forEach((el, i) => { if (parent[i] < 0) nodes.set(i, { el, box: bs[i], kids: [] }); });
  els.forEach((el, i) => { if (parent[i] >= 0) nodes.get(root(i))!.kids.push(el); });
  return [...nodes.values()];
}

// the 8 axis-aligned rotations/mirrors a part can have on the sheet
const D8: Map2[] = [];
for (const sx of [1, -1]) for (const sy of [1, -1]) D8.push(([x, y]) => [sx * x, sy * y], ([x, y]) => [sx * y, sy * x]);

/** Mean distance after mapping a onto b; Infinity as soon as it can no longer beat `bound`. */
function meanDist(a: Pt[], b: Pt[], f: Map2, bound: number): number {
  const lim = bound * a.length;
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const q = f(a[i]);
    s += Math.hypot(b[i][0] - q[0], b[i][1] - q[1]);
    if (s > lim) return Infinity;
  }
  return s / a.length;
}

type Scorer = (pa: Pt[], pb: Pt[], bound: number) => { cost: number; map: Map2 } | null;

/** Best rotation/mirror + translation (centroids aligned) mapping a onto b. */
const fitRigid: Scorer = (a, b, bound) => {
  const ca = centroid(a), cb = centroid(b);
  let best: { cost: number; map: Map2 } | null = null;
  for (const D of D8) {
    const q = D(ca), t: Pt = [cb[0] - q[0], cb[1] - q[1]];
    const map: Map2 = p => { const r = D(p); return [r[0] + t[0], r[1] + t[1]]; };
    const cost = meanDist(a, b, map, best ? best.cost : bound);
    if (cost < (best ? best.cost : bound)) best = { cost, map };
  }
  return best;
};

/** The element itself, then (one closed subpath) every other start point, in both directions. */
function* variants(el: El): Generator<El> {
  yield el;
  const { cmds, pts } = el;
  if (el.kind !== 'path' || cmds.filter(c => c === 'M').length !== 1 || cmds[cmds.length - 1] !== 'Z') return;
  const segs: { c: Cmd; p: Pt[] }[] = [];
  for (let i = 1, k = 1; i < cmds.length - 1; i++) {
    const n = cmds[i] === 'C' ? 3 : 1;
    segs.push({ c: cmds[i], p: pts.slice(k, k + n) }); k += n;
  }
  if (!segs.length) return;
  if (dist(segs[segs.length - 1].p[segs[segs.length - 1].p.length - 1], pts[0]) > 1e-9) segs.push({ c: 'L', p: [pts[0]] });
  const n = segs.length, ends = segs.map(s => s.p[s.p.length - 1]);
  const rev = segs.map((s, i) => ({ c: s.c, p: [...s.p.slice(0, -1).reverse(), ends[(i - 1 + n) % n]] })).reverse();
  for (const ring0 of [segs, rev]) {
    for (let r = 0; r < n; r++) {
      if (ring0 === segs && r === 0) continue;
      let ring = [...ring0.slice(r), ...ring0.slice(0, r)];
      const last = ring[ring.length - 1], start = last.p[last.p.length - 1];
      if (last.c === 'L') ring = ring.slice(0, -1);
      yield { ...el, cmds: ['M', ...ring.map(s => s.c), 'Z'], pts: [start, ...ring.flatMap(s => s.p)] };
    }
  }
}

/** How many extra straight segments two versions of a shape may differ by (LightBurn adds/drops tiny ones). */
const slack = (n: number) => Math.max(3, Math.round(n * 0.05));

/**
 * Line up two command lists that differ by a few segments: a straight segment missing on one side gets a
 * zero-length twin, and a straight segment facing a curve becomes the equivalent curve. Banded edit distance.
 */
function pad(a: El, b: El): { pa: Pt[]; pb: Pt[]; cmds: Cmd[] } | null {
  if (a.kind !== b.kind) return null;
  if (a.kind === 'circle') return { pa: a.pts, pb: b.pts, cmds: [] };
  const A = a.cmds, B = b.cmds, n = A.length, m = B.length;
  if (n === m && A.every((c, i) => c === B[i])) return { pa: a.pts, pb: b.pts, cmds: B };
  const w = slack(Math.max(n, m));
  if (Math.abs(n - m) > w) return null;
  // chord length of every segment: equal-cost edit paths are told apart by how well the segment sizes agree
  const chords = (el: El) => {
    const out: number[] = [];
    let k = 0, pen: Pt = [0, 0], start: Pt = [0, 0];
    for (const c of el.cmds) {
      if (c === 'Z') { out.push(dist(pen, start)); pen = start; continue; }
      const end = el.pts[k + (c === 'C' ? 2 : 0)];
      out.push(c === 'M' ? 0 : dist(pen, end));
      k += c === 'C' ? 3 : 1; pen = end; if (c === 'M') start = end;
    }
    return out;
  };
  const la = chords(a), lb = chords(b), G = 0.05;
  const W = 2 * w + 1, idx = (i: number, j: number) => i * W + (j - i + w);
  const D = new Float64Array((n + 1) * W).fill(Infinity), how = new Uint8Array((n + 1) * W);
  D[idx(0, 0)] = 0;
  const step = (i: number, j: number, c: number, h: number) => {
    if (Math.abs(j - i) > w || c >= D[idx(i, j)]) return;
    D[idx(i, j)] = c; how[idx(i, j)] = h;
  };
  for (let i = 0; i <= n; i++) for (let j = Math.max(0, i - w); j <= Math.min(m, i + w); j++) {
    const d = D[idx(i, j)];
    if (d === Infinity) continue;
    if (i < n && j < m) {
      const g = G * Math.abs(la[i] - lb[j]);
      if (A[i] === B[j]) step(i + 1, j + 1, d + g, 1);
      else if ((A[i] === 'L' && B[j] === 'C') || (A[i] === 'C' && B[j] === 'L')) step(i + 1, j + 1, d + 1 + g, 1);
    }
    if (i < n && A[i] === 'L') step(i + 1, j, d + 1 + G * la[i], 2);
    if (j < m && B[j] === 'L') step(i, j + 1, d + 1 + G * lb[j], 3);
  }
  if (D[idx(n, m)] === Infinity) return null;
  const ops: number[] = [];
  let edits = 0;
  for (let i = n, j = m; i || j;) {
    const h = how[idx(i, j)]; ops.push(h);
    if (h !== 1 || A[i - 1] !== B[j - 1]) edits++;
    if (h !== 3) i--; if (h !== 2) j--;
  }
  if (edits > w) return null;
  // replay both paths, emitting matching segments; `pen` follows M/Z so inserted segments sit where they belong
  const side = (el: El) => ({ el, i: 0, k: 0, pen: [0, 0] as Pt, start: [0, 0] as Pt, out: [] as Pt[] });
  const sa = side(a), sb = side(b), cmds: Cmd[] = [];
  const emit = (s: ReturnType<typeof side>, as: Cmd | 'zero') => {
    if (as === 'zero') { s.out.push(s.pen); return; }
    const c = s.el.cmds[s.i++];
    if (c === 'Z') { s.pen = s.start; return; }
    const pts = s.el.pts.slice(s.k, s.k + (c === 'C' ? 3 : 1)); s.k += pts.length;
    const end = pts[pts.length - 1];
    if (as === 'C' && c === 'L') s.out.push([s.pen[0] + (end[0] - s.pen[0]) / 3, s.pen[1] + (end[1] - s.pen[1]) / 3],
                                           [s.pen[0] + 2 * (end[0] - s.pen[0]) / 3, s.pen[1] + 2 * (end[1] - s.pen[1]) / 3], end);
    else s.out.push(...pts);
    if (c === 'M') s.start = end;
    s.pen = end;
  };
  for (const h of ops.reverse()) {
    if (h === 1) { const c: Cmd = A[sa.i] === B[sb.i] ? A[sa.i] : 'C'; emit(sa, c); emit(sb, c); cmds.push(c); }
    else if (h === 2) { emit(sa, 'L'); emit(sb, 'zero'); cmds.push('L'); }
    else { emit(sa, 'zero'); emit(sb, 'L'); cmds.push('L'); }
  }
  return { pa: sa.out, pb: sb.out, cmds };
}

interface Aligned { pa: Pt[]; pb: Pt[]; cmds: Cmd[]; cost: number; map: Map2 }

/** Try every start point/direction of `a`; keep the one the scorer likes best. */
function align(a: El, b: El, score: Scorer): Aligned | null {
  let best: Aligned | null = null;
  // ponytail: huge engraving paths (>3000 points) only try their own start point
  for (const v of a.pts.length > 3000 ? [a] : variants(a)) {
    const p = pad(v, b);
    if (!p || p.pa.length !== p.pb.length) continue;
    const s = score(p.pa, p.pb, best ? best.cost : Infinity);
    if (s && (!best || s.cost < best.cost)) best = { ...p, ...s };
    if (best && best.cost < 1e-6) break;
  }
  return best;
}

/** Pair the inner shapes of two matched parts by position (after mapping thin onto thick). */
function pairKids(ka: El[], kb: El[], map: Map2, key: (el: El) => string): { pairs: [El, El][]; cost: number } | null {
  const free = new Set(ka), pairs: [El, El][] = [];
  let cost = 0;
  for (const b of [...kb].sort((x, y) => area(bbox(y)) - area(bbox(x)))) {
    const cb = centroid(b.pts);
    let best: El | null = null, bd = Infinity;
    for (const a of free) {
      if (key(a) !== b.key || a.kind !== b.kind || Math.abs(a.cmds.length - b.cmds.length) > slack(b.cmds.length)) continue;
      const d = dist(map(centroid(a.pts)), cb);
      if (d < bd) { bd = d; best = a; }
    }
    if (!best) return null;
    free.delete(best); pairs.push([best, b]); cost += bd;
  }
  return { pairs, cost };
}

const maxDev = (al: Aligned) => al.pa.reduce((m, p, i) => Math.max(m, dist(al.map(p), al.pb[i])), 0);

export function describe(key: string, box: Box): string {
  const nl = (v: number) => v.toLocaleString('en-GB', { maximumFractionDigits: 1, useGrouping: false });
  return `part ${key.split('|')[0] || key} of ${nl(box[2] - box[0])} × ${nl(box[3] - box[1])} mm`;
}

/**
 * Thin colour -> thick colour. Same colours: identity. Otherwise (e.g. one layer colour per
 * thickness) colours are paired by how many shapes use them, then by total size.
 */
function colourMap(thin: Doc, thick: Doc): Map<string, string> | string {
  const stats = (d: Doc) => {
    const s = new Map<string, [number, number]>();
    for (const el of d.els) { const v = s.get(el.key) ?? [0, 0]; v[0]++; v[1] += area(bbox(el)); s.set(el.key, v); }
    return [...s].sort((x, y) => x[1][0] - y[1][0] || x[1][1] - y[1][1]);
  };
  const a = stats(thin), b = stats(thick);
  if (a.length === b.length && a.every(([k]) => b.some(([kb]) => kb === k))) return new Map(a.map(([k]) => [k, k]));
  if (a.length !== b.length || a.some(([, v], i) => v[0] !== b[i][1][0]))
    return 'The colours (layers) differ between the two files and cannot be paired automatically. Give both files the same colours.';
  return new Map(a.map(([k], i) => [k, b[i][0]]));
}

export function match(thin: Doc, thick: Doc): Match {
  const A = group(thin.els), B = group(thick.els);
  const used = new Set<Node>(), pairs: Pair[] = [], worst: Match['worst'] = [], errors: string[] = [];
  const cm = colourMap(thin, thick);
  if (typeof cm === 'string') return { pairs, worst, errors: [cm] };
  const ka = (el: El) => cm.get(el.key)!;
  const order = new Map(thick.els.map((el, i) => [el, i]));
  // largest parts first: they are the least ambiguous
  for (const nb of [...B].sort((x, y) => area(y.box) - area(x.box))) {
    let best: { na: Node; al: Aligned; kids: [El, El][]; score: number } | null = null;
    for (const na of A) {
      if (used.has(na) || ka(na.el) !== nb.el.key || na.kids.length !== nb.kids.length) continue;
      const al = align(na.el, nb.el, fitRigid);
      const kids = al && pairKids(na.kids, nb.kids, al.map, ka);
      if (!al || !kids) continue;
      const score = al.cost + kids.cost / Math.max(1, nb.kids.length);
      if (!best || score < best.score) best = { na, al, kids: kids.pairs, score };
    }
    if (!best) { errors.push(`No counterpart in the thin file for ${describe(nb.el.key, nb.box)}.`); continue; }
    used.add(best.na);
    const top = best.al, map = top.map;
    pairs.push({ a: best.na.el, b: nb.el, ...top, part: nb.box });
    let dev = maxDev(top);
    for (const [ka, kb] of best.kids) {
      const al = align(ka, kb, (pa, pb, bound) => {
        const cost = meanDist(pa, pb, map, bound);
        return cost < Infinity ? { cost, map } : null;
      });
      if (!al) { errors.push(`A shape inside ${describe(nb.el.key, nb.box)} is built differently in the two files.`); continue; }
      pairs.push({ a: ka, b: kb, ...al, part: nb.box });
      dev = Math.max(dev, maxDev(al));
    }
    worst.push({ box: nb.box, key: nb.el.key, dev });
  }
  const left = A.filter(n => !used.has(n)).length;
  if (left) errors.push(`${left} part(s) from the thin file have no counterpart in the thick file.`);
  pairs.sort((x, y) => order.get(x.b)! - order.get(y.b)!);
  worst.sort((x, y) => y.dev - x.dev);
  return { pairs, worst, errors };
}

export function blend(m: Match, lam: number): El[] {
  return m.pairs.map(({ a, b, pa, pb, cmds, map }) => ({
    ...b,
    cmds,
    pts: pb.map((p, i): Pt => { const q = map(pa[i]); return [p[0] + lam * (p[0] - q[0]), p[1] + lam * (p[1] - q[1])]; }),
    r: b.r + lam * (b.r - a.r),
  }));
}

/** err: will not work, warn: probably a mistake, info: worth knowing, often fine. */
export type Level = 'err' | 'warn' | 'info';
export interface Issue { level: Level; text: string; at: Pt }

/** Straight edges (and hole diameters) that equal the thickness in one file but not in the other. */
export function edgeCheck(m: Match, t1: number, t2: number): { joints: number; issues: Issue[] } {
  const tol = 0.02, isT = (v: number, t: number) => Math.abs(v - t) <= tol;
  const nl = (v: number) => v.toLocaleString('en-GB', { maximumFractionDigits: 2, useGrouping: false });
  let joints = 0;
  const issues: Issue[] = [];
  const test = (la: number, lb: number, at: Pt, what: string, part: Box, key: string) => {
    if (la < 1e-6 || lb < 1e-6) return;            // padded zero-length segment
    const ta = isT(la, t1), tb = isT(lb, t2);
    if (ta && tb) joints++;
    // an edge with the same length in both files is a fixed feature, not a joint; only flag it when it looks like one
    else if (Math.abs(la - lb) <= tol) { if (isT(la, t1) || isT(la, t2)) issues.push({ level: 'info', at, text: `Fixed ${nl(lb)} mm ${what.toLowerCase()} in ${describe(key, part)}: same in both files and equal to the ${nl(isT(la, t1) ? t1 : t2)} mm material. Fine if it isn't a joint.` }); }
    else if (ta !== tb) issues.push({ level: 'warn', at, text: `${what} of ${nl(la)} mm (thin) and ${nl(lb)} mm (thick) in ${describe(key, part)}: matches the material in only one file. Probably a joint that wasn't resized.` });
  };
  for (const { a, b, pa, pb, cmds, part } of m.pairs) {
    if (b.kind === 'circle') { test(2 * a.r, 2 * b.r, pb[0], 'Hole', part, b.key); continue; }
    let k = 0, sa = pa[0], sb = pb[0];
    for (const c of cmds) {
      if (c === 'M') { sa = pa[k]; sb = pb[k]; k++; continue; }
      if (c === 'C') { k += 3; continue; }
      const [a0, b0] = [pa[k - 1], pb[k - 1]], [a1, b1] = c === 'Z' ? [sa, sb] : [pa[k], pb[k]];
      test(dist(a0, a1), dist(b0, b1), [(b0[0] + b1[0]) / 2, (b0[1] + b1[1]) / 2], 'Edge', part, b.key);
      if (c === 'L') k++;
    }
  }
  return { joints, issues };
}

/** Outline of a shape as a polygon (first subpath, curves sampled). */
export function outline(el: El): Pt[] {
  if (el.kind === 'circle') return Array.from({ length: 48 }, (_, i): Pt =>
    [el.pts[0][0] + el.r * Math.cos(i * Math.PI / 24), el.pts[0][1] + el.r * Math.sin(i * Math.PI / 24)]);
  const out: Pt[] = [];
  let k = 0;
  for (const c of el.cmds) {
    if (c === 'M') { if (out.length) break; out.push(el.pts[k++]); }
    else if (c === 'L') out.push(el.pts[k++]);
    else if (c === 'C') {
      const p0 = out[out.length - 1], [p1, p2, p3] = el.pts.slice(k, k + 3);
      for (let j = 1; j <= 8; j++) {
        const t = j / 8, u = 1 - t;
        out.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
                  u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
      }
      k += 3;
    }
  }
  return out;
}

function inside(poly: Pt[], [x, y]: Pt): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

interface Part { box: Box; poly: Pt[]; els: El[]; engraving: boolean }

/** Parts as laid out on the sheet; an engraving (fill only, no stroke) rides along with the part it sits on. */
function parts(els: El[]): Part[] {
  const out: Part[] = [], loose: Part[] = [];
  for (const n of group(els)) {
    const p = { box: n.box, poly: outline(n.el), els: [n.el, ...n.kids], engraving: n.el.key.startsWith('none|') };
    (p.engraving ? loose : out).push(p);
  }
  for (const e of loose) {
    const [cx, cy] = centre(e.box);
    const host = out.find(p => cx >= p.box[0] && cx <= p.box[2] && cy >= p.box[1] && cy <= p.box[3]);
    if (host) host.els.push(...e.els); else out.push(e);
  }
  return out;
}

const centre = (b: Box): Pt => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

/** Closest distance between two part outlines (0 = overlap); Infinity when their boxes are more than `reach` apart. */
function partGap(A: Part, B: Part, reach: number): { gap: number; at: Pt } {
  if (A.box[0] - reach > B.box[2] || B.box[0] - reach > A.box[2] || A.box[1] - reach > B.box[3] || B.box[1] - reach > A.box[3])
    return { gap: Infinity, at: A.poly[0] };
  if (A.poly.some(p => inside(B.poly, p)) || B.poly.some(p => inside(A.poly, p))) return { gap: 0, at: A.poly[0] };
  let gap = Infinity, at = A.poly[0];
  for (const [P, Q] of [[A.poly, B.poly], [B.poly, A.poly]]) {
    for (const p of P) for (let k = 0; k < Q.length; k++) {
      const d = segDist(p, Q[k], Q[(k + 1) % Q.length]);
      if (d < gap) { gap = d; at = p; }
    }
  }
  return { gap, at };
}

const shifted = (p: Part, [dx, dy]: Pt): Part => ({
  ...p, box: [p.box[0] + dx, p.box[1] + dy, p.box[2] + dx, p.box[3] + dy], poly: p.poly.map(([x, y]): Pt => [x + dx, y + dy]),
});

/** Parts that overlap or sit closer than `min` mm on the sheet. */
export function gapCheck(els: El[], min = 0.3): { minGap: number; issues: Issue[] } {
  const ps = parts(els).filter(p => !p.engraving);
  let minGap = Infinity;
  const issues: Issue[] = [];
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    const { gap, at } = partGap(ps[i], ps[j], min + 1);
    minGap = Math.min(minGap, gap);
    if (gap < min) issues.push({ at, level: gap === 0 ? 'err' : 'warn', text: gap === 0 ? 'Parts overlap' : `Parts only ${gap.toFixed(2)} mm apart` });
  }
  return { minGap, issues };
}

/** Space between parts on the sheet: half the material thickness, at least 2 mm (thick boards char and warp in thin strips). */
export const minGap = (t: number) => Math.max(2, t / 2);

/**
 * Push parts apart until every pair is at least `min` mm apart, by scaling the part centres away from the layout
 * centre (separately in x and y). Parts that are already far enough apart keep their relative layout.
 * `move` maps a point of the input layout (e.g. an issue marker) to where its part ended up.
 */
export function spread(els: El[], min = 2): { els: El[]; move: (p: Pt) => Pt } {
  const ps = parts(els);
  if (!ps.length) return { els, move: p => p };
  const O = centre(ps.reduce<Box>((a, p) => [Math.min(a[0], p.box[0]), Math.min(a[1], p.box[1]), Math.max(a[2], p.box[2]), Math.max(a[3], p.box[3])],
    [Infinity, Infinity, -Infinity, -Infinity]));
  let s: Pt = [1, 1];
  const offset = (p: Part): Pt => { const c = centre(p.box); return [(c[0] - O[0]) * (s[0] - 1), (c[1] - O[1]) * (s[1] - 1)]; };
  // ponytail: whole-layout scaling, O(n^2) pair scan per round; a real nesting step if sheets get crowded
  for (let round = 0; round < 30; round++) {
    const cut = ps.filter(p => !p.engraving).map(p => shifted(p, offset(p)));
    const need: Pt = [1, 1];
    for (let i = 0; i < cut.length; i++) for (let j = i + 1; j < cut.length; j++) {
      const A = cut[i], B = cut[j], { gap } = partGap(A, B, min);
      if (gap >= min - 1e-6) continue;
      // push along the axis that already separates them most
      const sep = [Math.max(B.box[0] - A.box[2], A.box[0] - B.box[2]), Math.max(B.box[1] - A.box[3], A.box[1] - B.box[3])];
      const ax = sep[0] >= sep[1] ? 0 : 1, d = Math.abs(centre(A.box)[ax] - centre(B.box)[ax]);
      if (d < 1e-6) continue;   // centred on each other: scaling cannot separate them, gapCheck reports it
      need[ax] = Math.max(need[ax], (d + min - gap + 0.01) / d);
    }
    if (need[0] === 1 && need[1] === 1) break;
    s = [s[0] * need[0], s[1] * need[1]];
  }
  const by = new Map<El, Pt>();
  for (const p of ps) { const o = offset(p); for (const el of p.els) by.set(el, o); }
  const move = (q: Pt): Pt => {
    const p = ps.find(p => q[0] >= p.box[0] - 1e-6 && q[0] <= p.box[2] + 1e-6 && q[1] >= p.box[1] - 1e-6 && q[1] <= p.box[3] + 1e-6);
    const [dx, dy] = p ? offset(p) : [0, 0];
    return [q[0] + dx, q[1] + dy];
  };
  return { els: els.map(el => { const [dx, dy] = by.get(el) ?? [0, 0]; return { ...el, pts: el.pts.map(([x, y]): Pt => [x + dx, y + dy]) }; }), move };
}

/** The thick file's sheet (its viewBox plus anything already outside it), grown if the result sticks out further. */
export function sheetBox(els: El[], thick: Doc): { vb: [number, number, number, number]; grown: boolean } {
  const ext = (list: El[], [x0, y0, x1, y1]: Box): Box => list.reduce<Box>((a, el) => {
    const b = bbox(el);
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  }, [x0, y0, x1, y1]);
  const v = thick.viewBox, base = ext(thick.els, [v[0], v[1], v[0] + v[2], v[1] + v[3]]), out = ext(els, base);
  return { vb: [out[0], out[1], out[2] - out[0], out[3] - out[1]], grown: out.some((x, i) => Math.abs(x - base[i]) > 0.05) };
}
