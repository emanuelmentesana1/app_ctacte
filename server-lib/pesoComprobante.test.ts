import { describe, it, expect } from 'vitest';
import { pesoDeRenglones, sinPesoAProposito } from './pesoComprobante.js';

/**
 * Bultos y kilos de un pedido. NO es un dato decorativo: **define en qué camión entra la
 * mercadería**. La flota es 1×5.000 kg, 2×7.000 kg y 1×12.000 kg (Mati, 07/09/2026), así que
 * si este número está mal, se arma una hoja que no entra en el camión.
 *
 * La fórmula se sacó de la hoja de ruta REAL nº 3394 (07/09/2026) y se verificó contra cinco
 * remitos de ese día:
 *
 *   comp 77156 -> 67 bultos / 268,00 kg     ✓ exacto
 *   comp 77104 -> 34 bultos / 94,50 kg      ✓ exacto
 *   comp 77147 -> 286 bultos / 492,60 kg
 *   comp 77115 -> 107 bultos / 450,00 kg
 *   comp 77138 -> 171 bultos / 471,30 kg
 *
 * 🪤 Los tres últimos sólo cierran si los artículos SIN `equivalencia_um` cuentan **0 kg**.
 * El fallback intuitivo (contarlos como 1 kg por unidad) daba de más: 564,64 en vez de 492,60.
 * O sea: un artículo sin equivalencia cargada NO pesa para IM.
 */

describe('pesoDeRenglones — bultos y kilos de un pedido', () => {
  it('🔴 los bultos son la suma de las cantidades', () => {
    const r = pesoDeRenglones([
      { cantidad: 10, equivalencia_um: 25 },
      { cantidad: 5, equivalencia_um: 1 },
    ]);
    expect(r.bultos).toBe(15);
  });

  it('🔴 los kilos son cantidad × equivalencia', () => {
    // 2 bolsas de 25 kg + 30 kg sueltos = 80 kg en 32 bultos.
    const r = pesoDeRenglones([
      { cantidad: 2, equivalencia_um: 25 },
      { cantidad: 30, equivalencia_um: 1 },
    ]);
    expect(r.bultos).toBe(32);
    expect(r.kg).toBe(80);
  });

  it('🔴 EL CASO DE LA HOJA 3394: un artículo SIN equivalencia pesa 0, no 1', () => {
    // Verificado contra IM: con el fallback de 1 kg los remitos daban de más.
    const r = pesoDeRenglones([
      { cantidad: 10, equivalencia_um: 25 },
      { cantidad: 72.04, equivalencia_um: null },
    ]);
    expect(r.bultos).toBe(82.04);   // el bulto SÍ cuenta: el paquete viaja igual
    expect(r.kg).toBe(250);         // pero no suma kilos
    expect(r.renglones_sin_peso).toBe(1);
  });

  it('🔴 avisa cuántos renglones no pudieron pesarse', () => {
    // Si son muchos, el total de kg miente por abajo y la hoja puede sobrecargar el camión.
    const r = pesoDeRenglones([
      { cantidad: 1, equivalencia_um: 25 },
      { cantidad: 1, equivalencia_um: 0 },
      { cantidad: 1, equivalencia_um: null },
      { cantidad: 1, equivalencia_um: undefined },
    ]);
    expect(r.kg).toBe(25);
    expect(r.renglones_sin_peso).toBe(3);
  });

  it('los renglones en cantidad 0 no suman ni bultos ni kilos', () => {
    const r = pesoDeRenglones([{ cantidad: 0, equivalencia_um: 25 }, { cantidad: 4, equivalencia_um: 10 }]);
    expect(r.bultos).toBe(4);
    expect(r.kg).toBe(40);
  });

  it('redondea a 2 decimales: 4,2 kg × 3 no puede dar 12,600000000000001', () => {
    const r = pesoDeRenglones([{ cantidad: 3, equivalencia_um: 4.2 }]);
    expect(r.kg).toBe(12.6);
  });

  it('sin renglones no explota', () => {
    expect(pesoDeRenglones([])).toEqual({ bultos: 0, kg: 0, renglones_sin_peso: 0 });
  });
});

