/**
 * GET /api/recibos/control-im?dias=14[&refrescar=1] — los recibos que emitió la app y que IM ya
 * no tiene (S32 · mejora 7). Para la oficina: es un informe en la app, no un aviso que se manda
 * (regla de avisos de Mati, 04/10/2026: "lo que arregla otra persona va a un informe en la app").
 *
 * Una o dos consultas a IM por rango (GET /api/v2/recibos), cacheadas 30 minutos.
 *
 * Medido en producción el 04/10: de 551 recibos de la app (35 días), 2 ya no existen en IM.
 */
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import type { JwtPayload } from './auth.js';
import { puedeRevisarRecibos } from './permisos.js';
import { getV2, imV2Configurada } from './imApiV2.js';
import { recibosQueFaltanEnIM, type ImputadoApp } from './controlReciboIM.js';

const CACHE_MS = 30 * 60_000;
/**
 * 🪤 Margen de días alrededor del rango: en IM a veces le corren la fecha a un recibo (el 58697388,
 * del 01/09, lo editaron el 16/09 y quedó fechado el 31/08). Sin margen, quedaba fuera del rango
 * consultado y se informaba como faltante sin serlo.
 */
const MARGEN_DIAS = 7;
const sumarDias = (iso: string, n: number) =>
  new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) + n * 86_400_000).toISOString().slice(0, 10);
const cache = new Map<number, { at: number; cuerpo: unknown }>();

interface FilaImputada { id: string; cod_cliente: number; monto: number | string; fecha_comprobante: string | null; infomanager_recibo_id: string | null; imputado_at: string | null; cod_empresa: number | null; reviewed_by: string | null }

async function recibosIMDelRango(desde: string, hasta: string, empresas: string): Promise<Array<{ id_recibo: number | string }>> {
  const filas: Array<{ id_recibo: number | string }> = [];
  for (let page = 1; page <= 20; page++) {
    const d = await getV2<{ results?: Array<{ id_recibo: number | string }>; totalPages?: number }>('/api/v2/recibos', { fecha_desde: desde, fecha_hasta: hasta, empresas, page, limit: 5000 });
    filas.push(...(d?.results ?? []));
    if (!d?.totalPages || page >= d.totalPages) return filas;
  }
  throw new Error('Demasiados recibos en el rango.');
}

export async function controlRecibosIM(req: Request & { user?: JwtPayload }, res: Response) {
  if (!req.user || !puedeRevisarRecibos(req.user.rol)) { res.status(403).json({ error: 'Requiere admin, gerente o administrativo' }); return; }
  const dias = Math.min(60, Math.max(1, Number(req.query.dias) || 14));
  const hit = cache.get(dias);
  if (req.query.refrescar !== '1' && hit && Date.now() - hit.at < CACHE_MS) { res.json(hit.cuerpo); return; }
  if (!imV2Configurada()) { res.status(503).json({ error: 'Falta configurar la API nueva de InfoManager.' }); return; }

  const { data, error } = await sb().from('comprobantes_pago')
    .select('id, cod_cliente, monto, fecha_comprobante, infomanager_recibo_id, imputado_at, cod_empresa, reviewed_by')
    .eq('tenant_id', TENANT_ID).eq('status', 'imputado').not('infomanager_recibo_id', 'is', null)
    .gte('imputado_at', new Date(Date.now() - dias * 86_400_000).toISOString())
    .order('imputado_at').limit(3000);
  if (error) { res.status(502).json({ error: `No pude leer los recibos de la app: ${error.message}` }); return; }
  const filas = (data ?? []) as FilaImputada[];
  if (!filas.length) { res.json({ ok: true, dias, revisados: 0, faltan: [] }); return; }

  // La fecha del recibo en IM es la del comprobante (487 de 488 en septiembre; el otro lo editaron en IM).
  const fechas = filas.map(f => (f.fecha_comprobante || f.imputado_at || '').slice(0, 10)).filter(Boolean).sort();
  const empresas = [...new Set(filas.map(f => String(f.cod_empresa ?? 1)))].join(',');
  let enIM: Array<{ id_recibo: number | string }>;
  try { enIM = await recibosIMDelRango(sumarDias(fechas[0], -MARGEN_DIAS), sumarDias(fechas.at(-1) as string, MARGEN_DIAS), empresas); }
  catch (e) {
    // Sin la lista de IM no se puede decir qué falta: un error claro, nunca faltantes inventados.
    res.status(502).json({ error: `InfoManager no devolvió los recibos (${e instanceof Error ? e.message : String(e)}).` }); return;
  }

  const ids = [...new Set(filas.map(f => f.reviewed_by).filter(Boolean))] as string[];
  const nombres = new Map<string, string | null>();
  if (ids.length) {
    const { data: us } = await sb().from('usuarios').select('id, nombre').in('id', ids);
    for (const u of us ?? []) nombres.set(String(u.id), u.nombre ?? null);
  }
  const app: ImputadoApp[] = filas.map(f => ({
    id: String(f.id), cod_cliente: Number(f.cod_cliente), monto: Number(f.monto), fecha_comprobante: f.fecha_comprobante,
    infomanager_recibo_id: f.infomanager_recibo_id, imputado_at: f.imputado_at, cod_empresa: f.cod_empresa,
    reviewed_by_nombre: f.reviewed_by ? nombres.get(f.reviewed_by) ?? null : null,
  }));
  const cuerpo = { ok: true, dias, revisados: app.length, faltan: recibosQueFaltanEnIM(app, enIM), consultado_at: new Date().toISOString() };
  cache.set(dias, { at: Date.now(), cuerpo });
  res.json(cuerpo);
}
