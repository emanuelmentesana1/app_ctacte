import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * «Corregir en IM» un recibo ya emitido (Mati, 06/10/2026, caso MONTENORT): sólo admin o gerente; primero el plan
 * (qué va a pasar en IM, sin tocar nada); al corregir, la cuenta se cambia editando el recibo en IM5, se verifica
 * releyendo IM y recién ahí se cambia la app. Todo queda en recibos_correcciones (migración 060).
 */

const m = vi.hoisted(() => ({
  tablas: {} as Record<string, any[]>,
  errores: {} as Record<string, { code: string; message: string } | undefined>,
  comprobante: vi.fn(),
  editar: vi.fn(),
  anular: vi.fn(),
  pendientes: vi.fn(),
  crear: vi.fn(),
  configurado: vi.fn(() => true),
}));

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
          const nuevas = (Array.isArray(valores) ? valores : [valores]).map((v: any) => ({ id: `${tabla}-${filas.length + 1}`, ...v }));
          filas.push(...nuevas);
          return { data: unico ? nuevas[0] : nuevas, error: null };
        }
        const sel = filas.filter(r => filtros.every(f => f(r)));
        if (op === 'update') sel.forEach(r => Object.assign(r, valores));
        return { data: unico ? (sel[0] ?? null) : sel, error: null };
      };
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => (filtros.push(r => r[c] === v), q),
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
vi.mock('./im5Web.js', () => ({
  im5: { comprobante: m.comprobante, editarRecibo: m.editar, anular: m.anular },
  im5Configurado: m.configurado,
  ErrorIM5: class ErrorIM5 extends Error { constructor(msg: string, public status = 502, public sinRespuesta = false) { super(msg); } },
}));
vi.mock('./infomanager.js', () => ({ fetchComprobPendientes: m.pendientes, crearRecibo: m.crear }));
vi.mock('./cuentasResolver.js', () => ({
  resolveCuentaCod: vi.fn(async (medio: string) => ({ mercadopago: '1120003', recaudadora_1: '1120005', efectivo: '1110005' } as Record<string, string>)[medio] ?? null),
  listCuentasEfectivo: vi.fn(async () => [{ cod_cuenta: '1110005', nombre: 'Caja Casa Central', es_default: true }, { cod_cuenta: '1110004', nombre: 'Caja Chica 2', es_default: false }]),
}));

const { corregirRecibo } = await import('./corregirRecibo.js');
const { ErrorIM5 } = await import('./im5Web.js');
const { cuerpoEdicionRecibo } = await import('./im5Recibos.js');

const MATI = { sub: 'u-mati', email: 'mati@x', rol: 'admin', cod_vendedor: null };
const ANTO = { sub: 'u-anto', email: 'anto@x', rol: 'administrativo', cod_vendedor: null };

const detalle = (cuenta = '1120003', p: Record<string, unknown> = {}) => ({
  success: true,
  cabecera: {
    tipo_comprobante: 'RC', tipo_recibo: 'L', tipo_factura: null, cod_cliente: '750', tag: 'S', fecha: '2026-09-30', punto_de_venta: '0',
    moneda: 'P', cotizacion: '1.000000', moneda_2: 'P', cotizacion_2: '1.000000', observaciones: 'Cobro', numero: '30156202', anulada: 'N',
    total: '418719.000000', usuario: 'matias', tiene_derivado: 0, ...p,
  },
  rc_comprobantes: [{ id_comprob_pagado: '58997783', tipo: 'FA', punto_de_venta: '777', importe_pagado: '418719.000000', circuito: 'V', id_asiento: null }],
  rc_pagos: [{ cond_pago: 'OT', importe: '418719.000000', cod_cuenta: cuenta, cod_unidad_negocio: null }],
  rc_retenciones: [],
  rc_ncnd: [],
});
function req(user: any, body: Record<string, unknown>) {
  return { params: { id: 'c-835a' }, user, body } as any;
}
function res() {
  const r: any = { statusCode: 200, body: null };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}
const corregir = async (user: any, body: Record<string, unknown>) => { const r = res(); await corregirRecibo(req(user, body), r); return r; };

