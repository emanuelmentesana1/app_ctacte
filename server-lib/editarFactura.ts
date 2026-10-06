import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { JwtPayload } from './auth.js';
import { sb, TENANT_ID } from './supabase.js';
import {
  anularComprobante, anularConservandoCabecera, cabeceraComprobante, comprobantesPendientesCliente, pagadoDeFactura,
  fetchArticulosCatalogo, fetchClientesIMCon, invalidarIM, leerComprobante,
} from './infomanager.js';
import { emitirFactura, emitirRemito, emitirRemitoMasivo, letraDeFactura, type ResultadoEmision } from './facturarIM.js';
import { articulosSinStockDelError, frenaSiNoPuede } from './facturarPresupuestos.js';
import { exigirTipoEmpresa, ErrorVersion } from './versionPresupuesto.js';
import { usuarioIM } from './pedidos.js';
import { pesoDeRenglones, sinPesoAProposito } from './pesoComprobante.js';
import { invalidarVista } from './vistaPresupuestos.js';
import { invalidarRemitos } from './vistaRemitos.js';
import {
  avanzarEdicion, decidirEdicion, movimientosDeStock, totalRenglones, validarRenglones,
  type DepsEdicion, type Edicion, type RenglonEdicion,
} from './edicionFactura.js';

/**
 * POST /api/facturacion/editar — EDITAR UNA FACTURA EMITIDA (ver edicionFactura.ts).
 *
 * body: `{ im_factura_id, renglones?, motivo?, confirmar? }`
 *
 * · Sin `confirmar`: NO TOCA NADA. Devuelve qué pasaría —factura nueva, qué vuelve al stock y
 *   qué sale— o por qué no se puede. Es el mismo criterio que Facturar y Corregir: primero se ve.
 * · Con `confirmar`: arranca la edición, o RETOMA la que quedó abierta para esa factura.
 *
 * Sin `renglones` (o con los mismos que ya tiene la factura) sólo se rehace el remito, si no
 * coincide con ella.
 */

/** Lo que la vieja observación ya traía de marca: no se arrastra a la nueva. */
const sinMarca = (s: unknown) => String(s ?? '').replace(/\s*\[(Remito Automático|OP:)[^\]]*\]/g, '').trim();

class NoSePuede extends Error { constructor(message: string, public status = 409) { super(message); } }

/** Un renglón de IM como lo usa la edición: precio BRUTO y su descuento, igual que al facturar. */
function aRenglon(it: any, catalogo?: Map<number, any>): RenglonEdicion {
  const desc = Number(it.descuento_porc ?? 0) || 0;
  const neto = Number(it.precio ?? 0) || 0;
  let bruto = Number(it.precio_orig ?? 0) || neto;
  // 🪤 IM a veces no manda `precio_orig` y el parser lo completa con el neto: con descuento, eso
  // lo descontaría dos veces. El bruto se reconstruye del neto.
  if (desc > 0 && desc < 100 && Math.abs(bruto - neto) < 0.00005) bruto = Math.round(neto / (1 - desc / 100) * 10000) / 10000;
  return {
    cod_articulo: Number(it.cod_articulo), cantidad: Number(it.cantidad),
    precio: desc > 0 ? bruto : neto, descuento_porc: desc,
    iva_por: it.iva_por == null ? undefined : Number(it.iva_por),
    cod_lista_precios: it.cod_lista_precios != null ? Number(it.cod_lista_precios) : null,
    descripcion: catalogo?.get(Number(it.cod_articulo))?.descripcion ?? it.detalle ?? undefined,
  };
}

async function leerVigente(id: string, tipo: 'FA' | 'RE') {
  const d = await leerComprobante(id);
  const c = d.cabecera;
  if (c.existe !== true || c.anulada !== false || c.tipo_comprobante !== tipo) return null;
  return d;
}

