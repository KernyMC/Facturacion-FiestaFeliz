// API de comprobantes de pago - Fiesta Feliz
// Recibe fotos de transferencias/Deuna desde la app y las guarda en el almacenamiento S3 del VPS (SeaweedFS).
// Solo el administrador (con ADMIN_TOKEN) puede listar y ver las fotos.
// Las fotos con más de DIAS_RETENCION días (60 por defecto) se borran solas y queda un aviso para los administradores.
'use strict';
const http = require('http');
const crypto = require('crypto');
const Minio = require('minio');

const {
  S3_ENDPOINT = 'fiesta-s3', S3_PORT = '8333', S3_ACCESS_KEY, S3_SECRET_KEY,
  BUCKET = 'comprobantes', APP_TOKEN, ADMIN_TOKEN, PORT = '3000'
} = process.env;

if (!S3_ACCESS_KEY || !S3_SECRET_KEY || !APP_TOKEN || !ADMIN_TOKEN) {
  console.error('Faltan variables de entorno (S3_ACCESS_KEY, S3_SECRET_KEY, APP_TOKEN, ADMIN_TOKEN)');
  process.exit(1);
}

const s3 = new Minio.Client({ endPoint: S3_ENDPOINT, port: +S3_PORT, useSSL: false, accessKey: S3_ACCESS_KEY, secretKey: S3_SECRET_KEY });
const MAX_CUERPO = 6 * 1024 * 1024;           // 6 MB por petición (la app comprime la foto a ~200-400 KB)
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const seguro = s => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
const texto = (s, n = 80) => String(s ?? '').slice(0, n);

function igual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function leerCuerpo(req) {
  return new Promise((ok, mal) => {
    let n = 0; const partes = [];
    req.on('data', c => { n += c.length; if (n > MAX_CUERPO) { mal(new Error('demasiado grande')); req.destroy(); } else partes.push(c); });
    req.on('end', () => ok(Buffer.concat(partes)));
    req.on('error', mal);
  });
}
function streamATexto(st) {
  return new Promise((ok, mal) => { const p = []; st.on('data', c => p.push(c)); st.on('end', () => ok(Buffer.concat(p).toString('utf8'))); st.on('error', mal); });
}
function listar(prefijo) {
  return new Promise((ok, mal) => {
    const out = [];
    const st = s3.listObjectsV2(BUCKET, prefijo, true);
    st.on('data', o => out.push(o)); st.on('end', () => ok(out)); st.on('error', mal);
  });
}
async function asegurarBucket() {
  for (let i = 0; i < 60; i++) {
    try {
      if (!(await s3.bucketExists(BUCKET))) await s3.makeBucket(BUCKET);
      console.log('Bucket listo:', BUCKET); return;
    } catch (e) { console.log('Esperando al almacenamiento S3…', e.message); await new Promise(r => setTimeout(r, 3000)); }
  }
  console.error('No se pudo conectar al almacenamiento S3');
}