beforeEach(() => {
  m.errores = {};
  m.tablas = {
    comprobantes_pago: [{
      id: 'c-835a', tenant_id: 't', cod_cliente: 750, monto: 418_719, fecha_comprobante: '2026-09-30', medio_pago: 'mercadopago',
      status: 'imputado', infomanager_recibo_id: '59024166',
      infomanager_response: { recibo: { id: 59024166, numero: 30156202, usuario: 'matias', pagos: [{ cod_cuenta: 1120003, importe: 418719 }] } },
    }],
    recibos_correcciones: [],
  };
  m.configurado.mockReturnValue(true);
  m.comprobante.mockReset().mockResolvedValueOnce(detalle('1120003')).mockResolvedValueOnce(detalle('1120005'));
  m.editar.mockReset().mockResolvedValue({ success: true, id: 59024166 });
  m.anular.mockReset().mockResolvedValue({ success: true, id: 59024166 });
  // La FA 777-51049: $418.768,30, pagada con el recibo menos $49,30. Al anularlo, vuelve a deber todo.
  m.pendientes.mockReset().mockResolvedValue([{ id: 58997783, saldo: 49.3, fecha_factura: '2026-09-30' }]);
  m.crear.mockReset().mockResolvedValue({ ok: true, id: '59100001', raw: { recibo: { id: 59100001, numero: 30156500, usuario: 'matias', pagos: [{ cod_cuenta: 1120003, importe: 418768 }], comprobantes: [{ id: 59100002, numero: 51049, punto_de_venta: 777, importe_pagado: 418768 }] } } });
});

describe('Corregir en IM — quién y cuándo', () => {
  it('🔴 un vendedor no corrige en IM', async () => {
    const r = await corregir({ ...ANTO, rol: 'vendedor' }, { accion: 'corregir', cambios: { medio_pago: 'recaudadora_1' } });
    expect(r.statusCode).toBe(403);
    expect(m.editar).not.toHaveBeenCalled();
  });

  it('🔑 Anto (administrativo) sí: Mati, 06/10/2026', async () => {
    const r = await corregir(ANTO, { accion: 'corregir', cambios: { medio_pago: 'recaudadora_1' } });
    expect(r.statusCode).toBe(200);
    expect(m.tablas.recibos_correcciones[0]).toMatchObject({ estado: 'hecha', por: 'u-anto' });
  });

  it('🔑 el plan dice qué va a pasar en IM y no toca nada', async () => {
    const r = await corregir(MATI, { accion: 'plan', cambios: { medio_pago: 'recaudadora_1' } });
    expect(r.statusCode).toBe(200);
    expect(r.body.plan).toMatchObject({ tipo: 'cuenta', desde: '1120003', hacia: '1120005' });
    expect(r.body.recibo_im).toBe('30156202');
    expect(m.editar).not.toHaveBeenCalled();
    expect(m.tablas.recibos_correcciones).toHaveLength(0);
  });

  it('sin las variables de IM5 en el servidor, dice cuáles faltan y no toca nada', async () => {
    m.configurado.mockReturnValue(false);
    const r = await corregir(MATI, { accion: 'corregir', cambios: { medio_pago: 'recaudadora_1' } });
    expect(r.statusCode).toBe(503);
    expect(r.body.error).toMatch(/IM5_USUARIO/);
    expect(m.editar).not.toHaveBeenCalled();
  });
});

