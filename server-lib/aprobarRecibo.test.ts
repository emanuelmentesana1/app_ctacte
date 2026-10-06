import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * aprobarRecibo — el handler que emite el recibo en InfoManager. La auditoría del 09/06 lo marcó:
 * es lo que más plata mueve y no tenía un solo test del handler (sólo de sus funciones puras).
 *
 * Tres casos fijan el comportamiento que YA existía (pasan antes y después del cambio) y cuatro
 * cubren la mejora 5 de S32 (04/10/2026, Mati): *"los recibos tienen que entrar a IM con el
 * usuario de QUIEN APRUEBA"*.
 */

const m = vi.hoisted(() => ({
  crearRecibo: vi.fn(),
  fetchComprobPendientes: vi.fn(),
  filaUsuario: vi.fn(),
  comp: null as any,
  updates: [] as any[],
}));

vi.mock('./infomanager.js', () => ({
  crearRecibo: m.crearRecibo,
  fetchComprobPendientes: m.fetchComprobPendientes,
  fetchClientesIMCached: vi.fn(async () => []),
}));
vi.mock('./cuentasResolver.js', () => ({
  resolveCuentaCod: vi.fn(async () => '1120003'),
  debugCuentasResolver: vi.fn(async () => ({})),
  invalidateCuentasCache: vi.fn(),
  listCuentasEfectivo: vi.fn(async () => [{ cod_cuenta: '1110005', nombre: 'Caja Casa Central', es_default: true }, { cod_cuenta: '1110004', nombre: 'Caja Chica 2', es_default: false }]),
}));
vi.mock('./perfilUsuario.js', () => ({ filaUsuario: m.filaUsuario }));
vi.mock('./ocrRecibo.js', () => ({ ocrRecibo: vi.fn() }));
vi.mock('./mercadopago.js', () => ({ buscarPagoEnMP: vi.fn(), todayISO_AR: () => '2026-10-04', mpConfigStatus: vi.fn() }));
vi.mock('./supabase.js', () => ({
  TENANT_ID: 't',
  sb: () => ({
    from: (_t: string) => {
      const q: any = {
        select: () => q, eq: () => q, neq: () => q,
        maybeSingle: async () => ({ data: m.comp, error: null }),
        update: (v: any) => { m.updates.push(v); return q; },
        then: (r: any, j: any) => Promise.resolve({ data: null, error: null }).then(r, j),
      };
      return q;
    },
  }),
}));

process.env.INFOMANAGER_USUARIO = 'matias';
const { aprobarRecibo, cuentasEfectivo } = await import('./recibos.js');