/* ===== Borrado automático: las fotos se guardan DIAS_RETENCION días (por defecto 60 = 2 meses) ===== */
const DIAS_RETENCION = Math.max(7, +(process.env.DIAS_RETENCION || 60));
const AVISO_DIAS_ANTES = 7;
const fechaEC = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil' }).format(new Date()); // AAAA-MM-DD
const moverDias = (f, n) => { const d = new Date(f + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fechaDe = nombre => (FECHA.test(nombre.slice(0, 10)) ? nombre.slice(0, 10) : null);
async function guardarAviso(aviso) {
  const b = Buffer.from(JSON.stringify(aviso));
  await s3.putObject(BUCKET, `_avisos/${aviso.creado.slice(0, 10)}-${aviso.id}.json`, b, b.length, { 'Content-Type': 'application/json' });
}
async function guardarJSON(key, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  await s3.putObject(BUCKET, key, b, b.length, { 'Content-Type': 'application/json' });
}
async function leerJSON(key) { return JSON.parse(await streamATexto(await s3.getObject(BUCKET, key))); }
async function leerTodos(prefijo) {
  const out = [];
  for (const o of await listar(prefijo)) { if (o.name.endsWith('.json')) { try { out.push(await leerJSON(o.name)); } catch {} } }
  return out;
}
const claveTexto = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

let limpiando = false;
async function limpiezaAutomatica() {
  if (limpiando) return; limpiando = true;
  try {
    // Lista de compras: lo ya comprado se borra a los 30 días
    try {
      const limite = Date.now() - 30 * 864e5;
      for (const c of await leerTodos('_compras/')) if (c.estado === 'comprado' && new Date(c.actualizado).getTime() < limite) await s3.removeObject(BUCKET, `_compras/${c.id}.json`);
    } catch {}
    const corte = moverDias(fechaEC(), -DIAS_RETENCION); // se borran los días anteriores a esta fecha
    const viejos = (await listar('')).filter(o => { const f = fechaDe(o.name); return f && f < corte; });
    if (!viejos.length) return;
    const fechas = [...new Set(viejos.map(o => fechaDe(o.name)))].sort();
    const fotos = viejos.filter(o => !o.name.endsWith('.json')).length;
    for (let i = 0; i < viejos.length; i += 500) await s3.removeObjects(BUCKET, viejos.slice(i, i + 500).map(o => o.name));
    await guardarAviso({ id: crypto.randomBytes(4).toString('hex'), tipo: 'borrado', creado: new Date().toISOString(), fecha: fechaEC(), fotos, desde: fechas[0], hasta: fechas[fechas.length - 1], diasRetencion: DIAS_RETENCION });
    console.log(`Limpieza automática: ${fotos} foto(s) borradas (${fechas[0]} a ${fechas[fechas.length - 1]})`);
  } catch (e) { console.error('Error en limpieza automática:', e.message); }
  finally { limpiando = false; }
}
/** Avisos para el administrador: borrados ya hechos y fotos que se borrarán en los próximos días */
async function avisos() {
  const hoyF = fechaEC(), corte = moverDias(hoyF, -DIAS_RETENCION), corteProx = moverDias(hoyF, -(DIAS_RETENCION - AVISO_DIAS_ANTES));
  const objs = await listar('');
  const prox = objs.filter(o => { const f = fechaDe(o.name); return f && !o.name.endsWith('.json') && f >= corte && f < corteProx; });
  const fechasProx = [...new Set(prox.map(o => fechaDe(o.name)))].sort();
  const hechos = [];
  for (const o of objs.filter(o => o.name.startsWith('_avisos/')).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 20)) {
    try { hechos.push(JSON.parse(await streamATexto(await s3.getObject(BUCKET, o.name)))); } catch {}
  }
  return {
    diasRetencion: DIAS_RETENCION,
    proximas: prox.length ? { fotos: prox.length, desde: fechasProx[0], hasta: fechasProx[fechasProx.length - 1], seEmpiezanABorrar: moverDias(fechasProx[0], DIAS_RETENCION + 1) } : null,
    borrados: hechos
  };
}

const servidor = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const ruta = url.pathname.replace(/\/+$/, '');
    const esAdmin = igual(req.headers['x-admin-token'], ADMIN_TOKEN);

    if (req.method === 'GET' && ruta === '/api/salud') return json(res, 200, { ok: true });

    // El administrador comprueba su clave desde Ajustes
    if (req.method === 'GET' && ruta === '/api/admin/verificar') return json(res, esAdmin ? 200 : 401, { ok: esAdmin });

    // Avisos de borrado automático (solo administrador)
    if (req.method === 'GET' && ruta === '/api/avisos') {
      if (!esAdmin) return json(res, 401, { error: 'no autorizado' });
      return json(res, 200, await avisos());
    }

    // Lista de compras: todos los teléfonos la ven y agregan; el administrador marca "comprado" o borra
    if (ruta.startsWith('/api/compras')) {
      if (!igual(req.headers['x-app-token'], APP_TOKEN)) return json(res, 401, { error: 'no autorizado' });
      if (req.method === 'GET' && ruta === '/api/compras') {
        const limite = Date.now() - 14 * 864e5;
        const lista = (await leerTodos('_compras/')).filter(c => c.estado === 'pendiente' || new Date(c.actualizado).getTime() > limite);
        lista.sort((a, b) => (b.estado === 'pendiente') - (a.estado === 'pendiente') || (b.urgente === true) - (a.urgente === true) || String(a.creado).localeCompare(String(b.creado)));
        return json(res, 200, lista);
      }
      if (req.method === 'POST' && ruta === '/api/compras') {
        const d = JSON.parse((await leerCuerpo(req)).toString('utf8'));
        const nombre = texto(d.nombre, 80).trim(), quien = texto(d.pedidoPor, 60) || 'Sin nombre';
        if (!nombre) return json(res, 400, { error: 'falta el producto' });
        const ahora = new Date().toISOString(), k = claveTexto(nombre);
        let item = (await leerTodos('_compras/')).find(c => c.estado === 'pendiente' && c.clave === k);
        if (item) { // ya estaba pedido: se suma quién lo pide y se actualizan los datos
          if (!item.pedidoPor.includes(quien)) item.pedidoPor.push(quien);
          if (d.urgente) item.urgente = true;
          if (d.cantidad) item.cantidad = texto(d.cantidad, 40);
          if (d.nota) item.nota = texto(d.nota, 140);
          item.actualizado = ahora;
        } else {
          item = { id: crypto.randomBytes(6).toString('hex'), clave: k, nombre, cantidad: texto(d.cantidad, 40), nota: texto(d.nota, 140),
            urgente: !!d.urgente, categoria: texto(d.categoria, 30), pedidoPor: [quien], creado: ahora, actualizado: ahora, estado: 'pendiente' };
        }
        await guardarJSON(`_compras/${item.id}.json`, item);
        return json(res, 200, item);
      }
      if (req.method === 'POST' && ruta === '/api/compras/estado') {
        const d = JSON.parse((await leerCuerpo(req)).toString('utf8'));
        const id = seguro(d.id), key = `_compras/${id}.json`;
        let item; try { item = await leerJSON(key); } catch { return json(res, 404, { error: 'no existe' }); }
        const accion = String(d.accion || ''), por = texto(d.por, 60);
        if (accion === 'comprado' || accion === 'borrar') { if (!esAdmin) return json(res, 401, { error: 'solo el administrador' }); }
        else if (accion === 'cancelar') { if (!esAdmin && !(item.estado === 'pendiente' && item.pedidoPor.length === 1 && item.pedidoPor[0] === por)) return json(res, 403, { error: 'no permitido' }); }
        else return json(res, 400, { error: 'acción inválida' });
        if (accion === 'comprado') { Object.assign(item, { estado: 'comprado', compradoPor: por, actualizado: new Date().toISOString() }); await guardarJSON(key, item); }
        else await s3.removeObject(BUCKET, key);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'no encontrado' });
    }

    // Cada teléfono avisa qué versión de la app tiene (para que el administrador sepa si está actualizado)
    if (req.method === 'POST' && ruta === '/api/dispositivos') {
      if (!igual(req.headers['x-app-token'], APP_TOKEN)) return json(res, 401, { error: 'no autorizado' });
      const d = JSON.parse((await leerCuerpo(req)).toString('utf8'));
      const dev = String(d.dev || '');
      if (!/^[A-Z0-9]{3,12}$/.test(dev)) return json(res, 400, { error: 'dispositivo inválido' });
      const info = { dev, version: texto(d.version, 12), usuario: texto(d.usuario, 60), rol: texto(d.rol, 20),
        navegador: texto(req.headers['user-agent'], 160), instalada: !!d.instalada, visto: new Date().toISOString() };
      const b = Buffer.from(JSON.stringify(info));
      await s3.putObject(BUCKET, `_dispositivos/${dev}.json`, b, b.length, { 'Content-Type': 'application/json' });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && ruta === '/api/dispositivos') {
      if (!esAdmin) return json(res, 401, { error: 'no autorizado' });
      const lista = [];
      for (const o of await listar('_dispositivos/')) { try { lista.push(JSON.parse(await streamATexto(await s3.getObject(BUCKET, o.name)))); } catch {} }
      lista.sort((a, b) => String(b.visto).localeCompare(String(a.visto)));
      return json(res, 200, lista);
    }

    // Subir comprobante (desde cualquier teléfono de la app)
    if (req.method === 'POST' && ruta === '/api/comprobantes') {
      if (!igual(req.headers['x-app-token'], APP_TOKEN)) return json(res, 401, { error: 'no autorizado' });
      const d = JSON.parse((await leerCuerpo(req)).toString('utf8'));
      const uid = seguro(d.ventaUid), fecha = String(d.fecha || '');
      if (!uid || !FECHA.test(fecha)) return json(res, 400, { error: 'datos inválidos' });
      const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String(d.imagen || ''));
      if (!m) return json(res, 400, { error: 'imagen inválida' });
      const img = Buffer.from(m[2], 'base64');
      if (img.length < 100) return json(res, 400, { error: 'imagen vacía' });
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      const base = `${fecha}/${uid}`;
      await s3.putObject(BUCKET, `${base}.${ext}`, img, img.length, { 'Content-Type': `image/${m[1]}` });
      const meta = {
        ventaUid: uid, fecha, foto: `${base}.${ext}`, hora: texto(d.hora, 8), vendedora: texto(d.vendedora), cliente: texto(d.cliente),
        pago: texto(d.pago, 20), banco: texto(d.banco), total: Number(d.total) || 0, subido: new Date().toISOString()
      };
      const mj = Buffer.from(JSON.stringify(meta));
      await s3.putObject(BUCKET, `${base}.json`, mj, mj.length, { 'Content-Type': 'application/json' });
      return json(res, 200, { ok: true, foto: meta.foto });
    }

    // Listar comprobantes de un día (solo administrador)
    if (req.method === 'GET' && ruta === '/api/comprobantes') {
      if (!esAdmin) return json(res, 401, { error: 'no autorizado' });
      const fecha = url.searchParams.get('fecha') || '';
      if (!FECHA.test(fecha)) return json(res, 400, { error: 'fecha inválida' });
      const objs = (await listar(`${fecha}/`)).filter(o => o.name.endsWith('.json'));
      const lista = [];
      for (const o of objs) { try { lista.push(JSON.parse(await streamATexto(await s3.getObject(BUCKET, o.name)))); } catch {} }
      lista.sort((a, b) => String(a.hora).localeCompare(String(b.hora)));
      return json(res, 200, lista);
    }

    // Ver una foto (solo administrador)
    if (req.method === 'GET' && ruta === '/api/comprobantes/foto') {
      if (!esAdmin) return json(res, 401, { error: 'no autorizado' });
      const key = url.searchParams.get('key') || '';
      if (!/^\d{4}-\d{2}-\d{2}\/[A-Za-z0-9_-]+\.(jpg|png|webp)$/.test(key)) return json(res, 400, { error: 'clave inválida' });
      try {
        const st = await s3.getObject(BUCKET, key);
        res.writeHead(200, { 'Content-Type': key.endsWith('.png') ? 'image/png' : key.endsWith('.webp') ? 'image/webp' : 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
        return st.pipe(res);
      } catch { return json(res, 404, { error: 'no existe' }); }
    }

    json(res, 404, { error: 'no encontrado' });
  } catch (e) {
    console.error(e);
    json(res, e.message === 'demasiado grande' ? 413 : 500, { error: 'error del servidor' });
  }
});

servidor.listen(+PORT, async () => {
  console.log('API de comprobantes en puerto', PORT, '| fotos se guardan', DIAS_RETENCION, 'días');
  await asegurarBucket();
  limpiezaAutomatica();
  setInterval(limpiezaAutomatica, 6 * 60 * 60 * 1000); // revisa cada 6 horas
});
