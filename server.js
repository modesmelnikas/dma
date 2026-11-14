'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const { makeMonday } = require('./monday');
const { makeMock } = require('./mock');

const env = process.env;
const PORT = env.PORT || 3000;
const SECRET = env.SESSION_SECRET || (env.MONDAY_MOCK ? 'dev-secret' : null);
if (!SECRET) { console.error('Falta SESSION_SECRET'); process.exit(1); }
const mock = !!env.MONDAY_MOCK;
const B = mock ? { obras: 'obras', personal: 'personal', registros: 'registros', clientes: 'clientes', vacaciones: 'vacaciones', festivos: 'festivos' }
  : { obras: env.BOARD_OBRAS, personal: env.BOARD_PERSONAL, registros: env.BOARD_REGISTROS, clientes: env.BOARD_CLIENTES, vacaciones: env.BOARD_VACACIONES, festivos: env.BOARD_FESTIVOS };
if (!mock && (!env.MONDAY_API_TOKEN || !B.obras || !B.personal || !B.registros || !B.clientes || !B.vacaciones || !B.festivos)) {
  console.error('Faltan MONDAY_API_TOKEN o alguno de BOARD_OBRAS, BOARD_PERSONAL, BOARD_REGISTROS, BOARD_CLIENTES, BOARD_VACACIONES, BOARD_FESTIVOS'); process.exit(1);
}
const mon = mock ? makeMock() : makeMonday(env.MONDAY_API_TOKEN);

const COLS = {
  obras: ['cliente', 'nif', 'direccion', 'ubicacion', 'tipo', 'desplazamiento', 'codigo', 'activa', 'clienteid', 'estado', 'importe', 'importefinal', 'fechaestado'],
  personal: ['usuario', 'rol', 'salt', 'hash', 'mustchange', 'activo', 'vacaciones'],
  vacaciones: ['uid', 'desde', 'hasta', 'estado', 'nota', 'resuelve', 'fechares'],
  festivos: ['fecha', 'tipo'],
  clientes: ['nif', 'direccion', 'contacto', 'telefono', 'email', 'notas'],
  registros: ['obraid', 'obranombre', 'uid', 'nombreop', 'fecha', 'horas', 'entrada', 'salida', 'comida', 'trabajo'],
};
const today = () => new Date().toISOString().slice(0, 10);
const FIRST_CODE = 260100;
const TTL = 15000;

/* ---------- caché ---------- */
const cache = {};
async function load(kind) {
  const c = cache[kind];
  if (c && c.data && Date.now() - c.at < TTL) return c.data;
  if (c && c.p) return c.p;
  const p = mon.list(B[kind], COLS[kind], kind === 'registros').then((d) => { cache[kind] = { data: d, at: Date.now() }; return d; })
    .catch((e) => { cache[kind] = null; throw e; });
  cache[kind] = { p, at: 0 };
  return p;
}
const bust = (k) => { cache[k] = null; };

/* ---------- conversión a la forma que usa la web ---------- */
const bool = (v) => v === '1';
const persOut = (r) => ({ id: r.id, nombre: r.nombre, usuario: r.usuario, rol: r.rol === 'admin' ? 'admin' : 'operario',
  mustChange: bool(r.mustchange), activo: bool(r.activo), vacaciones: Number(r.vacaciones) || 0, ts: r.ts });
