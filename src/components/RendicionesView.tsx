import { useEffect, useMemo, useState } from 'react';
import { Loader2, AlertTriangle, RefreshCw, Banknote, CheckCircle2, Info } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import { useLecturaVigente } from '../utils/useLecturaVigente';
import './RendicionesView.css';

/**
 * LA RENDICIÓN DE LAS HOJAS — etapa 1, SÓLO LECTURA (Mati aprobó el diseño el 04/10/2026).
 *
 * Muestra, por hoja y por cliente, lo cobrado contra lo entregado con lo que YA está cargado:
 * recibos de efectivo en InfoManager (Caja Repartos), transferencias en la app, notas de crédito
 * y gastos del viaje. Y si la caja del día cuadra con el asiento que pasó la plata a Caja Casa
 * Central. No emite, no cierra y no aprueba nada: eso llega en las etapas siguientes.
 *
 * Regla de avisos de la oficina (Mati, 04/10/2026): un aviso visible por pantalla, primero lo que
 * frena; lo informativo va a un ⓘ, con una línea corta y el detalle en el `title`.
 */

type Estado = 'pago' | 'parcial' | 'de_mas' | 'sin_cobro';
interface Fila {
    cod_cliente: number; cliente: string; llevo: number; nc: number; nd: number; entregado: number; saldo_anterior: number;
    efectivo: number; recibos_efectivo: { id_recibo: string; numero: string | null; fecha: string; importe: number }[];
    transferencias: { id: string; monto: number; medio: string | null; status: string; fecha: string; quien: string | null; nombre: string | null }[];
    cobrado: number; queda: number; estado: Estado; compartido: boolean;
}
interface Gasto { id: string; fecha: string; importe: number; descripcion: string }
interface Hoja {
    id: string; numero: number; fecha: string; estado: string; chofer: string | null; nombre: string | null;
    fecha_efectiva: string; fecha_corrida: boolean; filas: Fila[]; gastos: Gasto[];
    totales: { clientes: number; llevo: number; nc: number; entregado: number; efectivo: number; transferencias: number; cobrado: number; gastos: number; debe_entregar: number; sin_cobro: number; parcial: number; de_mas: number };
    asiento_id: string | null;
}
interface Asiento {
    id: string; fecha: string; descripcion: string; hojas: number[]; hojas_fuera: number[]; entregado: number;
    cobrado_efectivo: number; cobrado_fuera_de_hoja: number; gastos: number; otros_pagos: Gasto[];
    diferencia_calculada: number; diferencia_registrada: number | null; cuadra: boolean | null;
}
interface FueraDeHoja { fecha: string; total: number; recibos: { id_recibo: string; numero: string | null; fecha: string; cod_cliente: number; cliente: string | null; importe: number }[] }
interface Respuesta { desde: string; hasta: string; hojas: Hoja[]; asientos: Asiento[]; fuera_de_hoja: FueraDeHoja[]; consultado: { im_recibos: boolean; im_mayor: boolean } }

const money = (n: number) => (n < 0 ? '−$' : '$') + Math.round(Math.abs(n)).toLocaleString('es-AR');
const ddmm = (iso: string) => iso.slice(0, 10).split('-').reverse().slice(0, 2).join('/');
const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const diaLargo = (iso: string) => `${DIAS[new Date(`${iso}T12:00:00Z`).getUTCDay()]} ${ddmm(iso)}`;
const ESTADO: Record<Estado, { texto: string; clase: string }> = {
    pago: { texto: 'Pagó', clase: 'ok' },
    parcial: { texto: 'Pagó parte', clase: 'ambar' },
    de_mas: { texto: 'Pagó de más', clase: 'verde' },
    sin_cobro: { texto: 'Sin cobro', clase: 'rojo' },
};

