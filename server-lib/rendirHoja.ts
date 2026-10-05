/**
 * RENDIR EL EFECTIVO DE LA HOJA EN LA APP — etapa 2 (diseño aprobado por Mati el 04/10/2026).
 *
 *   GET  /api/rendiciones/hoja/:id            → la rendición guardada, los recibos que ya emitió la app y si se puede emitir.
 *   PUT  /api/rendiciones/hoja/:id            → guarda lo cobrado por cliente, los gastos del viaje y lo contado.
 *   POST /api/rendiciones/hoja/:id/controlar  → otra persona controla lo contado (lo cuenta Anto, lo controla Maca).
 *   POST /api/rendiciones/hoja/:id/emitir     → { accion: 'plan' } vista previa · { accion: 'emitir' } emite.
 *   GET  /api/rendiciones/saldos?mes=AAAA-MM  → el saldo del mes por repartidor.
 *
 * 🔑 La emisión no tiene lógica de plata propia: cada recibo pasa por el mismo `aprobarRecibo` de
 * Cobranzas (pre-chequeo contra IM, ajuste de centavos, usuario de quien aprueba), con Caja Repartos
 * fijada por el servidor. Qué entra y cómo se imputa vive en `rendicionEfectivo.ts` (puro, con tests).
 *
 * 🔴 Mati: nada se escribe en IM sin su sí ⇒ `RENDICION_TOPE` arranca en 0: sólo vista previa.
 * 🪤 Sin la migración 056 no hay dónde guardar: todo contesta `falta_migracion` y la pantalla queda
 * en sólo lectura, como en la etapa 1.
 */
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import type { JwtPayload } from './auth.js';
import { puedeArmarHojasDeRuta, puedeRevisarRecibos } from './permisos.js';
import { fetchComprobPendientes, fetchClientesIMCached } from './infomanager.js';
import { getV2, imV2Configurada } from './imApiV2.js';
import { aprobarRecibo, CAJA_DEL_SERVIDOR } from './recibos.js';
import {
    normalizarBorrador, cuentasDeLaRendicion, planDeEmision, saldosPorRepartidor,
    type Borrador, type LineaEfectivo, type GastoViaje, type ReciboDeLaHoja, type PasoEmision,
} from './rendicionEfectivo.js';
import { VENTANA_IM, VENTANA_APP, type ReciboAppLite, type ReciboIMLite } from './duplicadosRecibo.js';
import type { FacturaParaImputar } from '../src/utils/aprobacionRecibos.js';

/** Caja Repartos en el plan de cuentas de IM (empresa 1). La misma que lee la etapa 1. */
const CUENTA_CAJA_REPARTOS = process.env.IM_CUENTA_CAJA_REPARTOS || '1110009';
/** El reparto es de Casa Central. */
const EMPRESA = 1;
/** Recibos por tanda. 0 = emisión apagada (sólo vista previa) hasta el sí de Mati al piloto. */
const tope = () => Math.max(0, Number(process.env.RENDICION_TOPE ?? 0) || 0);

const SIN_MIGRACION = new Set(['42P01', 'PGRST205', '42703', 'PGRST204']);
const MSJ_SIN_MIGRACION = 'Falta aplicar la migración 056 (rendición del efectivo) en la base: la rendición sigue en sólo lectura.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e));

class NoSePuede extends Error {
    constructor(texto: string, public status = 409, public faltaMigracion = false) { super(texto); }
}
/** El resultado de Supabase, o el error con un mensaje claro (y `falta_migracion` si no está la 056). */
function revisar<T>(r: { data: unknown; error: { code?: string; message: string } | null }, que: string): T | null {
    if (r.error) {
        if (SIN_MIGRACION.has(String(r.error.code ?? ''))) throw new NoSePuede(MSJ_SIN_MIGRACION, 503, true);
        throw new NoSePuede(`${que}: ${r.error.message}`, 502);
    }
    return r.data as T | null;
}
function fallar(res: Response, e: unknown, donde: string) {
    if (e instanceof NoSePuede) { res.status(e.status).json({ error: e.message, ...(e.faltaMigracion ? { falta_migracion: true } : {}) }); return; }
    console.error(`[rendir] ${donde}:`, mensaje(e));
    res.status(500).json({ error: mensaje(e) });
}

const sumarDias = (iso: string, n: number) =>
    new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) + n * 86_400_000).toISOString().slice(0, 10);

