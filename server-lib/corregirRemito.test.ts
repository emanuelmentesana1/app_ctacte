import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Corregir el remito de una entrega (Mati, 06/10/2026, opción 2 para DIAZ en la hoja 3402): el RE 77382
 * se borró en IM y la mercadería salió con el RE 77399. Admin o gerente, con motivo, y validando contra
 * IM que el remito nuevo exista y sea del mismo cliente. 🔴 No cambia lo que se le paga al chofer: mismo
 * importe y mismas notas, o no se toca nada.
 */

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

const m = vi.hoisted(() => ({
  sbMock: vi.fn(), rpc: vi.fn(), ventas: vi.fn(), cab: vi.fn(),
  columnaError: null as any, hoja: null as any, tablas: {} as Record<string, any>,
}));
vi.mock('./supabase.js', () => ({ sb: m.sbMock, TENANT_ID: 'test-tenant', hasSupabase: () => true }));
vi.mock('./infomanager.js', async (orig) => ({ ...(await orig() as any), fetchVentas: m.ventas, cabeceraComprobante: m.cab }));

const { corregirRemitoEntrega } = await import('./hojasRuta.js');

function fakeSb() {
  m.sbMock.mockImplementation(() => ({
    from: (t: string) => {
      const res = t === 'hojas_ruta_pedidos' ? { data: [], error: m.columnaError } : m.tablas[t] ?? { data: [], error: null };
      const q: any = { then: (r: any, j: any) => Promise.resolve(res).then(r, j), maybeSingle: () => Promise.resolve({ data: m.hoja, error: null }) };
      for (const k of ['select', 'eq', 'or', 'in', 'not', 'order', 'range', 'limit']) q[k] = () => q;
      return q;
    },
    rpc: m.rpc,
  }));
}

function llamar({ rol = 'admin', body = {} as any } = {}) {
  let status = 200; let out: any;
  const req: any = { user: { rol, sub: 'u-mati' }, params: { id: 'h1', comprobanteId: '58783918' }, body, query: {} };
  const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => { out = b; } };
  return corregirRemitoEntrega(req, res).then(() => ({ status, body: out }));
}

const diaz = { id: 'p1', hoja_id: 'h1', im_comprobante_id: '58783918', im_numero: 77382, im_remito_id: '58783918', im_remito_numero: 77382,
  cod_cliente: 812, cliente_nombre: 'DIAZ, Alfredo (Este)', total: 2682199.99, fecha: '2026-09-09', im_factura_id: null, remito_historial: [] };
const otra = { id: 'p2', hoja_id: 'h1', im_comprobante_id: '58786004', im_numero: 77405, im_remito_id: '58786004', cod_cliente: 500, total: 1000, fecha: '2026-09-09', remito_historial: [] };
const re77399 = { id: 58785809, tipo_comprobante: 'RE', numero: 77399, punto_de_venta: 7, cod_empresa: 1, cod_cliente: 812, total: 2682199.99, fecha: '2026-09-10', anulada: 'N' };
const cabecera = { existe: true, anulada: false, tipo_comprobante: 'RE', numero: 77399, cod_cliente: 812, cod_empresa: 1, total: 2682199.99, fecha: '2026-09-10' };
const pedido = { remito_numero: '77399', motivo: '  el RE 77382 se borró en IM;  salió con el RE 77399 ', version_esperada: 6 };

beforeEach(() => {
  vi.clearAllMocks(); m.columnaError = null;
  m.hoja = { id: 'h1', numero: 3402, fecha: '2026-09-09', estado: 'cerrada', version: 6, hojas_ruta_pedidos: [diaz, otra],
    cierres_importes: [{ pedidos: [{ im_comprobante_id: '58783918', cod_cliente: 812, total: 2682199.99 }, { im_comprobante_id: '58786004', cod_cliente: 500, total: 1000 }] }] };
  // El RE 77399 lo emitió la app para el presupuesto de DIAZ, con su factura.
  m.tablas = { presupuestos_facturados: { data: [{ im_comprobante_id: '58782979', im_remito_id: '58785809', im_factura_id: '58783805', cod_cliente: 812,
    cod_empresa: 1, total: 2682199.99, facturado_at: '2026-09-09', estado_emision: 'completo' }], error: null } };
  m.ventas.mockResolvedValue([{ ...re77399, id: 58785808, tipo_comprobante: 'FA', numero: 77399, cod_cliente: 9 }, re77399]);
  m.cab.mockResolvedValue(cabecera);
  m.rpc.mockResolvedValue({ data: { version: 7, im_comprobante_id: '58785809', remito_numero: 77399 }, error: null });
  fakeSb();
});

