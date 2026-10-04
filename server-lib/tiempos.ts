/**
 * Tiempos de las operaciones de cobranzas, en memoria (S32 · mejora 9, 04/10/2026).
 *
 * Medir antes de optimizar: la app no registraba cuánto tarda IM en emitir un recibo ni cuánto
 * tarda una aprobación entera. Se guardan las últimas 500 mediciones por operación y se reinician
 * con cada despliegue: alcanza para comparar antes y después, sin tablas nuevas.
 */
import type { Request, Response } from 'express';
import type { JwtPayload } from './auth.js';
import { puedeRevisarRecibos } from './permisos.js';

const MAX = 500;
const datos = new Map<string, number[]>();
const desde = new Date().toISOString();

export function registrarTiempo(etiqueta: string, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const lista = datos.get(etiqueta) ?? [];
    lista.push(Math.round(ms));
    if (lista.length > MAX) lista.splice(0, lista.length - MAX);
    datos.set(etiqueta, lista);
}

export function percentil(valores: number[], p: number): number | null {
    if (!valores.length) return null;
    const o = [...valores].sort((a, b) => a - b);
    return o[Math.min(o.length - 1, Math.ceil(p * o.length) - 1)];
}

export function resumenTiempos(): Record<string, { n: number; p50: number | null; p90: number | null; max: number }> {
    const out: Record<string, { n: number; p50: number | null; p90: number | null; max: number }> = {};
    for (const [k, v] of datos) out[k] = { n: v.length, p50: percentil(v, 0.5), p90: percentil(v, 0.9), max: Math.max(...v) };
    return out;
}

export function tiemposDesde(): string { return desde; }
export function reiniciarTiempos(): void { datos.clear(); }

/** GET /api/recibos/tiempos — la oficina y Mati ven cuánto tarda cada paso desde el último despliegue. */
export function tiemposRecibos(req: Request & { user?: JwtPayload }, res: Response): void {
    if (!req.user || !puedeRevisarRecibos(req.user.rol)) { res.status(403).json({ error: 'Requiere admin, gerente o administrativo' }); return; }
    res.json({ ok: true, desde, operaciones: resumenTiempos() });
}
