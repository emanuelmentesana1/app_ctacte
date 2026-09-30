import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * POST /api/facturacion/editar. La secuencia y sus cortes se prueban en edicionFactura.test.ts;
 * acá, lo que decide si se puede editar y lo que queda escrito. El caso de ejemplo es real: la
 * FAB 51031 (29/09/2026), editada en IM de Pasta de maní 3 kg a 4 kg con el remito sin tocar.
 */

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

const m = vi.hoisted(() => ({
  comprobantes: {} as Record<string, { cabecera: any; items: any[] }>,
  anularConservandoCabecera: vi.fn(),
  anularComprobante: vi.fn(),
  comprobantesPendientesCliente: vi.fn(),
  emitirFactura: vi.fn(),
  emitirRemito: vi.fn(),
  emitirRemitoMasivo: vi.fn(),
  rpc: vi.fn(),
  sbMock: vi.fn(),
}));

vi.mock('./infomanager.js', () => ({
  leerComprobante: async (id: string) => {
    const c = m.comprobantes[id];
    if (!c) throw new Error(`no existe ${id}`);
    return { cabecera: c.cabecera, items: c.items, crudos: [], idDevuelto: id };
  },
  cabeceraComprobante: async (id: string) => m.comprobantes[id]?.cabecera ?? { existe: false },
  anularConservandoCabecera: m.anularConservandoCabecera,
  anularComprobante: m.anularComprobante,
  comprobantesPendientesCliente: m.comprobantesPendientesCliente,
  fetchArticulosCatalogo: async () => new Map([
    [650, { descripcion: 'MANI C/ CHOCOLATE', equivalencia_um: 1 }],
    [663, { descripcion: 'PASTA DE MANI NATURAL X 3K', equivalencia_um: 3 }],
    [685, { descripcion: 'PASTA DE MANI NATURAL 4KG x 2u', equivalencia_um: 8 }],
  ]),
  fetchClientesIMCon: async () => [{ cod_cliente: 753, categoria_iva: 'CF' }],
  invalidarIM: vi.fn(),
}));
vi.mock('./facturarIM.js', async (original) => ({
  ...(await original<any>()),
  emitirFactura: m.emitirFactura, emitirRemito: m.emitirRemito, emitirRemitoMasivo: m.emitirRemitoMasivo,
}));
vi.mock('./facturarPresupuestos.js', () => ({
  frenaSiNoPuede: (req: any, res: any) => { if (req.user.rol === 'vendedor') { res.status(403).json({ error: 'no' }); return true; } return false; },
  articulosSinStockDelError: () => null,
}));
vi.mock('./pedidos.js', () => ({ usuarioIM: vi.fn(async () => 'jorgelina') }));
vi.mock('./vistaPresupuestos.js', () => ({ invalidarVista: vi.fn() }));
vi.mock('./vistaRemitos.js', () => ({ invalidarRemitos: vi.fn() }));
vi.mock('./supabase.js', () => ({ sb: m.sbMock, TENANT_ID: 'test-tenant', hasSupabase: () => true }));

const { editarFactura } = await import('./editarFactura.js');

// ── Base falsa: cada tabla contesta lo que el test dice, y se anota todo lo que se escribe. ──
let lecturas: Record<string, any> = {};
let unaFila: Record<string, any> = {};
let escrituras: Array<{ tabla: string; op: string; valor: any; filtros: any[] }> = [];
let filasDelUpdate: Record<string, any[]> = {};

