import { describe, it, expect } from 'vitest';
import { preseleccionFIFO, siguienteEnCola, type FacturaParaImputar } from './aprobacionRecibos';

/**
 * 04/10/2026 — Mati: *"se imputa primero a la deuda más vieja, casi siempre"*. Hoy Anto toca
 * factura por factura en cada recibo (una decisión cada 45 s, ~530 por mes). La pantalla
 * propone la imputación y ella sólo la corrige cuando hace falta.
 */

const fa = (id: number, fecha: string, saldo: number, numero = id): FacturaParaImputar => ({
    id, fecha_factura: fecha, saldo, numero, tipo_comprobante: saldo < 0 ? 'NC' : 'FA',
});

describe('preseleccionFIFO', () => {
    it('una factura que alcanza: se imputa el monto del recibo, no el saldo entero', () => {
        expect(preseleccionFIFO([fa(1, '2026-09-20', 500_000)], 200_000)).toEqual({ '1': 200_000 });
    });

    it('🔑 la más vieja primero, aunque IM la mande después', () => {
        const facturas = [fa(2, '2026-09-28', 300_000), fa(1, '2026-09-10', 100_000)];
        expect(preseleccionFIFO(facturas, 250_000)).toEqual({ '1': 100_000, '2': 150_000 });
    });

    it('si el pago supera la deuda, toma todo y deja ver la diferencia (no inventa imputación)', () => {
        const facturas = [fa(1, '2026-09-10', 100_000), fa(2, '2026-09-12', 50_000)];
        expect(preseleccionFIFO(facturas, 400_000)).toEqual({ '1': 100_000, '2': 50_000 });
    });

    it('🪤 las notas de crédito (saldo negativo) no se preseleccionan: no son deuda', () => {
        const facturas = [fa(1, '2026-09-29', 2_016_874.632), fa(2, '2026-10-03', -203_683.2)];
        expect(preseleccionFIFO(facturas, 300_000)).toEqual({ '1': 300_000 });
    });

    it('mismo día: desempata por número de comprobante', () => {
        const facturas = [fa(9, '2026-09-10', 100_000, 51_000), fa(8, '2026-09-10', 100_000, 50_999)];
        expect(preseleccionFIFO(facturas, 150_000)).toEqual({ '8': 100_000, '9': 50_000 });
    });

    it('redondea a centavos: IM manda saldos con 3 decimales', () => {
        expect(preseleccionFIFO([fa(1, '2026-09-10', 1_000.4567)], 5_000)).toEqual({ '1': 1_000.46 });
    });

    it('sin monto o sin deuda no propone nada', () => {
        expect(preseleccionFIFO([fa(1, '2026-09-10', 1_000)], 0)).toEqual({});
        expect(preseleccionFIFO([], 1_000)).toEqual({});
        expect(preseleccionFIFO([fa(1, '2026-09-10', 0)], 1_000)).toEqual({});
    });

    it('sin fecha va al final: no se puede saber si es la más vieja', () => {
        const facturas = [{ id: 1, saldo: 100_000 }, fa(2, '2026-09-25', 100_000)] as FacturaParaImputar[];
        expect(preseleccionFIFO(facturas, 150_000)).toEqual({ '2': 100_000, '1': 50_000 });
    });
});

describe('siguienteEnCola', () => {
    it('pasa al siguiente de la lista que se estaba mirando', () => {
        expect(siguienteEnCola(['a', 'b', 'c'], 'a', new Set(['a']))).toBe('b');
    });

    it('🔑 saltea los que ya se resolvieron en esta tanda', () => {
        expect(siguienteEnCola(['a', 'b', 'c'], 'a', new Set(['a', 'b']))).toBe('c');
    });

    it('si era el último, vuelve a uno anterior que siga pendiente', () => {
        expect(siguienteEnCola(['a', 'b', 'c'], 'c', new Set(['c']))).toBe('a');
    });

    it('cola terminada: null (vuelve a la lista)', () => {
        expect(siguienteEnCola(['a', 'b'], 'b', new Set(['a', 'b']))).toBeNull();
        expect(siguienteEnCola([], 'x', new Set(['x']))).toBeNull();
    });

    it('un recibo abierto que no estaba en la cola igual encuentra el primero pendiente', () => {
        expect(siguienteEnCola(['a', 'b'], 'z', new Set(['z']))).toBe('a');
    });
});