describe('corregir el remito de una entrega', () => {
  it('🔴 la entrega pasa a ser el remito nuevo: busca el RE en IM, lo verifica y manda clave vieja, remito nuevo, motivo y versión', async () => {
    const r = await llamar({ body: pedido });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, version: 7, im_comprobante_id: '58785809' });
    // Una semana antes y una después de la hoja: el remito se rehace cerca del día del reparto.
    expect(m.ventas).toHaveBeenCalledWith('2026-09-02', '2026-09-16');
    expect(m.cab).toHaveBeenCalledWith('58785809');
    expect(m.rpc).toHaveBeenCalledWith('corregir_remito_entrega', { p_tenant: 'test-tenant', p_actor: 'u-mati', p_datos: {
      hoja_id: 'h1', im_comprobante_id: '58783918', remito_id: '58785809', remito_numero: 77399, remito_fecha: '2026-09-10',
      motivo: 'el RE 77382 se borró en IM; salió con el RE 77399', version_esperada: 6 } });
  });

  it('🔴 sólo admin y gerente, y siempre con número y motivo', async () => {
    expect((await llamar({ rol: 'administrativo', body: pedido })).status).toBe(403);
    expect((await llamar({ body: { ...pedido, remito_numero: 'RE 77399' } })).status).toBe(400);
    expect((await llamar({ body: { ...pedido, motivo: ' ' } })).status).toBe(400);
    expect(m.ventas).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('🔴 sin la migración 058 avisa y no pregunta a IM', async () => {
    m.columnaError = { code: '42703', message: 'column hojas_ruta_pedidos.remito_historial does not exist' };
    vi.resetModules();
    const { corregirRemitoEntrega: fresco } = await import('./hojasRuta.js');
    let status = 200; let out: any;
    const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => { out = b; } };
    await fresco({ user: { rol: 'admin', sub: 'u' }, params: { id: 'h1', comprobanteId: '58783918' }, body: pedido, query: {} } as any, res);
    expect(status).toBe(503);
    expect(out.error).toMatch(/058/);
    expect(m.ventas).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('si la hoja cambió desde que se abrió la pantalla, frena antes de ir a IM', async () => {
    const r = await llamar({ body: { ...pedido, version_esperada: 5 } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/cambió/);
    expect(m.ventas).not.toHaveBeenCalled();
  });

  it('🔴 un remito que no está en IM, que está anulado o que es de otro cliente no se acepta', async () => {
    m.ventas.mockResolvedValue([]);
    let r = await llamar({ body: pedido });
    expect(r.status).toBe(409); expect(r.body.error).toMatch(/No encontré el RE 77399/);

    m.ventas.mockResolvedValue([{ ...re77399, anulada: 'S' }]);
    r = await llamar({ body: pedido });
    expect(r.status).toBe(409); expect(r.body.error).toMatch(/anulado/);

    m.ventas.mockResolvedValue([re77399]);
    m.cab.mockResolvedValue({ ...cabecera, cod_cliente: 125 });
    r = await llamar({ body: pedido });
    expect(r.status).toBe(409); expect(r.body.error).toMatch(/otro cliente|cliente 125/);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('si IM no contesta, lo dice y no toca nada', async () => {
    m.cab.mockResolvedValue({ ...cabecera, existe: null, anulada: null });
    const r = await llamar({ body: pedido });
    expect(r.status).toBe(502);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('🔴 un remito por otro importe no se acepta: corregir el remito no cambia lo que se paga', async () => {
    m.cab.mockResolvedValue({ ...cabecera, total: 2600000 });
    const r = await llamar({ body: pedido });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/importe/);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('🔴 en una hoja cerrada compara contra lo confirmado al cierre, no contra la fila', async () => {
    m.hoja.cierres_importes[0].pedidos[0].total = 2600000;
    m.cab.mockResolvedValue({ ...cabecera, total: 2600000 });
    expect((await llamar({ body: pedido })).status).toBe(200);
  });

  it('🔴 si con el remito nuevo la entrega quedara con otras notas (NC/ND), no se corrige', async () => {
    // La factura del remito nuevo tiene una NC: la liquidación pasaría a descontarla.
    m.tablas.facturas_correcciones = { data: [{ im_factura_id: '58783805', im_comprobante_id: '58790000', tipo: 'NC B', total: 5000, numero: 30100 }], error: null };
    const r = await llamar({ body: pedido });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/notas/);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('una entrega de las hojas armadas con presupuestos (antes del 08/09) no se corrige desde acá', async () => {
    m.hoja.hojas_ruta_pedidos = [{ ...diaz, im_remito_id: '58785555' }, otra];
    const r = await llamar({ body: pedido });
    expect(r.status).toBe(409);
    expect(m.ventas).not.toHaveBeenCalled();
  });

  it('lo que frena la base (el remito ya está en otra hoja) llega con su mensaje', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'El remito 77399 ya está en la hoja 3410' } });
    const r = await llamar({ body: pedido });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/3410/);
  });
});