/** Lo que hay que saber de una factura para editarla, validado. Tira `NoSePuede` con el motivo. */
async function armar(idFactura: string, body: any) {
  const { data: fila, error } = await sb().from('presupuestos_facturados')
    .select('im_comprobante_id, cod_cliente, cod_empresa, im_factura_id, im_factura_numero, im_factura_tipo, im_remito_id, im_remito_numero, estado_emision')
    .eq('tenant_id', TENANT_ID).eq('im_factura_id', idFactura).maybeSingle();
  if (error) throw new NoSePuede(error.message, 500);
  if (!fila) throw new NoSePuede('Esta factura no salió de la app, así que no tengo su pedido ni su remito. Corregila en InfoManager o con notas.');
  if (fila.estado_emision !== 'completo' || !fila.im_remito_id) {
    throw new NoSePuede('Esa factura no tiene su remito emitido y completo. Resolvelo primero en Facturación.');
  }

  const [fa, re] = await Promise.all([leerComprobante(idFactura), leerComprobante(String(fila.im_remito_id))]);
  exigirTipoEmpresa(fa.cabecera, 'FA');
  if (fa.cabecera.existe !== true || fa.cabecera.anulada !== false) throw new NoSePuede(`No pude confirmar en InfoManager que la factura ${fila.im_factura_numero ?? ''} siga vigente.`);
  if (re.cabecera.existe !== true || re.cabecera.anulada !== false) throw new NoSePuede(`El remito ${fila.im_remito_numero ?? ''} ya no está vigente en InfoManager. Resolvelo en Facturación.`);
  if (!(Number(fa.cabecera.cod_vendedor) > 0)) throw new NoSePuede('La factura no tiene vendedor en InfoManager: la nueva quedaría sin comisión para nadie.');
  if (!fa.cabecera.fecha || !re.cabecera.fecha) throw new NoSePuede('InfoManager no devolvió la fecha de la factura o del remito.', 502);

  // Con notas o ajustes, la factura ya no es sólo ella: anularla las dejaría colgando.
  const [{ data: notas, error: e1 }, { data: ajustes, error: e2 }] = await Promise.all([
    sb().from('facturas_correcciones').select('tipo, numero').eq('tenant_id', TENANT_ID).eq('im_factura_id', idFactura).limit(5),
    sb().from('hojas_ruta_ajustes').select('im_ajuste_tipo, im_ajuste_numero').eq('tenant_id', TENANT_ID)
      .in('im_comprobante_id', [String(fila.im_remito_id), String(fila.im_comprobante_id)]).limit(5),
  ]);
  if (e1 || e2) throw new NoSePuede(`No pude verificar si tiene notas: ${(e1 ?? e2)!.message}`, 500);
  const todas = [...(notas ?? []).map((n: any) => `${n.tipo} ${n.numero ?? ''}`), ...(ajustes ?? []).map((a: any) => `${a.im_ajuste_tipo ?? 'nota'} ${a.im_ajuste_numero ?? ''}`)];
  if (todas.length) throw new NoSePuede(`La factura tiene ${todas.join(', ')}. Con notas encima no se puede rehacer: seguí corrigiéndola con notas.`);

  // 🔴 Un renglón escrito a mano con plata (sin código) no se puede volver a emitir por la API: la
  // factura nueva saldría por menos, en silencio.
  const aMano = fa.items.find(it => !(it.cod_articulo > 0) && Math.abs(Number(it.precio) * Number(it.cantidad)) >= 0.005);
  if (aMano) throw new NoSePuede(`La factura tiene un renglón escrito a mano con importe ("${aMano.detalle ?? 'sin texto'}"), y InfoManager no deja emitirlo sin código de artículo. Corregila con notas o en InfoManager.`);

  const catalogo = await fetchArticulosCatalogo().catch(() => new Map());
  const actuales = fa.items.filter(it => it.cod_articulo > 0).map(it => aRenglon(it, catalogo));
  const remito = re.items.filter(it => it.cod_articulo > 0).map(it => aRenglon(it, catalogo));
  let nuevos: RenglonEdicion[] | null = null;
  if (body?.renglones != null) {
    try { nuevos = validarRenglones(body.renglones); } catch (e: any) { throw new NoSePuede(e.message, 400); }
  }
  const decision = decidirEdicion(actuales, remito, nuevos);
  if (!decision.rehace_factura && !decision.remito_difiere) throw new NoSePuede('No hay nada que cambiar: la factura queda igual y el remito ya coincide con ella.', 400);

  let categoria_iva: any = null;
  if (decision.rehace_factura) {
    // 🔴 Un pago imputado quedaría colgando de una factura anulada.
    const pendientes = await comprobantesPendientesCliente(Number(fila.cod_cliente), Number(fila.cod_empresa) || 1);
    const pend = pendientes.find(p => String(p.id) === idFactura);
    // 🪤 Una factura con fecha FUTURA no figura en pendientes (FA B 51277, 06/10/2026): se confirma
    // con /reportes/facturas. Si tampoco aparece ahí, se frena: no se puede afirmar que no tenga pagos.
    const reporte = pend ? null : await pagadoDeFactura(idFactura, String(fa.cabecera.fecha ?? ''));
    const sinPagos = pend ? Math.abs(Number(pend.saldo) - Number(fa.cabecera.total)) <= 0.5
      : !!reporte && reporte.pagado <= 0.5 && Math.abs(reporte.saldo - Number(fa.cabecera.total)) <= 0.5;
    if (!sinPagos) {
      const cobrado = pend ? Number(fa.cabecera.total) - Number(pend.saldo) : reporte ? reporte.pagado : Number(fa.cabecera.total);
      throw new NoSePuede(`La factura ${fila.im_factura_numero} tiene $${Math.round(cobrado).toLocaleString('es-AR')} cobrados. Desimputá el recibo en InfoManager antes de editarla, o corregila con notas.`);
    }
    const [cliente] = (await fetchClientesIMCon([Number(fila.cod_cliente)])).filter((c: any) => Number(c.cod_cliente) === Number(fila.cod_cliente));
    categoria_iva = (cliente as any)?.categoria_iva ?? null;
    const letra = String(fa.cabecera.tipo_factura ?? '').trim();
    if (!['A', 'B'].includes(letra) || letraDeFactura(categoria_iva) !== letra) {
      throw new NoSePuede('La letra de la factura no coincide con la condición de IVA actual del cliente. Revisala en InfoManager antes de editarla.');
    }
  }

  // La hoja: cerrada ya se liquidó. La función de la base lo vuelve a mirar bajo lock.
  const { data: enHoja } = await sb().from('hojas_ruta_pedidos')
    .select('hojas_ruta!inner(numero, estado, tenant_id)').eq('hojas_ruta.tenant_id', TENANT_ID)
    .in('im_comprobante_id', [String(fila.im_remito_id), String(fila.im_comprobante_id)]).limit(1);
  const hoja = (enHoja?.[0] as any)?.hojas_ruta ?? null;
  if (hoja && hoja.estado !== 'abierta') throw new NoSePuede(`El remito está en la hoja ${hoja.numero}, que ya está ${hoja.estado}. Reabrila antes de editar.`);

  const stock = movimientosDeStock(remito, decision.finales);
  const nombre = (cod: number) => catalogo.get(cod)?.descripcion ?? `Artículo ${cod}`;
  return {
    fila, fa, re, decision, categoria_iva, hoja, catalogo,
    resumen: {
      rehace_factura: decision.rehace_factura,
      factura: { numero: fila.im_factura_numero, tipo: fila.im_factura_tipo, total_actual: Number(fa.cabecera.total), total_nuevo: totalRenglones(decision.finales) },
      remito: { numero: fila.im_remito_numero, total_actual: Number(re.cabecera.total), total_nuevo: totalRenglones(decision.finales) },
      vuelve: stock.vuelve.map(m => ({ ...m, descripcion: nombre(m.cod_articulo) })),
      sale: stock.sale.map(m => ({ ...m, descripcion: nombre(m.cod_articulo) })),
      hoja: hoja?.numero ?? null,
    },
  };
}