describe('Corregir en IM — cambio de cuenta (MONTENORT)', () => {
  it('🔑 edita en IM5 con el cuerpo de la pantalla, verifica releyendo, cambia la app y deja registro', async () => {
    const r = await corregir(MATI, { accion: 'corregir', cambios: { medio_pago: 'recaudadora_1' } });
    expect(r.statusCode).toBe(200);
    expect(m.editar).toHaveBeenCalledTimes(1);
    expect(m.editar.mock.calls[0][0]).toBe('59024166');
    expect(m.editar.mock.calls[0][1]).toEqual(cuerpoEdicionRecibo(detalle('1120003') as any, { codCuenta: '1120005' }));
    const comp = m.tablas.comprobantes_pago[0];
    expect(comp.medio_pago).toBe('recaudadora_1');
    expect(comp.infomanager_response.recibo.pagos[0].cod_cuenta).toBe('1120005');
    expect(m.tablas.recibos_correcciones[0]).toMatchObject({
      comprobante_id: 'c-835a', im_recibo_id: '59024166', tipo: 'cuenta', estado: 'hecha', por: 'u-mati',
      antes: { cuenta: '1120003', medio_pago: 'mercadopago', numero: '30156202' }, despues: { cuenta: '1120005', medio_pago: 'recaudadora_1', numero: '30156202' },
    });
  });

  it('🔴 si al releer IM no quedó la cuenta nueva, la app no cambia y el registro queda en error', async () => {
    m.comprobante.mockReset().mockResolvedValue(detalle('1120003'));
    const r = await corregir(MATI, { accion: 'corregir', cambios: { medio_pago: 'recaudadora_1' } });
    expect(r.statusCode).toBe(502);
    expect(m.tablas.comprobantes_pago[0].medio_pago).toBe('mercadopago');
    expect(m.tablas.recibos_correcciones[0]).toMatchObject({ estado: 'error' });
  });

  it('🪤 si IM5 no contesta al grabar, se verifica releyendo: si quedó, se completa', async () => {
    m.editar.mockReset().mockRejectedValue(new ErrorIM5('IM5 no contestó (timeout).', 502, true));
    const r = await corregir(MATI, { accion: 'corregir', cambios: { medio_pago: 'recaudadora_1' } });
    expect(r.statusCode).toBe(200);
    expect(m.tablas.comprobantes_pago[0].medio_pago).toBe('recaudadora_1');
    expect(m.tablas.recibos_correcciones[0]).toMatchObject({ estado: 'hecha' });
  });

  it('🔴 sin la migración 060 no se toca IM: sin registro no hay corrección', async () => {
    m.errores.recibos_correcciones = { code: '42P01', message: 'relation "recibos_correcciones" does not exist' };
    const r = await corregir(MATI, { accion: 'corregir', cambios: { medio_pago: 'recaudadora_1' } });
    expect(r.statusCode).toBe(503);
    expect(r.body.error).toMatch(/060/);
    expect(m.editar).not.toHaveBeenCalled();
  });

  it('🔴 si IM no coincide con la app, no se toca nada y dice por qué', async () => {
    m.comprobante.mockReset().mockResolvedValue(detalle('1120003', { total: '500000.000000' }));
    const r = await corregir(MATI, { accion: 'corregir', cambios: { medio_pago: 'recaudadora_1' } });
    expect(r.statusCode).toBe(409);
    expect(r.body.error).toMatch(/revisalo/i);
    expect(m.editar).not.toHaveBeenCalled();
  });


  it('si IM ya tiene esa cuenta y sólo la app tenía mal el medio, se corrige la app sin tocar IM', async () => {
    m.comprobante.mockReset().mockResolvedValue(detalle('1120005'));
    const r = await corregir(MATI, { accion: 'corregir', cambios: { medio_pago: 'recaudadora_1' } });
    expect(r.statusCode).toBe(200);
    expect(r.body.plan).toMatchObject({ tipo: 'solo_app' });
    expect(m.editar).not.toHaveBeenCalled();
    expect(m.tablas.comprobantes_pago[0].medio_pago).toBe('recaudadora_1');
  });

  it('en efectivo, la cuenta nueva es la caja elegida, y sólo una habilitada', async () => {
    m.tablas.comprobantes_pago[0].medio_pago = 'efectivo';
    m.comprobante.mockReset().mockResolvedValueOnce(detalle('1110005')).mockResolvedValueOnce(detalle('1110004'));
    const ok = await corregir(MATI, { accion: 'plan', cambios: { cod_cuenta: '1110004' } });
    expect(ok.body.plan).toMatchObject({ tipo: 'cuenta', desde: '1110005', hacia: '1110004' });
    const mal = await corregir(MATI, { accion: 'plan', cambios: { cod_cuenta: '1110009' } });
    expect(mal.statusCode).toBe(400);
  });
});

