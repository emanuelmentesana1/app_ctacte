/**
 * Corregir en IM un recibo que la app ya emitió (Mati, 06/10/2026). Lógica PURA, sin IM ni Supabase.
 *
 * El caso que lo originó: MONTENORT. Mati cambió el medio de pago de dos recibos en la app creyendo que así se corregía
 * IM, y en IM siguieron en MercadoPago. La API oficial de IM no edita ni anula recibos; la web de IM5 sí (su manual:
 * "un recibo se edita: se pueden cambiar los comprobantes imputados, los medios de pago, las retenciones y las
 * observaciones"). Diseño de Mati:
 *  · si sólo cambia la CUENTA, se edita el recibo en IM5 y conserva el número;
 *  · si cambia el monto, el cliente o la fecha, se anula y se reemite;
 *  · siempre con confirmación, controlando antes contra IM y dejando registro. Quién: admin, gerente y administrativo
 *    (Anto se sumó el mismo 06/10, pedido de Mati).
 *
 * 🔑 El cuerpo del PUT se arma IGUAL que la pantalla de IM5 (copiado de su código, v1.0.436, y comparado campo por campo
 * con un PUT real capturado sin enviar). Probado el 06/10 en el RC 30156402: editar no cambia el número, el usuario, la
 * cuenta, el importe ni el saldo de la factura. IM5 sí pone la unidad de negocio "UN General" (lo mismo que en los
 * recibos cargados a mano) y rehace las filas internas del pago y de la imputación.
 */

/** El detalle de un recibo como lo devuelve GET /IM5/api/comprobantes/{id}. Sólo lo que se usa. */
export interface DetalleReciboIM5 {
    cabecera: Record<string, unknown> & {
        tipo_comprobante?: string | null; numero?: string | number | null; anulada?: string | null; total?: string | number | null;
        cod_cliente?: string | number | null; fecha?: string | null; tiene_derivado?: number | string | null; tiene_posterior?: number | string | null;
    };
    rc_comprobantes?: Array<Record<string, unknown>>;
    rc_pagos?: Array<Record<string, unknown>>;
    rc_retenciones?: Array<Record<string, unknown>>;
    rc_ncnd?: unknown[];
}

const fecha = (v: unknown) => (v ? String(v).slice(0, 10) : null);
const o = (v: unknown) => v ?? null;

/**
 * El cuerpo de PUT /IM5/api/comprobantes/recibo/{id}, armado como lo arma la pantalla de IM5 al apretar Grabar.
 * `codCuenta` cambia la cuenta del (único) pago; el resto viaja como está en IM.
 */
export function cuerpoEdicionRecibo(d: DetalleReciboIM5, cambios: { codCuenta?: string } = {}) {
    const r = d.cabecera;
    const tipo = String(r.tipo_comprobante ?? 'RC');
    return {
        cabecera: {
            tipo_comprobante: tipo,
            tipo_recibo: (r.tipo_recibo as string) || 'L',
            tipo_factura: 'X',
            cod_cliente: r.cod_cliente,
            cod_vendedor: r.cod_vendedor || null,
            cod_corredor: r.cod_corredor || null,
            tag: r.tag,
            fecha: fecha(r.fecha),
            punto_de_venta: Number(r.punto_de_venta) || 0,
            moneda: r.moneda,
            cotizacion: Number(r.cotizacion) || 1,
            moneda_2: r.moneda_2 || r.moneda,
            cotizacion_2: Number(r.cotizacion_2) || 1,
            cod_cuenta: r.cod_cuenta || null,
            cod_unidad_negocio_cab: r.cod_unidad_negocio_cab || null,
            cod_periodo: r.cod_periodo || null,
            observaciones: (r.observaciones as string) || '',
        },
        comprobantes: (d.rc_comprobantes ?? []).filter(e => Number(e.importe_pagado) !== 0).map(e => ({
            id_comprob_pagado: e.id_comprob_pagado,
            tipo_comprobante: e.tipo ?? e.tipo_comprobante,
            importe_pagado: Number(e.importe_pagado),
            detalle: (e.detalle as string) || '',
            punto_de_venta: Number(e.punto_de_venta) || 0,
            circuito: String(e.circuito || 'V') === 'C' ? 'C' : 'V',
            id_asiento: o(e.id_asiento),
        })),
        pagos: (d.rc_pagos ?? []).filter(e => Number(e.importe) !== 0).map(e => {
            const ch = e.cond_pago === 'CH', tj = e.cond_pago === 'TJ';
            return {
                cond_pago: e.cond_pago,
                importe: Number(e.importe),
                cod_cuenta: cambios.codCuenta ?? o(e.cod_cuenta),
                cod_unidad_negocio: o(e.cod_unidad_negocio),
                cheque_banco: (ch && e.cheque_banco) || null,
                cheque_numero: (ch && e.cheque_numero) || null,
                cod_banco: ch ? o(e.cod_banco) : null,
                tipo_cheque: (ch && e.tipo_cheque) || null,
                cheque_id: (ch && Number(e.cheque_id)) || 1,
                cheque_fec_emision: (ch && e.cheque_fec_emision) || null,
                cheque_fec_pago: (ch && e.cheque_fec_pago) || null,
                cod_tarjeta: tj ? o(e.cod_tarjeta) : null,
                cod_tarjeta_plan: tj ? o(e.cod_tarjeta_plan) : null,
                tarjeta_numero: (tj && e.tarjeta_numero) || null,
                tarjeta_num_cupon: (tj && e.tarjeta_num_cupon) || null,
                tarjeta_lote_numero: (tj && e.tarjeta_lote_numero) || null,
                tarjeta_cod_autorizacion: (tj && e.tarjeta_cod_autorizacion) || null,
                id_pago_externo: e.id_pago_externo || null,
                estado_de_pago: e.estado_de_pago || null,
                ID_sistema_externo_accion: e.id_sistema_externo_accion || e.ID_sistema_externo_accion || null,
                importe_cf: Number(e.importe_cf) || 0,
                porcentaje_cf: Number(e.porcentaje_cf) || 0,
                importe_arancel: Number(e.importe_arancel) || 0,
                importe_cf_impuesto: Number(e.importe_cf_impuesto) || 0,
                mp_data: e.mp_data || null,
                pw_data: e.pw_data || null,
                clover_data: e.clover_data || null,
                // La pantalla marca así los pagos que ya estaban grabados.
                _persistido: true,
            };
        }),
        retenciones: (d.rc_retenciones ?? []).filter(e => Number(e.importe) !== 0).map(e => ({
            retencion: (e.retencion as string) || '',
            cod_impuesto: o(e.cod_impuesto),
            numero_retencion: (e.numero_retencion as string) || '',
            cod_cuenta: o(e.cod_cuenta),
            importe: Number(e.importe) || 0,
        })),
        confirmar_reingreso_cheque: false,
    };
}

