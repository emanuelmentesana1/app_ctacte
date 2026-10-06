import { describe, it, expect } from 'vitest';
import { armarRendiciones, type HojaIn, type ReciboIMIn, type MovMayorIn, type TransferenciaIn } from './rendicionHoja.js';

/**
 * Etapa 1 de la rendición (sólo lectura), aprobada por Mati el 04/10/2026.
 *
 * Cómo se rinde hoy (medido en IM, septiembre): el efectivo que cobra el chofer lo carga Anto al
 * día siguiente en Caja Repartos (1110009) con la fecha de la hoja; cada gasto del viaje es una
 * orden de pago "según HR nnnn"; un asiento por día ("3421,3422-AS") pasa la plata a Caja Casa
 * Central, y otro asiento chico cubre la diferencia de caja. La cuenta
 *   cobrado − gastos − entregado = diferencia
 * cerró en los 16 asientos de septiembre con hojas del panel.
 */

const CAJA = '1110009';
const pedido = (cod: number, total: number, p: Partial<HojaIn['pedidos'][number]> = {}) => ({
    im_comprobante_id: `re-${cod}-${total}`, cod_cliente: cod, cliente_nombre: `CLIENTE ${cod}`, total, saldo_anterior: 0, notas: [], ...p,
});
const hoja = (numero: number, fecha: string, pedidos: HojaIn['pedidos'], p: Partial<HojaIn> = {}): HojaIn => ({
    id: `h${numero}`, numero, fecha, estado: 'abierta', chofer: numero % 2 ? 'VICTOR' : 'NIÑO', nombre: null, pedidos, ...p,
});
const efectivo = (id: number, cod: number, fecha: string, importe: number, cuenta = CAJA): ReciboIMIn => ({
    id_recibo: id, numero: `0000-${30_150_000 + id}`, fecha, cliente: { codigo: String(cod) }, importe_total: importe,
    items: [{ tipo_pago: 'EFECTIVO', importe, cuenta_contable: cuenta }],
});
const transf = (id: string, cod: number, fecha: string, monto: number, p: Partial<TransferenciaIn> = {}): TransferenciaIn => ({
    id, cod_cliente: cod, monto, medio_pago: 'mercadopago', status: 'imputado', fecha_comprobante: fecha,
    created_at: `${fecha}T15:00:00Z`, created_by_rol: 'repartidor', created_by_nombre: 'Victor', ...p,
});
const mov = (id: number, fecha: string, tipo: 'RC' | 'OP' | 'AS', descripcion: string, debe: number, haber: number): MovMayorIn =>
    ({ id, fecha, tipo_comprobante: tipo, descripcion, debe, haber });

const base = (over: Partial<Parameters<typeof armarRendiciones>[0]> = {}) => armarRendiciones({
    hojas: [], recibosIM: [], mayor: [], transferencias: [], cuentaCaja: CAJA, ...over,
});

