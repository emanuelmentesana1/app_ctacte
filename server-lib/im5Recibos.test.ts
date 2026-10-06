import { describe, it, expect } from 'vitest';
import { cuerpoEdicionRecibo, planCorreccion, imputacionReemision, pendientesTrasAnular, type DetalleReciboIM5 } from './im5Recibos.js';

/**
 * Corregir en IM un recibo que la app ya emitió (Mati, 06/10/2026, caso MONTENORT). Datos inventados con la forma
 * real: el armado del cuerpo se comparó campo por campo con un PUT real de la pantalla de IM5 (RC 30156402).
 */

const detalle = (p: { cabecera?: Record<string, unknown>; pago?: Record<string, unknown>; pagos?: Array<Record<string, unknown>> } = {}): DetalleReciboIM5 => ({
    cabecera: {
        tipo_comprobante: 'RC', tipo_recibo: 'L', tipo_factura: null, cod_cliente: '900', cod_vendedor: null, cod_corredor: null, tag: 'S',
        fecha: '2026-09-30', punto_de_venta: '0', moneda: 'P', cotizacion: '1.000000', moneda_2: 'P', cotizacion_2: '1.000000',
        cod_cuenta: null, cod_unidad_negocio_cab: null, cod_periodo: null, observaciones: 'Cobro de prueba',
        numero: '30150001', anulada: 'N', total: '49.000000', usuario: 'matias', cliente_nombre: 'CLIENTE DE PRUEBA', tiene_derivado: 0,
        ...p.cabecera,
    },
    rc_comprobantes: [{ id: '1', id_comprob_pagado: '58000001', tipo: 'FA', punto_de_venta: '777', numero: '1', importe_pagado: '49.000000', detalle: null, circuito: 'V', id_asiento: null }],
    rc_pagos: p.pagos ?? [{
        id: '2', cond_pago: 'OT', importe: '49.000000', cod_cuenta: '1120003', cod_unidad_negocio: null, cheque_id: null,
        cheque_fec_emision: '2026-10-06', cheque_fec_pago: '2026-10-06', tarjeta_numero: '', tarjeta_num_cupon: '', tarjeta_lote_numero: 0,
        importe_cf: '0.000000', porcentaje_cf: '0.000000', importe_arancel: '0.000000', importe_cf_impuesto: null, mp_data: null, ...p.pago,
    }],
    rc_retenciones: [],
    rc_ncnd: [],
});

describe('cuerpoEdicionRecibo — el PUT como lo arma la pantalla de IM5', () => {
    it('🔑 sin cambios, viaja lo que está en IM con las conversiones de la pantalla', () => {
        expect(cuerpoEdicionRecibo(detalle())).toEqual({
            cabecera: {
                tipo_comprobante: 'RC', tipo_recibo: 'L', tipo_factura: 'X', cod_cliente: '900', cod_vendedor: null, cod_corredor: null, tag: 'S',
                fecha: '2026-09-30', punto_de_venta: 0, moneda: 'P', cotizacion: 1, moneda_2: 'P', cotizacion_2: 1,
                cod_cuenta: null, cod_unidad_negocio_cab: null, cod_periodo: null, observaciones: 'Cobro de prueba',
            },
            comprobantes: [{ id_comprob_pagado: '58000001', tipo_comprobante: 'FA', importe_pagado: 49, detalle: '', punto_de_venta: 777, circuito: 'V', id_asiento: null }],
            pagos: [{
                cond_pago: 'OT', importe: 49, cod_cuenta: '1120003', cod_unidad_negocio: null, cheque_banco: null, cheque_numero: null, cod_banco: null,
                tipo_cheque: null, cheque_id: 1, cheque_fec_emision: null, cheque_fec_pago: null, cod_tarjeta: null, cod_tarjeta_plan: null,
                tarjeta_numero: null, tarjeta_num_cupon: null, tarjeta_lote_numero: null, tarjeta_cod_autorizacion: null, id_pago_externo: null,
                estado_de_pago: null, ID_sistema_externo_accion: null, importe_cf: 0, porcentaje_cf: 0, importe_arancel: 0, importe_cf_impuesto: 0,
                mp_data: null, pw_data: null, clover_data: null, _persistido: true,
            }],
            retenciones: [],
            confirmar_reingreso_cheque: false,
        });
    });

    it('cambiar la cuenta toca SÓLO la cuenta del pago', () => {
        const antes = cuerpoEdicionRecibo(detalle());
        const despues = cuerpoEdicionRecibo(detalle(), { codCuenta: '1120005' });
        expect(despues.pagos[0].cod_cuenta).toBe('1120005');
        expect({ ...despues, pagos: [{ ...despues.pagos[0], cod_cuenta: '1120003' }] }).toEqual(antes);
    });
});

