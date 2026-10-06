import { describe, it, expect, vi, beforeEach } from 'vitest';

/** El aviso "Hay N presupuestos nuevos": Supabase solamente, y sólo si el rango incluye hoy. */
const m = vi.hoisted(() => ({ filtros: [] as Array<[string, ...unknown[]]>, filas: [] as any[], error: null as any, hoy: '2026-10-06' }));

vi.mock('./infomanager.js', () => ({ fechaArgentina: () => m.hoy }));
vi.mock('./facturarPresupuestos.js', () => ({
  frenaSiNoPuede: (req: any, res: any) => { if (req.user.rol === 'vendedor') { res.status(403).json({ error: 'no' }); return true; } return false; },
}));
vi.mock('./supabase.js', () => ({
  TENANT_ID: 'test-tenant',
  sb: () => ({
    from: (tabla: string) => {
      m.filtros.push(['from', tabla]);
      const q: any = { then: (r: any, j: any) => Promise.resolve({ data: m.filas, error: m.error }).then(r, j) };
      for (const k of ['select', 'eq', 'not', 'gt', 'limit']) q[k] = (...a: unknown[]) => { m.filtros.push([k, ...a]); return q; };
      return q;
    },
  }),
}));

const { novedadesFacturacion } = await import('./novedadesFacturacion.js');

async function pedir(query: Record<string, string>, rol = 'administrativo') {
  let status = 200, body: any;
  const res: any = { status(s: number) { status = s; return res; }, json(b: any) { body = b; return res; } };
  await novedadesFacturacion({ query, user: { rol } } as any, res);
  return { status, body };
}

beforeEach(() => { m.filtros = []; m.filas = []; m.error = null; m.hoy = '2026-10-06'; });

describe('novedadesFacturacion', () => {
  const Q = { desde: '2026-09-30', hasta: '2026-10-06', leido_at: '2026-10-06T13:00:00.000Z' };

  it('devuelve los presupuestos enviados después de la última lectura, sin repetir', async () => {
    m.filas = [{ im_presupuesto_id: '58301' }, { im_presupuesto_id: 58302 }, { im_presupuesto_id: '58301' }];
    const r = await pedir(Q);
    expect(r.body).toEqual({ ok: true, ids: ['58301', '58302'] });
    expect(m.filtros).toContainEqual(['from', 'pedidos_vendedor']);
    expect(m.filtros).toContainEqual(['eq', 'estado', 'enviado']);
    expect(m.filtros).toContainEqual(['gt', 'updated_at', '2026-10-06T13:00:00.000Z']);
  });

  it('🪤 si el rango no incluye hoy no avisa nada, y ni consulta', async () => {
    m.filas = [{ im_presupuesto_id: '58301' }];
    const r = await pedir({ ...Q, hasta: '2026-10-05' });
    expect(r.body).toEqual({ ok: true, ids: [] });
    expect(m.filtros).toEqual([]);
  });

  it('sin el momento de la última lectura no adivina: 400', async () => {
    expect((await pedir({ desde: Q.desde, hasta: Q.hasta })).status).toBe(400);
    expect((await pedir({ ...Q, leido_at: 'ayer' })).status).toBe(400);
  });

  it('un vendedor no puede consultarlo', async () => {
    expect((await pedir(Q, 'vendedor')).status).toBe(403);
  });

  it('si Supabase falla lo dice (la pantalla no muestra un "0 nuevos" falso)', async () => {
    m.error = { message: 'timeout' };
    const r = await pedir(Q);
    expect(r.status).toBe(502);
  });
});
