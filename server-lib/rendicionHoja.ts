/**
 * LA RENDICIÓN DE LAS HOJAS DE RUTA — lógica PURA (sin Supabase ni IM), etapa 1: sólo lectura.
 *
 * Mati (03/10/2026): *"cuando el camión vuelve, la oficina hace A MANO los recibos de todo lo que
 * cobraron los choferes"* y quiere que *"la hoja se cierre recién con lo cobrado"*. Antes de que la
 * app emita nada, esta etapa MUESTRA cómo quedó cada hoja con lo que ya está cargado.
 *
 * Cómo se rinde hoy (medido en IM, septiembre 2026):
 *  · El efectivo lo carga Anto al día siguiente, un recibo por cliente, en Caja Repartos (1110009)
 *    y con la FECHA DE LA HOJA (349 de los recibos caen el mismo día de la hoja del cliente).
 *  · Cada gasto del viaje es una orden de pago con el texto "según HR nnnn".
 *  · Un asiento por día pasa la plata a Caja Casa Central y lleva los números de hoja en la
 *    descripción ("3421,3422-AS"); otro asiento chico registra la diferencia de caja.
 *  · La cuenta  cobrado − gastos − entregado = diferencia  cerró en los 16 asientos del mes.
 */

export interface PedidoIn {
    im_comprobante_id: string;
    cod_cliente: number;
    cliente_nombre?: string | null;
    total: number;
    saldo_anterior?: number | null;
    /** Notas de crédito / débito ya vinculadas a la entrega (journal + panel). */
    notas?: Array<{ tipo?: unknown; total?: unknown }>;
    /** Marcada «No salió» en la hoja (migración 057, `entregaNoSalio`): no cuenta, ni sus notas. */
    no_salio?: boolean;
}
export interface HojaIn {
    id: string;
    numero: number;
    fecha: string;
    estado: string;
    chofer: string | null;
    nombre?: string | null;
    pedidos: PedidoIn[];
}
export interface ReciboIMIn {
    id_recibo: number | string;
    numero?: string | null;
    fecha: string;
    cliente: { codigo: string | number; razon_social?: string | null };
    importe_total: number;
    items?: Array<{ tipo_pago?: string; importe?: number; cuenta_contable?: string | number | null }>;
}
export interface MovMayorIn {
    id: number | string;
    fecha: string;
    tipo_comprobante: string;
    descripcion?: string | null;
    debe: number;
    haber: number;
}
export interface TransferenciaIn {
    id: string;
    cod_cliente: number;
    monto: number;
    medio_pago: string | null;
    status: string;
    fecha_comprobante: string | null;
    created_at: string;
    created_by_rol?: string | null;
    created_by_nombre?: string | null;
}

export type EstadoCobro = 'pago' | 'entrega' | 'deuda_vieja' | 'parcial' | 'de_mas' | 'sin_cobro' | 'no_salio';

export interface FilaRendicion {
    cod_cliente: number;
    cliente: string;
    llevo: number;
    nc: number;
    nd: number;
    entregado: number;
    saldo_anterior: number;
    efectivo: number;
    recibos_efectivo: Array<{ id_recibo: string; numero: string | null; fecha: string; importe: number }>;
    transferencias: Array<{ id: string; monto: number; medio: string | null; status: string; fecha: string; quien: string | null; nombre: string | null }>;
    cobrado: number;
    /** Lo que sigue debiendo: saldo anterior + entregado − cobrado. Negativo = pagó de más. */
    queda: number;
    estado: EstadoCobro;
    /** El cliente estaba en otra hoja del mismo día: el cobro se cuenta en una sola. */
    compartido: boolean;
    /** Remitos del cliente en esta hoja marcados «No salió». */
    no_salieron: number;
}

export interface GastoHoja { id: string; fecha: string; importe: number; descripcion: string }

