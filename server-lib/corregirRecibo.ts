/**
 * POST /api/recibos/:id/corregir { cambios, accion: 'plan' | 'corregir' } — «Corregir en IM» un recibo que la app ya
 * emitió (Mati, 06/10/2026, caso MONTENORT: cambiar el medio sólo en la app dejaba IM con la cuenta vieja).
 *
 *  · 'plan': controla contra IM y dice qué va a pasar. No toca nada.
 *  · 'corregir': si sólo cambia la cuenta, edita el recibo en IM5 (mismo número), relee IM para confirmar y recién ahí
 *    cambia la app. Monto, cliente o fecha (anular y reemitir) vienen en la próxima tanda: por ahora, a mano en IM.
 *
 * Sólo admin o gerente. Cada corrección queda en `recibos_correcciones` (migración 060) ANTES de tocar IM: sin
 * registro no hay corrección. Qué se hace y qué no vive en `im5Recibos.ts` (puro, con tests).
 */
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import type { JwtPayload } from './auth.js';
import { puedeCorregirRecibosEnIM } from './permisos.js';
import { im5, im5Configurado, ErrorIM5 } from './im5Web.js';
import { resolveCuentaCod, listCuentasEfectivo } from './cuentasResolver.js';
import { isValidMedio } from './mediosPago.js';
import { cuerpoEdicionRecibo, planCorreccion, type CambiosRecibo, type DetalleReciboIM5 } from './im5Recibos.js';

const SIN_MIGRACION = new Set(['42P01', 'PGRST205']);
/** Un recibo a la vez: dos pestañas corrigiendo el mismo recibo chocan acá, no en IM. */
const corrigiendo = new Set<string>();
const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
    if (!user || !puedeCorregirRecibosEnIM(String(user.rol))) { res.status(403).json({ error: 'Corregir un recibo en InfoManager es sólo de admin o gerente.' }); return; }
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
        if (accion === 'plan') { res.json({ ok: true, plan, recibo_im: numeroIM ?? (im ? String(im.cabecera.numero) : null) }); return; }

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
        if (plan.tipo === 'anular_reemitir') {
            res.status(501).json({ error: 'Cambiar el monto, el cliente o la fecha todavía se corrige a mano en IM (anular el recibo y cargarlo de nuevo). Viene en la próxima tanda.' });
            return;
        }

        // ── Cambio de cuenta: mismo número, otra cuenta ──────────────────────────────────────────────────────────
        const cab = im!.cabecera;
        const antes = { cuenta: plan.desde, medio_pago: comp.medio_pago ?? null, numero: String(cab.numero), total: Number(cab.total) };
        // 1) Registro primero: sin registro no se toca IM.
        const ins = await sb().from('recibos_correcciones').insert({
            tenant_id: TENANT_ID, comprobante_id: comp.id, im_recibo_id: idIM, tipo: 'cuenta', antes, estado: 'en_curso', por: user.sub,
        }).select().single();
        if (ins.error) {
            if (SIN_MIGRACION.has(String(ins.error.code ?? ''))) { res.status(503).json({ error: 'Falta aplicar la migración 060 (registro de correcciones): no se tocó IM.' }); return; }
            throw new Error(`No pude registrar la corrección: ${ins.error.message}`);
        }
        const registro = ins.data as { id: string };
        const cerrar = (cambio: Record<string, unknown>) => sb().from('recibos_correcciones').update({ ...cambio, terminada_at: new Date().toISOString() }).eq('id', registro.id);

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
