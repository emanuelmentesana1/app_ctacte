import { describe, it, expect } from 'vitest';
import { posiblesDuplicados, VENTANA_IM, type ReciboAppLite, type ReciboIMLite } from './duplicadosRecibo.js';

/**
 * S32 (04/10/2026). En septiembre se rechazaron 63 de 534 recibos cargados: 44 porque el pago
 * YA estaba imputado por otro lado y 8 porque se subieron dos veces. Anto lo descubre a mano,
 * mirando IM. Calibrado sobre esos rechazos: ventana de −3 a +10 días y tolerancia de máx($1;
 * 0,5%) detecta 33 de los 44, con aviso de más en el 8% de los recibos buenos. Es un AVISO: decide
 * una persona.
 */

const app = (p: Partial<ReciboAppLite>): ReciboAppLite => ({
    id: 'x', cod_cliente: 722, monto: 150_000, fecha_comprobante: '2026-09-20', created_at: '2026-09-20T15:00:00Z',
    status: 'pendiente_revision', infomanager_recibo_id: null, ...p,
});
const im = (p: Partial<ReciboIMLite>): ReciboIMLite => ({
    id_recibo: 58_900_001, numero: '0000-30155729', fecha: '2026-09-22', cliente: { codigo: '722' }, importe_total: 150_000,
    items: [{ tipo_pago: 'OTRO', importe: 150_000, cuenta_contable: '1120003' }], ...p,
});
const candidato = { cod_cliente: 722, monto: 150_000, fecha: '2026-09-20' };

describe('posiblesDuplicados — en la app', () => {
    it('🔑 el mismo pago cargado por otra persona (chofer y vendedor) aparece', () => {
        const r = posiblesDuplicados(candidato, [app({ id: 'a1', created_by_rol: 'repartidor' })], []);
        expect(r.app.map(x => x.id)).toEqual(['a1']);
    });

    it('un rechazado no cuenta: ya se descartó', () => {
        expect(posiblesDuplicados(candidato, [app({ id: 'a1', status: 'rechazado' })], []).app).toEqual([]);
    });

    it('otro cliente o fuera de la semana no es el mismo pago', () => {
        const r = posiblesDuplicados(candidato, [
            app({ id: 'a1', cod_cliente: 815 }),
            app({ id: 'a2', fecha_comprobante: '2026-09-05' }),
        ], []);
        expect(r.app).toEqual([]);
    });

    it('no se avisa a sí mismo', () => {
        expect(posiblesDuplicados({ ...candidato, id: 'a1' }, [app({ id: 'a1' })], []).app).toEqual([]);
    });

    it('sin fecha de comprobante usa la fecha de carga', () => {
        const r = posiblesDuplicados(candidato, [app({ id: 'a1', fecha_comprobante: null, created_at: '2026-09-21T13:00:00Z' })], []);
        expect(r.app.map(x => x.id)).toEqual(['a1']);
    });
});

describe('posiblesDuplicados — en InfoManager', () => {
    it('🔑 un recibo del mismo cliente e importe, unos días después, aparece (el "ya imputado")', () => {
        const r = posiblesDuplicados(candidato, [], [im({})]);
        expect(r.im.map(x => x.id_recibo)).toEqual(['58900001']);
        expect(r.im[0].dias).toBe(2);
    });

    it(`ventana de ${VENTANA_IM.antes} días antes a ${VENTANA_IM.despues} después`, () => {
        const r = posiblesDuplicados(candidato, [], [
            im({ id_recibo: 1, fecha: '2026-09-16' }),  // −4: afuera
            im({ id_recibo: 2, fecha: '2026-09-17' }),  // −3: adentro
            im({ id_recibo: 3, fecha: '2026-09-30' }),  // +10: adentro
            im({ id_recibo: 4, fecha: '2026-10-01' }),  // +11: afuera
        ]);
        expect(r.im.map(x => x.id_recibo).sort()).toEqual(['2', '3']);
    });

    it('tolerancia: centavos y hasta 0,5% (retenciones, redondeos de IM)', () => {
        const r = posiblesDuplicados({ cod_cliente: 722, monto: 700_089, fecha: '2026-09-24' }, [], [
            im({ id_recibo: 1, fecha: '2026-09-24', importe_total: 700_089.3325 }),
            im({ id_recibo: 2, fecha: '2026-09-24', importe_total: 703_000 }),   // +0,42%: adentro
            im({ id_recibo: 3, fecha: '2026-09-24', importe_total: 710_000 }),   // +1,4%: afuera
        ]);
        expect(r.im.map(x => x.id_recibo).sort()).toEqual(['1', '2']);
    });

    it('el recibo que ya emitió la app para un gemelo no se repite: se muestra una sola vez, en la app', () => {
        const r = posiblesDuplicados(candidato, [app({ id: 'a1', status: 'imputado', infomanager_recibo_id: '58900001' })], [im({})]);
        expect(r.app.map(x => x.id)).toEqual(['a1']);
        expect(r.im).toEqual([]);
    });

    it('el propio recibo en IM (si ya se emitió) no es un duplicado', () => {
        const r = posiblesDuplicados({ ...candidato, infomanager_recibo_id: '58900001' }, [], [im({})]);
        expect(r.im).toEqual([]);
    });

    it('ordena por cercanía: primero el más parecido', () => {
        const r = posiblesDuplicados(candidato, [], [
            im({ id_recibo: 1, fecha: '2026-09-28' }),
            im({ id_recibo: 2, fecha: '2026-09-21' }),
        ]);
        expect(r.im.map(x => x.id_recibo)).toEqual(['2', '1']);
    });

    it('sin monto o sin cliente no busca nada', () => {
        expect(posiblesDuplicados({ cod_cliente: 722, monto: 0, fecha: '2026-09-20' }, [app({ id: 'a1' })], [im({})]))
            .toEqual({ app: [], im: [] });
    });
});
