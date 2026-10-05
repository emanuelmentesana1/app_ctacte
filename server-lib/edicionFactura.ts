import type { DatosComprobante, ResultadoEmision } from './facturarIM.js';

/**
 * EDITAR UNA FACTURA EMITIDA: anular y volver a emitir factura y remito.
 *
 * Mati (30/09/2026), por Jorgelina: *"InfoManager es más fácil ya que sólo edita la factura y
 * listo, y en la app tiene que ponerse a emitir NC y ND... no podemos hacer que se pueda modificar
 * la factura y no tener que emitir tantos comprobantes? acordate que éstas no pasan por ARCA"*.
 *
 * 🔴 La API de IM NO edita renglones (probado contra IM real el 04/09/2026: precio y descuento se
 * ignoran en silencio y agregar un renglón contesta 200 sin hacer nada). Editar desde la app es
 * REHACER: se anula la factura, se emite la nueva con la misma fecha, y el remito se rehace con
 * los renglones de ella — el viejo, al anularse, devuelve el stock; el nuevo descuenta lo que sale.
 *
 * Y por qué hacía falta: editando en la pantalla de IM el remito queda como estaba. El 29-30/09 eso
 * dejó tres remitos que no decían lo mismo que su factura (FAB 51031, 51034 y FAA 1658) y el stock
 * descontado de productos que no salieron.
 *
 * Este módulo es SÓLO la secuencia y sus reglas: todo lo que habla con IM o con la base entra por
 * `DepsEdicion`, para poder probar un corte en cada paso sin tocar nada real.
 */

/** Costo de distribución: es plata, no mercadería. No mueve stock ni se compara como producto. */
const NO_FISICOS = new Set([Number(process.env.IM_ART_COSTO_DISTRIBUCION || 13819)]);

export interface RenglonEdicion {
  cod_articulo: number;
  cantidad: number;
  /** BRUTO cuando hay descuento, igual que al facturar (ver facturarPresupuestos). */
  precio: number;
  descuento_porc?: number | null;
  iva_por?: number | null;
  cod_lista_precios?: number | null;
  descripcion?: string;
}

export type PasoEdicion = 'anular_fa' | 'emitir_fa' | 'emitir_re' | 'hoja' | 'anular_re' | 'cerrar' | 'listo';
export type EstadoEdicion = 'en_curso' | 'fallo' | 'incierto' | 'completo' | 'cancelada';

/** Lo que va quedando anotado de una edición. Se guarda después de CADA paso (`guardar`). */
export interface Edicion {
  id: string;
  /** El pedido (presupuesto) del que salieron factura y remito: la fila de `presupuestos_facturados`. */
  im_comprobante_id: string;
  rehace_factura: boolean;
  fa_vieja: { id: string; numero: number | null; tipo: string | null; fecha: string };
  re_viejo: { id: string; numero: number | null; fecha: string; punto_de_venta: number };
  /** Cómo tiene que quedar la factura. `null` cuando sólo se rehace el remito. */
  renglones: RenglonEdicion[] | null;
  /** Cabecera de los comprobantes nuevos: sale de la factura vieja, no se adivina. */
  datos: Omit<DatosComprobante, 'items' | 'total' | 'fecha' | 'numero' | 'im_factura_id'>;
  motivo: string;
  paso: PasoEdicion;
  estado: EstadoEdicion;
  error: string | null;
  fa_nueva: { id: string; numero: number | null; tipo: string } | null;
  re_nuevo: { id: string; numero: number | null } | null;
  hoja: number | null;
}

export interface DepsEdicion {
  /** `true` anulada, `false` vigente, `null` no se pudo saber. */
  facturaAnulada(id: string): Promise<boolean | null>;
  anularFactura(id: string, motivo: string): Promise<{ ok: true } | { ok: false; error: string; incierto?: boolean }>;
  emitirFactura(d: DatosComprobante): Promise<ResultadoEmision>;
  /** Los renglones que IM dice que TIENE la factura. `null` si no se pudieron leer. */
  renglonesDeFactura(id: string): Promise<RenglonEdicion[] | null>;
  emitirRemito(d: DatosComprobante): Promise<ResultadoEmision>;
  remitoAnulado(id: string): Promise<boolean | null>;
  anularRemito(re: Edicion['re_viejo'], motivo: string): Promise<{ ok: true } | { ok: false; error: string; sinRespuesta?: boolean }>;
  /** Cambia el remito viejo por el nuevo en la hoja de ruta, en su lugar. `hoja: null` si no estaba en ninguna. */
  reemplazarEnHoja(op: Edicion, renglonesRemito: RenglonEdicion[]): Promise<{ hoja: number | null }>;
  /** Deja el pedido apuntando a los comprobantes nuevos, con los viejos en su historial. */
  cerrarPedido(op: Edicion): Promise<void>;
  guardar(op: Edicion): Promise<void>;
}

