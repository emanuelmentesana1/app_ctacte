import { describe, it, expect, vi, beforeEach } from 'vitest';

/** GET /api/recibos/control-im — S32 · mejora 7. */
const m = vi.hoisted(() => ({ getV2: vi.fn(), filas: [] as any[], usuarios: [] as any[] }));
vi.mock('./imApiV2.js', () => ({ getV2: m.getV2, imV2Configurada: () => true }));
vi.mock('./supabase.js', () => ({
  TENANT_ID: 't',
  sb: () => ({
    from: (t: string) => {
      const q: any = {
        select: () => q, eq: () => q, in: () => q, gte: () => q, not: () => q, order: () => q, limit: () => q,
        then: (r: any, j: any) => Promise.resolve({ data: t === 'usuarios' ? m.usuarios : m.filas, error: null }).then(r, j),
      };
      return q;
    },
  }),
}));
const { controlRecibosIM } = await import('./recibosControlIM.js');

const fila = (id: string, recibo: string, p: Record<string, unknown> = {}) => ({
  id, cod_cliente: 722, monto: 150_000, fecha_comprobante: '2026-09-17', infomanager_recibo_id: recibo,
  imputado_at: '2026-09-17T17:04:03Z', cod_empresa: 1, reviewed_by: 'u-anto', ...p,
});
const req = (rol = 'administrativo', query: Record<string, string> = {}) => ({ user: { sub: 'u', rol }, query }) as any;
function res() {
  const r: any = { statusCode: 200, body: null };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}
beforeEach(() => {
  m.getV2.mockReset().mockResolvedValue({ results: [{ id_recibo: 58891124 }], totalPages: 1 });
  m.filas = [fila('a', '58884698'), fila('b', '58891124')];
  m.usuarios = [{ id: 'u-anto', nombre: 'Anto' }];
});

describe('controlRecibosIM', () => {
  it('🔑 devuelve los recibos de la app que IM ya no tiene, con quién los aprobó', async () => {
    const r = res();
    await controlRecibosIM(req('administrativo', { refrescar: '1' }), r);
    expect(r.statusCode).toBe(200);
    expect(r.body.revisados).toBe(2);
    expect(r.body.faltan).toEqual([expect.objectContaining({ id: 'a', infomanager_recibo_id: '58884698', reviewed_by_nombre: 'Anto' })]);
  });

  it('si IM no contesta, error claro: no se inventan faltantes', async () => {
    m.getV2.mockRejectedValue(new Error('IM caído'));
    const r = res();
    await controlRecibosIM(req('administrativo', { refrescar: '1' }), r);
    expect(r.statusCode).toBe(502);
  });

  it('quien no aprueba recibos no lo ve', async () => {
    const r = res();
    await controlRecibosIM(req('vendedor'), r);
    expect(r.statusCode).toBe(403);
  });
});
