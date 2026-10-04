/**
 * POST /api/recibos/lote — aprobar EN LOTE los pagos que MercadoPago ya verificó (S32 · mejora 4).
 *
 *   { accion: 'plan' }                     → qué entraría, con qué imputación, y qué no y por qué.
 *   { accion: 'aprobar', ids: string[] }   → vuelve a armar el plan con datos frescos y aprueba los
 *                                            listos, uno por uno, hasta el tope del piloto.
 *
 * 🔑 El lote NO tiene lógica de plata propia: cada recibo pasa por el mismo `aprobarRecibo` de la
 * pantalla (candado, pre-chequeo anti-duplicado contra IM, ajuste de centavos, usuario de quien
 * aprueba). Acá sólo se decide qué entra y se frena en el primer problema.
 *
 * Mati (04/10/2026): *"empezá por una tanda chica, verificada contra IM antes de liberar el
 * resto"* ⇒ tope por tanda en `RECIBOS_LOTE_TOPE` (3 de entrada). Se sube cambiando la variable.
 */
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import type { JwtPayload } from './auth.js';
import { puedeRevisarRecibos } from './permisos.js';
import { fetchComprobPendientes } from './infomanager.js';
import { getV2, imV2Configurada } from './imApiV2.js';
import { aprobarRecibo } from './recibos.js';
import { planDelLote, type CandidatoLote, type PasoLote } from './loteRecibos.js';
import { posiblesDuplicados, VENTANA_IM, VENTANA_APP, type ReciboAppLite, type ReciboIMLite } from './duplicadosRecibo.js';
import type { FacturaParaImputar } from '../src/utils/aprobacionRecibos.js';

/** El lote es de Casa Central: los pagos verificados por MercadoPago entran a la empresa 1. */
const EMPRESA = 1;
const tope = () => Math.max(0, Number(process.env.RECIBOS_LOTE_TOPE ?? 3) || 0);

const sumarDias = (iso: string, n: number) =>
  new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) + n * 86_400_000).toISOString().slice(0, 10);

interface FilaRecibo {
  id: string; cod_cliente: number; monto: number | string; fecha_comprobante: string | null; medio_pago: string | null;
  mp_status: string | null; status: string; observaciones: string | null; created_at: string; infomanager_recibo_id: string | null;
  mp_payment_id?: string | null; mp_candidates?: Array<{ payment_id?: string; date_approved?: string }> | null;
}

/** La fecha que se graba en IM: la del comprobante; si no hay, la del pago en MercadoPago. */
function fechaDe(f: FilaRecibo): string | null {
  if (f.fecha_comprobante) return String(f.fecha_comprobante).slice(0, 10);
  const mp = (f.mp_candidates ?? []).find(c => String(c.payment_id) === String(f.mp_payment_id));
  return mp?.date_approved ? String(mp.date_approved).slice(0, 10) : null;
}

async function armarPlan(filas: FilaRecibo[]): Promise<{ plan: PasoLote[]; imConsultado: boolean }> {
  const candidatos: CandidatoLote[] = filas.map(f => ({
    id: String(f.id), cod_cliente: Number(f.cod_cliente), monto: Number(f.monto), fecha: fechaDe(f),
    medio_pago: f.medio_pago, mp_status: f.mp_status, status: f.status, observaciones: f.observaciones,
  }));
  const conFecha = candidatos.filter(c => c.fecha);
  if (!conFecha.length) return { plan: planDelLote(candidatos, () => [], () => ({ app: [], im: [] }), tope()), imConsultado: true };

  // Facturas pendientes por cliente: una consulta a IM por cliente, en serie (no en ráfaga).
  const pendientes = new Map<number, FacturaParaImputar[]>();
  for (const cod of [...new Set(conFecha.map(c => c.cod_cliente))]) {
    try { pendientes.set(cod, await fetchComprobPendientes(EMPRESA, cod)); }
    catch { pendientes.set(cod, []); }   // sin pendientes el recibo queda salteado: no se imputa a ciegas
  }

  // ¿Ya figura? Una sola consulta de recibos de IM para toda la ventana, y la app por los mismos clientes.
  const fechas = conFecha.map(c => c.fecha as string).sort();
  let enIM: ReciboIMLite[] | null = null;
  if (imV2Configurada()) {
    try {
      const d = await getV2<{ results?: ReciboIMLite[] }>('/api/v2/recibos', {
        fecha_desde: sumarDias(fechas[0], -VENTANA_IM.antes), fecha_hasta: sumarDias(fechas.at(-1) as string, VENTANA_IM.despues), limit: 5000,
      });
      enIM = d?.results ?? [];
    } catch (e) { console.warn(`[lote] IM no devolvió los recibos: ${e instanceof Error ? e.message : String(e)}`); }
  }
  const { data: deApp } = await sb().from('comprobantes_pago')
    .select('id, cod_cliente, monto, fecha_comprobante, created_at, status, infomanager_recibo_id')
    .eq('tenant_id', TENANT_ID).in('cod_cliente', [...new Set(conFecha.map(c => c.cod_cliente))])
    .gte('created_at', `${sumarDias(fechas[0], -(VENTANA_APP + 3))}T00:00:00Z`)
    .lte('created_at', `${sumarDias(fechas.at(-1) as string, VENTANA_APP + 10)}T23:59:59Z`);
  const app = (deApp ?? []) as ReciboAppLite[];

  const plan = planDelLote(
    candidatos,
    cod => pendientes.get(cod) ?? [],
    // 🔴 Sin poder mirar IM no se descarta un duplicado: para emitir, eso cuenta como "puede estar repetido".
    c => enIM == null ? { app: [], im: ['IM no contestó'] } : posiblesDuplicados({ cod_cliente: c.cod_cliente, monto: c.monto, fecha: c.fecha as string, id: c.id }, app, enIM),
    tope(),
  );
  if (enIM == null) for (const p of plan) if (p.estado !== 'salteado') Object.assign(p, { estado: 'salteado', motivo: 'No pude consultar InfoManager para descartar duplicados: probá en unos minutos.', comprobantes: undefined });
  return { plan, imConsultado: enIM != null };
}