interface FilaHoja {
    id: string; numero: number; fecha: string; estado: string;
    choferes?: { nombre?: string | null } | null;
    hojas_ruta_pedidos?: Array<{ cod_cliente: number | string; cliente_nombre?: string | null }>;
}
interface FilaRendicion {
    id: string; hoja_id: string; efectivo: LineaEfectivo[] | null; gastos: GastoViaje[] | null;
    efectivo_contado: number | string | null; diferencia: number | string | null; observaciones: string | null;
    contado_por: string | null; contado_at: string | null; controlado_por: string | null; controlado_at: string | null;
    version: number;
}

async function leerHoja(id: string): Promise<FilaHoja> {
    if (!UUID.test(id)) throw new NoSePuede('Hoja inválida.', 400);
    const hoja = revisar<FilaHoja>(await sb().from('hojas_ruta')
        .select('id, numero, fecha, estado, choferes(nombre), hojas_ruta_pedidos(cod_cliente, cliente_nombre)')
        .eq('tenant_id', TENANT_ID).eq('id', id).maybeSingle(), 'No pude leer la hoja');
    if (!hoja) throw new NoSePuede('No existe esa hoja de ruta.', 404);
    return { ...hoja, numero: Number(hoja.numero), fecha: String(hoja.fecha).slice(0, 10) };
}
async function leerRendicion(hojaId: string): Promise<FilaRendicion | null> {
    return revisar<FilaRendicion>(await sb().from('rendiciones').select('*')
        .eq('tenant_id', TENANT_ID).eq('hoja_id', hojaId).maybeSingle(), 'No pude leer la rendición');
}
async function recibosDeLaHoja(hojaId: string): Promise<ReciboDeLaHoja[]> {
    const filas = revisar<ReciboDeLaHoja[]>(await sb().from('comprobantes_pago')
        .select('id, cod_cliente, monto, status, infomanager_recibo_id, error_msg')
        .eq('tenant_id', TENANT_ID).eq('hoja_id', hojaId).eq('medio_pago', 'efectivo'), 'No pude leer los recibos de la hoja');
    return (filas ?? []).map(f => ({ ...f, cod_cliente: Number(f.cod_cliente), monto: Number(f.monto) }));
}
const aBorrador = (r: FilaRendicion): Borrador => ({
    efectivo: (r.efectivo ?? []).map(l => ({ cod_cliente: Number(l.cod_cliente), importe: Number(l.importe) })),
    gastos: (r.gastos ?? []).map(g => ({ concepto: g.concepto, importe: Number(g.importe), detalle: g.detalle ?? null })),
    efectivo_contado: r.efectivo_contado == null ? null : Number(r.efectivo_contado),
    observaciones: r.observaciones ?? null,
});

/** Lo que ve la pantalla: la hoja, la rendición con sus cuentas, los recibos ya emitidos y si se puede emitir. */
async function respuesta(user: JwtPayload, hoja: FilaHoja, rend: FilaRendicion | null, recibos: ReciboDeLaHoja[]) {
    const ids = [rend?.contado_por, rend?.controlado_por].filter((x): x is string => !!x);
    const nombres = new Map<string, string>();
    if (ids.length) {
        const { data } = await sb().from('usuarios').select('id, nombre').in('id', ids);
        for (const u of (data ?? []) as Array<{ id: string; nombre: string | null }>) nombres.set(String(u.id), u.nombre ?? 'otra persona');
    }
    const b = rend ? aBorrador(rend) : null;
    return {
        ok: true,
        hoja: { id: hoja.id, numero: hoja.numero, fecha: hoja.fecha, estado: hoja.estado, chofer: hoja.choferes?.nombre ?? null },
        rendicion: rend && b ? {
            ...b,
            version: rend.version,
            contado_por: rend.contado_por ? (nombres.get(rend.contado_por) ?? 'otra persona') : null,
            contado_at: rend.contado_at,
            controlado_por: rend.controlado_por ? (nombres.get(rend.controlado_por) ?? 'otra persona') : null,
            controlado_at: rend.controlado_at,
            /** Quien contó no se controla a sí mismo. */
            lo_conto_quien_pregunta: rend.contado_por === user.sub,
            cuentas: cuentasDeLaRendicion(b),
        } : null,
        recibos,
        emision: { tope: tope(), cuenta: CUENTA_CAJA_REPARTOS },
    };
}