const ESTADOS = ['presupuesto_pendiente', 'presupuesto_enviado', 'aceptado', 'factura_pendiente', 'facturado'];
const obraOut = (r, cli, adm) => {
  const o = { id: r.id, nombre: r.nombre, tipo: r.tipo, desplazamiento: Number(r.desplazamiento) || 0, codigo: r.codigo, activa: bool(r.activa), ts: r.ts };
  if (!adm) return o;
  const c = cli || null;
  return Object.assign(o, { cliente: c ? c.nombre : r.cliente, nif: c ? c.nif : r.nif, direccion: c ? c.direccion : r.direccion, ubicacion: r.ubicacion,
    clienteId: c ? c.id : '', estado: ESTADOS.includes(r.estado) ? r.estado : 'presupuesto_pendiente', importe: Number(r.importe) || 0, importeFinal: Number(r.importefinal) || 0, fechaEstado: r.fechaestado });
};
const cliOut = (r) => ({ id: r.id, nombre: r.nombre, nif: r.nif, direccion: r.direccion, contacto: r.contacto, telefono: r.telefono, email: r.email, notas: r.notas, ts: r.ts });
/* ---------- vacaciones ---------- */
// Festivos por defecto: Cataluña + locales de Solsona. Fuentes: Orden EMT/66/2025 (2026), Orden EMT/52/2026 (2027), Orden EMT/208/2025 (locales 2026).
// Los locales de Solsona de 2027 aún no estaban publicados: el administrador los añade en la app.
const FESTIVOS_DEFECTO = [
  ['2026-01-01', 'Año Nuevo'], ['2026-01-06', 'Reyes'], ['2026-04-03', 'Viernes Santo'], ['2026-04-06', 'Lunes de Pascua'],
  ['2026-05-01', 'Fiesta del Trabajo'], ['2026-06-24', 'San Juan'], ['2026-08-15', 'Asunción'], ['2026-09-11', 'Diada de Cataluña'],
  ['2026-10-12', 'Fiesta Nacional de España'], ['2026-12-08', 'Inmaculada Concepción'], ['2026-12-25', 'Navidad'], ['2026-12-26', 'San Esteban'],
  ['2026-09-08', 'Fiesta Mayor de Solsona (local)', 'local'], ['2026-09-09', 'Fiesta Mayor de Solsona (local)', 'local'],
  ['2027-01-01', 'Año Nuevo'], ['2027-01-06', 'Reyes'], ['2027-03-26', 'Viernes Santo'], ['2027-03-29', 'Lunes de Pascua'],
  ['2027-05-01', 'Fiesta del Trabajo'], ['2027-06-24', 'San Juan'], ['2027-08-15', 'Asunción'], ['2027-09-11', 'Diada de Cataluña'],
  ['2027-10-12', 'Fiesta Nacional de España'], ['2027-12-08', 'Inmaculada Concepción'], ['2027-12-25', 'Navidad'], ['2027-12-26', 'San Esteban'],
];
let seeding = null;
async function festivosList() {
  let list = await load('festivos');
  if (!list.length) {
    if (!seeding) seeding = (async () => {
      for (const [fecha, nombre, tipo] of FESTIVOS_DEFECTO) await mon.create(B.festivos, nombre, { fecha, tipo: tipo || 'catalunya' });
      bust('festivos');
    })().finally(() => { seeding = null; });
    await seeding;
    list = await load('festivos');
  }
  return list;
}
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => ISO.test(s || '') && !isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
// días laborables (lunes a viernes, sin festivos) por año natural dentro de [desde, hasta]
function workdays(desde, hasta, fset) {
  const by = {}; let total = 0;
  const end = Date.parse(hasta + 'T00:00:00Z');
  for (let t = Date.parse(desde + 'T00:00:00Z'); t <= end; t += 86400000) {
    const d = new Date(t), dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const iso = d.toISOString().slice(0, 10);
    if (fset.has(iso)) continue;
    const y = iso.slice(0, 4); by[y] = (by[y] || 0) + 1; total++;
  }
  return { total, by };
}
const vacOut = (v, personal, fset) => {
  const w = workdays(v.desde, v.hasta, fset), p = personal.find((x) => x.id === v.uid);
  return { id: v.id, uid: v.uid, nombre: p ? p.nombre : v.nombre, desde: v.desde, hasta: v.hasta, estado: v.estado || 'pendiente', nota: v.nota,
    resuelve: v.resuelve, fechaRes: v.fechares, dias: w.total, porAnio: w.by, ts: v.ts };
};
const regOut = (r) => ({ id: r.id, obraId: r.obraid, obraNombre: r.obranombre, uid: r.uid, nombreOp: r.nombreop, fecha: r.fecha,
  horas: Number(r.horas) || 0, entrada: r.entrada, salida: r.salida, comida: r.comida !== '0', trabajo: r.trabajo, fotoIds: r.fotoIds || [], ts: r.ts });

