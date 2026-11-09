// Sincronización de ventas, turnos de caja, garantías y clientes entre todos los teléfonos (PostgreSQL en el VPS).
// Cada teléfono envía sus cambios y recibe los de los demás desde un "cursor" (número de versión).
// Solo los teléfonos activados por el administrador pueden sincronizar.
'use strict';
const crypto = require('crypto');
const { Pool } = require('pg');

const TIPOS = new Set(['venta', 'turno', 'movimiento', 'cliente']);
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

module.exports = function crearSync({ json, leerCuerpo, igual }) {
  const { DATABASE_URL } = process.env;
  if (!DATABASE_URL) { console.log('Sin DATABASE_URL: la sincronización está apagada'); return { iniciar: async () => {}, rutas: async () => false }; }
  const pool = new Pool({ connectionString: DATABASE_URL, max: 8 });
  pool.on('error', e => console.error('PostgreSQL:', e.message));
  let tokens = new Map(), listo = false;

  async function iniciar() {
    for (let i = 0; i < 40; i++) {
      try {
        await pool.query(`
          CREATE SEQUENCE IF NOT EXISTS registros_version;
          CREATE TABLE IF NOT EXISTS registros (
            tipo text NOT NULL, id text NOT NULL, fecha date, data jsonb NOT NULL,
            borrado boolean NOT NULL DEFAULT false, dispositivo text,
            version bigint NOT NULL, actualizado timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (tipo, id));
          CREATE INDEX IF NOT EXISTS registros_version_idx ON registros (version);
          CREATE INDEX IF NOT EXISTS registros_tipo_fecha_idx ON registros (tipo, fecha);
          CREATE TABLE IF NOT EXISTS dispositivos_token (
            token text PRIMARY KEY, dev text NOT NULL, nombre text, creado timestamptz NOT NULL DEFAULT now(), activo boolean NOT NULL DEFAULT true);`);
        await cargarTokens(); listo = true;
        console.log('Base de datos lista'); return;
      } catch (e) { console.log('Esperando a PostgreSQL…', e.message); await new Promise(r => setTimeout(r, 3000)); }
    }
  }
  async function cargarTokens() {
    const r = await pool.query('SELECT token, dev, nombre FROM dispositivos_token WHERE activo');
    tokens = new Map(r.rows.map(x => [x.token, x]));
  }
  const dispositivoDe = req => tokens.get(String(req.headers['x-dev-token'] || '')) || null;

  return {
    iniciar,
    async rutas(req, res, ruta, esAdmin) {
      if (!ruta.startsWith('/api/sync') && ruta !== '/api/dispositivos/activar' && ruta !== '/api/dispositivos/desactivar') return false;
      if (!listo) { json(res, 503, { error: 'la base de datos se está iniciando' }); return true; }
      const cuerpo = async () => JSON.parse((await leerCuerpo(req)).toString('utf8') || '{}');

      // El administrador activa un teléfono (una sola vez) y este recibe su propia llave
      if (req.method === 'POST' && ruta === '/api/dispositivos/activar') {
        if (!esAdmin) { json(res, 401, { error: 'solo el administrador' }); return true; }
        const d = await cuerpo(), dev = String(d.dev || '').slice(0, 12).replace(/[^A-Z0-9]/g, '');
        if (!dev) { json(res, 400, { error: 'falta el teléfono' }); return true; }
        const token = crypto.randomBytes(24).toString('base64url');
        await pool.query('UPDATE dispositivos_token SET activo = false WHERE dev = $1', [dev]);
        await pool.query('INSERT INTO dispositivos_token (token, dev, nombre) VALUES ($1, $2, $3)', [token, dev, String(d.nombre || '').slice(0, 60)]);
        await cargarTokens();
        json(res, 200, { token }); return true;
      }

      // Desactivar un teléfono (perdido, cambiado o de prueba)
      if (req.method === 'POST' && ruta === '/api/dispositivos/desactivar') {
        if (!esAdmin) { json(res, 401, { error: 'solo el administrador' }); return true; }
        const dev = String((await cuerpo()).dev || '').slice(0, 12);
        const r = await pool.query('UPDATE dispositivos_token SET activo = false WHERE dev = $1 AND activo', [dev]);
        await cargarTokens(); json(res, 200, { desactivados: r.rowCount }); return true;
      }
      // Estado general (administrador)
      if (req.method === 'GET' && ruta === '/api/sync/estado') {
        if (!esAdmin) { json(res, 401, { error: 'solo el administrador' }); return true; }
        const r = await pool.query(`SELECT tipo, count(*)::int AS n, sum(CASE WHEN borrado THEN 1 ELSE 0 END)::int AS borrados FROM registros GROUP BY tipo`);
        const t = await pool.query(`SELECT dev, nombre, creado FROM dispositivos_token WHERE activo ORDER BY creado`);
        json(res, 200, { registros: r.rows, telefonos: t.rows }); return true;
      }

      // Sincronizar: recibe cambios del teléfono y le devuelve lo nuevo de todos
      if (req.method === 'POST' && ruta === '/api/sync') {
        const disp = dispositivoDe(req);
        if (!disp) { json(res, 401, { error: 'teléfono no activado' }); return true; }
        const d = await cuerpo();
        const cambios = Array.isArray(d.cambios) ? d.cambios.slice(0, 500) : [];
        let guardados = 0;
        if (cambios.length) {
          const cli = await pool.connect();
          try {
            await cli.query('BEGIN');
            for (const c of cambios) {
              const tipo = String(c.tipo || ''), id = String(c.id || '').slice(0, 80);
              if (!TIPOS.has(tipo) || !id || typeof c.data !== 'object' || c.data === null) continue;
              const data = JSON.stringify(c.data);
              if (data.length > 60000) continue;
              const fecha = FECHA.test(String(c.fecha || '')) ? c.fecha : null;
              await cli.query(`
                INSERT INTO registros (tipo, id, fecha, data, borrado, dispositivo, version)
                VALUES ($1, $2, $3, $4::jsonb, $5, $6, nextval('registros_version'))
                ON CONFLICT (tipo, id) DO UPDATE SET fecha = EXCLUDED.fecha, data = EXCLUDED.data, borrado = EXCLUDED.borrado,
                  dispositivo = EXCLUDED.dispositivo, version = nextval('registros_version'), actualizado = now()
                WHERE registros.data IS DISTINCT FROM EXCLUDED.data OR registros.borrado IS DISTINCT FROM EXCLUDED.borrado`,
                [tipo, id, fecha, data, !!c.borrado, disp.dev]);
              guardados++;
            }
            await cli.query('COMMIT');
          } catch (e) { await cli.query('ROLLBACK'); throw e; } finally { cli.release(); }
        }
        const desde = Math.max(0, parseInt(d.desde, 10) || 0);
        const r = await pool.query('SELECT tipo, id, data, borrado, version FROM registros WHERE version > $1 ORDER BY version LIMIT 1000', [desde]);
        const cursor = r.rows.length ? Number(r.rows[r.rows.length - 1].version) : desde;
        json(res, 200, { guardados, cursor, mas: r.rows.length === 1000, registros: r.rows.map(x => ({ tipo: x.tipo, id: x.id, data: x.data, borrado: x.borrado })) });
        return true;
      }
      json(res, 404, { error: 'no encontrado' }); return true;
    }
  };
};
