import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, AlertTriangle, Lock, X } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import { MEDIOS_PAGO_UI } from '../utils/mediosPago';
import { ESTADO_COBRO, type EstadoCobro } from '../utils/estadoCobro';
import './ImprimirHoja.css';
import './HojaRendida.css';

/**
 * La hoja de ruta CON los recibos que impactan, y todo lo de su cierre (Mati, 06/10/2026, puntos 3 y 4 del piloto):
 * por cliente lo entregado, el saldo anterior, lo cobrado y lo que queda, y cada recibo con su número, su medio y a qué
 * facturas fue; abajo lo cobrado por medio, los gastos, lo que debía entregar, lo contado, la diferencia y quién contó
 * y quién controló.
 *
 * Es el mismo papel en los dos lugares: la pestaña «Con los recibos» de la impresión y el resumen de «Cerrar hoja».
 * Los datos salen de GET /api/rendiciones/hoja/:id/resumen, con la misma cuenta que Rendiciones.
 */
interface Recibo { medio: string; numero: string | null; fecha: string; importe: number; origen: 'app' | 'im' | 'pendiente' | 'otro'; facturas: Array<{ numero: string; importe: number }> | null }
interface ClienteResumen { cod_cliente: number; cliente: string; entregado: number; saldo_anterior: number; cobrado: number; queda: number; estado: EstadoCobro; no_salieron: number; recibos: Recibo[] }
export interface Resumen {
    hoja: { id: string; numero: number; fecha: string; estado: string; chofer: string | null; nombre: string | null };
    clientes: ClienteResumen[];
    totales: { entregado: number; cobrado: number; queda: number; por_medio: Record<string, number>; recibos: number; sin_detalle: number; pendientes: number };
    rendicion: null | {
        gastos: Array<{ concepto: string; importe: number; detalle: string | null }>; efectivo: number; total_gastos: number; debe_entregar: number;
        contado: number | null; diferencia: number | null; contado_por: string | null; contado_at: string | null; controlado_por: string | null; controlado_at: string | null;
    };
    gastos_im: Array<{ id: string; fecha: string; importe: number; descripcion: string }>;
    asiento_id: string | null;
}

const money = (n: number | null | undefined) =>
    n == null ? '—' : new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const fechaCorta = (iso: string) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');
