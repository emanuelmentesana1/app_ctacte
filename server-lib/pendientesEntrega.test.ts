import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Mercadería ya facturada que viaja con un pedido nuevo. Mati (01/10/2026): CARDENES, PR 59080, con
 * "MAIZ LEALES 25 PENDIENTE" y "MEZCLA GALLO PREM" escritos a mano en IM en $0. Lo que se prueba es
 * lo que, si falla, hace que se pierdan, se cobren dos veces o no lleguen al camión.
 */

const m = vi.hoisted(() => ({ sbMock: vi.fn() }));
vi.mock('./supabase.js', () => ({ sb: m.sbMock, TENANT_ID: 'test-tenant', hasSupabase: () => true }));

const {
  esPendienteDeIM, pendientesDeIM, unirPendientes, validarPendientes, firmaPendientes, pesoDePendientes,
  leerPendientes, guardarPendientes, pasarPendientesDeIM, ErrorPendientes,
} = await import('./pendientesEntrega.js');

/** Los renglones del PR 59080 tal como los devuelve InfoManager (leídos el 01/10/2026). */
const PR_59080 = [
  { id: 58954400, cod_articulo: 462, cantidad: 10, precio: 41454.9, precio_orig: 41454.9, descuento_porc: 0, detalle: 'MAIZ LEALES 25 PLUS' },
  { id: 58954401, cod_articulo: 486, cantidad: 10, precio: 63014.14, precio_orig: 63014.14, descuento_porc: 0, detalle: 'MAIZ BT X20KG' },
  { id: 58955053, cod_articulo: 0, cantidad: 10, precio: 0, precio_orig: 1, descuento_porc: 100, detalle: 'MAIZ LEALES 25 PENDIENTE' },
  { id: 58955066, cod_articulo: 0, cantidad: 300, precio: 0, precio_orig: 1, descuento_porc: 100, detalle: 'MEZCLA GALLO PREM' },
];

describe('qué es un pendiente escrito en InfoManager', () => {
  it('🔑 un renglón sin código en $0 (el 100% de descuento lo deja en cero)', () => {
    expect(esPendienteDeIM(PR_59080[2])).toBe(true);
    expect(esPendienteDeIM(PR_59080[3])).toBe(true);
  });
  it('así viene de /ventas/items: código vacío, precio 0', () => {
    expect(esPendienteDeIM({ id: '1', cod_articulo: '', cantidad: 6, precio: 0, importe: 0, detalle: 'ANILLO FRUTA PENDIENTE ' })).toBe(true);
  });
  it('un artículo del catálogo no lo es, aunque vaya en $0', () => {
    expect(esPendienteDeIM({ cod_articulo: 491, cantidad: 300, precio: 0 })).toBe(false);
    expect(esPendienteDeIM(PR_59080[0])).toBe(false);
  });
  it('🔴 un renglón sin código CON importe tampoco: es un flete escrito a mano y se cobra', () => {
    expect(esPendienteDeIM({ cod_articulo: 0, cantidad: 1, precio: 15000, detalle: 'FLETE' })).toBe(false);
  });
  it('sin cantidad no viaja nada', () => {
    expect(esPendienteDeIM({ cod_articulo: '', cantidad: 0, precio: 0, detalle: 'NOTA' })).toBe(false);
  });
  it('se toma el texto y el renglón de IM, sin los espacios del final', () => {
    expect(pendientesDeIM(PR_59080)).toEqual([
      { im_renglon_id: '58955053', cod_articulo: null, descripcion: 'MAIZ LEALES 25 PENDIENTE', cantidad: 10, factura_ref: null, origen: 'im' },
      { im_renglon_id: '58955066', cod_articulo: null, descripcion: 'MEZCLA GALLO PREM', cantidad: 300, factura_ref: null, origen: 'im' },
    ]);
  });
});

describe('juntar lo de la app con lo que sigue en IM', () => {
  it('🔑 van los dos: lo cargado en la app y lo escrito en IM', () => {
    const app = [{ id: 'a1', im_renglon_id: null, cod_articulo: 491, descripcion: 'MEZCLA GALLO PREMIUM', cantidad: 150, factura_ref: 'FA B 50680', origen: 'app' as const }];
    expect(unirPendientes(app, PR_59080).map(p => p.descripcion)).toEqual(['MEZCLA GALLO PREMIUM', 'MAIZ LEALES 25 PENDIENTE', 'MEZCLA GALLO PREM']);
  });
  it('🔴 uno que ya se pasó a la app al facturar no aparece dos veces', () => {
    const app = [{ id: 'a1', im_renglon_id: '58955066', cod_articulo: null, descripcion: 'MEZCLA GALLO PREM', cantidad: 300, factura_ref: null, origen: 'app' as const }];
    const juntos = unirPendientes(app, PR_59080);
    expect(juntos.filter(p => p.descripcion === 'MEZCLA GALLO PREM')).toHaveLength(1);
    expect(juntos).toHaveLength(2);
  });
});

