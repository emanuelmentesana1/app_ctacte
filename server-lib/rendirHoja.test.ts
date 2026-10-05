import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Rendir el efectivo de la hoja en la app (etapa 2, diseño aprobado por Mati el 04/10/2026).
 * Lo que fijan estos tests, además de la cuenta (que tiene sus tests en rendicionEfectivo.test.ts):
 *  · sin la migración 056 nada se rompe: la rendición sigue en sólo lectura;
 *  · lo cuenta Anto y lo controla OTRA persona (Maca);
 *  · 🔴 no se escribe en IM sin el sí de Mati: con el tope en 0 sólo hay vista previa;
 *  · cada recibo pasa por el mismo `aprobarRecibo` de Cobranzas, a Caja Repartos y con la fecha
 *    de la hoja; y si dos personas emiten la misma hoja, el segundo choca en la base, no en IM.
 */

const m = vi.hoisted(() => ({
  tablas: {} as Record<string, any[]>,
  errores: {} as Record<string, { code: string; message: string } | undefined>,
  aprobar: vi.fn(),
  pendientes: vi.fn(),
  getV2: vi.fn(),
}));

/** Una base en memoria con lo justo del cliente de Supabase: filtra de verdad, inserta y actualiza. */
vi.mock('./supabase.js', () => ({
  TENANT_ID: 't',
  sb: () => ({
    from: (tabla: string) => {
      const filtros: Array<(r: any) => boolean> = [];
      let op: 'select' | 'insert' | 'update' = 'select';
      let valores: any = null;
      let unico = false;
      const ejecutar = async () => {
        if (m.errores[tabla]) return { data: null, error: m.errores[tabla] };
        const filas = (m.tablas[tabla] ??= []);
        if (op === 'insert') {
          const nuevas = (Array.isArray(valores) ? valores : [valores]).map((v: any) => ({ ...v }));
          for (const n of nuevas) {
            // Los índices únicos de la migración 056: una rendición por hoja; un efectivo por hoja y cliente.
            const choca = tabla === 'rendiciones' ? filas.some(f => f.hoja_id === n.hoja_id)
              : tabla === 'comprobantes_pago' && n.hoja_id ? filas.some(f => f.hoja_id === n.hoja_id && f.cod_cliente === n.cod_cliente && f.medio_pago === 'efectivo')
              : false;
            if (choca) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
            filas.push({ version: 1, ...n });
          }
          return { data: unico ? filas.at(-1) : nuevas, error: null };
        }
        const sel = filas.filter(r => filtros.every(f => f(r)));
        if (op === 'update') sel.forEach(r => Object.assign(r, valores));
        return { data: unico ? (sel[0] ?? null) : sel, error: null };
      };
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => (filtros.push(r => r[c] === v), q),
        neq: (c: string, v: unknown) => (filtros.push(r => r[c] !== v), q),
        in: (c: string, vs: unknown[]) => (filtros.push(r => vs.includes(r[c])), q),
        gte: (c: string, v: any) => (filtros.push(r => r[c] >= v), q),
        lte: (c: string, v: any) => (filtros.push(r => r[c] <= v), q),
        order: () => q,
        limit: () => q,
        insert: (v: unknown) => { op = 'insert'; valores = v; return q; },
        update: (v: unknown) => { op = 'update'; valores = v; return q; },
        maybeSingle: () => { unico = true; return ejecutar(); },
        single: () => { unico = true; return ejecutar(); },
        then: (ok: any, mal: any) => ejecutar().then(ok, mal),
      };
      return q;
    },
  }),
}));
vi.mock('./infomanager.js', () => ({
  fetchComprobPendientes: m.pendientes,
  fetchClientesIMCached: vi.fn(async () => [{ cod_cliente: 722, cod_vendedor: 5 }]),
  fechaArgentina: () => '2026-10-06',
}));
vi.mock('./imApiV2.js', () => ({ getV2: m.getV2, imV2Configurada: () => true }));
vi.mock('./recibos.js', () => ({ aprobarRecibo: m.aprobar, CAJA_DEL_SERVIDOR: Symbol.for('cajaDelServidor') }));

const { rendicionDeHoja, guardarRendicion, controlarRendicion, emitirRendicion, saldosDelMes } = await import('./rendirHoja.js');
const CAJA = Symbol.for('cajaDelServidor');

