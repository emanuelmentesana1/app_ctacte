/**
 * MERCADERÍA YA FACTURADA QUE VIAJA CON UN PEDIDO NUEVO ("pendientes de entrega").
 *
 * Mati (01/10/2026): *"este presupu tiene articulos cargados a mano sin costo, esto pasa porque es
 * mercaderia que ya estaba facturada y remitida antes.. y jo la agrega unicamente para que la
 * puedan cargar en la parte de logistica, no hay que facturarla de nuevo... este tipo de casos
 * nunca lo contemplamos"*. Eligió que los guarde la app y que salgan en el papel que firma el
 * cliente.
 *
 * La oficina los escribía en InfoManager como renglones SIN código en $0 ("MAIZ LEALES 25
 * PENDIENTE": 24 presupuestos en septiembre). La API de IM no puede crear esos renglones
 * —`cod_articulo` es obligatorio—, y de ahí salían tres problemas:
 *  · rehacer el presupuesto los borraba, así que la app se negaba a agregarle un producto
 *    (CARDENES, PR 59080);
 *  · desde que factura la app (09/09) no salen ni en la factura ni en el remito;
 *  · la hoja de ruta no los veía: ni bultos ni kilos.
 *
 * Ahora viven en `pendientes_entrega` (migración 055), colgados del presupuesto. Los que siguen
 * escritos en IM se muestran junto con los de la app y PASAN a la app cuando el presupuesto se
 * rehace o se factura. Nunca van a InfoManager: no se facturan y no mueven stock (ya lo movió el
 * remito original).
 */
import { sb, TENANT_ID } from './supabase.js';
import { pesoDeRenglones, type Peso } from './pesoComprobante.js';

export interface Pendiente {
  /** La fila en la app. Sin `id`, todavía está sólo escrito en InfoManager. */
  id?: string | null;
  /** El renglón escrito a mano en IM del que salió, si salió de ahí. */
  im_renglon_id: string | null;
  /** Con artículo se sabe cuánto pesa; sin artículo es sólo el texto que venía de IM. */
  cod_articulo: number | null;
  descripcion: string;
  cantidad: number;
  /** De qué factura sale ("FA B 50680"). */
  factura_ref: string | null;
  /** `app` = guardado acá · `im` = sigue escrito en InfoManager. */
  origen: 'app' | 'im';
  creado_por?: string | null;
  created_at?: string | null;
}

export class ErrorPendientes extends Error {
  constructor(message: string, public status = 502, public faltaMigracion = false) { super(message); }
}

export const MSJ_FALTA_MIGRACION = 'Falta aplicar la migración 055 (pendientes de entrega) en la base';

/** La tabla o la función todavía no existen: el código salió antes que el SQL. */
const CODIGOS_SIN_MIGRACION = new Set(['42P01', 'PGRST205', 'PGRST202', '42883']);
const faltaMigracion = (error: any) => CODIGOS_SIN_MIGRACION.has(String(error?.code ?? ''));

/**
 * ¿Es un renglón escrito a mano en IM en $0? Así carga la oficina la mercadería que viaja sin
 * cobrarse. 🪤 Uno sin código CON importe es otra cosa —un flete escrito a mano— y no es esto.
 *
 * `/ventas/items` trae el código como `""` y el detalle del presupuesto como `0`: los dos valen.
 * `precio` es el neto en las dos lecturas (con el descuento del 100% adentro).
 */
export function esPendienteDeIM(it: any): boolean {
  const cantidad = Number(it?.cantidad);
  return !(Number(it?.cod_articulo) > 0) && Number.isFinite(cantidad) && cantidad > 0
    && Math.abs(Number(it?.precio ?? 0) * cantidad) < 0.005;
}

/** Los renglones a mano de IM, con la forma de un pendiente. */
export function pendientesDeIM(items: any[]): Pendiente[] {
  return (items ?? []).filter(esPendienteDeIM).map(it => ({
    im_renglon_id: it.id != null ? String(it.id) : null,
    cod_articulo: null,
    descripcion: String(it.detalle ?? '').trim() || 'Sin descripción',
    cantidad: Number(it.cantidad),
    factura_ref: null,
    origen: 'im' as const,
  }));
}

/**
 * Todo lo que el presupuesto lleva sin cobrar: lo guardado en la app y lo que sigue escrito en IM.
 * 🪤 Un renglón de IM que ya se pasó a la app (al facturar) aparece en los dos lados: va una vez.
 */
