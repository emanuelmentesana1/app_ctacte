import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Aviso de «remito anulado en IM» (Mati, 05/10/2026). Es un AVISO, no un descuento: DIAZ (hoja 3402)
 * tenía el remito borrado y la mercadería salió con otro. Sólo se avisa lo que IM CONFIRMA anulado o
 * borrado; un «no pude preguntar» no se convierte en aviso.
 */

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

const m = vi.hoisted(() => ({ sbMock: vi.fn(), vig: vi.fn(), hojas: [] as any[] }));
vi.mock('./supabase.js', () => ({ sb: m.sbMock, TENANT_ID: 'test-tenant', hasSupabase: () => true }));
vi.mock('./infomanager.js', async (orig) => ({ ...(await orig() as any), comprobantesVigentes: m.vig }));

const { remitosAnulados } = await import('./hojasRuta.js');

function fakeSb() {
  m.sbMock.mockImplementation(() => ({
    from: () => {
      const q: any = { then: (r: any, j: any) => Promise.resolve({ data: m.hojas, error: null }).then(r, j) };
      for (const k of ['select', 'eq', 'gte', 'lte', 'order', 'range', 'in', 'limit']) q[k] = () => q;
      return q;
    },
  }));
}

function llamar(query: Record<string, string>) {
  let status = 200; let out: any;
  const req: any = { user: { rol: 'administrativo', sub: 'u1' }, params: {}, body: {}, query };
  const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => { out = b; } };
  return remitosAnulados(req, res).then(() => ({ status, body: out }));
}

const entrega = (id: string, extra: Record<string, unknown> = {}) => ({
  im_comprobante_id: id, im_remito_id: id, im_remito_numero: 77000 + Number(id), cliente_nombre: `CLIENTE ${id}`, cod_cliente: Number(id), total: 1000, ...extra });

beforeEach(() => {
  vi.clearAllMocks(); fakeSb();
  m.hojas = [{ id: 'h1', numero: 3402, fecha: '2026-09-09', estado: 'cerrada', hojas_ruta_pedidos: [
    entrega('1', { cliente_nombre: 'DIAZ, Alfredo', total: 2682199.99 }),
    entrega('2'),
    entrega('3'),
    entrega('4', { cliente_nombre: 'LEAL, Paulina', estado_entrega: 'no_salio' }),
  ] }];
  m.vig.mockResolvedValue(new Map<string, boolean | null>([['1', false], ['2', true], ['3', null]]));
});

describe('remitos anulados en IM', () => {
  it('🔴 avisa sólo lo que IM confirma anulado o borrado, y no consulta lo ya marcado «no salió»', async () => {
    const r = await llamar({ desde: '2026-09-09', hasta: '2026-09-10', refrescar: '1' });
    expect(r.status).toBe(200);
    expect(r.body.entregas).toHaveLength(1);
    expect(r.body.entregas[0]).toMatchObject({ hoja: 3402, im_comprobante_id: '1', cliente_nombre: 'DIAZ, Alfredo', remito: 77001, total: 2682199.99 });
    // Ni el vigente (2), ni el que IM no contestó (3), ni el marcado (4).
    const [ids, rango] = m.vig.mock.calls[0];
    expect([...ids]).toEqual(['1', '2', '3']);
    // El rango del listado de IM: unos días antes (los remitos salen antes que la hoja) y uno o dos después.
    expect(rango).toMatchObject({ desde: '2026-09-04', hasta: '2026-09-12' });
  });

  it('un rango inválido o de más de dos meses no consulta IM', async () => {
    expect((await llamar({ desde: '2026-09-10', hasta: '2026-09-01' })).status).toBe(400);
    expect((await llamar({ desde: '2026-01-01', hasta: '2026-09-30' })).status).toBe(400);
    expect((await llamar({ desde: 'ayer', hasta: '2026-09-30' })).status).toBe(400);
    expect(m.vig).not.toHaveBeenCalled();
  });

  it('si IM no contesta, lo dice y no inventa avisos', async () => {
    m.vig.mockRejectedValue(new Error('timeout'));
    const r = await llamar({ desde: '2026-09-09', hasta: '2026-09-10', refrescar: '1' });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/InfoManager/);
  });
});