function depsReales(actor: string): DepsEdicion {
  const vigente = async (id: string): Promise<boolean | null> => {
    const c = await cabeceraComprobante(id);
    if (c.existe === false || c.anulada === true) return true;
    if (c.existe === true && c.anulada === false) return false;
    return null;
  };
  return {
    facturaAnulada: vigente,
    remitoAnulado: vigente,
    anularFactura: (id, motivo) => anularConservandoCabecera(id, motivo),
    emitirFactura: (d) => emitirFactura(d),
    renglonesDeFactura: async (id) => {
      try {
        const d = await leerVigente(id, 'FA');
        return d ? d.items.filter(it => it.cod_articulo > 0).map(it => aRenglon(it)) : null;
      } catch { return null; }
    },
    /** Igual que Facturar: si IM rechaza por stock, el remito sale por el masivo, que descuenta igual. */
    emitirRemito: async (d): Promise<ResultadoEmision> => {
      const r = await emitirRemito(d);
      if (r.ok || r.sinRespuesta) return r;
      const catalogo = await fetchArticulosCatalogo().catch(() => new Map());
      return articulosSinStockDelError(r.error, catalogo) ? emitirRemitoMasivo(d) : r;
    },
    anularRemito: async (re, motivo) => {
      const r = await anularComprobante({
        id: re.id, numero: Number(re.numero) || 0, punto_de_venta: re.punto_de_venta, fecha: re.fecha,
        tipo_comprobante: 'RE', observaciones: `ANULADO: ${motivo}`.slice(0, 500),
      });
      if (!r.ok) return r;
      // Que quedó anulado lo dice IM releyendo, no la respuesta del PUT (regla de oro de esta API).
      const post = await cabeceraComprobante(re.id);
      return post.existe === true && post.anulada === false
        ? { ok: false, error: 'InfoManager aceptó la anulación pero el remito sigue vigente.' }
        : { ok: true };
    },
    reemplazarEnHoja: async (op, renglones) => {
      const catalogo = await fetchArticulosCatalogo();
      const peso = pesoDeRenglones(renglones.map(r => ({
        cantidad: r.cantidad, equivalencia_um: catalogo.get(r.cod_articulo)?.equivalencia_um,
        sin_peso_a_proposito: sinPesoAProposito(r.cod_articulo, catalogo.get(r.cod_articulo)),
      })));
      const factura = op.fa_nueva ?? { id: op.fa_vieja.id, numero: op.fa_vieja.numero };
      const { data, error } = await sb().rpc('reemplazar_remito_en_hoja', {
        p_tenant: TENANT_ID, p_actor: actor,
        p_datos: {
          remito_viejo: op.re_viejo.id, remito_nuevo: op.re_nuevo!.id, pedido: op.im_comprobante_id,
          remito_numero: op.re_nuevo!.numero, factura_id: factura.id, factura_numero: factura.numero,
          total: totalRenglones(renglones), bultos: peso.bultos, kg: peso.kg,
          peso_completo: peso.renglones_sin_peso === 0, renglones_sin_peso: peso.renglones_sin_peso,
        },
      });
      if (error) throw new Error(['PGRST202', '42883'].includes(String(error.code)) ? 'Falta aplicar la migración 054 en la base.' : error.message);
      return { hoja: (data as any)?.hoja ?? null };
    },
    cerrarPedido: async (op) => {
      const { data: actual } = await sb().from('presupuestos_facturados').select('historial_facturas, historial_remitos')
        .eq('tenant_id', TENANT_ID).eq('im_comprobante_id', op.im_comprobante_id).maybeSingle();
      const hf = Array.isArray(actual?.historial_facturas) ? actual!.historial_facturas : [];
      const hr = Array.isArray(actual?.historial_remitos) ? actual!.historial_remitos : [];
      const { data, error } = await sb().from('presupuestos_facturados').update({
        ...(op.fa_nueva ? {
          im_factura_id: op.fa_nueva.id, im_factura_numero: op.fa_nueva.numero, im_factura_tipo: op.fa_nueva.tipo,
          historial_facturas: [...hf, { id: op.fa_vieja.id, numero: op.fa_vieja.numero, tipo: op.fa_vieja.tipo, motivo: `editada: ${op.motivo}`.slice(0, 200) }],
        } : {}),
        im_remito_id: op.re_nuevo!.id, im_remito_numero: op.re_nuevo!.numero,
        historial_remitos: [...hr, { id: op.re_viejo.id, numero: op.re_viejo.numero, motivo: 'rehecho al editar la factura' }],
        estado_emision: 'completo', claim_token: null,
      }).eq('tenant_id', TENANT_ID).eq('im_comprobante_id', op.im_comprobante_id).eq('estado_emision', 'editando').select('im_comprobante_id');
      if (error) throw new Error(`Los comprobantes nuevos salieron pero no pude registrarlos en el pedido: ${error.message}`);
      if (!data?.length) throw new Error('El pedido ya no está en edición: alguien lo tocó mientras tanto. Revisalo en Facturación.');
    },
    guardar: async (op) => {
      const { error } = await sb().from('facturas_ediciones').update({
        estado: op.estado, paso: op.paso, datos: op, error: op.error, updated_at: new Date().toISOString(),
      }).eq('tenant_id', TENANT_ID).eq('id', op.id);
      // 🔴 Sin el registro, un reintento no sabría qué ya salió. Se frena.
      if (error) throw new Error(`No pude anotar el avance de la edición: ${error.message}`);
    },
  };
}

