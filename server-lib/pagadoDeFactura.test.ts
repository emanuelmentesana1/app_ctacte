import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });
const { pagoSegunReporte } = await import('./infomanager.js');

/** Una fila real de /reportes/facturas (FA B 51277, MEDINA DORA, 06/10/2026). */
const FILA = { fa_id: 59078448, fa_nro: 51277, fa_fecha: '2026-10-07', fa_total: 336254.45, rc_imp_pagado: 0, saldo_fa: 336254.45, ultimo_recibo: 0 };

describe('pagoSegunReporte', () => {
  it('encuentra la factura por id aunque IM lo mande como número', () => {
    expect(pagoSegunReporte([{ ...FILA, fa_id: 1 }, FILA], '59078448')).toEqual({ pagado: 0, saldo: 336254.45 });
  });
  it('con un recibo imputado devuelve lo pagado', () => {
    expect(pagoSegunReporte([{ ...FILA, rc_imp_pagado: 100000, saldo_fa: 236254.45 }], '59078448')).toEqual({ pagado: 100000, saldo: 236254.45 });
  });
  it('🔴 si no está, o los importes no se leen, devuelve null: no se afirma que no tenga pagos', () => {
    expect(pagoSegunReporte([FILA], '1')).toBeNull();
    expect(pagoSegunReporte([{ ...FILA, rc_imp_pagado: 'x' }], '59078448')).toBeNull();
  });
});
