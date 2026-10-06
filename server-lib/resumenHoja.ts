/**
 * El resumen de UNA hoja (lógica pura, con tests). Lo sirve GET /api/rendiciones/hoja/:id/resumen (`resumenDeHoja`, en
 * rendiciones.ts), sólo lectura.
 *
 * Mati (06/10/2026), puntos 3 y 4 después del piloto de la 3449:
 *  · imprimir la hoja de ruta CON los recibos que impactan (qué recibo, a qué factura, efectivo o transferencia);
 *  · al cerrar la hoja, ver TODA la info: entregado, cobrado por medio, recibos emitidos, facturas imputadas, gastos,
 *    contado, diferencia, quién contó y quién controló.
 *
 * 🔑 La cuenta por cliente es la MISMA de Rendiciones (`calcularRendiciones`, con todas las hojas del día: un cliente
 * compartido o una hoja con la fecha corrida se cuentan igual que allá). Acá se le suma, por recibo, a qué facturas
 * fue —lo que devolvió IM cuando la app lo emitió— y lo que se rindió en la app.
 * 🪤 De un recibo cargado a mano en IM no se sabe a qué facturas fue: la API de IM no lo da. Sale con su número y sin
 * el detalle, y la pantalla lo dice.
 */
import type { HojaRendicion, EstadoCobro, GastoHoja } from './rendicionHoja.js';
import { cuentasDeLaRendicion, type LineaEfectivo, type GastoViaje } from '../src/utils/rendicionCuentas.js';

export interface ReciboAppIn {
    id: string;
    infomanager_recibo_id: string | null;
    status: string;
    medio_pago: string | null;
    infomanager_response: {
        recibo?: { numero?: number | string | null; comprobantes?: Array<{ numero?: number | string | null; punto_de_venta?: number | string | null; importe_pagado?: number | string | null }> };
    } | null;
}
export interface RendicionAppIn {
    efectivo: LineaEfectivo[] | null; gastos: GastoViaje[] | null; efectivo_contado: number | string | null;
    contado_por: string | null; contado_at: string | null; controlado_por: string | null; controlado_at: string | null;
}
export interface ReciboResumen {
    /** 'efectivo' o el medio de la transferencia ('mercadopago', 'recaudadora_1', …). */
    medio: string;
    /** Número del recibo en IM; null si la transferencia todavía no se aprobó. */
    numero: string | null;
    fecha: string;
    importe: number;
    /** app = emitido por la app (con facturas) · im = cargado a mano en IM (sin detalle) · pendiente = sin aprobar · otro. */
    origen: 'app' | 'im' | 'pendiente' | 'otro';
    /** A qué facturas fue y cuánto a cada una; null si no se sabe. */
    facturas: Array<{ numero: string; importe: number }> | null;
}
export interface ResumenHoja {
    hoja: { id: string; numero: number; fecha: string; estado: string; chofer: string | null; nombre: string | null };
    clientes: Array<{
        cod_cliente: number; cliente: string; entregado: number; saldo_anterior: number; cobrado: number; queda: number;
        estado: EstadoCobro; no_salieron: number; recibos: ReciboResumen[];
    }>;
    totales: { entregado: number; cobrado: number; queda: number; por_medio: Record<string, number>; recibos: number; sin_detalle: number; pendientes: number };
    /** Lo rendido en la app; null si la hoja no se rindió en la app (se rindió a mano en IM). */
    rendicion: null | {
        gastos: GastoViaje[]; efectivo: number; total_gastos: number; debe_entregar: number; contado: number | null; diferencia: number | null;
        contado_por: string | null; contado_at: string | null; controlado_por: string | null; controlado_at: string | null;
    };
    /** Las órdenes de pago "según HR" de IM y el asiento de la rendición, si ya existen. */
    gastos_im: GastoHoja[];
    asiento_id: string | null;
}

const centavos = (n: number) => Math.round(n * 100) / 100;
/** "0000-30156395" → "30156395". */
const numeroRC = (n: unknown) => (n == null || n === '' ? null : String(n).split('-').pop() ?? null);
const etiquetaFactura = (pv: unknown, nro: unknown) => (Number(pv) > 0 ? `${Number(pv)}-${Number(nro)}` : String(Number(nro)));
const facturasDe = (r: ReciboAppIn | undefined) => {
    const cs = r?.infomanager_response?.recibo?.comprobantes;
    return Array.isArray(cs) && cs.length ? cs.map(c => ({ numero: etiquetaFactura(c.punto_de_venta, c.numero), importe: Number(c.importe_pagado) || 0 })) : null;
};

