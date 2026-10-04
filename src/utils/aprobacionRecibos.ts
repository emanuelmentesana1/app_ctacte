/**
 * Lógica pura de la aprobación de recibos (pantalla de Anto). Sin React ni fetch: se testea sola.
 */

/** Lo mínimo de una factura pendiente de IM (`/reportes/comprob_pendientes_clientes`). */
export interface FacturaParaImputar {
    id: number | string;
    fecha_factura?: string;
    numero?: number | string;
    saldo?: number;
    importe_factura?: number;
    tipo_comprobante?: string;
}

const centavos = (n: number) => Math.round(n * 100) / 100;

/**
 * Propone a qué facturas imputar un pago: **la deuda más vieja primero** (Mati, 04/10/2026:
 * *"se imputa primero a la deuda más vieja, casi siempre"*).
 *
 * · Sólo deudas: una nota de crédito llega con saldo negativo y no es algo que se cobre.
 * · Si el pago supera la deuda, se toma todo y la diferencia queda a la vista: la pantalla ya
 *   bloquea aprobar con diferencia y ofrece marcarlo como anticipo. Acá no se inventa nada.
 * · Sin fecha va al final: no se puede afirmar que sea la más vieja.
 */
export function preseleccionFIFO(facturas: FacturaParaImputar[], monto: number): Record<string, number> {
    let resto = centavos(Number(monto) || 0);
    if (!(resto > 0)) return {};
    const deudas = facturas
        .map(f => ({ f, saldo: centavos(Number(f.saldo ?? f.importe_factura ?? 0)) }))
        .filter(x => x.saldo > 0)
        .sort((a, b) => {
            const fa = a.f.fecha_factura ?? '9999-12-31';
            const fb = b.f.fecha_factura ?? '9999-12-31';
            if (fa !== fb) return fa < fb ? -1 : 1;
            const na = Number(a.f.numero), nb = Number(b.f.numero);
            if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
            return String(a.f.id).localeCompare(String(b.f.id));
        });
    const elegidas: Record<string, number> = {};
    for (const { f, saldo } of deudas) {
        if (!(resto > 0)) break;
        const toma = centavos(Math.min(saldo, resto));
        elegidas[String(f.id)] = toma;
        resto = centavos(resto - toma);
    }
    return elegidas;
}

/**
 * El próximo recibo a revisar después de resolver uno. Sigue el orden de la lista que se estaba
 * mirando (con sus filtros), saltea lo que ya se resolvió en esta tanda y, si el actual era el
 * último, vuelve al primero que siga pendiente. `null` = no queda nada: se vuelve a la lista.
 */
export function siguienteEnCola(cola: string[], actual: string, resueltos: Set<string>): string | null {
    const pendiente = (id: string) => id !== actual && !resueltos.has(id);
    const desde = cola.indexOf(actual);
    if (desde >= 0) {
        const despues = cola.slice(desde + 1).find(pendiente);
        if (despues) return despues;
    }
    return cola.find(pendiente) ?? null;
}
