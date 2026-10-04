/**
 * GET /api/recibos/posibles-duplicados?cod_cliente=&monto=&fecha=[&excluir_id=]
 *
 * ¿Este pago ya figura en la app o en InfoManager? Lo usan la carga (vendedor, chofer) y el
 * detalle que revisa la oficina. La lógica del parecido vive en `duplicadosRecibo.ts` (pura, con
 * tests); acá sólo se junta lo que hace falta.
 *
 * Es un AVISO: si IM no contesta se responde igual con lo de la app y `consultado.im = false`,
 * para que la pantalla diga "no pude mirar IM" en vez de callarse.
 */
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import { getV2, imV2Configurada } from './imApiV2.js';
import { posiblesDuplicados, VENTANA_IM, VENTANA_APP, type ReciboAppLite, type ReciboIMLite } from './duplicadosRecibo.js';
import type { JwtPayload } from './auth.js';

const sumarDias = (iso: string, n: number) =>
  new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) + n * 86_400_000).toISOString().slice(0, 10);

/** Cada carga pregunta una vez; el cliente que corrige el monto pregunta de nuevo. 2 min alcanzan. */
const CACHE_MS = 2 * 60_000;
const cacheIM = new Map<string, { at: number; filas: ReciboIMLite[] }>();

async function recibosIMDelCliente(cod: number, desde: string, hasta: string): Promise<ReciboIMLite[] | null> {
  if (!imV2Configurada()) return null;
  const clave = `${cod}|${desde}|${hasta}`;
  const hit = cacheIM.get(clave);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.filas;
  try {
    const d = await getV2<{ results?: ReciboIMLite[] }>('/api/v2/recibos', { fecha_desde: desde, fecha_hasta: hasta, cod_cliente: cod, limit: 200 });
    const filas: ReciboIMLite[] = Array.isArray(d?.results) ? d.results : [];
    cacheIM.set(clave, { at: Date.now(), filas });
    if (cacheIM.size > 500) cacheIM.delete(cacheIM.keys().next().value as string);
    return filas;
  } catch (e) {
    console.warn(`[posibles-duplicados] IM no contestó para el cliente ${cod}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export async function posiblesDuplicadosRecibo(req: Request & { user?: JwtPayload }, res: Response) {
  if (!req.user) { res.status(401).json({ error: 'No autorizado' }); return; }
  const cod = Number(req.query.cod_cliente);
  const monto = Number(req.query.monto);
  const fecha = String(req.query.fecha ?? '').slice(0, 10);
  if (!(cod > 0) || !(monto > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    res.status(400).json({ error: 'Faltan cod_cliente, monto o fecha (AAAA-MM-DD).' });
    return;
  }
  const excluirId = typeof req.query.excluir_id === 'string' && req.query.excluir_id ? req.query.excluir_id : undefined;

  // En la app: los recibos de ese cliente cargados cerca de esa fecha (la carga puede ser días después).
  const desde = sumarDias(fecha, -(VENTANA_APP + 3));
  const hasta = sumarDias(fecha, VENTANA_APP + 10);
  const { data: filas, error } = await sb().from('comprobantes_pago')
    .select('id, cod_cliente, monto, fecha_comprobante, created_at, status, infomanager_recibo_id, created_by')
    .eq('tenant_id', TENANT_ID).eq('cod_cliente', cod)
    .gte('created_at', `${desde}T00:00:00Z`).lte('created_at', `${hasta}T23:59:59Z`)
    .limit(200);
  if (error) console.warn(`[posibles-duplicados] Supabase: ${error.message}`);
  interface FilaApp { id: string; cod_cliente: number; monto: number; fecha_comprobante: string | null; created_at: string; status: string; infomanager_recibo_id: string | null; created_by: string | null }
  const enApp = (filas ?? []) as FilaApp[];

  // Quién cargó cada uno: el aviso dice "lo cargó Victor (chofer)", que es lo que hay que saber.
  const ids = [...new Set(enApp.map(f => f.created_by).filter(Boolean))];
  const quienes = new Map<string, { rol: string; nombre: string | null }>();
  if (ids.length) {
    const { data: us } = await sb().from('usuarios').select('id, rol, nombre').in('id', ids);
    for (const u of us ?? []) quienes.set(String(u.id), { rol: String(u.rol), nombre: u.nombre ?? null });
  }
  const propio = excluirId ? enApp.find(f => f.id === excluirId) : undefined;

  const enIM = await recibosIMDelCliente(cod, sumarDias(fecha, -VENTANA_IM.antes), sumarDias(fecha, VENTANA_IM.despues));
  const app: ReciboAppLite[] = enApp.map(f => ({
    id: String(f.id), cod_cliente: Number(f.cod_cliente), monto: Number(f.monto), fecha_comprobante: f.fecha_comprobante ?? null,
    created_at: String(f.created_at), status: String(f.status), infomanager_recibo_id: f.infomanager_recibo_id ?? null,
    created_by_rol: quienes.get(String(f.created_by))?.rol ?? null, created_by_nombre: quienes.get(String(f.created_by))?.nombre ?? null,
  }));
  const r = posiblesDuplicados(
    { cod_cliente: cod, monto, fecha, id: excluirId, infomanager_recibo_id: propio?.infomanager_recibo_id ?? null },
    app, enIM ?? [],
  );
  res.json({ ok: true, ...r, consultado: { app: !error, im: enIM != null } });
}