export function armarResumenHoja(e: { hoja: HojaRendicion; recibosApp: ReciboAppIn[]; rendicion: RendicionAppIn | null; nombres: Map<string, string> }): ResumenHoja {
    const porIdIM = new Map(e.recibosApp.filter(r => r.infomanager_recibo_id).map(r => [String(r.infomanager_recibo_id), r]));
    const porId = new Map(e.recibosApp.map(r => [r.id, r]));

    const clientes = e.hoja.filas.map(f => {
        const efectivo: ReciboResumen[] = f.recibos_efectivo.map(x => {
            const app = porIdIM.get(String(x.id_recibo));
            return { medio: 'efectivo', numero: numeroRC(x.numero), fecha: x.fecha, importe: x.importe, origen: app ? 'app' : 'im', facturas: facturasDe(app) };
        });
        const transferencias: ReciboResumen[] = f.transferencias.map(t => {
            const app = porId.get(t.id);
            const emitida = t.status === 'imputado';
            return {
                medio: t.medio ?? 'transferencia', numero: emitida ? numeroRC(app?.infomanager_response?.recibo?.numero) : null, fecha: t.fecha, importe: t.monto,
                origen: emitida ? 'app' : t.status === 'pendiente_revision' ? 'pendiente' : 'otro', facturas: emitida ? facturasDe(app) : null,
            };
        });
        return {
            cod_cliente: f.cod_cliente, cliente: f.cliente, entregado: f.entregado, saldo_anterior: f.saldo_anterior, cobrado: f.cobrado, queda: f.queda,
            estado: f.estado, no_salieron: f.no_salieron, recibos: [...efectivo, ...transferencias],
        };
    });

    const recibos = clientes.flatMap(c => c.recibos);
    const porMedio: Record<string, number> = {};
    for (const r of recibos) porMedio[r.medio] = centavos((porMedio[r.medio] ?? 0) + r.importe);

    let rendicion: ResumenHoja['rendicion'] = null;
    if (e.rendicion) {
        const gastos = (e.rendicion.gastos ?? []).map(g => ({ concepto: g.concepto, importe: Number(g.importe), detalle: g.detalle ?? null }));
        const c = cuentasDeLaRendicion({
            efectivo: (e.rendicion.efectivo ?? []).map(l => ({ cod_cliente: Number(l.cod_cliente), importe: Number(l.importe) })),
            gastos, efectivo_contado: e.rendicion.efectivo_contado == null ? null : Number(e.rendicion.efectivo_contado),
        });
        const nombre = (id: string | null) => (id ? e.nombres.get(id) ?? 'otra persona' : null);
        rendicion = {
            gastos, efectivo: c.efectivo, total_gastos: c.gastos, debe_entregar: c.debe_entregar, contado: c.contado, diferencia: c.diferencia,
            contado_por: nombre(e.rendicion.contado_por), contado_at: e.rendicion.contado_at,
            controlado_por: nombre(e.rendicion.controlado_por), controlado_at: e.rendicion.controlado_at,
        };
    }

    const h = e.hoja;
    return {
        hoja: { id: h.id, numero: h.numero, fecha: h.fecha, estado: h.estado, chofer: h.chofer, nombre: h.nombre },
        clientes,
        totales: {
            entregado: centavos(clientes.reduce((s, c) => s + c.entregado, 0)),
            cobrado: centavos(clientes.reduce((s, c) => s + c.cobrado, 0)),
            queda: centavos(clientes.reduce((s, c) => s + c.queda, 0)),
            por_medio: porMedio,
            recibos: recibos.filter(r => r.numero).length,
            sin_detalle: recibos.filter(r => r.origen === 'im').length,
            pendientes: recibos.filter(r => r.origen === 'pendiente').length,
        },
        rendicion,
        gastos_im: h.gastos,
        asiento_id: h.asiento_id,
    };
}