describe('lo que manda la pantalla', () => {
  it('se limpia el texto y se redondea la cantidad', () => {
    const r = validarPendientes([{ descripcion: '  MEZCLA   GALLO ', cantidad: '300.0004', cod_articulo: 491, factura_ref: ' FA B 50680 ' }]);
    expect(r).toEqual({ ok: true, lista: [{ id: null, im_renglon_id: null, cod_articulo: 491, descripcion: 'MEZCLA GALLO', cantidad: 300, factura_ref: 'FA B 50680', origen: 'app' }] });
  });
  it('🔴 sin cantidad no se acepta', () => {
    const r = validarPendientes([{ descripcion: 'MEZCLA', cantidad: 0 }]);
    expect(r.ok).toBe(false);
  });
  it('🔴 sin descripción tampoco: el papel diría un renglón en blanco', () => {
    expect(validarPendientes([{ descripcion: '   ', cantidad: 3 }]).ok).toBe(false);
  });
  it('un artículo inventado se rechaza, no se corrige solo', () => {
    expect(validarPendientes([{ descripcion: 'X', cantidad: 1, cod_articulo: 'abc' }]).ok).toBe(false);
    expect(validarPendientes([{ descripcion: 'X', cantidad: 1, cod_articulo: 0 }]).ok).toBe(false);
  });
  it('tiene que ser una lista', () => {
    expect(validarPendientes({ descripcion: 'X' }).ok).toBe(false);
  });
  it('🪤 un id de renglón que no es de IM se ignora: no se adivina de dónde salió', () => {
    const r: any = validarPendientes([{ descripcion: 'X', cantidad: 1, im_renglon_id: 'drop table' }]);
    expect(r.lista[0].im_renglon_id).toBeNull();
  });
  it('la firma cambia con la cantidad y con el orden', () => {
    const a = { id: null, im_renglon_id: null, cod_articulo: null, descripcion: 'A', cantidad: 1, factura_ref: null, origen: 'app' as const };
    const b = { ...a, descripcion: 'B' };
    expect(firmaPendientes([a, b])).not.toBe(firmaPendientes([b, a]));
    expect(firmaPendientes([a])).not.toBe(firmaPendientes([{ ...a, cantidad: 2 }]));
  });
});

describe('cuánto pesan', () => {
  const cat = new Map<number, any>([[462, { equivalencia_um: 20 }], [491, { equivalencia_um: 1 }]]);
  it('🔑 con artículo se pesan con el catálogo: van al camión', () => {
    const p = pesoDePendientes([
      { im_renglon_id: null, cod_articulo: 462, descripcion: 'MAIZ LEALES 25 PLUS', cantidad: 10, factura_ref: null, origen: 'app' },
      { im_renglon_id: null, cod_articulo: 491, descripcion: 'MEZCLA GALLO PREMIUM', cantidad: 300, factura_ref: null, origen: 'app' },
    ], cat);
    expect(p).toEqual({ bultos: 310, kg: 500, renglones_sin_peso: 0 });
  });
  it('🪤 sin artículo cuenta el bulto pero NO inventa kilos, y lo dice', () => {
    const p = pesoDePendientes(pendientesDeIM(PR_59080), cat);
    expect(p).toEqual({ bultos: 310, kg: 0, renglones_sin_peso: 2 });
  });
});

