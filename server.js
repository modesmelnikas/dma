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
const B = mock ? { obras: 'obras', personal: 'personal', registros: 'registros', clientes: 'clientes' }
  : { obras: env.BOARD_OBRAS, personal: env.BOARD_PERSONAL, registros: env.BOARD_REGISTROS, clientes: env.BOARD_CLIENTES };
if (!mock && (!env.MONDAY_API_TOKEN || !B.obras || !B.personal || !B.registros || !B.clientes)) {
  console.error('Faltan MONDAY_API_TOKEN, BOARD_OBRAS, BOARD_PERSONAL, BOARD_REGISTROS o BOARD_CLIENTES'); process.exit(1);
}
const mon = mock ? makeMock() : makeMonday(env.MONDAY_API_TOKEN);

const COLS = {
  obras: ['cliente', 'nif', 'direccion', 'ubicacion', 'tipo', 'desplazamiento', 'codigo', 'activa'],
  personal: ['usuario', 'rol', 'salt', 'hash', 'mustchange', 'activo'],
  clientes: ['proyecto', 'contacto', 'telefono', 'email', 'importe', 'estado', 'obraid', 'fecha', 'notas'],
  registros: ['obraid', 'obranombre', 'uid', 'nombreop', 'fecha', 'horas', 'entrada', 'salida', 'comida', 'trabajo'],
};
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
const obraOut = (r) => ({ id: r.id, nombre: r.nombre, cliente: r.cliente, nif: r.nif, direccion: r.direccion, ubicacion: r.ubicacion,
  tipo: r.tipo, desplazamiento: Number(r.desplazamiento) || 0, codigo: r.codigo, activa: bool(r.activa), ts: r.ts });
const persOut = (r) => ({ id: r.id, nombre: r.nombre, usuario: r.usuario, rol: r.rol === 'admin' ? 'admin' : 'operario',
  mustChange: bool(r.mustchange), activo: bool(r.activo), ts: r.ts });
const ESTADOS = ['presupuesto_pendiente', 'presupuesto_enviado', 'aceptado', 'factura_pendiente', 'facturado'];
const cliOut = (r) => ({ id: r.id, nombre: r.nombre, proyecto: r.proyecto, contacto: r.contacto, telefono: r.telefono, email: r.email,
  importe: Number(r.importe) || 0, estado: ESTADOS.includes(r.estado) ? r.estado : 'presupuesto_pendiente', obraId: r.obraid, fecha: r.fecha, notas: r.notas, ts: r.ts });
const regOut = (r) => ({ id: r.id, obraId: r.obraid, obraNombre: r.obranombre, uid: r.uid, nombreOp: r.nombreop, fecha: r.fecha,
  horas: Number(r.horas) || 0, entrada: r.entrada, salida: r.salida, comida: r.comida !== '0', trabajo: r.trabajo, fotoIds: r.fotoIds || [], ts: r.ts });

/* ---------- sesión (cookie firmada) ---------- */
const b64 = (b) => Buffer.from(b).toString('base64url');
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function makeToken(id) { const body = b64(JSON.stringify({ id, exp: Date.now() + 12 * 3600e3 })); return body + '.' + sign(body); }
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
  setCookie(res, makeToken(p.id), 12 * 3600);
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
  const [obras, personal, regs, clis] = await Promise.all([load('obras'), load('personal'), load('registros'), adm ? load('clientes') : []]);
  const reg = (adm ? regs : regs.filter((r) => r.uid === req.user.id)).map(regOut).sort((a, b) => b.ts - a.ts).slice(0, 3000);
  res.json({
    obras: obras.map(obraOut),
    registros: reg,
    personal: (adm ? personal : personal.filter((p) => p.id === req.user.id)).map(persOut),
    clientes: clis.map(cliOut),
  });
}));

