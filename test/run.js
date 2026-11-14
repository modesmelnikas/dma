'use strict';
process.env.MONDAY_MOCK = '1';
process.env.INITIAL_ADMIN_USER = 'admin';
process.env.INITIAL_ADMIN_PASSWORD = 'temporal1';
const assert = require('assert');
const app = require('../server');
const srv = app.listen(0);
const base = 'http://127.0.0.1:' + srv.address().port;
function client() {
  let cookie = '';
  return async (m, u, b) => {
    const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { s: r.status, j: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
(async () => {
  const a = client();
  assert.equal((await a('GET', '/api/data')).s, 401);
  assert.equal((await a('POST', '/api/login', { usuario: 'admin', password: 'mala' })).s, 401);
  assert.equal((await a('POST', '/api/login', { usuario: 'admin', password: 'temporal1' })).s, 200);
  let me = (await a('GET', '/api/me')).j; assert.equal(me.mustChange, true);
  assert.equal((await a('GET', '/api/data')).s, 403);                      // bloqueado hasta cambiar contraseña
  assert.equal((await a('POST', '/api/password', { nueva: 'corta' })).s, 400);
  assert.equal((await a('POST', '/api/password', { nueva: 'nueva123' })).s, 200);
  assert.equal((await a('GET', '/api/me')).j.mustChange, false);
  // obras y códigos
  const o1 = (await a('POST', '/api/obras', { nombre: 'Casa Pere', desplazamiento: 1, tipo: 'Porxo' })).j.id;
  const o2 = (await a('POST', '/api/obras', { nombre: 'Coberta Joan' })).j.id;
  let d = (await a('GET', '/api/data')).j;
  assert.deepEqual(d.obras.map((o) => o.codigo).sort(), ['260100', '260101']);
  assert.equal(d.obras.find((o) => o.id === o1).desplazamiento, 1);
  // personal
  assert.equal((await a('POST', '/api/personal', { nombre: 'Marc', usuario: 'marc', rol: 'operario', password: 'temp123' })).s, 200);
  assert.equal((await a('POST', '/api/personal', { nombre: 'Marc2', usuario: 'marc', rol: 'operario', password: 'temp123' })).s, 400);
  assert.equal((await a('PATCH', '/api/personal/' + me.id, { rol: 'operario' })).s, 400);
  const m = client();
  assert.equal((await m('POST', '/api/login', { usuario: 'marc', password: 'temp123' })).s, 200);
  assert.equal((await m('POST', '/api/password', { nueva: 'marc1234' })).s, 200);
  // operario: sin permisos de admin
  assert.equal((await m('POST', '/api/obras', { nombre: 'X' })).s, 403);
  assert.equal((await m('GET', '/api/data')).j.personal.length, 1);
  // registro con foto
  const r1 = await m('POST', '/api/registros', { obraId: o1, fecha: '2026-11-03', horas: 9, entrada: '07:00', salida: '17:00', comida: true, trabajo: 'Tejado', fotos: [PNG] });
  assert.equal(r1.s, 200);
  assert.equal((await a('POST', '/api/registros', { obraId: o2, fecha: '2026-11-03', horas: 4, entrada: '08:00', salida: '12:00', comida: false, trabajo: 'Otra' })).s, 200);
  d = (await m('GET', '/api/data')).j; assert.equal(d.registros.length, 1);   // solo los suyos
  assert.equal(d.registros[0].fotoIds.length, 1); assert.equal(d.registros[0].nombreOp, 'Marc');
  assert.equal((await a('GET', '/api/data')).j.registros.length, 2);
  const f = await m('GET', '/api/fotos/' + d.registros[0].fotoIds[0]); assert.equal(f.s, 200);
  assert.equal((await a('GET', '/api/fotos/' + d.registros[0].fotoIds[0])).s, 200);
  // el otro operario no ve foto ajena
  await a('POST', '/api/personal', { nombre: 'Lluis', usuario: 'lluis', rol: 'operario', password: 'temp123' });
  const l = client(); await l('POST', '/api/login', { usuario: 'lluis', password: 'temp123' }); await l('POST', '/api/password', { nueva: 'lluis123' });
  assert.equal((await l('GET', '/api/fotos/' + d.registros[0].fotoIds[0])).s, 404);
  assert.equal((await l('DELETE', '/api/registros/' + d.registros[0].id)).s, 403);
  // desactivar -> pierde acceso
  const lid = (await a('GET', '/api/data')).j.personal.find((p) => p.usuario === 'lluis').id;
  await a('PATCH', '/api/personal/' + lid, { activo: false });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal((await l('GET', '/api/data')).s, 401);
  // borrar obra en cascada
  await a('DELETE', '/api/obras/' + o1);
  d = (await a('GET', '/api/data')).j; assert.equal(d.registros.length, 1); assert.equal(d.obras.length, 1);
  // cierre de obra: no se puede registrar
  await a('PATCH', '/api/obras/' + o2, { activa: false });
  assert.equal((await a('POST', '/api/registros', { obraId: o2, fecha: '2026-11-03', horas: 4, entrada: '08:00', salida: '12:00', trabajo: 'x' })).s, 400);
  // reset de contraseña
  const mid = (await a('GET', '/api/data')).j.personal.find((p) => p.usuario === 'marc').id;
  await a('PATCH', '/api/personal/' + mid, { password: 'reset123' });
  const m2 = client(); assert.equal((await m2('POST', '/api/login', { usuario: 'marc', password: 'marc1234' })).s, 401);
  await m2('POST', '/api/login', { usuario: 'marc', password: 'reset123' }); assert.equal((await m2('GET', '/api/me')).j.mustChange, true);
  assert.equal((await a('GET', '/')).s, 200);
  console.log('TODO OK'); srv.close();
})().catch((e) => { console.error('FALLO', e); process.exit(1); });
