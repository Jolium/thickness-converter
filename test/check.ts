/**
 * node test/check.ts <thin.svg> <thick.svg> <tThin> <tThick> <T> [reference.svg] [out.svg]
 * Builds thickness T and, when a reference file of thickness T is given, reports how far the
 * result is from it (should be ~0 when the design scales linearly). Exit code 1 on mismatch.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseSvg, writeSvg } from '../src/svg.ts';
import { blend, edgeCheck, gapCheck, group, match, outline, segDist, minGap, sheetBox, spread } from '../src/morph.ts';
import type { El } from '../src/svg.ts';

type Poly = [number, number][];
const far = (P: Poly[], Q: Poly[], pts = P.flat()) => pts.reduce((w, p) => Math.max(w,
  Math.min(...Q.map(q => q.reduce((d, s, i) => Math.min(d, segDist(p, s, q[(i + 1) % q.length])), Infinity)))), 0);

/**
 * Layout- and structure-blind comparison: pair every part with a same-sized reference part, try the 8 axis
 * rotations/mirrors about the part centre, and return the largest outline distance found.
 */
function partDistance(out: El[], ref: El[]): number {
  const parts = (els: El[]) => group(els).map(n => ({ box: n.box, polys: [n.el, ...n.kids].map(outline) as Poly[] }));
  const R = parts(ref), used = new Set<number>();
  let worst = 0;
  for (const o of parts(out)) {
    const [cx, cy] = [(o.box[0] + o.box[2]) / 2, (o.box[1] + o.box[3]) / 2], w = o.box[2] - o.box[0], h = o.box[3] - o.box[1];
    let best: { i: number; polys: Poly[]; d: number } | null = null;
    R.forEach((r, i) => {
      if (used.has(i)) return;
      const rw = r.box[2] - r.box[0], rh = r.box[3] - r.box[1], [rx, ry] = [(r.box[0] + r.box[2]) / 2, (r.box[1] + r.box[3]) / 2];
      for (let t = 0; t < 8; t++) {
        const swap = t & 4;
        if (Math.abs((swap ? h : w) - rw) > 0.5 || Math.abs((swap ? w : h) - rh) > 0.5) continue;
        const f = ([x, y]: [number, number]): [number, number] => {
          let u = x - cx, v = y - cy; if (swap) [u, v] = [v, u];
          return [rx + (t & 1 ? -u : u), ry + (t & 2 ? -v : v)];
        };
        const polys = o.polys.map(q => q.map(f)), all = polys.flat();
        const d = far(polys, r.polys, all.filter((_, k) => k % Math.ceil(all.length / 40) === 0));   // quick pick
        if (!best || d < best.d) best = { i, polys, d };
      }
    });
    if (!best) return Infinity;
    used.add(best.i);
    worst = Math.max(worst, far(best.polys, R[best.i].polys), far(R[best.i].polys, best.polys));
  }
  return worst;
}

const [thinF, thickF, t1s, t2s, Ts, refF, outF] = process.argv.slice(2);
if (!Ts) { console.log('usage: node test/check.ts thin.svg thick.svg tThin tThick T [reference.svg] [out.svg]'); process.exit(2); }
const [t1, t2, T] = [t1s, t2s, Ts].map(Number);
const thin = parseSvg(readFileSync(thinF, 'utf8')), thick = parseSvg(readFileSync(thickF, 'utf8'));
let ms = performance.now();
const m = match(thin, thick);
console.log(`match: ${m.pairs.length} shapes paired in ${(performance.now() - ms).toFixed(0)} ms, errors: ${m.errors.length}`);
m.errors.forEach(e => console.log('  ERROR', e));
const ec = edgeCheck(m, t1, t2);
console.log(`edges = thickness in both files: ${ec.joints}; inconsistent: ${ec.issues.length}`);
const counts = new Map<string, number>(); ec.issues.forEach(i => counts.set(i.text, (counts.get(i.text) ?? 0) + 1));
counts.forEach((n, t) => console.log(`   ${t}${n > 1 ? ` (${n}x)` : ''}`));

const els = spread(blend(m, (T - t2) / (t2 - t1)), minGap(T)).els;
const { vb, grown } = sheetBox(els, thick);
const g = gapCheck(els, minGap(T) - 0.01);
console.log(`result: ${els.length} shapes, sheet ${vb[2].toFixed(1)} x ${vb[3].toFixed(1)} mm${grown ? ' (grown)' : ''}, min part gap ${g.minGap.toFixed(2)} mm, gap issues ${g.issues.length}`);
const svg = writeSvg(els, vb);
if (outF) writeFileSync(outF, svg);

let fail = m.errors.length > 0;
// at the thick file's own thickness the result must be that file
const same = blend(m, 0).every((el, i) => el.pts.every((p, k) => p[0] === m.pairs[i].pb[k][0] && p[1] === m.pairs[i].pb[k][1]));
console.log(`blend at ${t2} mm reproduces the thick file: ${same}`);
if (!same) fail = true;
if (refF) {
  const ref = parseSvg(readFileSync(refF, 'utf8')).els, out = parseSvg(svg).els;
  const dev = partDistance(out, ref);
  console.log(`vs reference: ${out.length}/${ref.length} shapes, max outline distance per part ${dev.toFixed(4)} mm`);
  // 0.1: source files may approximate the same curve differently (e.g. 171 straight segments vs a few cubics)
  if (dev > 0.1 || out.length !== ref.length) fail = true;
}
console.log(fail ? 'FAIL' : 'OK');
process.exit(fail ? 1 : 0);