/* ----- obras ----- */
function obraVals(b) {
  const t = (v) => String(v == null ? '' : v).trim().slice(0, 200);
  const d = Math.max(0, Math.min(24, Number(b.desplazamiento) || 0));
  return { name: t(b.nombre), vals: { cliente: t(b.cliente), nif: t(b.nif), direccion: t(b.direccion), ubicacion: t(b.ubicacion), tipo: t(b.tipo), desplazamiento: String(d) } };
}
app.post('/api/obras', auth, active, admin, wrap(async (req, res) => {
  const { name, vals } = obraVals(req.body);
  if (!name) return res.status(400).json({ error: 'Falta el nombre de la obra.' });
  const obras = await load('obras');
  const max = obras.reduce((m, o) => Math.max(m, parseInt(o.codigo, 10) || 0), FIRST_CODE - 1);
  const r = await mon.create(B.obras, name, { ...vals, codigo: String(max + 1), activa: '1' });
  bust('obras'); res.json({ id: r.id });
}));
app.patch('/api/obras/:id', auth, active, admin, wrap(async (req, res) => {
  const b = req.body, vals = {}; let name = null;
  if ('activa' in b) vals.activa = b.activa ? '1' : '0';
  if ('nombre' in b) { const o = obraVals(b); if (!o.name) return res.status(400).json({ error: 'Falta el nombre.' }); name = o.name; Object.assign(vals, o.vals); }
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
const today = () => new Date().toISOString().slice(0, 10);
function cliVals(b, partial) {
  const t = (v, n = 200) => String(v == null ? '' : v).trim().slice(0, n), vals = {};
  for (const k of ['proyecto', 'contacto', 'telefono', 'email']) if (!partial || k in b) vals[k] = t(b[k]);
  if (!partial || 'importe' in b) vals.importe = String(Math.max(0, Number(String(b.importe).replace(',', '.')) || 0));
  if (!partial || 'obraId' in b) vals.obraid = t(b.obraId, 40);
  if (!partial || 'notas' in b) vals.notas = { text: t(b.notas, 3000) };
  return vals;
}
app.post('/api/clientes', auth, active, admin, wrap(async (req, res) => {
  const nombre = String(req.body.nombre || '').trim().slice(0, 150);
  if (!nombre) return res.status(400).json({ error: 'Falta el nombre del cliente.' });
  const estado = ESTADOS.includes(req.body.estado) ? req.body.estado : 'presupuesto_pendiente';
  const r = await mon.create(B.clientes, nombre, { ...cliVals(req.body, false), estado, fecha: today() });
  bust('clientes'); res.json({ id: r.id });
}));
app.patch('/api/clientes/:id', auth, active, admin, wrap(async (req, res) => {
  const b = req.body, vals = cliVals(b, true); let name = null;
  if ('nombre' in b) { name = String(b.nombre || '').trim().slice(0, 150); if (!name) return res.status(400).json({ error: 'Falta el nombre.' }); }
  if ('estado' in b) {
    if (!ESTADOS.includes(b.estado)) return res.status(400).json({ error: 'Estado no válido.' });
    vals.estado = b.estado; vals.fecha = today();
  }
  await mon.update(B.clientes, req.params.id, vals, name);
  bust('clientes'); res.json({ ok: true });
}));
app.delete('/api/clientes/:id', auth, active, admin, wrap(async (req, res) => {
  await mon.remove(req.params.id); bust('clientes'); res.json({ ok: true });
}));

/* ----- personal (admin) ----- */
app.post('/api/personal', auth, active, admin, wrap(async (req, res) => {
  const nombre = String(req.body.nombre || '').trim().slice(0, 100), usuario = String(req.body.usuario || '').trim().toLowerCase();
  const rol = req.body.rol === 'admin' ? 'admin' : 'operario', pw = String(req.body.password || '');
  if (!nombre) return res.status(400).json({ error: 'Escribe el nombre completo.' });
  if (!/^[a-z0-9._-]{3,}$/.test(usuario)) return res.status(400).json({ error: 'Usuario no válido.' });
  if (pw.length < 6) return res.status(400).json({ error: 'La contraseña temporal tiene que tener al menos 6 caracteres.' });
  if ((await load('personal')).some((p) => p.usuario === usuario)) return res.status(400).json({ error: 'Ya existe un usuario con ese nombre de usuario.' });
  const r = await mon.create(B.personal, nombre, { usuario, rol, salt: '', hash: await bcrypt.hash(pw, 10), mustchange: '1', activo: '1' });
  bust('personal'); res.json({ id: r.id });
}));
app.patch('/api/personal/:id', auth, active, admin, wrap(async (req, res) => {
  const id = req.params.id, b = req.body, vals = {};
  if (id === req.user.id && ('rol' in b || 'activo' in b)) return res.status(400).json({ error: 'No puedes cambiar tu propio rol ni desactivarte.' });
  if ('rol' in b) vals.rol = b.rol === 'admin' ? 'admin' : 'operario';
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
