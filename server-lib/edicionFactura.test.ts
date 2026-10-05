import { describe, it, expect, vi } from 'vitest';
import {
  avanzarEdicion, movimientosDeStock, pasosDe, totalRenglones, mismosRenglones, decidirEdicion, validarRenglones,
  type Edicion, type DepsEdicion,
} from './edicionFactura.js';

/**
 * EDITAR UNA FACTURA = anular y volver a emitir factura y remito (30/09/2026).
 *
 * Jorgelina corrige las facturas en InfoManager porque "sólo edita la factura y listo", y el
 * remito queda como estaba: FAB 51031 y 51034 (pasta de maní cambiada) y FAA 1658 (sésamo que no
 * salió) dejaron el stock mal. La API de IM no edita renglones, así que "editar" es rehacer.
 */

const FA_VIEJA = { id: '58995098', numero: 51031, tipo: 'FA B', fecha: '2026-09-29' };
const RE_VIEJO = { id: '58995120', numero: 78304, fecha: '2026-09-29', punto_de_venta: 7 };
const R = (cod: number, cantidad: number, precio: number, descuento_porc = 0) => ({ cod_articulo: cod, cantidad, precio, descuento_porc });

function edicion(p: Partial<Edicion> = {}): Edicion {
  return {
    id: '11111111-1111-4111-8111-111111111111', im_comprobante_id: '58994539',
    rehace_factura: true, fa_vieja: FA_VIEJA, re_viejo: RE_VIEJO,
    renglones: [R(650, 12, 9936), R(685, 2, 34945.592)],
    datos: { cod_empresa: 1, cod_cliente: 753, cod_vendedor: 12, categoria_iva: 'CF', cod_lista_precios: 12, usuario: 'jorgelina', observaciones: 'Pedido 59242', origen_id: '58994539', cod_deposito: 1 } as any,
    motivo: 'cambio de pasta de maní', paso: 'anular_fa', estado: 'en_curso', error: null,
    fa_nueva: null, re_nuevo: null, hoja: null,
    ...p,
  };
}

function deps(over: Partial<DepsEdicion> = {}): DepsEdicion & { guardados: Edicion[] } {
  const guardados: Edicion[] = [];
  return {
    guardados,
    facturaAnulada: vi.fn(async () => false),
    anularFactura: vi.fn(async () => ({ ok: true as const })),
    emitirFactura: vi.fn(async () => ({ ok: true as const, id: '59100001', numero: 51100, tipo: 'FA B' })),
    renglonesDeFactura: vi.fn(async () => [R(650, 12, 9936), R(685, 2, 34945.592)]),
    emitirRemito: vi.fn(async () => ({ ok: true as const, id: '59100010', numero: 78500, tipo: 'RE' })),
    remitoAnulado: vi.fn(async () => false),
    anularRemito: vi.fn(async () => ({ ok: true as const })),
    reemplazarEnHoja: vi.fn(async () => ({ hoja: 3445 })),
    cerrarPedido: vi.fn(async () => {}),
    guardar: vi.fn(async (op: Edicion) => { guardados.push(JSON.parse(JSON.stringify(op))); }),
    ...over,
  };
}

describe('los pasos', () => {
  it('cambiando la factura: se anula la vieja ANTES de emitir la nueva, y el remito viejo se anula recién con el nuevo emitido', () => {
    expect(pasosDe(true)).toEqual(['anular_fa', 'emitir_fa', 'emitir_re', 'hoja', 'anular_re', 'cerrar']);
  });
  it('con la factura bien y el remito mal, sólo se rehace el remito', () => {
    expect(pasosDe(false)).toEqual(['emitir_re', 'hoja', 'anular_re', 'cerrar']);
  });
});