/** El recibo como lo tiene la app (comprobantes_pago), con el número de IM que guardó al emitirlo. */
export interface ReciboEnLaApp {
    status: string;
    cod_cliente: number;
    monto: number;
    fecha_comprobante: string | null;
    medio_pago: string | null;
    infomanager_recibo_id: string | null;
    numero_im?: string | null;
}
export interface CambiosRecibo { cod_cliente?: number; monto?: number; fecha_comprobante?: string; medio_pago?: string }
export type PlanCorreccion =
    | { tipo: 'solo_app' }
    | { tipo: 'cuenta'; desde: string; hacia: string }
    | { tipo: 'anular_reemitir'; motivos: string[] }
    | { tipo: 'no_se_puede'; motivo: string };

const $ = (n: number) => `$${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const verdad = (v: unknown) => v === true || Number(v) === 1;

/**
 * Qué hace falta en IM para que el recibo quede como se pide. `cuentaNueva` es la cuenta que corresponde al medio (o a la
 * caja) pedido, resuelta afuera; null si no cambia. Nada se toca si IM no coincide con lo que la app cree que emitió.
 */
export function planCorreccion(app: ReciboEnLaApp, cambios: CambiosRecibo, im: DetalleReciboIM5 | null, cuentaNueva: string | null): PlanCorreccion {
    if (app.status !== 'imputado' || !app.infomanager_recibo_id) return { tipo: 'solo_app' };

    const motivos: string[] = [];
    if (cambios.cod_cliente != null && Number(cambios.cod_cliente) !== Number(app.cod_cliente)) motivos.push(`cambia el cliente (${app.cod_cliente} → ${cambios.cod_cliente})`);
    if (cambios.monto != null && Math.abs(Number(cambios.monto) - Number(app.monto)) >= 0.01) motivos.push(`cambia el monto (${$(Number(app.monto))} → ${$(Number(cambios.monto))})`);
    if (cambios.fecha_comprobante && cambios.fecha_comprobante !== app.fecha_comprobante) motivos.push(`cambia la fecha (${app.fecha_comprobante ?? '—'} → ${cambios.fecha_comprobante})`);
    const pagos = (im?.rc_pagos ?? []).filter(p => Number(p.importe) !== 0);
    const cuentaActual = pagos.length === 1 ? String(pagos[0].cod_cuenta ?? '') : null;
    const cambiaCuenta = cuentaNueva != null && cuentaNueva !== cuentaActual;
    if (!motivos.length && !cambiaCuenta) return { tipo: 'solo_app' };

    // 🔴 Antes de tocar IM: que el recibo de IM sea el que la app cree que emitió.
    if (!im) return { tipo: 'no_se_puede', motivo: 'No pude leer el recibo en IM: probá en unos minutos. No se cambió nada.' };
    const c = im.cabecera;
    if (String(c.anulada ?? 'N') !== 'N') return { tipo: 'no_se_puede', motivo: 'En IM el recibo ya está anulado: no se corrige desde acá.' };
    if (app.numero_im && String(c.numero) !== String(app.numero_im)) return { tipo: 'no_se_puede', motivo: `En IM ese recibo tiene otro número (${c.numero}, la app tiene ${app.numero_im}): revisalo antes de corregir.` };
    // IM imputa pesos enteros: hasta $1 de diferencia es el truncado de siempre.
    if (Math.abs(Number(c.total) - Number(app.monto)) > 1) return { tipo: 'no_se_puede', motivo: `En IM el recibo es por ${$(Number(c.total))} y en la app por ${$(Number(app.monto))}: revisalo antes de corregir.` };
    if (Number(c.cod_cliente) !== Number(app.cod_cliente)) return { tipo: 'no_se_puede', motivo: `En IM el recibo es de otro cliente (${c.cod_cliente}): revisalo antes de corregir.` };
    if (verdad(c.tiene_derivado) || verdad(c.tiene_posterior) || (im.rc_ncnd ?? []).length) {
        return { tipo: 'no_se_puede', motivo: 'En IM el recibo tiene un comprobante posterior relacionado: corregilo a mano en IM.' };
    }

    if (motivos.length) return { tipo: 'anular_reemitir', motivos };

    if (pagos.length !== 1) return { tipo: 'no_se_puede', motivo: 'El recibo tiene más de un medio de pago en IM: corregilo a mano.' };
    if (pagos[0].cond_pago === 'CH' || pagos[0].cond_pago === 'TJ') return { tipo: 'no_se_puede', motivo: 'Es un cheque o una tarjeta: corregilo a mano en IM.' };
    return { tipo: 'cuenta', desde: String(cuentaActual), hacia: String(cuentaNueva) };
}
