import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Aislamos syncVentas.ts de sus dependencias pesadas para poder probar el
// cableado de invalidación de caches sin tocar IM / Supabase / snapshotCache.
vi.mock('./goalsResponseCache.js', () => ({ invalidateByPrefix: vi.fn() }));
vi.mock('./snapshotCache.js', () => ({ invalidateMonth: vi.fn(), invalidateItemsMonth: vi.fn() }));
vi.mock('./notificacionesAlertas.js', () => ({ invalidateAlertasVendedor: vi.fn() }));
vi.mock('./historialCompras.js', () => ({ invalidateHistorialCache: vi.fn() }));
vi.mock('./infomanager.js', () => ({
  // El cache de /ventas se limpia junto con las vistas (10/09/2026).
  invalidarCacheVentas: vi.fn(),
  invalidarCacheItems: vi.fn(), fetchVentas: vi.fn(), fetchVentasItems: vi.fn() }));
vi.mock('./supabase.js', () => ({ sb: vi.fn(), TENANT_ID: 'test', hasSupabase: () => false }));
vi.mock('./comisionesShared.js', () => ({ COD_EMPRESA_CASA_CENTRAL: 1, COD_CLIENTES_INTERNOS: new Set() }));
vi.mock('./comisionOverrides.js', () => ({ loadVendedorOverrides: vi.fn(), resolveCodVendedor: vi.fn() }));
vi.mock('../src/utils/ventas.js', () => ({ computeVentaNeta: vi.fn(), monthKey: vi.fn() }));

import { invalidateMonthCaches, syncVentasMesActual, syncVentasMeses } from './syncVentas.js';
import { invalidateByPrefix } from './goalsResponseCache.js';
import { invalidateMonth, invalidateItemsMonth } from './snapshotCache.js';
import { invalidateAlertasVendedor } from './notificacionesAlertas.js';
import { invalidateHistorialCache } from './historialCompras.js';

describe('invalidateMonthCaches', () => {
  beforeEach(() => vi.clearAllMocks());

  it('invalida los caches ya existentes del mes (goals, clientes, snapshot, items)', () => {
    invalidateMonthCaches(2026, 7);
    expect(invalidateByPrefix).toHaveBeenCalledWith('goals:2026-07:');
    expect(invalidateByPrefix).toHaveBeenCalledWith('clientes:2026-07:');
    expect(invalidateMonth).toHaveBeenCalledWith(2026, 7, undefined);
    expect(invalidateItemsMonth).toHaveBeenCalledWith(2026, 7, undefined);
  });

  it('invalida TAMBIÉN los caches de alertas (campana + historial): una venta nueva no puede dejar alertas rancias', () => {
    invalidateMonthCaches(2026, 7);
    // Sin argumentos = clear total: el sync no sabe qué vendedor/cliente cambió.
    expect(invalidateAlertasVendedor).toHaveBeenCalled();
    expect(invalidateHistorialCache).toHaveBeenCalled();
  });
});

/**
 * 🔴 30/09/2026 — el mes en curso se sacaba con `getUTCMonth()` y el server corre en UTC. Desde
 * las 21:00 del último día, UTC ya está en el mes siguiente: el sync de cada hora y el botón
 * "Actualizar avance" leían OCTUBRE y septiembre quedaba congelado en pleno cierre, hasta el
 * sync diario de la 01:00. Es el mismo bug que `hoyArgentina.ts` arregló en el navegador el 01/09.
 *
 * Sin Supabase (mockeado arriba) el sync no llega a IM, pero devuelve el rango que iba a pedir.
 */
describe('el mes en curso es el de Tucumán, no el de UTC', () => {
  afterEach(() => { vi.useRealTimers(); });
  const congelar = (iso: string) => { vi.useFakeTimers(); vi.setSystemTime(new Date(iso)); };

  it('el 30/09 a las 21:30 de Tucumán (ya 01/10 en UTC) el sync de la hora y el botón leen septiembre', async () => {
    congelar('2026-10-01T00:30:00.000Z');
    const r = await syncVentasMesActual();
    expect([r.desde, r.hasta]).toEqual(['2026-09-01', '2026-09-30']);
  });

  it('el resync de varios meses también arranca por septiembre', async () => {
    congelar('2026-10-01T00:30:00.000Z');
    const [actual, anterior] = await syncVentasMeses(2);
    expect([actual.desde, actual.hasta]).toEqual(['2026-09-01', '2026-09-30']);
    expect(anterior.desde).toBe('2026-08-01');
  });

  it('pasada la medianoche de Tucumán ya es octubre', async () => {
    congelar('2026-10-01T03:30:00.000Z');
    const r = await syncVentasMesActual();
    expect([r.desde, r.hasta]).toEqual(['2026-10-01', '2026-10-31']);
  });
});