const HOJA = '11111111-2222-3333-4444-555555555555';
const ANTO = { sub: 'u-anto', email: 'anto@x', rol: 'administrativo', cod_vendedor: null };
const MACA = { sub: 'u-maca', email: 'maca@x', rol: 'administrativo', cod_vendedor: null };
const fa = (id: string, fecha: string, saldo: number) => ({ id, fecha_factura: fecha, numero: id, saldo, tipo_comprobante: 'FA' });

function req(user: any, body: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { params: { id: HOJA }, query: {}, user, body, ...extra } as any;
}
function res() {
  const r: any = { statusCode: 200, body: null };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}
const guardar = async (user: any, body: Record<string, unknown>) => { const r = res(); await guardarRendicion(req(user, body), r); return r; };

const HOJA_FUERA = '11111111-2222-3333-4444-666666666666';

beforeEach(() => {
  delete process.env.RENDICION_TOPE;
  // Cada test arranca SIN piloto; los que emiten prenden la hoja 3449 a mano.
  process.env.RENDICION_PILOTO_HOJAS = '';
  m.errores = {};
  m.tablas = {
    hojas_ruta: [{
      id: HOJA, tenant_id: 't', numero: 3449, fecha: '2026-10-05', estado: 'abierta', choferes: { nombre: 'VICTOR' },
      hojas_ruta_pedidos: [{ cod_cliente: 722, cliente_nombre: 'PEREZ' }, { cod_cliente: 815, cliente_nombre: 'GOMEZ' }],
    }, {
      id: HOJA_FUERA, tenant_id: 't', numero: 3450, fecha: '2026-10-05', estado: 'abierta', choferes: { nombre: 'NIÑO' },
      hojas_ruta_pedidos: [{ cod_cliente: 722, cliente_nombre: 'PEREZ' }],
    }],
    usuarios: [{ id: 'u-anto', nombre: 'Anto' }, { id: 'u-maca', nombre: 'Maca' }],
    rendiciones: [],
    comprobantes_pago: [],
    client_operational: [],
  };
  m.aprobar.mockReset().mockImplementation(async (rq: any, rs: any) => {
    const fila = m.tablas.comprobantes_pago.find(f => f.id === rq.params.id);
    Object.assign(fila, { status: 'imputado', infomanager_recibo_id: '58999001' });
    rs.status(200).json({ ok: true, recibo_id: '58999001' });
  });
  m.pendientes.mockReset().mockResolvedValue([fa('FA2', '2026-10-05', 412_300), fa('FA1', '2026-09-20', 120_000)]);
  m.getV2.mockReset().mockResolvedValue({ results: [] });
});

describe('rendición de la hoja — sin la migración 056', () => {
  it('🔑 responde "falta la migración" y la pantalla sigue en sólo lectura', async () => {
    m.errores.rendiciones = { code: 'PGRST205', message: "Could not find the table 'public.rendiciones'" };
    const r = res();
    await rendicionDeHoja(req(ANTO), r);
    expect(r.statusCode).toBe(200);
    expect(r.body.falta_migracion).toBe(true);
  });
});

describe('guardar la rendición', () => {
  it('🔑 guarda lo cobrado, los gastos y el contado, y calcula la diferencia', async () => {
    const r = await guardar(ANTO, { efectivo: [{ cod_cliente: 722, importe: 412_300 }], gastos: [{ concepto: 'Ayudante', importe: 18_000 }], efectivo_contado: 394_000 });
    expect(r.statusCode).toBe(200);
    const fila = m.tablas.rendiciones[0];
    expect(fila).toMatchObject({ hoja_id: HOJA, diferencia: -300, efectivo_contado: 394_000, contado_por: 'u-anto' });
    expect(r.body.rendicion.cuentas).toMatchObject({ efectivo: 412_300, gastos: 18_000, debe_entregar: 394_300, diferencia: -300 });
  });

  it('si otra persona la cambió en el medio (versión vieja), no pisa nada', async () => {
    await guardar(ANTO, { efectivo: [{ cod_cliente: 722, importe: 1000 }] });
    await guardar(ANTO, { efectivo: [{ cod_cliente: 722, importe: 2000 }], version: 1 });
    const r = await guardar(MACA, { efectivo: [{ cod_cliente: 722, importe: 3000 }], version: 1 });
    expect(r.statusCode).toBe(409);
    expect(m.tablas.rendiciones[0].efectivo).toEqual([{ cod_cliente: 722, importe: 2000 }]);
  });

  it('🔴 lo que ya se emitió en IM no se cambia desde la rendición', async () => {
    await guardar(ANTO, { efectivo: [{ cod_cliente: 722, importe: 412_300 }] });
    m.tablas.comprobantes_pago.push({ id: 'c1', tenant_id: 't', hoja_id: HOJA, cod_cliente: 722, monto: 412_300, medio_pago: 'efectivo', status: 'imputado', infomanager_recibo_id: '58999001' });
    const r = await guardar(ANTO, { efectivo: [{ cod_cliente: 722, importe: 400_000 }], version: 1 });
    expect(r.statusCode).toBe(409);
    expect(r.body.error).toMatch(/58999001/);
  });

  it('si cambia lo contado después del control, el control se borra (hay que volver a controlar)', async () => {
    await guardar(ANTO, { efectivo: [{ cod_cliente: 722, importe: 1000 }], efectivo_contado: 1000 });
    Object.assign(m.tablas.rendiciones[0], { controlado_por: 'u-maca', controlado_at: '2026-10-06T12:00:00Z' });
    await guardar(ANTO, { efectivo: [{ cod_cliente: 722, importe: 1000 }], efectivo_contado: 900, version: 1 });
    expect(m.tablas.rendiciones[0]).toMatchObject({ efectivo_contado: 900, controlado_por: null, controlado_at: null });
  });
});

