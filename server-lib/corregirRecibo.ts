/**
 * POST /api/recibos/:id/corregir { cambios, accion: 'plan' | 'corregir' } — «Corregir en IM» un recibo que la app ya
 * emitió (Mati, 06/10/2026, caso MONTENORT: cambiar el medio sólo en la app dejaba IM con la cuenta vieja).
 *
 *  · 'plan': controla contra IM y dice qué va a pasar. No toca nada.
 *  · 'corregir': si sólo cambia la cuenta, edita el recibo en IM5 (mismo número), relee IM para confirmar y recién ahí
 *    cambia la app. Si cambia el monto, el cliente o la fecha: lo anula en IM5 (y lo confirma releyendo) y emite uno
 *    nuevo por la API oficial, con el MISMO usuario de IM del anulado (así no cambia la caja) y primero a las mismas
 *    facturas. Si después de anular el nuevo no sale, la app lo deja en error con los datos nuevos, para reprocesar.
 *
 * Admin, gerente o administrativo (Anto). Cada corrección queda en `recibos_correcciones` (migración 060) ANTES de tocar IM: sin
 * registro no hay corrección. Qué se hace y qué no vive en `im5Recibos.ts` (puro, con tests).
 */
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import type { JwtPayload } from './auth.js';
import { puedeCorregirRecibosEnIM } from './permisos.js';
import { im5, im5Configurado, ErrorIM5 } from './im5Web.js';
import { resolveCuentaCod, listCuentasEfectivo } from './cuentasResolver.js';
import { isValidMedio, getFormaPagoIM } from './mediosPago.js';
import { fetchComprobPendientes, crearRecibo } from './infomanager.js';
import { ajustarImputacionIM } from './recibosImputacion.js';
import {
    cuerpoEdicionRecibo, planCorreccion, imputacionReemision, pendientesTrasAnular,
    type CambiosRecibo, type DetalleReciboIM5, type FacturaDeuda,
} from './im5Recibos.js';

const SIN_MIGRACION = new Set(['42P01', 'PGRST205']);
/** Un recibo a la vez: dos pestañas corrigiendo el mismo recibo chocan acá, no en IM. */
const corrigiendo = new Set<string>();
const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Comp = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- la fila de comprobantes_pago
interface Reemision {
    nuevo: { cod_cliente: number; monto: number; fecha: string; cuenta: string; medio: string; facturas: Array<{ id: string; importe: number }> };
    originales: Array<{ id: string; importe: number }>;
    mismoCliente: boolean;
    empresa: number;
}

async function deudaDe(empresa: number, codCliente: number): Promise<FacturaDeuda[]> {
    const p = await fetchComprobPendientes(empresa, codCliente);
    return p.map((x: { id: unknown; saldo?: unknown; importe_factura?: unknown; fecha_factura?: unknown }) => ({
        id: String(x.id), saldo: Math.abs(Number(x.saldo ?? x.importe_factura ?? 0)), fecha: x.fecha_factura ? String(x.fecha_factura).slice(0, 10) : null,
    }));
}

/** El recibo nuevo de una corrección: con qué datos y a qué facturas. La deuda la da IM (antes o después de anular). */
async function armarReemision(comp: Comp, cambios: CambiosRecibo, im: DetalleReciboIM5, cuentaNueva: string | null, despuesDeAnular: boolean): Promise<Reemision | { error: string }> {
    const pagos = (im.rc_pagos ?? []).filter(p => Number(p.importe) !== 0);
    if (pagos.length !== 1) return { error: 'El recibo tiene más de un medio de pago en IM: corregilo a mano.' };
    const empresa = Number(comp.cod_empresa) || 1;
    const codCliente = cambios.cod_cliente ?? Number(comp.cod_cliente);
    const mismoCliente = codCliente === Number(comp.cod_cliente);
    const originales = (im.rc_comprobantes ?? []).filter(c => Number(c.importe_pagado) !== 0).map(c => ({ id: String(c.id_comprob_pagado), importe: Number(c.importe_pagado) }));
    let deuda: FacturaDeuda[];
    try { deuda = await deudaDe(empresa, codCliente); } catch (e) { return { error: `IM no devolvió la deuda del cliente (${mensaje(e)}): probá en unos minutos.` }; }
    if (mismoCliente && !despuesDeAnular) deuda = pendientesTrasAnular(deuda, originales);
    const monto = cambios.monto ?? Number(comp.monto);
    const facturas = imputacionReemision(monto, mismoCliente ? originales.map(o => o.id) : [], deuda);
    if ('error' in facturas) return facturas;
    return {
        nuevo: {
            cod_cliente: codCliente, monto, fecha: cambios.fecha_comprobante ?? String(im.cabecera.fecha ?? comp.fecha_comprobante).slice(0, 10),
            cuenta: cuentaNueva ?? String(pagos[0].cod_cuenta), medio: cambios.medio_pago ?? comp.medio_pago ?? '', facturas,
        },
        originales, mismoCliente, empresa,
    };
}