describe('avanzarEdicion', () => {
  it('camino completo: factura nueva, remito sacado de ELLA, hoja, remito viejo anulado y pedido cerrado', async () => {
    const d = deps();
    const op = await avanzarEdicion(edicion(), d);
    expect(op.estado).toBe('completo');
    expect(op.fa_nueva).toEqual({ id: '59100001', numero: 51100, tipo: 'FA B' });
    expect(op.re_nuevo).toEqual({ id: '59100010', numero: 78500 });
    // La factura nueva lleva la fecha de la vieja: el mes no cambia.
    expect(vi.mocked(d.emitirFactura).mock.calls[0][0]).toMatchObject({ fecha: '2026-09-29', total: 189123.18, cod_cliente: 753 });
    // El remito sale de los renglones de la factura NUEVA, con la fecha del remito viejo.
    expect(d.renglonesDeFactura).toHaveBeenCalledWith('59100001');
    expect(vi.mocked(d.emitirRemito).mock.calls[0][0]).toMatchObject({ fecha: '2026-09-29', im_factura_id: '59100001' });
    expect(d.anularRemito).toHaveBeenCalledWith(RE_VIEJO, expect.stringContaining('78500'));
    expect(d.cerrarPedido).toHaveBeenCalled();
  });

  it('🔴 la factura nueva va SIN el presupuesto en cod_compatibilidad: IM lo rechaza repetido aunque la vieja esté anulada', async () => {
    // FAB 51178, 05/10/2026: "Ya existe un comprobante con cod_compatibilidad = '59041796'".
    const d = deps();
    await avanzarEdicion(edicion(), d);
    expect(vi.mocked(d.emitirFactura).mock.calls[0][0].origen_id ?? null).toBeNull();
  });

  it('🔴 la factura nueva queda GUARDADA antes de pedir el remito: un corte ahí no la emite dos veces', async () => {
    const d = deps({ emitirRemito: vi.fn(async () => { throw new Error('se cayó la conexión'); }) });
    const op = await avanzarEdicion(edicion(), d);
    expect(op.estado).toBe('fallo');
    expect(op.paso).toBe('emitir_re');
    expect(d.guardados.some(g => g.fa_nueva?.numero === 51100 && g.paso === 'emitir_re')).toBe(true);

    // Reintento: sigue desde el remito, sin volver a anular ni a facturar.
    const d2 = deps();
    const fin = await avanzarEdicion({ ...op, estado: 'en_curso' }, d2);
    expect(fin.estado).toBe('completo');
    expect(d2.anularFactura).not.toHaveBeenCalled();
    expect(d2.emitirFactura).not.toHaveBeenCalled();
    expect(d2.renglonesDeFactura).toHaveBeenCalledWith('59100001');
  });

  it('🔴 si InfoManager no contesta al facturar, NO se sabe si salió: queda incierto y no sigue', async () => {
    const d = deps({ emitirFactura: vi.fn(async () => ({ ok: false as const, error: 'timeout', sinRespuesta: true })) });
    const op = await avanzarEdicion(edicion(), d);
    expect(op.estado).toBe('incierto');
    expect(op.paso).toBe('emitir_fa');
    expect(d.emitirRemito).not.toHaveBeenCalled();
    expect(d.anularRemito).not.toHaveBeenCalled();
  });

  it('un rechazo de InfoManager al facturar se puede reintentar: la vieja ya anulada no se anula de nuevo', async () => {
    const d = deps({ emitirFactura: vi.fn(async () => ({ ok: false as const, error: 'Ya existe una factura con...' })) });
    const op = await avanzarEdicion(edicion(), d);
    expect(op.estado).toBe('fallo');
    expect(op.paso).toBe('emitir_fa');
    expect(op.error).toContain('Ya existe');

    const d2 = deps({ facturaAnulada: vi.fn(async () => true) });
    const fin = await avanzarEdicion({ ...op, estado: 'en_curso' }, d2);
    expect(fin.estado).toBe('completo');
    expect(d2.anularFactura).not.toHaveBeenCalled();
  });

  it('si no se puede verificar que la factura vieja siga viva, no se toca nada', async () => {
    const d = deps({ facturaAnulada: vi.fn(async () => null) });
    const op = await avanzarEdicion(edicion(), d);
    expect(op.estado).toBe('fallo');
    expect(d.anularFactura).not.toHaveBeenCalled();
    expect(d.emitirFactura).not.toHaveBeenCalled();
  });

  it('sólo remito: no toca la factura y el remito sale de la factura vigente', async () => {
    const d = deps();
    const op = await avanzarEdicion(edicion({ rehace_factura: false, renglones: null, paso: 'emitir_re' }), d);
    expect(op.estado).toBe('completo');
    expect(d.anularFactura).not.toHaveBeenCalled();
    expect(d.emitirFactura).not.toHaveBeenCalled();
    expect(d.renglonesDeFactura).toHaveBeenCalledWith(FA_VIEJA.id);
    expect(vi.mocked(d.emitirRemito).mock.calls[0][0]).toMatchObject({ im_factura_id: FA_VIEJA.id });
  });

  it('un fallo en la hoja de ruta frena ANTES de anular el remito viejo: la entrega nunca queda sin remito', async () => {
    const d = deps({ reemplazarEnHoja: vi.fn(async () => { throw new Error('La hoja cambió'); }) });
    const op = await avanzarEdicion(edicion(), d);
    expect(op.estado).toBe('fallo');
    expect(op.paso).toBe('hoja');
    expect(d.anularRemito).not.toHaveBeenCalled();
  });

  it('el remito viejo ya anulado (reintento) no se vuelve a anular', async () => {
    const d = deps({ remitoAnulado: vi.fn(async () => true) });
    const op = await avanzarEdicion(edicion({ paso: 'anular_re', fa_nueva: { id: '59100001', numero: 51100, tipo: 'FA B' }, re_nuevo: { id: '59100010', numero: 78500 } }), d);
    expect(op.estado).toBe('completo');
    expect(d.anularRemito).not.toHaveBeenCalled();
  });

  it('la factura nueva que InfoManager no deja leer frena el remito', async () => {
    const d = deps({ renglonesDeFactura: vi.fn(async () => null) });
    const op = await avanzarEdicion(edicion(), d);
    expect(op.estado).toBe('fallo');
    expect(op.paso).toBe('emitir_re');
    expect(d.emitirRemito).not.toHaveBeenCalled();
  });
});

