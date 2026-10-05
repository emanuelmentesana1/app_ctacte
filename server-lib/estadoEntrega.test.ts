import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * «No salió» (05/10/2026). Cambia lo que se le paga a un chofer, también en hojas cerradas: por eso
 * sólo lo marcan admin y gerente, siempre con motivo, y sin la migración 057 no se toca nada.
 */

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

const m = vi.hoisted(() => ({ sbMock: vi.fn(), columnaError: null as any, rpc: vi.fn() }));
vi.mock('./supabase.js', () => ({ sb: m.sbMock, TENANT_ID: 'test-tenant', hasSupabase: () => true }));

const { marcarEstadoEntrega } = await import('./hojasRuta.js');

function fakeSb() {
  m.sbMock.mockImplementation(() => ({
    from: () => {
      const q: any = { then: (r: any, j: any) => Promise.resolve({ data: [], error: m.columnaError }).then(r, j) };
      for (const k of ['select', 'limit', 'eq']) q[k] = () => q;
      return q;
    },
    rpc: m.rpc,
  }));
}

function llamar({ rol = 'admin', body = {} as any } = {}) {
  let status = 200; let out: any;
  const req: any = { user: { rol, sub: 'u-mati' }, params: { id: 'h1', comprobanteId: '58784016' }, body, query: {} };
  const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => { out = b; } };
  return marcarEstadoEntrega(req, res).then(() => ({ status, body: out }));
}

beforeEach(() => { vi.clearAllMocks(); m.columnaError = null; m.rpc.mockResolvedValue({ data: { version: 8, estado: 'no_salio' }, error: null }); fakeSb(); });

describe('marcar «no salió»', () => {
  it('🔴 sólo admin y gerente: un administrativo no lo puede marcar', async () => {
    const r = await llamar({ rol: 'administrativo', body: { estado: 'no_salio', motivo: 'remito anulado', version_esperada: 7 } });
    expect(r.status).toBe(403);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('🔴 sin motivo no se marca', async () => {
    const r = await llamar({ body: { estado: 'no_salio', motivo: ' ', version_esperada: 7 } });
    expect(r.status).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('un estado desconocido se rechaza', async () => {
    const r = await llamar({ body: { estado: 'parcial', motivo: 'algo', version_esperada: 7 } });
    expect(r.status).toBe(400);
  });

  it('🔴 sin la migración 057 avisa y no toca nada', async () => {
    m.columnaError = { code: '42703', message: 'column hojas_ruta_pedidos.estado_entrega does not exist' };
    vi.resetModules();
    const { marcarEstadoEntrega: fresco } = await import('./hojasRuta.js');
    let status = 200; let out: any;
    const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => { out = b; } };
    await fresco({ user: { rol: 'admin', sub: 'u' }, params: { id: 'h1', comprobanteId: '1' }, body: { estado: 'no_salio', motivo: 'xyz', version_esperada: 1 }, query: {} } as any, res);
    expect(status).toBe(503);
    expect(out.error).toMatch(/057/);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('🔴 marca con la hoja, la entrega, el motivo y la versión que se vio', async () => {
    const r = await llamar({ body: { estado: 'no_salio', motivo: '  remito anulado 29/09,  no salió ', version_esperada: 7 } });
    expect(r.status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith('marcar_estado_entrega', { p_tenant: 'test-tenant', p_actor: 'u-mati', p_datos: {
      hoja_id: 'h1', im_comprobante_id: '58784016', estado: 'no_salio', motivo: 'remito anulado 29/09, no salió', version_esperada: 7 } });
    expect(r.body).toMatchObject({ ok: true, version: 8 });
  });

  it('deshacer manda estado null y sin motivo', async () => {
    m.rpc.mockResolvedValue({ data: { version: 9, estado: null }, error: null });
    const r = await llamar({ body: { estado: null, version_esperada: 8 } });
    expect(r.status).toBe(200);
    expect(m.rpc.mock.calls[0][1].p_datos).toMatchObject({ estado: null, motivo: null });
  });

  it('si la hoja cambió, la base frena y se devuelve el mensaje', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'La hoja cambió. Actualizá antes de continuar' } });
    const r = await llamar({ body: { estado: 'no_salio', motivo: 'remito anulado', version_esperada: 3 } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/cambió/);
  });
});
