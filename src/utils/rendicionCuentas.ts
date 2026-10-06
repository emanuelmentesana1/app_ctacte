/**
 * Las cuentas de la rendición de una hoja (etapa 2, 05/10/2026). Puras y compartidas: la pantalla
 * las usa mientras Anto tipea y el servidor, al guardar. Una sola fórmula para los dos lados.
 */

/** Los gastos del viaje de septiembre: combustible, ayudantes, comida y estacionamiento, gomería. */
export const CONCEPTOS_GASTO = ['Ayudante', 'Combustible', 'Comida', 'Estacionamiento', 'Gomería', 'Otro'] as const;
export type ConceptoGasto = typeof CONCEPTOS_GASTO[number];

export interface LineaEfectivo {
    cod_cliente: number;
    importe: number;
    /** A qué facturas va el recibo, si quien rinde la eligió (Mati, 06/10/2026). Sin esto: la más vieja primero. */
    facturas?: Array<{ id: string; importe: number }>;
}
export interface GastoViaje { concepto: ConceptoGasto; importe: number; detalle: string | null }
export interface Borrador {
    efectivo: LineaEfectivo[];
    gastos: GastoViaje[];
    /** null = todavía no se contó (no es lo mismo que contar $0). */
    efectivo_contado: number | null;
    observaciones: string | null;
}

const centavos = (n: number) => Math.round(n * 100) / 100;

/**
 * Un importe tipeado ("412.300", "412.300,50", "$ 18.000"). Misma regla que `parseMontoUpload` del
 * servidor: con coma, el punto separa miles; sin coma, un punto con 1 o 2 decimales es decimal y si no,
 * miles. Vacío = null (no cargado). Lo que no es un número, null.
 */
export function leerImporte(texto: string): number | null {
    let v = String(texto ?? '').replace(/[^\d.,]/g, '');
    if (!v) return null;
    if (v.includes(',')) v = v.replace(/\./g, '').replace(',', '.');
    else if (v.includes('.') && !/^\d+\.\d{1,2}$/.test(v)) v = v.replace(/\./g, '');
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? centavos(n) : null;
}

/**
 * La cuenta de la oficina (la misma que cerró en los 16 asientos de septiembre):
 *   debe entregar = efectivo cobrado − gastos del viaje
 *   diferencia    = contado − debe entregar   (negativa: faltó plata · positiva: sobró)
 */
export function cuentasDeLaRendicion(b: Pick<Borrador, 'efectivo' | 'gastos' | 'efectivo_contado'>): { efectivo: number; gastos: number; debe_entregar: number; contado: number | null; diferencia: number | null } {
    const efectivo = centavos(b.efectivo.reduce((s, l) => s + l.importe, 0));
    const gastos = centavos(b.gastos.reduce((s, g) => s + g.importe, 0));
    const debe = centavos(efectivo - gastos);
    return { efectivo, gastos, debe_entregar: debe, contado: b.efectivo_contado, diferencia: b.efectivo_contado == null ? null : centavos(b.efectivo_contado - debe) };
}

/**
 * Lo que Anto copia en IM para cerrar el día (la API no crea asientos ni órdenes de pago):
 *  · un asiento Caja Repartos → Caja Casa Central por lo contado, con los números de hoja
 *    ("3421,3422-AS", el formato que ya usa la oficina);
 *  · la diferencia de caja del día;
 *  · una orden de pago por cada gasto del viaje, "según HR nnnn".
 */
export function resumenParaIM(hojas: Array<{ numero: number; contado: number | null; diferencia: number | null; gastos: GastoViaje[] }>): {
    asiento: { texto: string; importe: number } | null;
    diferencia: { importe: number } | null;
    ops: Array<{ hoja: number; texto: string; importe: number }>;
    faltan_contar: number[];
} {
    const orden = [...hojas].sort((a, b) => a.numero - b.numero);
    const faltan = orden.filter(h => h.contado == null).map(h => h.numero);
    const ops = orden.flatMap(h => h.gastos.map(g => ({ hoja: h.numero, texto: `según HR ${h.numero} - ${g.concepto === 'Otro' ? g.detalle : g.concepto}`, importe: g.importe })));
    if (faltan.length || !orden.length) return { asiento: null, diferencia: null, ops, faltan_contar: faltan };
    const diferencia = centavos(orden.reduce((s, h) => s + (h.diferencia ?? 0), 0));
    return {
        asiento: { texto: `${orden.map(h => h.numero).join(',')}-AS`, importe: centavos(orden.reduce((s, h) => s + (h.contado ?? 0), 0)) },
        diferencia: diferencia ? { importe: diferencia } : null,
        ops,
        faltan_contar: [],
    };
}