export function pasosDe(rehaceFactura: boolean): PasoEdicion[] {
  return rehaceFactura
    ? ['anular_fa', 'emitir_fa', 'emitir_re', 'hoja', 'anular_re', 'cerrar']
    : ['emitir_re', 'hoja', 'anular_re', 'cerrar'];
}

const netoUnitario = (r: RenglonEdicion) => Number(r.precio) * (1 - (Number(r.descuento_porc ?? 0) || 0) / 100);

export function totalRenglones(rs: RenglonEdicion[]): number {
  return Math.round(rs.reduce((s, r) => s + Number(r.cantidad) * netoUnitario(r), 0) * 100) / 100;
}

/**
 * ¿Dicen lo mismo? Por artículo: cantidad y precio NETO. El remito masivo guarda el neto con
 * descuento 0 y la factura el bruto con su descuento, así que comparar precio y descuento por
 * separado daría "distintos" para comprobantes iguales.
 */
export function mismosRenglones(a: RenglonEdicion[], b: RenglonEdicion[]): boolean {
  const resumen = (rs: RenglonEdicion[]) => {
    const m = new Map<number, { cantidad: number; importe: number }>();
    for (const r of rs) {
      const v = m.get(Number(r.cod_articulo)) ?? { cantidad: 0, importe: 0 };
      v.cantidad += Number(r.cantidad); v.importe += Number(r.cantidad) * netoUnitario(r);
      m.set(Number(r.cod_articulo), v);
    }
    return m;
  };
  const ra = resumen(a), rb = resumen(b);
  if (ra.size !== rb.size) return false;
  for (const [cod, x] of ra) {
    const y = rb.get(cod);
    if (!y || Math.abs(x.cantidad - y.cantidad) > 0.0001 || Math.abs(x.importe - y.importe) > 0.01) return false;
  }
  return true;
}

/** Lo que vuelve al depósito y lo que sale de más, pasando del remito viejo al nuevo. */
export function movimientosDeStock(viejo: RenglonEdicion[], nuevo: RenglonEdicion[]) {
  const cant = (rs: RenglonEdicion[]) => {
    const m = new Map<number, number>();
    for (const r of rs) {
      if (NO_FISICOS.has(Number(r.cod_articulo))) continue;
      m.set(Number(r.cod_articulo), (m.get(Number(r.cod_articulo)) ?? 0) + Number(r.cantidad));
    }
    return m;
  };
  const v = cant(viejo), n = cant(nuevo);
  const vuelve: Array<{ cod_articulo: number; cantidad: number }> = [];
  const sale: Array<{ cod_articulo: number; cantidad: number }> = [];
  for (const cod of [...new Set([...v.keys(), ...n.keys()])].sort((a, b) => a - b)) {
    const dif = Math.round(((n.get(cod) ?? 0) - (v.get(cod) ?? 0)) * 10000) / 10000;
    if (dif < 0) vuelve.push({ cod_articulo: cod, cantidad: -dif });
    if (dif > 0) sale.push({ cod_articulo: cod, cantidad: dif });
  }
  return { vuelve, sale };
}

/**
 * Qué hay que rehacer.
 *
 * 🔑 Se puede editar SIN cambiar nada de la factura: si el remito no dice lo mismo que ella (lo
 * que dejó la edición en la pantalla de IM el 29-30/09), se rehace sólo el remito. La factura no
 * se toca — ni número ni fecha — y el stock queda bien.
 */
export function decidirEdicion(actuales: RenglonEdicion[], remito: RenglonEdicion[], nuevos: RenglonEdicion[] | null) {
  const rehace_factura = !!nuevos && !mismosRenglones(nuevos, actuales);
  const finales = rehace_factura ? nuevos! : actuales;
  return { rehace_factura, remito_difiere: !mismosRenglones(remito, finales), finales };
}

/**
 * Los renglones que manda la pantalla, validados. Tira un `Error` con un mensaje para la oficina.
 *
 * Los mismos criterios que la corrección con notas (`tramitarCorreccion`), porque es la misma
 * grilla: cantidad 0 es "lo saco", el precio tiene que estar consultado y el descuento es un %.
 */
