/**
 * RENDIR EL EFECTIVO DE LA HOJA EN LA APP — lógica PURA (sin Supabase ni IM). Etapa 2 del diseño
 * aprobado por Mati el 04/10/2026.
 *
 * Hoy Anto tipea en el escritorio de IM unos 19 recibos de efectivo por día, al día siguiente del
 * reparto, desde el papel de la hoja. Acá la oficina carga lo cobrado por cliente, los gastos del
 * viaje y el efectivo contado, y la app emite los recibos con el motor de siempre (`aprobarRecibo`).
 *
 * Decisiones de Mati que viven en este archivo:
 *  2. El efectivo se imputa primero a la deuda más vieja.
 *  3. Lo cuenta Anto y lo controla Maca. La diferencia NO se descuenta en el momento: se acumula en
 *     un saldo mensual por repartidor (a favor o en contra).
 *  4. La app anota los gastos del viaje. La orden de pago en IM sigue a mano: la API no crea OP ni
 *     asientos, así que la app da el texto y el importe para copiar.
 */
import { preseleccionFIFO, type FacturaParaImputar } from '../src/utils/aprobacionRecibos.js';
import { posiblesDuplicados, type ReciboAppLite, type ReciboIMLite } from './duplicadosRecibo.js';
import { CONCEPTOS_GASTO, cuentasDeLaRendicion, resumenParaIM, type Borrador, type ConceptoGasto, type GastoViaje, type LineaEfectivo } from '../src/utils/rendicionCuentas.js';

// Las cuentas viven en src/utils (la pantalla las usa mientras se tipea): se re-exportan para el servidor.
export { CONCEPTOS_GASTO, cuentasDeLaRendicion, resumenParaIM, type Borrador, type ConceptoGasto, type GastoViaje, type LineaEfectivo };

const centavos = (n: number) => Math.round(n * 100) / 100;
const MAX_IMPORTE = 1e9;
const diaUTC = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
const diasEntre = (desde: string, hasta: string) => Math.round((diaUTC(hasta) - diaUTC(desde)) / 86_400_000);

/** Acepta 412300, "412300.5" y vacío. Lo que no es un número queda como NaN para rechazarlo. */
function numero(v: unknown): number | null {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    return Number.isFinite(n) ? n : NaN;
}

/**
 * Lo que manda la pantalla, validado. Sólo clientes de la hoja: el recibo sale con la fecha y la
 * caja de ESTA hoja. El cliente que no pagó no es una línea (no hay recibo que emitir).
 */
export function normalizarBorrador(body: unknown, clientesDeLaHoja: number[]): { ok: true; borrador: Borrador } | { ok: false; error: string } {
    const b = (body ?? {}) as Record<string, unknown>;
    const deLaHoja = new Set(clientesDeLaHoja.map(Number));

    const efectivo: LineaEfectivo[] = [];
    const vistos = new Set<number>();
    for (const l of Array.isArray(b.efectivo) ? b.efectivo : []) {
        const cod = Number((l as Record<string, unknown>)?.cod_cliente);
        const importe = numero((l as Record<string, unknown>)?.importe);
        if (!deLaHoja.has(cod)) return { ok: false, error: `El cliente ${cod} no está en esta hoja.` };
        if (vistos.has(cod)) return { ok: false, error: `El cliente ${cod} está dos veces: sería un recibo doble.` };
        vistos.add(cod);
        if (importe == null || importe === 0) continue;
        if (!(importe > 0) || importe > MAX_IMPORTE) return { ok: false, error: `El efectivo del cliente ${cod} no es un importe válido.` };
        efectivo.push({ cod_cliente: cod, importe: centavos(importe) });
    }

    const gastos: GastoViaje[] = [];
    const listaGastos = Array.isArray(b.gastos) ? b.gastos : [];
    if (listaGastos.length > 30) return { ok: false, error: 'Demasiados gastos para una hoja (máximo 30).' };
    for (const g of listaGastos) {
        const r = (g ?? {}) as Record<string, unknown>;
        const concepto = String(r.concepto ?? '') as ConceptoGasto;
        const importe = numero(r.importe);
        const detalle = typeof r.detalle === 'string' && r.detalle.trim() ? r.detalle.trim().slice(0, 120) : null;
        if (!CONCEPTOS_GASTO.includes(concepto)) return { ok: false, error: `"${concepto}" no es un concepto de gasto. Usá: ${CONCEPTOS_GASTO.join(', ')}.` };
        if (importe == null || !(importe > 0) || importe > MAX_IMPORTE) return { ok: false, error: `El gasto "${concepto}" no tiene un importe válido.` };
        if (concepto === 'Otro' && !detalle) return { ok: false, error: 'En un gasto "Otro" escribí qué fue.' };
        gastos.push({ concepto, importe: centavos(importe), detalle });
    }

    const contado = numero(b.efectivo_contado);
    if (contado != null && (!(contado >= 0) || contado > MAX_IMPORTE)) return { ok: false, error: 'El efectivo contado no es un importe válido.' };
    const observaciones = typeof b.observaciones === 'string' && b.observaciones.trim() ? b.observaciones.trim().slice(0, 500) : null;

    return { ok: true, borrador: { efectivo, gastos, efectivo_contado: contado == null ? null : centavos(contado), observaciones } };
}