export function unirPendientes(app: Pendiente[], items: any[]): Pendiente[] {
  const pasados = new Set(app.map(p => p.im_renglon_id).filter(Boolean));
  return [...app, ...pendientesDeIM(items).filter(p => !p.im_renglon_id || !pasados.has(p.im_renglon_id))];
}

function deFila(f: any): Pendiente {
  return {
    id: String(f.id), im_renglon_id: f.im_renglon_id ?? null,
    cod_articulo: f.cod_articulo != null ? Number(f.cod_articulo) : null,
    descripcion: String(f.descripcion), cantidad: Number(f.cantidad),
    factura_ref: f.factura_ref ?? null, origen: 'app',
    creado_por: f.creado_por ?? null, created_at: f.created_at ?? null,
  };
}

/**
 * Lo guardado en la app para estos presupuestos.
 * @returns `null` si falta la migración 055: quien llama sigue como antes, sin pendientes de la app.
 * @throws ErrorPendientes si la base no contesta. "No pude leer" no es "no tiene".
 */
export async function leerPendientes(ids: string[]): Promise<Map<string, Pendiente[]> | null> {
  const porPresupuesto = new Map<string, Pendiente[]>();
  const unicos = [...new Set(ids.map(String))].filter(Boolean);
  for (let i = 0; i < unicos.length; i += 200) {
    const { data, error } = await sb().from('pendientes_entrega')
      .select('id, im_comprobante_id, im_renglon_id, cod_articulo, descripcion, cantidad, factura_ref, orden, creado_por, created_at')
      .eq('tenant_id', TENANT_ID).in('im_comprobante_id', unicos.slice(i, i + 200)).order('orden');
    if (error) {
      if (faltaMigracion(error)) return null;
      throw new ErrorPendientes(`No pude leer los pendientes de entrega: ${error.message}`);
    }
    for (const f of data ?? []) {
      const k = String((f as any).im_comprobante_id);
      porPresupuesto.set(k, [...(porPresupuesto.get(k) ?? []), deFila(f)]);
    }
  }
  return porPresupuesto;
}

/** Lo que manda la pantalla, validado. Devuelve el motivo del rechazo en vez de corregir solo. */
export function validarPendientes(entrada: unknown): { ok: true; lista: Pendiente[] } | { ok: false; error: string } {
  if (!Array.isArray(entrada)) return { ok: false, error: 'Los pendientes tienen que venir como lista.' };
  if (entrada.length > 50) return { ok: false, error: 'Son demasiados pendientes para un pedido (máximo 50).' };
  const lista: Pendiente[] = [];
  for (const x of entrada as any[]) {
    const descripcion = typeof x?.descripcion === 'string' ? x.descripcion.replace(/\s+/g, ' ').trim() : '';
    const cantidad = Number(x?.cantidad);
    const cod = x?.cod_articulo == null || x?.cod_articulo === '' ? null : Number(x.cod_articulo);
    const ref = typeof x?.factura_ref === 'string' ? x.factura_ref.replace(/\s+/g, ' ').trim() : '';
    if (!descripcion || descripcion.length > 200) return { ok: false, error: 'Cada pendiente tiene que decir qué es (hasta 200 letras).' };
    if (!Number.isFinite(cantidad) || cantidad <= 0 || cantidad > 1e9) return { ok: false, error: `"${descripcion}": la cantidad tiene que ser mayor que cero.` };
    if (cod != null && !(Number.isInteger(cod) && cod > 0)) return { ok: false, error: `"${descripcion}": el artículo no es válido.` };
    if (ref.length > 60) return { ok: false, error: `"${descripcion}": la referencia de la factura es demasiado larga.` };
    lista.push({
      id: typeof x?.id === 'string' && x.id ? x.id : null,
      im_renglon_id: x?.im_renglon_id != null && /^\d+$/.test(String(x.im_renglon_id)) ? String(x.im_renglon_id) : null,
      cod_articulo: cod, descripcion, cantidad: Math.round(cantidad * 1000) / 1000,
      factura_ref: ref || null, origen: x?.origen === 'im' ? 'im' : 'app',
    });
  }
  return { ok: true, lista };
}

/** Para comparar dos listas: qué, cuánto y de dónde, en orden. */
export function firmaPendientes(ps: Pendiente[]): string {
  return ps.map(p => `${p.cod_articulo ?? ''}|${p.descripcion}|${p.cantidad}|${p.factura_ref ?? ''}|${p.im_renglon_id ?? ''}`).join('·');
}

