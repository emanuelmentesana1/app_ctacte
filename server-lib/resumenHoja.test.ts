import { describe, it, expect } from 'vitest';
import { armarResumenHoja, type ReciboAppIn } from './resumenHoja.js';
import type { HojaRendicion, FilaRendicion } from './rendicionHoja.js';

/**
 * El resumen de UNA hoja (Mati, 06/10/2026): imprimir la hoja CON los recibos que impactan (qué recibo, a qué factura,
 * efectivo o transferencia) y, al cerrarla, ver toda la info: entregado, cobrado por medio, recibos emitidos, facturas
 * imputadas, gastos, contado, diferencia, quién contó y quién controló.
 */

const fila = (p: Partial<FilaRendicion>): FilaRendicion => ({
    cod_cliente: 13, cliente: 'CLIENTE 13', llevo: 210_411.74, nc: 0, nd: 0, entregado: 210_411.74, saldo_anterior: 599_802.86,
    efectivo: 0, recibos_efectivo: [], transferencias: [], cobrado: 0, queda: 810_214.6, estado: 'sin_cobro', compartido: false, no_salieron: 0, ...p,
});
const hoja = (filas: FilaRendicion[], p: Partial<HojaRendicion> = {}): HojaRendicion => ({
    id: 'h3449', numero: 3449, fecha: '2026-10-05', estado: 'abierta', chofer: 'VICTOR', nombre: null, fecha_efectiva: '2026-10-05', fecha_corrida: false,
    filas, gastos: [], asiento_id: null,
    totales: { clientes: filas.length, llevo: 0, nc: 0, entregado: filas.reduce((s, f) => s + f.entregado, 0), efectivo: filas.reduce((s, f) => s + f.efectivo, 0),
        transferencias: 0, cobrado: filas.reduce((s, f) => s + f.cobrado, 0), gastos: 0, debe_entregar: 0, sin_cobro: 0, parcial: 0, de_mas: 0, no_salio: 0 },
    ...p,
});
const emitido = (id: string, idIM: string, numero: number, facturas: Array<[number, number, number]>, p: Partial<ReciboAppIn> = {}): ReciboAppIn => ({
    id, infomanager_recibo_id: idIM, status: 'imputado', medio_pago: 'efectivo',
    infomanager_response: { recibo: { numero, comprobantes: facturas.map(([pv, nro, imp]) => ({ punto_de_venta: pv, numero: nro, importe_pagado: imp })) } }, ...p,
});

describe('armarResumenHoja — los recibos de cada cliente', () => {
    it('🔑 el efectivo emitido desde la app sale con su número de recibo y a qué facturas fue', () => {
        const r = armarResumenHoja({
            hoja: hoja([fila({ efectivo: 192_800, cobrado: 192_800, estado: 'deuda_vieja', recibos_efectivo: [{ id_recibo: '59075304', numero: '0000-30156395', fecha: '2026-10-05', importe: 192_800 }] })]),
            recibosApp: [emitido('f6c98045', '59075304', 30156395, [[777, 50861, 150_000], [777, 50999, 42_800]])],
            rendicion: null, nombres: new Map(),
        });
        expect(r.clientes[0].recibos).toEqual([{
            medio: 'efectivo', numero: '30156395', fecha: '2026-10-05', importe: 192_800, origen: 'app',
            facturas: [{ numero: '777-50861', importe: 150_000 }, { numero: '777-50999', importe: 42_800 }],
        }]);
    });

    it('el efectivo cargado a mano en IM sale con su número, sin el detalle de facturas (la API de IM no lo da)', () => {
        const r = armarResumenHoja({
            hoja: hoja([fila({ efectivo: 50_000, cobrado: 50_000, recibos_efectivo: [{ id_recibo: '59000001', numero: '0000-30150001', fecha: '2026-10-05', importe: 50_000 }] })]),
            recibosApp: [], rendicion: null, nombres: new Map(),
        });
        expect(r.clientes[0].recibos).toEqual([{ medio: 'efectivo', numero: '30150001', fecha: '2026-10-05', importe: 50_000, origen: 'im', facturas: null }]);
        expect(r.totales.sin_detalle).toBe(1);
    });

    it('transferencias: la aprobada con su recibo y sus facturas; la pendiente sin número todavía', () => {
        const r = armarResumenHoja({
            hoja: hoja([fila({
                cod_cliente: 193, cobrado: 268_720, transferencias: [
                    { id: 't1', monto: 180_000, medio: 'mercadopago', status: 'imputado', fecha: '2026-10-05', quien: 'vendedor', nombre: 'Julio' },
                    { id: 't2', monto: 88_720, medio: 'recaudadora_1', status: 'pendiente_revision', fecha: '2026-10-06', quien: 'repartidor', nombre: 'Victor' },
                ],
            })]),
            recibosApp: [emitido('t1', '59075400', 30156410, [[777, 50800, 180_000]], { medio_pago: 'mercadopago' })],
            rendicion: null, nombres: new Map(),
        });
        expect(r.clientes[0].recibos).toEqual([
            { medio: 'mercadopago', numero: '30156410', fecha: '2026-10-05', importe: 180_000, origen: 'app', facturas: [{ numero: '777-50800', importe: 180_000 }] },
            { medio: 'recaudadora_1', numero: null, fecha: '2026-10-06', importe: 88_720, origen: 'pendiente', facturas: null },
        ]);
        expect(r.totales.pendientes).toBe(1);
    });

    it('los clientes quedan en el orden de la hoja y con su cuenta (entregado, saldo anterior, cobrado, queda, estado)', () => {
        const r = armarResumenHoja({
            hoja: hoja([fila({ cod_cliente: 1, cliente: 'ÁVILA' }), fila({ cod_cliente: 2, cliente: 'BUSTOS', estado: 'pago', cobrado: 100, queda: 0 })]),
            recibosApp: [], rendicion: null, nombres: new Map(),
        });
        expect(r.clientes.map(c => c.cliente)).toEqual(['ÁVILA', 'BUSTOS']);
        expect(r.clientes[1]).toMatchObject({ cod_cliente: 2, cobrado: 100, queda: 0, estado: 'pago', saldo_anterior: 599_802.86 });
    });
});

