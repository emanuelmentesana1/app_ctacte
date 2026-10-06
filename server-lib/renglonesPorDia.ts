import { createHash } from 'node:crypto';

/**
 * ⏱️ 06/10/2026 — "ACTUALIZAR" LIVIANO (punto 6, sí de Mati vía el Integrador).
 *
 * Jorgelina factura con el rango de una semana y aprieta Actualizar cada uno o dos minutos. Medido
 * en producción el 06/10: 8 a 13 s por carga, y de eso ~7 s son los renglones de cada día del
 * rango (`/ventas/items`, ~1 s por día) que se volvían a pedir ENTEROS aunque el día no hubiera
 * cambiado. El listado de `/ventas`, que sí hay que releer, son ~2 s.
 *
 * La regla: los renglones de un día se reusan mientras el LISTADO de ese día sea idéntico al de la
 * vez que se leyeron. Un pedido nuevo, una factura o un remito emitidos, un comprobante anulado, una
 * fecha movida o un total editado cambian el listado del día, y ese día se relee entero. Verificado
 * en producción: todos los renglones de un día son de comprobantes del listado de ese mismo día.
 *
 * 🪤 Lo que NO se ve en el listado es una edición en InfoManager que deja el total igual (cambiar un
 * artículo por otro del mismo precio). Por eso:
 *  · lo guardado vence a los 10 minutos aunque el listado no cambie;
 *  · si al facturar o editar la versión del presupuesto no coincide (`exigirHuella`), se olvida todo
 *    y el Actualizar siguiente relee de cero;
 *  · los que editan presupuestos desde la app lo olvidan al terminar.
 * Facturar no corre riesgo: emite con una lectura puntual del presupuesto bajo lock, no con esto.
 */

/** Cuánto puede durar un día guardado aunque su listado no cambie. */
const VIGENCIA_MS = 10 * 60_000;
/** Un día de Casa Central son ~4 MB de renglones: diez días alcanzan para el rango de una semana. */
const MAXIMO_DIAS = 10;

/** La firma del listado de un día: cualquier cambio en una fila de ese día la cambia. */
export function firmaDelDia(ventas: any[], dia: string): string {
  const filas = ventas
    .filter(v => String(v?.fecha ?? '').slice(0, 10) === dia)
    .map(v => JSON.stringify(Object.keys(v).sort().map(k => [k, v[k]])))
    .sort();
  return createHash('sha256').update(filas.join('\n')).digest('hex');
}

export class RenglonesFirmados<T> {
  private generacion = 0;
  private dias = new Map<string, { firma: string; at: number; dato: T }>();
  constructor(private vigenciaMs = VIGENCIA_MS, private maximo = MAXIMO_DIAS, private ahora = () => Date.now()) {}

  olvidar() { this.generacion++; this.dias.clear(); }

  /** Los renglones del día: los guardados si el listado no cambió, o una lectura nueva. */
  async obtener(dia: string, firma: string, leer: () => Promise<T>): Promise<T> {
    const guardado = this.dias.get(dia);
    if (guardado && guardado.firma === firma && this.ahora() - guardado.at < this.vigenciaMs) return guardado.dato;
    const generacion = this.generacion;
    const at = this.ahora();
    const dato = await leer();
    // Una lectura que empezó antes de un `olvidar()` no vuelve a guardar lo que se quiso tirar.
    if (generacion === this.generacion) {
      this.dias.delete(dia);
      if (this.dias.size >= this.maximo) this.dias.delete(this.dias.keys().next().value!);
      this.dias.set(dia, { firma, at, dato });
    }
    return dato;
  }
}

/** El de todo el proceso. Lo usa `renglonesDelDia` (infomanager.ts). */
export const renglonesFirmados = new RenglonesFirmados<any>();
export function olvidarRenglonesFirmados() { renglonesFirmados.olvidar(); }