/** Un recibo de efectivo que la app ya creó para esta hoja (`comprobantes_pago.hoja_id`). */
export interface ReciboDeLaHoja { id: string; cod_cliente: number; monto: number; status: string; infomanager_recibo_id: string | null; error_msg?: string | null }

export type EstadoEmision = 'emitido' | 'listo' | 'salteado' | 'en_espera';
export interface PasoEmision {
    cod_cliente: number;
    importe: number;
    estado: EstadoEmision;
    motivo?: string;
    /** `etiqueta` y `fecha` son para la vista previa: aprobarRecibo sólo usa id e importe. */
    comprobantes?: Array<{ id: string; importe_a_pagar: number; etiqueta: string; fecha: string | null }>;
    /** El registro de la app que se reusa (un intento anterior que falló). */
    recibo_app_id?: string | null;
    recibo_im?: string | null;
}

/** Hasta $5 lo absorbe el ajuste de IM (trunca a entero), igual que la pantalla de aprobación. */
const TOLERANCIA_FIFO = 5;
/** Anto carga el recibo con la fecha de la hoja; una hoja con la fecha corrida lo corre un día. */
const VENTANA_A_MANO = 1;

export interface EntradaPlan {
    hoja: { numero: number; fecha: string };
    efectivo: LineaEfectivo[];
    existentes: ReciboDeLaHoja[];
    /** Recibos de IM de esos clientes alrededor de la fecha. null = IM no contestó. */
    enIM: ReciboIMLite[] | null;
    /** Otros recibos de la app de esos clientes (no los de esta hoja). */
    enApp: ReciboAppLite[];
    /** Facturas pendientes del cliente en IM. null = IM no las devolvió. */
    pendientesDe: (codCliente: number) => FacturaParaImputar[] | null;
    cuentaCaja: string;
    tope: number;
}

/**
 * Qué recibo emite la app por cada cliente y cuál no, con el motivo. Nada se emite "por las dudas":
 * ante cualquier duda (IM no contestó, ya figura, paga de más) el cliente se saltea y queda a la vista.
 */