/** Registro primero: sin registro no se toca IM. 'sin_migracion' si falta la 060. */
async function abrirRegistro(comp: Comp, idIM: string, tipo: 'cuenta' | 'anular_reemitir', antes: object, por: string): Promise<{ id: string } | 'sin_migracion'> {
    const ins = await sb().from('recibos_correcciones').insert({ tenant_id: TENANT_ID, comprobante_id: comp.id, im_recibo_id: idIM, tipo, antes, estado: 'en_curso', por }).select().single();
    if (ins.error) {
        if (SIN_MIGRACION.has(String(ins.error.code ?? ''))) return 'sin_migracion';
        throw new Error(`No pude registrar la corrección: ${ins.error.message}`);
    }
    return ins.data as { id: string };
}
const cerrarRegistro = (id: string, cambio: Record<string, unknown>) => sb().from('recibos_correcciones').update({ ...cambio, terminada_at: new Date().toISOString() }).eq('id', id);

/**
 * Anular y reemitir. 🔴 El orden importa: registro → anular (y confirmar releyendo) → deuda real después de anular →
 * emitir. Si el nuevo no sale, el anulado no se puede "desanular": la app deja el recibo en error con los datos nuevos,
 * así se reprocesa desde Cobranzas como cualquier recibo con error, y el registro lo marca.
 */
