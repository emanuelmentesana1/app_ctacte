/**
 * GET /api/rendiciones?desde=&hasta=[&refrescar=1] — la rendición de las hojas, SÓLO LECTURA.
 *
 * Etapa 1 del diseño aprobado por Mati el 04/10/2026: mostrar, por hoja y por cliente, lo que ya
 * está cargado (recibos de efectivo en IM, transferencias en la app, notas de crédito, gastos del
 * viaje) y si la caja del día cuadra con el asiento de IM. No escribe nada, en ningún lado.
 *
 * La cuenta vive en `rendicionHoja.ts` (pura, con tests). Acá sólo se junta lo que hace falta:
 *  · Supabase: hojas y entregas (con los MISMOS importes que la Liquidación: `enriquecerHojas`),
 *    notas vinculadas (`notasDeHojas`) y transferencias cargadas en la app.
 *  · IM: GET /api/v2/recibos (efectivo a Caja Repartos) y /planes/mayor de Caja Repartos (gastos,
 *    asiento de rendición y diferencia de caja). Dos lecturas por rango, cacheadas 5 minutos.
 */
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import type { JwtPayload } from './auth.js';
import { puedeArmarHojasDeRuta } from './permisos.js';
import { leerPaginas, enriquecerHojas, notasDeHojas } from './repartoDatos.js';
import { imClient, imGetRetry, fechaArgentina } from './infomanager.js';
import { getV2, imV2Configurada } from './imApiV2.js';
import { armarRendiciones, type HojaIn, type ReciboIMIn, type MovMayorIn, type TransferenciaIn } from './rendicionHoja.js';

/** Caja Repartos en el plan de cuentas de IM (empresa 1). */
const CUENTA_CAJA_REPARTOS = process.env.IM_CUENTA_CAJA_REPARTOS || '1110009';
const MAX_DIAS = 31;
const CACHE_MS = 5 * 60_000;

const sumarDias = (iso: string, n: number) =>
  new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) + n * 86_400_000).toISOString().slice(0, 10);
const diasEntre = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Lo mínimo de las filas de Supabase que se usan acá. */
interface FilaPedido { im_comprobante_id: string | number; cod_cliente: number | string; cliente_nombre?: string | null; total?: number | string | null; saldo_anterior?: number | string | null; notas?: Array<{ tipo?: unknown; total?: unknown }> }
interface FilaHoja { id: string; numero: number; fecha: string; estado: string; nombre?: string | null; choferes?: { nombre?: string | null } | null; hojas_ruta_pedidos?: FilaPedido[] }
interface FilaCobro { id: string; cod_cliente: number; monto: number | string; medio_pago: string | null; status: string; fecha_comprobante: string | null; created_at: string; created_by: string | null }

const cache = new Map<string, { at: number; valor: unknown }>();
async function conCache<T>(clave: string, refrescar: boolean, leer: () => Promise<T>): Promise<T> {
  const hit = cache.get(clave);
  if (!refrescar && hit && Date.now() - hit.at < CACHE_MS) return hit.valor as T;
  const valor = await leer();
  cache.set(clave, { at: Date.now(), valor });
  if (cache.size > 100) cache.delete(cache.keys().next().value as string);
  return valor;
}

/** Recibos de IM del rango (empresa 1), todas las páginas. */
async function recibosIM(desde: string, hasta: string): Promise<ReciboIMIn[]> {
  const filas: ReciboIMIn[] = [];
  for (let page = 1; page <= 20; page++) {
    const d = await getV2<{ results?: ReciboIMIn[]; totalPages?: number }>('/api/v2/recibos', { fecha_desde: desde, fecha_hasta: hasta, empresas: '1', page, limit: 5000 });
    filas.push(...(d?.results ?? []));
    if (!d?.totalPages || page >= d.totalPages) return filas;
  }
  throw new Error('Demasiados recibos en el rango: acotalo.');
}

/** Libro mayor de Caja Repartos del rango. */
async function mayorCaja(desde: string, hasta: string): Promise<MovMayorIn[]> {
  const cli = await imClient();
  const { data } = await imGetRetry(() => cli.get('/planes/mayor', {
    params: { fechaDesde: desde, fechaHasta: hasta, tag: 'T', saldoAnterior: 'N', codEmpresa: 1, codCuenta: Number(CUENTA_CAJA_REPARTOS) },
  }), 'mayor caja repartos');
  return (Array.isArray(data) ? data : (data?.results ?? [])) as MovMayorIn[];
}