/**
 * Deja en `destino` EXACTAMENTE esta lista (y nada en `origen`, si se rehízo el presupuesto). Una
 * sola transacción en la base: o queda todo o no cambia nada (ver migración 055).
 *
 * Quién cargó cada uno y cuándo salen de las filas que ya había, no de lo que manda la pantalla.
 */
export async function guardarPendientes(destino: string, origen: string, lista: Pendiente[], anteriores: Pendiente[], usuario: string | null): Promise<void> {
  const previo = new Map(anteriores.filter(p => p.id).map(p => [String(p.id), p]));
  const filas = lista.map(p => {
    const antes = p.id ? previo.get(String(p.id)) : undefined;
    return {
      descripcion: p.descripcion, cantidad: p.cantidad, cod_articulo: p.cod_articulo,
      factura_ref: p.factura_ref, im_renglon_id: p.im_renglon_id ?? antes?.im_renglon_id ?? null,
      creado_por: antes?.creado_por ?? null, created_at: antes?.created_at ?? null,
    };
  });
  const usuarioValido = usuario && /^[0-9a-f-]{36}$/i.test(usuario) ? usuario : null;
  const { error } = await sb().rpc('guardar_pendientes_entrega', {
    p_tenant: TENANT_ID, p_destino: destino, p_origen: origen, p_lista: filas, p_usuario: usuarioValido,
  });
  if (error) {
    if (faltaMigracion(error)) throw new ErrorPendientes(`${MSJ_FALTA_MIGRACION}. No se cambió nada.`, 503, true);
    throw new ErrorPendientes(`No pude guardar los pendientes de entrega: ${error.message}`);
  }
}

/**
 * Pasa a la app los renglones a mano en $0 que siguen escritos en el presupuesto. Se usa al
 * FACTURAR: la factura y el remito salen sin ellos —la API no los acepta— y desde acá los leen el
 * remito impreso y la hoja de ruta. Repetirlo no duplica nada (índice único por renglón de IM).
 *
 * @returns cuántos había para pasar, o el motivo si no se pudo. Falta de migración = 0 y sin error:
 *          es el comportamiento de antes, no una falla nueva.
 */
export async function pasarPendientesDeIM(idPresupuesto: string, items: any[], usuario: string | null): Promise<{ pasados: number; error?: string }> {
  const deIM = pendientesDeIM(items).filter(p => p.im_renglon_id);
  if (!deIM.length) return { pasados: 0 };
  const usuarioValido = usuario && /^[0-9a-f-]{36}$/i.test(usuario) ? usuario : null;
  const { error } = await sb().from('pendientes_entrega').upsert(deIM.map((p, i) => ({
    tenant_id: TENANT_ID, im_comprobante_id: String(idPresupuesto), im_renglon_id: p.im_renglon_id,
    cod_articulo: null, descripcion: p.descripcion.slice(0, 200), cantidad: p.cantidad,
    // Después de lo cargado en la app: es el orden en que se los ve en el panel.
    orden: 1000 + i, creado_por: usuarioValido,
  })), { onConflict: 'tenant_id,im_comprobante_id,im_renglon_id', ignoreDuplicates: true });
  if (error) {
    if (faltaMigracion(error)) return { pasados: 0 };
    return { pasados: 0, error: error.message };
  }
  return { pasados: deIM.length };
}

/**
 * Cuánto suman al camión. Con artículo se pesa con su equivalencia del catálogo; sin artículo
 * (el texto que venía de IM) cuenta el bulto pero no los kilos, y queda como "sin peso".
 */
export function pesoDePendientes(ps: Pendiente[], cat: Map<number, any>): Peso {
  return pesoDeRenglones(ps.map(p => ({
    cantidad: p.cantidad,
    equivalencia_um: p.cod_articulo != null ? cat.get(Number(p.cod_articulo))?.equivalencia_um : null,
  })));
}

/** Lo que el papel y la pantalla necesitan: qué, cuánto y de qué factura. */
export function pendientesParaMostrar(ps: Pendiente[]) {
  return ps.map(p => ({
    id: p.id ?? null, im_renglon_id: p.im_renglon_id, cod_articulo: p.cod_articulo,
    descripcion: p.descripcion, cantidad: p.cantidad, factura_ref: p.factura_ref, origen: p.origen,
  }));
}