describe('pesoDeRenglones — la carga del camión', () => {
  it('🔴 una hoja de ruta se suma pedido por pedido y se compara con la capacidad', () => {
    // El camión más chico es de 5.000 kg. 200 bolsas de 25 kg lo llenan justo.
    const pedidos = [
      pesoDeRenglones([{ cantidad: 100, equivalencia_um: 25 }]),
      pesoDeRenglones([{ cantidad: 100, equivalencia_um: 25 }]),
    ];
    const total = pedidos.reduce((s, p) => s + p.kg, 0);
    expect(total).toBe(5000);
    expect(total > 5000).toBe(false);
    expect(total > 4000).toBe(true);
  });
});

it.each(['dato ilegible', '', '  ', null, undefined, NaN, Infinity, -1])('cantidad desconocida %s no acredita peso completo', cantidad => {
  expect(pesoDeRenglones([{cantidad,equivalencia_um:25}])).toMatchObject({kg:0,bultos:0,renglones_sin_peso:1});
});
it('cero real y string numérico son distintos de una cantidad ilegible', () => {
  expect(pesoDeRenglones([{cantidad:0,equivalencia_um:null},{cantidad:'2',equivalencia_um:25}])).toEqual({kg:50,bultos:2,renglones_sin_peso:0});
});

/**
 * SIN PESO A PROPÓSITO (Mati, 03/10/2026): *"los accesorios y los venenos (raticidas, cebos, etc.) NO
 * llevan peso, y está bien que queden en 0"*. La hoja 3448 (VICTOR, 03/10) salía "Peso estimado · sin
 * verificar" por macetas, ganchos, un raticida y orejas: renglones que nunca van a tener peso.
 * Rubros reales de IM: 11 Accesorios y Venenos · 7 Frutos secos · 10 Snack · 4 Comestibles ·
 * 13 Varios · 8 Insumos para prod.
 */
describe('sin peso a propósito: accesorios, venenos y lo que decidió Mati', () => {
  const art = (cod_rubro: number | null, equivalencia_um: number | null) => ({ cod_rubro, equivalencia_um });
  const renglon = (cod: number, cantidad: number, rubro: number, eq: number) =>
    ({ cantidad, equivalencia_um: eq, sin_peso_a_proposito: sinPesoAProposito(cod, art(rubro, eq)) });

  it('🔴 todo el rubro 11 "Accesorios y Venenos" va sin peso a propósito', () => {
    expect(sinPesoAProposito(1968, art(11, 0))).toBe(true); // ULTRA RATICIDA 30 SOBRES
    expect(sinPesoAProposito(1212, art(11, null))).toBe(true); // MACETA CLASICA N° 12
  });

  it('🔴 y cuatro códigos sueltos de otros rubros, por decisión de Mati', () => {
    // FORRAJES VARIOS · BOLSAS vacías de 1 y 10 kg · NUEZ PELADA LIGHT
    for (const [cod, rubro] of [[13818, 13], [2100, 8], [2102, 8], [617, 7]]) {
      expect(sinPesoAProposito(cod, art(rubro, 0)), String(cod)).toBe(true);
    }
  });

  it('🔴 un snack sin equivalencia NO: tiene que pesar, y la hoja lo tiene que avisar', () => {
    expect(sinPesoAProposito(10710, art(10, 0))).toBe(false); // CHIZITO FLOR DEL NORTE X KG
    expect(sinPesoAProposito(10670, art(4, 0))).toBe(false); // MANI TOSTADO KING X KG
  });

  it('sin el artículo en el catálogo no se sabe qué es: no se asume nada', () => {
    expect(sinPesoAProposito(1968, undefined)).toBe(false);
  });

  it('🔴 hoja 3448: los accesorios y venenos ya no la dejan "sin verificar"; el chizito sí', () => {
    const peso = pesoDeRenglones([
      renglon(1968, 36, 11, 0), renglon(1910, 20, 11, 0), renglon(1212, 6, 11, 0), renglon(1215, 6, 11, 0),
      renglon(957, 22, 11, 0), renglon(617, 2, 7, 0),
      renglon(10710, 5, 10, 0), // CHIZITO: todavía sin peso cargado
      renglon(10670, 5, 4, 1), // MANI X KG: 5 kg
    ]);
    expect(peso.renglones_sin_peso).toBe(1);
    expect(peso.kg).toBe(5);
    expect(peso.bultos).toBe(102);
  });

  it('si IM tiene un peso cargado, manda el peso aunque sea del rubro 11', () => {
    const peso = pesoDeRenglones([renglon(1945, 12, 11, 0.25)]); // TALQUERA HORTAL X 250 GR
    expect(peso.kg).toBe(3);
    expect(peso.renglones_sin_peso).toBe(0);
  });
});