export function validarRenglones(raw: unknown): RenglonEdicion[] {
  if (!Array.isArray(raw)) throw new Error('Faltan los renglones de la factura.');
  const leidos = raw.map((r: any) => {
    if (r?.precio == null || String(r.precio).trim() === '') throw new Error('Falta consultar el precio de un artículo. Elegí su lista antes de guardar.');
    const n: RenglonEdicion = {
      cod_articulo: Number(r?.cod_articulo), cantidad: Number(r?.cantidad), precio: Number(r?.precio),
      descuento_porc: Number(r?.descuento_porc ?? 0) || 0,
      iva_por: r?.iva_por == null ? undefined : Number(r.iva_por),
      cod_lista_precios: r?.cod_lista_precios == null ? null : Number(r.cod_lista_precios),
      descripcion: r?.descripcion == null ? undefined : String(r.descripcion),
    };
    if (!Number.isSafeInteger(n.cod_articulo) || n.cod_articulo <= 0 || !Number.isFinite(n.cantidad) || n.cantidad < 0
      || !Number.isFinite(n.precio) || n.precio < 0 || !Number.isFinite(n.descuento_porc!) || n.descuento_porc! < 0 || n.descuento_porc! > 100
      || (n.iva_por != null && !Number.isFinite(n.iva_por)) || (n.cod_lista_precios != null && !Number.isSafeInteger(n.cod_lista_precios))) {
      throw new Error('Hay un renglón inválido. No se cambió nada.');
    }
    return n;
  }).filter(r => r.cantidad > 0);
  if (!leidos.length) throw new Error('La factura quedaría sin productos: eso es anularla, no editarla. Usá "Anular".');

  // El mismo artículo en dos renglones: se suma si es al mismo precio; a precios distintos no se
  // puede mostrar ni comparar en una sola fila, y se dice en vez de elegir uno.
  const porArticulo = new Map<number, RenglonEdicion>();
  for (const r of leidos) {
    const ya = porArticulo.get(r.cod_articulo);
    if (!ya) { porArticulo.set(r.cod_articulo, { ...r }); continue; }
    if (Math.abs(ya.precio - r.precio) > 0.00005 || Number(ya.descuento_porc ?? 0) !== Number(r.descuento_porc ?? 0) || (ya.iva_por ?? null) !== (r.iva_por ?? null)) {
      throw new Error(`El artículo ${r.cod_articulo} está dos veces a precios distintos. Dejalo en un solo renglón.`);
    }
    ya.cantidad += r.cantidad;
  }
  return [...porArticulo.values()];
}

/**
 * Avanza la edición desde el paso en que quedó hasta terminar o hasta el primer problema.
 *
 * 🔑 EL ORDEN ES LA RED DE SEGURIDAD:
 *  · La factura vieja se anula ANTES de emitir la nueva: si algo se corta en el medio queda un
 *    pedido sin factura —se retoma—, nunca un cliente con dos facturas vivas.
 *  · El remito viejo se anula DESPUÉS de emitir el nuevo y de cambiarlo en la hoja: la entrega
 *    nunca se queda sin un remito que la respalde.
 *  · Cada comprobante emitido se GUARDA antes de dar el paso siguiente: un reintento no lo vuelve
 *    a emitir.
 *
 * 🔴 `incierto` = IM no contestó a una emisión o anulación y NO se sabe si pasó. Ahí se para y no
 * se reintenta solo: reintentar a ciegas es cómo se emite dos veces.
 */