describe('controlar lo contado (decisión 3: lo cuenta Anto y lo controla Maca)', () => {
  it('🔴 quien contó no puede controlarse a sí mismo', async () => {
    await guardar(ANTO, { efectivo: [{ cod_cliente: 722, importe: 1000 }], efectivo_contado: 1000 });
    const r = res();
    await controlarRendicion(req(ANTO, { version: 1 }), r);
    expect(r.statusCode).toBe(409);
    expect(m.tablas.rendiciones[0].controlado_por ?? null).toBe(null);
  });

  it('otra persona lo controla', async () => {
    await guardar(ANTO, { efectivo: [{ cod_cliente: 722, importe: 1000 }], efectivo_contado: 1000 });
    const r = res();
    await controlarRendicion(req(MACA, { version: 1 }), r);
    expect(r.statusCode).toBe(200);
    expect(m.tablas.rendiciones[0].controlado_por).toBe('u-maca');
  });

  it('sin contar no hay nada que controlar', async () => {
    await guardar(ANTO, { efectivo: [{ cod_cliente: 722, importe: 1000 }] });
    const r = res();
    await controlarRendicion(req(MACA, { version: 1 }), r);
    expect(r.statusCode).toBe(409);
  });
});

describe('emitir los recibos de efectivo', () => {
  beforeEach(async () => { await guardar(ANTO, { efectivo: [{ cod_cliente: 722, importe: 412_300 }] }); });

  it('la vista previa muestra la imputación aunque la emisión esté apagada, y no toca IM', async () => {
    const r = res();
    await emitirRendicion(req(ANTO, { accion: 'plan' }), r);
    expect(r.statusCode).toBe(200);
    expect(r.body.plan[0]).toMatchObject({ cod_cliente: 722, estado: 'listo', comprobantes: [{ id: 'FA1', importe_a_pagar: 120_000 }, { id: 'FA2', importe_a_pagar: 292_300 }] });
    expect(r.body.fecha).toBe('2026-10-05');
    expect(m.aprobar).not.toHaveBeenCalled();
  });

  it('🔴 sin hojas en el piloto no se emite nada', async () => {
    const r = res();
    await emitirRendicion(req(ANTO, { accion: 'emitir' }), r);
    expect(r.statusCode).toBe(403);
    expect(m.aprobar).not.toHaveBeenCalled();
    expect(m.tablas.comprobantes_pago).toHaveLength(0);
  });

  it('🔑 con el piloto activo: un recibo por cliente, a Caja Repartos, con la fecha de la hoja y por el motor de siempre', async () => {
    process.env.RENDICION_PILOTO_HOJAS = '3449';
    const r = res();
    await emitirRendicion(req(ANTO, { accion: 'emitir' }), r);
    expect(r.statusCode).toBe(200);
    expect(r.body.resultados).toEqual([{ cod_cliente: 722, ok: true, recibo_id: '58999001' }]);
    const fila = m.tablas.comprobantes_pago[0];
    expect(fila).toMatchObject({ hoja_id: HOJA, cod_cliente: 722, cod_vendedor: 5, monto: 412_300, medio_pago: 'efectivo', fecha_comprobante: '2026-10-05', created_by: 'u-anto' });
    const rq = m.aprobar.mock.calls[0][0];
    expect(rq[CAJA]).toBe('1110009');
    expect(rq.params.id).toBe(fila.id);
    expect(rq.body).toMatchObject({ monto: 412_300, fecha: '2026-10-05', medio_pago: 'efectivo', cod_empresa: 1, comprobantes: [{ id: 'FA1', importe_a_pagar: 120_000 }, { id: 'FA2', importe_a_pagar: 292_300 }] });
    expect(rq.user.sub).toBe('u-anto');
  });

  it('🔴 si otra persona ya está emitiendo ese cliente, choca en la base y NO llega a IM', async () => {
    process.env.RENDICION_PILOTO_HOJAS = '3449';
    // Otra pestaña lo inserta mientras este pedido consulta IM: el plan ya se armó sin verlo.
    m.getV2.mockImplementationOnce(async () => {
      m.tablas.comprobantes_pago.push({ id: 'otro', tenant_id: 't', hoja_id: HOJA, cod_cliente: 722, monto: 412_300, medio_pago: 'efectivo', status: 'error' });
      return { results: [] };
    });
    const r = res();
    await emitirRendicion(req(ANTO, { accion: 'emitir' }), r);
    expect(m.aprobar).not.toHaveBeenCalled();
    expect(r.body.frenado).toBe(true);
    expect(r.body.resultados[0].ok).toBe(false);
  });

  it('si IM rechaza uno, queda marcado con el motivo y la tanda se frena ahí', async () => {
    process.env.RENDICION_PILOTO_HOJAS = '3449';
    await guardar(ANTO, { efectivo: [{ cod_cliente: 722, importe: 412_300 }, { cod_cliente: 815, importe: 50_000 }], version: 1 });
    m.aprobar.mockImplementationOnce(async (_rq: any, rs: any) => { rs.status(409).json({ ok: false, error: 'La factura FA1 ya no está pendiente' }); });
    const r = res();
    await emitirRendicion(req(ANTO, { accion: 'emitir' }), r);
    expect(m.aprobar).toHaveBeenCalledTimes(1);
    expect(r.body.frenado).toBe(true);
    expect(m.tablas.comprobantes_pago[0]).toMatchObject({ status: 'error', error_msg: expect.stringMatching(/ya no está pendiente/) });
  });
});