/**
 * 🔑 SI EL PRIMER PASO FALLÓ SIN CAMBIAR NADA EN IM, LA EDICIÓN SE SUELTA SOLA.
 *
 * Sin esto el pedido quedaba "editando" para siempre por un rechazo que no tocó ningún
 * comprobante —p. ej. IM no dejó anular—, y en ese estado tampoco se puede anular ni volver a
 * editar. Sólo cuando se puede asegurar que no pasó nada: nada emitido, en el primer paso, y la
 * factura vieja todavía viva.
 */
async function soltarSiNoCambioNada(op: Edicion): Promise<boolean> {
  if (op.estado !== 'fallo' || op.fa_nueva || op.re_nuevo) return false;
  if (op.paso !== (op.rehace_factura ? 'anular_fa' : 'emitir_re')) return false;
  if (op.rehace_factura) {
    const c = await cabeceraComprobante(op.fa_vieja.id).catch(() => null);
    if (!(c?.existe === true && c?.anulada === false)) return false;
  }
  const { data, error } = await sb().from('presupuestos_facturados').update({ estado_emision: 'completo' })
    .eq('tenant_id', TENANT_ID).eq('im_comprobante_id', op.im_comprobante_id).eq('estado_emision', 'editando')
    .select('im_comprobante_id');
  if (error || !data?.length) return false;
  await sb().from('facturas_ediciones').update({ estado: 'cancelada', updated_at: new Date().toISOString() })
    .eq('tenant_id', TENANT_ID).eq('id', op.id);
  return true;
}