export interface HojaRendicion {
    id: string;
    numero: number;
    fecha: string;
    estado: string;
    chofer: string | null;
    nombre: string | null;
    /**
     * El día en que se rindió. Es la fecha de la hoja salvo que esté corrida: pasó con la 3402 y la
     * 3431, fechadas un día distinto del reparto (ningún recibo de sus clientes en su fecha, varios
     * en la de al lado).
     */
    fecha_efectiva: string;
    fecha_corrida: boolean;
    filas: FilaRendicion[];
    gastos: GastoHoja[];
    totales: {
        clientes: number; llevo: number; nc: number; entregado: number;
        efectivo: number; transferencias: number; cobrado: number; gastos: number;
        /** Lo que el chofer tendría que haber entregado en efectivo: cobrado en efectivo − gastos. */
        debe_entregar: number;
        sin_cobro: number; parcial: number; de_mas: number; no_salio: number;
    };
    /** El asiento de IM que pasó el efectivo de esta hoja a Caja Casa Central, si ya existe. */
    asiento_id: string | null;
}

export interface AsientoRendicion {
    id: string;
    fecha: string;
    descripcion: string;
    hojas: number[];
    /** Hojas del asiento que no están en lo que se pidió: sin ellas no se puede decir si cuadra. */
    hojas_fuera: number[];
    entregado: number;
    /** TODO el efectivo de Caja Repartos de las fechas del asiento: así rinde la oficina. */
    cobrado_efectivo: number;
    /** La parte de eso que cobraron a clientes que no estaban en ninguna hoja del día. */
    cobrado_fuera_de_hoja: number;
    gastos: number;
    /**
     * Pagos hechos con la caja del reparto que no son de ninguna hoja (OP sin "HR"): un proveedor
     * pagado con esa plata (el 14 y el 15/09: NUTRINOA y BURBUJAS). Salen de la misma caja.
     */
    otros_pagos: GastoHoja[];
    /** cobrado − gastos − otros pagos − entregado. */
    diferencia_calculada: number;
    /** El asiento "diferencia de caja" del mismo día (debe − haber), si hay. */
    diferencia_registrada: number | null;
    cuadra: boolean | null;
}

export interface CobroFueraDeHoja {
    fecha: string;
    total: number;
    recibos: Array<{ id_recibo: string; numero: string | null; fecha: string; cod_cliente: number; cliente: string | null; importe: number }>;
}

export interface EntradaRendicion {
    hojas: HojaIn[];
    recibosIM: ReciboIMIn[];
    mayor: MovMayorIn[];
    transferencias: TransferenciaIn[];
    /** Caja Repartos en el plan de IM. */
    cuentaCaja: string;
}

const centavos = (n: number) => Math.round(n * 100) / 100;
const diaUTC = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
const sumarDias = (s: string, n: number) => new Date(diaUTC(s) + n * 86_400_000).toISOString().slice(0, 10);
const esTipo = (t: unknown, pref: string) => String(t ?? '').toUpperCase().startsWith(pref);
/** "pagó lo mismo" admite el redondeo de IM: máx($1; 1%). */
const tolerancia = (entregado: number) => Math.max(1, Math.abs(entregado) * 0.01);
/** Los números de hoja que aparecen en un texto ("segun hr 3424", "3421,3422-AS"). */
const numerosEn = (texto: string) => [...texto.matchAll(/\b(\d{4})\b/g)].map(m => Number(m[1]));

/**
 * 🔄 06/10/2026 (Mati, hoja 3449): el estado mira lo que el cliente DEBÍA, que es el saldo anterior más lo
 * entregado ese día (las dos columnas del papel). Antes comparaba sólo contra la entrega, y pagar deuda
 * vieja (en efectivo o por transferencia) salía "Pagó de más".
 */
function estadoDe(entregado: number, cobrado: number, saldoAnterior: number): EstadoCobro {
    if (!(cobrado > 0.005)) return 'sin_cobro';
    const total = entregado + saldoAnterior;
    if (cobrado > total + tolerancia(total)) return 'de_mas';
    if (Math.abs(cobrado - total) <= tolerancia(total)) return 'pago';
    if (saldoAnterior > 1 && Math.abs(cobrado - entregado) <= tolerancia(entregado)) return 'entrega';
    if (saldoAnterior > 1 && Math.abs(cobrado - saldoAnterior) <= tolerancia(saldoAnterior)) return 'deuda_vieja';
    return 'parcial';
}