export function RendicionesView({ desde, hasta }: { desde: string; hasta: string }) {
    const [datos, setDatos] = useState<Respuesta | null>(null);
    const [cargando, setCargando] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [abierta, setAbierta] = useState<string | null>(null);
    const [refrescar, setRefrescar] = useState(0);

    /**
     * 🔴 Nunca pintar los números de un rango bajo el rótulo de otro (mismo cuidado que la
     * Liquidación): se limpia antes de pedir y se descarta la respuesta si el rango cambió.
     */
    const { iniciar } = useLecturaVigente(`${desde}|${hasta}|${refrescar}`);
    useEffect(() => {
        const lectura = iniciar(); if (!lectura) return;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) { setCargando(false); return; }
        setCargando(true); setError(null); setDatos(null);
        (async () => {
            try {
                const qs = new URLSearchParams({ desde, hasta });
                if (refrescar) qs.set('refrescar', '1');
                const r = await fetch(`/api/rendiciones?${qs}`, { headers: authHeaders(), signal: lectura.signal });
                const d = await r.json().catch(() => null);
                if (!lectura.vigente()) return;
                if (!r.ok || !d?.ok) throw new Error(d?.error ?? 'No se pudo traer la rendición');
                if (d.desde !== desde || d.hasta !== hasta) return;
                setDatos(d); lectura.confirmar();
            } catch (e) {
                if (lectura.vigente()) setError(e instanceof Error ? e.message : 'Error de conexión');
            } finally {
                if (lectura.vigente()) setCargando(false);
            }
        })();
    }, [desde, hasta, refrescar, iniciar]);

    /** Por día de rendición (la fecha efectiva de la hoja), en orden. */
    const dias = useMemo(() => {
        const porDia = new Map<string, Hoja[]>();
        for (const h of datos?.hojas ?? []) porDia.set(h.fecha_efectiva, [...(porDia.get(h.fecha_efectiva) ?? []), h]);
        const asientoPorId = new Map((datos?.asientos ?? []).map(a => [a.id, a]));
        return [...porDia.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([fecha, hojas]) => ({
            fecha, hojas,
            asientos: [...new Set(hojas.map(h => h.asiento_id).filter((x): x is string => !!x))].map(id => asientoPorId.get(id)).filter((a): a is Asiento => !!a),
            fuera: datos?.fuera_de_hoja.find(f => f.fecha === fecha) ?? null,
        }));
    }, [datos]);

    const total = useMemo(() => {
        const hs = datos?.hojas ?? [];
        const s = (k: keyof Hoja['totales']) => hs.reduce((acc, h) => acc + (h.totales[k] ?? 0), 0);
        return { hojas: hs.length, entregado: s('entregado'), efectivo: s('efectivo'), transferencias: s('transferencias'), sin_cobro: s('sin_cobro') };
    }, [datos]);

    return (
        <div className="rd-root">
            <div className="rd-top">
                <span className="rd-info" title="Muestra lo que ya está cargado: los recibos de efectivo y el libro mayor de Caja Repartos en InfoManager, y las transferencias de la app. No emite, no cierra y no aprueba nada.">
                    <Info size={13} /> Sólo lectura
                </span>
                {cargando && <Loader2 size={16} className="rd-girando" />}
                <button className="rd-btn ghost" onClick={() => setRefrescar(n => n + 1)} disabled={cargando} title="Vuelve a consultar InfoManager">
                    <RefreshCw size={14} /> Actualizar
                </button>
            </div>

            {error && <div className="rd-aviso error"><AlertTriangle size={14} /> {error}</div>}
            {datos && !datos.consultado.im_mayor && (
                <div className="rd-aviso"><AlertTriangle size={14} /> No pude leer el libro mayor de Caja Repartos: faltan los gastos del viaje y el cuadre con IM.</div>
            )}

            {datos && total.hojas > 0 && (
                <div className="rd-totales">
                    <div><span>Hojas</span><b>{total.hojas}</b></div>
                    <div><span>Entregado</span><b>{money(total.entregado)}</b></div>
                    <div><span>Efectivo</span><b>{money(total.efectivo)}</b></div>
                    <div><span>Transferencias</span><b>{money(total.transferencias)}</b></div>
                    <div><span>Clientes sin cobro</span><b>{total.sin_cobro}</b></div>
                </div>
            )}

            {datos && !total.hojas && !cargando && (
                <div className="rd-vacio"><Banknote size={26} /><span>No hay hojas de ruta en este rango.</span></div>
            )}

            {dias.map(d => (
                <section className="rd-dia-grupo" key={d.fecha}>
                    <div className="rd-dia">
                        <div className="rd-dia-titulo">
                            <b>{diaLargo(d.fecha)}</b>
                            <span className="rd-gris">{d.hojas.length} {d.hojas.length === 1 ? 'hoja' : 'hojas'}</span>
                            {!d.asientos.length && <span className="rd-chip gris">Sin rendir en IM todavía</span>}
                            {d.fuera && (
                                <span className="rd-info rd-fuera"
                                    title={`Cobros a clientes que no estaban en ninguna hoja del día. Entran en la caja del día y en el cuadre del asiento:\n${d.fuera.recibos.map(r => `· ${r.cliente ?? `Cliente ${r.cod_cliente}`} — recibo ${r.numero ?? r.id_recibo} — ${money(r.importe)}`).join('\n')}`}>
                                    <Info size={13} /> Fuera de hoja: {money(d.fuera.total)} ({d.fuera.recibos.length} {d.fuera.recibos.length === 1 ? 'cobro' : 'cobros'})
                                </span>
                            )}
                        </div>
                        {d.asientos.map(a => <ResumenAsiento key={a.id} a={a} />)}
                    </div>

                    {d.hojas.map(h => (
                        <TarjetaHoja key={h.id} h={h} abierta={abierta === h.id} onToggle={() => setAbierta(x => x === h.id ? null : h.id)} />
                    ))}
                </section>
            ))}
        </div>
    );
}