describe('planCorreccion — qué se hace en IM y qué no', () => {
    const app = { status: 'imputado', cod_cliente: 900, monto: 49, fecha_comprobante: '2026-09-30', medio_pago: 'mercadopago', infomanager_recibo_id: '59000001', numero_im: '30150001' };

    it('🔑 MONTENORT: si sólo cambia la cuenta, se edita en IM y conserva el número', () => {
        expect(planCorreccion(app, { medio_pago: 'recaudadora_1' }, detalle(), '1120005')).toMatchObject({ tipo: 'cuenta', desde: '1120003', hacia: '1120005' });
    });

    it('si cambia el monto, el cliente o la fecha, es anular y reemitir', () => {
        expect(planCorreccion(app, { monto: 50 }, detalle(), null)).toMatchObject({ tipo: 'anular_reemitir' });
        expect(planCorreccion(app, { cod_cliente: 901 }, detalle(), null)).toMatchObject({ tipo: 'anular_reemitir' });
        expect(planCorreccion(app, { fecha_comprobante: '2026-10-01' }, detalle(), null)).toMatchObject({ tipo: 'anular_reemitir' });
    });

    it('lo que no toca IM (un texto, la misma cuenta) se cambia sólo en la app', () => {
        expect(planCorreccion(app, {}, detalle(), null)).toMatchObject({ tipo: 'solo_app' });
        expect(planCorreccion(app, { medio_pago: 'mercadopago' }, detalle(), '1120003')).toMatchObject({ tipo: 'solo_app' });
        expect(planCorreccion({ ...app, status: 'pendiente_revision', infomanager_recibo_id: null }, { monto: 50 }, null, null)).toMatchObject({ tipo: 'solo_app' });
    });

    it('🔴 control contra IM antes de tocar nada', () => {
        const no = (d: DetalleReciboIM5 | null, cambios = { medio_pago: 'recaudadora_1' }) => planCorreccion(app, cambios, d, '1120005');
        expect(no(null)).toMatchObject({ tipo: 'no_se_puede' });
        expect(no(detalle({ cabecera: { anulada: 'S' } }))).toMatchObject({ tipo: 'no_se_puede', motivo: expect.stringMatching(/anulado/i) });
        expect(no(detalle({ cabecera: { numero: '30159999' } }))).toMatchObject({ tipo: 'no_se_puede', motivo: expect.stringMatching(/número/i) });
        expect(no(detalle({ cabecera: { total: '60.000000' } }))).toMatchObject({ tipo: 'no_se_puede', motivo: expect.stringMatching(/\$/) });
        expect(no(detalle({ cabecera: { cod_cliente: '901' } }))).toMatchObject({ tipo: 'no_se_puede', motivo: expect.stringMatching(/cliente/i) });
        expect(no(detalle({ cabecera: { tiene_derivado: 1 } }))).toMatchObject({ tipo: 'no_se_puede', motivo: expect.stringMatching(/posterior/i) });
    });

    it('🔴 un recibo con dos medios de pago, un cheque o una tarjeta se corrige a mano', () => {
        const dos = detalle({ pagos: [{ cond_pago: 'OT', importe: '20', cod_cuenta: '1120003' }, { cond_pago: 'EF', importe: '29', cod_cuenta: '1110005' }] });
        expect(planCorreccion(app, { medio_pago: 'recaudadora_1' }, dos, '1120005')).toMatchObject({ tipo: 'no_se_puede' });
        expect(planCorreccion(app, { medio_pago: 'recaudadora_1' }, detalle({ pago: { cond_pago: 'CH' } }), '1120005')).toMatchObject({ tipo: 'no_se_puede' });
        expect(planCorreccion(app, { medio_pago: 'recaudadora_1' }, detalle({ pago: { cond_pago: 'TJ' } }), '1120005')).toMatchObject({ tipo: 'no_se_puede' });
    });

    it('$1 de diferencia con IM es el truncado de siempre: no frena', () => {
        expect(planCorreccion({ ...app, monto: 49.8 }, { medio_pago: 'recaudadora_1' }, detalle(), '1120005')).toMatchObject({ tipo: 'cuenta' });
    });
});