export async function rendicionDeHoja(req: Request & { user?: JwtPayload }, res: Response) {
    const user = req.user;
    if (!user || !puedeArmarHojasDeRuta(String(user.rol))) { res.status(403).json({ error: 'Esto lo ve administración.' }); return; }
    try {
        const hoja = await leerHoja(String(req.params.id));
        const rend = await leerRendicion(hoja.id);
        res.json(await respuesta(user, hoja, rend, await recibosDeLaHoja(hoja.id)));
    } catch (e) {
        // Sin la 056 la pantalla no se rompe: avisa y sigue en sólo lectura.
        if (e instanceof NoSePuede && e.faltaMigracion) { res.json({ ok: true, falta_migracion: true, mensaje: e.message }); return; }
        fallar(res, e, 'leer');
    }
}

export async function guardarRendicion(req: Request & { user?: JwtPayload }, res: Response) {
    const user = req.user;
    if (!user || !puedeRevisarRecibos(String(user.rol))) { res.status(403).json({ error: 'Requiere admin, gerente o administrativo' }); return; }
    try {
        const hoja = await leerHoja(String(req.params.id));
        if (hoja.estado === 'anulada') throw new NoSePuede('La hoja está anulada.');
        const clientes = [...new Set((hoja.hojas_ruta_pedidos ?? []).map(p => Number(p.cod_cliente)))];
        const n = normalizarBorrador(req.body, clientes);
        if (!n.ok) throw new NoSePuede(n.error, 400);
        const b = n.borrador;

        // 🔴 Lo que ya se emitió en IM no se cambia desde acá: la app no edita recibos de IM.
        for (const r of await recibosDeLaHoja(hoja.id)) {
            if (r.status !== 'imputado') continue;
            const linea = b.efectivo.find(l => l.cod_cliente === r.cod_cliente);
            if (!linea || Math.abs(linea.importe - r.monto) >= 0.01) {
                throw new NoSePuede(`El recibo ${r.infomanager_recibo_id ?? ''} del cliente ${r.cod_cliente} ya se emitió en IM por $${r.monto.toFixed(2)}: no se cambia desde la rendición. Si está mal, corregilo en IM.`);
            }
        }

        const actual = await leerRendicion(hoja.id);
        const antes = actual ? aBorrador(actual) : null;
        const cambioContado = (antes?.efectivo_contado ?? null) !== b.efectivo_contado;
        const cambioCuenta = !antes || cambioContado
            || JSON.stringify(antes.efectivo) !== JSON.stringify(b.efectivo) || JSON.stringify(antes.gastos) !== JSON.stringify(b.gastos);
        const fila: Record<string, unknown> = {
            efectivo: b.efectivo, gastos: b.gastos, efectivo_contado: b.efectivo_contado, observaciones: b.observaciones,
            diferencia: cuentasDeLaRendicion(b).diferencia, updated_by: user.sub,
        };
        if (cambioContado) Object.assign(fila, { contado_por: b.efectivo_contado == null ? null : user.sub, contado_at: b.efectivo_contado == null ? null : new Date().toISOString() });
        // Lo que se controló es ESTA cuenta: si cambia lo cobrado, los gastos o lo contado, se vuelve a controlar.
        if (cambioCuenta && actual?.controlado_por) Object.assign(fila, { controlado_por: null, controlado_at: null });

        let guardada: FilaRendicion | null;
        const conflicto = 'Otra persona cambió esta rendición: recargá para ver lo último. No se guardó nada.';
        if (!actual) {
            const r = await sb().from('rendiciones').insert({ tenant_id: TENANT_ID, hoja_id: hoja.id, version: 1, ...fila }).select().single();
            if (r.error?.code === '23505') throw new NoSePuede(conflicto);
            guardada = revisar<FilaRendicion>(r, 'No pude guardar la rendición');
        } else {
            if (Number(req.body?.version) !== actual.version) throw new NoSePuede(conflicto);
            const filas = revisar<FilaRendicion[]>(await sb().from('rendiciones').update({ ...fila, version: actual.version + 1 })
                .eq('id', actual.id).eq('version', actual.version).select(), 'No pude guardar la rendición');
            if (!filas?.length) throw new NoSePuede(conflicto);
            guardada = filas[0];
        }
        res.json(await respuesta(user, hoja, guardada, await recibosDeLaHoja(hoja.id)));
    } catch (e) { fallar(res, e, 'guardar'); }
}

