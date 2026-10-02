/**
 * 🔴 LAS FACTURAS QUE EMITIÓ LA APP, SÓLO LAS QUE HACEN FALTA.
 *
 * Mati (02/10/2026): *"aparecen en presupuestos muchos que ya están facturados... termina
 * confundiendo a Jo"*. El índice de facturas emitidas se pedía ENTERO y sin filtro, y la base
 * devuelve como mucho 1.000 filas por consulta: el 30/09 la tabla pasó las 1.000 (1.054 contra
 * 1.000, medido) y las facturas nuevas quedaron afuera. Las que emitió la app desde ese día salían
 * como "deducidas" ("FA B 51071 ?") y seguían en "Para facturar" (ISA, Cristian, PR 59298), y en
 * Facturar una factura de otro presupuesto podía frenar como "ya facturado" a un pedido repetido.
 *
 * Se pide por los dos lados que importan, de a tandas que nunca llegan al tope:
 *  · los presupuestos que se están mirando → su propia factura;
 *  · las facturas candidatas del rango → si ya están atadas a OTRO presupuesto, no pueden
 *    justificar a éste (ver `buscarFacturasYaEmitidas`).
 */
import { sb, TENANT_ID } from './supabase.js';

/** Ids por consulta: 200 entran holgados en la URL y devuelven muy por debajo de 1.000 filas. */
const TANDA = 200;
const COLUMNAS = 'im_comprobante_id, im_factura_id, im_factura_numero, im_factura_tipo';

export type FacturaNuestra = { im_factura_id: string | null; im_factura_numero: number | null; im_factura_tipo: string | null };

function enTandas(ids: Iterable<string | number>): string[][] {
  const unicos = [...new Set([...ids].map(String))].filter(Boolean);
  const tandas: string[][] = [];
  for (let i = 0; i < unicos.length; i += TANDA) tandas.push(unicos.slice(i, i + TANDA));
  return tandas;
}

/**
 * `im_comprobante_id` → la factura que le emitió la app, para estos presupuestos y para las
 * facturas dadas. 🔴 Tira si la base no contesta: "no pude preguntar" no es "no hay ninguna".
 */
export async function facturasEmitidasPorLaApp(
  idsPresupuestos: Iterable<string | number>, idsFacturas: Iterable<string | number>,
): Promise<Map<string, FacturaNuestra>> {
  const consultas = [
    ...enTandas(idsPresupuestos).map(t => sb().from('presupuestos_facturados').select(COLUMNAS)
      .eq('tenant_id', TENANT_ID).in('im_comprobante_id', t).not('im_factura_id', 'is', null)),
    ...enTandas(idsFacturas).map(t => sb().from('presupuestos_facturados').select(COLUMNAS)
      .eq('tenant_id', TENANT_ID).in('im_factura_id', t)),
  ];
  const tandas = await Promise.all(consultas.map(async q => {
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data ?? [];
  }));
  const nuestras = new Map<string, FacturaNuestra>();
  for (const n of tandas.flat() as any[]) {
    nuestras.set(String(n.im_comprobante_id), {
      im_factura_id: n.im_factura_id ?? null,
      im_factura_numero: n.im_factura_numero ?? null,
      im_factura_tipo: n.im_factura_tipo ?? null,
    });
  }
  return nuestras;
}