describe('saldo del mes por repartidor', () => {
  it('🔑 suma las diferencias de las hojas contadas del mes', async () => {
    await guardar(ANTO, { efectivo: [{ cod_cliente: 722, importe: 412_300 }], gastos: [{ concepto: 'Ayudante', importe: 18_000 }], efectivo_contado: 394_000 });
    const r = res();
    await saldosDelMes(req(ANTO, {}, { query: { mes: '2026-10' } }), r);
    expect(r.statusCode).toBe(200);
    expect(r.body.saldos).toEqual([{ chofer: 'VICTOR', hojas: 1, contadas: 1, saldo: -300, sin_controlar: 1 }]);
  });
});

describe('piloto (Mati, 05/10/2026: "sí al piloto" con una hoja)', () => {
  it('🔑 por defecto el piloto es la hoja 3449: ésa puede emitir', async () => {
    delete process.env.RENDICION_PILOTO_HOJAS;
    const r = res();
    await rendicionDeHoja(req(ANTO), r);
    expect(r.body.emision).toMatchObject({ piloto: [3449] });
    expect(r.body.emision.tope).toBeGreaterThan(0);
  });

  it('🔴 una hoja fuera del piloto no emite, aunque tenga su rendición guardada', async () => {
    process.env.RENDICION_PILOTO_HOJAS = '3449';
    const g = res();
    await guardarRendicion(req(ANTO, { efectivo: [{ cod_cliente: 722, importe: 412_300 }] }, { params: { id: HOJA_FUERA } }), g);
    expect(g.statusCode).toBe(200);
    expect(g.body.emision).toMatchObject({ tope: 0, piloto: [3449] });
    const r = res();
    await emitirRendicion(req(ANTO, { accion: 'emitir' }, { params: { id: HOJA_FUERA } }), r);
    expect(r.statusCode).toBe(403);
    expect(r.body.error).toMatch(/3449/);
    expect(m.aprobar).not.toHaveBeenCalled();
  });
});

