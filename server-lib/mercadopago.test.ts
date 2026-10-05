import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * La verificación automática de MercadoPago pedía UNA página de 50 pagos y no seguía. Del 29/09 al
 * 02/10/2026 la cuenta principal tuvo 95 pagos aprobados: del 51 en adelante salía "no encontrado"
 * aunque el pago hubiera entrado (medido el 05/10). Eso le resta recibos al lote de Cobranzas y le
 * suma trabajo a mano a Anto.
 */
const m = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('axios', () => ({ default: { get: m.get } }));

process.env.MP_TOKEN_PRINCIPAL = 'token-de-prueba';
delete process.env.MP_TOKEN_RECAUDADORA_1;
delete process.env.MP_TOKEN_RECAUDADORA_2;
const { buscarPagoEnMP } = await import('./mercadopago.js');

const pago = (id: number, monto: number) => ({ id, transaction_amount: monto, status: 'approved', date_approved: '2026-09-30T15:00:00.000-03:00' });
const pagina = (desde: number, cantidad: number) => Array.from({ length: cantidad }, (_, i) => pago(desde + i, 1_000 + desde + i));

beforeEach(() => { m.get.mockReset(); });

describe('buscarPagoEnMP — recorre todas las páginas', () => {
  it('🔑 encuentra el pago aunque esté después de los primeros 50', async () => {
    m.get.mockImplementation(async (_url: string, cfg: { params: { offset?: number } }) => {
      const offset = cfg.params.offset ?? 0;
      const results = offset === 0 ? pagina(1, 50) : [pago(2000, 418_769.3), ...pagina(3000, 44)];
      return { data: { results, paging: { total: 95, limit: 50, offset } } };
    });
    const r = await buscarPagoEnMP({ monto: 418_769.3, desdeISO: '2026-09-29', hastaISO: '2026-10-02' });
    expect(r.map(x => x.payment_id)).toEqual(['2000']);
  });

  it('con una sola página no pide de más', async () => {
    m.get.mockResolvedValue({ data: { results: [pago(1, 100)], paging: { total: 1, limit: 50, offset: 0 } } });
    await buscarPagoEnMP({ monto: 100, desdeISO: '2026-09-29', hastaISO: '2026-10-02' });
    expect(m.get).toHaveBeenCalledTimes(1);
  });

  it('no se queda pidiendo para siempre: corta en 1.000 pagos por cuenta', async () => {
    m.get.mockImplementation(async (_url: string, cfg: { params: { offset?: number } }) =>
      ({ data: { results: pagina((cfg.params.offset ?? 0) + 1, 50), paging: { total: 100_000, limit: 50, offset: cfg.params.offset ?? 0 } } }));
    await buscarPagoEnMP({ monto: 1, desdeISO: '2026-01-01', hastaISO: '2026-10-02' });
    expect(m.get).toHaveBeenCalledTimes(20);
  });
});