const PENDIENTE = { id: 'FA1', saldo: 300_000, tipo_comprobante: 'FA' };
function req(body: Record<string, unknown> = {}, rol = 'administrativo') {
  return {
    params: { id: 'r1' },
    user: { sub: 'u-anto', email: 'anto@x', rol, cod_vendedor: null },
    body: { monto: 250_000, fecha: '2026-10-02', medio_pago: 'mercadopago', cod_empresa: 1, comprobantes: [{ id: 'FA1', importe_a_pagar: 250_000 }], ...body },
  } as any;
}
function res() {
  const r: any = { statusCode: 200, body: null };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

beforeEach(() => {
  m.crearRecibo.mockReset();
  m.fetchComprobPendientes.mockReset().mockResolvedValue([PENDIENTE]);
  m.filaUsuario.mockReset().mockResolvedValue({ im_usuario: 'anto', cod_empresa: null, ve_todos_los_clientes: false, ve_toda_la_empresa: false });
  m.comp = { id: 'r1', cod_cliente: 722, monto: 250_000, fecha_comprobante: '2026-10-02', medio_pago: 'mercadopago', status: 'pendiente_revision', observaciones: null, referencia: null };
  m.updates = [];
});

describe('aprobarRecibo — lo que ya hacía', () => {
  it('emite el recibo con la imputación elegida y lo deja imputado con el número de IM', async () => {
    m.crearRecibo.mockResolvedValue({ ok: true, id: '58999001', raw: { recibo: { id: 58999001 } } });
    const r = res();
    await aprobarRecibo(req(), r);
    expect(r.statusCode).toBe(200);
    const payload = m.crearRecibo.mock.calls[0][0];
    expect(payload.comprobantes).toEqual([{ id: 'FA1', importe_a_pagar: '250000.00' }]);
    expect(payload.pagos[0]).toMatchObject({ forma_pago: 'OT', importe: '250000.00', cod_cuenta: '1120003' });
    expect(m.updates.at(-1)).toMatchObject({ status: 'imputado', infomanager_recibo_id: '58999001' });
  });

  it('🪤 al emitir bien no queda ningún texto de error (la rendición marca "Emitiendo…" mientras emite)', async () => {
    m.comp = { ...m.comp, status: 'error', error_msg: 'Emitiendo desde la rendición de la hoja 3449…' };
    m.crearRecibo.mockResolvedValue({ ok: true, id: '58999001', raw: {} });
    await aprobarRecibo(req(), res());
    expect(m.updates.at(-1)).toMatchObject({ status: 'imputado', error_msg: null });
  });

  it('si la factura ya no está pendiente en IM, no emite (otro recibo la pagó)', async () => {
    m.fetchComprobPendientes.mockResolvedValue([]);
    const r = res();
    await aprobarRecibo(req(), r);
    expect(r.statusCode).toBe(409);
    expect(m.crearRecibo).not.toHaveBeenCalled();
  });

  it('si IM no contesta, queda en error y NO se reintenta (no se sabe si entró)', async () => {
    m.crearRecibo.mockResolvedValue({ ok: false, error: 'timeout', sinRespuesta: true, raw: null });
    const r = res();
    await aprobarRecibo(req(), r);
    expect(m.crearRecibo).toHaveBeenCalledTimes(1);
    expect(m.updates.at(-1)).toMatchObject({ status: 'error' });
  });
});

describe('aprobarRecibo — usuario de IM de quien aprueba (S32 · mejora 5)', () => {
  it('🔑 el recibo entra a IM con el login de quien aprueba', async () => {
    m.crearRecibo.mockResolvedValue({ ok: true, id: '1', raw: {} });
    await aprobarRecibo(req(), res());
    expect(m.crearRecibo.mock.calls[0][0].usuario).toBe('anto');
  });

  it('sin login de IM cargado (Rodrigo, Maca), entra como hoy: con el de la app', async () => {
    m.filaUsuario.mockResolvedValue({ im_usuario: null, cod_empresa: null, ve_todos_los_clientes: false, ve_toda_la_empresa: false });
    m.crearRecibo.mockResolvedValue({ ok: true, id: '1', raw: {} });
    await aprobarRecibo(req(), res());
    expect(m.crearRecibo.mock.calls[0][0].usuario).toBe('matias');
  });

  it('🪤 si IM rechaza ESE usuario, reintenta una sola vez con el de la app (Anto no se traba)', async () => {
    m.crearRecibo
      .mockResolvedValueOnce({ ok: false, error: 'HTTP 400', raw: { errores: [{ campo: 'usuario', mensajes: ['El usuario no existe'] }] } })
      .mockResolvedValueOnce({ ok: true, id: '58999002', raw: {} });
    const r = res();
    await aprobarRecibo(req(), r);
    expect(m.crearRecibo).toHaveBeenCalledTimes(2);
    expect(m.crearRecibo.mock.calls[1][0].usuario).toBe('matias');
    expect(m.updates.at(-1)).toMatchObject({ status: 'imputado', infomanager_recibo_id: '58999002' });
  });

  it('el navegador ya no puede elegir con qué usuario se emite', async () => {
    m.crearRecibo.mockResolvedValue({ ok: true, id: '1', raw: {} });
    await aprobarRecibo(req({ usuario: 'otro_usuario' }), res());
    expect(m.crearRecibo.mock.calls[0][0].usuario).toBe('anto');
  });
});

describe('la caja de Jorgelina (Mati, 06/10/2026: "que le impacte en su caja")', () => {
  const JO = { im_usuario: 'jorgelina', cod_empresa: null, ve_todos_los_clientes: false, ve_toda_la_empresa: false };

  it('🔑 lo que aprueba Jorgelina entra a IM con CONY CAJA, no con "jorgelina" ni con el de la app', async () => {
    m.filaUsuario.mockResolvedValue(JO);
    m.crearRecibo.mockResolvedValue({ ok: true, id: '1', raw: {} });
    await aprobarRecibo(req(), res());
    expect(m.crearRecibo.mock.calls[0][0].usuario).toBe('CONY CAJA');
    expect(m.crearRecibo.mock.calls[0][0].pagos[0].cod_cuenta).toBe('1120003');
  });

  it('en efectivo, a ella le viene elegida la Caja Chica 2 (su caja en IM)', async () => {
    m.filaUsuario.mockResolvedValue(JO);
    const r = res();
    await cuentasEfectivo(req(), r);
    expect(r.body.cuentas.filter((c: any) => c.es_default).map((c: any) => c.cod_cuenta)).toEqual(['1110004']);
  });

  it('a Anto le sigue viniendo elegida la de siempre', async () => {
    const r = res();
    await cuentasEfectivo(req(), r);
    expect(r.body.cuentas.filter((c: any) => c.es_default).map((c: any) => c.cod_cuenta)).toEqual(['1110005']);
  });
});

describe('aprobarRecibo — la caja la valida el servidor (S32 · mejora 6)', () => {
  it('Caja Chica 2 en efectivo se acepta (está en la lista de cajas)', async () => {
    m.crearRecibo.mockResolvedValue({ ok: true, id: '1', raw: {} });
    const r = res();
    await aprobarRecibo(req({ medio_pago: 'efectivo', cod_cuenta: '1110004' }), r);
    expect(r.statusCode).toBe(200);
    expect(m.crearRecibo.mock.calls[0][0].pagos[0].cod_cuenta).toBe('1110004');
  });

  it('🔴 una caja que no está habilitada se rechaza y NO se emite', async () => {
    const r = res();
    await aprobarRecibo(req({ medio_pago: 'efectivo', cod_cuenta: '1110008' }), r);
    expect(r.statusCode).toBe(400);
    expect(m.crearRecibo).not.toHaveBeenCalled();
  });

  it('en una transferencia no se puede pisar la cuenta de cobro', async () => {
    const r = res();
    await aprobarRecibo(req({ medio_pago: 'mercadopago', cod_cuenta: '1110005' }), r);
    expect(r.statusCode).toBe(400);
    expect(m.crearRecibo).not.toHaveBeenCalled();
  });

  it('pagos armados a mano con una cuenta fuera de las de cobro se rechazan', async () => {
    const r = res();
    await aprobarRecibo(req({ pagos: [{ forma_pago: 'OT', importe: '250000', cod_cuenta: '9999999' }] }), r);
    expect(r.statusCode).toBe(400);
    expect(m.crearRecibo).not.toHaveBeenCalled();
  });
});

describe('aprobarRecibo — la caja que fija el servidor (rendición de la hoja, etapa 2)', () => {
  it('🔑 la rendición emite a Caja Repartos aunque no esté entre las cajas de la pantalla', async () => {
    const { CAJA_DEL_SERVIDOR } = await import('./recibos.js');
    m.crearRecibo.mockResolvedValue({ ok: true, id: '1', raw: {} });
    const rq = req({ medio_pago: 'efectivo' });
    rq[CAJA_DEL_SERVIDOR] = '1110009';
    const r = res();
    await aprobarRecibo(rq, r);
    expect(r.statusCode).toBe(200);
    expect(m.crearRecibo.mock.calls[0][0].pagos[0]).toMatchObject({ forma_pago: 'EF', cod_cuenta: '1110009' });
  });

  it('🔴 desde el navegador, Caja Repartos se sigue rechazando: no está en la lista de cajas', async () => {
    const r = res();
    await aprobarRecibo(req({ medio_pago: 'efectivo', cod_cuenta: '1110009' }), r);
    expect(r.statusCode).toBe(400);
    expect(m.crearRecibo).not.toHaveBeenCalled();
  });
});

describe('aprobarRecibo — registra sus tiempos (S32 · mejora 9)', () => {
  it('después de aprobar quedan medidos el total y la emisión en IM', async () => {
    const { resumenTiempos, reiniciarTiempos } = await import('./tiempos.js');
    reiniciarTiempos();
    m.crearRecibo.mockResolvedValue({ ok: true, id: '1', raw: {} });
    await aprobarRecibo(req(), res());
    const t = resumenTiempos();
    expect(t['recibo.aprobar']?.n).toBe(1);
    expect(t['im.recibo.post']?.n).toBe(1);
  });
});
