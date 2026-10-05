import { describe, it, expect } from 'vitest';
import { parseMontoUpload, lecturaDelCelular } from './recibosShared.js';

/**
 * Bug auditoría 22-jul: el server re-parseaba como formato AR lo que el front
 * (cleanMonto de RecibosApp) ya había normalizado a punto decimal:
 * '1.500,50' → front manda '1500.50' → server borraba el punto → 150050 (×100).
 * El parser debe bancar AMBOS formatos sin romper ninguno.
 */
describe('parseMontoUpload', () => {
  it('formato canónico del front (punto decimal) NO se multiplica ×100', () => {
    expect(parseMontoUpload('1500.50')).toBe(1500.5);
    expect(parseMontoUpload('999.99')).toBe(999.99);
    expect(parseMontoUpload('1.5')).toBe(1.5);
  });

  it('formato argentino crudo (por si algo saltea el cleanMonto del front)', () => {
    expect(parseMontoUpload('1.500,50')).toBe(1500.5);
    expect(parseMontoUpload('1500,50')).toBe(1500.5);
    expect(parseMontoUpload('1.500.000')).toBe(1500000);
  });

  it('punto como separador de miles (el front deja pasar "15.000" crudo)', () => {
    expect(parseMontoUpload('15.000')).toBe(15000);
    expect(parseMontoUpload('1.500')).toBe(1500);
  });

  it('caso front-mangled: "1.500.000" tipeado queda "1.500000" tras cleanMonto', () => {
    // cleanMonto colapsa múltiples puntos a uno ('1' + '.' + '500000').
    // Más de 2 decimales no existe en ARS → son miles.
    expect(parseMontoUpload('1.500000')).toBe(1500000);
  });

  it('enteros y basura', () => {
    expect(parseMontoUpload('1500')).toBe(1500);
    expect(parseMontoUpload('$ 1.500,50')).toBe(1500.5); // por si llega con símbolo
    expect(parseMontoUpload('')).toBeNull();
    expect(parseMontoUpload(undefined)).toBeNull();
    expect(parseMontoUpload(null)).toBeNull();
    expect(parseMontoUpload('abc')).toBeNull();
  });
});

/**
 * Lo que leyó el OCR del celular (S32 · mejora 8, 05/10/2026) se guarda con el recibo para medir
 * cuánto acierta. Llega del navegador: se acepta sólo la forma esperada y nada más.
 */
describe('lecturaDelCelular', () => {
  it('guarda monto, fecha y cuenta de la foto, marcados como del celular', () => {
    expect(lecturaDelCelular(JSON.stringify({ monto: 418769.3, fecha: '2026-09-30', medio: 'recaudadora_1' })))
      .toEqual({ fuente: 'celular', monto: 418769.3, fecha: '2026-09-30', medio: 'recaudadora_1' });
  });

  it('lo que no tiene la forma esperada se descarta, campo por campo', () => {
    expect(lecturaDelCelular(JSON.stringify({ monto: 'mucho', fecha: '30/09/2026', medio: 'banco', extra: 'x', monto2: 1 })))
      .toBe(null);
    expect(lecturaDelCelular(JSON.stringify({ monto: 1500, fecha: 'ayer', medio: null })))
      .toEqual({ fuente: 'celular', monto: 1500, fecha: null, medio: null });
  });

  it('nada, basura o algo enorme: no se guarda', () => {
    expect(lecturaDelCelular(undefined)).toBe(null);
    expect(lecturaDelCelular('{no es json')).toBe(null);
    expect(lecturaDelCelular('x'.repeat(600))).toBe(null);
  });
});

