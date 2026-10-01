import { describe, it, expect, vi } from 'vitest';

// repartoDatos arrastra infomanager, que corta el proceso sin el secreto de IM.
vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });
const { conPesoDeIM } = await import('./repartoDatos.js');

/**
 * 🔴 LOS KILOS DE UNA HOJA ABIERTA TIENEN QUE SEGUIR A INFOMANAGER.
 *
 * Mati (17/09/2026): *"cuando editamos una factura desde IM no se están modificando los kg que
 * tiene esa factura en la app... los kg nunca se modifican"*.
 *
 * El peso se recalcula contra IM al ASIGNAR el pedido a la hoja y ahí queda congelado en
 * `hojas_ruta_pedidos`: si después editan el comprobante en InfoManager, la hoja sigue diciendo
 * los kilos viejos. Y los kilos deciden en qué camión entra la mercadería.
 *
 * 🪤 Pero un comprobante SIN renglones leídos no pesa 0: puede ser que IM no haya contestado ese
 * día. Poner 0 hace que la hoja parezca entrar en el camión, y eso se descubre en el galpón.
 */
const fila = (over: Record<string, any> = {}) => ({
  im_comprobante_id: '58840001', cod_cliente: 1093,
  bultos: 10, kg: 300, peso_completo: true, renglones_sin_peso: 0, ...over,
});
/** 2 bolsas de 30 kg + 10 kg de granel = 70 kg y 12 bultos. */
const RENGLONES = [{ cantidad: 2, equivalencia_um: 30 }, { cantidad: 10, equivalencia_um: 1 }];

describe('el peso de una entrega abierta', () => {
  it('🔑 se recalcula con los renglones que hay HOY en IM', () => {
    const [f] = conPesoDeIM([fila()], new Map([['58840001', RENGLONES]]));
    expect(f.kg).toBe(70);
    expect(f.bultos).toBe(12);
  });

  it('🔑 y deja a la vista con qué se había armado la hoja', () => {
    const [f] = conPesoDeIM([fila()], new Map([['58840001', RENGLONES]]));
    expect(f.kg_snapshot).toBe(300);
    expect(f.bultos_snapshot).toBe(10);
  });

  it('🔴 sin renglones de ese comprobante NO se pone en cero: queda el respaldo', () => {
    for (const mapa of [new Map(), new Map([['58840001', []]]), new Map([['otro', RENGLONES]])]) {
      const [f] = conPesoDeIM([fila()], mapa as any);
      expect(f.kg, JSON.stringify([...mapa.keys()])).toBe(300);
      expect(f.bultos).toBe(10);
      expect(f.kg_snapshot).toBeUndefined();
    }
  });

  it('🔑 y dice si el peso quedó completo con lo que se leyó', () => {
    const [ok] = conPesoDeIM([fila()], new Map([['58840001', RENGLONES]]));
    expect(ok.peso_completo).toBe(true);
    expect(ok.renglones_sin_peso).toBe(0);
    // Un renglón sin equivalencia no se puede pesar: la hoja tiene que decirlo.
    const [incompleto] = conPesoDeIM([fila()], new Map([['58840001', [...RENGLONES, { cantidad: 5, equivalencia_um: null }]]]));
    expect(incompleto.peso_completo).toBe(false);
    expect(incompleto.renglones_sin_peso).toBe(1);
  });

  it('el remito también encuentra sus renglones por su propio id', () => {
    const [f] = conPesoDeIM([fila({ im_remito_id: '77600' })], new Map([['77600', RENGLONES]]));
    expect(f.kg_snapshot).toBe(300);
  });
});

describe('lo que viaja sin cobrarse con cada entrega (01/10/2026)', async () => {
  const { conPendientes } = await import('./repartoDatos.js');
  const cat = new Map<number, any>([[491, { equivalencia_um: 1 }]]);
  const datos = { porPresupuesto: new Map([['58954399', [
    { id: 'a1', im_renglon_id: null, cod_articulo: 491, descripcion: 'MEZCLA GALLO PREMIUM', cantidad: 300, factura_ref: 'FA B 50680', origen: 'app' },
    { id: 'a2', im_renglon_id: '58955053', cod_articulo: null, descripcion: 'MAIZ LEALES 25 PENDIENTE', cantidad: 10, factura_ref: null, origen: 'app' },
  ]]]), cat };
  const entrega = (over: Record<string, any> = {}) => ({ ...fila(), im_presupuesto_id: '58954399', ...over });

  it('🔑 en una hoja abierta suma al peso recalculado y lleva la lista', () => {
    const [f] = conPendientes([entrega({ bultos: 12, kg: 70, kg_snapshot: 300, renglones_sin_peso: 0 })], datos, true);
    expect(f.bultos).toBe(322);
    expect(f.kg).toBe(370);
    // El de IM sin artículo cuenta el bulto pero no inventa kilos: la hoja lo dice.
    expect(f.renglones_sin_peso).toBe(1);
    expect(f.peso_completo).toBe(false);
    expect((f as any).pendientes.map((p: any) => p.descripcion)).toEqual(['MEZCLA GALLO PREMIUM', 'MAIZ LEALES 25 PENDIENTE']);
  });

  it('🪤 sobre el RESPALDO no se suma: el peso guardado al armar la hoja ya los trae', () => {
    const [f] = conPendientes([entrega({ bultos: 322, kg: 370 })], datos, true);
    expect(f.bultos).toBe(322);
    expect(f.kg).toBe(370);
    expect((f as any).pendientes).toHaveLength(2);
  });

  it('en una hoja cerrada sólo se muestran: su peso es historia', () => {
    const [f] = conPendientes([entrega({ bultos: 12, kg: 70, kg_snapshot: 300 })], datos, false);
    expect(f.kg).toBe(70);
    expect((f as any).pendientes).toHaveLength(2);
  });

  it('una entrega sin presupuesto de origen conocido no se toca', () => {
    const [f] = conPendientes([entrega({ im_presupuesto_id: null })], datos, true);
    expect((f as any).pendientes).toBeUndefined();
  });

  it('sin poder leerlos (o sin la migración), la hoja sale como antes', () => {
    const [f] = conPendientes([entrega({ kg_snapshot: 300 })], { porPresupuesto: null, cat }, true);
    expect(f.kg).toBe(300);
    expect((f as any).pendientes).toBeUndefined();
  });
});