export async function rendicionesDelRango(req: Request & { user?: JwtPayload }, res: Response) {
  if (!puedeArmarHojasDeRuta(String(req.user?.rol ?? ''))) { res.status(403).json({ error: 'Esto lo ve administración.' }); return; }
  const desde = String(req.query.desde ?? '').slice(0, 10);
  const hasta = String(req.query.hasta ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta) || hasta < desde) {
    res.status(400).json({ error: 'Rango inválido: mandá desde y hasta (AAAA-MM-DD).' }); return;
  }
  if (diasEntre(desde, hasta) > MAX_DIAS) { res.status(400).json({ error: `El rango no puede pasar de ${MAX_DIAS} días.` }); return; }
  const refrescar = req.query.refrescar === '1';

  try {
    const hojas: FilaHoja[] = await leerPaginas(() => sb().from('hojas_ruta')
      .select('id, numero, fecha, estado, cierres_importes, chofer_id, nombre, choferes(nombre), hojas_ruta_pedidos(*)')
      .eq('tenant_id', TENANT_ID).gte('fecha', desde).lte('fecha', hasta).neq('estado', 'anulada')
      .order('fecha').order('numero'));
    if (!hojas.length) {
      res.json({ ok: true, desde, hasta, hojas: [], asientos: [], fuera_de_hoja: [], consultado: { im_recibos: true, im_mayor: true } });
      return;
    }

    // Los mismos importes que la Liquidación: vivos en las abiertas, congelados al cierre en las cerradas.
    const entregas = await enriquecerHojas(hojas, false, true);
    const porId = new Map<string, FilaPedido>(entregas.map((p: FilaPedido) => [String(p.im_comprobante_id), p]));
    const grupos = hojas.map(h => ({ hojaId: String(h.id), filas: (h.hojas_ruta_pedidos ?? []).map(p => porId.get(String(p.im_comprobante_id)) ?? p) }));
    const conNotas = new Map((await notasDeHojas(grupos)).map(g => [g.hojaId, g.filas]));

    const hojasIn: HojaIn[] = hojas.map(h => ({
      id: String(h.id), numero: Number(h.numero), fecha: String(h.fecha), estado: String(h.estado),
      chofer: h.choferes?.nombre ?? null, nombre: h.nombre ?? null,
      pedidos: ((conNotas.get(String(h.id)) ?? []) as FilaPedido[]).map(p => ({
        im_comprobante_id: String(p.im_comprobante_id), cod_cliente: Number(p.cod_cliente), cliente_nombre: p.cliente_nombre ?? null,
        total: Number(p.total ?? 0), saldo_anterior: p.saldo_anterior == null ? null : Number(p.saldo_anterior), notas: p.notas ?? [],
      })),
    }));

    // IM: el efectivo se carga con la fecha de la hoja; el asiento sale uno a tres días después.
    const hoy = fechaArgentina();
    const finMayor = sumarDias(hasta, 5) < hoy ? sumarDias(hasta, 5) : hoy;
    if (!imV2Configurada()) { res.status(503).json({ error: 'Falta configurar la API nueva de InfoManager: no puedo leer los recibos.' }); return; }
    let recibos: ReciboIMIn[];
    try {
      recibos = await conCache(`rec|${desde}|${hasta}`, refrescar, () => recibosIM(sumarDias(desde, -1), sumarDias(hasta, 1)));
    } catch (e) {
      // Sin los recibos, la pantalla diría "no cobró" a todos: es preferible un error claro.
      res.status(502).json({ error: `InfoManager no devolvió los recibos (${e instanceof Error ? e.message : String(e)}). Probá en unos minutos.` }); return;
    }
    let mayor: MovMayorIn[] = [];
    let mayorOk = true;
    try { mayor = await conCache(`may|${desde}|${finMayor}`, refrescar, () => mayorCaja(desde, finMayor)); }
    catch (e) { mayorOk = false; console.warn(`[rendiciones] mayor de Caja Repartos: ${e instanceof Error ? e.message : String(e)}`); }

    // Transferencias cargadas en la app (chofer o vendedor) para los clientes de las hojas.
    const clientes = [...new Set(hojasIn.flatMap(h => h.pedidos.map(p => p.cod_cliente)))];
    const transf: FilaCobro[] = [];
    for (let i = 0; i < clientes.length; i += 200) {
      transf.push(...await leerPaginas(() => sb().from('comprobantes_pago')
        .select('id, cod_cliente, monto, medio_pago, status, fecha_comprobante, created_at, created_by')
        .eq('tenant_id', TENANT_ID).in('cod_cliente', clientes.slice(i, i + 200))
        .gte('created_at', `${sumarDias(desde, -2)}T00:00:00Z`).lte('created_at', `${sumarDias(hasta, 3)}T23:59:59Z`)
        .order('created_at')));
    }
    const ids = [...new Set(transf.map(t => t.created_by).filter(Boolean))];
    const quienes = new Map<string, { rol: string; nombre: string | null }>();
    if (ids.length) {
      const { data: us } = await sb().from('usuarios').select('id, rol, nombre').in('id', ids);
      for (const u of us ?? []) quienes.set(String(u.id), { rol: String(u.rol), nombre: u.nombre ?? null });
    }
    const transferencias: TransferenciaIn[] = transf.map(t => ({
      id: String(t.id), cod_cliente: Number(t.cod_cliente), monto: Number(t.monto), medio_pago: t.medio_pago ?? null, status: String(t.status),
      fecha_comprobante: t.fecha_comprobante ?? null, created_at: String(t.created_at),
      created_by_rol: quienes.get(String(t.created_by))?.rol ?? null, created_by_nombre: quienes.get(String(t.created_by))?.nombre ?? null,
    }));

    const r = armarRendiciones({ hojas: hojasIn, recibosIM: recibos, mayor, transferencias, cuentaCaja: CUENTA_CAJA_REPARTOS });
    // Etapa 2: lo que ya se rindió en la app. null = falta la migración 056 (la pantalla sigue en sólo lectura).
    const { data: enApp, error: errApp } = await sb().from('rendiciones')
      .select('hoja_id, efectivo, gastos, efectivo_contado, diferencia, contado_at, controlado_at')
      .eq('tenant_id', TENANT_ID).in('hoja_id', hojas.map(h => String(h.id)));
    if (errApp && !['42P01', 'PGRST205'].includes(String(errApp.code))) console.warn(`[rendiciones] rendiciones de la app: ${errApp.message}`);
    res.json({ ok: true, desde, hasta, ...r, rendiciones_app: errApp ? null : (enApp ?? []), consultado: { im_recibos: true, im_mayor: mayorOk } });
  } catch (err) {
    const e = err as { message?: string; status?: number };
    console.error('[rendiciones]', e?.message);
    res.status(Number.isInteger(e?.status) ? Number(e.status) : 500).json({ error: e?.message ?? 'error' });
  }
}