async function responder(res: Response, op: Edicion) {
  invalidarIM(); invalidarVista(); invalidarRemitos();
  if (await soltarSiNoCambioNada(op)) {
    res.status(409).json({ ...respuestaDe(op), estado: 'cancelada', error: `${op.error ?? 'InfoManager rechazó el primer paso.'} No se cambió nada: la factura y el remito siguen como estaban.` });
    return;
  }
  res.status(op.estado === 'completo' ? 200 : 502).json(respuestaDe(op));
}

function respuestaDe(op: Edicion) {
  return {
    ok: op.estado === 'completo', estado: op.estado, paso: op.paso, error: op.error,
    factura_nueva: op.fa_nueva, remito_nuevo: op.re_nuevo, hoja: op.hoja,
    factura_vieja: { numero: op.fa_vieja.numero, tipo: op.fa_vieja.tipo }, remito_viejo: { numero: op.re_viejo.numero },
  };
}

async function edicionAbierta(idFactura: string): Promise<Edicion | null> {
  const { data, error } = await sb().from('facturas_ediciones').select('datos')
    .eq('tenant_id', TENANT_ID).eq('im_factura_id', idFactura).in('estado', ['en_curso', 'fallo', 'incierto']).maybeSingle();
  if (error) throw new NoSePuede(['42P01', 'PGRST205'].includes(String((error as any).code)) ? 'Falta aplicar la migración 054 en la base para editar facturas.' : error.message, 503);
  return (data?.datos as Edicion) ?? null;
}

