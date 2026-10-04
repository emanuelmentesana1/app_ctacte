import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * POST /api/recibos/lote — S32 · mejora 4. El lote NO tiene lógica de plata propia: cada recibo
 * pasa por el mismo `aprobarRecibo` (candado, pre-chequeo contra IM, usuario de quien aprueba).
 * Acá se prueba qué entra, el tope del piloto y que frene en el primer problema.
 */

const m = vi.hoisted(() => ({
  aprobarRecibo: vi.fn(),
  fetchComprobPendientes: vi.fn(),
  getV2: vi.fn(),
  filas: [] as any[],
}));
vi.mock('./recibos.js', () => ({ aprobarRecibo: m.aprobarRecibo }));
vi.mock('./infomanager.js', () => ({ fetchComprobPendientes: m.fetchComprobPendientes }));
vi.mock('./imApiV2.js', () => ({ getV2: m.getV2, imV2Configurada: () => true }));
vi.mock('./supabase.js', () => ({
  TENANT_ID: 't',
  sb: () => ({
    from: (t: string) => {
      const q: any = {
        select: () => q, eq: () => q, in: () => q, gte: () => q, lte: () => q, order: () => q, limit: () => q,
        then: (r: any, j: any) => Promise.resolve({ data: t === 'comprobantes_pago' ? m.filas : [], error: null }).then(r, j),
      };
      return q;
    },
  }),
}));

const { aprobarEnLote } = await import('./recibosLote.js');

const fila = (id: string, p: Record<string, unknown> = {}) => ({
  id, cod_cliente: 722, monto: 250_000, fecha_comprobante: '2026-10-02', medio_pago: 'mercadopago', mp_status: 'verified',
  status: 'pendiente_revision', observaciones: null, created_at: '2026-10-02T14:00:00Z', infomanager_recibo_id: null, created_by: null, ...p,
});
const PENDIENTES = [
  { id: 'FA2', fecha_factura: '2026-09-28', numero: '51000', saldo: 300_000, tipo_comprobante: 'FA' },
  { id: 'FA1', fecha_factura: '2026-09-10', numero: '50900', saldo: 100_000, tipo_comprobante: 'FA' },
];
const req = (body: any, rol = 'administrativo') => ({ user: { sub: 'u-anto', rol }, body }) as any;
function res() {
  const r: any = { statusCode: 200, body: null };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

beforeEach(() => {
  m.aprobarRecibo.mockReset().mockImplementation(async (rq: any, rs: any) => rs.json({ ok: true, recibo_id: `IM-${rq.params.id}` }));
  m.fetchComprobPendientes.mockReset().mockResolvedValue(PENDIENTES);
  m.getV2.mockReset().mockResolvedValue({ results: [] });
  // Montos distintos: dos pagos iguales del mismo cliente en la semana son un posible duplicado (y salen del lote).
  m.filas = [fila('r1'), fila('r2', { monto: 90_000, observaciones: 'imputar a FA 142847' })];
  process.env.RECIBOS_LOTE_TOPE = '3';
});

describe('aprobarEnLote', () => {
  it('plan: el verificado queda listo con la deuda más vieja primero; el que tiene observaciones, salteado', async () => {
    const r = res();
    await aprobarEnLote(req({ accion: 'plan' }), r);
    expect(r.statusCode).toBe(200);
    const [a, b] = r.body.plan;
    expect(a).toMatchObject({ id: 'r1', estado: 'listo', comprobantes: [{ id: 'FA1', importe_a_pagar: 100_000 }, { id: 'FA2', importe_a_pagar: 150_000 }] });
    expect(b).toMatchObject({ id: 'r2', estado: 'salteado' });
    expect(m.aprobarRecibo).not.toHaveBeenCalled();
  });

  it('🔑 aprobar: cada listo pasa por el aprobarRecibo de siempre, con la imputación del plan', async () => {
    const r = res();
    await aprobarEnLote(req({ accion: 'aprobar', ids: ['r1', 'r2'] }), r);
    expect(m.aprobarRecibo).toHaveBeenCalledTimes(1);
    const rq = m.aprobarRecibo.mock.calls[0][0];
    expect(rq.params.id).toBe('r1');
    expect(rq.body).toMatchObject({ monto: 250_000, fecha: '2026-10-02', medio_pago: 'mercadopago', cod_empresa: 1 });
    expect(rq.body.comprobantes).toEqual([{ id: 'FA1', importe_a_pagar: 100_000 }, { id: 'FA2', importe_a_pagar: 150_000 }]);
    expect(rq.user.sub).toBe('u-anto');
    expect(r.body.resultados).toEqual([{ id: 'r1', ok: true, recibo_id: 'IM-r1' }]);
  });

  it(`tope del piloto: no aprueba más de ${3} por tanda aunque haya más listos`, async () => {
    m.filas = ['a', 'b', 'c', 'd', 'e'].map((id, i) => fila(id, { monto: 10_000 * (i + 1) }));
    const r = res();
    await aprobarEnLote(req({ accion: 'aprobar', ids: ['a', 'b', 'c', 'd', 'e'] }), r);
    expect(m.aprobarRecibo).toHaveBeenCalledTimes(3);
  });

  it('🪤 frena en el primer problema: no sigue emitiendo a ciegas', async () => {
    m.filas = ['a', 'b', 'c'].map((id, i) => fila(id, { monto: 10_000 * (i + 1) }));
    m.aprobarRecibo.mockImplementationOnce(async (_rq: any, rs: any) => rs.status(400).json({ ok: false, error: 'IM no respondió' }));
    const r = res();
    await aprobarEnLote(req({ accion: 'aprobar', ids: ['a', 'b', 'c'] }), r);
    expect(m.aprobarRecibo).toHaveBeenCalledTimes(1);
    expect(r.body.resultados[0]).toMatchObject({ id: 'a', ok: false });
    expect(r.body.frenado).toBe(true);
  });

  it('si no puede mirar IM para descartar duplicados, no aprueba nada', async () => {
    m.getV2.mockRejectedValue(new Error('IM caído'));
    const r = res();
    await aprobarEnLote(req({ accion: 'aprobar', ids: ['r1'] }), r);
    expect(m.aprobarRecibo).not.toHaveBeenCalled();
    expect(r.body.plan[0].estado).toBe('salteado');
  });

  it('dos pagos iguales del mismo cliente en la semana quedan afuera del lote (posible duplicado)', async () => {
    m.filas = [fila('r1'), fila('r3')];
    const r = res();
    await aprobarEnLote(req({ accion: 'plan' }), r);
    expect(r.body.plan.map((p: any) => p.estado)).toEqual(['salteado', 'salteado']);
  });

  it('quien no aprueba recibos no entra', async () => {
    const r = res();
    await aprobarEnLote(req({ accion: 'plan' }, 'vendedor'), r);
    expect(r.statusCode).toBe(403);
  });
});