export async function avanzarEdicion(entrada: Edicion, deps: DepsEdicion): Promise<Edicion> {
  const op: Edicion = { ...entrada, estado: 'en_curso', error: null };
  const pasos = pasosDe(op.rehace_factura);
  const frenar = async (estado: 'fallo' | 'incierto', error: string) => {
    op.estado = estado; op.error = error;
    await deps.guardar(op);
    return op;
  };
  const avanzar = async (siguiente: PasoEdicion) => { op.paso = siguiente; await deps.guardar(op); };

  while (op.paso !== 'listo') {
    const i = pasos.indexOf(op.paso);
    if (i < 0) return frenar('fallo', `Paso desconocido: ${op.paso}.`);
    const siguiente: PasoEdicion = pasos[i + 1] ?? 'listo';
    try {
      switch (op.paso) {
        case 'anular_fa': {
          const anulada = await deps.facturaAnulada(op.fa_vieja.id);
          if (anulada === null) return frenar('fallo', `No pude verificar en InfoManager la factura ${op.fa_vieja.numero ?? ''}. No se tocó nada: probá de nuevo en un rato.`);
          if (!anulada) {
            const r = await deps.anularFactura(op.fa_vieja.id, `Reemplazada al editarla desde la app: ${op.motivo}`);
            if (!r.ok) return frenar(r.incierto ? 'incierto' : 'fallo', `InfoManager no anuló la factura ${op.fa_vieja.numero ?? ''}: ${r.error}`);
          }
          break;
        }
        case 'emitir_fa': {
          if (op.fa_nueva) break;
          const renglones = op.renglones ?? [];
          if (!renglones.length) return frenar('fallo', 'La factura nueva no tiene renglones.');
          // 🔴 Sin `origen_id`: viaja en `cod_compatibilidad`, y IM lo rechaza repetido aunque la factura
          // que lo tenía esté anulada (FAB 51178, 05/10/2026). El vínculo con el pedido vive de nuestro lado.
          const r = await deps.emitirFactura({ ...op.datos, origen_id: null, items: renglones as any, total: totalRenglones(renglones), fecha: op.fa_vieja.fecha, numero: null });
          if (!r.ok) {
            return r.sinRespuesta
              ? frenar('incierto', `InfoManager no contestó al emitir la factura nueva. NO se sabe si salió: verificalo en InfoManager antes de hacer nada. (${r.error})`)
              : frenar('fallo', `InfoManager rechazó la factura nueva: ${r.error}. La vieja ya está anulada: reintentá, o avisá si sigue fallando.`);
          }
          op.fa_nueva = { id: String(r.id), numero: r.numero ?? null, tipo: r.tipo };
          break;
        }
        case 'emitir_re': {
          if (op.re_nuevo) break;
          const idFactura = op.fa_nueva?.id ?? op.fa_vieja.id;
          const renglones = await deps.renglonesDeFactura(idFactura);
          if (!renglones?.length) return frenar('fallo', `No pude leer los renglones de la factura ${op.fa_nueva?.numero ?? op.fa_vieja.numero ?? ''} en InfoManager, y el remito tiene que decir lo mismo que ella. Reintentá en un rato.`);
          const r = await deps.emitirRemito({ ...op.datos, items: renglones as any, total: totalRenglones(renglones), fecha: op.re_viejo.fecha, im_factura_id: idFactura });
          if (!r.ok) {
            return r.sinRespuesta
              ? frenar('incierto', `InfoManager no contestó al emitir el remito nuevo. NO se sabe si salió: verificalo antes de hacer nada. (${r.error})`)
              : frenar('fallo', `InfoManager rechazó el remito nuevo: ${r.error}`);
          }
          op.re_nuevo = { id: String(r.id), numero: r.numero ?? null };
          break;
        }
        case 'hoja': {
          const idFactura = op.fa_nueva?.id ?? op.fa_vieja.id;
          const renglones = await deps.renglonesDeFactura(idFactura);
          if (!renglones?.length) return frenar('fallo', 'No pude leer la factura para recalcular el peso de la entrega. Reintentá en un rato.');
          const r = await deps.reemplazarEnHoja(op, renglones);
          op.hoja = r.hoja;
          break;
        }
        case 'anular_re': {
          const anulado = await deps.remitoAnulado(op.re_viejo.id);
          if (anulado === null) return frenar('fallo', `No pude verificar en InfoManager el remito ${op.re_viejo.numero ?? ''}. Reintentá en un rato.`);
          if (!anulado) {
            const r = await deps.anularRemito(op.re_viejo, `Reemplazado por el remito ${op.re_nuevo?.numero ?? ''} al editar la factura: ${op.motivo}`);
            if (!r.ok) return frenar(r.sinRespuesta ? 'incierto' : 'fallo', `InfoManager no anuló el remito ${op.re_viejo.numero ?? ''}: ${r.error}. El nuevo ya salió: hasta que se anule, el stock queda descontado dos veces.`);
          }
          break;
        }
        case 'cerrar':
          await deps.cerrarPedido(op);
          break;
      }
    } catch (e: any) {
      return frenar('fallo', e?.message ?? String(e));
    }
    await avanzar(siguiente);
  }
  op.estado = 'completo';
  await deps.guardar(op);
  return op;
}