describe('armarResumenHoja — totales y rendición', () => {
    const conTodo = () => hoja([
        fila({ cod_cliente: 13, efectivo: 192_800, cobrado: 372_800, recibos_efectivo: [{ id_recibo: '59075304', numero: '0000-30156395', fecha: '2026-10-05', importe: 192_800 }],
            transferencias: [{ id: 't1', monto: 180_000, medio: 'mercadopago', status: 'imputado', fecha: '2026-10-05', quien: null, nombre: null }] }),
        fila({ cod_cliente: 94, efectivo: 103_359, cobrado: 103_359, recibos_efectivo: [{ id_recibo: '59075241', numero: '0000-30156391', fecha: '2026-10-05', importe: 103_359 }] }),
    ]);

    it('🔑 cobrado por medio de pago y recibos emitidos', () => {
        const r = armarResumenHoja({ hoja: conTodo(), recibosApp: [emitido('t1', '59075400', 30156410, [[777, 1, 180_000]], { medio_pago: 'mercadopago' })], rendicion: null, nombres: new Map() });
        expect(r.totales.por_medio).toEqual({ efectivo: 296_159, mercadopago: 180_000 });
        expect(r.totales.cobrado).toBe(476_159);
        expect(r.totales.recibos).toBe(3);
    });

    it('🔑 lo rendido en la app: gastos, lo que debía entregar, lo contado, la diferencia y quién contó y controló', () => {
        const r = armarResumenHoja({
            hoja: conTodo(), recibosApp: [],
            rendicion: {
                efectivo: [{ cod_cliente: 13, importe: 192_800 }, { cod_cliente: 94, importe: 103_359 }],
                gastos: [{ concepto: 'Ayudante', importe: 18_000, detalle: null }, { concepto: 'Combustible', importe: 30_000, detalle: 'YPF' }],
                efectivo_contado: 248_100, contado_por: 'u-anto', contado_at: '2026-10-06T12:46:15Z', controlado_por: null, controlado_at: null,
            },
            nombres: new Map([['u-anto', 'Anto']]),
        });
        expect(r.rendicion).toEqual({
            gastos: [{ concepto: 'Ayudante', importe: 18_000, detalle: null }, { concepto: 'Combustible', importe: 30_000, detalle: 'YPF' }],
            efectivo: 296_159, total_gastos: 48_000, debe_entregar: 248_159, contado: 248_100, diferencia: -59,
            contado_por: 'Anto', contado_at: '2026-10-06T12:46:15Z', controlado_por: null, controlado_at: null,
        });
    });

    it('sin rendición en la app (se rindió a mano en IM): quedan los gastos y el asiento de IM', () => {
        const r = armarResumenHoja({
            hoja: hoja([fila({})], { gastos: [{ id: 'op1', fecha: '2026-10-06', importe: 18_000, descripcion: 'según HR 3449 - Ayudante' }], asiento_id: '59080000' }),
            recibosApp: [], rendicion: null, nombres: new Map(),
        });
        expect(r.rendicion).toBeNull();
        expect(r.gastos_im).toEqual([{ id: 'op1', fecha: '2026-10-06', importe: 18_000, descripcion: 'según HR 3449 - Ayudante' }]);
        expect(r.asiento_id).toBe('59080000');
    });
});
