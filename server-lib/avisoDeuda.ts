/**
 * Aviso diario de deuda en Slack: los clientes con deuda de 15 días o más.
 *
 * Pedido de Manolo (01/10/2026). Lo arma la propia app, con los mismos datos que la pestaña
 * Cobranza, y lo publica en #semillero-avisos por un webhook de Slack, de lunes a sábado a las
 * 7:58 (ver el cron en server.ts). Así los datos no salen de la empresa y el aviso no depende del
 * asistente personal de nadie.
 *
 * 🔑 LA CUENTA ES LA DE LA PANTALLA, AL PIE DE LA LETRA (src/components/VendorShell.tsx,
 * `clientsAggAll` / `clientsAgg`). Si alguien la cambia allá, hay que cambiarla acá:
 *
 *  - Un comprobante con saldo de $2.000 o menos (en más o en menos) no cuenta: son ajustes y
 *    redondeos que ensucian la antigüedad (UMBRAL_SALDO_FACTURA).
 *  - Se agrupa por cliente y se suma el saldo: NC y recibos restan.
 *  - Los días del cliente son los del comprobante DEUDOR (saldo > 0) más viejo.
 *  - Es deudor si el saldo neto pasa los $2.000.
 *  - Vendedores: los activos, que es lo que la pantalla tilda la primera vez.
 *
 * 🪤 El chip "+15d" de la pantalla cuenta MÁS de 15 días. El aviso es de 15 O MÁS, como lo pidió
 * Manolo, así que trae además los que están justo en 15.
 */

/** El mismo umbral de la pantalla (UMBRAL_SALDO_FACTURA en VendorShell.tsx). */
export const UMBRAL_SALDO = 2000;

/** Tope de clientes en el mensaje. Si hay más, el resto está en la pestaña Cobranza. */
const MAX_CLIENTES = 60;

export type ClienteDeudor = {
    cod: string;
    nombre: string;
    localidad: string;
    vendedor: string;
    saldo: number;
    dias: number;
    comprobantes: number;
};

/** Los comprobantes de los vendedores elegidos. Mismo filtro que `?cods=` en /api/data. */
export function deVendedores(invoices: any[], cods: Set<string>): any[] {
    return invoices.filter((inv) => cods.has(String(inv.COD_VENDED)));
}

/** Todos los deudores, como la pestaña Cobranza: del más atrasado al más reciente. */
export function deudoresDeCobranza(invoices: any[], clientDbMap: Record<string, any> = {}): ClienteDeudor[] {
    const porCliente = new Map<string, ClienteDeudor & { diasVendedor: number }>();
    for (const inv of invoices) {
        const cod = inv.COD_CLIENT ? String(inv.COD_CLIENT) : '';
        if (!cod) continue;
        const saldo = Number(inv.SALDO) || 0;
        if (Math.abs(saldo) <= UMBRAL_SALDO) continue;

        let c = porCliente.get(cod);
        if (!c) {
            c = {
                cod,
                nombre: String(inv.CLIENTES_N ?? '').trim(),
                localidad: clientDbMap[cod]?.Localidad ?? '',
                vendedor: '',
                saldo: 0,
                dias: 0,
                comprobantes: 0,
                diasVendedor: -1,
            };
            porCliente.set(cod, c);
        }
        c.saldo += saldo;
        c.comprobantes++;
        const dias = Number(inv.DIAS_EMISI) || 0;
        if (saldo > 0 && dias > c.dias) c.dias = dias;
        // El vendedor del comprobante deudor más viejo: es el que tiene que ir a cobrar.
        if (saldo > 0 && dias > c.diasVendedor && inv.VENDEDORES) {
            c.diasVendedor = dias;
            c.vendedor = String(inv.VENDEDORES).trim();
        }
    }
    return [...porCliente.values()]
        .filter((c) => c.saldo > UMBRAL_SALDO)
        .map(({ diasVendedor: _omitido, ...c }) => c)
        .sort((a, b) => b.dias - a.dias || b.saldo - a.saldo);
}

export type ResultadoAviso = {
    /** AAAA-MM-DD, hoy en Argentina. */
    fecha: string;
    minimo: number;
    /** Todos los deudores (lo que la pantalla llama "para cobrar"). */
    totalDeudores: number;
    atrasados: ClienteDeudor[];
    /** La app sirvió un cache vencido porque InfoManager no respondió. */
    viejoMin?: number;
    /** Los datos NO son de InfoManager (fallback de Sheets): no se publica la lista. */
    noConfiable?: string;
};

const pesos = (v: number) => `$ ${Math.round(v).toLocaleString('es-AR')}`;

/** "vie 02/10" a partir de "2026-10-02". */
export function fechaCorta(fecha: string): string {
    const [a, m, d] = fecha.split('-');
    const dia = new Intl.DateTimeFormat('es-AR', { weekday: 'short', timeZone: 'UTC' })
        .format(new Date(Date.UTC(+a, +m - 1, +d)))
        .replace('.', '');
    return `${dia} ${d}/${m}`;
}

