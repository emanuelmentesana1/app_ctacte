import { describe, it, expect } from 'vitest';
import { planDelLote, type CandidatoLote } from './loteRecibos.js';

/**
 * S32 · mejora 4 (Mati, 04/10/2026): aprobar en lote los pagos que MercadoPago ya verificó.
 * En septiembre fueron 319 de los 468 imputados, y 280 de ellos a una sola factura. Condición de
 * Mati: *"empezá por una tanda chica, verificada contra IM antes de liberar el resto"* ⇒ tope.
 * Entra al lote SÓLO lo que no necesita criterio: verificado, sin observaciones, que se cubre con
 * facturas pendientes de la más vieja a la más nueva, y sin un posible duplicado.
 */

const cand = (p: Partial<CandidatoLote> = {}): CandidatoLote => ({
    id: 'r1', cod_cliente: 722, monto: 250_000, fecha: '2026-10-02', medio_pago: 'mercadopago', mp_status: 'verified',
    status: 'pendiente_revision', observaciones: null, ...p,
});
const fa = (id: string, fecha: string, saldo: number) => ({ id, fecha_factura: fecha, numero: id, saldo, tipo_comprobante: 'FA' });
const pend = { 722: [fa('FA2', '2026-09-28', 300_000), fa('FA1', '2026-09-10', 100_000)] } as Record<number, ReturnType<typeof fa>[]>;
const sinDup = () => ({ app: [], im: [] });

describe('planDelLote', () => {
    it('🔑 un pago verificado se imputa de la deuda más vieja a la más nueva y queda listo', () => {
        const [p] = planDelLote([cand()], (c) => pend[c] ?? [], sinDup, 3);
        expect(p.estado).toBe('listo');
        expect(p.comprobantes).toEqual([{ id: 'FA1', importe_a_pagar: 100_000 }, { id: 'FA2', importe_a_pagar: 150_000 }]);
    });

    it('lo que no verificó MercadoPago, o no es de MercadoPago, no entra', () => {
        const r = planDelLote([cand({ id: 'a', mp_status: 'ambiguous' }), cand({ id: 'b', medio_pago: 'recaudadora_1', mp_status: 'skipped' })], (c) => pend[c] ?? [], sinDup, 3);
        expect(r.map(x => x.estado)).toEqual(['salteado', 'salteado']);
    });

    it('🪤 con observaciones del vendedor ("imputar a la FA 142847") se revisa a mano', () => {
        const [p] = planDelLote([cand({ observaciones: 'imputar a FA 142847' })], (c) => pend[c] ?? [], sinDup, 3);
        expect(p.estado).toBe('salteado');
        expect(p.motivo).toMatch(/observaci/i);
    });

    it('si el pago supera la deuda pendiente (anticipo o saldo a favor), se revisa a mano', () => {
        const [p] = planDelLote([cand({ monto: 900_000 })], (c) => pend[c] ?? [], sinDup, 3);
        expect(p.estado).toBe('salteado');
        expect(p.motivo).toMatch(/deuda|anticipo/i);
    });

    it('si puede estar repetido (en la app o en IM), se revisa a mano', () => {
        const dup = () => ({ app: [], im: [{ id_recibo: '58999123' }] });
        const [p] = planDelLote([cand()], (c) => pend[c] ?? [], dup, 3);
        expect(p.estado).toBe('salteado');
        expect(p.motivo).toMatch(/repetido/i);
    });

    it(`🔑 tope del piloto: pasado el tope, los demás quedan "en espera"`, () => {
        const varios = ['r1', 'r2', 'r3', 'r4'].map((id, i) => cand({ id, cod_cliente: 722, monto: 10_000 + i }));
        const r = planDelLote(varios, (c) => pend[c] ?? [], sinDup, 2);
        expect(r.map(x => x.estado)).toEqual(['listo', 'listo', 'en_espera', 'en_espera']);
    });

    it('ya no está pendiente (otro lo aprobó) o sin fecha: afuera', () => {
        const r = planDelLote([cand({ id: 'a', status: 'imputado' }), cand({ id: 'b', fecha: null })], (c) => pend[c] ?? [], sinDup, 3);
        expect(r.map(x => x.estado)).toEqual(['salteado', 'salteado']);
    });
});
