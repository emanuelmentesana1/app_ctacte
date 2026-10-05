import { describe, it, expect } from 'vitest';
import { leerImporte } from './rendicionCuentas';

/**
 * Lo que Anto tipea en la rendición, copiado del papel de la hoja. 🪤 "412.300" son cuatrocientos
 * doce mil trescientos, no 412,3: en Argentina el punto separa miles (la misma regla que
 * `parseMontoUpload` en el servidor, que ya resolvió el bug del ×100 del 22/07).
 */
describe('leerImporte', () => {
    it('acepta los formatos que se tipean acá', () => {
        expect(leerImporte('412300')).toBe(412_300);
        expect(leerImporte('412.300')).toBe(412_300);
        expect(leerImporte('1.412.300')).toBe(1_412_300);
        expect(leerImporte('412.300,50')).toBe(412_300.5);
        expect(leerImporte('412300,5')).toBe(412_300.5);
        expect(leerImporte('$ 18.000')).toBe(18_000);
        expect(leerImporte('1500.50')).toBe(1_500.5);
    });

    it('vacío es "no cargado"; cero es cero; lo que no es un número, null', () => {
        expect(leerImporte('')).toBe(null);
        expect(leerImporte('   ')).toBe(null);
        expect(leerImporte('0')).toBe(0);
        expect(leerImporte('abc')).toBe(null);
    });
});