export async function aprobarEnLote(req: Request & { user?: JwtPayload }, res: Response) {
  const user = req.user;
  if (!user || !puedeRevisarRecibos(user.rol)) { res.status(403).json({ error: 'Requiere admin, gerente o administrativo' }); return; }
  const accion = req.body?.accion;
  if (accion !== 'plan' && accion !== 'aprobar') { res.status(400).json({ error: 'accion tiene que ser "plan" o "aprobar"' }); return; }
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 200) : [];
  if (accion === 'aprobar' && !ids.length) { res.status(400).json({ error: 'Faltan los ids a aprobar' }); return; }

  try {
    let q = sb().from('comprobantes_pago')
      .select('id, cod_cliente, monto, fecha_comprobante, medio_pago, mp_status, status, observaciones, created_at, infomanager_recibo_id, mp_payment_id, mp_candidates')
      .eq('tenant_id', TENANT_ID);
    q = accion === 'plan'
      ? q.eq('status', 'pendiente_revision').eq('medio_pago', 'mercadopago').eq('mp_status', 'verified').order('created_at').limit(100)
      : q.in('id', ids);
    const { data: filas, error } = await q;
    if (error) { res.status(502).json({ error: `No pude leer los recibos: ${error.message}` }); return; }

    const { plan, imConsultado } = await armarPlan((filas ?? []) as FilaRecibo[]);
    if (accion === 'plan') { res.json({ ok: true, tope: tope(), plan, consultado: { im: imConsultado } }); return; }

    // Aprobar: uno por uno, con el mismo handler de la pantalla. Se frena en el primer problema.
    const resultados: Array<{ id: string; ok: boolean; recibo_id?: string | null; error?: string }> = [];
    let frenado = false;
    for (const paso of plan.filter(p => p.estado === 'listo' && ids.includes(p.id))) {
      const r: { statusCode: number; body: { ok?: boolean; recibo_id?: string | null; error?: string } | null } = { statusCode: 200, body: null };
      const resInterno = { status(c: number) { r.statusCode = c; return this; }, json(b: typeof r.body) { r.body = b; return this; } } as unknown as Response;
      const reqInterno = { params: { id: paso.id }, user, body: { monto: paso.monto, fecha: paso.fecha, medio_pago: 'mercadopago', cod_empresa: EMPRESA, comprobantes: paso.comprobantes } } as unknown as Request & { user?: JwtPayload };
      await aprobarRecibo(reqInterno, resInterno);
      const ok = r.statusCode === 200 && r.body?.ok === true;
      resultados.push(ok ? { id: paso.id, ok, recibo_id: r.body?.recibo_id ?? null } : { id: paso.id, ok, error: r.body?.error ?? `HTTP ${r.statusCode}` });
      if (!ok) { frenado = true; break; }
    }
    console.log(`[lote] ${user.sub} aprobó ${resultados.filter(x => x.ok).length} de ${resultados.length}${frenado ? ' (frenado)' : ''}`);
    res.json({ ok: true, tope: tope(), plan, resultados, frenado });
  } catch (err) {
    const e = err as { message?: string };
    console.error('[lote]', e?.message);
    res.status(500).json({ error: e?.message ?? 'error' });
  }
}
