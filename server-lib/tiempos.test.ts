import { describe, it, expect, beforeEach } from 'vitest';
import { registrarTiempo, resumenTiempos, reiniciarTiempos, percentil } from './tiempos.js';

/**
 * S32 · mejora 9 (04/10/2026): medir antes de optimizar. Hoy no se sabe cuánto tarda IM en emitir
 * un recibo ni cuánto tarda una aprobación entera: la app no lo registraba.
 */
beforeEach(() => reiniciarTiempos());

describe('percentil', () => {
    it('mediana y p90 sobre valores sin ordenar', () => {
        const v = [900, 100, 500, 300, 700];
        expect(percentil(v, 0.5)).toBe(500);
        expect(percentil(v, 0.9)).toBe(900);
    });
    it('sin valores: null', () => { expect(percentil([], 0.5)).toBeNull(); });
});

describe('registrarTiempo / resumenTiempos', () => {
    it('resume por operación: cantidad, mediana, p90 y máximo', () => {
        for (const ms of [1200, 1800, 1500, 9000]) registrarTiempo('im.recibo.post', ms);
        registrarTiempo('recibo.aprobar', 2500);
        const r = resumenTiempos();
        expect(r['im.recibo.post']).toEqual({ n: 4, p50: 1500, p90: 9000, max: 9000 });
        expect(r['recibo.aprobar'].n).toBe(1);
    });
    it('🪤 guarda las últimas 500 por operación: la memoria no crece sin fin', () => {
        for (let i = 0; i < 700; i++) registrarTiempo('x', i);
        expect(resumenTiempos().x.n).toBe(500);
        expect(resumenTiempos().x.max).toBe(699);
    });
    it('ignora valores que no son tiempos', () => {
        registrarTiempo('x', Number.NaN); registrarTiempo('x', -5);
        expect(resumenTiempos().x).toBeUndefined();
    });
});
