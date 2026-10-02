import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * El índice de facturas emitidas por la app (02/10/2026). La base devuelve como mucho 1.000 filas
 * por consulta: pedido entero, desde el 30/09 dejaba afuera las facturas nuevas (1.054 contra
 * 1.000, medido) y el panel las mostraba como "deducidas" en "Para facturar".
 */

const m = vi.hoisted(() => ({ sbMock: vi.fn() }));
vi.mock('./supabase.js', () => ({ sb: m.sbMock, TENANT_ID: 'test-tenant', hasSupabase: () => true }));
const { facturasEmitidasPorLaApp } = await import('./facturasDeLaApp.js');

/** Como PostgREST: respeta los filtros y devuelve como mucho 1.000 filas. */
let filas: any[] = [];
let consultas: Array<{ col: string; ids: string[] }> = [];
let error: { message: string } | null = null;
beforeEach(() => {
  consultas = []; error = null;
  filas = [
    ...Array.from({ length: 1053 }, (_, i) => ({ im_comprobante_id: `v${i}`, im_factura_id: `fv${i}`, im_factura_numero: i, im_factura_tipo: 'FA B' })),
    // ISA, Cristian: la 1.054, la que quedaba afuera.
    { im_comprobante_id: '59007432', im_factura_id: '59008516', im_factura_numero: 51071, im_factura_tipo: 'FA B' },
  ];
  m.sbMock.mockImplementation(() => ({
    from: () => {
      const filtros: Array<(x: any) => boolean> = [];
      const q: any = { then: (r: any, j: any) => Promise.resolve(error ? { data: null, error } : { data: filas.filter(x => filtros.every(f => f(x))).slice(0, 1000), error: null }).then(r, j) };
      q.select = () => q;
      q.eq = () => q;
      q.in = (c: string, ids: any[]) => { consultas.push({ col: c, ids: ids.map(String) }); filtros.push(x => ids.map(String).includes(String(x[c]))); return q; };
      q.not = (c: string) => { filtros.push(x => x[c] != null); return q; };
      return q;
    },
  }));
});

describe('facturasEmitidasPorLaApp', () => {
  it('🔴 encuentra la factura de un presupuesto aunque sea la fila 1.054', async () => {
    const r = await facturasEmitidasPorLaApp(['59007432'], []);
    expect(r.get('59007432')).toEqual({ im_factura_id: '59008516', im_factura_numero: 51071, im_factura_tipo: 'FA B' });
  });

  it('🔴 y sabe de qué presupuesto es una factura del rango, para que no justifique a otro', async () => {
    const r = await facturasEmitidasPorLaApp([], ['59008516']);
    expect(r.get('59007432')?.im_factura_id).toBe('59008516');
  });

  it('pide de a tandas de 200: ninguna consulta se acerca al tope', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `v${i}`);
    const r = await facturasEmitidasPorLaApp(ids, []);
    expect(r.size).toBe(450);
    expect(consultas.map(c => c.ids.length)).toEqual([200, 200, 50]);
  });

  it('los repetidos y vacíos no generan consultas de más', async () => {
    await facturasEmitidasPorLaApp(['v1', 'v1', '', 'v2'], []);
    expect(consultas).toEqual([{ col: 'im_comprobante_id', ids: ['v1', 'v2'] }]);
  });

  it('sin nada para preguntar no consulta la base', async () => {
    expect((await facturasEmitidasPorLaApp([], [])).size).toBe(0);
    expect(consultas).toHaveLength(0);
  });

  it('🔴 si la base no contesta, tira: "no pude preguntar" no es "no hay ninguna"', async () => {
    error = { message: 'connection failure' };
    await expect(facturasEmitidasPorLaApp(['59007432'], [])).rejects.toThrow(/connection failure/);
  });
});
