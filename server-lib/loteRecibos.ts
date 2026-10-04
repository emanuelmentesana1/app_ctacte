/**
 * Qué recibos entran en la aprobación EN LOTE y cómo se imputa cada uno. Lógica pura.
 *
 * S32 · mejora 4 (Mati, 04/10/2026). En septiembre MercadoPago verificó solo 319 de los 468
 * recibos imputados, y 280 de ellos fueron a una sola factura: ahí no hay nada que decidir.
 * Entra al lote sólo lo que no necesita criterio; todo lo demás queda para revisar uno por uno.
 * La imputación es la misma regla de la pantalla (la deuda más vieja primero) y la emisión pasa
 * por el mismo `aprobarRecibo` de siempre, con su pre-chequeo contra IM.
 */
import { preseleccionFIFO, type FacturaParaImputar } from '../src/utils/aprobacionRecibos.js';

export interface CandidatoLote {
    id: string;
    cod_cliente: number;
    monto: number;
    /** yyyy-MM-dd: la fecha del comprobante (o la de MercadoPago). */
    fecha: string | null;
    medio_pago: string | null;
    mp_status: string | null;
    status: string;
    observaciones: string | null;
}

export type EstadoLote = 'listo' | 'salteado' | 'en_espera';
export interface PasoLote {
    id: string;
    cod_cliente: number;
    monto: number;
    fecha: string | null;
    estado: EstadoLote;
    motivo?: string;
    comprobantes?: Array<{ id: string; importe_a_pagar: number }>;
}

/** Igual que la pantalla de aprobación: hasta $5 de diferencia lo absorbe el ajuste de IM. */
const TOLERANCIA = 5;

export function planDelLote(
    candidatos: CandidatoLote[],
    pendientesDe: (codCliente: number) => FacturaParaImputar[],
    duplicadosDe: (c: CandidatoLote) => { app: unknown[]; im: unknown[] },
    tope: number,
): PasoLote[] {
    let listos = 0;
    return candidatos.map(c => {
        const base = { id: c.id, cod_cliente: c.cod_cliente, monto: Number(c.monto), fecha: c.fecha };
        const salteado = (motivo: string): PasoLote => ({ ...base, estado: 'salteado', motivo });
        if (c.status !== 'pendiente_revision') return salteado('Ya no está pendiente.');
        if (c.medio_pago !== 'mercadopago' || c.mp_status !== 'verified') return salteado('MercadoPago no lo verificó: revisalo a mano.');
        if (!(Number(c.monto) > 0.01)) return salteado('No tiene monto.');
        if (!c.fecha || !/^\d{4}-\d{2}-\d{2}$/.test(c.fecha)) return salteado('No tiene fecha del comprobante.');
        if (String(c.observaciones ?? '').trim()) return salteado('Tiene observaciones del vendedor: revisalo a mano.');
        const elegidas = preseleccionFIFO(pendientesDe(c.cod_cliente), Number(c.monto));
        const imputado = Object.values(elegidas).reduce((s, x) => s + x, 0);
        if (Math.abs(imputado - Number(c.monto)) > TOLERANCIA) {
            return salteado('El pago supera la deuda pendiente (¿anticipo o saldo a favor?): revisalo a mano.');
        }
        const dup = duplicadosDe(c);
        if (dup.app.length || dup.im.length) return salteado('Puede estar repetido: revisalo a mano.');
        if (listos >= tope) return { ...base, estado: 'en_espera', motivo: `Tope del piloto: ${tope} por tanda.` };
        listos += 1;
        return { ...base, estado: 'listo', comprobantes: Object.entries(elegidas).map(([id, importe_a_pagar]) => ({ id, importe_a_pagar })) };
    });
}