describe('Corregir en IM — monto, cliente o fecha: anular y reemitir (tanda 2)', () => {
  const anulado = () => detalle('1120003', { anulada: 'S' });
  beforeEach(() => {
    m.comprobante.mockReset().mockResolvedValueOnce(detalle('1120003')).mockResolvedValueOnce(anulado());
    // Después de anular, la FA vuelve a deber lo que pagaba el recibo.
    m.pendientes.mockReset().mockResolvedValueOnce([{ id: 58997783, saldo: 49.3, fecha_factura: '2026-09-30' }]).mockResolvedValue([{ id: 58997783, saldo: 418_768.3, fecha_factura: '2026-09-30' }]);
  });

  it('🔑 el plan dice qué se anula y qué se emite: cliente, monto, fecha, cuenta y facturas', async () => {
    m.pendientes.mockReset().mockResolvedValue([{ id: 58997783, saldo: 49.3, fecha_factura: '2026-09-30' }]);
    const r = await corregir(MATI, { accion: 'plan', cambios: { monto: 418_768 } });
    expect(r.statusCode).toBe(200);
    expect(r.body.plan).toMatchObject({ tipo: 'anular_reemitir', nuevo: { cod_cliente: 750, monto: 418_768, fecha: '2026-09-30', cuenta: '1120003', facturas: [{ id: '58997783', importe: 418_768 }] } });
    expect(m.anular).not.toHaveBeenCalled();
    expect(m.crear).not.toHaveBeenCalled();
  });

  it('🔑 corregir: registra, anula en IM5 y lo confirma, emite el nuevo con el MISMO usuario (la caja) y deja la app con el número nuevo', async () => {
    const r = await corregir(MATI, { accion: 'corregir', cambios: { monto: 418_768 } });
    expect(r.statusCode).toBe(200);
    expect(m.anular).toHaveBeenCalledWith('59024166');
    const pedido = m.crear.mock.calls[0][0];
    expect(pedido).toMatchObject({ cod_cliente: '750', fecha: '2026-09-30', usuario: 'matias', comprobantes: [{ id: '58997783', importe_a_pagar: '418768.00' }] });
    expect(pedido.pagos[0]).toMatchObject({ forma_pago: 'OT', importe: '418768.00', cod_cuenta: '1120003' });
    expect(pedido.detalle).toMatch(/Reemplaza al RC 30156202/);
    const comp = m.tablas.comprobantes_pago[0];
    expect(comp).toMatchObject({ status: 'imputado', monto: 418_768, infomanager_recibo_id: '59100001', error_msg: null });
    expect(comp.infomanager_response.reemplaza).toMatchObject({ id: '59024166', numero: '30156202' });
    expect(m.tablas.recibos_correcciones[0]).toMatchObject({ tipo: 'anular_reemitir', estado: 'hecha', despues: { numero: '30156500', id: '59100001', monto: 418_768 } });
  });

  it('🔴 si IM5 no anula, no se emite nada y la app no cambia', async () => {
    m.anular.mockReset().mockRejectedValue(new ErrorIM5('IM5 rechazó el pedido (400: No se puede anular).', 502));
    const r = await corregir(MATI, { accion: 'corregir', cambios: { monto: 418_768 } });
    expect(r.statusCode).toBe(502);
    expect(m.crear).not.toHaveBeenCalled();
    expect(m.tablas.comprobantes_pago[0]).toMatchObject({ status: 'imputado', monto: 418_719 });
    expect(m.tablas.recibos_correcciones[0]).toMatchObject({ estado: 'error' });
  });

  it('🔴 anulado pero el nuevo no sale: la app lo deja en error con los datos nuevos, listo para reprocesar, y lo dice', async () => {
    m.crear.mockReset().mockResolvedValue({ ok: false, error: 'HTTP 400', raw: { mensaje: 'Validaciones' } });
    const r = await corregir(MATI, { accion: 'corregir', cambios: { monto: 418_768 } });
    expect(r.statusCode).toBe(502);
    expect(r.body.error).toMatch(/anuló/i);
    const comp = m.tablas.comprobantes_pago[0];
    expect(comp).toMatchObject({ status: 'error', monto: 418_768, infomanager_recibo_id: null });
    expect(comp.error_msg).toMatch(/Reabrir para reprocesar/);
    expect(m.tablas.recibos_correcciones[0]).toMatchObject({ estado: 'error', error: expect.stringMatching(/ANULADO SIN REEMPLAZO/) });
  });

  it('🔴 más plata que toda la deuda (anticipo): no se toca IM', async () => {
    const r = await corregir(MATI, { accion: 'corregir', cambios: { monto: 900_000 } });
    expect(r.statusCode).toBe(409);
    expect(r.body.error).toMatch(/anticipo/i);
    expect(m.anular).not.toHaveBeenCalled();
  });

  it('🔴 un recibo de la rendición de una hoja no se reemite desde acá', async () => {
    m.tablas.comprobantes_pago[0].hoja_id = 'h3449';
    const r = await corregir(MATI, { accion: 'corregir', cambios: { monto: 418_768 } });
    expect(r.statusCode).toBe(409);
    expect(m.anular).not.toHaveBeenCalled();
  });
});
