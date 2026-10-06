// ═══════════════════════════════════════════════════════════════════════════
// Premio por cumplimiento del objetivo del mes — LÓGICA PURA.
//
// Decisión de Manolo (06/10/2026), rige desde SEPTIEMBRE 2026:
//   1. Cumplimiento del objetivo en pesos (el mismo % de la pestaña Objetivos:
//      neto vendido / objetivo neto):
//        · menos de 95%      → sin premio
//        · 95% a menos de 100% → 7,5% de la comisión neta
//        · 100% o más        → 15% de la comisión neta
//   2. "Comisión neta" = comisión bruta − 3% de rebotes M.C. vendedor
//      + 3% de rebotes de empresa/depósito. Es la base del premio.
//   3. Requisito: cumplir al menos 2 objetivos de producto (en unidades) del
//      mes, tenga las familias que tenga. Cumplido = 100% o más de las unidades.
//      Si no llega a 2, el premio se reduce 50%. Si no tiene objetivos de
//      producto cargados, no se reduce (no hay requisito que cumplir).
//
// Separado de comisiones.ts (IO) para poder probarlo sin InfoManager ni
// Supabase, igual que rebotesParser.ts.
// ═══════════════════════════════════════════════════════════════════════════

export const PREMIO_RIGE_DESDE = { year: 2026, month: 9 } as const;

export function rigePremioObjetivo(year: number, month: number): boolean {
  return year > PREMIO_RIGE_DESDE.year
    || (year === PREMIO_RIGE_DESDE.year && month >= PREMIO_RIGE_DESDE.month);
}

/** Tramos de mayor a menor: el primero cuyo `desde` alcanza el cumplimiento gana. */
export const TRAMOS_PREMIO = [
  { desde: 1, tasa: 0.15 },
  { desde: 0.95, tasa: 0.075 },
] as const;

export const MIN_PRODUCTOS_CUMPLIDOS = 2;
export const REDUCCION_SIN_PRODUCTOS = 0.5;

export interface AvanceProductos {
  /** Familias con objetivo en unidades cargadas para el vendedor en el mes. */
  total: number;
  /** Familias con 100% o más de las unidades. */
  cumplidos: number;
}

export interface PremioObjetivo {
  /** neto vendido / objetivo. null = el vendedor no tiene objetivo cargado. */
  pct_cumplimiento: number | null;
  /** 0, 0.075 o 0.15. */
  tasa: number;
  /** La comisión neta sobre la que se calcula. */
  base: number;
  /** base × tasa, antes del requisito de productos. */
  premio_bruto: number;
  productos_total: number;
  productos_cumplidos: number;
  /** true si no llegó a MIN_PRODUCTOS_CUMPLIDOS y se le aplicó la reducción. */
  reducido: boolean;
  /** Lo que se paga. */
  premio: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function tasaPremio(pct: number | null): number {
  if (pct == null || !Number.isFinite(pct)) return 0;
  for (const t of TRAMOS_PREMIO) if (pct >= t.desde) return t.tasa;
  return 0;
}

/** Un objetivo de producto está cumplido cuando las unidades vendidas llegan al objetivo. */
export function productoCumplido(unidades: number, target: number): boolean {
  return target > 0 && unidades >= target;
}

export function calcPremioObjetivo(
  comisionNeta: number,
  pctCumplimiento: number | null,
  productos: AvanceProductos,
): PremioObjetivo {
  const tasa = tasaPremio(pctCumplimiento);
  // Una comisión neta negativa (rebotes que superan la comisión) no genera premio.
  const base = Math.max(0, comisionNeta);
  const premioBruto = r2(base * tasa);
  const reducido = premioBruto > 0
    && productos.total > 0
    && productos.cumplidos < MIN_PRODUCTOS_CUMPLIDOS;
  return {
    pct_cumplimiento: pctCumplimiento,
    tasa,
    base: r2(base),
    premio_bruto: premioBruto,
    productos_total: productos.total,
    productos_cumplidos: productos.cumplidos,
    reducido,
    premio: reducido ? r2(premioBruto * (1 - REDUCCION_SIN_PRODUCTOS)) : premioBruto,
  };
}
