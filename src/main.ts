import './style.css';
import { parseSvg, writeSvg, type Doc } from './svg.ts';
import { blend, edgeCheck, gapCheck, match, minGap, sheetBox, spread, type Issue, type Level, type Match } from './morph.ts';

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const nl = (v: number) => v.toLocaleString('en-GB', { maximumFractionDigits: 3, useGrouping: false });
const num = (s: string) => { const v = Number(s.trim().replace(',', '.')); return v > 0 ? v : NaN; };
const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

/** Thickness token in a file name: 3mm, 2_5mm, 1_8inch, 1_4inch. */
const TOKEN = /\d+(?:[._,]\d+)?mm|1_8inch|1_4inch/i;
const fromName = (name: string) => {
  const s = name.match(TOKEN)?.[0].toLowerCase();
  return !s ? NaN : s === '1_8inch' ? 3.175 : s === '1_4inch' ? 6.35 : num(s.replace('mm', '').replace('_', '.'));
};
const token = (t: number) => Math.abs(t - 3.175) < 1e-3 ? '1_8inch' : Math.abs(t - 6.35) < 1e-3 ? '1_4inch'
  : `${String(+t.toFixed(3)).replace('.', '_')}mm`;
const outName = (name: string, t: number) => {
  const base = name.replace(/\.svg$/i, '');
  return (TOKEN.test(base) ? base.replace(TOKEN, token(t)) : `${base}_${token(t)}`) + '.svg';
};

interface Side { doc: Doc | null; name: string; t: HTMLInputElement }
const sides = {} as Record<'thin' | 'thick', Side>;
let matched: Match | null = null, lastUrl = '';

for (const key of ['thin', 'thick'] as const) {
  const card = $(`#side-${key}`), drop = $('.drop', card), file = $<HTMLInputElement>('input[type=file]', card);
  const side: Side = sides[key] = { doc: null, name: '', t: $<HTMLInputElement>('input.t', card) };
  const load = async (f: File) => {
    const text = $('.drop-text', drop);
    try {
      side.doc = parseSvg(await f.text());
      side.name = f.name;
      const t = fromName(f.name);
      if (t) side.t.value = nl(t);
      text.textContent = `${f.name} · ${side.doc.els.length} shapes` + (side.doc.skipped ? ` (${side.doc.skipped} empty skipped)` : '');
      drop.classList.add('loaded'); drop.classList.remove('bad');
    } catch (e) {
      side.doc = null;
      text.textContent = `${f.name}: ${(e as Error).message}`;
      drop.classList.add('bad'); drop.classList.remove('loaded');
    }
    matched = null;
    refresh();
  };
  file.onchange = () => { if (file.files?.[0]) load(file.files[0]); file.value = ''; };
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer?.files[0]; if (f) load(f); };
  side.t.oninput = refresh;
}

const tNew = $<HTMLInputElement>('#t-new'), go = $<HTMLButtonElement>('#go'), check = $('#check'), result = $('#result');
for (const b of document.querySelectorAll<HTMLButtonElement>('.chips button')) b.onclick = () => { tNew.value = b.dataset.t!; refresh(); };
tNew.oninput = refresh;
go.onclick = make;

type Note = Pick<Issue, 'level' | 'text'>;
const TAG: Record<Level, string> = { err: 'Error', warn: 'Warning', info: 'Info' };
/** Errors first, then warnings, then info; the same message many times (e.g. 28 identical plates) -> one line with a count. */
const report = (notes: Note[]) => {
  const n = new Map<string, { note: Note; count: number }>();
  for (const note of notes) {
    const k = note.level + note.text;
    n.set(k, { note, count: (n.get(k)?.count ?? 0) + 1 });
  }
  const order = (l: Level) => ['err', 'warn', 'info'].indexOf(l);
  const rows = [...n.values()].sort((a, b) => order(a.note.level) - order(b.note.level)).map(({ note, count }) =>
    `<li class="${note.level}"><span class="tag">${TAG[note.level]}</span><span>${esc(note.text)}${count > 1 ? ` (${count}×)` : ''}</span></li>`);
  return rows.length ? `<ul class="report">${rows.join('')}</ul>` : '';
};

function refresh() {
  result.innerHTML = '';
  const { thin, thick } = sides, t1 = num(thin.t.value), t2 = num(thick.t.value), T = num(tNew.value);
  let ok = false;
  if (!thin.doc || !thick.doc) check.hidden = true;
  else {
    check.hidden = false;
    let html = '<h2>Check</h2>';
    if (!(t1 < t2)) html += report([{ level: 'err', text: 'The thin design must be thinner than the thick design.' }]);
    else {
      matched ??= match(thin.doc, thick.doc);
      if (matched.errors.length) html += report(matched.errors.map(text => ({ level: 'err', text })));
      else {
        ok = true;
        const ec = edgeCheck(matched, t1, t2);
        html += `<p class="good">${matched.pairs.length} shapes paired. ${ec.joints} edges match the material thickness in both files (joints).</p>`;
        html += report([
          ...(ec.joints ? [] : [{ level: 'warn', text: 'No joints found that scale with the thickness. Are the thicknesses filled in correctly?' } as const]),
          ...ec.issues,
        ]);
      }
    }
    check.innerHTML = html;
  }
  go.disabled = !ok || !T;
}

function make() {
  const { thin, thick } = sides, t1 = num(thin.t.value), t2 = num(thick.t.value), T = num(tNew.value);
  if (!matched || !thick.doc) return;
  const { els, move } = spread(blend(matched, (T - t2) / (t2 - t1)), minGap(T));
  const { vb, grown } = sheetBox(els, thick.doc);
  const gaps = gapCheck(els), edges = edgeCheck(matched, t1, t2).issues;
  const notes: Note[] = [];
  if (T < t1 || T > t2) notes.push({ level: 'warn', text: `${nl(T)} mm is outside ${nl(t1)}–${nl(t2)} mm, so the result is extrapolated. Check it extra carefully.` });
  if (els.some(el => el.kind === 'circle' && el.r <= 0)) notes.push({ level: 'err', text: 'Some holes shrink below 0 mm. This thickness is too far outside the two designs.' });
  if (grown) notes.push({ level: 'info', text: `The sheet has grown to ${nl(+vb[2].toFixed(1))} × ${nl(+vb[3].toFixed(1))} mm.` });
  notes.push(...gaps.issues);

  const svg = writeSvg(els, vb);
  const r = Math.max(vb[2], vb[3]) / 80;
  const marks = [...edges.map(i => ({ ...i, at: move(i.at) })), ...gaps.issues]
    .map(i => `<circle class="mark-${i.level}" cx="${i.at[0]}" cy="${i.at[1]}" r="${r}"><title>${esc(i.text)}</title></circle>`).join('');
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  const url = lastUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const name = outName(thick.name, T);
  result.innerHTML =
    (notes.some(n => n.level !== 'info') ? '' : '<p class="good">No overlapping parts.</p>') + report(notes) +
    `<a class="primary download" href="${url}" download="${esc(name)}">Download ${esc(name)}</a>` +
    `<div class="preview">${writeSvg(els, vb, marks)}</div>`;
}