async function anularYReemitir(res: Response, user: JwtPayload, comp: Comp, cambios: CambiosRecibo, im: DetalleReciboIM5, cuentaNueva: string | null, motivos: string[]) {
    const idIM = String(comp.infomanager_recibo_id);
    const numero = String(im.cabecera.numero);
    if (comp.hoja_id) { res.status(409).json({ error: 'Es un recibo de la rendición de una hoja: corregilo a mano en IM y avisá a Rendiciones.' }); return; }
    const vista = await armarReemision(comp, cambios, im, cuentaNueva, false);
    if ('error' in vista) { res.status(409).json({ error: `${vista.error} No se tocó IM.` }); return; }
    const antes = {
        numero, id: idIM, cod_cliente: Number(comp.cod_cliente), monto: Number(comp.monto), fecha: String(im.cabecera.fecha ?? '').slice(0, 10),
        cuenta: String((im.rc_pagos ?? [])[0]?.cod_cuenta ?? ''), medio_pago: comp.medio_pago ?? null, facturas: vista.originales,
    };
    const registro = await abrirRegistro(comp, idIM, 'anular_reemitir', antes, user.sub);
    if (registro === 'sin_migracion') { res.status(503).json({ error: 'Falta aplicar la migración 060 (registro de correcciones): no se tocó IM.' }); return; }

    // 1) Anular en IM5, y confirmarlo releyendo (sin respuesta, decide la relectura).
    try { await im5.anular(idIM); } catch (e) {
        if (!(e instanceof ErrorIM5 && e.sinRespuesta)) {
            await cerrarRegistro(registro.id, { estado: 'error', error: `No se anuló: ${mensaje(e)}` });
            res.status(502).json({ error: `IM5 no anuló el recibo ${numero} (${mensaje(e)}). No se cambió nada.` });
            return;
        }
    }
    let releido: DetalleReciboIM5 | null = null;
    try { releido = await im5.comprobante(idIM); } catch (e) { console.warn(`[corregir] no pude releer ${idIM}: ${mensaje(e)}`); }
    if (String(releido?.cabecera.anulada ?? '') !== 'S') {
        const motivo = releido ? 'en IM el recibo sigue sin anular' : 'no pude releer el recibo en IM: revisá si quedó anulado';
        await cerrarRegistro(registro.id, { estado: 'error', error: motivo });
        res.status(502).json({ error: `IM no confirmó la anulación del recibo ${numero} (${motivo}). La app no se cambió.` });
        return;
    }

    // 2) Ya está anulado: el nuevo, con la deuda real de IM.
    const fallar = async (motivo: string, sinSaber = false) => {
        const texto = sinSaber
            ? `Se anuló en IM el RC ${numero} para corregirlo y al emitir el nuevo IM no respondió: NO se sabe si se creó. Mirá la cta cte del cliente en IM antes de reprocesarlo.`
            : `Se anuló en IM el RC ${numero} para corregirlo y NO se pudo emitir el nuevo (${motivo}). Usá «Reabrir para reprocesar» y aprobalo, o cargalo a mano en IM.`;
        await sb().from('comprobantes_pago').update({
            cod_cliente: vista.nuevo.cod_cliente, monto: vista.nuevo.monto, fecha_comprobante: vista.nuevo.fecha, medio_pago: vista.nuevo.medio || comp.medio_pago,
            status: 'error', infomanager_recibo_id: null, error_msg: texto,
            infomanager_response: { anulado: { id: idIM, numero, por_correccion: true }, anterior: comp.infomanager_response ?? null },
        }).eq('id', comp.id);
        await cerrarRegistro(registro.id, { estado: 'error', error: `ANULADO SIN REEMPLAZO: ${motivo}` });
        console.error(`[corregir] ${user.sub}: anulado ${numero} (${idIM}) SIN reemplazo: ${motivo}`);
        res.status(502).json({ error: texto });
    };
    // 🪤 Las facturas que pagaba salen del detalle de ANTES de anular: el anulado puede venir sin ellas. La deuda, de IM ahora.
    const real = await armarReemision(comp, cambios, im, cuentaNueva, true);
    if ('error' in real) { await fallar(real.error); return; }
    const comprobantes = real.nuevo.facturas.map(f => ({ id: f.id, importe_a_pagar: f.importe.toFixed(2) }));
    const ajuste = ajustarImputacionIM(real.nuevo.monto, comprobantes.map(c => Number(c.importe_a_pagar)));
    if (!ajuste.ok) { await fallar(ajuste.error); return; }
    comprobantes.forEach((c, i) => { c.importe_a_pagar = ajuste.comprobantesEnteros[i].toFixed(2); });
    const usuario = String(im.cabecera.usuario || process.env.INFOMANAGER_USUARIO || '');
    const detalle = `${String(im.cabecera.observaciones ?? '').trim()} · Reemplaza al RC ${numero} (${motivos.join('; ')})`.replace(/^ · /, '').slice(0, 250);
    const r = await crearRecibo({
        cod_empresa: String(real.empresa), fecha: real.nuevo.fecha, centro_costo: im.cabecera.tag === 'N' ? 'N' : 'S', cod_cliente: String(real.nuevo.cod_cliente),
        usuario, detalle, moneda: 'P', cotizacion: '1.0',
        pagos: [{ forma_pago: getFormaPagoIM(real.nuevo.medio), importe: ajuste.pagoTotal.toFixed(2), cod_cuenta: real.nuevo.cuenta, cod_unidad_negocio: '', tarjeta_numero: '', tarjeta_numero_cupon: '' }],
        comprobantes,
    });
    if (!r.ok) { await fallar(r.error, r.sinRespuesta === true); return; }

    // 3) La app, con el recibo nuevo.
    const numeroNuevo = r.raw?.recibo?.numero != null ? String(r.raw.recibo.numero) : null;
    const { error: errApp } = await sb().from('comprobantes_pago').update({
        cod_cliente: real.nuevo.cod_cliente, monto: real.nuevo.monto, fecha_comprobante: real.nuevo.fecha, medio_pago: real.nuevo.medio || comp.medio_pago,
        status: 'imputado', error_msg: null, infomanager_recibo_id: r.id ?? null, imputado_at: new Date().toISOString(),
        infomanager_response: { ...(r.raw ?? {}), reemplaza: { id: idIM, numero } },
        factura_asociada: comprobantes.map(c => `#${c.id}·$${c.importe_a_pagar}`).join(','),
    }).eq('id', comp.id);
    const despues = { numero: numeroNuevo, id: r.id ?? null, cod_cliente: real.nuevo.cod_cliente, monto: real.nuevo.monto, fecha: real.nuevo.fecha, cuenta: real.nuevo.cuenta, facturas: comprobantes };
    if (errApp) {
        await cerrarRegistro(registro.id, { estado: 'error', despues, error: `IM quedó bien pero la app no se actualizó: ${errApp.message}` });
        res.status(500).json({ error: `En IM se anuló el RC ${numero} y se emitió el ${numeroNuevo ?? '?'}, pero la app no se actualizó (${errApp.message}). No lo corrijas de nuevo: avisá.` });
        return;
    }
    await cerrarRegistro(registro.id, { estado: 'hecha', despues });
    console.log(`[corregir] ${user.sub} anuló el RC ${numero} (${idIM}) y emitió el ${numeroNuevo} (${r.id}): ${motivos.join('; ')}`);
    res.json({ ok: true, plan: { tipo: 'anular_reemitir', motivos }, recibo_im: numero, nuevo: { numero: numeroNuevo, id: r.id ?? null } });
}