/** El texto del aviso, con el formato de Slack (mrkdwn). */
export function formatearAvisoDeuda(r: ResultadoAviso): string {
    const lineas = [`*Deuda de ${r.minimo} días o más · ${fechaCorta(r.fecha)}*`];

    // Una lista armada con datos que no son los de InfoManager es peor que ninguna: alguien
    // podría salir a cobrarle a quien ya pagó.
    if (r.noConfiable) {
        lineas.push(`Hoy no publico la lista: la app no pudo leer las cuentas de InfoManager (${r.noConfiable}). Revisá la pestaña Cobranza más tarde.`);
        return lineas.join('\n');
    }
    if (r.viejoMin !== undefined) {
        lineas.push(`_Ojo: InfoManager no respondió; los saldos son de hace ${r.viejoMin} min._`);
    }
    if (r.atrasados.length === 0) {
        lineas.push(`Ningún cliente con ${r.minimo} días o más (de ${r.totalDeudores} con saldo para cobrar).`);
        return lineas.join('\n');
    }

    const total = r.atrasados.reduce((s, c) => s + c.saldo, 0);
    lineas.push(`*${r.atrasados.length} clientes* · ${pesos(total)} · de ${r.totalDeudores} con saldo para cobrar`);

    // Agrupado por vendedor: cada uno ve de un vistazo a quién tiene que ir a cobrar.
    const mostrados = r.atrasados.slice(0, MAX_CLIENTES);
    const vendedorDe = (c: ClienteDeudor) => c.vendedor || 'Sin vendedor';
    for (const v of [...new Set(mostrados.map(vendedorDe))]) {
        const suyos = mostrados.filter((c) => vendedorDe(c) === v);
        const suma = suyos.reduce((s, c) => s + c.saldo, 0);
        lineas.push('', `_${v}_ · ${suyos.length} · ${pesos(suma)}`);
        for (const c of suyos) {
            const donde = [c.cod, c.localidad].filter(Boolean).join(' · ');
            const comp = c.comprobantes === 1 ? '1 comprob.' : `${c.comprobantes} comprob.`;
            lineas.push(`- *${c.dias} d* ${c.nombre} (${donde}) · ${pesos(c.saldo)} · ${comp}`);
        }
    }
    if (r.atrasados.length > MAX_CLIENTES) {
        lineas.push('', `…y ${r.atrasados.length - MAX_CLIENTES} clientes más. El detalle está en la pestaña Cobranza.`);
    }
    lineas.push(
        '',
        '_Pestaña Cobranza, vendedores activos. Días = el comprobante impago más viejo; no cuentan saldos de $ 2.000 o menos._',
    );
    return lineas.join('\n');
}

export type DatosCobranza = {
    invoices: any[];
    clientDbMap: Record<string, any>;
    source: 'infomanager' | 'sheets';
    stale?: boolean;
    staleMin?: number;
    degraded?: string;
};

/**
 * Arma el aviso. Recibe de dónde sacar los datos para poder probarlo sin InfoManager ni Supabase:
 * en server.ts son `fetchData` (el mismo cache de /api/data, que el pre-warm mantiene caliente,
 * así que no suma llamadas a InfoManager) y `codsVendedoresActivos` (la lista de /api/goals).
 */
export async function armarAvisoDeuda(deps: {
    datos: () => Promise<DatosCobranza>;
    codsActivos: () => Promise<Set<string>>;
    hoy: string;
    minimo: number;
}): Promise<ResultadoAviso> {
    const [d, cods] = await Promise.all([deps.datos(), deps.codsActivos()]);
    const base = { fecha: deps.hoy, minimo: deps.minimo };

    if (d.degraded || d.source !== 'infomanager') {
        return { ...base, totalDeudores: 0, atrasados: [], noConfiable: d.degraded || `fuente ${d.source}` };
    }
    if (cods.size === 0) throw new Error('No hay vendedores activos: no sé de quién armar la lista.');

    const todos = deudoresDeCobranza(deVendedores(d.invoices, cods), d.clientDbMap);
    return {
        ...base,
        totalDeudores: todos.length,
        atrasados: todos.filter((c) => c.dias >= deps.minimo),
        viejoMin: d.stale ? d.staleMin ?? 0 : undefined,
    };
}

/**
 * Publica en Slack por un Incoming Webhook. La URL del webhook ES la credencial (quien la tiene
 * puede escribir en el canal): va solo en la variable de entorno SLACK_WEBHOOK_AVISOS.
 */
export async function publicarEnSlack(webhook: string, texto: string, fetchImpl: typeof fetch = fetch): Promise<void> {
    const res = await fetchImpl(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: texto }),
        signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
        const cuerpo = await res.text().catch(() => '');
        throw new Error(`Slack respondió ${res.status}${cuerpo ? `: ${cuerpo.slice(0, 120)}` : ''}`);
    }
}