export async function controlarRendicion(req: Request & { user?: JwtPayload }, res: Response) {
    const user = req.user;
    if (!user || !puedeRevisarRecibos(String(user.rol))) { res.status(403).json({ error: 'Requiere admin, gerente o administrativo' }); return; }
    try {
        const hoja = await leerHoja(String(req.params.id));
        const actual = await leerRendicion(hoja.id);
        if (!actual || actual.efectivo_contado == null) throw new NoSePuede('Primero hay que contar el efectivo.');
        if (actual.contado_por === user.sub) throw new NoSePuede('Lo controla otra persona, no quien lo contó (decisión de Mati: lo cuenta Anto y lo controla Maca).');
        const conflicto = 'Otra persona cambió esta rendición: recargá antes de controlar.';
        if (Number(req.body?.version) !== actual.version) throw new NoSePuede(conflicto);
        const filas = revisar<FilaRendicion[]>(await sb().from('rendiciones')
            .update({ controlado_por: user.sub, controlado_at: new Date().toISOString(), version: actual.version + 1 })
            .eq('id', actual.id).eq('version', actual.version).select(), 'No pude guardar el control');
        if (!filas?.length) throw new NoSePuede(conflicto);
        res.json(await respuesta(user, hoja, filas[0], await recibosDeLaHoja(hoja.id)));
    } catch (e) { fallar(res, e, 'controlar'); }
}

/** Igual que la carga del repartidor (recibos.ts): el vendedor del cliente, para que el cobro también le aparezca a él. */
async function codVendedorDe(cod: number): Promise<number> {
    try {
        const hit = (await fetchClientesIMCached()).find(c => Number(c.cod_cliente) === cod);
        if (hit?.cod_vendedor != null) return Number(hit.cod_vendedor);
    } catch (e) { console.warn(`[rendir] IM clientes: ${mensaje(e)}`); }
    const { data } = await sb().from('client_operational').select('cod_vendedor').eq('tenant_id', TENANT_ID).eq('cod_cliente', cod).maybeSingle();
    return Number((data as { cod_vendedor?: number } | null)?.cod_vendedor ?? 0) || 0;
}

/** Qué se emite: con datos frescos de IM y de la app, cada vez (también al emitir: el plan visto puede tener minutos). */
async function planDeLaHoja(hoja: FilaHoja, efectivo: LineaEfectivo[], existentes: ReciboDeLaHoja[], topeTanda: number): Promise<{ plan: PasoEmision[]; imConsultado: boolean }> {
    const cods = [...new Set(efectivo.map(l => l.cod_cliente))];
    if (!cods.length) return { plan: [], imConsultado: true };

    // ¿Ya figura en IM? Una sola consulta para la ventana de la hoja.
    let enIM: ReciboIMLite[] | null = null;
    if (imV2Configurada()) {
        try {
            const d = await getV2<{ results?: ReciboIMLite[] }>('/api/v2/recibos', {
                fecha_desde: sumarDias(hoja.fecha, -VENTANA_IM.antes), fecha_hasta: sumarDias(hoja.fecha, VENTANA_IM.despues), empresas: String(EMPRESA), limit: 5000,
            });
            enIM = (d?.results ?? []).filter(r => cods.includes(Number(r.cliente?.codigo)));
        } catch (e) { console.warn(`[rendir] IM no devolvió los recibos: ${mensaje(e)}`); }
    }
    // Otros cobros cargados en la app para esos clientes (no los de esta hoja).
    const propios = new Set(existentes.map(r => r.id));
    const { data: deApp } = await sb().from('comprobantes_pago')
        .select('id, cod_cliente, monto, fecha_comprobante, created_at, status, infomanager_recibo_id')
        .eq('tenant_id', TENANT_ID).in('cod_cliente', cods)
        .gte('created_at', `${sumarDias(hoja.fecha, -(VENTANA_APP + 3))}T00:00:00Z`)
        .lte('created_at', `${sumarDias(hoja.fecha, VENTANA_APP + 10)}T23:59:59Z`);
    const enApp = ((deApp ?? []) as ReciboAppLite[])
        .filter(r => !propios.has(String(r.id)))
        .map(r => ({ ...r, cod_cliente: Number(r.cod_cliente), monto: Number(r.monto) }));

    // Facturas pendientes por cliente, en serie (no en ráfaga). Lo ya emitido no se consulta.
    const pendientes = new Map<number, FacturaParaImputar[] | null>();
    for (const cod of cods.filter(c => !existentes.some(r => r.cod_cliente === c && r.status === 'imputado'))) {
        try { pendientes.set(cod, await fetchComprobPendientes(EMPRESA, cod)); } catch { pendientes.set(cod, null); }
    }
    const plan = planDeEmision({
        hoja: { numero: hoja.numero, fecha: hoja.fecha }, efectivo, existentes, enIM, enApp,
        pendientesDe: c => pendientes.get(c) ?? null, cuentaCaja: CUENTA_CAJA_REPARTOS, tope: topeTanda,
    });
    return { plan, imConsultado: enIM != null };
}

