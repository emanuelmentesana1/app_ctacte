import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * S32 · mejora 10 (04/10/2026). La lista de 30 días de un vendedor (152 recibos) tardaba 1,3 s:
 * 250-380 ms la consulta y 250-790 ms firmar las 147 fotos. Se firman las primeras 40 miniaturas;
 * la foto de las demás se firma al abrir el recibo (GET /api/recibos/:id ya lo hace).
 */
const m = vi.hoisted(() => ({ filas: [] as any[], firmados: [] as string[][] }));
vi.mock('./infomanager.js', () => ({ crearRecibo: vi.fn(), fetchComprobPendientes: vi.fn(), fetchClientesIMCached: vi.fn(async () => []) }));
vi.mock('./cuentasResolver.js', () => ({ resolveCuentaCod: vi.fn(), debugCuentasResolver: vi.fn(), invalidateCuentasCache: vi.fn(), listCuentasEfectivo: vi.fn(async () => []) }));
vi.mock('./perfilUsuario.js', () => ({ filaUsuario: vi.fn(async () => ({ im_usuario: null, cod_empresa: null, ve_todos_los_clientes: false, ve_toda_la_empresa: false })) }));
vi.mock('./ocrRecibo.js', () => ({ ocrRecibo: vi.fn() }));
vi.mock('./mercadopago.js', () => ({ buscarPagoEnMP: vi.fn(), todayISO_AR: () => '2026-10-04', mpConfigStatus: vi.fn() }));
vi.mock('./supabase.js', () => ({
  TENANT_ID: 't',
  sb: () => ({
    storage: { from: () => ({ createSignedUrls: async (paths: string[]) => { m.firmados.push(paths); return { data: paths.map(p => ({ path: p, signedUrl: `https://firmado/${p}` })) }; } }) },
    from: () => {
      const q: any = { select: () => q, eq: () => q, gte: () => q, lt: () => q, order: () => q, limit: () => q,
        then: (r: any, j: any) => Promise.resolve({ data: m.filas, error: null }).then(r, j) };
      return q;
    },
  }),
}));
process.env.INFOMANAGER_USUARIO = 'matias';
const { listRecibos } = await import('./recibos.js');

function res() {
  const r: any = { statusCode: 200, body: null };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}
beforeEach(() => {
  m.filas = Array.from({ length: 60 }, (_, i) => ({ id: `r${i}`, cod_cliente: 1, cod_vendedor: 4, monto: 1000, status: 'imputado', foto_url: `f/${i}.jpg`, created_at: '2026-10-01T10:00:00Z' }));
  m.firmados = [];
});

describe('listRecibos — fotos bajo demanda', () => {
  it('🔑 firma sólo las primeras 40 miniaturas; las demás quedan para cuando se abre el recibo', async () => {
    const r = res();
    await listRecibos({ user: { sub: 'u', rol: 'vendedor', cod_vendedor: 4 }, query: {} } as any, r);
    expect(m.firmados.flat()).toHaveLength(40);
    expect(r.body.recibos[0].foto_signed_url).toBe('https://firmado/f/0.jpg');
    expect(r.body.recibos[59].foto_signed_url).toBeNull();
    expect(r.body.recibos[59].foto_url).toBe('f/59.jpg');
  });
});
