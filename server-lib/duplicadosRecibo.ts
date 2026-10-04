/**
 * ¿Este pago ya figura? Lógica PURA (sin Supabase ni IM) para avisar antes de cargar o de aprobar.
 *
 * S32 (04/10/2026). En septiembre se rechazaron 63 de 534 recibos: 44 porque el pago ya estaba
 * imputado por otro lado y 8 porque se subieron dos veces. Calibrado contra esos rechazos:
 * ventana de −3 a +10 días y tolerancia de máx($1; 0,5%) detecta 33 de los 44, con aviso de más en
 * el 8% de los recibos buenos. Por eso es un AVISO y decide una persona: nunca un bloqueo.
 */

export interface ReciboAppLite {
    id: string;
    cod_cliente: number;
    monto: number;
    fecha_comprobante: string | null;
    created_at: string;
    status: string;
    infomanager_recibo_id: string | null;
    created_by_rol?: string | null;
    created_by_nombre?: string | null;
}

export interface ReciboIMLite {
    id_recibo: number | string;
    numero?: string;
    fecha: string;
    cliente: { codigo: string | number };
    importe_total: number;
    items?: Array<{ tipo_pago?: string; importe?: number; cuenta_contable?: string | number | null }>;
}

export interface Candidato {
    cod_cliente: number;
    monto: number;
    /** yyyy-MM-dd: la fecha del comprobante. */
    fecha: string;
    /** Para no avisarse a sí mismo cuando se revisa un recibo ya cargado. */
    id?: string;
    infomanager_recibo_id?: string | null;
}

export interface CoincidenciaApp { id: string; fecha: string; monto: number; status: string; dias: number; quien: string | null; nombre: string | null; recibo_im: string | null }
export interface CoincidenciaIM { id_recibo: string; numero: string | null; fecha: string; importe: number; dias: number; cuentas: string[] }

/** En días, relativo a la fecha del comprobante: el recibo de IM suele quedar unos días después. */
export const VENTANA_IM = { antes: 3, despues: 10 } as const;
/** Dos cargas del mismo pago en la app quedan cerca: una semana para cada lado. */
export const VENTANA_APP = 7;
export const TOLERANCIA = { abs: 1, pct: 0.005 } as const;

const dia = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
const diasEntre = (desde: string, hasta: string) => Math.round((dia(hasta) - dia(desde)) / 86_400_000);
const fechaDe = (r: ReciboAppLite) => (r.fecha_comprobante || r.created_at || '').slice(0, 10);

export function posiblesDuplicados(c: Candidato, enApp: ReciboAppLite[], enIM: ReciboIMLite[]): { app: CoincidenciaApp[]; im: CoincidenciaIM[] } {
    const monto = Number(c.monto) || 0;
    if (!(monto > 0) || !c.cod_cliente || !/^\d{4}-\d{2}-\d{2}/.test(c.fecha ?? '')) return { app: [], im: [] };
    const tolerancia = Math.max(TOLERANCIA.abs, monto * TOLERANCIA.pct);
    const parecido = (x: number) => Math.abs((Number(x) || 0) - monto) <= tolerancia;

    const app: CoincidenciaApp[] = enApp
        .filter(r => r.id !== c.id && Number(r.cod_cliente) === Number(c.cod_cliente) && r.status !== 'rechazado')
        .filter(r => parecido(r.monto) && fechaDe(r) && Math.abs(diasEntre(c.fecha, fechaDe(r))) <= VENTANA_APP)
        .map(r => ({
            id: r.id, fecha: fechaDe(r), monto: Number(r.monto), status: r.status, dias: diasEntre(c.fecha, fechaDe(r)),
            quien: r.created_by_rol ?? null, nombre: r.created_by_nombre ?? null, recibo_im: r.infomanager_recibo_id ?? null,
        }));

    // El recibo de IM de un gemelo de la app ya se muestra en la app: no se repite.
    const yaMostrados = new Set([c.infomanager_recibo_id, ...app.map(a => a.recibo_im)].filter(Boolean).map(String));
    const im: CoincidenciaIM[] = enIM
        .filter(x => String(x.cliente?.codigo) === String(c.cod_cliente) && !yaMostrados.has(String(x.id_recibo)))
        .map(x => ({ x, dias: diasEntre(c.fecha, String(x.fecha).slice(0, 10)) }))
        .filter(({ x, dias }) => parecido(x.importe_total) && dias >= -VENTANA_IM.antes && dias <= VENTANA_IM.despues)
        .map(({ x, dias }) => ({
            id_recibo: String(x.id_recibo), numero: x.numero ?? null, fecha: String(x.fecha).slice(0, 10),
            importe: Number(x.importe_total), dias,
            cuentas: [...new Set((x.items ?? []).filter(i => i.tipo_pago !== 'AJUSTE_REDONDEO').map(i => String(i.cuenta_contable ?? '')).filter(Boolean))],
        }));

    const cercania = (d: number, importe: number) => Math.abs(d) * 1e6 + Math.abs(importe - monto);
    app.sort((a, b) => cercania(a.dias, a.monto) - cercania(b.dias, b.monto));
    im.sort((a, b) => cercania(a.dias, a.importe) - cercania(b.dias, b.importe));
    return { app, im };
}