describe('movimientosDeStock', () => {
  it('FAB 51031: vuelven las 2 pastas de 3 kg y salen las 2 de 4 kg; lo que no cambia no se mueve', () => {
    const viejo = [R(650, 12, 9936), R(663, 2, 13313.17)];
    const nuevo = [R(650, 12, 9936), R(685, 2, 34945.592)];
    expect(movimientosDeStock(viejo, nuevo)).toEqual({
      vuelve: [{ cod_articulo: 663, cantidad: 2 }],
      sale: [{ cod_articulo: 685, cantidad: 2 }],
    });
  });
  it('FAA 1658: el costo de distribución no es mercadería, sólo vuelve el sésamo', () => {
    const viejo = [R(704, 60, 1685.24), R(405, 25, 2159.14), R(13819, 1, 20128)];
    const nuevo = [R(704, 60, 1685.24), R(13819, 1, 18509)];
    expect(movimientosDeStock(viejo, nuevo)).toEqual({ vuelve: [{ cod_articulo: 405, cantidad: 25 }], sale: [] });
  });
  it('un cambio de cantidad mueve sólo la diferencia', () => {
    expect(movimientosDeStock([R(1, 10, 5)], [R(1, 7, 5)])).toEqual({ vuelve: [{ cod_articulo: 1, cantidad: 3 }], sale: [] });
  });
});