export function armarRendiciones(e: EntradaRendicion): { hojas: HojaRendicion[]; asientos: AsientoRendicion[]; fuera_de_hoja: CobroFueraDeHoja[] } {
    const hojas = [...e.hojas].sort((a, b) => (a.fecha === b.fecha ? a.numero - b.numero : a.fecha < b.fecha ? -1 : 1));

    // ── Efectivo: recibos de IM con cobro a Caja Repartos ───────────────────────────────────────
    const efectivoDe = (r: ReciboIMIn) => centavos((r.items ?? [])
        .filter(i => String(i.cuenta_contable ?? '') === e.cuentaCaja)
        .reduce((s, i) => s + (Number(i.importe) || 0), 0));
    const recibosCaja = e.recibosIM.filter(r => efectivoDe(r) > 0);
    const recibosDe = new Map<string, ReciboIMIn[]>();   // fecha|cliente
    for (const r of recibosCaja) {
        const k = `${String(r.fecha).slice(0, 10)}|${Number(r.cliente?.codigo)}`;
        recibosDe.set(k, [...(recibosDe.get(k) ?? []), r]);
    }

    // 🪤 Hoja con la fecha corrida (la 3402 y la 3431 en septiembre): ningún recibo de sus clientes en
    // su fecha y al menos dos en el día de al lado ⇒ se rindió ese otro día y se corre ENTERA. Por
    // cliente no: un cobro suelto de otro día es de la rendición de ese día y movido descuadra dos.
    const clientesDelDia = new Map<string, Set<number>>();
    for (const h of hojas) {
        const set = clientesDelDia.get(h.fecha) ?? new Set<number>();
        h.pedidos.forEach(p => set.add(Number(p.cod_cliente)));
        clientesDelDia.set(h.fecha, set);
    }
    const fechaEfectiva = new Map<string, string>();
    for (const h of hojas) {
        const cods = [...new Set(h.pedidos.map(p => Number(p.cod_cliente)))];
        const enSuDia = cods.filter(c => recibosDe.has(`${h.fecha}|${c}`)).length;
        let elegida = h.fecha;
        if (enSuDia === 0) {
            const vecinos = [-1, 1].map(n => {
                const f = sumarDias(h.fecha, n);
                const ajenos = clientesDelDia.get(f) ?? new Set<number>();
                return { f, n: cods.filter(c => !ajenos.has(c) && recibosDe.has(`${f}|${c}`)).length };
            }).filter(v => v.n >= 2).sort((a, b) => b.n - a.n);
            if (vecinos.length && (vecinos.length === 1 || vecinos[0].n > vecinos[1].n)) elegida = vecinos[0].f;
        }
        fechaEfectiva.set(h.id, elegida);
    }
    const fechaDe = (h: HojaIn) => fechaEfectiva.get(h.id) ?? h.fecha;

    // Qué hojas tiene cada cliente cada día: decide a qué hoja va un cobro (una sola).
    const hojasDelCliente = new Map<string, HojaIn[]>();
    for (const h of hojas) {
        for (const cod of new Set(h.pedidos.map(p => Number(p.cod_cliente)))) {
            const k = `${fechaDe(h)}|${cod}`;
            hojasDelCliente.set(k, [...(hojasDelCliente.get(k) ?? []), h]);
        }
    }
    for (const lista of hojasDelCliente.values()) lista.sort((a, b) => a.numero - b.numero);
    const duenaDe = (fecha: string, cod: number) => hojasDelCliente.get(`${fecha}|${cod}`)?.[0];

    const asignados = new Map<string, ReciboIMIn[]>();   // hoja|cliente
    const fuera = new Map<string, ReciboIMIn[]>();       // fecha
    const fechasConHoja = new Set(hojas.map(fechaDe));
    for (const r of recibosCaja) {
        const fecha = String(r.fecha).slice(0, 10);
        const cod = Number(r.cliente?.codigo);
        const h = duenaDe(fecha, cod);
        if (h) {
            const k = `${h.id}|${cod}`;
            asignados.set(k, [...(asignados.get(k) ?? []), r]);
        } else if (fechasConHoja.has(fecha)) {
            fuera.set(fecha, [...(fuera.get(fecha) ?? []), r]);
        }
    }

    // ── Transferencias cargadas en la app (chofer o vendedor), el día de la hoja o el siguiente ──
    const transfPorHoja = new Map<string, TransferenciaIn[]>();
    for (const t of e.transferencias) {
        if (t.status === 'rechazado' || t.medio_pago === 'efectivo') continue;
        const fecha = (t.fecha_comprobante || t.created_at || '').slice(0, 10);
        const cod = Number(t.cod_cliente);
        const h = duenaDe(fecha, cod) ?? duenaDe(sumarDias(fecha, -1), cod);
        if (!h) continue;
        const k = `${h.id}|${cod}`;
        transfPorHoja.set(k, [...(transfPorHoja.get(k) ?? []), t]);
    }

    // ── Gastos del viaje: OP "según HR nnnn". Sin HR ni número de hoja: "otro pago" de esa caja ──
    const numerosDeHojas = new Set(hojas.map(h => h.numero));
    const gastosPorNumero = new Map<number, GastoHoja[]>();
    const otrosPagos: GastoHoja[] = [];
    for (const m of e.mayor) {
        if (m.tipo_comprobante !== 'OP') continue;
        const desc = String(m.descripcion ?? '');
        const gasto = { id: String(m.id), fecha: String(m.fecha).slice(0, 10), importe: centavos((Number(m.haber) || 0) - (Number(m.debe) || 0)), descripcion: desc.trim() };
        const hr = desc.match(/h\.?\s*r\.?\s*(\d{4})\b/i);
        const numero = hr ? Number(hr[1]) : numerosEn(desc).find(n => numerosDeHojas.has(n));
        if (numero) gastosPorNumero.set(numero, [...(gastosPorNumero.get(numero) ?? []), gasto]);
        else otrosPagos.push(gasto);
    }

    // ── Asientos de rendición: "3421,3422-AS" ───────────────────────────────────────────────────
    // "3421,3422-AS". 🪤 A veces con una aclaración a mano: "3402,3403 (3400 y 3401 NO EXTEN)-AS" — lo
    // que está entre paréntesis no son hojas del asiento.
    const asientosIM = e.mayor
        .filter(m => m.tipo_comprobante === 'AS' && /^\s*\d{4}\b.*-\s*AS\s*$/i.test(String(m.descripcion ?? '')))
        .map(m => ({ m, numeros: numerosEn(String(m.descripcion ?? '').replace(/\(.*$/, '').replace(/-\s*AS\s*$/i, '')) }));
    const asientoDeHoja = new Map<number, string>();
    for (const { m, numeros } of asientosIM) for (const n of numeros) if (!asientoDeHoja.has(n)) asientoDeHoja.set(n, String(m.id));

    const salida: HojaRendicion[] = hojas.map(h => {
        const porCliente = new Map<number, PedidoIn[]>();
        for (const p of h.pedidos) porCliente.set(Number(p.cod_cliente), [...(porCliente.get(Number(p.cod_cliente)) ?? []), p]);
        const filas: FilaRendicion[] = [...porCliente.entries()].map(([cod, ps]) => {
            // 🔄 05/10/2026: lo marcado «No salió» no cuenta, ni sus notas: igual que en la Liquidación.
            const salieron = ps.filter(p => !p.no_salio);
            const llevo = centavos(salieron.reduce((s, p) => s + (Number(p.total) || 0), 0));
            const notas = salieron.flatMap(p => p.notas ?? []);
            const nc = centavos(notas.filter(n => esTipo(n.tipo, 'NC')).reduce((s, n) => s + Math.abs(Number(n.total) || 0), 0));
            // La factura complementaria (opción C, 06/10/2026) sube lo entregado, como una ND.
            // Mismo criterio que la Liquidación (/^(nd|fa\b)/), para que las dos den el mismo entregado.
            const nd = centavos(notas.filter(n => esTipo(n.tipo, 'ND') || /^fa\b/i.test(String(n.tipo ?? ''))).reduce((s, n) => s + Math.abs(Number(n.total) || 0), 0));
            const entregado = centavos(llevo - nc + nd);
            const recibos = asignados.get(`${h.id}|${cod}`) ?? [];
            const efectivo = centavos(recibos.reduce((s, r) => s + efectivoDe(r), 0));
            const transf = transfPorHoja.get(`${h.id}|${cod}`) ?? [];
            const transferencias = centavos(transf.reduce((s, t) => s + (Number(t.monto) || 0), 0));
            const cobrado = centavos(efectivo + transferencias);
            // El saldo anterior es del CLIENTE, no del comprobante: con dos remitos no se suma dos veces.
            const saldo = ps.find(p => p.saldo_anterior != null)?.saldo_anterior;
            const saldoAnterior = centavos(Number(saldo ?? 0));
            return {
                cod_cliente: cod,
                cliente: ps.find(p => p.cliente_nombre)?.cliente_nombre ?? `Cliente ${cod}`,
                llevo, nc, nd, entregado,
                saldo_anterior: saldoAnterior,
                efectivo,
                recibos_efectivo: recibos.map(r => ({ id_recibo: String(r.id_recibo), numero: r.numero ?? null, fecha: String(r.fecha).slice(0, 10), importe: efectivoDe(r) })),
                transferencias: transf.map(t => ({ id: t.id, monto: Number(t.monto) || 0, medio: t.medio_pago, status: t.status, fecha: (t.fecha_comprobante || t.created_at || '').slice(0, 10), quien: t.created_by_rol ?? null, nombre: t.created_by_nombre ?? null })),
                cobrado,
                queda: centavos(saldoAnterior + entregado - cobrado),
                // Si nada de lo suyo salió y no pagó, no es un "sin cobro": no hubo entrega.
                estado: !salieron.length && !(cobrado > 0.005) ? 'no_salio' : estadoDe(entregado, cobrado, saldoAnterior),
                compartido: (hojasDelCliente.get(`${fechaDe(h)}|${cod}`)?.length ?? 0) > 1,
                no_salieron: ps.length - salieron.length,
            };
        });
        const gastos = gastosPorNumero.get(h.numero) ?? [];
        const suma = (k: keyof FilaRendicion) => centavos(filas.reduce((s, f) => s + (Number(f[k]) || 0), 0));
        const efectivo = suma('efectivo');
        const totalGastos = centavos(gastos.reduce((s, g) => s + g.importe, 0));
        return {
            id: h.id, numero: h.numero, fecha: h.fecha, estado: h.estado, chofer: h.chofer, nombre: h.nombre ?? null,
            fecha_efectiva: fechaDe(h), fecha_corrida: fechaDe(h) !== h.fecha,
            filas, gastos,
            totales: {
                clientes: filas.length, llevo: suma('llevo'), nc: suma('nc'), entregado: suma('entregado'),
                efectivo, transferencias: centavos(suma('cobrado') - efectivo), cobrado: suma('cobrado'),
                gastos: totalGastos, debe_entregar: centavos(efectivo - totalGastos),
                sin_cobro: filas.filter(f => f.estado === 'sin_cobro').length,
                parcial: filas.filter(f => f.estado === 'parcial').length,
                de_mas: filas.filter(f => f.estado === 'de_mas').length,
                no_salio: filas.filter(f => f.estado === 'no_salio').length,
            },
            asiento_id: asientoDeHoja.get(h.numero) ?? null,
        };
    });

    const porNumero = new Map(salida.map(h => [h.numero, h]));
    const diferenciasDelDia = new Map<string, number>();
    for (const m of e.mayor) {
        if (m.tipo_comprobante !== 'AS' || !/difer/i.test(String(m.descripcion ?? ''))) continue;
        const f = String(m.fecha).slice(0, 10);
        diferenciasDelDia.set(f, centavos((diferenciasDelDia.get(f) ?? 0) + (Number(m.debe) || 0) - (Number(m.haber) || 0)));
    }
    // 🔑 La oficina rinde POR DÍA: todo el efectivo de Caja Repartos de la fecha de las hojas entra
    // en el asiento, aunque sea de un cliente que no estaba en ninguna hoja (en septiembre: un cobro
    // de $2,1M el 19/09 y dos por $1,45M el 23/09). Con eso, la cuenta cerró en los 16 asientos.
    const cajaDelDia = new Map<string, number>();
    for (const r of recibosCaja) {
        const f = String(r.fecha).slice(0, 10);
        cajaDelDia.set(f, centavos((cajaDelDia.get(f) ?? 0) + efectivoDe(r)));
    }
    const fueraDelDia = new Map([...fuera.entries()].map(([f, rs]) => [f, centavos(rs.reduce((s, r) => s + efectivoDe(r), 0))]));
    const conHojas = asientosIM.filter(({ numeros }) => numeros.some(n => porNumero.has(n)));
    const fechasDe = (numeros: number[]) => [...new Set(numeros.map(n => porNumero.get(n)?.fecha_efectiva).filter((f): f is string => !!f))];
    // Una fecha rendida en dos asientos no se puede repartir: ahí no se afirma nada.
    const vecesPorFecha = new Map<string, number>();
    for (const { numeros } of conHojas) for (const f of fechasDe(numeros)) vecesPorFecha.set(f, (vecesPorFecha.get(f) ?? 0) + 1);

    const asientos: AsientoRendicion[] = conHojas.map(({ m, numeros }) => {
        const presentes = numeros.map(n => porNumero.get(n)).filter((h): h is HojaRendicion => !!h);
        const ausentes = numeros.filter(n => !porNumero.has(n));
        const fechas = fechasDe(numeros);
        const entregado = centavos((Number(m.haber) || 0) - (Number(m.debe) || 0));
        const cobrado = centavos(fechas.reduce((s, f) => s + (cajaDelDia.get(f) ?? 0), 0));
        const cobradoFuera = centavos(fechas.reduce((s, f) => s + (fueraDelDia.get(f) ?? 0), 0));
        const gastos = centavos(presentes.reduce((s, h) => s + h.totales.gastos, 0));
        // Una OP "según HR" de una hoja que el propio asiento menciona y no es del panel (la oficina
        // escribió "3400 y 3401 NO EXTEN") también salió de esta caja en esta rendición.
        const mencionadas = numerosEn(String(m.descripcion ?? '')).filter(n => !porNumero.has(n));
        const otros = [...otrosPagos.filter(o => fechas.includes(o.fecha)), ...mencionadas.flatMap(n => gastosPorNumero.get(n) ?? [])];
        const calculada = centavos(cobrado - gastos - otros.reduce((s, o) => s + o.importe, 0) - entregado);
        const fecha = String(m.fecha).slice(0, 10);
        const registrada = diferenciasDelDia.has(fecha) ? diferenciasDelDia.get(fecha)! : null;
        const repartida = fechas.some(f => (vecesPorFecha.get(f) ?? 0) > 1);
        return {
            id: String(m.id), fecha, descripcion: String(m.descripcion ?? '').trim(), hojas: numeros, hojas_fuera: ausentes,
            entregado, cobrado_efectivo: cobrado, cobrado_fuera_de_hoja: cobradoFuera, gastos, otros_pagos: otros,
            diferencia_calculada: calculada, diferencia_registrada: registrada,
            cuadra: ausentes.length || repartida ? null : Math.abs(calculada + (registrada ?? 0)) < 1,
        };
    });

    const fuera_de_hoja: CobroFueraDeHoja[] = [...fuera.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([fecha, rs]) => ({
            fecha,
            total: fueraDelDia.get(fecha) ?? 0,
            recibos: rs.map(r => ({ id_recibo: String(r.id_recibo), numero: r.numero ?? null, fecha, cod_cliente: Number(r.cliente?.codigo), cliente: r.cliente?.razon_social ?? null, importe: efectivoDe(r) })),
        }));
    return { hojas: salida, asientos, fuera_de_hoja };
}