/** Un recibo: registrar el cobro (con el reclamo en base) y emitirlo con el motor de Cobranzas. */
async function emitirUno(user: JwtPayload, hoja: FilaHoja, paso: PasoEmision): Promise<{ cod_cliente: number; ok: boolean; recibo_id?: string | null; error?: string }> {
    const base = { cod_cliente: paso.cod_cliente };
    // Queda en 'error' mientras se emite, no en 'pendiente_revision': así no aparece en la cola de
    // Cobranzas de Anto (ni se aprueba ahí a otra caja) si algo corta a mitad de camino.
    const enCurso = `Emitiendo desde la rendición de la hoja ${hoja.numero}…`;
    let id = paso.recibo_app_id ?? null;
    if (id) {
        const r = await sb().from('comprobantes_pago').update({ monto: paso.importe, fecha_comprobante: hoja.fecha, status: 'error', error_msg: enCurso })
            .eq('id', id).neq('status', 'imputado').select('id');
        if (r.error || !r.data?.length) return { ...base, ok: false, error: 'Ese recibo cambió mientras tanto: recargá la rendición.' };
    } else {
        // 🔑 Reclamo en base: índice único (hoja, cliente) de la migración 056. Si otra persona está
        // emitiendo la misma hoja, el segundo choca acá y no llega a IM.
        id = randomUUID();
        const r = await sb().from('comprobantes_pago').insert({
            id, tenant_id: TENANT_ID, hoja_id: hoja.id, cod_cliente: paso.cod_cliente, cod_vendedor: await codVendedorDe(paso.cod_cliente),
            monto: paso.importe, fecha_comprobante: hoja.fecha, medio_pago: 'efectivo', mp_status: 'skipped',
            observaciones: `Rendición hoja ${hoja.numero}`, foto_url: null,
            status: 'error', error_msg: enCurso, created_by: user.sub, created_at: new Date().toISOString(),
        });
        if (r.error) return { ...base, ok: false, error: r.error.code === '23505' ? 'Otra persona está emitiendo este recibo: recargá la rendición.' : `No pude registrar el cobro: ${r.error.message}` };
    }

    // El mismo aprobarRecibo de Cobranzas, con Caja Repartos fijada por el servidor.
    const r: { statusCode: number; body: { ok?: boolean; recibo_id?: string | null; error?: string } | null } = { statusCode: 200, body: null };
    const resInterno = { status(c: number) { r.statusCode = c; return this; }, json(b: typeof r.body) { r.body = b; return this; } } as unknown as Response;
    const reqInterno = {
        params: { id }, user,
        body: { monto: paso.importe, fecha: hoja.fecha, medio_pago: 'efectivo', cod_empresa: EMPRESA, comprobantes: paso.comprobantes, observaciones: `Rendición hoja ${hoja.numero}` },
        [CAJA_DEL_SERVIDOR]: CUENTA_CAJA_REPARTOS,
    } as unknown as Request & { user?: JwtPayload };
    await aprobarRecibo(reqInterno, resInterno);
    if (r.statusCode === 200 && r.body?.ok === true) return { ...base, ok: true, recibo_id: r.body.recibo_id ?? null };

    const error = r.body?.error ?? `HTTP ${r.statusCode}`;
    // Si IM rechazó, aprobarRecibo ya dejó su motivo; si cortó antes (validación, pre-chequeo), se anota acá.
    await sb().from('comprobantes_pago').update({ status: 'error', error_msg: `Rendición hoja ${hoja.numero}: ${error}` }).eq('id', id).eq('error_msg', enCurso);
    return { ...base, ok: false, error };
}