describe('totales y comparación', () => {
  it('el total aplica el descuento de cada renglón y redondea a centavos', () => {
    expect(totalRenglones([R(351, 10, 12453.72, 35)])).toBe(80949.18);
  });
  it('mismosRenglones compara por artículo, cantidad y neto; el orden no importa', () => {
    expect(mismosRenglones([R(1, 2, 10), R(2, 1, 5)], [R(2, 1, 5), R(1, 2, 10)])).toBe(true);
    // Mismo neto con precio neto y descuento 0 (remito masivo) que con bruto y descuento.
    expect(mismosRenglones([R(351, 10, 8094.918)], [R(351, 10, 12453.72, 35)])).toBe(true);
    expect(mismosRenglones([R(1, 2, 10)], [R(1, 3, 10)])).toBe(false);
    expect(mismosRenglones([R(1, 2, 10)], [R(1, 2, 10), R(2, 1, 5)])).toBe(false);
  });
});

describe('decidirEdicion — qué hay que rehacer', () => {
  const factura = [R(650, 12, 9936), R(685, 2, 34945.592)];
  const remitoViejo = [R(650, 12, 9936), R(663, 2, 13313.17)];

  it('los casos del 29/09: la factura está bien y el remito no → sólo el remito, sin tocar la factura', () => {
    expect(decidirEdicion(factura, remitoViejo, null)).toEqual({ rehace_factura: false, remito_difiere: true, finales: factura });
    // Mandar los mismos renglones que ya tiene la factura es lo mismo que no mandar nada.
    expect(decidirEdicion(factura, remitoViejo, factura.map(r => ({ ...r })))).toMatchObject({ rehace_factura: false, remito_difiere: true });
  });

  it('cambiar la factura rehace los dos; el remito se compara contra la factura NUEVA', () => {
    const nuevos = [R(650, 10, 9936), R(685, 2, 34945.592)];
    expect(decidirEdicion(factura, factura, nuevos)).toEqual({ rehace_factura: true, remito_difiere: true, finales: nuevos });
  });

  it('sin cambios en ninguno de los dos no hay nada que hacer', () => {
    expect(decidirEdicion(factura, factura, null)).toMatchObject({ rehace_factura: false, remito_difiere: false });
  });
});

describe('validarRenglones', () => {
  it('saca los renglones en cantidad 0 (así se da de baja un producto) y normaliza los números', () => {
    expect(validarRenglones([{ cod_articulo: '650', cantidad: '12', precio: '9936', descuento_porc: null }, { cod_articulo: 405, cantidad: 0, precio: 2159.14 }]))
      .toEqual([{ cod_articulo: 650, cantidad: 12, precio: 9936, descuento_porc: 0, iva_por: undefined, cod_lista_precios: null, descripcion: undefined }]);
  });
  it.each([
    ['sin artículo', [{ cod_articulo: 0, cantidad: 1, precio: 1 }]],
    ['precio sin consultar', [{ cod_articulo: 1, cantidad: 1, precio: null }]],
    ['descuento de más de 100%', [{ cod_articulo: 1, cantidad: 1, precio: 1, descuento_porc: 120 }]],
    ['cantidad negativa', [{ cod_articulo: 1, cantidad: -1, precio: 1 }]],
    ['el mismo artículo a dos precios', [{ cod_articulo: 1, cantidad: 1, precio: 1 }, { cod_articulo: 1, cantidad: 1, precio: 2 }]],
  ])('rechaza %s', (_n, rs) => {
    expect(() => validarRenglones(rs)).toThrow();
  });
  it('rechaza una factura que queda vacía: eso es anularla, no editarla', () => {
    expect(() => validarRenglones([{ cod_articulo: 1, cantidad: 0, precio: 1 }])).toThrow(/anul/i);
  });
  it('el mismo artículo repetido al mismo precio se suma en un renglón', () => {
    expect(validarRenglones([{ cod_articulo: 1, cantidad: 1, precio: 5 }, { cod_articulo: 1, cantidad: 2, precio: 5 }]))
      .toMatchObject([{ cod_articulo: 1, cantidad: 3, precio: 5 }]);
  });
});