/** La cuenta del asiento, para el ⓘ: cobrado − gastos − otros pagos → entregado ± diferencia. */
function detalleAsiento(a: Asiento): string {
    const otros = a.otros_pagos.reduce((s, o) => s + o.importe, 0);
    const lineas = [
        `Cobrado en efectivo (Caja Repartos): ${money(a.cobrado_efectivo)}${a.cobrado_fuera_de_hoja ? `, ${money(a.cobrado_fuera_de_hoja)} de clientes fuera de hoja` : ''}`,
        a.gastos ? `− Gastos del viaje: ${money(a.gastos)}` : '',
        otros ? `− Otros pagos con esa caja: ${money(otros)} (${a.otros_pagos.map(o => o.descripcion.replace(/^\s*Caja Repartos -\s*/i, '')).join(' · ')})` : '',
        `→ Entregado a Caja Casa Central: ${money(a.entregado)}`,
        `Diferencia calculada: ${money(a.diferencia_calculada)}`,
        a.diferencia_registrada != null ? `Diferencia de caja registrada en IM: ${money(a.diferencia_registrada)}` : 'Sin asiento de diferencia de caja ese día',
    ];
    return lineas.filter(Boolean).join('\n');
}

function ResumenAsiento({ a }: { a: Asiento }) {
    const descuadre = a.diferencia_calculada + (a.diferencia_registrada ?? 0);
    return (
        <div className={`rd-asiento ${a.cuadra === true ? 'ok' : a.cuadra === false ? 'mal' : ''}`}>
            <span className="rd-asiento-estado">
                {a.cuadra === true && <><CheckCircle2 size={14} /> Cuadra con IM</>}
                {a.cuadra === false && <><AlertTriangle size={14} /> No cuadra por {money(Math.abs(descuadre))}</>}
                {a.cuadra === null && <>Asiento con hojas fuera de este rango ({a.hojas_fuera.join(', ')})</>}
            </span>
            <span className="rd-info" title={detalleAsiento(a)}>
                <Info size={13} /> Asiento del {ddmm(a.fecha)} · hojas {a.hojas.join(', ')}
            </span>
        </div>
    );
}

