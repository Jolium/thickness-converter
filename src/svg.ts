/** SVG <-> flat list of shapes in absolute millimetre coordinates. */
export type Pt = [number, number];
export type Cmd = 'M' | 'L' | 'C' | 'Z';
type Mat = [number, number, number, number, number, number];

export interface El {
  kind: 'path' | 'circle';
  cmds: Cmd[];   // path: one entry per segment; circle: []
  pts: Pt[];     // M/L: 1 point, C: 3 points (2 controls + end), Z: none; circle: [centre]
  r: number;     // circle radius, 0 for paths
  style: string; // stroke/fill/stroke-width, written back unchanged
  key: string;   // colour key used to pair shapes between files
}

export interface Doc { els: El[]; viewBox: [number, number, number, number]; skipped: number }

const I: Mat = [1, 0, 0, 1, 0, 0];
const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const ap = (m: Mat, [x, y]: Pt): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
const nums = (s: string) => (s.match(NUM) ?? []).map(Number);

function parseTransform(s: string | undefined): Mat {
  let m = I;
  for (const [, fn, args] of (s ?? '').matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const a = nums(args), rad = (a[0] ?? 0) * Math.PI / 180;
    let t: Mat;
    switch (fn) {
      case 'matrix': t = a as Mat; break;
      case 'translate': t = [1, 0, 0, 1, a[0], a[1] ?? 0]; break;
      case 'scale': t = [a[0], 0, 0, a[1] ?? a[0], 0, 0]; break;
      case 'rotate': {
        const [cx, cy] = [a[1] ?? 0, a[2] ?? 0], c = Math.cos(rad), s2 = Math.sin(rad);
        t = mul(mul([1, 0, 0, 1, cx, cy], [c, s2, -s2, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]); break;
      }
      case 'skewX': t = [1, 0, Math.tan(rad), 1, 0, 0]; break;
      case 'skewY': t = [1, Math.tan(rad), 0, 1, 0, 0]; break;
      default: throw new Error(`Unknown transform '${fn}'.`);
    }
    m = mul(m, t);
  }
  return m;
}

/** SVG elliptical arc -> cubic segments (SVG spec F.6.5), each [c1, c2, end]. */
function arcToCubics(p0: Pt, rx: number, ry: number, deg: number, large: boolean, sweep: boolean, p1: Pt): Pt[][] {
  if (!rx || !ry || (p0[0] === p1[0] && p0[1] === p1[1])) return [[p0, p1, p1]];
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = deg * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2, dy = (p0[1] - p1[1]) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  const lam = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
  const cx1 = k * rx * y1 / ry, cy1 = -k * ry * x1 / rx;
  const cx = cos * cx1 - sin * cy1 + (p0[0] + p1[0]) / 2, cy = sin * cx1 + cos * cy1 + (p0[1] + p1[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI; else if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9)), h = dt / n, kk = 4 / 3 * Math.tan(h / 4);
  const pt = (t: number): Pt => [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos];
  const der = (t: number): Pt => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos];
  const out: Pt[][] = [];
  for (let i = 0; i < n; i++) {
    const a = t1 + i * h, b = a + h, pa = pt(a), pb = pt(b), da = der(a), db = der(b);
    out.push([[pa[0] + kk * da[0], pa[1] + kk * da[1]], [pb[0] - kk * db[0], pb[1] - kk * db[1]], i === n - 1 ? p1 : pb]);
  }
  return out;
}

const STEP: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 };

