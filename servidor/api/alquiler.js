// Alquiler de disfraces inflables - Fiesta Feliz
// Inventario de disfraces, reservas, contrato firmado (se guarda en el servidor) y envío por correo con Resend.
'use strict';
const crypto = require('crypto');

const PRECIO_DIA = 25;        // $ por día por disfraz
const GARANTIA = 30;          // $ de garantía por disfraz
const DESC_VENTILADOR = 10;   // $ que se descuentan si falta o se daña el ventilador
const DISFRACES_INICIALES = ['Dinosaurio naranja #1', 'Dinosaurio naranja #2', 'Dinosaurio verde', 'Dinosaurio gris',
  'Capibara #1', 'Capibara #2', 'Ajolote', 'Sapo', 'Stitch', 'Dinosaurio Venom', 'Unicornio',
  'Tiburón azul', 'Tiburón gris', 'Tiburón rosado'];
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

module.exports = function crearAlquiler({ s3, BUCKET, json, leerCuerpo, guardarJSON, leerJSON, leerTodos, listar, igual, APP_TOKEN, fechaEC, moverDias }) {
  const { RESEND_API_KEY, CORREO_DESDE = 'La Fiesta Feliz <info@lafiestafeliz.com>' } = process.env;
  const id = () => crypto.randomBytes(5).toString('hex');
  const t = (s, n = 80) => String(s ?? '').slice(0, n).trim();
  const e = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dinero = n => '$' + (Number(n) || 0).toFixed(2).replace('.', ',');
  const fechaLarga = f => new Date(f + 'T12:00:00Z').toLocaleDateString('es-EC', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  let correosHoy = { dia: '', n: 0 };

  const conGuantes = n => /dinosaurio/i.test(n) && !/verde/i.test(n);
  const esMontado = n => /dinosaurio verde/i.test(n);
  async function sembrarDisfraces() {
    // completar datos de guantes / montado en los disfraces ya guardados
    for (const d of await leerTodos('_disfraces/')) {
      if (d.guantes === undefined) { d.guantes = conGuantes(d.nombre); d.montado = esMontado(d.nombre); await guardarJSON(`_disfraces/${d.id}.json`, d); }
    }
    if ((await listar('_disfraces/')).length) return;
    for (const nombre of DISFRACES_INICIALES) {
      const d = { id: id(), nombre, ventilador: true, guantes: conGuantes(nombre), montado: esMontado(nombre), estado: 'disponible', nota: '', creado: new Date().toISOString() };
      await guardarJSON(`_disfraces/${d.id}.json`, d);
    }
    console.log('Disfraces iniciales cargados:', DISFRACES_INICIALES.length);
  }

  /** Un alquiler ocupa sus disfraces desde el día de retiro hasta la devolución (o hasta hoy si está atrasado). */
  function choques(a, otros) {
    const ids = new Set(a.disfraces.map(d => d.id)), hoy = fechaEC();
    return otros.filter(o => o.id !== a.id && (o.estado === 'reservado' || o.estado === 'entregado') && o.disfraces.some(d => ids.has(d.id)))
      .filter(o => { const fin = o.estado === 'entregado' && o.devolverHasta < hoy ? hoy : o.devolverHasta; return !(fin < a.retiroDesde || o.retiroDesde > a.devolverHasta); });
  }

  function contratoHTML(a, firma) {
    const c = a.cliente || {}, n = a.disfraces.length;
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Contrato ${e(a.id)}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;padding:18px;color:#111;line-height:1.5;font-size:15px}h1{font-size:17px;text-align:center;margin:0 0 12px}ol{padding-left:20px}li{margin-bottom:8px}.datos p{margin:4px 0}.firma{margin-top:22px;border-top:1px solid #999;padding-top:8px}.firma img{max-width:300px;height:auto;display:block}</style></head><body>
<h1>CONTRATO DE ALQUILER DE DISFRAZ INFLABLE<br>LA FIESTA FELIZ</h1>
<div class="datos">
<p><b>N.º de contrato:</b> ${e(a.id)}</p>
<p><b>Cliente:</b> ${e(c.nombre)} &nbsp; <b>C.I.:</b> ${e(c.cedula || '-')}</p>
<p><b>Teléfono:</b> ${e(c.telefono || '-')} &nbsp; <b>Correo:</b> ${e(c.correo || '-')}</p>
<p><b>Disfraz(es):</b> ${a.disfraces.map(d => e(d.nombre)).join(', ')} (${n})</p>
<p><b>Fecha del evento:</b> ${e(fechaLarga(a.fechaEvento))}</p>
</div>
<ol>
<li><b>Precio:</b> ${dinero(a.precioDia)} por día de uso por disfraz. Total del alquiler: <b>${dinero(a.totalAlquiler)}</b>.</li>
<li><b>Garantía:</b> el cliente deja ${dinero(a.garantiaPorTraje)} por cada disfraz (total <b>${dinero(a.garantiaTotal)}</b>), que se devuelve al entregar el disfraz completo, en buen estado y a tiempo.</li>
<li><b>Retiro y devolución:</b> puede retirar el disfraz desde el <b>${e(fechaLarga(a.retiroDesde))}</b> y debe devolverlo hasta el <b>${e(fechaLarga(a.devolverHasta))}</b>, en el horario de atención del local.</li>
<li><b>Atraso:</b> si la devolución se retrasa, el local podrá cobrar la garantía.</li>
<li><b>Ventilador:</b> si el disfraz se devuelve sin el ventilador o con el ventilador dañado, se descontarán ${dinero(DESC_VENTILADOR)} de la garantía por cada disfraz.</li>
<li><b>Traje completo:</b> el disfraz se debe devolver completo, con sus accesorios (por ejemplo, los guantes de los disfraces de dinosaurio que los traen) y con su ventilador.</li>
<li><b>Rayones o roturas:</b> si el disfraz se devuelve rayado o roto, se cobra la garantía completa de ese disfraz, salvo que el cliente lo repare por su cuenta y lo devuelva reparado.</li>
<li>El cliente declara haber recibido el(los) disfraz(es) en buen estado y acepta estas condiciones.</li>
</ol>
${firma ? `<div class="firma"><img src="${firma}" alt="Firma del cliente">Firma del cliente: <b>${e(c.nombre)}</b> · ${e(a.entrega?.fecha || fechaEC())} ${e(a.entrega?.hora || '')}</div>`
        : '<p class="firma">Firma del cliente: ______________________________</p>'}
</body></html>`;
  }

  async function enviarCorreo(a, html, firmaB64) {
    if (!RESEND_API_KEY) return 'sin-configurar';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.cliente?.correo || '')) return 'sin-correo';
    const hoy = fechaEC(); if (correosHoy.dia !== hoy) correosHoy = { dia: hoy, n: 0 };
    if (correosHoy.n >= 100) return 'limite';
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: CORREO_DESDE, to: [a.cliente.correo], subject: `Tu contrato de alquiler - La Fiesta Feliz (N.º ${a.id})`,
          html: `<p>Hola ${e(a.cliente.nombre)}, gracias por alquilar con La Fiesta Feliz. Este es tu contrato firmado (la firma va adjunta).</p>` + html.replace(/<img [^>]*>/, ''),
          attachments: firmaB64 ? [{ filename: 'firma.png', content: firmaB64 }] : [] })
      });
      if (!r.ok) { console.error('Resend:', r.status, await r.text()); return 'error'; }
      correosHoy.n++; return 'enviado';
    } catch (err) { console.error('Resend:', err.message); return 'error'; }
  }

  /** Atiende las rutas de alquiler. Devuelve true si la ruta era suya. */
  return {
    sembrarDisfraces,
    async rutas(req, res, ruta, url, esAdmin) {
      if (!ruta.startsWith('/api/disfraces') && !ruta.startsWith('/api/alquileres')) return false;
      if (req.method === 'GET' && ruta === '/api/disfraces/foto') {
        const did = t(url.searchParams.get('id'), 20).replace(/[^a-f0-9]/g, '');
        try { const st = await s3.getObject(BUCKET, `_disfraces/fotos/${did}.jpg`); res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' }); st.pipe(res); }
        catch { json(res, 404, { error: 'sin foto' }); }
        return true;
      }
      if (!igual(req.headers['x-app-token'], APP_TOKEN)) { json(res, 401, { error: 'no autorizado' }); return true; }
      const cuerpo = async () => JSON.parse((await leerCuerpo(req)).toString('utf8') || '{}');

      // ----- Inventario de disfraces -----
      if (req.method === 'GET' && ruta === '/api/disfraces') {
        const l = await leerTodos('_disfraces/'); l.sort((a, b) => a.nombre.localeCompare(b.nombre)); json(res, 200, l); return true;
      }
      if (req.method === 'POST' && ruta === '/api/disfraces') {
        if (!esAdmin) { json(res, 401, { error: 'solo el administrador' }); return true; }
        const d = await cuerpo(), nombre = t(d.nombre, 60);
        if (!nombre) { json(res, 400, { error: 'falta el nombre' }); return true; }
        let x = {}; if (d.id) { try { x = await leerJSON(`_disfraces/${t(d.id, 20)}.json`); } catch {} }
        x = { ...x, id: x.id || id(), nombre, ventilador: d.ventilador !== false, guantes: !!d.guantes, montado: !!d.montado, estado: ['disponible', 'reparacion'].includes(d.estado) ? d.estado : 'disponible', nota: t(d.nota, 140), creado: x.creado || new Date().toISOString() };
        await guardarJSON(`_disfraces/${x.id}.json`, x); json(res, 200, x); return true;
      }
      if (req.method === 'POST' && ruta === '/api/disfraces/foto') {
        if (!esAdmin) { json(res, 401, { error: 'solo el administrador' }); return true; }
        const d = await cuerpo(), did = t(d.id, 20).replace(/[^a-f0-9]/g, '');
        const m = /^data:image\/(jpeg|png);base64,(.+)$/.exec(String(d.imagen || ''));
        if (!did || !m) { json(res, 400, { error: 'foto inválida' }); return true; }
        let x; try { x = await leerJSON(`_disfraces/${did}.json`); } catch { json(res, 404, { error: 'no existe' }); return true; }
        const img = Buffer.from(m[2], 'base64');
        await s3.putObject(BUCKET, `_disfraces/fotos/${did}.jpg`, img, img.length, { 'Content-Type': 'image/jpeg' });
        x.foto = Date.now(); await guardarJSON(`_disfraces/${did}.json`, x); json(res, 200, x); return true;
      }
      if (req.method === 'POST' && ruta === '/api/disfraces/borrar') {
        if (!esAdmin) { json(res, 401, { error: 'solo el administrador' }); return true; }
        const d = await cuerpo(), did = t(d.id, 20).replace(/[^a-f0-9]/g, '');
        await s3.removeObjects(BUCKET, [`_disfraces/${did}.json`, `_disfraces/fotos/${did}.jpg`]); json(res, 200, { ok: true }); return true;
      }

      // ----- Alquileres -----
      if (req.method === 'GET' && ruta === '/api/alquileres') {
        const limite = moverDias(fechaEC(), -120);
        const l = (await leerTodos('_alquileres/')).filter(a => a.estado === 'reservado' || a.estado === 'entregado' || a.fechaEvento >= limite);
        l.sort((a, b) => a.retiroDesde.localeCompare(b.retiroDesde)); json(res, 200, l); return true;
      }
      if (req.method === 'POST' && ruta === '/api/alquileres') {
        const d = await cuerpo();
        let a = null; if (d.id) { try { a = await leerJSON(`_alquileres/${t(d.id, 20)}.json`); } catch {} }
        const todos = await leerTodos('_alquileres/'), disfraces = await leerTodos('_disfraces/');
        if (!a) { // nueva reserva
          const fechaEvento = String(d.fechaEvento || '');
          const elegidos = (d.disfraces || []).map(x => disfraces.find(z => z.id === x)).filter(Boolean);
          if (!FECHA.test(fechaEvento) || !elegidos.length || !t(d.cliente?.nombre)) { json(res, 400, { error: 'faltan datos (fecha, disfraz o nombre)' }); return true; }
          const dias = Math.max(1, Math.min(30, parseInt(d.dias, 10) || 1));
          a = { id: id(), creado: new Date().toISOString(), creadoPor: t(d.por, 60), estado: 'reservado', canal: t(d.canal, 30) || 'Facebook', nota: t(d.nota, 200),
            cliente: { nombre: t(d.cliente.nombre, 80), cedula: t(d.cliente.cedula, 20), telefono: t(d.cliente.telefono, 20), correo: t(d.cliente.correo, 80) },
            disfraces: elegidos.map(z => ({ id: z.id, nombre: z.nombre })), fechaEvento, dias,
            retiroDesde: moverDias(fechaEvento, -1), devolverHasta: moverDias(fechaEvento, dias),
            precioDia: PRECIO_DIA, garantiaPorTraje: GARANTIA };
          a.totalAlquiler = a.precioDia * a.dias * a.disfraces.length; a.garantiaTotal = a.garantiaPorTraje * a.disfraces.length;
          const ch = choques(a, todos);
          if (ch.length) { json(res, 409, { error: 'ocupado', detalle: ch.map(o => `${o.disfraces.map(x => x.nombre).join(', ')} (${o.cliente.nombre}, ${o.retiroDesde} a ${o.devolverHasta})`) }); return true; }
        } else { // cambio de estado: cancelar o devolver
          if (d.accion === 'cancelar' && a.estado === 'reservado') { a.estado = 'cancelado'; a.canceladoPor = t(d.por, 60); }
          else if (d.accion === 'devolver' && a.estado === 'entregado') {
            const v = d.devolucion || {};
            a.devolucion = { fecha: fechaEC(), hora: t(v.hora, 8), por: t(d.por, 60), atraso: !!v.atraso, rayados: (v.rayados || []).map(x => t(x, 20)), sinVentilador: (v.sinVentilador || []).map(x => t(x, 20)),
              descuento: Math.max(0, Number(v.descuento) || 0), garantiaDevuelta: Math.max(0, Number(v.garantiaDevuelta) || 0), nota: t(v.nota, 200),
              acta: (v.acta || []).slice(0, 20).map(x => ({ id: t(x.id, 20), nombre: t(x.nombre, 60), completo: !!x.completo, sinRoturas: !!x.sinRoturas, ventilador: !!x.ventilador })) };
            a.estado = 'devuelto';
            for (const did of a.devolucion.rayados) { try { const z = await leerJSON(`_disfraces/${did}.json`); z.estado = 'reparacion'; z.nota = `Devuelto rayado/roto (${a.cliente.nombre}, ${fechaEC()})`; await guardarJSON(`_disfraces/${did}.json`, z); } catch {} }
          } else { json(res, 400, { error: 'acción no permitida' }); return true; }
        }
        await guardarJSON(`_alquileres/${a.id}.json`, a); json(res, 200, a); return true;
      }
      // Contrato: vista previa (para firmar) o el firmado (solo administrador)
      if (req.method === 'GET' && ruta === '/api/alquileres/contrato') {
        const aid = t(url.searchParams.get('id'), 20).replace(/[^a-f0-9]/g, '');
        if (url.searchParams.get('firmado') === '1') {
          if (!esAdmin) { json(res, 401, { error: 'solo el administrador' }); return true; }
          let html;
          try { const st = await s3.getObject(BUCKET, `_contratos/${aid}.html`); const p = []; for await (const c of st) p.push(c); html = Buffer.concat(p).toString('utf8'); }
          catch { json(res, 404, { error: 'no hay contrato firmado' }); return true; }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html);
          return true;
        }
        let a; try { a = await leerJSON(`_alquileres/${aid}.json`); } catch { json(res, 404, { error: 'no existe' }); return true; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(contratoHTML(a, null)); return true;
      }
      // Entrega: firma del cliente + pagos; guarda el contrato y lo envía por correo
      if (req.method === 'POST' && ruta === '/api/alquileres/firmar') {
        const d = await cuerpo(), aid = t(d.id, 20).replace(/[^a-f0-9]/g, '');
        let a; try { a = await leerJSON(`_alquileres/${aid}.json`); } catch { json(res, 404, { error: 'no existe' }); return true; }
        if (a.estado !== 'reservado') { json(res, 400, { error: 'este alquiler ya fue entregado o cancelado' }); return true; }
        const m = /^data:image\/png;base64,(.+)$/.exec(String(d.firma || ''));
        if (!m || m[1].length < 200) { json(res, 400, { error: 'falta la firma' }); return true; }
        const pagos = ['efectivo', 'transferencia', 'deuna'];
        a.entrega = { fecha: fechaEC(), hora: t(d.hora, 8), por: t(d.por, 60), pagoAlquiler: pagos.includes(d.pagoAlquiler) ? d.pagoAlquiler : 'efectivo', pagoGarantia: pagos.includes(d.pagoGarantia) ? d.pagoGarantia : 'efectivo' };
        if (d.correo) a.cliente.correo = t(d.correo, 80);
        a.estado = 'entregado';
        const png = Buffer.from(m[1], 'base64');
        await s3.putObject(BUCKET, `_contratos/${a.id}.png`, png, png.length, { 'Content-Type': 'image/png' });
        const html = contratoHTML(a, String(d.firma));
        const hb = Buffer.from(html);
        await s3.putObject(BUCKET, `_contratos/${a.id}.html`, hb, hb.length, { 'Content-Type': 'text/html; charset=utf-8' });
        a.contrato = { guardado: new Date().toISOString(), correo: await enviarCorreo(a, html, m[1]) };
        await guardarJSON(`_alquileres/${a.id}.json`, a);
        json(res, 200, a); return true;
      }
      if (req.method === 'POST' && ruta === '/api/alquileres/borrar') { // para corregir errores (solo administrador)
        if (!esAdmin) { json(res, 401, { error: 'solo el administrador' }); return true; }
        const aid = t((await cuerpo()).id, 20).replace(/[^a-f0-9]/g, '');
        if (!aid) { json(res, 400, { error: 'falta el id' }); return true; }
        await s3.removeObjects(BUCKET, [`_alquileres/${aid}.json`, `_contratos/${aid}.html`, `_contratos/${aid}.png`]);
        json(res, 200, { ok: true }); return true;
      }
      if (req.method === 'POST' && ruta === '/api/alquileres/reenviar') {
        if (!esAdmin) { json(res, 401, { error: 'solo el administrador' }); return true; }
        const d = await cuerpo(), aid = t(d.id, 20).replace(/[^a-f0-9]/g, '');
        let a; try { a = await leerJSON(`_alquileres/${aid}.json`); } catch { json(res, 404, { error: 'no existe' }); return true; }
        if (d.correo) a.cliente.correo = t(d.correo, 80);
        let firmaB64 = null, html;
        try { const st = await s3.getObject(BUCKET, `_contratos/${a.id}.png`); const p = []; for await (const c of st) p.push(c); firmaB64 = Buffer.concat(p).toString('base64'); } catch {}
        html = contratoHTML(a, firmaB64 ? `data:image/png;base64,${firmaB64}` : null);
        a.contrato = { ...(a.contrato || {}), correo: await enviarCorreo(a, html, firmaB64), reenviado: new Date().toISOString() };
        await guardarJSON(`_alquileres/${a.id}.json`, a); json(res, 200, a); return true;
      }
      json(res, 404, { error: 'no encontrado' }); return true;
    }
  };
};