function TarjetaHoja({ h, abierta, onToggle }: { h: Hoja; abierta: boolean; onToggle: () => void }) {
    const t = h.totales;
    return (
        <div className={`rd-hoja${abierta ? ' abierta' : ''}`}>
            <div className="rd-hoja-head" onClick={onToggle} role="button" aria-expanded={abierta}>
                <div className="rd-hoja-titulo">
                    <b>Hoja {h.numero}</b>
                    {h.nombre && <span className="rd-gris">· {h.nombre}</span>}
                    <span>· {h.chofer ?? 'Sin chofer'}</span>
                    {h.estado === 'cerrada' && <span className="rd-chip gris">cerrada</span>}
                    {h.fecha_corrida && <span className="rd-chip ambar" title={`La hoja dice ${ddmm(h.fecha)}, pero sus recibos son del ${ddmm(h.fecha_efectiva)}`}>fecha corrida: se rindió el {ddmm(h.fecha_efectiva)}</span>}
                </div>
                <div className="rd-cifras">
                    <span>Entregado <b>{money(t.entregado)}</b></span>
                    <span>Efectivo <b>{money(t.efectivo)}</b></span>
                    <span>Transf. <b>{money(t.transferencias)}</b></span>
                    {t.gastos > 0 && <span>Gastos <b>{money(-t.gastos)}</b></span>}
                    <span>Debe entregar <b>{money(t.debe_entregar)}</b></span>
                </div>
                <div className="rd-estados">
                    {t.sin_cobro > 0 && <span className="rd-chip rojo">{t.sin_cobro} sin cobro</span>}
                    {t.parcial > 0 && <span className="rd-chip ambar">{t.parcial} pagó parte</span>}
                    {t.de_mas > 0 && <span className="rd-chip verde">{t.de_mas} pagó de más</span>}
                </div>
            </div>

            {abierta && (
                <div className="rd-detalle">
                    <div className="rd-tabla">
                        <div className="rd-fila rd-encabezado">
                            <span>Cliente</span><span>Llevó</span><span>NC</span><span>Saldo ant.</span>
                            <span>Efectivo</span><span>Transf.</span><span>Queda</span><span>Estado</span>
                        </div>
                        {h.filas.map(f => (
                            <div className="rd-fila" key={f.cod_cliente}>
                                <span className="rd-cliente" data-l="Cliente">{f.cliente}<small> #{f.cod_cliente}{f.compartido ? ' · también en otra hoja' : ''}</small></span>
                                <span data-l="Llevó">{money(f.llevo)}</span>
                                <span data-l="NC">{f.nc ? money(-f.nc) : '—'}</span>
                                <span data-l="Saldo ant.">{f.saldo_anterior ? money(f.saldo_anterior) : '—'}</span>
                                <span data-l="Efectivo" title={f.recibos_efectivo.map(r => `Recibo ${r.numero ?? r.id_recibo}`).join(', ')}>{f.efectivo ? money(f.efectivo) : '—'}</span>
                                <span data-l="Transf." title={f.transferencias.map(x => `${x.nombre ?? x.quien ?? ''} · ${x.status}`).join(', ')}>
                                    {f.transferencias.length ? money(f.transferencias.reduce((s, x) => s + x.monto, 0)) : '—'}
                                    {f.transferencias.some(x => x.status === 'pendiente_revision') && <small> (en revisión)</small>}
                                </span>
                                <span data-l="Queda" className={f.queda < 0 ? 'rd-a-favor' : ''}>{money(f.queda)}</span>
                                <span data-l="Estado"><span className={`rd-chip ${ESTADO[f.estado].clase}`}>{ESTADO[f.estado].texto}</span></span>
                            </div>
                        ))}
                    </div>
                    {h.gastos.length > 0 && (
                        <div className="rd-gastos">
                            <b>Gastos del viaje (órdenes de pago "según HR {h.numero}")</b>
                            <ul>{h.gastos.map(g => <li key={g.id}>{g.descripcion.replace(/^\s*Caja Repartos -\s*/i, '')} · {money(g.importe)}</li>)}</ul>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