function fakeSb() {
  m.sbMock.mockImplementation(() => ({
    rpc: m.rpc,
    from: (t: string) => {
      let actual: { op: string; valor: any; filtros: any[] } | null = null;
      const q: any = {
        then: (r: any, j: any) => Promise.resolve(actual ? { data: null, error: null } : (lecturas[t] ?? { data: [], error: null })).then(r, j),
        maybeSingle: () => Promise.resolve(unaFila[t] ?? { data: null, error: null }),
        select: () => actual?.op === 'update' ? Promise.resolve({ data: filasDelUpdate[t] ?? [{}], error: null }) : q,
        insert: (v: any) => { actual = { op: 'insert', valor: v, filtros: [] }; escrituras.push({ tabla: t, ...actual }); return q; },
        update: (v: any) => { actual = { op: 'update', valor: v, filtros: [] }; escrituras.push({ tabla: t, ...actual }); return q; },
        delete: () => { actual = { op: 'delete', valor: null, filtros: [] }; escrituras.push({ tabla: t, ...actual }); return q; },
      };
      for (const k of ['eq', 'in', 'neq', 'limit', 'is', 'not', 'order']) q[k] = (...a: any[]) => { actual?.filtros.push([k, ...a]); return q; };
      return q;
    },
  }));
}

function llamar(body: any, rol = 'administrativo') {
  let status = 200; let out: any;
  const req: any = { user: { rol, sub: '00000000-0000-0000-0000-0000000000aa' }, body };
  const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => { out = b; } };
  return editarFactura(req, res).then(() => ({ status, body: out }));
}

const it_ = (cod: number, cantidad: number, precio: number, descuento_porc = 0) =>
  ({ cod_articulo: cod, cantidad, precio: precio * (1 - descuento_porc / 100), precio_orig: precio, descuento_porc, iva_por: 0, cod_lista_precios: 12, detalle: null });
const cab = (p: any) => ({ existe: true, anulada: false, cod_empresa: 1, cod_cliente: 753, cod_vendedor: 12, cod_lista_precios: 12, observaciones: 'Pedido 59242', ...p });

const FILA = { im_comprobante_id: '58994539', cod_cliente: 753, cod_empresa: 1, im_factura_id: '58995098', im_factura_numero: 51031, im_factura_tipo: 'FA B', im_remito_id: '58995120', im_remito_numero: 78304, estado_emision: 'completo' };
// Dos de los siete renglones de la factura real: alcanzan para el caso y las cuentas se siguen a mano.
const FACTURA = [it_(650, 12, 9936), it_(685, 2, 34945.592)];

beforeEach(() => {
  vi.clearAllMocks();
  escrituras = []; filasDelUpdate = {};
  m.comprobantes = {
    '58995098': { cabecera: cab({ tipo_comprobante: 'FA', tipo_factura: 'B', numero: 51031, fecha: '2026-09-29', total: 323066.70, punto_de_venta: 777 }), items: FACTURA },
    '58995120': { cabecera: cab({ tipo_comprobante: 'RE', tipo_factura: 'X', numero: 78304, fecha: '2026-09-29', total: 279801.86, punto_de_venta: 7 }), items: [it_(650, 12, 9936), it_(663, 2, 13313.17)] },
  };
  unaFila = { presupuestos_facturados: { data: FILA, error: null } };
  lecturas = { facturas_correcciones: { data: [], error: null }, hojas_ruta_ajustes: { data: [], error: null }, hojas_ruta_pedidos: { data: [{ hojas_ruta: { numero: 3440, estado: 'abierta' } }], error: null } };
  m.comprobantesPendientesCliente.mockResolvedValue([{ id: '58995098', saldo: 323066.70 }]);
  m.anularConservandoCabecera.mockImplementation(async (id: string) => { m.comprobantes[id].cabecera = { ...m.comprobantes[id].cabecera, anulada: true }; return { ok: true }; });
  m.anularComprobante.mockImplementation(async ({ id }: any) => { m.comprobantes[id].cabecera = { ...m.comprobantes[id].cabecera, anulada: true }; return { ok: true, raw: null }; });
  m.emitirFactura.mockImplementation(async (d: any) => {
    m.comprobantes['59100001'] = { cabecera: cab({ tipo_comprobante: 'FA', tipo_factura: 'B', numero: 51100, fecha: d.fecha, total: d.total }), items: d.items.map((r: any) => it_(r.cod_articulo, r.cantidad, r.precio, r.descuento_porc ?? 0)) };
    return { ok: true, id: '59100001', numero: 51100, tipo: 'FA B' };
  });
  m.emitirRemito.mockResolvedValue({ ok: true, id: '59100010', numero: 78500, tipo: 'RE' });
  m.rpc.mockResolvedValue({ data: { ok: true, hoja: 3440 }, error: null });
  fakeSb();
});