export async function editarFactura(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  const idFactura = String(req.body?.im_factura_id ?? '').trim();
  if (!/^\d+$/.test(idFactura)) { res.status(400).json({ error: 'Falta la factura.' }); return; }
  const confirmar = req.body?.confirmar === true;
  const actor = req.user?.sub;
  try {
    // Una edición que quedó a mitad de camino se retoma; no se arranca otra encima.
    const abierta = await edicionAbierta(idFactura);
    if (abierta) {
      if (!confirmar) { res.json({ abierta: respuestaDe(abierta) }); return; }
      if (abierta.estado === 'incierto') {
        res.status(409).json({ error: `${abierta.error ?? 'No se sabe si InfoManager hizo el último paso.'} Hasta que se verifique a mano no se reintenta: reintentar a ciegas puede emitir dos veces.`, abierta: respuestaDe(abierta) });
        return;
      }
      await responder(res, await avanzarEdicion(abierta, depsReales(String(actor))));
      return;
    }

    const a = await armar(idFactura, req.body);
    if (!confirmar) { res.json({ previsualizacion: a.resumen }); return; }
    if (!actor) { res.status(401).json({ error: 'Falta el usuario.' }); return; }

    const motivo = String(req.body?.motivo ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'corrección de la factura';
    const cab = a.fa.cabecera;
    const op: Edicion = {
      id: randomUUID(), im_comprobante_id: String(a.fila.im_comprobante_id),
      rehace_factura: a.decision.rehace_factura,
      fa_vieja: { id: idFactura, numero: a.fila.im_factura_numero ?? null, tipo: a.fila.im_factura_tipo ?? null, fecha: cab.fecha! },
      re_viejo: { id: String(a.fila.im_remito_id), numero: a.fila.im_remito_numero ?? null, fecha: a.re.cabecera.fecha!, punto_de_venta: Number(a.re.cabecera.punto_de_venta) },
      renglones: a.decision.rehace_factura ? a.decision.finales : null,
      datos: {
        cod_empresa: Number(cab.cod_empresa), cod_cliente: Number(cab.cod_cliente), cod_vendedor: Number(cab.cod_vendedor),
        categoria_iva: a.categoria_iva, cod_lista_precios: Number(cab.cod_lista_precios) || 12,
        usuario: await usuarioIM(req.user),
        observaciones: [sinMarca(cab.observaciones), a.decision.rehace_factura ? `reemplaza a la ${a.fila.im_factura_tipo ?? 'FA'} ${a.fila.im_factura_numero ?? ''}` : '']
          .filter(Boolean).join(' - ').slice(0, 400),
        origen_id: String(a.fila.im_comprobante_id), cod_deposito: 1,
      },
      motivo, paso: a.decision.rehace_factura ? 'anular_fa' : 'emitir_re', estado: 'en_curso', error: null,
      fa_nueva: null, re_nuevo: null, hoja: null,
    };

    // 🔴 El registro va ANTES de tocar InfoManager, y el índice único frena una segunda edición.
    const { error: errIns } = await sb().from('facturas_ediciones').insert({
      tenant_id: TENANT_ID, id: op.id, im_comprobante_id: op.im_comprobante_id, im_factura_id: idFactura,
      estado: op.estado, paso: op.paso, datos: op, creado_por: actor,
    });
    if (errIns) {
      res.status(String((errIns as any).code) === '23505' ? 409 : 503).json({ error: String((errIns as any).code) === '23505'
        ? 'Ya hay una edición en curso de este pedido. Actualizá la pantalla.'
        : ['42P01', 'PGRST205'].includes(String((errIns as any).code)) ? 'Falta aplicar la migración 054 en la base para editar facturas.' : errIns.message });
      return;
    }
    // Mientras dura, el pedido está "editando": Facturar y la sincronización de anulados no lo tocan.
    const { data: marcado, error: errMarca } = await sb().from('presupuestos_facturados').update({ estado_emision: 'editando' })
      .eq('tenant_id', TENANT_ID).eq('im_comprobante_id', op.im_comprobante_id).eq('estado_emision', 'completo').eq('im_factura_id', idFactura)
      .select('im_comprobante_id');
    if (errMarca || !marcado?.length) {
      await sb().from('facturas_ediciones').delete().eq('tenant_id', TENANT_ID).eq('id', op.id);
      res.status(409).json({ error: errMarca?.message ?? 'El pedido cambió mientras tanto. Actualizá la pantalla: no se tocó nada.' });
      return;
    }

    await responder(res, await avanzarEdicion(op, depsReales(actor)));
  } catch (err: any) {
    if (err instanceof NoSePuede || err instanceof ErrorVersion) { res.status((err as any).status ?? 409).json({ error: err.message }); return; }
    console.error('[editarFactura]', err?.message);
    res.status(502).json({ error: err?.message ?? 'No se pudo editar la factura.' });
  }
}