describe('imputacionReemision — a qué facturas va el recibo nuevo (anular y reemitir)', () => {
    const deuda = [
        { id: 'VIEJA', saldo: 50_000, fecha: '2026-08-01' },
        { id: 'FA1', saldo: 300_000, fecha: '2026-09-20' },
        { id: 'FA2', saldo: 120_000, fecha: '2026-09-25' },
        { id: 'RESIDUO', saldo: 0.6, fecha: '2026-07-01' },
    ];

    it('🔑 mismo monto: va a las mismas facturas que el anulado, aunque haya deuda más vieja', () => {
        expect(imputacionReemision(300_000, ['FA1'], deuda)).toEqual([{ id: 'FA1', importe: 300_000 }]);
    });

    it('más plata: primero las del anulado, el resto a la deuda más vieja (un residuo de $1 o menos no cuenta)', () => {
        expect(imputacionReemision(400_000, ['FA1'], deuda)).toEqual([{ id: 'FA1', importe: 300_000 }, { id: 'VIEJA', importe: 50_000 }, { id: 'FA2', importe: 50_000 }]);
    });

    it('menos plata: sólo a las del anulado, en su orden', () => {
        expect(imputacionReemision(100_000, ['FA2', 'FA1'], deuda)).toEqual([{ id: 'FA2', importe: 100_000 }]);
    });

    it('otro cliente (sin facturas del anulado): la deuda más vieja primero', () => {
        expect(imputacionReemision(60_000, [], deuda)).toEqual([{ id: 'VIEJA', importe: 50_000 }, { id: 'FA1', importe: 10_000 }]);
    });

    it('🔴 más plata que toda la deuda: no se emite (sería anticipo, la API de IM no lo hace)', () => {
        expect(imputacionReemision(500_000, ['FA1'], deuda)).toMatchObject({ error: expect.stringMatching(/anticipo/i) });
        expect(imputacionReemision(10, [], [])).toMatchObject({ error: expect.stringMatching(/anticipo/i) });
    });
});

describe('pendientesTrasAnular — la deuda del cliente cuando se anule el recibo', () => {
    it('lo que pagaba el anulado vuelve a estar pendiente (y aparece si ya no figuraba)', () => {
        expect(pendientesTrasAnular([{ id: 'FA1', saldo: 0.3, fecha: '2026-09-30' }, { id: 'FA2', saldo: 10, fecha: null }], [{ id: 'FA1', importe: 418_719 }, { id: 'FA9', importe: 5 }]))
            .toEqual([{ id: 'FA1', saldo: 418_719.3, fecha: '2026-09-30' }, { id: 'FA2', saldo: 10, fecha: null }, { id: 'FA9', saldo: 5, fecha: null }]);
    });
});
