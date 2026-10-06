import { describe, it, expect, vi } from 'vitest';
import { firmaDelDia, RenglonesFirmados } from './renglonesPorDia.js';

const fila = (id: number, extra: Record<string, unknown> = {}) =>
  ({ id, fecha: '2026-10-06', tipo_comprobante: 'PR', total: 1000, anulada: 'N', ...extra });

describe('firmaDelDia', () => {
  it('no depende del orden de las filas ni de las de otros días', () => {
    const a = [fila(1), fila(2), fila(9, { fecha: '2026-10-05' })];
    const b = [fila(2), fila(1)];
    expect(firmaDelDia(a, '2026-10-06')).toBe(firmaDelDia(b, '2026-10-06'));
  });
  it('cambia con un pedido nuevo, un total editado, una anulación o una fecha movida', () => {
    const base = firmaDelDia([fila(1), fila(2)], '2026-10-06');
    expect(firmaDelDia([fila(1), fila(2), fila(3)], '2026-10-06')).not.toBe(base);
    expect(firmaDelDia([fila(1), fila(2, { total: 1200 })], '2026-10-06')).not.toBe(base);
    expect(firmaDelDia([fila(1), fila(2, { anulada: 'S' })], '2026-10-06')).not.toBe(base);
    expect(firmaDelDia([fila(1), fila(2, { fecha: '2026-10-07' })], '2026-10-06')).not.toBe(base);
  });
});

describe('RenglonesFirmados', () => {
  it('reusa el día si el listado no cambió y relee si cambió', async () => {
    const r = new RenglonesFirmados<string>();
    const leer = vi.fn().mockResolvedValueOnce('v1').mockResolvedValueOnce('v2');
    expect(await r.obtener('2026-10-06', 'A', leer)).toBe('v1');
    expect(await r.obtener('2026-10-06', 'A', leer)).toBe('v1');
    expect(leer).toHaveBeenCalledTimes(1);
    expect(await r.obtener('2026-10-06', 'B', leer)).toBe('v2');
    expect(leer).toHaveBeenCalledTimes(2);
  });

  it('vence a los 10 minutos aunque el listado no cambie (ediciones con el mismo total)', async () => {
    let t = 0;
    const r = new RenglonesFirmados<string>(10 * 60_000, 10, () => t);
    const leer = vi.fn().mockResolvedValueOnce('viejo').mockResolvedValueOnce('nuevo');
    await r.obtener('d', 'A', leer);
    t = 9 * 60_000;
    expect(await r.obtener('d', 'A', leer)).toBe('viejo');
    t = 10 * 60_000;
    expect(await r.obtener('d', 'A', leer)).toBe('nuevo');
  });

  it('olvidar() fuerza la relectura, y una lectura en vuelo no guarda lo olvidado', async () => {
    const r = new RenglonesFirmados<string>();
    let soltar!: (v: string) => void;
    const lenta = r.obtener('d', 'A', () => new Promise<string>(res => { soltar = res; }));
    r.olvidar();
    soltar('de antes');
    expect(await lenta).toBe('de antes');
    const leer = vi.fn().mockResolvedValue('fresco');
    expect(await r.obtener('d', 'A', leer)).toBe('fresco');
    expect(leer).toHaveBeenCalledTimes(1);
  });

  it('guarda como mucho N días', async () => {
    const r = new RenglonesFirmados<string>(60_000, 2);
    const leer = vi.fn().mockResolvedValue('x');
    await r.obtener('d1', 'A', leer); await r.obtener('d2', 'A', leer); await r.obtener('d3', 'A', leer);
    await r.obtener('d1', 'A', leer);
    expect(leer).toHaveBeenCalledTimes(4);
  });

  it('un fallo de lectura no guarda nada', async () => {
    const r = new RenglonesFirmados<string>();
    await expect(r.obtener('d', 'A', () => Promise.reject(new Error('IM')))).rejects.toThrow('IM');
    const leer = vi.fn().mockResolvedValue('ok');
    expect(await r.obtener('d', 'A', leer)).toBe('ok');
  });
});
