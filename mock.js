'use strict';
// Monday simulado en memoria (solo para pruebas locales: MONDAY_MOCK=1)
const flat = (v) => { const o = {}; for (const k in v) o[k] = v[k] && typeof v[k] === 'object' && 'text' in v[k] ? v[k].text : v[k]; return o; };
function makeMock() {
  const boards = {}, assets = {};
  let n = 1000;
  const B = (b) => (boards[b] = boards[b] || []);
  return {
    async list(board, cols, withAssets) {
      return B(board).map((r) => { const o = { id: r.id, nombre: r.nombre, ts: r.ts }; cols.forEach((c) => (o[c] = r[c] == null ? '' : String(r[c]))); if (withAssets) o.fotoIds = (r.fotoIds || []).slice(); return o; });
    },
    async create(board, name, values) { const r = { id: String(++n), nombre: name, ts: Date.now(), ...flat(values) }; B(board).push(r); return { id: r.id, ts: r.ts }; },
    async update(board, id, values, name) { const r = B(board).find((x) => x.id === id); if (!r) throw new Error('no item'); if (name != null) r.nombre = name; Object.assign(r, flat(values)); },
    async remove(id) { for (const k in boards) boards[k] = boards[k].filter((x) => x.id !== id); },
    async upload(itemId, col, buf, filename, mime) { const id = String(++n); assets[id] = { buf, mime }; for (const k in boards) { const r = boards[k].find((x) => x.id === itemId); if (r) (r.fotoIds = r.fotoIds || []).push(id); } return id; },
    async asset(id) { return assets[id] || null; },
  };
}
module.exports = { makeMock };