export function planDeEmision(e: EntradaPlan): PasoEmision[] {
    const propios = new Set(e.existentes.map(r => r.infomanager_recibo_id).filter(Boolean).map(String));
    let listos = 0;
    return e.efectivo.map(l => {
        const base = { cod_cliente: l.cod_cliente, importe: l.importe };
        const salteado = (motivo: string, extra: Partial<PasoEmision> = {}): PasoEmision => ({ ...base, estado: 'salteado', motivo, ...extra });
        const previo = e.existentes.find(r => Number(r.cod_cliente) === l.cod_cliente);

        if (previo?.status === 'imputado') {
            if (Math.abs(Number(previo.monto) - l.importe) < 0.01) return { ...base, estado: 'emitido', recibo_app_id: previo.id, recibo_im: previo.infomanager_recibo_id };
            return salteado(`Ya se emitió el recibo ${previo.infomanager_recibo_id ?? ''} por $${Number(previo.monto).toFixed(2)}. Si el importe cambió, corregilo en IM: la app no emite otro.`, { recibo_app_id: previo.id, recibo_im: previo.infomanager_recibo_id });
        }
        if (previo && previo.status !== 'error' && previo.status !== 'pendiente_revision') {
            return salteado(`El recibo de la app está "${previo.status}": revisalo en Cobranzas.`, { recibo_app_id: previo.id });
        }
        if (e.enIM == null) return salteado('No pude consultar InfoManager para descartar un recibo repetido: probá en unos minutos.');

        // 🔴 Riesgo 1 del diseño: Anto ya lo cargó a mano en IM (Caja Repartos, fecha de la hoja).
        const aMano = e.enIM.find(r => String(r.cliente?.codigo) === String(l.cod_cliente)
            && !propios.has(String(r.id_recibo))
            && (r.items ?? []).some(i => String(i.cuenta_contable ?? '') === e.cuentaCaja && Number(i.importe) > 0)
            && Math.abs(diasEntre(e.hoja.fecha, String(r.fecha).slice(0, 10))) <= VENTANA_A_MANO);
        if (aMano) return salteado(`Ya está cargado a mano en IM (recibo ${aMano.numero ?? aMano.id_recibo}, $${Number(aMano.importe_total).toFixed(2)}): no se emite de nuevo.`, { recibo_im: String(aMano.id_recibo) });

        const dup = posiblesDuplicados(
            { cod_cliente: l.cod_cliente, monto: l.importe, fecha: e.hoja.fecha, id: previo?.id, infomanager_recibo_id: null },
            e.enApp, e.enIM.filter(r => !propios.has(String(r.id_recibo))),
        );
        if (dup.app.length || dup.im.length) {
            const d = dup.im[0] ? `recibo ${dup.im[0].numero ?? dup.im[0].id_recibo} del ${dup.im[0].fecha}` : `un pago cargado en la app el ${dup.app[0].fecha}`;
            return salteado(`Puede estar repetido: hay ${d} por un importe parecido. Revisalo antes de emitir.`);
        }

        const pendientes = e.pendientesDe(l.cod_cliente);
        if (pendientes == null) return salteado('IM no devolvió las facturas pendientes del cliente: probá en unos minutos.');
        const elegidas = preseleccionFIFO(pendientes, l.importe);
        const imputado = Object.values(elegidas).reduce((s, x) => s + x, 0);
        if (Math.abs(imputado - l.importe) > TOLERANCIA_FIFO) {
            return salteado(`Paga más que toda su deuda pendiente ($${centavos(imputado).toFixed(2)}): el resto es anticipo y la API de IM no lo hace. Cargalo a mano en IM.`);
        }
        if (listos >= e.tope) return { ...base, estado: 'en_espera', motivo: `Tope del piloto: ${e.tope} por tanda.`, recibo_app_id: previo?.id ?? null };
        listos += 1;
        return {
            ...base, estado: 'listo', recibo_app_id: previo?.id ?? null,
            comprobantes: Object.entries(elegidas).map(([id, importe_a_pagar]) => {
                const f = pendientes.find(x => String(x.id) === id);
                // Como la ve Anto en Cobranzas: "FA 3-142847".
                const numero = f?.punto_de_venta != null ? `${f.punto_de_venta}-${f.numero}` : String(f?.numero ?? id);
                return { id, importe_a_pagar, etiqueta: [f?.tipo_comprobante, numero].filter(Boolean).join(' '), fecha: f?.fecha_factura ?? null };
            }),
        };
    });
}

export interface RendicionDelMes { hoja_numero: number; fecha: string; chofer: string | null; diferencia: number | null; controlada: boolean }

/** El saldo del mes por repartidor (decisión 3): suma de las diferencias de las hojas ya contadas. */
export function saldosPorRepartidor(rs: RendicionDelMes[]): Array<{ chofer: string; hojas: number; contadas: number; saldo: number; sin_controlar: number }> {
    const por = new Map<string, { chofer: string; hojas: number; contadas: number; saldo: number; sin_controlar: number }>();
    for (const r of rs) {
        const chofer = r.chofer ?? 'Sin chofer';
        const s = por.get(chofer) ?? { chofer, hojas: 0, contadas: 0, saldo: 0, sin_controlar: 0 };
        s.hojas += 1;
        if (r.diferencia != null) {
            s.contadas += 1;
            s.saldo = centavos(s.saldo + r.diferencia);
            if (!r.controlada) s.sin_controlar += 1;
        }
        por.set(chofer, s);
    }
    return [...por.values()].sort((a, b) => a.chofer.localeCompare(b.chofer, 'es'));
}
