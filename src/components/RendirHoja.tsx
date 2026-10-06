import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, AlertTriangle, Info, Plus, X, Eye, Send, ShieldCheck } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import { CONCEPTOS_GASTO, cuentasDeLaRendicion, leerImporte, type ConceptoGasto, type GastoViaje, type LineaEfectivo } from '../utils/rendicionCuentas';
import { AvisoTemporal } from './AvisoTemporal';
import './RendirHoja.css';

/**
 * RENDIR EL EFECTIVO DE UNA HOJA EN LA APP — etapa 2 (diseño aprobado por Mati el 04/10/2026).
 *
 * La oficina copia del papel de la hoja lo cobrado en efectivo por cliente, anota los gastos del
 * viaje y lo contado. La app calcula la diferencia (no se descuenta: va al saldo del mes del
 * repartidor) y emite los recibos a Caja Repartos con el motor de Cobranzas.
 *
 * 🔴 La emisión arranca apagada: nada se escribe en IM sin el sí de Mati. Mientras tanto la vista
 * previa muestra a qué facturas iría cada recibo.
 */

/** Lo que trae la etapa 1 de cada hoja (lo justo para rendir). */
export interface FilaParaRendir {
    cod_cliente: number; cliente: string; entregado: number; saldo_anterior: number;
    recibos_efectivo: { id_recibo: string; numero: string | null; importe: number }[];
    transferencias: { monto: number }[];
}
export interface HojaParaRendir { id: string; numero: number; fecha: string; filas: FilaParaRendir[]; gastos: { id: string; importe: number; descripcion: string }[] }
/** Lo que se rindió en la app, como lo devuelve `/api/rendiciones` (sirve para el resumen del día). */
export interface RendicionApp { hoja_id: string; efectivo: LineaEfectivo[]; gastos: GastoViaje[]; efectivo_contado: number | null; diferencia: number | null; contado_at: string | null; controlado_at: string | null }

interface ReciboApp { id: string; cod_cliente: number; monto: number; status: string; infomanager_recibo_id: string | null; error_msg?: string | null }
interface Rendicion {
    efectivo: LineaEfectivo[]; gastos: GastoViaje[]; efectivo_contado: number | null; observaciones: string | null; version: number;
    contado_por: string | null; contado_at: string | null; controlado_por: string | null; controlado_at: string | null;
    lo_conto_quien_pregunta: boolean;
    cuentas: { efectivo: number; gastos: number; debe_entregar: number; contado: number | null; diferencia: number | null };
}
interface Detalle { ok: true; falta_migracion?: boolean; mensaje?: string; rendicion: Rendicion | null; recibos: ReciboApp[]; emision: { tope: number; cuenta: string; piloto?: number[] } }
interface Paso {
    cod_cliente: number; importe: number; estado: 'emitido' | 'listo' | 'salteado' | 'en_espera'; motivo?: string;
    comprobantes?: { id: string; importe_a_pagar: number; etiqueta?: string; fecha?: string | null }[]; recibo_im?: string | null;
    /** true = va a las facturas que eligió quien rinde; false = la más vieja primero. */
    elegida?: boolean;
    pendientes?: { id: string; etiqueta: string; fecha: string | null; saldo: number }[];
}
type Eleccion = Array<{ id: string; importe: number }>;
/** Hasta $5 lo absorbe el ajuste de IM (igual que el servidor). */
const TOLERANCIA = 5;
interface Resultado { cod_cliente: number; ok: boolean; recibo_id?: string | null; error?: string }
interface GastoEnPantalla { concepto: ConceptoGasto; importe: string; detalle: string }