/* ---------- sesión (cookie firmada) ---------- */
const b64 = (b) => Buffer.from(b).toString('base64url');
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function makeToken(id, secs) { const body = b64(JSON.stringify({ id, exp: Date.now() + secs * 1000 })); return body + '.' + sign(body); }
function readToken(t) {
  if (!t) return null;
  const [body, sig] = t.split('.');
  if (!body || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(sign(body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const o = JSON.parse(Buffer.from(body, 'base64url').toString()); return o.exp > Date.now() ? o : null; } catch (_) { return null; }
}
const cookieOf = (req, n) => { const m = (req.headers.cookie || '').split(/;\s*/).find((x) => x.startsWith(n + '=')); return m ? decodeURIComponent(m.slice(n.length + 1)) : null; };
function setCookie(res, val, maxAge) {
  res.setHeader('Set-Cookie', `dma_s=${encodeURIComponent(val)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}` + (env.NODE_ENV === 'production' ? '; Secure' : ''));
}

/* ---------- app ---------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '40mb' }));
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e.message); res.status(500).json({ error: 'Error del servidor. Inténtalo de nuevo.' }); });

async function bootstrapAdmin() {
  const ps = await load('personal');
  if (ps.length || !env.INITIAL_ADMIN_USER || !env.INITIAL_ADMIN_PASSWORD) return;
  const hash = await bcrypt.hash(env.INITIAL_ADMIN_PASSWORD, 10);
  await mon.create(B.personal, env.INITIAL_ADMIN_NAME || 'Administrador', { usuario: env.INITIAL_ADMIN_USER.toLowerCase(), rol: 'admin', salt: '', hash, mustchange: '1', activo: '1' });
  bust('personal');
  console.log('Administrador inicial creado:', env.INITIAL_ADMIN_USER);
}

async function auth(req, res, next) {
  try {
    const t = readToken(cookieOf(req, 'dma_s'));
    if (!t) return res.status(401).json({ error: 'auth' });
    const p = (await load('personal')).find((x) => x.id === t.id);
    if (!p || p.activo !== '1') return res.status(401).json({ error: 'auth' });
    req.user = { id: p.id, nombre: p.nombre, rol: p.rol === 'admin' ? 'admin' : 'operario', mustChange: bool(p.mustchange), hash: p.hash };
    next();
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'Error del servidor.' }); }
}
const active = (req, res, next) => (req.user.mustChange ? res.status(403).json({ error: 'Debes cambiar la contraseña.' }) : next());
const admin = (req, res, next) => (req.user.rol === 'admin' ? next() : res.status(403).json({ error: 'Solo administradores.' }));

// limitador sencillo de intentos de login
const fails = new Map();
function throttled(key) { const f = fails.get(key); return f && f.n >= 8 && Date.now() - f.at < 10 * 60e3; }
function noteFail(key) { const f = fails.get(key); if (!f || Date.now() - f.at > 10 * 60e3) fails.set(key, { n: 1, at: Date.now() }); else { f.n++; f.at = Date.now(); } }

app.post('/api/login', wrap(async (req, res) => {
  const u = String(req.body.usuario || '').trim().toLowerCase(), pw = String(req.body.password || '');
  const key = req.ip + '|' + u;
  if (throttled(key)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
  await bootstrapAdmin();
  const p = (await load('personal')).find((x) => x.usuario === u && x.activo === '1');
  const ok = p && p.hash && await bcrypt.compare(pw, p.hash);
  if (!ok) { noteFail(key); return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' }); }
  fails.delete(key);
  const secs = req.body.recordar ? 30 * 86400 : 12 * 3600; // «recordarme»: 30 días
  setCookie(res, makeToken(p.id, secs), secs);
  res.json({ ok: true });
}));
app.post('/api/logout', (req, res) => { setCookie(res, '', 0); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ id: req.user.id, nombre: req.user.nombre, rol: req.user.rol, mustChange: req.user.mustChange }));

app.post('/api/password', auth, wrap(async (req, res) => {
  const { actual, nueva } = req.body;
  if (typeof nueva !== 'string' || nueva.length < 6) return res.status(400).json({ error: 'La contraseña tiene que tener al menos 6 caracteres.' });
  if (!req.user.mustChange) {
    if (!actual || !(await bcrypt.compare(String(actual), req.user.hash))) return res.status(400).json({ error: 'La contraseña actual no es correcta.' });
  }
  if (await bcrypt.compare(nueva, req.user.hash)) return res.status(400).json({ error: 'La nueva contraseña tiene que ser distinta de la actual.' });
  await mon.update(B.personal, req.user.id, { hash: await bcrypt.hash(nueva, 10), salt: '', mustchange: '0' });
  bust('personal');
  res.json({ ok: true });
}));

app.get('/api/data', auth, active, wrap(async (req, res) => {
  const adm = req.user.rol === 'admin';
  const [obras, personal, regs, clis, vacs, fest] = await Promise.all([load('obras'), load('personal'), load('registros'), adm ? load('clientes') : [], load('vacaciones'), festivosList()]);
  const fset = new Set(fest.map((f) => f.fecha));
  const reg = (adm ? regs : regs.filter((r) => r.uid === req.user.id)).map(regOut).sort((a, b) => b.ts - a.ts).slice(0, 3000);
  res.json({
    obras: obras.map((o) => obraOut(o, clis.find((c) => c.id === o.clienteid), adm)),
    registros: reg,
    personal: (adm ? personal : personal.filter((p) => p.id === req.user.id)).map(persOut),
    clientes: clis.map(cliOut),
    vacaciones: (adm ? vacs : vacs.filter((v) => v.uid === req.user.id)).map((v) => vacOut(v, personal, fset)).sort((a, b) => b.ts - a.ts),
    festivos: fest.map((f) => ({ id: f.id, fecha: f.fecha, nombre: f.nombre, tipo: f.tipo })).sort((a, b) => a.fecha.localeCompare(b.fecha)),
  });
}));

/* ----- obras ----- */
async function obraVals(b, partial) {
  const t = (v) => String(v == null ? '' : v).trim().slice(0, 200), vals = {};
  const out = { name: null, vals };
  if (!partial || 'nombre' in b) out.name = t(b.nombre);
  for (const k of ['ubicacion', 'tipo']) if (!partial || k in b) vals[k] = t(b[k]);
  if (!partial || 'desplazamiento' in b) vals.desplazamiento = String(Math.max(0, Math.min(24, Number(b.desplazamiento) || 0)));
  for (const [k, col] of [['importe', 'importe'], ['importeFinal', 'importefinal']])
    if (!partial || k in b) vals[col] = String(Math.max(0, Number(String(b[k] == null ? 0 : b[k]).replace(',', '.')) || 0));
  if (!partial || 'clienteId' in b) {
    const c = b.clienteId ? (await load('clientes')).find((x) => x.id === String(b.clienteId)) : null;
    vals.clienteid = c ? c.id : ''; vals.cliente = c ? c.nombre : '';
  }
  if ('estado' in b || !partial) {
    const e = ESTADOS.includes(b.estado) ? b.estado : 'presupuesto_pendiente';
    vals.estado = e; vals.fechaestado = today();
  }
  return out;
}
app.post('/api/obras', auth, active, admin, wrap(async (req, res) => {
  const { name, vals } = await obraVals(req.body, false);
  if (!name) return res.status(400).json({ error: 'Falta el nombre de la obra.' });
  const obras = await load('obras');
  const max = obras.reduce((m, o) => Math.max(m, parseInt(o.codigo, 10) || 0), FIRST_CODE - 1);
  const r = await mon.create(B.obras, name, { ...vals, codigo: String(max + 1), activa: '1' });
  bust('obras'); res.json({ id: r.id });
}));
app.patch('/api/obras/:id', auth, active, admin, wrap(async (req, res) => {
  const b = req.body;
  const { name, vals } = await obraVals(b, true);
  if ('activa' in b) vals.activa = b.activa ? '1' : '0';
  if ('estado' in b && !ESTADOS.includes(b.estado)) return res.status(400).json({ error: 'Estado no válido.' });
  if (name === '') return res.status(400).json({ error: 'Falta el nombre.' });
  await mon.update(B.obras, req.params.id, vals, name);
  bust('obras'); res.json({ ok: true });
}));
app.delete('/api/obras/:id', auth, active, admin, wrap(async (req, res) => {
  for (const r of (await load('registros')).filter((x) => x.obraid === req.params.id)) await mon.remove(r.id);
  await mon.remove(req.params.id);
  bust('obras'); bust('registros'); res.json({ ok: true });
}));

/* ----- registros ----- */
const DATE = /^\d{4}-\d{2}-\d{2}$/, HM = /^\d{2}:\d{2}$/;
app.post('/api/registros', auth, active, wrap(async (req, res) => {
  const b = req.body;
  const obra = (await load('obras')).find((o) => o.id === String(b.obraId));
  if (!obra || obra.activa !== '1') return res.status(400).json({ error: 'La obra no existe o está cerrada.' });
  if (!DATE.test(b.fecha || '') || !HM.test(b.entrada || '') || !HM.test(b.salida || '')) return res.status(400).json({ error: 'Fecha u horas no válidas.' });
  const horas = Number(b.horas);
  if (!(horas > 0 && horas <= 24)) return res.status(400).json({ error: 'Las horas no son válidas.' });
  const fotos = Array.isArray(b.fotos) ? b.fotos.slice(0, 6) : [];
  const r = await mon.create(B.registros, obra.nombre + ' · ' + b.fecha, {
    obraid: obra.id, obranombre: obra.nombre, uid: req.user.id, nombreop: req.user.nombre, fecha: b.fecha, horas: String(horas),
    entrada: b.entrada, salida: b.salida, comida: b.comida === false ? '0' : '1', trabajo: { text: String(b.trabajo || '').slice(0, 5000) },
  });
  let n = 0;
  for (const f of fotos) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(f));
    if (!m) continue;
    try { await mon.upload(r.id, 'fotos', Buffer.from(m[2], 'base64'), `foto${++n}.${m[1].split('/')[1].replace('jpeg', 'jpg')}`, m[1]); } catch (e) { console.error(e.message); }
  }
  bust('registros'); res.json({ id: r.id });
}));
app.delete('/api/registros/:id', auth, active, wrap(async (req, res) => {
  const r = (await load('registros')).find((x) => x.id === req.params.id);
  if (!r) return res.json({ ok: true });
  if (req.user.rol !== 'admin' && r.uid !== req.user.id) return res.status(403).json({ error: 'No permitido.' });
  await mon.remove(r.id); bust('registros'); res.json({ ok: true });
}));
/* ----- vacaciones ----- */
async function usadoAnio(uid, year, vacs, fset, exceptId) {
  let n = 0;
  for (const v of vacs) {
    if (v.uid !== uid || v.id === exceptId || !['pendiente', 'aprobada'].includes(v.estado || 'pendiente')) continue;
    n += workdays(v.desde, v.hasta, fset).by[year] || 0;
  }
  return n;
}
app.post('/api/vacaciones', auth, active, wrap(async (req, res) => {
  const { desde, hasta } = req.body, nota = String(req.body.nota || '').trim().slice(0, 500);
  if (!validDate(desde) || !validDate(hasta)) return res.status(400).json({ error: 'Fechas no válidas.' });
  if (hasta < desde) return res.status(400).json({ error: 'La fecha final no puede ser anterior a la inicial.' });
  if (Date.parse(hasta) - Date.parse(desde) > 366 * 86400000) return res.status(400).json({ error: 'El rango es demasiado largo.' });
  const fset = new Set((await festivosList()).map((f) => f.fecha));
  const w = workdays(desde, hasta, fset);
  if (!w.total) return res.status(400).json({ error: 'En ese rango no hay ningún día laborable.' });
  const vacs = (await load('vacaciones')).filter((v) => v.uid === req.user.id && ['pendiente', 'aprobada'].includes(v.estado || 'pendiente'));
  if (vacs.some((v) => desde <= v.hasta && hasta >= v.desde)) return res.status(400).json({ error: 'Ya tienes una solicitud que coincide con esas fechas.' });
  const me = (await load('personal')).find((p) => p.id === req.user.id);
  const asignados = Number(me && me.vacaciones) || 0;
  for (const y of Object.keys(w.by)) {
    const queda = asignados - await usadoAnio(req.user.id, y, vacs, fset);
    if (w.by[y] > queda) return res.status(400).json({ error: `Te quedan ${Math.max(0, queda)} días en ${y} y pides ${w.by[y]}.` });
  }
  const r = await mon.create(B.vacaciones, req.user.nombre, { uid: req.user.id, desde, hasta, estado: 'pendiente', nota: { text: nota } });
  bust('vacaciones'); res.json({ id: r.id, dias: w.total });
}));
app.patch('/api/vacaciones/:id', auth, active, admin, wrap(async (req, res) => {
  const estado = req.body.estado;
  if (!['pendiente', 'aprobada', 'rechazada'].includes(estado)) return res.status(400).json({ error: 'Estado no válido.' });
  if (!(await load('vacaciones')).some((v) => v.id === req.params.id)) return res.status(404).json({ error: 'No existe la solicitud.' });
  await mon.update(B.vacaciones, req.params.id, { estado, resuelve: estado === 'pendiente' ? '' : req.user.nombre, fechares: estado === 'pendiente' ? '' : today() });
  bust('vacaciones'); res.json({ ok: true });
}));
app.delete('/api/vacaciones/:id', auth, active, wrap(async (req, res) => {
  const v = (await load('vacaciones')).find((x) => x.id === req.params.id);
  if (!v) return res.json({ ok: true });
  const own = v.uid === req.user.id && (v.estado || 'pendiente') === 'pendiente';
  if (req.user.rol !== 'admin' && !own) return res.status(403).json({ error: 'Solo puedes cancelar tus solicitudes pendientes.' });
  await mon.remove(v.id); bust('vacaciones'); res.json({ ok: true });
}));
app.post('/api/festivos', auth, active, admin, wrap(async (req, res) => {
  const fecha = req.body.fecha, nombre = String(req.body.nombre || '').trim().slice(0, 100);
  if (!validDate(fecha)) return res.status(400).json({ error: 'Fecha no válida.' });
  if (!nombre) return res.status(400).json({ error: 'Pon un nombre al festivo.' });
  if ((await festivosList()).some((f) => f.fecha === fecha)) return res.status(400).json({ error: 'Ese día ya está como festivo.' });
  const r = await mon.create(B.festivos, nombre, { fecha, tipo: 'local' });
  bust('festivos'); res.json({ id: r.id });
}));
app.delete('/api/festivos/:id', auth, active, admin, wrap(async (req, res) => {
  await mon.remove(req.params.id); bust('festivos'); res.json({ ok: true });
}));

