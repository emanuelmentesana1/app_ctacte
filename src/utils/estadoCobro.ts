/**
 * Cómo se dice el estado de cobro de cada cliente de una hoja. Lo usan Rendiciones, la hoja impresa con los recibos
 * y el cierre de la hoja (Mati, 06/10/2026): los tres tienen que decir lo mismo.
 */
export type EstadoCobro = 'pago' | 'entrega' | 'deuda_vieja' | 'parcial' | 'de_mas' | 'sin_cobro' | 'no_salio';

export const ESTADO_COBRO: Record<EstadoCobro, { texto: string; clase: string }> = {
    pago: { texto: 'Pagó todo', clase: 'ok' },
    entrega: { texto: 'Pagó la entrega', clase: 'ok' },
    deuda_vieja: { texto: 'Pagó la deuda vieja', clase: 'ok' },
    parcial: { texto: 'Pagó parte', clase: 'ambar' },
    de_mas: { texto: 'Pagó de más', clase: 'verde' },
    sin_cobro: { texto: 'Sin cobro', clase: 'rojo' },
    no_salio: { texto: 'No salió', clase: 'gris' },
};
