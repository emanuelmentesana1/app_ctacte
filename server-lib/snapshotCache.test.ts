import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./infomanager.js', () => ({ fetchVentas: vi.fn(async () => []), fetchVentasItems: vi.fn(async () => []) }));

import { fetchVentas } from './infomanager.js';
import { getMonthlyVentasRaw, invalidateMonth } from './snapshotCache.js';

/**
 * 🔴 30/09/2026 — el mes en curso refresca su cache cada 30 min y los históricos cada 24 h. Se
 * decidía con `getUTCMonth()` y el server corre en UTC: desde las 21:00 del último día el mes
 * que se está cerrando pasaba a "histórico" y lo que se facturaba esas tres horas no se veía.
 */
describe('cache del mes: el mes en curso es el de Tucumán, no el de UTC', () => {
  beforeEach(() => { vi.clearAllMocks(); invalidateMonth(2026, 9); invalidateMonth(2026, 8); });
  afterEach(() => { vi.useRealTimers(); });
  const congelar = (iso: string) => { vi.useFakeTimers(); vi.setSystemTime(new Date(iso)); };

  it('el 30/09 a las 21:30 de Tucumán septiembre sigue en curso: a los 35 min se refresca', async () => {
    congelar('2026-10-01T00:30:00.000Z');
    await getMonthlyVentasRaw(2026, 9);
    vi.setSystemTime(new Date('2026-10-01T01:05:00.000Z'));
    await getMonthlyVentasRaw(2026, 9);
    expect(fetchVentas).toHaveBeenCalledTimes(2);
  });

  it('agosto, que sí cerró, sigue con su cache de 24 h', async () => {
    congelar('2026-10-01T00:30:00.000Z');
    await getMonthlyVentasRaw(2026, 8);
    vi.setSystemTime(new Date('2026-10-01T01:05:00.000Z'));
    await getMonthlyVentasRaw(2026, 8);
    expect(fetchVentas).toHaveBeenCalledTimes(1);
  });
});