/** Path data -> absolute M/L/C/Z in the element's own coordinates. */
function parsePath(d: string): { cmds: Cmd[]; pts: Pt[] } {
  const cmds: Cmd[] = [], pts: Pt[] = [];
  let cur: Pt = [0, 0], start: Pt = [0, 0], lastC: Pt | null = null, lastQ: Pt | null = null;
  for (const [, c, args] of d.matchAll(/([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g)) {
    const C = c.toUpperCase(), rel = c !== C, a = nums(args);
    const P = (x: number, y: number): Pt => (rel ? [cur[0] + x, cur[1] + y] : [x, y]);
    if (C === 'Z') { cmds.push('Z'); cur = start; lastC = lastQ = null; continue; }
    if (!a.length || a.length % STEP[C]) throw new Error(`Invalid path data at '${c}'.`);
    for (let i = 0; i < a.length; i += STEP[C]) {
      const v = a.slice(i, i + STEP[C]);
      let nextC: Pt | null = null, nextQ: Pt | null = null;
      if (C === 'M' || C === 'L') {
        const p = P(v[0], v[1]);
        cmds.push(C === 'M' && i === 0 ? 'M' : 'L'); pts.push(p);
        if (C === 'M' && i === 0) start = p;
        cur = p;
      } else if (C === 'H' || C === 'V') {
        const p: Pt = C === 'H' ? [rel ? cur[0] + v[0] : v[0], cur[1]] : [cur[0], rel ? cur[1] + v[0] : v[0]];
        cmds.push('L'); pts.push(p); cur = p;
      } else if (C === 'C' || C === 'S') {
        const c1: Pt = C === 'C' ? P(v[0], v[1]) : lastC ? [2 * cur[0] - lastC[0], 2 * cur[1] - lastC[1]] : cur;
        const o = C === 'C' ? 2 : 0, c2 = P(v[o], v[o + 1]), p = P(v[o + 2], v[o + 3]);
        cmds.push('C'); pts.push(c1, c2, p); nextC = c2; cur = p;
      } else if (C === 'Q' || C === 'T') {
        const q: Pt = C === 'Q' ? P(v[0], v[1]) : lastQ ? [2 * cur[0] - lastQ[0], 2 * cur[1] - lastQ[1]] : cur;
        const p = C === 'Q' ? P(v[2], v[3]) : P(v[0], v[1]);
        cmds.push('C');
        pts.push([cur[0] + 2 / 3 * (q[0] - cur[0]), cur[1] + 2 / 3 * (q[1] - cur[1])], [p[0] + 2 / 3 * (q[0] - p[0]), p[1] + 2 / 3 * (q[1] - p[1])], p);
        nextQ = q; cur = p;
      } else {
        const p = P(v[5], v[6]);
        for (const seg of arcToCubics(cur, v[0], v[1], v[2], v[3] !== 0, v[4] !== 0, p)) { cmds.push('C'); pts.push(...seg); }
        cur = p;
      }
      lastC = nextC; lastQ = nextQ;
    }
  }
  return { cmds, pts };
}

/** Drop near-zero straight segments and a closing L that only returns to the subpath start. */
function tidy(cmds: Cmd[], pts: Pt[]): { cmds: Cmd[]; pts: Pt[] } {
  const oc: Cmd[] = [], op: Pt[] = [];
  let start: Pt = [0, 0];
  for (let i = 0, k = 0; i < cmds.length; i++) {
    const c = cmds[i];
    if (c === 'M') { start = pts[k]; oc.push(c); op.push(pts[k++]); continue; }
    if (c === 'Z') {
      const last = op[op.length - 1];
      if (oc[oc.length - 1] === 'L' && last && Math.hypot(last[0] - start[0], last[1] - start[1]) < 1e-3) { oc.pop(); op.pop(); }
      oc.push(c); continue;
    }
    if (c === 'L') {
      const p = pts[k++], prev = op[op.length - 1];
      if (prev && Math.hypot(p[0] - prev[0], p[1] - prev[1]) < 0.15) continue;   // LightBurn leaves tiny stubs
      oc.push(c); op.push(p); continue;
    }
    oc.push(c); op.push(pts[k], pts[k + 1], pts[k + 2]); k += 3;
  }
  return { cmds: oc, pts: op };
}

const SKIP = new Set(['defs', 'clipPath', 'mask', 'symbol', 'pattern', 'marker', 'metadata', 'style', 'title', 'desc',
  'linearGradient', 'radialGradient', 'filter', 'script']);
const CONTAINERS = new Set(['svg', 'g', 'a', 'switch']);
const UNSUPPORTED = new Set(['text', 'use', 'image', 'foreignObject']);
const STYLE_PROPS = ['stroke', 'fill', 'stroke-width'];

function lengthMm(v: string | undefined): number | null {
  const m = v?.trim().match(/^([-+]?[\d.]+(?:e[-+]?\d+)?)\s*(mm|cm|in|pt|pc|px)?$/i);
  if (!m) return null;
  const unit = (m[2] ?? 'px').toLowerCase();
  return parseFloat(m[1]) * ({ mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96 } as Record<string, number>)[unit];
}

export function parseSvg(text: string): Doc {
  text = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const stack: { m: Mat; st: Record<string, string> }[] = [];
  const els: El[] = [];
  let viewBox: [number, number, number, number] | null = null, skip = 0, skipped = 0;
  for (const [, close, rawTag, attrText, selfClose] of text.matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g)) {
    const tag = rawTag.replace(/^.*:/, '');
    if (skip) { if (close) skip--; else if (!selfClose) skip++; continue; }
    if (close) { if (CONTAINERS.has(tag)) stack.pop(); continue; }
    if (SKIP.has(tag)) { if (!selfClose) skip = 1; continue; }
    if (UNSUPPORTED.has(tag)) throw new Error(`<${tag}> is not supported. Convert text and images to paths first.`);

    const at: Record<string, string> = {};
    for (const [, k, , v1, v2] of attrText.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) at[k] = v1 ?? v2;
    const top = stack[stack.length - 1];
    const st = { ...top?.st };
    for (const p of STYLE_PROPS) if (at[p] != null) st[p] = at[p];
    for (const decl of (at.style ?? '').split(';')) {
      const i = decl.indexOf(':'), k = decl.slice(0, i).trim();
      if (i > 0 && STYLE_PROPS.includes(k)) st[k] = decl.slice(i + 1).trim();
    }

    if (tag === 'svg' && !top) {
      // root: everything is converted to millimetres here
      const vb = nums(at.viewBox ?? '');
      const wMm = lengthMm(at.width), hMm = lengthMm(at.height);
      let unit = 1;
      if (vb.length === 4) { viewBox = vb as [number, number, number, number]; if (wMm) unit = wMm / vb[2]; }
      else { unit = 25.4 / 96; viewBox = [0, 0, (wMm ?? 0) / unit, (hMm ?? 0) / unit]; }
      viewBox = viewBox.map(v => v * unit) as [number, number, number, number];
      stack.push({ m: [unit, 0, 0, unit, 0, 0], st });
      continue;
    }
    if (!top) continue;
    const m = mul(top.m, parseTransform(at.transform));
    if (CONTAINERS.has(tag)) { if (!selfClose) stack.push({ m, st }); continue; }

    const n = (k: string) => parseFloat(at[k] ?? '0') || 0;
    let d: string | null = null;
    if (tag === 'path') d = at.d ?? '';
    else if (tag === 'rect') {
      const [x, y, w, h] = [n('x'), n('y'), n('width'), n('height')];
      let rx = Math.min(n('rx') || n('ry'), w / 2), ry = Math.min(n('ry') || n('rx'), h / 2);
      if (!w || !h) { skipped++; continue; }
      d = rx > 0 && ry > 0
        ? `M${x + rx},${y}H${x + w - rx}A${rx},${ry} 0 0 1 ${x + w},${y + ry}V${y + h - ry}A${rx},${ry} 0 0 1 ${x + w - rx},${y + h}` +
          `H${x + rx}A${rx},${ry} 0 0 1 ${x},${y + h - ry}V${y + ry}A${rx},${ry} 0 0 1 ${x + rx},${y}Z`
        : `M${x},${y}H${x + w}V${y + h}H${x}Z`;
    } else if (tag === 'circle' || tag === 'ellipse') {
      const [cx, cy] = [n('cx'), n('cy')];
      const rx = tag === 'circle' ? n('r') : n('rx'), ry = tag === 'circle' ? n('r') : n('ry');
      if (!rx || !ry) { skipped++; continue; }
      const sx = Math.hypot(m[0], m[1]), sy = Math.hypot(m[2], m[3]);
      if (rx === ry && Math.abs(sx - sy) < 1e-9 * sx && Math.abs(m[0] * m[2] + m[1] * m[3]) < 1e-9 * sx * sx) {
        els.push({ kind: 'circle', cmds: [], pts: [ap(m, [cx, cy])], r: rx * sx, style: '', key: '' });
      } else d = `M${cx + rx},${cy}A${rx},${ry} 0 1 1 ${cx - rx},${cy}A${rx},${ry} 0 1 1 ${cx + rx},${cy}Z`;
    } else if (tag === 'line') d = `M${n('x1')},${n('y1')}L${n('x2')},${n('y2')}`;
    else if (tag === 'polyline' || tag === 'polygon') d = `M${at.points ?? ''}${tag === 'polygon' ? 'Z' : ''}`;
    else continue;

    if (d !== null) {
      const raw = parsePath(d);
      const t = tidy(raw.cmds, raw.pts.map(p => ap(m, p)));
      if (t.pts.length < 2) { skipped++; continue; }
      els.push({ kind: 'path', cmds: t.cmds, pts: t.pts, r: 0, style: '', key: '' });
    }
    const el = els[els.length - 1];
    el.style = STYLE_PROPS.filter(p => st[p] != null).map(p => `${p}:${st[p]}`).join(';');
    el.key = `${st.stroke ?? ''}|${st.fill ?? ''}`.toLowerCase();
  }
  if (!viewBox) throw new Error('This is not an SVG file.');
  if (!els.length) throw new Error('No shapes found in this file.');
  return { els, viewBox, skipped };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const f = (v: number) => String(Math.round(v * 1e4) / 1e4);

export function pathData(el: El): string {
  let d = '', k = 0;
  for (const c of el.cmds) {
    if (c === 'Z') { d += 'z'; continue; }
    const n = c === 'C' ? 3 : 1;
    d += c + el.pts.slice(k, k + n).map(p => `${f(p[0])},${f(p[1])}`).join(',');
    k += n;
  }
  return d;
}

export function writeSvg(els: El[], vb: [number, number, number, number], extra = ''): string {
  const body = els.map(el => el.kind === 'circle'
    ? `  <circle style="${esc(el.style)}" cx="${f(el.pts[0][0])}" cy="${f(el.pts[0][1])}" r="${f(el.r)}"/>`
    : `  <path style="${esc(el.style)}" d="${pathData(el)}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f(vb[2])}mm" height="${f(vb[3])}mm" viewBox="${vb.map(f).join(' ')}">\n${body}\n${extra}</svg>\n`;
}