describe('armarRendiciones — por cliente', () => {
    it('🔑 los clientes salen en el orden de la hoja impresa: alfabético en castellano (Mati, 06/10/2026)', () => {
        // Cargados en otro orden, como llegan de la base. La hoja impresa (hojasRuta.ts) los ordena por nombre.
        const nombres = ['ZARATE Ana', 'ñandú SRL', 'ÁVILA Juan', 'NUÑEZ Luis', 'bustos Sebastián'];
        const r = base({ hojas: [hoja(3450, '2026-10-05', nombres.map((n, i) => pedido(200 + i, 1_000, { cliente_nombre: n })))] });
        expect(r.hojas[0].filas.map(f => f.cliente)).toEqual(['ÁVILA Juan', 'bustos Sebastián', 'NUÑEZ Luis', 'ñandú SRL', 'ZARATE Ana']);
    });

    it('🔑 el efectivo sale de Caja Repartos con la fecha de la hoja; lo de otras cuentas no es del reparto', () => {
        const r = base({
            hojas: [hoja(3423, '2026-09-21', [pedido(101, 400_000)])],
            recibosIM: [efectivo(1, 101, '2026-09-21', 400_000), efectivo(2, 101, '2026-09-21', 90_000, '1110004')],
        });
        const f = r.hojas[0].filas[0];
        expect(f.efectivo).toBe(400_000);
        expect(f.recibos_efectivo.map(x => x.id_recibo)).toEqual(['1']);
        expect(f.estado).toBe('pago');
    });

    it('transferencias de la app del día o del siguiente; las rechazadas y el efectivo del vendedor no cuentan', () => {
        const r = base({
            hojas: [hoja(3423, '2026-09-21', [pedido(101, 300_000)])],
            transferencias: [
                transf('t1', 101, '2026-09-22', 200_000),
                transf('t2', 101, '2026-09-21', 50_000, { status: 'rechazado' }),
                transf('t3', 101, '2026-09-21', 70_000, { medio_pago: 'efectivo', created_by_rol: 'vendedor' }),
                transf('t4', 101, '2026-09-24', 30_000),
            ],
        });
        const f = r.hojas[0].filas[0];
        expect(f.transferencias.map(t => t.id)).toEqual(['t1']);
        expect(f.cobrado).toBe(200_000);
        expect(f.queda).toBe(100_000);
        expect(f.estado).toBe('parcial');
    });

    it('las NC por lo que volvió bajan lo entregado', () => {
        const r = base({
            hojas: [hoja(3423, '2026-09-21', [pedido(101, 500_000, { notas: [{ tipo: 'NC', total: -100_000 }] })])],
            recibosIM: [efectivo(1, 101, '2026-09-21', 400_000)],
        });
        const f = r.hojas[0].filas[0];
        expect(f.nc).toBe(100_000);
        expect(f.entregado).toBe(400_000);
        expect(f.estado).toBe('pago');
    });

    /** 🔴 06/10/2026 — opción C: la factura complementaria por lo agregado sube lo entregado, como una ND. */
    it('una factura complementaria sube lo entregado, como una ND', () => {
        const r = base({
            hojas: [hoja(3423, '2026-09-21', [pedido(101, 500_000, { notas: [{ tipo: 'NC B', total: 56_755.28 }, { tipo: 'FA B', total: 47_364.72 }] })])],
            recibosIM: [efectivo(1, 101, '2026-09-21', 490_609.44)],
        });
        const f = r.hojas[0].filas[0];
        expect(f.nd).toBe(47_364.72);
        expect(f.entregado).toBe(490_609.44);
        expect(f.estado).toBe('pago');
    });

    it('🔄 06/10: el estado mira lo que el cliente debía (saldo anterior + entrega), no sólo la entrega', () => {
        // Antes: pagar 300.000 con una entrega de 100.000 decía "Pagó de más", aunque debía 250.000 de antes.
        const r = base({
            hojas: [hoja(3423, '2026-09-21', [pedido(101, 100_000, { saldo_anterior: 250_000 }), pedido(102, 80_000)])],
            recibosIM: [efectivo(1, 101, '2026-09-21', 300_000)],
        });
        const [a, b] = r.hojas[0].filas;
        expect(a.estado).toBe('parcial');
        expect(a.queda).toBe(50_000);
        expect(b.estado).toBe('sin_cobro');
        expect(r.hojas[0].totales.sin_cobro).toBe(1);
    });

    it('🔑 hoja 3449: pagó justo la deuda vieja, parte en efectivo y parte por transferencia', () => {
        const r = base({
            hojas: [hoja(3449, '2026-10-05', [pedido(13, 210_411.74, { saldo_anterior: 599_802.86 })])],
            recibosIM: [efectivo(1, 13, '2026-10-05', 192_800)],
            transferencias: [transf('t1', 13, '2026-10-05', 407_000, { created_by_rol: 'vendedor', created_by_nombre: 'Sebastián' })],
        });
        const f = r.hojas[0].filas[0];
        expect(f.cobrado).toBe(599_800);
        expect(f.estado).toBe('deuda_vieja');
        expect(f.queda).toBe(210_414.6);
        expect(r.hojas[0].totales.de_mas).toBe(0);
    });

    it('pagó la entrega y le queda la deuda vieja; pagó todo; pagó más de lo que debía', () => {
        const r = base({
            hojas: [hoja(3423, '2026-09-21', [
                pedido(101, 100_000, { saldo_anterior: 50_000 }),
                pedido(102, 100_000, { saldo_anterior: 50_000 }),
                pedido(103, 100_000, { saldo_anterior: 50_000 }),
            ])],
            recibosIM: [efectivo(1, 101, '2026-09-21', 100_000), efectivo(2, 102, '2026-09-21', 150_000), efectivo(3, 103, '2026-09-21', 180_000)],
        });
        expect(r.hojas[0].filas.map(f => f.estado)).toEqual(['entrega', 'pago', 'de_mas']);
        expect(r.hojas[0].filas.map(f => f.queda)).toEqual([50_000, 0, -30_000]);
    });

    it('🔑 lo que no salió (botón «No salió» de Repartos) no es entregado ni "sin cobro", igual que en la Liquidación', () => {
        const r = base({
            hojas: [hoja(3423, '2026-09-21', [
                pedido(101, 100_000, { no_salio: true, notas: [{ tipo: 'NC', total: -10_000 }] }),
                pedido(102, 80_000),
                pedido(103, 50_000, { no_salio: true }), pedido(103, 30_000, { im_comprobante_id: 'otro' }),
            ])],
            recibosIM: [efectivo(1, 103, '2026-09-21', 30_000)],
        });
        const [a, b, c] = r.hojas[0].filas;
        // Las notas de la entrega que no salió tampoco cuentan (la Liquidación las saca igual).
        expect(a).toMatchObject({ llevo: 0, nc: 0, entregado: 0, estado: 'no_salio', no_salieron: 1 });
        expect(b.estado).toBe('sin_cobro');
        expect(c).toMatchObject({ llevo: 30_000, entregado: 30_000, estado: 'pago', no_salieron: 1 });
        expect(r.hojas[0].totales).toMatchObject({ entregado: 110_000, sin_cobro: 1, no_salio: 1 });
    });

    it('si no salió pero el cliente igual pagó (deuda vieja), el cobro se ve', () => {
        const r = base({
            hojas: [hoja(3423, '2026-09-21', [pedido(101, 100_000, { no_salio: true })])],
            recibosIM: [efectivo(1, 101, '2026-09-21', 40_000)],
        });
        expect(r.hojas[0].filas[0]).toMatchObject({ entregado: 0, efectivo: 40_000, estado: 'de_mas' });
    });

    it('un cliente con dos remitos en la hoja es UNA fila (el papel agrupa por cliente)', () => {
        const r = base({ hojas: [hoja(3423, '2026-09-21', [pedido(101, 100_000), pedido(101, 50_000, { im_comprobante_id: 'otro' })])] });
        expect(r.hojas[0].filas).toHaveLength(1);
        expect(r.hojas[0].filas[0].llevo).toBe(150_000);
    });

    it('🪤 hoja con la fecha corrida: si su día no tiene recibos de sus clientes y el anterior tiene varios, se corre ENTERA', () => {
        // Pasó con la 3431: fechada el 25/09, sus 6 recibos están el 24/09 (y la 3402, al revés).
        const r = base({
            hojas: [hoja(3431, '2026-09-25', [pedido(101, 200_000), pedido(102, 100_000), pedido(103, 50_000)])],
            recibosIM: [efectivo(1, 101, '2026-09-24', 200_000), efectivo(2, 102, '2026-09-24', 100_000)],
        });
        const h = r.hojas[0];
        expect(h.fecha_corrida).toBe(true);
        expect(h.fecha_efectiva).toBe('2026-09-24');
        expect(h.totales.efectivo).toBe(300_000);
    });

    it('un solo recibo en otro día NO corre la hoja: puede ser un cobro suelto', () => {
        const r = base({
            hojas: [hoja(3431, '2026-09-25', [pedido(101, 200_000), pedido(102, 100_000)])],
            recibosIM: [efectivo(1, 101, '2026-09-24', 200_000)],
        });
        expect(r.hojas[0].fecha_corrida).toBe(false);
        expect(r.hojas[0].totales.efectivo).toBe(0);
    });

    it('🔑 el cobro a un cliente que no estaba en ninguna hoja del día queda aparte, a la vista', () => {
        const r = base({
            hojas: [hoja(3421, '2026-09-19', [pedido(101, 200_000)])],
            recibosIM: [efectivo(1, 101, '2026-09-19', 200_000), efectivo(2, 999, '2026-09-19', 2_124_343)],
        });
        expect(r.hojas[0].totales.efectivo).toBe(200_000);
        expect(r.fuera_de_hoja).toEqual([{ fecha: '2026-09-19', total: 2_124_343, recibos: [expect.objectContaining({ id_recibo: '2', cod_cliente: 999, importe: 2_124_343 })] }]);
    });

    it('🪤 un recibo no se cuenta dos veces si el cliente está en dos hojas el mismo día', () => {
        const r = base({
            hojas: [hoja(3426, '2026-09-22', [pedido(101, 100_000)]), hoja(3425, '2026-09-22', [pedido(101, 50_000)])],
            recibosIM: [efectivo(1, 101, '2026-09-22', 150_000)],
        });
        const total = r.hojas.reduce((s, h) => s + h.totales.efectivo, 0);
        expect(total).toBe(150_000);
        expect(r.hojas.find(h => h.numero === 3425)!.filas[0].efectivo).toBe(150_000);
        expect(r.hojas.every(h => h.filas[0].compartido)).toBe(true);
    });
});