describe('contra la base', () => {
  let respuesta: any;
  let llamadas: any[];
  beforeEach(() => {
    llamadas = [];
    respuesta = { data: [], error: null };
    m.sbMock.mockImplementation(() => {
      const q: any = {
        then: (r: any, j: any) => Promise.resolve(respuesta).then(r, j),
        upsert: (filas: any, opciones: any) => { llamadas.push({ op: 'upsert', filas, opciones }); return q; },
      };
      for (const k of ['select', 'eq', 'in', 'order']) q[k] = () => q;
      return {
        from: () => q,
        rpc: async (nombre: string, args: any) => { llamadas.push({ op: 'rpc', nombre, args }); return respuesta; },
      };
    });
  });

  it('🔑 sin la migración 055 leer devuelve null: la pantalla sigue como antes', async () => {
    respuesta = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.pendientes_entrega'" } };
    expect(await leerPendientes(['1'])).toBeNull();
  });
  it('🔴 si la base no contesta NO es "no tiene pendientes": se dice', async () => {
    respuesta = { data: null, error: { code: '08006', message: 'connection failure' } };
    await expect(leerPendientes(['1'])).rejects.toBeInstanceOf(ErrorPendientes);
  });
  it('agrupa por presupuesto y respeta el orden', async () => {
    respuesta = { data: [
      { id: 'a', im_comprobante_id: '10', descripcion: 'X', cantidad: '2.000', orden: 0 },
      { id: 'b', im_comprobante_id: '20', descripcion: 'Y', cantidad: 1, orden: 0 },
      { id: 'c', im_comprobante_id: '10', descripcion: 'Z', cantidad: 3, orden: 1, cod_articulo: 491 },
    ], error: null };
    const r = await leerPendientes(['10', '20']);
    expect(r!.get('10')!.map(p => [p.descripcion, p.cantidad, p.origen])).toEqual([['X', 2, 'app'], ['Z', 3, 'app']]);
  });

  it('🔑 guardar manda la lista entera y conserva quién cargó lo que ya estaba', async () => {
    const antes = [{ id: 'a', im_renglon_id: '777', cod_articulo: null, descripcion: 'X', cantidad: 1, factura_ref: null, origen: 'app' as const, creado_por: 'jo', created_at: '2026-09-08T10:00:00Z' }];
    await guardarPendientes('200', '100', [{ id: 'a', im_renglon_id: null, cod_articulo: null, descripcion: 'X', cantidad: 4, factura_ref: null, origen: 'app' }], antes, '3d5f48d3-bac5-4a37-8c09-dfe0891c7e3a');
    const rpc = llamadas.find(l => l.op === 'rpc');
    expect(rpc.nombre).toBe('guardar_pendientes_entrega');
    expect(rpc.args).toMatchObject({ p_destino: '200', p_origen: '100', p_usuario: '3d5f48d3-bac5-4a37-8c09-dfe0891c7e3a' });
    expect(rpc.args.p_lista).toEqual([{ descripcion: 'X', cantidad: 4, cod_articulo: null, factura_ref: null, im_renglon_id: '777', creado_por: 'jo', created_at: '2026-09-08T10:00:00Z' }]);
  });
  it('🔴 sin la migración, guardar avisa con 503 y dice que no cambió nada', async () => {
    respuesta = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
    const e: any = await guardarPendientes('1', '1', [], [], null).catch(x => x);
    expect(e).toBeInstanceOf(ErrorPendientes);
    expect(e.status).toBe(503);
    expect(e.faltaMigracion).toBe(true);
    expect(e.message).toMatch(/055/);
  });

  it('🔑 al facturar, los renglones a mano pasan a la app sin duplicarse en un reintento', async () => {
    respuesta = { data: null, error: null };
    const r = await pasarPendientesDeIM('58954399', PR_59080, null);
    expect(r).toEqual({ pasados: 2 });
    const up = llamadas.find(l => l.op === 'upsert');
    expect(up.opciones).toEqual({ onConflict: 'tenant_id,im_comprobante_id,im_renglon_id', ignoreDuplicates: true });
    expect(up.filas.map((f: any) => [f.im_renglon_id, f.descripcion, f.cantidad])).toEqual([
      ['58955053', 'MAIZ LEALES 25 PENDIENTE', 10], ['58955066', 'MEZCLA GALLO PREM', 300],
    ]);
  });
  it('un presupuesto sin renglones a mano no toca la base', async () => {
    expect(await pasarPendientesDeIM('1', PR_59080.slice(0, 2), null)).toEqual({ pasados: 0 });
    expect(llamadas).toHaveLength(0);
  });
  it('si falla, lo dice: quien factura tiene que saber que no van a salir en el remito', async () => {
    respuesta = { data: null, error: { code: '08006', message: 'connection failure' } };
    expect(await pasarPendientesDeIM('1', PR_59080, null)).toEqual({ pasados: 0, error: 'connection failure' });
  });
  it('sin la migración no es una falla nueva: es como antes', async () => {
    respuesta = { data: null, error: { code: '42P01', message: 'relation does not exist' } };
    expect(await pasarPendientesDeIM('1', PR_59080, null)).toEqual({ pasados: 0 });
  });
});