export async function emitirRendicion(req: Request & { user?: JwtPayload }, res: Response) {
    const user = req.user;
    if (!user || !puedeRevisarRecibos(String(user.rol))) { res.status(403).json({ error: 'Requiere admin, gerente o administrativo' }); return; }
    const accion = req.body?.accion;
    if (accion !== 'plan' && accion !== 'emitir') { res.status(400).json({ error: 'accion tiene que ser "plan" o "emitir"' }); return; }
    try {
        const hoja = await leerHoja(String(req.params.id));
        if (hoja.estado === 'anulada') throw new NoSePuede('La hoja está anulada.');
        const rend = await leerRendicion(hoja.id);
        if (!rend) throw new NoSePuede('Primero guardá lo cobrado por cliente.');
        if (accion === 'emitir' && tope() === 0) {
            throw new NoSePuede('La emisión desde la app todavía no está activada: falta el sí de Mati para el piloto. No se emitió nada.', 403);
        }
        const existentes = await recibosDeLaHoja(hoja.id);
        const efectivo = aBorrador(rend).efectivo;
        // La vista previa muestra la imputación de todos aunque la emisión esté apagada.
        const { plan, imConsultado } = await planDeLaHoja(hoja, efectivo, existentes, accion === 'plan' ? Math.max(tope(), efectivo.length) : tope());
        if (accion === 'plan') { res.json({ ok: true, plan, tope: tope(), fecha: hoja.fecha, cuenta: CUENTA_CAJA_REPARTOS, consultado: { im: imConsultado } }); return; }

        // Emitir: uno por uno, y se frena en el primer problema (mismo criterio que el lote de Cobranzas).
        const resultados: Array<{ cod_cliente: number; ok: boolean; recibo_id?: string | null; error?: string }> = [];
        let frenado = false;
        for (const paso of plan.filter(p => p.estado === 'listo')) {
            const r = await emitirUno(user, hoja, paso);
            resultados.push(r);
            if (!r.ok) { frenado = true; break; }
        }
        console.log(`[rendir] hoja ${hoja.numero}: ${user.sub} emitió ${resultados.filter(x => x.ok).length} de ${resultados.length}${frenado ? ' (frenado)' : ''}`);
        res.json({ ok: true, plan, resultados, frenado, tope: tope() });
    } catch (e) { fallar(res, e, 'emitir'); }
}

export async function saldosDelMes(req: Request & { user?: JwtPayload }, res: Response) {
    const user = req.user;
    if (!user || !puedeArmarHojasDeRuta(String(user.rol))) { res.status(403).json({ error: 'Esto lo ve administración.' }); return; }
    const mes = String(req.query?.mes ?? '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) { res.status(400).json({ error: 'Mandá el mes como AAAA-MM.' }); return; }
    try {
        const desde = `${mes}-01`;
        const hasta = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)).toISOString().slice(0, 10);
        const hojas = revisar<FilaHoja[]>(await sb().from('hojas_ruta').select('id, numero, fecha, estado, choferes(nombre)')
            .eq('tenant_id', TENANT_ID).gte('fecha', desde).lte('fecha', hasta).neq('estado', 'anulada'), 'No pude leer las hojas') ?? [];
        if (!hojas.length) { res.json({ ok: true, mes, saldos: [], hojas: [] }); return; }
        const rends = revisar<Array<{ hoja_id: string; diferencia: number | string | null; controlado_at: string | null }>>(await sb().from('rendiciones')
            .select('hoja_id, diferencia, controlado_at').eq('tenant_id', TENANT_ID).in('hoja_id', hojas.map(h => h.id)), 'No pude leer las rendiciones') ?? [];
        const porId = new Map(hojas.map(h => [h.id, h]));
        const rs = rends.filter(r => porId.has(r.hoja_id)).map(r => {
            const h = porId.get(r.hoja_id) as FilaHoja;
            return { hoja_numero: Number(h.numero), fecha: String(h.fecha).slice(0, 10), chofer: h.choferes?.nombre ?? null, diferencia: r.diferencia == null ? null : Number(r.diferencia), controlada: !!r.controlado_at };
        }).sort((a, b) => a.hoja_numero - b.hoja_numero);
        res.json({ ok: true, mes, saldos: saldosPorRepartidor(rs), hojas: rs });
    } catch (e) {
        if (e instanceof NoSePuede && e.faltaMigracion) { res.json({ ok: true, falta_migracion: true, mensaje: e.message, mes, saldos: [], hojas: [] }); return; }
        fallar(res, e, 'saldos');
    }
}