describe('armarRendiciones — gastos y asiento del día', () => {
    const hojas = [
        hoja(3423, '2026-09-21', [pedido(101, 1_000_000), pedido(102, 600_000)]),
        hoja(3424, '2026-09-21', [pedido(103, 2_000_000)]),
    ];
    const recibosIM = [efectivo(1, 101, '2026-09-21', 1_000_000), efectivo(2, 102, '2026-09-21', 500_000.5), efectivo(3, 103, '2026-09-21', 2_000_000)];
    const mayor = [
        mov(10, '2026-09-21', 'OP', ' Caja Repartos - (OP.Nro.12846)-AYUDANTE ROBERTO SEGUN HR 3424', 0, 18_000),
        mov(11, '2026-09-21', 'OP', ' Caja Repartos - (OP.Nro.12847)-combustible segun hr 3999', 0, 50_000),
        mov(12, '2026-09-22', 'AS', '3423,3424-AS', 0, 3_482_000),
        mov(13, '2026-09-22', 'AS', 'diferencia de cja n° 835-AS', 0, 0.5),
    ];

    it('los gastos del viaje salen de las OP "según HR" de cada hoja', () => {
        const r = base({ hojas, recibosIM, mayor });
        const h24 = r.hojas.find(h => h.numero === 3424)!;
        expect(h24.gastos.map(g => g.importe)).toEqual([18_000]);
        expect(h24.totales.debe_entregar).toBe(2_000_000 - 18_000);
        expect(r.hojas.find(h => h.numero === 3423)!.gastos).toEqual([]);
    });

    it('🔑 el asiento del día junta las hojas y la cuenta cierra con la diferencia registrada', () => {
        const r = base({ hojas, recibosIM, mayor });
        expect(r.asientos).toHaveLength(1);
        const a = r.asientos[0];
        expect(a.hojas).toEqual([3423, 3424]);
        expect(a.entregado).toBe(3_482_000);
        expect(a.cobrado_efectivo).toBe(3_500_000.5);
        expect(a.gastos).toBe(18_000);
        expect(a.diferencia_calculada).toBe(0.5);
        expect(a.diferencia_registrada).toBe(-0.5);
        expect(a.cuadra).toBe(true);
        expect(r.hojas.every(h => h.asiento_id === '12')).toBe(true);
    });

    it('🔑 el cuadre usa TODO el efectivo del día, también el de clientes fuera de la hoja (así rinde la oficina)', () => {
        const r = base({
            hojas, mayor: [...mayor.slice(0, 2), mov(12, '2026-09-22', 'AS', '3423,3424-AS', 0, 3_582_000), mov(13, '2026-09-22', 'AS', 'diferencia de cja n° 835-AS', 0, 0.5)],
            recibosIM: [...recibosIM, efectivo(4, 999, '2026-09-21', 100_000)],
        });
        const a = r.asientos[0];
        expect(a.cobrado_efectivo).toBe(3_600_000.5);
        expect(a.cobrado_fuera_de_hoja).toBe(100_000);
        expect(a.cuadra).toBe(true);
    });

    it('si el asiento incluye hojas que no están en el rango, no se afirma si cuadra', () => {
        const r = base({ hojas: [hojas[0]], recibosIM, mayor });
        expect(r.asientos[0].hojas_fuera).toEqual([3424]);
        expect(r.asientos[0].cuadra).toBeNull();
    });

    it('🪤 el asiento con una aclaración escrita a mano igual se reconoce ("3402,3403 (3400 y 3401 NO EXTEN)-AS")', () => {
        const r = base({ hojas, recibosIM, mayor: [mov(12, '2026-09-22', 'AS', '3423,3424       (3400 y 3401 NO EXTEN)-AS', 0, 3_482_018)] });
        expect(r.asientos).toHaveLength(1);
        expect(r.asientos[0].hojas).toEqual([3423, 3424]);
        expect(r.asientos[0].hojas_fuera).toEqual([]);
    });

    it('🪤 la OP "según HR" de una hoja que el asiento aclara como inexistente cuenta en ese asiento', () => {
        // 11/09: "3402,3403 (3400 y 3401 NO EXTEN)-AS" y una OP "estacionamiento segun hr 3401" por $12.000.
        const r = base({
            hojas, recibosIM,
            mayor: [mov(10, '2026-09-21', 'OP', ' Caja Repartos - (OP.Nro.12846)-AYUDANTE ROBERTO SEGUN HR 3424', 0, 18_000),
                mov(15, '2026-09-21', 'OP', ' Caja Repartos - (OP.Nro.12700)-estacionamiento segun hr 3401', 0, 12_000),
                mov(12, '2026-09-22', 'AS', '3423,3424       (3400 y 3401 NO EXTEN)-AS', 0, 3_470_000),
                mov(13, '2026-09-22', 'AS', 'diferencia de cja n° 835-AS', 0, 0.5)],
        });
        const a = r.asientos[0];
        expect(a.otros_pagos.map(o => o.importe)).toEqual([12_000]);
        expect(a.cuadra).toBe(true);
    });

    it('🔑 un pago a un proveedor hecho con la caja del reparto (OP sin hoja) se muestra y entra en el cuadre', () => {
        // Pasó el 14 y el 15/09: NUTRINOA $460.000 y BURBUJAS $476.000 salieron de Caja Repartos.
        const r = base({
            hojas, recibosIM,
            mayor: [...mayor.slice(0, 2), mov(14, '2026-09-21', 'OP', 'NUTRINOA SAS -  (OP.Nro.12762)-Pago Factura No. 0001', 0, 460_000),
                mov(12, '2026-09-22', 'AS', '3423,3424-AS', 0, 3_022_000), mov(13, '2026-09-22', 'AS', 'diferencia de cja n° 835-AS', 0, 0.5)],
        });
        const a = r.asientos[0];
        expect(a.otros_pagos.map(o => o.importe)).toEqual([460_000]);
        expect(a.diferencia_calculada).toBe(0.5);
        expect(a.cuadra).toBe(true);
    });

    it('sin asiento todavía: la hoja queda "sin rendir" y no hay cuadre', () => {
        const r = base({ hojas, recibosIM, mayor: mayor.filter(m => m.tipo_comprobante !== 'AS') });
        expect(r.asientos).toEqual([]);
        expect(r.hojas.every(h => h.asiento_id === null)).toBe(true);
    });
});