function leerCambios(cuerpo: unknown): (CambiosRecibo & { cod_cuenta?: string }) | string {
    const x = (cuerpo ?? {}) as Record<string, unknown>;
    const c: CambiosRecibo & { cod_cuenta?: string } = {};
    if (x.cod_cliente !== undefined) { const n = Number(x.cod_cliente); if (!Number.isInteger(n) || n <= 0) return 'Cliente inválido.'; c.cod_cliente = n; }
    if (x.monto !== undefined) { const n = Number(x.monto); if (!(n > 0)) return 'El monto tiene que ser mayor a 0.'; c.monto = n; }
    if (x.fecha_comprobante !== undefined) {
        const f = String(x.fecha_comprobante ?? '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return 'La fecha tiene que ser AAAA-MM-DD.';
        c.fecha_comprobante = f;
    }
    if (x.medio_pago !== undefined) { const mp = String(x.medio_pago ?? ''); if (!isValidMedio(mp)) return `Medio de pago inválido: ${mp}.`; c.medio_pago = mp; }
    if (x.cod_cuenta !== undefined) { const cc = String(x.cod_cuenta ?? ''); if (!/^\d{1,10}$/.test(cc)) return 'Caja inválida.'; c.cod_cuenta = cc; }
    return c;
}

export async function corregirRecibo(req: Request & { user?: JwtPayload }, res: Response) {
    const user = req.user;
    if (!user || !puedeCorregirRecibosEnIM(String(user.rol))) { res.status(403).json({ error: 'Corregir un recibo en InfoManager es de administración (admin, gerente o administrativo).' }); return; }
    const accion = req.body?.accion;
    if (accion !== 'plan' && accion !== 'corregir') { res.status(400).json({ error: 'accion tiene que ser "plan" o "corregir".' }); return; }
    const cambios = leerCambios(req.body?.cambios);
    if (typeof cambios === 'string') { res.status(400).json({ error: cambios }); return; }
    const id = String(req.params.id);
    if (accion === 'corregir') {
        if (corrigiendo.has(id)) { res.status(409).json({ error: 'Este recibo ya se está corrigiendo: esperá unos segundos y recargá.' }); return; }
        corrigiendo.add(id);
    }
    try {
        const { data: comp, error } = await sb().from('comprobantes_pago').select('*').eq('tenant_id', TENANT_ID).eq('id', id).maybeSingle();
        if (error) throw new Error(`No pude leer el recibo: ${error.message}`);
        if (!comp) { res.status(404).json({ error: 'Recibo no encontrado.' }); return; }

        // La cuenta que corresponde a lo pedido: la del medio de pago, o la caja elegida si es efectivo.
        const medio: string = cambios.medio_pago ?? comp.medio_pago ?? '';
        let cuentaNueva: string | null = null;
        if (cambios.medio_pago !== undefined || cambios.cod_cuenta !== undefined) {
            if (medio === 'efectivo') {
                if (cambios.cod_cuenta) {
                    const cajas = (await listCuentasEfectivo()).map(c => String(c.cod_cuenta));
                    if (!cajas.includes(cambios.cod_cuenta)) { res.status(400).json({ error: `La caja ${cambios.cod_cuenta} no está habilitada para recibos.` }); return; }
                    cuentaNueva = cambios.cod_cuenta;
                } else cuentaNueva = await resolveCuentaCod('efectivo');
            } else {
                if (cambios.cod_cuenta) { res.status(400).json({ error: 'La caja se elige sólo en efectivo: en los demás medios la cuenta sale del medio de pago.' }); return; }
                cuentaNueva = await resolveCuentaCod(medio);
                if (!cuentaNueva) { res.status(400).json({ error: `No sé a qué cuenta de IM va "${medio}".` }); return; }
            }
        }

        const emitido = comp.status === 'imputado' && !!comp.infomanager_recibo_id;
        if (emitido && !im5Configurado()) {
            res.status(503).json({ error: 'Para corregir en IM faltan IM5_USUARIO e IM5_PASSWORD en el servidor (EasyPanel). No se cambió nada.' });
            return;
        }
        const idIM = String(comp.infomanager_recibo_id ?? '');
        let im: DetalleReciboIM5 | null = null;
        if (emitido) {
            try { im = await im5.comprobante(idIM); } catch (e) { console.warn(`[corregir] no pude leer el recibo ${idIM} en IM5: ${mensaje(e)}`); }
        }
        const numeroApp = comp.infomanager_response?.recibo?.numero;
        const numeroIM = numeroApp != null ? String(numeroApp) : null;
        const plan = planCorreccion({
            status: String(comp.status), cod_cliente: Number(comp.cod_cliente), monto: Number(comp.monto), fecha_comprobante: comp.fecha_comprobante ?? null,
            medio_pago: comp.medio_pago ?? null, infomanager_recibo_id: comp.infomanager_recibo_id ?? null, numero_im: numeroIM,
        }, cambios, im, cuentaNueva);
        if (accion === 'plan') {
            // Para anular y reemitir, la vista previa dice qué recibo nuevo sale (o por qué no se puede).
            if (plan.tipo === 'anular_reemitir') {
                const v = comp.hoja_id ? { error: 'Es un recibo de la rendición de una hoja: corregilo a mano en IM y avisá a Rendiciones.' } : await armarReemision(comp, cambios, im!, cuentaNueva, false);
                const p = 'error' in v ? { tipo: 'no_se_puede' as const, motivo: v.error } : { ...plan, nuevo: v.nuevo };
                res.json({ ok: true, plan: p, recibo_im: numeroIM ?? String(im!.cabecera.numero) });
                return;
            }
            res.json({ ok: true, plan, recibo_im: numeroIM ?? (im ? String(im.cabecera.numero) : null) });
            return;
        }

        if (plan.tipo === 'solo_app') {
            // IM ya tiene esa cuenta y sólo la app tenía mal el medio: se corrige la app (IM y la app quedan iguales).
            if (emitido && im && cambios.medio_pago !== undefined && cambios.medio_pago !== comp.medio_pago) {
                const medioAnterior = comp.medio_pago;
                const { error: e } = await sb().from('comprobantes_pago').update({ medio_pago: cambios.medio_pago }).eq('id', comp.id);
                if (e) throw new Error(`No pude actualizar el recibo: ${e.message}`);
                console.log(`[corregir] ${user.sub}: IM ya tenía la cuenta del recibo ${idIM}; medio de la app ${medioAnterior} → ${cambios.medio_pago}`);
                res.json({ ok: true, plan, recibo_im: numeroIM });
                return;
            }
            res.status(409).json({ error: 'Esto no toca InfoManager: guardalo con «Guardar cambios».' });
            return;
        }
        if (plan.tipo === 'no_se_puede') { res.status(409).json({ error: plan.motivo }); return; }
        if (plan.tipo === 'anular_reemitir') { await anularYReemitir(res, user, comp, cambios, im!, cuentaNueva, plan.motivos); return; }

        // ── Cambio de cuenta: mismo número, otra cuenta ──────────────────────────────────────────────────────────
        const cab = im!.cabecera;
        const antes = { cuenta: plan.desde, medio_pago: comp.medio_pago ?? null, numero: String(cab.numero), total: Number(cab.total) };
        // 1) Registro primero: sin registro no se toca IM.
        const registro = await abrirRegistro(comp, idIM, 'cuenta', antes, user.sub);
        if (registro === 'sin_migracion') { res.status(503).json({ error: 'Falta aplicar la migración 060 (registro de correcciones): no se tocó IM.' }); return; }
        const cerrar = (cambio: Record<string, unknown>) => cerrarRegistro(registro.id, cambio);

        // 2) IM5: el mismo cuerpo que arma la pantalla, con la cuenta nueva.
        try {
            await im5.editarRecibo(idIM, cuerpoEdicionRecibo(im!, { codCuenta: plan.hacia }));
        } catch (e) {
            // Sin respuesta no se sabe si grabó: se decide releyendo. Un rechazo explícito no grabó nada.
            if (!(e instanceof ErrorIM5 && e.sinRespuesta)) {
                await cerrar({ estado: 'error', error: mensaje(e) });
                res.status(502).json({ error: `IM5 no aceptó el cambio (${mensaje(e)}). No se cambió nada.` });
                return;
            }
        }

        // 3) Verificación: releer IM. Sólo si quedó como se pidió, se cambia la app.
        let despues: DetalleReciboIM5 | null = null;
        try { despues = await im5.comprobante(idIM); } catch (e) { console.warn(`[corregir] no pude releer ${idIM}: ${mensaje(e)}`); }
        const pagos = (despues?.rc_pagos ?? []).filter(p => Number(p.importe) !== 0);
        const quedo = !!despues && String(despues.cabecera.anulada ?? 'N') === 'N' && String(despues.cabecera.numero) === antes.numero
            && Math.abs(Number(despues.cabecera.total) - antes.total) < 0.01 && pagos.length === 1 && String(pagos[0].cod_cuenta) === plan.hacia;
        if (!quedo) {
            const motivo = despues ? `en IM el recibo sigue con la cuenta ${pagos.map(p => p.cod_cuenta).join('+') || '—'}` : 'no pude releer el recibo en IM';
            await cerrar({ estado: 'error', error: motivo });
            res.status(502).json({ error: `IM no confirmó el cambio (${motivo}). La app no se cambió: revisá el recibo ${antes.numero} en IM.` });
            return;
        }

        // 4) La app, igual que IM.
        const resp = (comp.infomanager_response ?? {}) as { recibo?: { pagos?: Array<Record<string, unknown>> } };
        const respuesta = resp.recibo ? { ...resp, recibo: { ...resp.recibo, pagos: (resp.recibo.pagos ?? []).map(p => ({ ...p, cod_cuenta: plan.hacia })) } } : resp;
        const { error: errApp } = await sb().from('comprobantes_pago').update({ medio_pago: medio || comp.medio_pago, infomanager_response: respuesta }).eq('id', comp.id);
        if (errApp) {
            await cerrar({ estado: 'error', error: `IM quedó bien pero la app no se actualizó: ${errApp.message}` });
            res.status(500).json({ error: `En IM el recibo ${antes.numero} ya quedó en la cuenta ${plan.hacia}, pero la app no se actualizó (${errApp.message}). No lo corrijas de nuevo: avisá.` });
            return;
        }
        await cerrar({ estado: 'hecha', despues: { cuenta: plan.hacia, medio_pago: medio || comp.medio_pago, numero: antes.numero, total: Number(despues!.cabecera.total) } });
        console.log(`[corregir] ${user.sub} corrigió en IM el recibo ${antes.numero} (${idIM}): cuenta ${plan.desde} → ${plan.hacia}`);
        res.json({ ok: true, plan, recibo_im: antes.numero });
    } catch (e) {
        console.error('[corregir]', mensaje(e));
        res.status(500).json({ error: mensaje(e) });
    } finally {
        if (accion === 'corregir') corrigiendo.delete(id);
    }
}
