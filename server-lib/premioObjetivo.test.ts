import { describe, it, expect } from 'vitest';
import {
  calcPremioObjetivo, tasaPremio, productoCumplido, rigePremioObjetivo,
} from './premioObjetivo.js';

// Comisión neta del ejemplo de septiembre 2026 que pasó Manolo: los $ 4.882.707 que
// mostraba la pantalla (bruta − 30.606) + 13.241 de rebotes de empresa = 4.895.948.
const NETA = 4895948;
const CON_PRODUCTOS = { total: 4, cumplidos: 2 };

describe('rigePremioObjetivo — desde septiembre 2026', () => {
  it('agosto no, septiembre en adelante sí', () => {
    expect(rigePremioObjetivo(2026, 8)).toBe(false);
    expect(rigePremioObjetivo(2026, 9)).toBe(true);
    expect(rigePremioObjetivo(2027, 1)).toBe(true);
  });
});

describe('tasaPremio — tramos sobre el cumplimiento del objetivo en pesos', () => {
  it('menos de 95% no cobra', () => {
    expect(tasaPremio(0.9499)).toBe(0);
    expect(tasaPremio(0.5)).toBe(0);
  });
  it('95% a menos de 100% cobra 7,5%', () => {
    expect(tasaPremio(0.95)).toBe(0.075);
    expect(tasaPremio(0.9999)).toBe(0.075);
  });
  it('100% justo o más cobra 15%', () => {
    expect(tasaPremio(1)).toBe(0.15);
    expect(tasaPremio(1.32)).toBe(0.15);
  });
  it('sin objetivo cargado no cobra', () => {
    expect(tasaPremio(null)).toBe(0);
  });
});

describe('calcPremioObjetivo', () => {
  it('superó el objetivo y cumplió 2 de 4 productos: 15% entero', () => {
    const p = calcPremioObjetivo(NETA, 1.04, CON_PRODUCTOS);
    expect(p).toMatchObject({ tasa: 0.15, premio_bruto: 734392.2, reducido: false, premio: 734392.2 });
  });

  it('entre 95% y 99%: 7,5%', () => {
    expect(calcPremioObjetivo(NETA, 0.97, CON_PRODUCTOS).premio).toBe(367196.1);
  });

  it('cumplió solo 1 producto: el premio se reduce a la mitad', () => {
    const p = calcPremioObjetivo(NETA, 1.04, { total: 4, cumplidos: 1 });
    expect(p).toMatchObject({ premio_bruto: 734392.2, reducido: true, premio: 367196.1 });
  });

  it('cuentan los cumplidos, no la proporción: 2 de 6 alcanza', () => {
    expect(calcPremioObjetivo(NETA, 1.04, { total: 6, cumplidos: 2 }).reducido).toBe(false);
  });

  it('con una sola familia cargada no llega a 2: se reduce', () => {
    expect(calcPremioObjetivo(NETA, 1.04, { total: 1, cumplidos: 1 }).reducido).toBe(true);
  });

  it('sin objetivos de producto cargados no hay requisito: no se reduce', () => {
    expect(calcPremioObjetivo(NETA, 1.04, { total: 0, cumplidos: 0 })).toMatchObject({ reducido: false, premio: 734392.2 });
  });

  it('debajo de 95% no hay premio ni reducción que mostrar', () => {
    expect(calcPremioObjetivo(NETA, 0.9, { total: 4, cumplidos: 0 })).toMatchObject({ premio: 0, reducido: false });
  });

  it('una comisión neta negativa no genera premio', () => {
    expect(calcPremioObjetivo(-1000, 1.2, CON_PRODUCTOS).premio).toBe(0);
  });
});

describe('productoCumplido', () => {
  it('cumplido = llegar a las unidades del objetivo', () => {
    expect(productoCumplido(100, 100)).toBe(true);
    expect(productoCumplido(99.5, 100)).toBe(false);
    expect(productoCumplido(5, 0)).toBe(false);
  });
});