const cuando = (iso: string | null) => (iso ? new Date(iso).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const medio = (m: string) => MEDIOS_PAGO_UI.find(x => x.value === m)?.label ?? m;

/** "a 777-50861 (125.000,00), 777-50999 (25.000,00)", o lo que se sabe cuando no hay detalle. */
function destino(r: Recibo) {
    if (r.facturas?.length) return `a ${r.facturas.map(f => `${f.numero} (${money(f.importe)})`).join(', ')}`;
    if (r.origen === 'im') return 'Cargado a mano en IM: sin el detalle de facturas';
    if (r.origen === 'pendiente') return 'Transferencia sin aprobar todavía';
    return 'Sin recibo en IM';
}

export function HojaRendida({ hojaId, onCargado }: { hojaId: string; onCargado?: (r: Resumen | null) => void }) {
    const [d, setD] = useState<Resumen | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const abort = new AbortController();
        setD(null); setError(null);
        fetch(`/api/rendiciones/hoja/${hojaId}/resumen`, { headers: authHeaders(), signal: abort.signal })
            .then(async r => {
                const j = await r.json().catch(() => null);
                if (!r.ok) throw new Error(j?.error ?? 'No se pudo armar el resumen de la hoja');
                if (!abort.signal.aborted) { setD(j); onCargado?.(j); }
            })
            .catch(e => { if (!abort.signal.aborted) { setError(e?.message ?? 'Error de conexión'); onCargado?.(null); } });
        return () => abort.abort();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `onCargado` sólo avisa: no es motivo para volver a pedir.
    }, [hojaId]);

    if (error) return <div className="imp-error"><AlertTriangle size={16} /> {error}</div>;
    if (!d) return <div className="imp-cargando"><Loader2 className="spin" size={22} /> Juntando los recibos de la hoja…</div>;
    const r = d.rendicion;

    return (
        <div className="imp-hoja hrd-hoja">
            <div className="imp-head">
                <div className="imp-head-marca">
                    <img src="/logo.svg" alt="" onError={e => { (e.target as HTMLImageElement).src = '/logo.png'; }} />
                    <div>
                        <div className="imp-empresa">Semillero El Manantial</div>
                        <div className="imp-doc">Hoja de ruta con los recibos{d.hoja.nombre ? <> · <b>{d.hoja.nombre}</b></> : null}</div>
                    </div>
                </div>
                <div className="imp-head-nro">
                    <div className="imp-nro">N° {d.hoja.numero}</div>
                    <div className="imp-fecha">{fechaCorta(d.hoja.fecha)}</div>
                </div>
            </div>

            <div className="imp-datos">
                <span><b>Chofer</b> {d.hoja.chofer || '—'}</span>
                <span><b>Clientes</b> {d.clientes.length}</span>
                <span><b>Entregado</b> {money(d.totales.entregado)}</span>
                <span><b>Cobrado</b> {money(d.totales.cobrado)}</span>
                <span><b>Recibos emitidos</b> {d.totales.recibos}</span>
            </div>

            <table className="imp-tabla">
                <thead>
                    <tr>
                        <th>Cliente</th><th className="n">Entregado</th><th className="n">Saldo anterior</th>
                        <th className="n">Cobrado</th><th className="n">Queda</th><th>Estado</th>
                    </tr>
                </thead>
                {/* Un tbody por cliente: no se parte entre dos páginas (igual que la hoja de ruta). */}
                {d.clientes.map(c => (
                    <tbody className="imp-grupo" key={c.cod_cliente}>
                        <tr>
                            <td><b>{c.cliente}</b></td>
                            <td className="n">{money(c.entregado)}</td>
                            <td className="n">{money(c.saldo_anterior)}</td>
                            <td className="n">{money(c.cobrado)}</td>
                            <td className="n">{money(c.queda)}</td>
                            <td>{ESTADO_COBRO[c.estado]?.texto ?? c.estado}{c.no_salieron > 0 ? ` · ${c.no_salieron} no salió` : ''}</td>
                        </tr>
                        {c.recibos.map((x, i) => (
                            <tr className="hrd-recibo" key={`${x.numero ?? 'sin'}-${i}`}>
                                <td colSpan={6}>
                                    <b>{x.numero ? `RC ${x.numero}` : 'Sin recibo'}</b> · {medio(x.medio)} · {money(x.importe)} · {destino(x)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                ))}
                <tfoot>
                    <tr>
                        <td>TOTAL · {d.clientes.length} clientes</td>
                        <td className="n">{money(d.totales.entregado)}</td>
                        <td className="n"></td>
                        <td className="n">{money(d.totales.cobrado)}</td>
                        <td className="n">{money(d.totales.queda)}</td>
                        <td></td>
                    </tr>
                </tfoot>
            </table>

            <div className="hrd-pie">
                <table className="imp-tabla hrd-cuentas">
                    <thead><tr><th colSpan={2}>Cobrado por medio</th></tr></thead>
                    <tbody>
                        {Object.entries(d.totales.por_medio).map(([m, imp]) => (
                            <tr key={m}><td>{medio(m)}</td><td className="n">{money(imp)}</td></tr>
                        ))}
                        {!Object.keys(d.totales.por_medio).length && <tr><td colSpan={2}>No hay cobros cargados.</td></tr>}
                    </tbody>
                </table>

                {r ? (
                    <table className="imp-tabla hrd-cuentas">
                        <thead><tr><th colSpan={2}>Rendición del efectivo</th></tr></thead>
                        <tbody>
                            <tr><td>Efectivo cobrado</td><td className="n">{money(r.efectivo)}</td></tr>
                            {r.gastos.map((g, i) => (
                                <tr key={i}><td>Gasto · {g.concepto}{g.detalle ? ` (${g.detalle})` : ''}</td><td className="n">−{money(g.importe)}</td></tr>
                            ))}
                            <tr className="hrd-fuerte"><td>Debía entregar</td><td className="n">{money(r.debe_entregar)}</td></tr>
                            <tr><td>Contado</td><td className="n">{money(r.contado)}</td></tr>
                            <tr className="hrd-fuerte"><td>Diferencia</td><td className="n">{money(r.diferencia)}</td></tr>
                            <tr><td>Contó</td><td>{r.contado_por ? `${r.contado_por} · ${cuando(r.contado_at)}` : 'Nadie todavía'}</td></tr>
                            <tr><td>Controló</td><td>{r.controlado_por ? `${r.controlado_por} · ${cuando(r.controlado_at)}` : 'Sin controlar'}</td></tr>
                        </tbody>
                    </table>
                ) : (
                    <table className="imp-tabla hrd-cuentas">
                        <thead><tr><th colSpan={2}>Rendición del efectivo</th></tr></thead>
                        <tbody>
                            <tr><td colSpan={2}>No se rindió en la app.{d.asiento_id ? ` Asiento de IM ${d.asiento_id}.` : ''}</td></tr>
                            {d.gastos_im.map(g => <tr key={g.id}><td>Gasto en IM · {g.descripcion}</td><td className="n">−{money(g.importe)}</td></tr>)}
                        </tbody>
                    </table>
                )}
            </div>

            {d.totales.sin_detalle > 0 && <p className="imp-nota">{d.totales.sin_detalle} recibo(s) cargado(s) a mano en IM: InfoManager no dice a qué facturas fueron.</p>}
            {d.totales.pendientes > 0 && <p className="imp-nota">{d.totales.pendientes} transferencia(s) sin aprobar todavía: cuentan en lo cobrado, pero no tienen recibo.</p>}
        </div>
    );
}

/**
 * «Cerrar hoja» (Mati, 06/10/2026): antes de cerrar se ve TODA la info de la hoja. No bloquea nada nuevo: si el resumen
 * no carga (IM sin contestar), la hoja se puede cerrar igual, como hasta hoy.
 */
export function CierreHoja({ hojaId, numero, chofer, onConfirmar, onCancelar }: {
    hojaId: string; numero: number; chofer: string | null; onConfirmar: () => void; onCancelar: () => void;
}) {
    return createPortal(
        <div className="imp-overlay hrd-cierre" role="dialog" aria-label={`Cerrar la hoja ${numero}`}>
            <div className="imp-toolbar">
                <span className="hrd-titulo"><Lock size={15} /> ¿Cerrar la hoja {numero}?</span>
                <button className="imp-btn hrd-cancelar" onClick={onCancelar}>Cancelar</button>
                <button className="imp-btn hrd-confirmar" onClick={onConfirmar}>Cerrar hoja</button>
                <button className="imp-cerrar" onClick={onCancelar} title="Cancelar"><X size={18} /></button>
            </div>
            <p className="hrd-aviso">Entra en la liquidación de {chofer ?? 'el chofer'} y ya no se le pueden agregar ni sacar pedidos.</p>
            <HojaRendida hojaId={hojaId} />
        </div>,
        document.body,
    );
}