app.get('/api/fotos/:id', auth, active, wrap(async (req, res) => {
  const id = String(req.params.id);
  const r = (await load('registros')).find((x) => (x.fotoIds || []).includes(id));
  if (!r || (req.user.rol !== 'admin' && r.uid !== req.user.id)) return res.status(404).end();
  const a = await mon.asset(id);
  if (!a) return res.status(404).end();
  res.setHeader('Content-Type', /^image\//.test(a.mime) ? a.mime : 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(a.buf);
}));

/* ----- clientes / CRM (admin) ----- */
function cliVals(b, partial) {
  const t = (v, n = 200) => String(v == null ? '' : v).trim().slice(0, n), vals = {};
  for (const k of ['nif', 'direccion', 'contacto', 'telefono', 'email']) if (!partial || k in b) vals[k] = t(b[k]);
  if (!partial || 'notas' in b) vals.notas = { text: t(b.notas, 3000) };
  return vals;
}
app.post('/api/clientes', auth, active, admin, wrap(async (req, res) => {
  const nombre = String(req.body.nombre || '').trim().slice(0, 150);
  if (!nombre) return res.status(400).json({ error: 'Falta el nombre del cliente.' });
  const r = await mon.create(B.clientes, nombre, cliVals(req.body, false));
  bust('clientes'); res.json({ id: r.id });
}));
app.patch('/api/clientes/:id', auth, active, admin, wrap(async (req, res) => {
  const b = req.body, vals = cliVals(b, true); let name = null;
  if ('nombre' in b) { name = String(b.nombre || '').trim().slice(0, 150); if (!name) return res.status(400).json({ error: 'Falta el nombre.' }); }
  await mon.update(B.clientes, req.params.id, vals, name);
  if (name) for (const o of (await load('obras')).filter((x) => x.clienteid === req.params.id)) await mon.update(B.obras, o.id, { cliente: name });
  bust('clientes'); bust('obras'); res.json({ ok: true });
}));
app.delete('/api/clientes/:id', auth, active, admin, wrap(async (req, res) => {
  for (const o of (await load('obras')).filter((x) => x.clienteid === req.params.id)) await mon.update(B.obras, o.id, { clienteid: '' });
  await mon.remove(req.params.id); bust('clientes'); bust('obras'); res.json({ ok: true });
}));

const diasVac = (v) => Math.max(0, Math.min(366, Math.round((Number(String(v == null ? 0 : v).replace(',', '.')) || 0) * 2) / 2));
/* ----- personal (admin) ----- */
app.post('/api/personal', auth, active, admin, wrap(async (req, res) => {
  const nombre = String(req.body.nombre || '').trim().slice(0, 100), usuario = String(req.body.usuario || '').trim().toLowerCase();
  const rol = req.body.rol === 'admin' ? 'admin' : 'operario', pw = String(req.body.password || '');
  if (!nombre) return res.status(400).json({ error: 'Escribe el nombre completo.' });
  if (!/^[a-z0-9._-]{3,}$/.test(usuario)) return res.status(400).json({ error: 'Usuario no válido.' });
  if (pw.length < 6) return res.status(400).json({ error: 'La contraseña temporal tiene que tener al menos 6 caracteres.' });
  if ((await load('personal')).some((p) => p.usuario === usuario)) return res.status(400).json({ error: 'Ya existe un usuario con ese nombre de usuario.' });
  const r = await mon.create(B.personal, nombre, { usuario, rol, salt: '', hash: await bcrypt.hash(pw, 10), mustchange: '1', activo: '1', vacaciones: String(diasVac(req.body.vacaciones)) });
  bust('personal'); res.json({ id: r.id });
}));
app.patch('/api/personal/:id', auth, active, admin, wrap(async (req, res) => {
  const id = req.params.id, b = req.body, vals = {};
  if (id === req.user.id && ('rol' in b || 'activo' in b)) return res.status(400).json({ error: 'No puedes cambiar tu propio rol ni desactivarte.' });
  if ('rol' in b) vals.rol = b.rol === 'admin' ? 'admin' : 'operario';
  if ('vacaciones' in b) vals.vacaciones = String(diasVac(b.vacaciones));
  if ('activo' in b) vals.activo = b.activo ? '1' : '0';
  if (b.password != null) {
    if (String(b.password).length < 6) return res.status(400).json({ error: 'Contraseña demasiado corta.' });
    vals.hash = await bcrypt.hash(String(b.password), 10); vals.mustchange = '1';
  }
  await mon.update(B.personal, id, vals);
  bust('personal'); res.json({ ok: true });
}));
app.delete('/api/personal/:id', auth, active, admin, wrap(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'No puedes eliminarte a ti mismo.' });
  await mon.remove(req.params.id); bust('personal'); res.json({ ok: true });
}));

app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

if (require.main === module) app.listen(PORT, () => console.log('DMA escuchando en', PORT + (mock ? ' (Monday simulado)' : '')));
module.exports = app;