describe('previsualizar (no toca nada)', () => {
  it('FAB 51031: la factura está bien → sólo se rehace el remito; vuelven las pastas de 3 kg y salen las de 4 kg', async () => {
    const r = await llamar({ im_factura_id: '58995098' });
    expect(r.status).toBe(200);
    expect(r.body.previsualizacion).toMatchObject({
      rehace_factura: false,
      remito: { numero: 78304, total_actual: 279801.86, total_nuevo: 189123.18 },
      vuelve: [{ cod_articulo: 663, cantidad: 2, descripcion: 'PASTA DE MANI NATURAL X 3K' }],
      sale: [{ cod_articulo: 685, cantidad: 2, descripcion: 'PASTA DE MANI NATURAL 4KG x 2u' }],
      hoja: 3440,
    });
    // Sin tocar la factura no hace falta mirar pagos, y no se escribe NADA.
    expect(m.comprobantesPendientesCliente).not.toHaveBeenCalled();
    expect(escrituras).toEqual([]);
    expect(m.emitirRemito).not.toHaveBeenCalled();
  });

  it('una factura que no salió de la app no se edita: no tiene pedido ni remito registrados', async () => {
    unaFila.presupuestos_facturados = { data: null, error: null };
    const r = await llamar({ im_factura_id: '58995098' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/no salió de la app/);
  });

  it('sin cambios en la factura y con el remito igual, no hay nada que hacer', async () => {
    m.comprobantes['58995120'].items = FACTURA;
    const r = await llamar({ im_factura_id: '58995098' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/nada que cambiar/);
  });

  it('🔴 cambiar una factura con plata cobrada no se deja: el recibo quedaría colgando de una anulada', async () => {
    m.comprobantesPendientesCliente.mockResolvedValue([{ id: '58995098', saldo: 23066.70 }]);
    const r = await llamar({ im_factura_id: '58995098', renglones: [{ cod_articulo: 650, cantidad: 10, precio: 9936 }, { cod_articulo: 685, cantidad: 2, precio: 34945.592 }] });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/300\.000 cobrados/);
  });

  it('con notas de crédito o débito encima, se sigue corrigiendo con notas', async () => {
    lecturas.facturas_correcciones = { data: [{ tipo: 'NC', numero: 1234 }], error: null };
    const r = await llamar({ im_factura_id: '58995098' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/NC 1234/);
  });

  it('con la hoja de ruta cerrada no se toca: ya se liquidó', async () => {
    lecturas.hojas_ruta_pedidos = { data: [{ hojas_ruta: { numero: 3400, estado: 'cerrada' } }], error: null };
    const r = await llamar({ im_factura_id: '58995098' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/hoja 3400/);
  });

  it('🔴 un renglón escrito a mano con plata frena: la factura nueva saldría por menos', async () => {
    m.comprobantes['58995098'].items = [...FACTURA, { cod_articulo: 0, cantidad: 1, precio: 5000, precio_orig: 5000, descuento_porc: 0, detalle: 'FLETE' }];
    const r = await llamar({ im_factura_id: '58995098' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/FLETE/);
  });

  it('los vendedores no editan facturas', async () => {
    const r = await llamar({ im_factura_id: '58995098' }, 'vendedor');
    expect(r.status).toBe(403);
  });
});

describe('confirmar', () => {
  it('sólo remito: se anota ANTES de tocar IM, el remito sale de la factura y el viejo se anula al final', async () => {
    const orden: string[] = [];
    m.emitirRemito.mockImplementation(async () => { orden.push('emitir_re'); return { ok: true, id: '59100010', numero: 78500, tipo: 'RE' }; });
    m.rpc.mockImplementation(async () => { orden.push('hoja'); return { data: { ok: true, hoja: 3440 }, error: null }; });
    m.anularComprobante.mockImplementation(async ({ id }: any) => { orden.push('anular_re'); m.comprobantes[id].cabecera = { ...m.comprobantes[id].cabecera, anulada: true }; return { ok: true }; });

    const r = await llamar({ im_factura_id: '58995098', confirmar: true, motivo: 'pasta de 4 kg' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, estado: 'completo', remito_nuevo: { numero: 78500 }, factura_nueva: null, hoja: 3440 });
    expect(orden).toEqual(['emitir_re', 'hoja', 'anular_re']);
    expect(m.anularConservandoCabecera).not.toHaveBeenCalled();
    expect(m.emitirFactura).not.toHaveBeenCalled();

    // El registro de la edición es lo primero que se escribe, y el pedido queda "editando" mientras dura.
    expect(escrituras[0]).toMatchObject({ tabla: 'facturas_ediciones', op: 'insert' });
    expect(escrituras[1]).toMatchObject({ tabla: 'presupuestos_facturados', op: 'update', valor: { estado_emision: 'editando' } });
    // El remito lleva los renglones de la factura y la fecha del remito viejo.
    expect(m.emitirRemito.mock.calls[0][0]).toMatchObject({ fecha: '2026-09-29', im_factura_id: '58995098', cod_cliente: 753, usuario: 'jorgelina' });
    expect(m.emitirRemito.mock.calls[0][0].items.map((i: any) => i.cod_articulo)).toEqual([650, 685]);
    // La hoja recibe el remito nuevo en lugar del viejo.
    expect(m.rpc).toHaveBeenCalledWith('reemplazar_remito_en_hoja', expect.objectContaining({
      p_datos: expect.objectContaining({ remito_viejo: '58995120', remito_nuevo: '59100010', pedido: '58994539', total: 189123.18, kg: 28 }),
    }));
    // Y el pedido cierra apuntando al remito nuevo, con el viejo en el historial.
    const cierre = escrituras.filter(e => e.tabla === 'presupuestos_facturados' && e.op === 'update').at(-1)!;
    expect(cierre.valor).toMatchObject({ im_remito_id: '59100010', im_remito_numero: 78500, estado_emision: 'completo', historial_remitos: [{ id: '58995120', numero: 78304 }] });
    expect(cierre.filtros).toContainEqual(['eq', 'estado_emision', 'editando']);
  });

  it('cambiando la factura: anula la vieja, emite la nueva con la MISMA fecha y el remito sale de la nueva', async () => {
    const renglones = [{ cod_articulo: 650, cantidad: 10, precio: 9936 }, { cod_articulo: 685, cantidad: 2, precio: 34945.592 }];
    const r = await llamar({ im_factura_id: '58995098', confirmar: true, renglones, motivo: 'bajan 2 maní' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, factura_nueva: { numero: 51100 }, remito_nuevo: { numero: 78500 } });
    expect(m.anularConservandoCabecera).toHaveBeenCalledWith('58995098', expect.stringContaining('bajan 2 maní'));
    expect(m.emitirFactura.mock.calls[0][0]).toMatchObject({ fecha: '2026-09-29', total: 169251.18, cod_vendedor: 12, categoria_iva: 'CF', observaciones: 'Pedido 59242 - reemplaza a la FA B 51031' });
    expect(m.emitirRemito.mock.calls[0][0]).toMatchObject({ im_factura_id: '59100001' });
    const cierre = escrituras.filter(e => e.tabla === 'presupuestos_facturados' && e.op === 'update').at(-1)!;
    expect(cierre.valor).toMatchObject({ im_factura_id: '59100001', im_factura_numero: 51100, historial_facturas: [{ id: '58995098', numero: 51031 }] });
  });

  it('retoma la edición que quedó a mitad de camino sin volver a facturar', async () => {
    unaFila.facturas_ediciones = { data: { datos: {
      id: '11111111-1111-4111-8111-111111111111', im_comprobante_id: '58994539', rehace_factura: true,
      fa_vieja: { id: '58995098', numero: 51031, tipo: 'FA B', fecha: '2026-09-29' },
      re_viejo: { id: '58995120', numero: 78304, fecha: '2026-09-29', punto_de_venta: 7 },
      renglones: FACTURA, datos: { cod_empresa: 1, cod_cliente: 753, cod_vendedor: 12, usuario: 'jorgelina' },
      motivo: 'x', paso: 'emitir_re', estado: 'fallo', error: 'se cortó', fa_nueva: { id: '59100001', numero: 51100, tipo: 'FA B' }, re_nuevo: null, hoja: null,
    } }, error: null };
    m.comprobantes['59100001'] = { cabecera: cab({ tipo_comprobante: 'FA', numero: 51100, fecha: '2026-09-29' }), items: FACTURA };
    const r = await llamar({ im_factura_id: '58995098', confirmar: true });
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('completo');
    expect(m.emitirFactura).not.toHaveBeenCalled();
    expect(m.anularConservandoCabecera).not.toHaveBeenCalled();
    expect(m.emitirRemito.mock.calls[0][0]).toMatchObject({ im_factura_id: '59100001' });
  });

  it('si IM rechaza el primer paso y no se cambió nada, la edición se cancela sola y el pedido vuelve a como estaba', async () => {
    m.emitirRemito.mockResolvedValue({ ok: false, error: 'No se puede crear el remito' });
    const r = await llamar({ im_factura_id: '58995098', confirmar: true });
    expect(r.status).toBe(409);
    expect(r.body.estado).toBe('cancelada');
    expect(r.body.error).toMatch(/No se cambió nada/);
    const vuelta = escrituras.filter(e => e.tabla === 'presupuestos_facturados' && e.op === 'update').at(-1)!;
    expect(vuelta.valor).toEqual({ estado_emision: 'completo' });
    expect(vuelta.filtros).toContainEqual(['eq', 'estado_emision', 'editando']);
    expect(escrituras.some(e => e.tabla === 'facturas_ediciones' && e.op === 'update' && e.valor.estado === 'cancelada')).toBe(true);
    expect(m.anularComprobante).not.toHaveBeenCalled();
  });

  it('con la factura vieja ya anulada NO se cancela: hay que terminarla', async () => {
    const renglones = [{ cod_articulo: 650, cantidad: 10, precio: 9936 }, { cod_articulo: 685, cantidad: 2, precio: 34945.592 }];
    m.emitirFactura.mockResolvedValue({ ok: false, error: 'Ya existe una factura con...' });
    const r = await llamar({ im_factura_id: '58995098', confirmar: true, renglones });
    expect(r.status).toBe(502);
    expect(r.body.estado).toBe('fallo');
    expect(r.body.paso).toBe('emitir_fa');
    expect(escrituras.some(e => e.tabla === 'facturas_ediciones' && e.valor?.estado === 'cancelada')).toBe(false);
  });

  it('🔴 una edición incierta NO se reintenta sola', async () => {
    unaFila.facturas_ediciones = { data: { datos: { estado: 'incierto', paso: 'emitir_fa', error: 'InfoManager no contestó', fa_vieja: { numero: 51031 }, re_viejo: { numero: 78304 } } }, error: null };
    const r = await llamar({ im_factura_id: '58995098', confirmar: true });
    expect(r.status).toBe(409);
    expect(m.emitirFactura).not.toHaveBeenCalled();
    expect(m.emitirRemito).not.toHaveBeenCalled();
  });

  it('si otra persona ya está editando el mismo pedido, choca con el registro y no toca nada', async () => {
    m.sbMock.mockImplementation(() => ({
      rpc: m.rpc,
      from: (t: string) => {
        const q: any = {
          then: (r: any, j: any) => Promise.resolve(lecturas[t] ?? { data: [], error: null }).then(r, j),
          maybeSingle: () => Promise.resolve(unaFila[t] ?? { data: null, error: null }),
          insert: () => ({ then: (r: any, j: any) => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate' } }).then(r, j) }),
        };
        for (const k of ['select', 'eq', 'in', 'neq', 'limit']) q[k] = () => q;
        return q;
      },
    }));
    const r = await llamar({ im_factura_id: '58995098', confirmar: true });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/edición en curso/);
    expect(m.emitirRemito).not.toHaveBeenCalled();
  });
});