const money = (n: number) => (n < 0 ? '−$' : '$') + Math.round(Math.abs(n)).toLocaleString('es-AR');
const ddmm = (iso: string) => iso.slice(0, 10).split('-').reverse().slice(0, 2).join('/');
const cuando = (iso: string | null) => (iso ? new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const aTexto = (n: number | null | undefined) => (n == null ? '' : String(n));

export function RendirHoja({ h, onGuardado }: { h: HojaParaRendir; onGuardado: (r: RendicionApp) => void }) {
    const [detalle, setDetalle] = useState<Detalle | null>(null);
    const [cargando, setCargando] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [listo, setListo] = useState<string | null>(null);
    const [efectivo, setEfectivo] = useState<Record<number, string>>({});
    /** A qué facturas va el recibo de cada cliente, si quien rinde la eligió (Mati, 06/10/2026). */
    const [elegidas, setElegidas] = useState<Record<number, Eleccion>>({});
    const [eligiendo, setEligiendo] = useState<number | null>(null);
    const [gastos, setGastos] = useState<GastoEnPantalla[]>([]);
    const [contado, setContado] = useState('');
    const [ocupado, setOcupado] = useState(false);
    const [plan, setPlan] = useState<Paso[] | null>(null);
    const [resultados, setResultados] = useState<{ lista: Resultado[]; frenado: boolean } | null>(null);

    /** Lo guardado pasa a la pantalla: lo que se ve arranca igual a lo que hay en la base. */
    const aplicar = useCallback((d: Detalle) => {
        setDetalle(d);
        const r = d.rendicion;
        setEfectivo(Object.fromEntries((r?.efectivo ?? []).map(l => [l.cod_cliente, aTexto(l.importe)])));
        setElegidas(Object.fromEntries((r?.efectivo ?? []).filter(l => l.facturas?.length).map(l => [l.cod_cliente, l.facturas as Eleccion])));
        setGastos((r?.gastos ?? []).map(g => ({ concepto: g.concepto, importe: aTexto(g.importe), detalle: g.detalle ?? '' })));
        setContado(aTexto(r?.efectivo_contado));
    }, []);

    const leer = useCallback(async () => {
        const r = await fetch(`/api/rendiciones/hoja/${h.id}`, { headers: authHeaders() });
        const d = await r.json().catch(() => null);
        if (!r.ok || !d?.ok) throw new Error(d?.error ?? 'No se pudo traer la rendición');
        return d as Detalle;
    }, [h.id]);

    useEffect(() => {
        let vigente = true;
        leer().then(d => { if (vigente) aplicar(d); })
            .catch(e => { if (vigente) setError(e instanceof Error ? e.message : 'Error de conexión'); })
            .finally(() => { if (vigente) setCargando(false); });
        return () => { vigente = false; };
    }, [leer, aplicar]);

    const reciboDe = (cod: number) => detalle?.recibos.find(r => r.cod_cliente === cod) ?? null;
    /**
     * Lo que no se tipea: el recibo que ya emitió la app, o el que Anto cargó a mano en IM (en ese
     * caso la app no lo emite de nuevo, pero el importe cuenta para la caja de la hoja).
     */
    const fijo = useCallback((f: FilaParaRendir): { importe: number; origen: 'app' | 'a_mano'; detalle: string } | null => {
        const app = detalle?.recibos.find(r => r.cod_cliente === f.cod_cliente);
        if (app?.status === 'imputado') return { importe: app.monto, origen: 'app', detalle: `Recibo ${app.infomanager_recibo_id ?? ''}` };
        const propios = new Set((detalle?.recibos ?? []).map(r => r.infomanager_recibo_id).filter(Boolean));
        const aMano = f.recibos_efectivo.filter(r => !propios.has(r.id_recibo));
        if (!aMano.length) return null;
        return { importe: aMano.reduce((s, r) => s + r.importe, 0), origen: 'a_mano', detalle: aMano.map(r => `Recibo ${r.numero ?? r.id_recibo}`).join(', ') };
    }, [detalle]);

    const lineas: LineaEfectivo[] = useMemo(() => h.filas.flatMap(f => {
        const importe = fijo(f)?.importe ?? leerImporte(efectivo[f.cod_cliente] ?? '') ?? 0;
        const facturas = elegidas[f.cod_cliente];
        if (!(importe > 0)) return [];
        return [facturas?.length ? { cod_cliente: f.cod_cliente, importe, facturas } : { cod_cliente: f.cod_cliente, importe }];
    }), [h.filas, efectivo, elegidas, fijo]);
    const gastosLeidos: GastoViaje[] = gastos.map(g => ({ concepto: g.concepto, importe: leerImporte(g.importe) ?? 0, detalle: g.detalle.trim() || null }));
    const contadoLeido = contado.trim() === '' ? null : leerImporte(contado);
    const cuentas = cuentasDeLaRendicion({ efectivo: lineas, gastos: gastosLeidos, efectivo_contado: contadoLeido });

    const r = detalle?.rendicion ?? null;
    const sinGuardar = JSON.stringify({ e: lineas, g: gastosLeidos, c: contadoLeido })
        !== JSON.stringify({ e: r?.efectivo ?? [], g: r?.gastos ?? [], c: r?.efectivo_contado ?? null });

    async function pedir(metodo: 'PUT' | 'POST', ruta: string, cuerpo: unknown) {
        const resp = await fetch(`/api/rendiciones/hoja/${h.id}${ruta}`, {
            method: metodo, headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
        });
        const d = await resp.json().catch(() => null);
        if (!resp.ok || !d?.ok) throw new Error(d?.error ?? `Error ${resp.status}`);
        return d;
    }
    const avisarArriba = (d: Detalle) => {
        if (d.rendicion) onGuardado({
            hoja_id: h.id, efectivo: d.rendicion.efectivo, gastos: d.rendicion.gastos, efectivo_contado: d.rendicion.efectivo_contado,
            diferencia: d.rendicion.cuentas.diferencia, contado_at: d.rendicion.contado_at, controlado_at: d.rendicion.controlado_at,
        });
    };
    async function correr(accion: () => Promise<void>) {
        setOcupado(true); setError(null);
        try { await accion(); } catch (e) { setError(e instanceof Error ? e.message : 'Error de conexión'); } finally { setOcupado(false); }
    }

    const guardar = () => correr(async () => {
        const d: Detalle = await pedir('PUT', '', { efectivo: lineas, gastos: gastosLeidos, efectivo_contado: contadoLeido, observaciones: r?.observaciones ?? null, version: r?.version });
        aplicar(d); avisarArriba(d); setPlan(null); setListo('Rendición guardada');
    });
    const vistaPrevia = () => correr(async () => {
        const d = await pedir('POST', '/emitir', { accion: 'plan' });
        setPlan(d.plan); setResultados(null);
    });
    const emitir = () => {
        const n = plan?.filter(p => p.estado === 'listo').length ?? 0;
        if (!window.confirm(`Se van a emitir ${n} recibos en InfoManager, a Caja Repartos, con fecha ${ddmm(h.fecha)}.\n\nEsta hoja deja de cargarse a mano en IM. ¿Seguir?`)) return;
        correr(async () => {
            const d = await pedir('POST', '/emitir', { accion: 'emitir' });
            setResultados({ lista: d.resultados ?? [], frenado: !!d.frenado }); setPlan(null);
            aplicar(await leer());
        });
    };
    const controlar = () => correr(async () => {
        const d: Detalle = await pedir('POST', '/controlar', { version: r?.version });
        aplicar(d); avisarArriba(d); setListo('Control registrado');
    });

    if (cargando) return <div className="rr-root rr-cargando"><Loader2 size={16} className="rd-girando" /> Cargando la rendición…</div>;
    if (detalle?.falta_migracion) return <div className="rr-root"><span className="rd-info" title={detalle.mensaje}><Info size={13} /> Rendir en la app todavía no está disponible</span></div>;

    const nombre = (cod: number) => h.filas.find(f => f.cod_cliente === cod)?.cliente ?? `Cliente ${cod}`;
    const emitidos = detalle?.recibos.filter(x => x.status === 'imputado').length ?? 0;
    const tope = detalle?.emision.tope ?? 0;
    const piloto = detalle?.emision.piloto ?? [];
    const listos = plan?.filter(p => p.estado === 'listo').length ?? 0;
    const gastosIM = h.gastos.reduce((s, g) => s + g.importe, 0);
    const puedeControlar = r?.efectivo_contado != null && !r.lo_conto_quien_pregunta && !r.controlado_por && !sinGuardar && !ocupado;

    return (
        <div className="rr-root">
            {/* Un aviso por pantalla (regla de la oficina, 04/10): primero el error; si no, lo que frena. */}
            {error
                ? <div className="rd-aviso error"><AlertTriangle size={14} /> {error}</div>
                : (emitidos > 0 || tope > 0) && <div className="rd-aviso"><AlertTriangle size={14} /> Esta hoja se rinde en la app: no cargues sus recibos de efectivo en IM.</div>}
            <AvisoTemporal texto={listo} onCerrar={() => setListo(null)} />

            <div className="rr-tabla">
                <div className="rr-fila rr-encabezado">
                    <span>Cliente</span><span>Entregado</span><span>Saldo ant.</span><span>Transf.</span><span>Efectivo</span><span>Recibo</span>
                </div>
                {h.filas.map(f => {
                    const fj = fijo(f);
                    const app = reciboDe(f.cod_cliente);
                    const transf = f.transferencias.reduce((s, t) => s + t.monto, 0);
                    return (
                        <div className="rr-fila" key={f.cod_cliente}>
                            <span className="rr-cliente" data-l="Cliente">{f.cliente}<small> #{f.cod_cliente}</small></span>
                            <span data-l="Entregado">{money(f.entregado)}</span>
                            <span data-l="Saldo ant.">{f.saldo_anterior ? money(f.saldo_anterior) : '—'}</span>
                            <span data-l="Transf.">{transf ? money(transf) : '—'}</span>
                            <span data-l="Efectivo">
                                {fj ? <b>{money(fj.importe)}</b> : (
                                    <input className="rr-input" inputMode="decimal" placeholder="0" aria-label={`Efectivo cobrado a ${f.cliente}`}
                                        value={efectivo[f.cod_cliente] ?? ''} disabled={ocupado}
                                        onChange={e => {
                                            const v = e.target.value;
                                            setEfectivo(x => ({ ...x, [f.cod_cliente]: v }));
                                            // Otro importe: la elección de facturas ya no suma lo cobrado.
                                            setElegidas(x => { const y = { ...x }; delete y[f.cod_cliente]; return y; });
                                        }} />
                                )}
                            </span>
                            <span data-l="Recibo" className="rr-recibo">
                                {fj?.origen === 'app' && <span className="rd-chip ok" title="Lo emitió la app">✓ {app?.infomanager_recibo_id}</span>}
                                {fj?.origen === 'a_mano' && <span className="rd-chip gris" title={fj.detalle}>a mano en IM</span>}
                                {!fj && app?.status === 'error' && <span className="rd-chip rojo" title={app.error_msg ?? ''}>no salió</span>}
                                {!fj && app?.status !== 'error' && '—'}
                            </span>
                        </div>
                    );
                })}
            </div>

            <div className="rr-gastos">
                <div className="rr-subtitulo">
                    <b>Gastos del viaje</b>
                    {h.gastos.length > 0 && (
                        <span className="rd-info" title={`Ya cargadas en IM:\n${h.gastos.map(g => `· ${g.descripcion.replace(/^\s*Caja Repartos -\s*/i, '')} — ${money(g.importe)}`).join('\n')}`}>
                            <Info size={13} /> En IM ya hay {h.gastos.length} {h.gastos.length === 1 ? 'orden de pago' : 'órdenes de pago'} de esta hoja por {money(gastosIM)}
                        </span>
                    )}
                </div>
                {gastos.map((g, i) => (
                    <div className="rr-gasto" key={i}>
                        <select aria-label="Concepto del gasto" value={g.concepto} disabled={ocupado}
                            onChange={e => { const v = e.target.value as ConceptoGasto; setGastos(gs => gs.map((x, j) => (j === i ? { ...x, concepto: v } : x))); }}>
                            {CONCEPTOS_GASTO.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <input className="rr-input" inputMode="decimal" placeholder="$" aria-label="Importe del gasto" value={g.importe} disabled={ocupado}
                            onChange={e => { const v = e.target.value; setGastos(gs => gs.map((x, j) => (j === i ? { ...x, importe: v } : x))); }} />
                        {g.concepto === 'Otro' && (
                            <input className="rr-detalle" placeholder="¿Qué fue?" aria-label="Detalle del gasto" value={g.detalle} disabled={ocupado}
                                onChange={e => { const v = e.target.value; setGastos(gs => gs.map((x, j) => (j === i ? { ...x, detalle: v } : x))); }} />
                        )}
                        <button type="button" className="rr-quitar" aria-label="Quitar gasto" disabled={ocupado} onClick={() => setGastos(gs => gs.filter((_, j) => j !== i))}><X size={14} /></button>
                    </div>
                ))}
                <button type="button" className="rd-btn ghost rr-agregar" disabled={ocupado} onClick={() => setGastos(gs => [...gs, { concepto: 'Ayudante', importe: '', detalle: '' }])}>
                    <Plus size={14} /> Agregar gasto
                </button>
            </div>

            <div className="rr-cuentas">
                <span>Efectivo <b>{money(cuentas.efectivo)}</b></span>
                <span>Gastos <b>{money(-cuentas.gastos)}</b></span>
                <span>Debe entregar <b>{money(cuentas.debe_entregar)}</b></span>
                <label>Contado
                    <input className="rr-input" inputMode="decimal" placeholder="sin contar" aria-label="Efectivo contado" value={contado} disabled={ocupado}
                        onChange={e => setContado(e.target.value)} />
                </label>
                {cuentas.diferencia != null && (
                    <span className={`rr-diferencia ${cuentas.diferencia < 0 ? 'falta' : cuentas.diferencia > 0 ? 'sobra' : 'justo'}`}>
                        Diferencia <b>{money(cuentas.diferencia)}</b> {cuentas.diferencia < 0 ? '(faltó)' : cuentas.diferencia > 0 ? '(sobró)' : '(justo)'}
                    </span>
                )}
            </div>

            <div className="rr-control">
                {r?.contado_por && <span className="rd-gris">Contó {r.contado_por} · {cuando(r.contado_at)}</span>}
                {r?.controlado_por
                    ? <span className="rr-controlado"><ShieldCheck size={14} /> Controló {r.controlado_por} · {cuando(r.controlado_at)}</span>
                    : (
                        <button type="button" className="rd-btn ghost rr-controlar" disabled={!puedeControlar} onClick={controlar}
                            title={r?.lo_conto_quien_pregunta ? 'Lo controla otra persona, no quien lo contó (lo cuenta Anto y lo controla Maca).' : 'Confirma que el efectivo contado está bien.'}>
                            <ShieldCheck size={14} /> Controlar
                        </button>
                    )}
            </div>

            <div className="rr-acciones">
                <button type="button" className="rd-btn rr-guardar" disabled={!sinGuardar || ocupado} onClick={guardar}>Guardar</button>
                <button type="button" className="rd-btn ghost rr-vista" disabled={sinGuardar || !r || ocupado} title={sinGuardar ? 'Guardá primero' : 'A qué facturas iría cada recibo'} onClick={vistaPrevia}>
                    <Eye size={14} /> Vista previa de los recibos
                </button>
                <button type="button" className="rd-btn rr-emitir" disabled={tope === 0 || sinGuardar || !listos || ocupado} onClick={emitir}>
                    <Send size={14} /> Emitir {listos || ''} {listos === 1 ? 'recibo' : 'recibos'}
                </button>
                {tope === 0 && (
                    <span className="rd-info rr-emision-apagada" title={piloto.length
                        ? `La emisión desde la app está en piloto con la hoja ${piloto.join(', ')}. Esta hoja se sigue cargando en IM como siempre.`
                        : 'La emisión desde la app no está activada: hace falta el sí de Mati. Esta hoja se sigue cargando en IM como siempre.'}>
                        <Info size={13} /> Emisión apagada
                    </span>
                )}
                {ocupado && <Loader2 size={16} className="rd-girando" />}
            </div>

            {plan && (
                <div className="rr-plan">
                    <b>Vista previa: recibos a Caja Repartos con fecha {ddmm(h.fecha)}</b>
                    {plan.length === 0 && <span className="rd-gris">No hay efectivo cargado.</span>}
                    {plan.map(p => (
                        <div key={p.cod_cliente} className={`rr-paso ${p.estado}`}>
                            <span className="rr-paso-cliente">{nombre(p.cod_cliente)} · {money(p.importe)}</span>
                            <span>
                                {p.estado === 'listo' && `→ ${(p.comprobantes ?? []).map(c => `${c.etiqueta || c.id}${c.fecha ? ` del ${ddmm(c.fecha)}` : ''} ${money(c.importe_a_pagar)}`).join(' · ')}${p.elegida ? ' (elegidas)' : ''}`}
                                {p.estado === 'emitido' && `✓ ya emitido (recibo ${p.recibo_im ?? ''})`}
                                {(p.estado === 'salteado' || p.estado === 'en_espera') && p.motivo}
                            </span>
                            {p.estado !== 'emitido' && !!p.pendientes?.length && eligiendo !== p.cod_cliente && (
                                <button type="button" className="rd-btn ghost rr-elegir" disabled={ocupado} onClick={() => setEligiendo(p.cod_cliente)}>Elegir facturas</button>
                            )}
                            {eligiendo === p.cod_cliente && (
                                <ElegirFacturas paso={p} actual={elegidas[p.cod_cliente]}
                                    onUsar={fs => { setElegidas(x => ({ ...x, [p.cod_cliente]: fs })); setEligiendo(null); }}
                                    onMasVieja={() => { setElegidas(x => { const y = { ...x }; delete y[p.cod_cliente]; return y; }); setEligiendo(null); }}
                                    onCancelar={() => setEligiendo(null)} />
                            )}
                        </div>
                    ))}
                </div>
            )}

            {resultados && (
                <div className={`rr-plan ${resultados.frenado ? 'frenado' : ''}`}>
                    <b>{resultados.lista.filter(x => x.ok).length} de {resultados.lista.length} recibos emitidos{resultados.frenado ? ': se frenó en el primer problema' : ''}</b>
                    {resultados.lista.map(x => (
                        <div key={x.cod_cliente} className={`rr-paso ${x.ok ? 'emitido' : 'salteado'}`}>
                            <span className="rr-paso-cliente">{nombre(x.cod_cliente)}</span>
                            <span>{x.ok ? `✓ recibo ${x.recibo_id ?? ''}` : x.error}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * Elegir a qué facturas va el recibo de un cliente: arranca con lo que propone la vista previa (la más
 * vieja primero) y se puede cambiar o repartir. La suma tiene que dar lo cobrado (±$5). Lo elegido se
 * guarda con la rendición y el servidor lo vuelve a controlar contra IM antes de emitir.
 */
function ElegirFacturas({ paso, actual, onUsar, onMasVieja, onCancelar }: {
    paso: Paso; actual: Eleccion | undefined; onUsar: (fs: Eleccion) => void; onMasVieja: () => void; onCancelar: () => void;
}) {
    const inicial = actual ?? (paso.comprobantes ?? []).map(c => ({ id: c.id, importe: c.importe_a_pagar }));
    const [montos, setMontos] = useState<Record<string, string>>(() => Object.fromEntries(inicial.map(f => [f.id, aTexto(f.importe)])));
    const eleccion: Eleccion = (paso.pendientes ?? []).flatMap(f => {
        const imp = leerImporte(montos[f.id] ?? '') ?? 0;
        return imp > 0 ? [{ id: f.id, importe: imp }] : [];
    });
    const suma = eleccion.reduce((s, f) => s + f.importe, 0);
    const pasada = (paso.pendientes ?? []).find(f => (leerImporte(montos[f.id] ?? '') ?? 0) > f.saldo + 1);
    const sirve = eleccion.length > 0 && Math.abs(suma - paso.importe) <= TOLERANCIA && !pasada;
    return (
        <div className="rr-elegir-facturas">
            {(paso.pendientes ?? []).map(f => (
                <label key={f.id} className="rr-factura">
                    <span>{f.etiqueta}{f.fecha ? ` del ${ddmm(f.fecha)}` : ''} · le quedan {money(f.saldo)}</span>
                    <input className="rr-input" inputMode="decimal" placeholder="0" aria-label={`Importe a ${f.etiqueta}`} value={montos[f.id] ?? ''}
                        onChange={e => { const v = e.target.value; setMontos(m => ({ ...m, [f.id]: v })); }} />
                </label>
            ))}
            <span className={`rr-suma ${sirve ? 'ok' : ''}`}>
                Suma {money(suma)} de {money(paso.importe)}{pasada ? ` · a ${pasada.etiqueta} no le alcanza el saldo` : ''}
            </span>
            <div className="rr-acciones">
                <button type="button" className="rd-btn rr-usar" disabled={!sirve} onClick={() => onUsar(eleccion)}>Usar estas</button>
                <button type="button" className="rd-btn ghost" onClick={onMasVieja}>La más vieja primero</button>
                <button type="button" className="rd-btn ghost" onClick={onCancelar}>Cancelar</button>
            </div>
        </div>
    );
}

