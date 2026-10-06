import { useEffect, useMemo, useState, useRef, type ReactNode } from 'react';
import { X, Camera, Upload, Check, AlertCircle, ChevronLeft, Loader2, Search, Clock, FileText, RefreshCw, ZoomIn, ZoomOut, Download, ExternalLink, LogOut, Share2 } from 'lucide-react';
import { authHeaders, getUser } from '../utils/auth';
import { buscarClientes } from '../utils/buscarClientes';
import { formatCurrency, formatCurrency2 } from '../utils/formatters';
import { MEDIOS_PAGO_UI, normalizeMedioUI, exigeFotoUI } from '../utils/mediosPago';
import { preseleccionFIFO, siguienteEnCola } from '../utils/aprobacionRecibos';
import { leerComprobante } from '../utils/ocrNavegador';
import type { DatosComprobante } from '../utils/ocrComprobante';
import { hoyArgentina } from '../utils/hoyArgentina';
import './RecibosApp.css';

interface Props {
    onClose: () => void;
    clients?: Array<{ cod: string; name: string; localidad?: string }>; // opcional: para selector
    // fullPage: modo pantalla completa (sin overlay/backdrop). Lo usa el shell
    // del repartidor, para quien Recibos ES la app entera, no un modal.
    fullPage?: boolean;
    // onLogout: en modo fullPage el header muestra el botón de cerrar sesión.
    onLogout?: () => void;
    /**
     * Cliente desde el que se tocó "Pago" (tarjeta de Cobranzas): abre directo la carga con ese
     * cliente elegido. Antes caía en la lista y había que buscarlo de nuevo (S32, 04/10/2026).
     */
    clienteInicial?: string | null;
}

interface MPCandidate {
    cuenta: 'principal' | 'recaudadora_1' | 'recaudadora_2';
    payment_id: string;
    date_approved: string;
    amount: number;
    status: string;
    payer_email?: string;
    description?: string;
}

interface ReciboRow {
    id: string;
    cod_cliente: number;
    cod_vendedor: number;
    monto: number | null;
    fecha_comprobante: string | null;
    medio_pago: string | null;
    banco_origen: string | null;
    referencia: string | null;
    observaciones: string | null;
    foto_url: string;
    foto_signed_url: string | null;
    ocr_raw: any;
    ocr_confidence: number | null;
    status: 'pendiente_revision' | 'aprobado' | 'imputado' | 'rechazado' | 'error';
    factura_asociada: string | null;
    cod_empresa: number | null;
    infomanager_recibo_id: string | null;
    /** Lo que devolvió IM al emitirlo: de acá sale el número de recibo (RC). */
    infomanager_response?: { recibo?: { numero?: number | string | null } } | null;
    motivo_rechazo: string | null;
    error_msg: string | null;
    created_at: string;
    reviewed_at: string | null;
    imputado_at: string | null;
    // MP verification
    mp_status?: 'pending' | 'verified' | 'not_found' | 'ambiguous' | 'skipped' | 'error' | null;
    mp_payment_id?: string | null;
    mp_cuenta?: 'principal' | 'recaudadora_1' | 'recaudadora_2' | null;
    mp_verified_at?: string | null;
    mp_lookup_attempts?: number | null;
    mp_candidates?: MPCandidate[] | null;
}

interface FacturaCandidata {
    id: number | string;
    tipo_comprobante: string;
    punto_de_venta: number | string;
    numero: number | string;
    fecha_factura?: string;
    importe_factura?: number;
    importe_pagado?: number;
    saldo?: number;
    dias_deuda?: number;
    detalle?: string;
}

export const RecibosApp = ({ onClose, clients = [], fullPage = false, onLogout, clienteInicial = null }: Props) => {
    const user = getUser();
    // Misma regla que `puedeRevisarRecibos` del servidor: administrativo imputa (Mati, 26/09).
    const isBackoffice = user?.rol === 'admin' || user?.rol === 'gerente' || user?.rol === 'administrativo';
    const isRepartidor = user?.rol === 'repartidor';
    // viewAll: ve la lista completa de comprobantes (de todos los vendedores).
    // El backoffice la revisa/imputa; el repartidor solo la consulta para saber
    // si un cliente ya pagó antes de entregarle la mercadería.
    const viewAll = isBackoffice || isRepartidor;
    // Todos arrancan en 'list': vendedores también necesitan ver el histórico de
    // sus comprobantes (aprobados/rechazados/imputados) sin tener que pasar antes
    // por upload. Si quieren cargar uno nuevo, el botón "Cargar nuevo" está en
    // el header derecho cuando view === 'list'.
    const [view, setView] = useState<'list' | 'upload' | 'detail'>(clienteInicial ? 'upload' : 'list');
    const [selectedId, setSelectedId] = useState<string | null>(null);
    /**
     * La tanda que está revisando el backoffice: los pendientes de la lista, en su orden y con sus
     * filtros. Al resolver uno se abre el siguiente, sin volver a la lista (S32: después de cada
     * aprobación había 1,8 s de espera fija y la lista se recargaba entera).
     */
    const [cola, setCola] = useState<string[]>([]);
    const [resueltos, setResueltos] = useState<Set<string>>(() => new Set());
    const resolver = (id: string) => {
        const hechos = new Set(resueltos).add(id);
        setResueltos(hechos);
        const sig = siguienteEnCola(cola, id, hechos);
        if (sig) { setSelectedId(sig); return; }
        setSelectedId(null); setView('list');
    };
    const quedan = cola.filter(x => x !== selectedId && !resueltos.has(x)).length;

    // Maestro completo: incluye clientes sin saldo (p.ej. adelantos de dinero).
    // El `clients` prop viene filtrado por saldo > 1000 desde VendorShell, así que
    // acá pedimos la lista completa al backend y dejamos el prop como fallback.
    const [fullClients, setFullClients] = useState<Array<{ cod: string; name: string; localidad?: string }>>([]);
    useEffect(() => {
        let alive = true;
        fetch('/api/clientes/lookup', { headers: authHeaders() })
            .then(r => r.json())
            .then(j => { if (alive && j.ok && Array.isArray(j.items)) setFullClients(j.items); })
            .catch(() => { /* silencioso: si falla, usamos el prop clients */ });
        return () => { alive = false; };
    }, []);

    // Estado de la integración MercadoPago (solo backoffice): permite avisar si la
    // verificación automática de recibos NO está activa (tokens sin cargar/inválidos).
    const [mpCfg, setMpCfg] = useState<{ activas: number; total: number; cuentas: { cuenta: string; configured: boolean; valid: boolean | null; detail: string }[] } | null>(null);
    useEffect(() => {
        if (!isBackoffice) return;
        let alive = true;
        fetch('/api/recibos/mp-config', { headers: authHeaders() })
            .then(r => r.json())
            .then(j => { if (alive && j.ok) setMpCfg(j); })
            .catch(() => { /* silencioso */ });
        return () => { alive = false; };
    }, [isBackoffice]);

    // Merge: maestro + clientes con deuda. Maestro pisa por si trae razón social más actual.
    const mergedClients = useMemo(() => {
        const m = new Map<string, { cod: string; name: string; localidad?: string }>();
        clients.forEach(c => m.set(String(c.cod), c));
        fullClients.forEach(c => m.set(String(c.cod), c));
        return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    }, [clients, fullClients]);

    // Lookup rápido por cod_cliente para mostrar nombre en lista/detalle
    const clientNameByCod = useMemo(() => {
        const m = new Map<string, string>();
        mergedClients.forEach(c => m.set(String(c.cod), c.name));
        return m;
    }, [mergedClients]);

    return (
        <div className={fullPage ? 'recibos-page' : 'recibos-overlay'} role="dialog" aria-modal={!fullPage}>
            <div className={fullPage ? 'recibos-page-inner' : 'recibos-modal'}>
                <header className="recibos-header">
                    {fullPage && view === 'list' ? (
                        <div className="recibos-page-brand">
                            <img src="/logo-sm.webp" alt="Semillero El Manantial" />
                        </div>
                    ) : fullPage ? (
                        <button className="recibos-icon-btn" onClick={() => setView('list')} aria-label="Volver">
                            <ChevronLeft size={20} />
                        </button>
                    ) : (
                        <button className="recibos-icon-btn" onClick={onClose} aria-label="Cerrar">
                            <X size={20} />
                        </button>
                    )}
                    <h2>
                        {view === 'list' && (isBackoffice ? 'Recibos pendientes' : isRepartidor ? 'Comprobantes de pago' : 'Mis comprobantes')}
                        {view === 'upload' && 'Cargar comprobante'}
                        {view === 'detail' && (isBackoffice ? 'Revisar recibo' : 'Detalle del comprobante')}
                    </h2>
                    <div className="recibos-header-actions">
                        {view === 'list' && (
                            <button className="btn-primary" onClick={() => setView('upload')}>
                                <Camera size={16} /> Cargar nuevo
                            </button>
                        )}
                        {fullPage && onLogout && (
                            <button className="recibos-icon-btn" onClick={onLogout}
                                aria-label="Cerrar sesión" title="Cerrar sesión">
                                <LogOut size={18} />
                            </button>
                        )}
                    </div>
                </header>

                <div className="recibos-body">
                    {view === 'list' && isBackoffice && mpCfg && (
                        mpCfg.activas === mpCfg.total ? (
                            <div className="mp-cfg-banner mp-cfg-banner--ok">
                                ✓ MercadoPago activo — verificación automática en {mpCfg.activas}/{mpCfg.total} cuentas
                            </div>
                        ) : (
                            <div className="mp-cfg-banner mp-cfg-banner--warn">
                                <strong>⚠️ MercadoPago: {mpCfg.activas}/{mpCfg.total} cuentas activas.</strong> Los recibos de MercadoPago no se verifican solos hasta cargar los tokens en EasyPanel.
                                <ul>
                                    {mpCfg.cuentas.map(c => (
                                        <li key={c.cuenta}>{c.cuenta.replace('_', ' ')}: {c.valid === true ? '✓ ' : c.configured ? '✗ ' : '— '}{c.detail}</li>
                                    ))}
                                </ul>
                            </div>
                        )
                    )}
                    {view === 'list' && (
                        <RecibosList
                            isBackoffice={!!isBackoffice}
                            viewAll={viewAll}
                            clientNameByCod={clientNameByCod}
                            onOpenDetail={(id, pendientes) => { setSelectedId(id); setCola(pendientes); setResueltos(new Set()); setView('detail'); }}
                            onUpload={() => setView('upload')}
                        />
                    )}
                    {view === 'upload' && (
                        <UploadRecibo
                            clients={mergedClients}
                            clienteInicial={clienteInicial}
                            defaultCodVendedor={user?.cod_vendedor ?? null}
                            hideCodVendedor={isRepartidor}
                            onDone={() => setView('list')}
                            onCancel={() => setView('list')}
                        />
                    )}
                    {view === 'detail' && selectedId && (
                        <DetalleRecibo
                            key={selectedId}
                            id={selectedId}
                            onResuelto={isBackoffice ? resolver : undefined}
                            quedan={quedan}
                            isBackoffice={!!isBackoffice}
                            clientNameByCod={clientNameByCod}
                            clients={mergedClients}
                            onBack={() => { setSelectedId(null); setView('list'); }}
                        />
                    )}
                </div>
            </div>
        </div>
    );
};

// ───────────────────────────────────────────────────────────────────────────
// LIST
// ───────────────────────────────────────────────────────────────────────────
// Mapeo cod_vendedor → nombre legible (basado en seed Supabase, ver
// project_panel_vendedor_recibos_mvp_20260420.md). Si aparece un cod nuevo
// no mapeado, mostramos "Vendedor #X".
const VENDOR_NAMES: Record<number, string> = {
    1: 'Federico',
    2: 'Sebastián',
    3: 'Marcelo',
    4: 'Julio',
    5: 'Adolfo',
    6: 'Andrea',
    8: 'Robledo',
    9: 'Darío',
    10: 'Niño',
    12: 'Brian',
};
const vendorLabel = (cod: number): string => VENDOR_NAMES[cod] ?? `Vendedor #${cod}`;

/** Lo que contesta POST /api/recibos/lote. */
interface PasoLote { id: string; cod_cliente: number; monto: number; fecha: string | null; estado: 'listo' | 'salteado' | 'en_espera'; motivo?: string; comprobantes?: Array<{ id: string; importe_a_pagar: number }> }

/**
 * Aprobar EN LOTE los pagos que MercadoPago ya verificó (S32 · mejora 4, Mati 04/10/2026). Primero
 * se ve el plan —qué entra, con qué imputación, y qué no y por qué— y recién ahí se aprueba. Cada
 * recibo pasa por la misma aprobación de siempre; se frena en el primer problema.
 */
function LoteMercadoPago({ clientNameByCod, onCerrar }: { clientNameByCod: Map<string, string>; onCerrar: (huboCambios: boolean) => void }) {
    const [plan, setPlan] = useState<PasoLote[] | null>(null);
    const [tope, setTope] = useState(0);
    const [cargando, setCargando] = useState(true);
    const [aprobando, setAprobando] = useState(false);
    const [resultados, setResultados] = useState<Array<{ id: string; ok: boolean; recibo_id?: string | null; error?: string }> | null>(null);
    const [frenado, setFrenado] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const nombre = (cod: number) => clientNameByCod.get(String(cod)) ?? `Cliente ${cod}`;
    useEffect(() => {
        let vivo = true;
        (async () => {
            try {
                const res = await fetch('/api/recibos/lote', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ accion: 'plan' }) });
                const d = await res.json();
                if (!vivo) return;
                if (!res.ok || !d?.ok) throw new Error(d?.error ?? `HTTP ${res.status}`);
                setPlan(d.plan ?? []); setTope(Number(d.tope) || 0);
            } catch (e) { if (vivo) setError(e instanceof Error ? e.message : 'No se pudo armar el plan'); }
            finally { if (vivo) setCargando(false); }
        })();
        return () => { vivo = false; };
    }, []);
    const listos = (plan ?? []).filter(p => p.estado === 'listo');
    const salteados = (plan ?? []).filter(p => p.estado === 'salteado');
    const enEspera = (plan ?? []).filter(p => p.estado === 'en_espera');
    const aprobar = async () => {
        setAprobando(true); setError(null);
        try {
            const res = await fetch('/api/recibos/lote', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ accion: 'aprobar', ids: listos.map(p => p.id) }) });
            const d = await res.json();
            if (!res.ok || !d?.ok) throw new Error(d?.error ?? `HTTP ${res.status}`);
            setResultados(d.resultados ?? []); setFrenado(d.frenado === true);
        } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo aprobar'); }
        finally { setAprobando(false); }
    };
    return (
        <div className="rec-lote">
            <div className="rec-lote-head">
                <strong>Aprobar en lote: pagos verificados por MercadoPago</strong>
                <span className="rec-lote-info" title={`Entra sólo lo que no necesita criterio: verificado por MercadoPago, sin observaciones, que se cubre con facturas pendientes (de la más vieja a la más nueva) y sin un posible duplicado. Piloto: hasta ${tope} por tanda.`}>
                    <AlertCircle size={13} /> Piloto: hasta {tope} por tanda
                </span>
                <button className="recibos-icon-btn" onClick={() => onCerrar(!!resultados?.some(r => r.ok))} aria-label="Cerrar"><X size={16} /></button>
            </div>
            {cargando && <div className="rec-loading"><Loader2 size={16} className="spin" /> Armando el plan…</div>}
            {error && <div className="rec-msg rec-msg--err">{error}</div>}
            {plan && !resultados && (
                <>
                    {!listos.length && <p className="rec-lote-vacio">No hay pagos para aprobar en lote ahora.</p>}
                    {listos.map(p => (
                        <div className="rec-lote-listo" key={p.id}>
                            <span><strong>{nombre(p.cod_cliente)}</strong> · {formatMoneyExact(p.monto)}</span>
                            <small>Se imputa a: {(p.comprobantes ?? []).map(c => `#${c.id} ${formatMoneyExact(c.importe_a_pagar)}`).join(' + ')}</small>
                        </div>
                    ))}
                    {enEspera.length > 0 && <p className="rec-lote-espera">{enEspera.length} más quedan para la próxima tanda (tope del piloto).</p>}
                    {salteados.length > 0 && (
                        <details className="rec-lote-salteados">
                            <summary>{salteados.length} para revisar uno por uno</summary>
                            <ul>{salteados.map(p => <li key={p.id}>{nombre(p.cod_cliente)} · {formatMoneyExact(p.monto)} — {p.motivo}</li>)}</ul>
                        </details>
                    )}
                    {listos.length > 0 && (
                        <button className="btn-primary" onClick={aprobar} disabled={aprobando}>
                            {aprobando ? <><Loader2 size={14} className="spin" /> Emitiendo…</> : <><Check size={14} /> Aprobar {listos.length}</>}
                        </button>
                    )}
                </>
            )}
            {resultados && (
                <div className="rec-lote-resultados">
                    {resultados.map(r => {
                        const p = (plan ?? []).find(x => x.id === r.id);
                        return (
                            <div key={r.id} className={`rec-lote-resultado ${r.ok ? 'ok' : 'mal'}`}>
                                {r.ok ? <Check size={14} /> : <AlertCircle size={14} />} {p ? nombre(p.cod_cliente) : r.id}
                                {r.ok ? ` · recibo InfoManager ${r.recibo_id ?? ''}` : ` · ${r.error}`}
                            </div>
                        );
                    })}
                    {frenado && <div className="rec-msg rec-msg--err">Se frenó en el primer problema: el resto quedó pendiente, sin tocar.</div>}
                    <button className="btn-secondary" onClick={() => onCerrar(resultados.some(r => r.ok))}>Listo</button>
                </div>
            )}
        </div>
    );
}

/**
 * Recibos que emitió la app y que InfoManager ya no tiene (S32 · mejora 7, 04/10/2026): se borraron
 * o anularon allá después de emitirse, y la app los seguía mostrando como imputados (2 en
 * septiembre). Es un informe para la oficina: no frena nada, por eso va plegado.
 */
function ControlRecibosIM({ clientNameByCod }: { clientNameByCod: Map<string, string> }) {
    const [faltan, setFaltan] = useState<Array<{ id: string; cod_cliente: number; monto: number; fecha_comprobante: string | null; infomanager_recibo_id: string | null; reviewed_by_nombre?: string | null }>>([]);
    const [abierto, setAbierto] = useState(false);
    useEffect(() => {
        let vivo = true;
        fetch('/api/recibos/control-im', { headers: authHeaders() })
            .then(r => r.json())
            .then(d => { if (vivo && d?.ok) setFaltan(d.faltan ?? []); })
            .catch(() => { /* es un informe: si falla, no se muestra */ });
        return () => { vivo = false; };
    }, []);
    if (!faltan.length) return null;
    return (
        <div className="rec-control-im">
            <button type="button" className="rec-control-im-chip" onClick={() => setAbierto(a => !a)} aria-expanded={abierto}
                title="Se borraron o anularon en InfoManager después de emitirse. La app los sigue mostrando como imputados: revisalos en IM.">
                <AlertCircle size={13} /> {faltan.length} {faltan.length === 1 ? 'recibo' : 'recibos'} de la app ya no {faltan.length === 1 ? 'está' : 'están'} en InfoManager
            </button>
            {abierto && (
                <ul>
                    {faltan.map(f => (
                        <li key={f.id}>
                            {clientNameByCod.get(String(f.cod_cliente)) ?? `Cliente ${f.cod_cliente}`} · {formatMoneyExact(f.monto)} · {f.fecha_comprobante ?? '—'} · recibo IM {f.infomanager_recibo_id}
                            {f.reviewed_by_nombre ? ` · aprobó ${f.reviewed_by_nombre}` : ''}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function RecibosList({ isBackoffice, viewAll, clientNameByCod, onOpenDetail, onUpload }: { isBackoffice: boolean; viewAll: boolean; clientNameByCod: Map<string, string>; onOpenDetail: (id: string, pendientes: string[]) => void; onUpload: () => void }) {
    const [items, setItems] = useState<ReciboRow[]>([]);
    /**
     * El recibo en PDF para mandarle al cliente por WhatsApp.
     *
     * Mati (16/09/2026): *"un botón para poder compartir el recibo que crean ellos, para
     * reemplazar el recibo manual que actualmente están escribiendo los vendedores"*.
     *
     * El import va acá adentro: jsPDF son ~600 kB y no tienen por qué viajar en el bundle de
     * la primera pantalla. Mismo criterio que el PDF del presupuesto.
     */
    const [compartiendo, setCompartiendo] = useState<string | null>(null);
    async function compartir(r: ReciboRow) {
        setCompartiendo(r.id);
        try {
            const { compartirReciboPdf } = await import('../utils/pdfRecibo');
            await compartirReciboPdf({
                // Sin número de InfoManager el PDF se rotula como constancia provisoria: hasta
                // que la oficina lo imputa, respalda que el vendedor recibió la plata.
                numero: r.infomanager_recibo_id ?? null,
                cliente: clientNameByCod.get(String(r.cod_cliente)) ?? `Cliente ${r.cod_cliente}`,
                cod_cliente: r.cod_cliente,
                fecha: r.fecha_comprobante ?? r.created_at,
                monto: Number(r.monto) || 0,
                medio_pago: MEDIOS_PAGO_UI.find(m => m.value === normalizeMedioUI(r.medio_pago))?.label ?? r.medio_pago,
                banco_origen: r.banco_origen,
                referencia: r.referencia,
                observaciones: r.observaciones,
                vendedor: vendorLabel(r.cod_vendedor),
            });
        } catch (e: any) {
            alert(`No se pudo armar el recibo: ${e?.message ?? 'error'}`);
        } finally {
            setCompartiendo(null);
        }
    }
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<'pendiente_revision' | 'todos' | 'imputado' | 'rechazado' | 'aprobado'>(isBackoffice ? 'pendiente_revision' : 'todos');
    const [vendorFilter, setVendorFilter] = useState<'all' | string>('all');
    const [search, setSearch] = useState('');
    const [err, setErr] = useState<string | null>(null);
    /**
     * Qué período se pide. `''` = los últimos 30 días, que es lo que se mostraba siempre.
     *
     * Mati (16/09/2026): *"a veces necesitamos ver el historial de recibos de más de 1 mes;
     * capaz que podemos poner un selector de fecha para cuidar las consultas"*. Por eso se pide
     * UN MES por vez y no un rango libre: la consulta queda acotada sola.
     */
    const [mes, setMes] = useState<string>('');
    const [truncado, setTruncado] = useState(false);
    const [verLote, setVerLote] = useState(false);
    /** Los últimos 12 meses, armados en el momento: no hay lista que mantener. */
    const mesesDisponibles = useMemo(() => {
        const hoy = new Date();
        return Array.from({ length: 12 }, (_, i) => {
            const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
            const valor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            const texto = d.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
            return { valor, texto: texto.charAt(0).toUpperCase() + texto.slice(1) };
        });
    }, []);

    const load = async () => {
        setLoading(true); setErr(null);
        try {
            const sp = new URLSearchParams();
            if (filter !== 'todos') sp.set('status', filter);
            if (mes) sp.set('mes', mes);
            const res = await fetch(`/api/recibos${sp.toString() ? `?${sp}` : ''}`, { headers: authHeaders() });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setItems(data.recibos || []);
            setTruncado(Boolean(data.truncado));
        } catch (e: any) { setErr(e.message); }
        finally { setLoading(false); }
    };
    useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter, mes]);

    // Vendedores únicos del set actual (derivados, no hardcoded), ordenados por nombre.
    const uniqueVendors = useMemo(() => {
        const set = new Set(items.map(r => r.cod_vendedor));
        return Array.from(set).sort((a, b) => vendorLabel(a).localeCompare(vendorLabel(b), 'es'));
    }, [items]);

    // Filtrado client-side por vendedor + buscador por cliente. No re-fetch — el
    // backend ya trae todo del status actual y filtramos en memoria.
    const visibleItems = useMemo(() => {
        let arr = items;
        if (vendorFilter !== 'all') {
            arr = arr.filter(r => String(r.cod_vendedor) === vendorFilter);
        }
        const q = search.trim().toLowerCase();
        if (q) {
            arr = arr.filter(r => {
                const name = (clientNameByCod.get(String(r.cod_cliente)) ?? '').toLowerCase();
                return name.includes(q) || String(r.cod_cliente).includes(q);
            });
        }
        return arr;
    }, [items, vendorFilter, search, clientNameByCod]);

    return (
        <div className="rec-list">
            <div className="rec-filter-bar">
                {(isBackoffice
                    ? ['pendiente_revision', 'aprobado', 'imputado', 'rechazado', 'todos']
                    : ['todos', 'pendiente_revision', 'imputado', 'rechazado']
                ).map(f => (
                    <button key={f}
                        className={`rec-chip ${filter === f ? 'is-active' : ''}`}
                        onClick={() => setFilter(f as any)}>
                        {statusLabel(f as any)}
                    </button>
                ))}
                <button className="rec-chip" onClick={load} title="Refrescar"><RefreshCw size={14} /></button>
                {/* Un mes por vez: mirar hacia atrás sin traerse todo el historial. */}
                <select
                    className="rec-periodo"
                    value={mes}
                    onChange={e => setMes(e.target.value)}
                    title="Qué período mostrar"
                >
                    <option value="">Últimos 30 días</option>
                    {mesesDisponibles.map(m => <option key={m.valor} value={m.valor}>{m.texto}</option>)}
                </select>
            </div>
            {isBackoffice && <ControlRecibosIM clientNameByCod={clientNameByCod} />}
            {isBackoffice && filter === 'pendiente_revision' && !verLote && (
                <button className="rec-chip rec-lote-abrir" onClick={() => setVerLote(true)} title="Aprobar de una vez los pagos que MercadoPago ya verificó">
                    <Check size={14} /> Aprobar en lote los verificados por MercadoPago
                </button>
            )}
            {verLote && <LoteMercadoPago clientNameByCod={clientNameByCod} onCerrar={(cambios) => { setVerLote(false); if (cambios) load(); }} />}
            {truncado && (
                /* La lista llegó al tope: decirlo, porque una lista cortada en silencio se lee
                   como "no hay más" y ahí se toman decisiones. */
                <div className="rec-truncado">
                    <AlertCircle size={14} />
                    <span>Hay más recibos en este período de los que entran en la lista. Filtrá por estado o elegí un mes puntual.</span>
                </div>
            )}

            {/* Filtro vendedor — visible para quien ve la lista completa (backoffice
                y repartidor) y si hay >1 vendedor en el set */}
            {viewAll && uniqueVendors.length > 1 && (
                <div className="rec-vendor-filter">
                    <label>
                        <span>Vendedor:</span>
                        <select value={vendorFilter} onChange={e => setVendorFilter(e.target.value)}>
                            <option value="all">Todos ({items.length})</option>
                            {uniqueVendors.map(cod => {
                                const count = items.filter(r => r.cod_vendedor === cod).length;
                                return (
                                    <option key={cod} value={String(cod)}>
                                        {vendorLabel(cod)} ({count})
                                    </option>
                                );
                            })}
                        </select>
                    </label>
                </div>
            )}

            {/* Buscador por cliente — client-side, filtra el set actual sin re-fetch */}
            <div className="rec-list-search">
                <Search size={14} />
                <input
                    type="text"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Buscar por cliente (nombre o código)…"
                />
                {search && (
                    <button type="button" className="rec-list-search-clear"
                        onClick={() => setSearch('')} aria-label="Limpiar búsqueda">
                        <X size={14} />
                    </button>
                )}
            </div>

            {loading && <div className="rec-loading"><Loader2 size={16} className="spin" /> Cargando…</div>}
            {err && <div className="rec-error"><AlertCircle size={16} /> {err}</div>}

            {!loading && visibleItems.length === 0 && (
                <div className="rec-empty">
                    <FileText size={32} />
                    <p>
                        Sin comprobantes
                        {filter !== 'todos' ? ` en estado "${statusLabel(filter)}"` : ' cargados'}
                        {vendorFilter !== 'all' ? ` de ${vendorLabel(Number(vendorFilter))}` : ''}
                        {search.trim() ? ` que coincidan con "${search.trim()}"` : ''}
                        .
                    </p>
                    {!isBackoffice && !search.trim() && filter === 'todos' && (
                        <button className="btn-primary" onClick={onUpload}>Cargar el primero</button>
                    )}
                </div>
            )}

            <ul className="rec-items">
                {visibleItems.map(r => (
                    <li key={r.id} className="rec-item" onClick={() => onOpenDetail(r.id, visibleItems.filter(x => x.status === 'pendiente_revision').map(x => x.id))}>
                        <div className="rec-item-thumb">
                            {r.foto_signed_url && r.foto_url.toLowerCase().endsWith('.pdf') ? (
                                <div className="rec-pdf-placeholder"><FileText size={22} /></div>
                            ) : r.foto_signed_url ? (
                                <img src={r.foto_signed_url} alt="comprobante" loading="lazy" />
                            ) : <div className="rec-pdf-placeholder"><FileText size={22} /></div>}
                        </div>
                        <div className="rec-item-body">
                            <div className="rec-item-row1">
                                <strong>
                                    {clientNameByCod.get(String(r.cod_cliente)) ?? `Cliente ${r.cod_cliente}`}
                                    <span className="rec-cod"> #{r.cod_cliente}</span>
                                </strong>
                                <span className={`rec-status rec-status--${r.status}`}>{statusLabel(r.status)}</span>
                            </div>
                            <div className="rec-item-row2">
                                <span className="rec-amount">{formatMoney(r.monto)}</span>
                                <span className="rec-meta">{r.fecha_comprobante ?? '—'} · {r.medio_pago ?? 'sin medio'}</span>
                            </div>
                            <div className="rec-item-row3">
                                <Clock size={11} />
                                <span>{timeAgo(r.created_at)}</span>
                                {viewAll && <span className="rec-vendor-tag">{vendorLabel(r.cod_vendedor)}</span>}
                                {r.ocr_confidence != null && <span className="rec-ocr-badge">OCR {Math.round(r.ocr_confidence * 100)}%</span>}
                                {/* 🪤 stopPropagation: la fila entera abre el detalle. */}
                                {r.status !== 'rechazado' && (
                                    <button
                                        className="rec-compartir"
                                        disabled={compartiendo === r.id}
                                        onClick={e => { e.stopPropagation(); compartir(r); }}
                                        title="Mandarle el recibo al cliente"
                                    >
                                        {compartiendo === r.id ? <Loader2 size={12} className="spin" /> : <Share2 size={12} />}
                                        <span>Compartir</span>
                                    </button>
                                )}
                            </div>
                        </div>
                    </li>
                ))}
            </ul>
        </div>
    );
}

// ───────────────────────────────────────────────────────────────────────────
// UPLOAD
// ───────────────────────────────────────────────────────────────────────────
function UploadRecibo({ clients, defaultCodVendedor, hideCodVendedor = false, clienteInicial = null, onDone, onCancel }:
    { clients: Array<{ cod: string; name: string; localidad?: string }>; defaultCodVendedor: number | null; hideCodVendedor?: boolean; clienteInicial?: string | null; onDone: () => void; onCancel: () => void }) {
    const fileRef = useRef<HTMLInputElement>(null);
    const [file, setFile] = useState<File | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [codCliente, setCodCliente] = useState(clienteInicial ?? '');
    const [codVendedor, setCodVendedor] = useState(defaultCodVendedor?.toString() ?? '');
    const [monto, setMonto] = useState('');
    // Fecha del comprobante: vacía por default para forzar al vendedor a cargar
    // la fecha REAL del recibo (no la del día de upload). Antes se precargaba
    // con hoy y muchos vendedores no la modificaban, lo que terminaba grabando
    // en IM la fecha de subida en vez de la del comprobante.
    const [fecha, setFecha] = useState<string>('');
    // Sin medio elegido de fábrica (Mati, 06/10/2026): venía "MercadoPago" y 26 pagos a la Recaudadora 1
    // quedaron cargados así entre mayo y septiembre. Quien carga lo elige siempre.
    const [medioPago, setMedioPago] = useState<string>('');
    const [observaciones, setObservaciones] = useState('');
    // Si se llegó desde la tarjeta de un cliente, la lista ya viene filtrada a ese cliente.
    const [clientSearch, setClientSearch] = useState(() =>
        clienteInicial ? (clients.find(c => c.cod === clienteInicial)?.name ?? clienteInicial) : '');
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
    const [ocrResult, setOcrResult] = useState<any>(null);
    /**
     * OCR en el celular (S32 · mejora 8, Mati 05/10/2026): apenas se elige la foto se leen el monto, la
     * fecha y a qué cuenta de Semillero fue la transferencia. Se prellena sólo lo que está vacío y se
     * avisa si lo cargado no coincide con la foto.
     */
    const [foto, setFoto] = useState<{ leyendo: true } | { leyendo: false; datos: DatosComprobante } | null>(null);
    const lecturaVigente = useRef(0);
    /**
     * ¿Este pago ya figura? Se pregunta solo, apenas hay cliente, monto y fecha. Si aparece algo
     * parecido hay que confirmar que es otro pago antes de enviar (S32: 52 de 63 rechazos de
     * septiembre eran pagos ya imputados por otro lado o subidos dos veces).
     */
    const [dup, setDup] = useState<Duplicados | null>(null);
    const [confirmaDistinto, setConfirmaDistinto] = useState(false);
    useEffect(() => {
        setDup(null); setConfirmaDistinto(false);
        const m = Number(monto);
        if (!codCliente || !(m > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return;
        let vivo = true;
        const t = window.setTimeout(async () => {
            try {
                const qs = new URLSearchParams({ cod_cliente: codCliente, monto: String(m), fecha });
                const res = await fetch(`/api/recibos/posibles-duplicados?${qs}`, { headers: authHeaders() });
                const d = await res.json();
                if (vivo && res.ok && d?.ok) setDup(d);
            } catch { /* es un aviso: si no contesta, la carga sigue como siempre */ }
        }, 600);
        return () => { vivo = false; window.clearTimeout(t); };
    }, [codCliente, monto, fecha]);
    const pideConfirmar = hayDuplicados(dup) && !confirmaDistinto;

    // Mismo buscador que Pedidos (utils/buscarClientes, con tests): sin esto "pena" no
    // encuentra a PEÑA y "bustos sebastian" no encuentra a "BUSTOS, Sebastián (Este)".
    // La localidad se sigue contemplando: se concatena al nombre sólo para matchear.
    const filteredClients = useMemo(() => {
        const conLoc = clients.map(c => ({ ...c, name: `${c.name} ${c.localidad ?? ''}`.trim() }));
        const codsOk = new Set(buscarClientes(conLoc, clientSearch).resultados.map(c => c.cod));
        return clients.filter(c => codsOk.has(c.cod));
    }, [clients, clientSearch]);

    const onPickFile = (f: File | null) => {
        if (!f) return;
        setFile(f);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPreviewUrl(URL.createObjectURL(f));
        const lectura = ++lecturaVigente.current;
        if (!f.type.startsWith('image/')) { setFoto(null); return; }
        setFoto({ leyendo: true });
        leerComprobante(f, hoyArgentina()).then(datos => {
            if (lectura !== lecturaVigente.current) return;   // ya eligió otra foto
            if (!datos || (datos.monto == null && datos.fecha == null && datos.medio == null)) { setFoto(null); return; }
            setFoto({ leyendo: false, datos });
            // Sólo lo vacío: lo que tipeó el vendedor no se pisa (si no coincide, se avisa).
            if (datos.monto != null) setMonto(m => m || String(datos.monto));
            if (datos.fecha) setFecha(x => x || (datos.fecha as string));
        });
    };

    // Sanitiza lo que el user escribe en el campo monto: saca "$", letras, espacios,
    // acepta "," o "." como decimal (AR usa coma, pero aceptamos ambos).
    const cleanMonto = (raw: string): string => {
        let v = raw.replace(/[^\d.,]/g, '');
        // Si tiene "." y "," (formato AR típico "1.500,50"): "." son miles, "," decimal.
        if (v.includes('.') && v.includes(',')) {
            v = v.replace(/\./g, '').replace(',', '.');
        } else if (v.includes(',')) {
            v = v.replace(',', '.');
        }
        // Dejar un solo punto decimal
        const parts = v.split('.');
        if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('');
        return v;
    };

    const submit = async () => {
        /**
         * 🔑 En efectivo la foto dejó de hacer falta (Mati, 16/09/2026): el recibo en PDF que
         * emite la app reemplaza al talonario, así que no hay nada que fotografiar. En
         * transferencias, MercadoPago y cheque se sigue pidiendo, porque la captura ES la
         * prueba del pago.
         */
        if (!file && exigeFotoUI(medioPago)) {
            setMsg({ kind: 'err', text: `Falta la foto del comprobante (hace falta para ${MEDIOS_PAGO_UI.find(m => m.value === medioPago)?.label ?? 'este medio de pago'})` });
            return;
        }
        if (!codCliente) { setMsg({ kind: 'err', text: 'Elegí el cliente' }); return; }
        if (!medioPago) { setMsg({ kind: 'err', text: 'Elegí el medio de pago' }); return; }
        const montoNum = Number(monto);
        if (!monto || !isFinite(montoNum) || montoNum <= 0) { setMsg({ kind: 'err', text: 'Ingresá el monto del pago' }); return; }
        if (!fecha) { setMsg({ kind: 'err', text: 'Ingresá la fecha del comprobante (la que aparece en el recibo, no la de hoy)' }); return; }
        if (pideConfirmar) { setMsg({ kind: 'err', text: 'Revisá el aviso: puede ser un pago que ya figura. Si es otro, confirmalo.' }); return; }
        setBusy(true); setMsg(null);
        try {
            const fd = new FormData();
            if (file) fd.append('foto', file);
            fd.append('cod_cliente', codCliente);
            if (codVendedor) fd.append('cod_vendedor', codVendedor);
            if (monto) fd.append('monto', monto);
            if (fecha) fd.append('fecha_comprobante', fecha);
            if (medioPago) fd.append('medio_pago', medioPago);
            if (observaciones) fd.append('observaciones', observaciones);
            // Lo que leyó el celular queda guardado con el recibo: así se mide cuánto acierta.
            if (foto && !foto.leyendo) fd.append('ocr_celular', JSON.stringify(foto.datos));
            const res = await fetch('/api/recibos/upload', {
                method: 'POST',
                headers: authHeaders(), // NO Content-Type: lo setea el browser con boundary
                body: fd
            });
            const data = await res.json();
            if (!res.ok || !data.ok) {
                setMsg({ kind: 'err', text: data.error || `HTTP ${res.status}` });
                return;
            }
            setOcrResult(data.ocr);
            setMsg({ kind: 'ok', text: 'Comprobante enviado. Queda pendiente de revisión.' });
            // Prellenar con OCR si el user no cargó monto
            if (data.ocr?.monto && !monto) setMonto(String(data.ocr.monto));
            if (data.ocr?.fecha && !fecha) setFecha(data.ocr.fecha);
            setTimeout(() => { onDone(); }, 1500);
        } catch (e: any) {
            setMsg({ kind: 'err', text: e.message });
        } finally { setBusy(false); }
    };

    return (
        <div className="rec-upload">
            <div className="rec-upload-col rec-upload-photo">
                {previewUrl ? (
                    file?.type === 'application/pdf'
                        ? <div className="rec-pdf-big"><FileText size={64} /><span>{file.name}</span></div>
                        : <img src={previewUrl} alt="preview" />
                ) : (
                    <div className="rec-upload-empty">
                        <Camera size={48} />
                        {/* En efectivo la foto es opcional: el comprobante es el recibo que
                            emite la app. Decirlo acá evita que el vendedor se quede buscando
                            qué fotografiar cuando ya no escribe el talonario. */}
                        {exigeFotoUI(medioPago) ? (
                            <p>Tomá una foto del comprobante o subí un archivo</p>
                        ) : (
                            <>
                                <p>En efectivo no hace falta foto</p>
                                <p className="rec-upload-hint">Cargá los datos y compartile el recibo al cliente. Si igual querés adjuntar algo, podés.</p>
                            </>
                        )}
                    </div>
                )}
                <div className="rec-upload-actions">
                    <input
                        ref={fileRef}
                        type="file"
                        accept="image/*,application/pdf"
                        style={{ display: 'none' }}
                        onChange={e => onPickFile(e.target.files?.[0] ?? null)}
                    />
                    <button className="btn-secondary" onClick={() => fileRef.current?.click()}>
                        <Camera size={16} /> {file ? 'Cambiar foto' : (exigeFotoUI(medioPago) ? 'Tomar foto / subir' : 'Adjuntar (opcional)')}
                    </button>
                </div>
            </div>

            <div className="rec-upload-col rec-upload-form">
                <label className="rec-field">
                    <span>Cliente *</span>
                    <div className="rec-client-picker">
                        <div className="rec-client-search">
                            <Search size={14} />
                            <input
                                type="text"
                                value={clientSearch}
                                onChange={e => setClientSearch(e.target.value)}
                                placeholder="Buscá por nombre, código o localidad…"
                            />
                        </div>
                        <div className="rec-client-list">
                            {filteredClients.length === 0 && (
                                <div className="rec-client-empty">Sin coincidencias. Cargá el código directo abajo.</div>
                            )}
                            {filteredClients.map(c => (
                                <button
                                    key={c.cod}
                                    type="button"
                                    className={`rec-client-option ${codCliente === c.cod ? 'is-active' : ''}`}
                                    onClick={() => setCodCliente(c.cod)}>
                                    <strong>{c.name}</strong>
                                    <span>Cod {c.cod}{c.localidad ? ` · ${c.localidad}` : ''}</span>
                                </button>
                            ))}
                        </div>
                        <input
                            type="number"
                            className="rec-cod-input"
                            placeholder="o código manual"
                            value={codCliente}
                            onChange={e => setCodCliente(e.target.value)}
                        />
                    </div>
                </label>

                <div className="rec-row">
                    <label className="rec-field">
                        <span>Monto *</span>
                        <input
                            type="text"
                            inputMode="decimal"
                            placeholder="0,00"
                            value={monto}
                            onChange={e => setMonto(cleanMonto(e.target.value))}
                        />
                    </label>
                    <label className="rec-field">
                        <span>Fecha del comprobante *</span>
                        <input type="date" value={fecha} required onChange={e => setFecha(e.target.value)}
                            style={!fecha ? { borderColor: '#c00' } : undefined} />
                    </label>
                </div>

                <div className="rec-row">
                    <label className="rec-field">
                        <span>Medio</span>
                        <select value={medioPago} onChange={e => setMedioPago(e.target.value)} style={!medioPago ? { borderColor: '#c00' } : undefined}>
                            <option value="" disabled>Elegí el medio de pago…</option>
                            {MEDIOS_PAGO_UI.map(m => (
                                <option key={m.value} value={m.value}>{m.label}</option>
                            ))}
                        </select>
                    </label>
                    {defaultCodVendedor == null && !hideCodVendedor && (
                        <label className="rec-field">
                            <span>Cod vendedor</span>
                            <input type="number" value={codVendedor} onChange={e => setCodVendedor(e.target.value)} />
                        </label>
                    )}
                </div>

                {foto?.leyendo && <p className="rec-foto-leyendo"><Loader2 size={13} className="spin" /> Leyendo la foto…</p>}
                {foto && !foto.leyendo && <AvisoFoto datos={foto.datos} monto={monto} fecha={fecha} medio={medioPago} onMedio={setMedioPago} />}

                <label className="rec-field">
                    <span>Observaciones</span>
                    <textarea rows={2} value={observaciones} onChange={e => setObservaciones(e.target.value)} placeholder="Ej: cliente pidió imputar a FA 142847" />
                </label>

                {ocrResult && (
                    <div className="rec-ocr-box">
                        <strong>OCR detectó:</strong>
                        <ul>
                            {ocrResult.monto != null && <li>Monto: ${ocrResult.monto}</li>}
                            {ocrResult.fecha && <li>Fecha: {ocrResult.fecha}</li>}
                            {ocrResult.banco_origen && <li>Banco origen: {ocrResult.banco_origen}</li>}
                            {ocrResult.referencia && <li>Ref: {ocrResult.referencia}</li>}
                            <li>Confianza: {Math.round((ocrResult.confidence ?? 0) * 100)}%</li>
                        </ul>
                    </div>
                )}

                {dup && hayDuplicados(dup) && (
                    <AvisoDuplicados dup={dup}>
                        <label className="rec-dup-confirma">
                            <input type="checkbox" checked={confirmaDistinto} onChange={e => setConfirmaDistinto(e.target.checked)} />
                            <span>Es un pago distinto: cargarlo igual</span>
                        </label>
                    </AvisoDuplicados>
                )}

                {msg && (
                    <div className={`rec-msg rec-msg--${msg.kind}`}>
                        {msg.kind === 'ok' ? <Check size={16} /> : <AlertCircle size={16} />}
                        <span>{msg.text}</span>
                    </div>
                )}

                <div className="rec-form-actions">
                    <button className="btn-secondary" onClick={onCancel} disabled={busy}>Cancelar</button>
                    <button className="btn-primary" onClick={submit}
                        disabled={busy || !medioPago || (!file && exigeFotoUI(medioPago)) || !codCliente || !monto || !(Number(monto) > 0) || pideConfirmar}
                        title={!monto ? 'Cargá el monto del comprobante' : undefined}>
                        {busy ? <><Loader2 size={16} className="spin" /> Enviando…</> : <><Upload size={16} /> Enviar comprobante</>}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ───────────────────────────────────────────────────────────────────────────
// DETAIL + APPROVAL (backoffice)
// ───────────────────────────────────────────────────────────────────────────
function cuentaLabel(c: string | null | undefined): string {
    if (c === 'principal') return 'MP Principal';
    if (c === 'recaudadora_1') return 'MP Recaudadora 1';
    if (c === 'recaudadora_2') return 'MP Recaudadora 2';
    return c ?? '?';
}

/** Lo que contesta GET /api/recibos/posibles-duplicados. */
interface Duplicados {
    app: Array<{ id: string; fecha: string; monto: number; status: string; dias: number; quien: string | null; nombre: string | null; recibo_im: string | null }>;
    im: Array<{ id_recibo: string; numero: string | null; fecha: string; importe: number; dias: number; cuentas: string[] }>;
    consultado: { app: boolean; im: boolean };
}

/** Nombre corto de las cuentas de cobro de Casa Central (plan de cuentas de IM). */
const CUENTAS_COBRO: Record<string, string> = {
    '1120003': 'MercadoPago', '1120005': 'Recaudadora 1', '1120006': 'Recaudadora 2', '1120002': 'Banco Nación',
    '1110009': 'Caja Repartos', '1110005': 'Caja Casa Central', '1110004': 'Caja Chica 2', '1110006': 'Valores a depositar',
};
const ddmm = (iso: string) => (iso ?? '').slice(0, 10).split('-').reverse().slice(0, 2).join('/');
const ROL_CORTO: Record<string, string> = { repartidor: 'chofer', vendedor: 'vendedor', administrativo: 'oficina', admin: 'oficina', gerente: 'oficina' };

function hayDuplicados(d: Duplicados | null): boolean {
    return !!d && (d.app.length > 0 || d.im.length > 0);
}

/** El motivo de rechazo que se propone desde el aviso: lo que hoy Anto escribe a mano ("imputado"). */
function motivoPorDuplicado(d: Duplicados): string {
    const enIM = d.im[0];
    if (enIM) return `Ya imputado en IM (recibo ${enIM.numero ?? enIM.id_recibo} del ${ddmm(enIM.fecha)})`;
    const enApp = d.app[0];
    return `Subido dos veces (otro comprobante del ${ddmm(enApp.fecha)}${enApp.nombre ? ` cargado por ${enApp.nombre}` : ''})`;
}

/**
 * "Este pago puede estar repetido" (S32, 04/10/2026). En septiembre 52 de los 63 rechazos fueron
 * pagos que ya estaban imputados por otro lado o subidos dos veces. Es un aviso: decide la persona.
 */
/**
 * Lo que leyó el OCR del celular contra lo cargado. Si todo coincide es una línea chica; si algo no
 * coincide, un aviso. 🪤 La cuenta: entre mayo y octubre de 2026, 26 pagos a la Recaudadora 1 se
 * cargaron como "MercadoPago" (la cuenta principal) y 2 quedaron en la cuenta equivocada de IM.
 */
function AvisoFoto({ datos, monto, fecha, medio, onMedio }: {
    datos: DatosComprobante; monto: string; fecha: string; medio: string; onMedio: (m: string) => void;
}) {
    const etiqueta = (m: string) => MEDIOS_PAGO_UI.find(x => x.value === m)?.label ?? m;
    const difiere: ReactNode[] = [];
    if (datos.monto != null && Number(monto) > 0 && Math.abs(Number(monto) - datos.monto) > 1) {
        difiere.push(<li key="monto">La foto dice {formatMoneyExact(datos.monto)} y cargaste {formatMoneyExact(Number(monto))}.</li>);
    }
    if (datos.fecha && fecha && fecha !== datos.fecha) {
        difiere.push(<li key="fecha">La foto dice {ddmm(datos.fecha)} y cargaste {ddmm(fecha)}.</li>);
    }
    if (datos.medio && datos.medio !== medio) {
        const destino = datos.medio;
        difiere.push(
            <li key="medio">
                {medio ? <>La transferencia fue a la {etiqueta(destino)} y elegiste {etiqueta(medio)}.</> : <>La transferencia fue a la {etiqueta(destino)}.</>}
                <button type="button" className="rec-foto-cambiar" onClick={() => onMedio(destino)}>{medio ? 'Cambiar a' : 'Elegir'} {etiqueta(destino)}</button>
            </li>,
        );
    }
    if (!difiere.length) {
        return (
            <p className="rec-foto-ok">
                <Check size={13} /> Leído de la foto{datos.monto != null ? `: ${formatMoneyExact(datos.monto)}` : ''}{datos.fecha ? ` · ${ddmm(datos.fecha)}` : ''}. Revisalo antes de enviar.
            </p>
        );
    }
    return (
        <div className="rec-foto-difiere" role="alert">
            <strong><AlertCircle size={14} /> Revisá con la foto</strong>
            <ul>{difiere}</ul>
        </div>
    );
}

function AvisoDuplicados({ dup, children }: { dup: Duplicados; children?: ReactNode }) {
    return (
        <div className="rec-dup" role="alert">
            <strong><AlertCircle size={14} /> Este pago puede estar repetido</strong>
            <ul>
                {dup.app.map(a => (
                    <li key={'a' + a.id}>
                        En la app: {formatMoneyExact(a.monto)} del {ddmm(a.fecha)}
                        {a.nombre || a.quien ? `, cargado por ${a.nombre ?? ''}${a.quien ? ` (${ROL_CORTO[a.quien] ?? a.quien})` : ''}` : ''} · {statusLabel(a.status)}
                        {a.recibo_im ? ` · recibo IM ${a.recibo_im}` : ''}
                    </li>
                ))}
                {dup.im.map(r => (
                    <li key={'i' + r.id_recibo}>
                        En InfoManager: recibo {r.numero ?? r.id_recibo} del {ddmm(r.fecha)} por {formatMoneyExact(r.importe)}
                        {r.cuentas.length ? ` · ${r.cuentas.map(c => CUENTAS_COBRO[c] ?? c).join(', ')}` : ''}
                    </li>
                ))}
            </ul>
            {!dup.consultado.im && <p className="rec-dup-nota">No pude consultar InfoManager: el aviso sólo mira la app.</p>}
            {children}
        </div>
    );
}

function MPBadge({ rec, isBackoffice, onReverify, onPickMatch }: {
    rec: ReciboRow;
    isBackoffice: boolean;
    onReverify: () => void;
    onPickMatch: (payment_id: string, cuenta: string) => void;
}) {
    if (rec.medio_pago !== 'mercadopago') return null;
    const status = rec.mp_status;
    const candidates = rec.mp_candidates ?? [];
    if (status === 'skipped') return null;

    if (status === 'verified') {
        const c = candidates.find(x => x.payment_id === rec.mp_payment_id) ?? null;
        return (
            <div className="mp-badge mp-badge--verified">
                <strong>✓ Verificado en MercadoPago</strong>
                <div className="mp-badge-detail">
                    <span>{cuentaLabel(rec.mp_cuenta)}</span>
                    {c?.amount != null && <span>Monto MP: <strong>{formatMoney(c.amount)}</strong></span>}
                    {c?.date_approved && <span>Acreditado {new Date(c.date_approved).toLocaleString('es-AR')}</span>}
                    {c?.payer_email && <span>Pagador: {c.payer_email}</span>}
                    <span className="mp-badge-payid">ID {rec.mp_payment_id}</span>
                </div>
            </div>
        );
    }

    if (status === 'ambiguous') {
        return (
            <div className="mp-badge mp-badge--warn">
                <strong>⚠ Múltiples candidatos en MP</strong>
                <div className="mp-badge-detail">Encontramos {candidates.length} pagos con el mismo monto en la ventana. Elegí el correcto:</div>
                <div className="mp-candidates">
                    {candidates.map(c => (
                        <button key={`${c.cuenta}-${c.payment_id}`} className="mp-candidate-btn"
                            onClick={() => onPickMatch(c.payment_id, c.cuenta)}>
                            <span className="mp-cand-cuenta">{cuentaLabel(c.cuenta)}</span>
                            <span className="mp-cand-fecha">{c.date_approved ? new Date(c.date_approved).toLocaleString('es-AR') : '?'}</span>
                            {c.payer_email && <span className="mp-cand-email">{c.payer_email}</span>}
                            <span className="mp-cand-id">ID {c.payment_id}</span>
                        </button>
                    ))}
                </div>
            </div>
        );
    }

    if (status === 'not_found') {
        return (
            <div className="mp-badge mp-badge--warn">
                <strong>⚠ No encontrado en MP</strong>
                <div className="mp-badge-detail">
                    Reintentando cada 5 min (ventana 24h) · {rec.mp_lookup_attempts ?? 0} intentos
                </div>
                {isBackoffice && (
                    <button className="mp-badge-btn" onClick={onReverify}>Re-verificar ahora</button>
                )}
            </div>
        );
    }

    if (status === 'error') {
        return (
            <div className="mp-badge mp-badge--err">
                <strong>✗ Error consultando MP</strong>
                {isBackoffice && (
                    <button className="mp-badge-btn" onClick={onReverify}>Reintentar</button>
                )}
            </div>
        );
    }

    // pending o null
    return (
        <div className="mp-badge mp-badge--pending">
            <strong>⏳ Buscando en MercadoPago...</strong>
        </div>
    );
}

function DetalleRecibo({ id, isBackoffice, clientNameByCod, clients, onBack, onResuelto, quedan = 0 }: { id: string; isBackoffice: boolean; clientNameByCod: Map<string, string>; clients: Array<{ cod: string; name: string; localidad?: string }>; onBack: () => void; onResuelto?: (id: string) => void; quedan?: number }) {
    const [rec, setRec] = useState<ReciboRow | null>(null);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);
    const [editMode, setEditMode] = useState(false);
    const [facturas, setFacturas] = useState<FacturaCandidata[]>([]);
    const [loadingFacturas, setLoadingFacturas] = useState(false);
    const [codEmpresa, setCodEmpresa] = useState<number>(1);
    const [selFacturas, setSelFacturas] = useState<Record<string, number>>({});
    const [montoFinal, setMontoFinal] = useState('');
    const [fechaFinal, setFechaFinal] = useState('');
    const [medioFinal, setMedioFinal] = useState('');
    const [motivoRechazo, setMotivoRechazo] = useState('');
    const [esAnticipo, setEsAnticipo] = useState(false);
    const [cuentasEfectivo, setCuentasEfectivo] = useState<Array<{ cod_cuenta: string; nombre: string; es_default: boolean }>>([]);
    const [cuentaEfectivoSel, setCuentaEfectivoSel] = useState('');
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
    const [lightboxOpen, setLightboxOpen] = useState(false);
    const [lightboxZoom, setLightboxZoom] = useState(false);
    /**
     * ¿Este pago ya figura en IM o en la app? Antes Anto lo averiguaba mirando IM a mano, y en
     * septiembre 52 de sus 63 rechazos fueron exactamente eso (S32, 04/10/2026).
     */
    const [dup, setDup] = useState<Duplicados | null>(null);
    const motivoRef = useRef<HTMLInputElement>(null);

    // Cerrar lightbox con ESC + reset zoom al cerrar
    useEffect(() => {
        if (!lightboxOpen) { setLightboxZoom(false); return; }
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightboxOpen(false); };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [lightboxOpen]);

    // Descarga la foto al disco — fuerza download cross-origin via fetch + blob.
    // signed URL de Supabase tiene Content-Disposition: inline, asi que el atributo
    // "download" del <a> es ignorado y abre inline. Esta tecnica lo evita.
    const downloadFoto = async () => {
        if (!rec?.foto_signed_url) return;
        try {
            const res = await fetch(rec.foto_signed_url);
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const ext = (rec.foto_url?.split('.').pop() ?? 'jpg').toLowerCase();
            a.download = `comprobante-${rec.cod_cliente}-${rec.id.slice(0, 8)}.${ext}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (e) {
            console.error('download foto failed', e);
        }
    };

    const loadRecibo = async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/recibos/${id}`, { headers: authHeaders() });
            const data = await res.json();
            const item: ReciboRow | null = data.recibo ?? null;
            setRec(item);
            if (item) {
                // Lookup del payment MP verificado, compartido para auto-fill de monto y fecha.
                const mpCand = item.mp_status === 'verified' && item.mp_candidates
                    ? item.mp_candidates.find(c => c.payment_id === item.mp_payment_id) ?? null
                    : null;

                // Monto: si el del comprobante es placeholder 0.01, cae a MP. Sino respeta el cargado.
                const montoSeed = (item.monto && item.monto > 0.01) ? item.monto : (mpCand?.amount ?? item.monto);
                setMontoFinal(montoSeed?.toString() ?? '');

                // Fecha: prioridad vendedor/OCR > MP date_approved (slice ISO directo para no
                // perder el día por conversión a UTC). Si no hay ninguna, dejamos VACÍO
                // — antes caíamos a "hoy" y eso terminaba grabándose en IM como fecha
                // del recibo (en vez de la real del comprobante).
                const fechaSeed = item.fecha_comprobante
                    ?? (mpCand?.date_approved ? mpCand.date_approved.slice(0, 10) : null)
                    ?? '';
                setFechaFinal(fechaSeed);

                // Normaliza recibos legacy ('transferencia', 'otro', 'tarjeta') al canon actual
                setMedioFinal(normalizeMedioUI(item.medio_pago));
            }
        } catch (e: any) { setErr(e.message); }
        finally { setLoading(false); }
    };
    useEffect(() => { loadRecibo(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

    const loadFacturas = async () => {
        if (!rec) return;
        setLoadingFacturas(true);
        try {
            const res = await fetch(`/api/recibos/${rec.id}/facturas-candidatas?cod_empresa=${codEmpresa}`, { headers: authHeaders() });
            const data = await res.json();
            const lista: FacturaCandidata[] = data.facturas ?? [];
            setFacturas(lista);
            // 🔑 Propuesta de imputación: la deuda más vieja primero (Mati, 04/10/2026). Antes había
            // que tocar factura por factura en cada recibo; ahora se corrige sólo cuando hace falta.
            if (!esAnticipo) setSelFacturas(preseleccionFIFO(lista, Number(montoFinal)));
        } catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
        finally { setLoadingFacturas(false); }
    };

    const reverificarMPHandler = async () => {
        if (!rec) return;
        try {
            const res = await fetch(`/api/recibos/${rec.id}/reverificar-mp`, { method: 'POST', headers: authHeaders() });
            const data = await res.json();
            if (!data.ok) { setMsg({ kind: 'err', text: data.error ?? 'error' }); return; }
            setMsg({ kind: 'ok', text: `MP: ${data.result?.status ?? 'ok'}` });
            await loadRecibo();
        } catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
    };

    const elegirMatchHandler = async (payment_id: string, cuenta: string) => {
        if (!rec) return;
        try {
            const res = await fetch(`/api/recibos/${rec.id}/elegir-match`, {
                method: 'POST',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ payment_id, cuenta }),
            });
            const data = await res.json();
            if (!data.ok) { setMsg({ kind: 'err', text: data.error ?? 'error' }); return; }
            setMsg({ kind: 'ok', text: 'Match asignado' });
            await loadRecibo();
        } catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
    };
    useEffect(() => { if (isBackoffice && rec) loadFacturas(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [rec?.id, codEmpresa]);

    useEffect(() => {
        setDup(null);
        if (!isBackoffice || !rec || rec.status !== 'pendiente_revision') return;
        const m = Number(montoFinal) || Number(rec.monto) || 0;
        const f = (fechaFinal || rec.fecha_comprobante || rec.created_at || '').slice(0, 10);
        if (!(m > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(f)) return;
        let vivo = true;
        const t = window.setTimeout(async () => {
            try {
                const qs = new URLSearchParams({ cod_cliente: String(rec.cod_cliente), monto: String(m), fecha: f, excluir_id: rec.id });
                const res = await fetch(`/api/recibos/posibles-duplicados?${qs}`, { headers: authHeaders() });
                const d = await res.json();
                if (vivo && res.ok && d?.ok) setDup(d);
            } catch { /* es un aviso: si no contesta, se aprueba como siempre */ }
        }, 300);
        return () => { vivo = false; window.clearTimeout(t); };
    }, [isBackoffice, rec, montoFinal, fechaFinal]);

    // Cajas de efectivo: se cargan una vez cuando el backoffice abre un recibo en
    // efectivo, para poder elegir a qué caja entra la plata (Casa Central, Caja
    // Chica 2, etc.). Sólo aplica a medio 'efectivo' (no anticipo).
    useEffect(() => {
        if (!isBackoffice || esAnticipo || medioFinal !== 'efectivo') return;
        if (cuentasEfectivo.length > 0) return; // ya cargadas
        (async () => {
            try {
                const res = await fetch('/api/cuentas/efectivo', { headers: authHeaders() });
                const data = await res.json();
                const list = (data.cuentas ?? []) as Array<{ cod_cuenta: string; nombre: string; es_default: boolean }>;
                setCuentasEfectivo(list);
                if (!cuentaEfectivoSel) {
                    const def = list.find(c => c.es_default) ?? list[0];
                    if (def) setCuentaEfectivoSel(def.cod_cuenta);
                }
            } catch { /* si falla, el backend cae a la caja por defecto */ }
        })();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [isBackoffice, esAnticipo, medioFinal]);

    const toggleFactura = (f: FacturaCandidata) => {
        const key = String(f.id);
        setSelFacturas(prev => {
            const next = { ...prev };
            if (next[key] != null) { delete next[key]; return next; }
            // Autocompletar: saldo disponible, limitado al monto restante del recibo.
            // Redondeo a 2 decimales: IM a veces devuelve saldos con 3 decimales por
            // intereses/comisiones y eso descuadraba el balance contra montoFinal entero.
            const saldo = Math.abs(f.saldo ?? f.importe_factura ?? 0);
            const yaImputado = Object.values(prev).reduce((a, b) => a + (b || 0), 0);
            const restante = Math.max(0, Number(montoFinal) - yaImputado);
            const importe = restante > 0 ? Math.min(saldo, restante) : saldo;
            next[key] = Math.round(importe * 100) / 100;
            return next;
        });
    };

    const setImporteFactura = (key: string, value: number, saldo: number) => {
        // Cap al saldo de la factura (InfoManager rechaza si supera) + redondeo a 2 decimales.
        const capped = Math.max(0, Math.min(value, saldo));
        setSelFacturas(p => ({ ...p, [key]: Math.round(capped * 100) / 100 }));
    };

    // Parser robusto: si el reverse-proxy de EasyPanel timeout-ea o el backend
    // cae mientras procesa, la respuesta llega como HTML (página de error de
    // nginx) en lugar de JSON. Antes esto crasheaba el frontend con
    // "Unexpected token '<'". Ahora devolvemos un objeto con .error legible.
    const parseRes = async (res: Response): Promise<any> => {
        const text = await res.text();
        try {
            return text ? JSON.parse(text) : {};
        } catch {
            const looksHtml = text.trim().toLowerCase().startsWith('<');
            return {
                ok: false,
                error: looksHtml
                    ? `Timeout o error del servidor (HTTP ${res.status}). Reintentá en unos segundos.`
                    : `Respuesta inesperada (HTTP ${res.status}): ${text.slice(0, 200)}`,
            };
        }
    };

    const aprobar = async () => {
        if (!rec) return;
        setBusy(true); setMsg(null);
        try {
            const comprobantesPayload = esAnticipo
                ? []
                : Object.entries(selFacturas).map(([id, importe]) => ({
                    id, importe_a_pagar: Number(importe)
                }));
            // Cuenta de efectivo elegida: solo se manda para medio efectivo (no anticipo).
            const codCuenta = (!esAnticipo && medioFinal === 'efectivo' && cuentaEfectivoSel)
                ? cuentaEfectivoSel
                : undefined;
            const res = await fetch(`/api/recibos/${rec.id}/aprobar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({
                    monto: Number(montoFinal),
                    fecha: fechaFinal,
                    medio_pago: medioFinal,
                    cod_empresa: codEmpresa,
                    comprobantes: comprobantesPayload,
                    es_anticipo: esAnticipo,
                    ...(codCuenta ? { cod_cuenta: codCuenta } : {}),
                })
            });
            const data = await parseRes(res);
            if (!res.ok || !data.ok) {
                setMsg({ kind: 'err', text: `Error: ${data.error}${data.raw ? ' — ' + JSON.stringify(data.raw).slice(0, 200) : ''}` });
                return;
            }
            setMsg({
                kind: 'ok',
                text: data.anticipo
                    ? (data.mensaje ?? 'Anticipo registrado. Cargalo a mano en IM.')
                    : `Imputado. Recibo InfoManager: ${data.recibo_id ?? '(sin id)'}${onResuelto && quedan > 0 ? ` · sigue el próximo (quedan ${quedan})` : ''}`,
            });
            // El anticipo trae instrucciones para cargarlo en IM: se deja leer. Lo demás pasa al próximo.
            if (onResuelto) setTimeout(() => onResuelto(rec.id), data.anticipo ? 3200 : 600);
            else setTimeout(onBack, data.anticipo ? 3200 : 1800);
        } catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
        finally { setBusy(false); }
    };

    const rechazar = async () => {
        if (!rec || !motivoRechazo.trim()) { setMsg({ kind: 'err', text: 'Cargá un motivo' }); return; }
        setBusy(true); setMsg(null);
        try {
            const res = await fetch(`/api/recibos/${rec.id}/rechazar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ motivo: motivoRechazo })
            });
            const data = await parseRes(res);
            if (!res.ok || !data.ok) { setMsg({ kind: 'err', text: data.error }); return; }
            setMsg({ kind: 'ok', text: 'Rechazado' });
            if (onResuelto) setTimeout(() => onResuelto(rec.id), 600);
            else setTimeout(onBack, 1200);
        } catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
        finally { setBusy(false); }
    };

    // Reabre un recibo rechazado o con error → vuelve a 'pendiente_revision'
    // para poder corregirlo y reprocesarlo.
    const reabrir = async () => {
        if (!rec) return;
        setBusy(true); setMsg(null);
        try {
            const res = await fetch(`/api/recibos/${rec.id}/editar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ reabrir: true }),
            });
            const data = await parseRes(res);
            if (!res.ok || !data.ok) { setMsg({ kind: 'err', text: data.error }); return; }
            setMsg({ kind: 'ok', text: 'Recibo reabierto — ya podés corregirlo y reprocesarlo' });
            await loadRecibo();
        } catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
        finally { setBusy(false); }
    };

    if (loading) return <div className="rec-loading"><Loader2 className="spin" /> Cargando…</div>;
    if (err || !rec) return <div className="rec-error"><AlertCircle /> {err ?? 'No encontrado'}</div>;

    // Redondeo a 2 decimales: el reduce de floats puede dar 4.0000000001 y eso
    // ensucia tanto el display con decimales como la comparación contra montoFinal.
    const totalImputado = Math.round(Object.values(selFacturas).reduce((a, b) => a + (b || 0), 0) * 100) / 100;

    // Si el OCR falló y el vendedor no cargó monto, comprobantes_pago.monto queda en 0.01.
    // Cuando MP verificó el pago, mostramos el amount real detectado para no engañar al admin con "$ 0".
    const mpMatch = rec.mp_status === 'verified' && rec.mp_candidates
        ? rec.mp_candidates.find(c => c.payment_id === rec.mp_payment_id) ?? null
        : null;
    const montoIsPlaceholder = !rec.monto || rec.monto <= 0.01;
    const montoEffective = !montoIsPlaceholder ? rec.monto : (mpMatch?.amount ?? null);

    // Mensaje exacto que explica por qué el botón aprobar está disabled.
    const disabledReason = (() => {
        if (busy) return '';
        if (!fechaFinal) return 'Cargá la fecha del comprobante (la que se graba en InfoManager)';
        if (esAnticipo) {
            return !(Number(montoFinal) > 0) ? 'Cargá el monto final del anticipo' : '';
        }
        if (Object.keys(selFacturas).length === 0) return 'Seleccioná al menos una factura, o marcá "Es anticipo de cliente"';
        const diff = Math.abs(totalImputado - Number(montoFinal));
        if (diff > 5) return `Diferencia $${(Number(montoFinal) - totalImputado).toFixed(2)} — ajustá monto final o importe imputado`;
        return '';
    })();

    return (
        <>
        <div className="rec-detail">
            <button className="rec-back" onClick={onBack}><ChevronLeft size={16} /> Volver</button>

            <div className="rec-detail-grid">
                <div className="rec-detail-photo">
                    {rec.foto_signed_url && rec.foto_url.toLowerCase().endsWith('.pdf')
                        ? <a href={rec.foto_signed_url} target="_blank" rel="noreferrer" className="rec-pdf-link"><FileText size={32} /> Ver PDF</a>
                        : rec.foto_signed_url
                            ? <img
                                src={rec.foto_signed_url}
                                alt="comprobante"
                                className="rec-photo-zoomable"
                                title="Click para ampliar"
                                onClick={() => setLightboxOpen(true)}
                            />
                            : <div>Sin foto</div>}
                </div>

                <div className="rec-detail-info">
                    <div className="rec-detail-head">
                        <div>
                            <span className={`rec-status rec-status--${rec.status}`}>{statusLabel(rec.status)}</span>
                            <h3>{clientNameByCod.get(String(rec.cod_cliente)) ?? `Cliente ${rec.cod_cliente}`}</h3>
                            <p>Cod {rec.cod_cliente} · Vendedor cod {rec.cod_vendedor} · {timeAgo(rec.created_at)}</p>
                        </div>
                        <div className="rec-detail-amount">
                            {montoEffective != null ? (
                                <>
                                    {formatMoney(montoEffective)}
                                    {montoIsPlaceholder && <small className="rec-amount-source"> (MP)</small>}
                                </>
                            ) : (
                                <span className="rec-amount-empty">Sin monto cargado</span>
                            )}
                        </div>
                    </div>

                    {editMode && isBackoffice ? (
                        <EditarReciboForm
                            rec={rec}
                            clients={clients}
                            onSaved={() => { setEditMode(false); loadRecibo(); }}
                            onCancel={() => setEditMode(false)}
                        />
                    ) : (
                    <>
                    <dl className="rec-dl">
                        <dt>Fecha</dt><dd>{rec.fecha_comprobante ?? '—'}</dd>
                        <dt>Medio</dt><dd>{rec.medio_pago ?? '—'}</dd>
                        <dt>Banco origen</dt><dd>{rec.banco_origen ?? '—'}</dd>
                        <dt>Referencia</dt><dd>{rec.referencia ?? '—'}</dd>
                        <dt>Observaciones</dt><dd>{rec.observaciones ?? '—'}</dd>
                        {rec.ocr_confidence != null && <><dt>OCR</dt><dd>{Math.round(rec.ocr_confidence * 100)}%</dd></>}
                        {rec.factura_asociada && <><dt>Imputado a</dt><dd>{rec.factura_asociada}</dd></>}
                        {rec.infomanager_recibo_id && <><dt>Recibo IM</dt><dd>{rec.infomanager_recibo_id}</dd></>}
                        {rec.motivo_rechazo && <><dt>Motivo rechazo</dt><dd>{rec.motivo_rechazo}</dd></>}
                        {rec.error_msg && <><dt>Error</dt><dd>{rec.error_msg}</dd></>}
                    </dl>

                    <MPBadge rec={rec} isBackoffice={isBackoffice}
                        onReverify={reverificarMPHandler}
                        onPickMatch={elegirMatchHandler} />

                    {isBackoffice && (rec.status === 'pendiente_revision' || rec.status === 'error') && (
                        <div className="rec-approval">
                            <h4>{esAnticipo ? 'Imputar como anticipo' : 'Imputar a facturas'}</h4>
                            {dup && hayDuplicados(dup) && (
                                <AvisoDuplicados dup={dup}>
                                    <button type="button" className="btn-danger rec-dup-rechazar"
                                        onClick={() => { setMotivoRechazo(motivoPorDuplicado(dup)); motivoRef.current?.focus(); }}>
                                        Rechazar: ya figura
                                    </button>
                                </AvisoDuplicados>
                            )}

                            <label className="rec-anticipo-toggle">
                                <input type="checkbox" checked={esAnticipo} onChange={e => setEsAnticipo(e.target.checked)} />
                                <div>
                                    <strong>Es anticipo de cliente (sin factura)</strong>
                                    <span>La API de IM no emite anticipos: se registra acá y lo cargás a mano en IM (Recibos → Tipo Recibo "S/Anticipo" → Cta. Contable 2124000).</span>
                                </div>
                            </label>

                            <div className="rec-row">
                                <label className="rec-field">
                                    <span>Empresa</span>
                                    <select value={codEmpresa} onChange={e => setCodEmpresa(Number(e.target.value))}>
                                        <option value={1}>1 · Casa Central</option>
                                        <option value={2}>2 · BRS San Martín</option>
                                        <option value={3}>3 · Santo Cristo</option>
                                    </select>
                                </label>
                                <label className="rec-field">
                                    <span>Monto final</span>
                                    <input type="number" step="0.01" value={montoFinal} onChange={e => setMontoFinal(e.target.value)} />
                                </label>
                            </div>
                            <div className="rec-row">
                                <label className="rec-field">
                                    <span>Fecha {!fechaFinal && <small style={{ color: '#c00' }}>· obligatoria</small>}</span>
                                    <input type="date" value={fechaFinal} required onChange={e => setFechaFinal(e.target.value)}
                                        style={!fechaFinal ? { borderColor: '#c00' } : undefined} />
                                </label>
                                <label className="rec-field">
                                    <span>Medio</span>
                                    <select value={medioFinal} onChange={e => setMedioFinal(e.target.value)}>
                                        {MEDIOS_PAGO_UI.map(m => (
                                            <option key={m.value} value={m.value}>{m.label}</option>
                                        ))}
                                    </select>
                                </label>
                            </div>

                            {!esAnticipo && medioFinal === 'efectivo' && cuentasEfectivo.length > 0 && (
                                <div className="rec-row">
                                    <label className="rec-field">
                                        <span>Caja de efectivo</span>
                                        <select value={cuentaEfectivoSel} onChange={e => setCuentaEfectivoSel(e.target.value)}>
                                            {cuentasEfectivo.map(c => (
                                                <option key={c.cod_cuenta} value={c.cod_cuenta}>
                                                    {c.nombre}{c.es_default ? ' (por defecto)' : ''}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                </div>
                            )}

                            {!esAnticipo && <div className="rec-facturas">
                                {loadingFacturas && <div><Loader2 className="spin" size={14} /> Cargando facturas pendientes…</div>}
                                {!loadingFacturas && facturas.length === 0 && <div className="rec-empty">Sin facturas pendientes para esta empresa.</div>}
                                {!loadingFacturas && facturas.map(f => {
                                    const key = String(f.id);
                                    const sel = selFacturas[key] != null;
                                    const saldo = Math.abs(f.saldo ?? f.importe_factura ?? 0);
                                    return (
                                        <div key={key} className={`rec-factura ${sel ? 'is-active' : ''}`}>
                                            <label>
                                                <input type="checkbox" checked={sel} onChange={() => toggleFactura(f)} />
                                                <div>
                                                    <strong>{f.tipo_comprobante} {f.punto_de_venta}-{f.numero}</strong>
                                                    <span>{f.fecha_factura ?? ''} · Saldo {formatMoneyExact(saldo)}{f.dias_deuda != null ? ` · ${f.dias_deuda}d` : ''}{f.detalle ? ` · ${f.detalle}` : ''}</span>
                                                </div>
                                            </label>
                                            {sel && (
                                                <input type="number" step="0.01" max={saldo} min="0"
                                                    value={selFacturas[key]}
                                                    onChange={e => setImporteFactura(key, Number(e.target.value), saldo)}
                                                    className="rec-importe-input"
                                                    title={`Máx ${formatMoneyExact(saldo)}`} />
                                            )}
                                        </div>
                                    );
                                })}
                            </div>}

                            {!esAnticipo && (
                                <div className="rec-approval-summary">
                                    <span>Total a imputar: <strong>{formatMoneyExact(totalImputado)}</strong> / {formatMoneyExact(Number(montoFinal))}</span>
                                    <button type="button" className="rec-chip rec-fifo" onClick={() => setSelFacturas(preseleccionFIFO(facturas, Number(montoFinal)))}
                                        title="Vuelve a repartir el monto empezando por la factura más vieja">
                                        ↺ Más vieja primero
                                    </button>
                                    {Math.abs(totalImputado - Number(montoFinal)) > 5 && (
                                        <span className="rec-warn">
                                            ⚠ Diferencia: ${(Number(montoFinal) - totalImputado).toFixed(2)}
                                        </span>
                                    )}
                                </div>
                            )}
                            {esAnticipo && (
                                <div className="rec-approval-summary">
                                    <span>Anticipo por <strong>{formatMoney(Number(montoFinal))}</strong> → cta 2124000 · <em>se carga a mano en IM</em></span>
                                </div>
                            )}

                            {msg && <div className={`rec-msg rec-msg--${msg.kind}`}>{msg.text}</div>}

                            <div className="rec-approval-actions">
                                <input
                                    ref={motivoRef}
                                    type="text"
                                    placeholder="Motivo de rechazo (si aplica)"
                                    value={motivoRechazo}
                                    onChange={e => setMotivoRechazo(e.target.value)}
                                    className="rec-rechazo-input"
                                />
                                <button className="btn-danger" disabled={busy || !motivoRechazo.trim()} onClick={rechazar}>Rechazar</button>
                                <button className="btn-primary"
                                    disabled={busy || !fechaFinal || (esAnticipo
                                        ? !(Number(montoFinal) > 0)
                                        : (Object.keys(selFacturas).length === 0 || Math.abs(totalImputado - Number(montoFinal)) > 5))}
                                    onClick={aprobar}
                                    title={disabledReason}>
                                    {busy ? <><Loader2 size={14} className="spin" /> {esAnticipo ? 'Registrando…' : 'Emitiendo…'}</> : <><Check size={14} /> {esAnticipo ? 'Registrar anticipo (cargar a mano en IM)' : (onResuelto && quedan > 0 ? 'Aprobar, emitir y seguir' : 'Aprobar y emitir recibo')}</>}
                                </button>
                            </div>
                        </div>
                    )}

                    {isBackoffice && (
                        <div className="rec-detail-tools">
                            <button className="btn-secondary" onClick={() => { setEditMode(true); setMsg(null); }}>
                                Editar datos del recibo
                            </button>
                            {(rec.status === 'rechazado' || rec.status === 'error' || rec.status === 'aprobado') && (
                                <button className="btn-primary" onClick={reabrir} disabled={busy}>
                                    {busy ? <><Loader2 size={14} className="spin" /> …</> : (rec.status === 'aprobado' ? 'Reabrir anticipo' : 'Reabrir para reprocesar')}
                                </button>
                            )}
                        </div>
                    )}
                    {msg && rec.status !== 'pendiente_revision' && rec.status !== 'error' && (
                        <div className={`rec-msg rec-msg--${msg.kind}`}>{msg.text}</div>
                    )}
                    </>
                    )}
                </div>
            </div>
        </div>
        {lightboxOpen && rec.foto_signed_url && (
            <div
                className="rec-lightbox"
                onClick={(e) => { if (e.target === e.currentTarget) setLightboxOpen(false); }}
                role="dialog"
                aria-label="Comprobante ampliado"
            >
                <div className="rec-lightbox-toolbar" onClick={e => e.stopPropagation()}>
                    <button
                        className="rec-lightbox-btn"
                        onClick={() => setLightboxZoom(z => !z)}
                        title={lightboxZoom ? 'Reducir' : 'Zoom 2x'}
                    >
                        {lightboxZoom ? <ZoomOut size={20} /> : <ZoomIn size={20} />}
                        <span>{lightboxZoom ? 'Reducir' : 'Zoom 2x'}</span>
                    </button>
                    <a
                        className="rec-lightbox-btn"
                        href={rec.foto_signed_url}
                        target="_blank"
                        rel="noreferrer"
                        title="Abrir original en pestaña nueva (visor del browser, zoom infinito)"
                    >
                        <ExternalLink size={20} />
                        <span>Abrir original</span>
                    </a>
                    <button
                        className="rec-lightbox-btn"
                        onClick={downloadFoto}
                        title="Descargar al disco para ver con visor de fotos del SO"
                    >
                        <Download size={20} />
                        <span>Descargar</span>
                    </button>
                    <button
                        className="rec-lightbox-btn rec-lightbox-btn--close"
                        onClick={() => setLightboxOpen(false)}
                        aria-label="Cerrar"
                        title="Cerrar (ESC)"
                    >
                        <X size={20} />
                    </button>
                </div>
                <div className={`rec-lightbox-stage ${lightboxZoom ? 'is-zoomed' : ''}`}>
                    <img
                        src={rec.foto_signed_url}
                        alt="comprobante ampliado"
                        onClick={(e) => { e.stopPropagation(); setLightboxZoom(z => !z); }}
                    />
                </div>
            </div>
        )}
        </>
    );
}

// ───────────────────────────────────────────────────────────────────────────
// EDIT — corrección de datos de un recibo ya cargado (backoffice)
// ───────────────────────────────────────────────────────────────────────────
function EditarReciboForm({ rec, clients, onSaved, onCancel }: {
    rec: ReciboRow;
    clients: Array<{ cod: string; name: string; localidad?: string }>;
    onSaved: () => void;
    onCancel: () => void;
}) {
    const [codCliente, setCodCliente] = useState(String(rec.cod_cliente));
    const [monto, setMonto] = useState(rec.monto != null ? String(rec.monto) : '');
    const [fecha, setFecha] = useState(rec.fecha_comprobante ?? '');
    const [medio, setMedio] = useState(normalizeMedioUI(rec.medio_pago));
    const [bancoOrigen, setBancoOrigen] = useState(rec.banco_origen ?? '');
    const [referencia, setReferencia] = useState(rec.referencia ?? '');
    const [observaciones, setObservaciones] = useState(rec.observaciones ?? '');
    const [clientSearch, setClientSearch] = useState('');
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

    // Mismo buscador que Pedidos (utils/buscarClientes, con tests): sin esto "pena" no
    // encuentra a PEÑA y "bustos sebastian" no encuentra a "BUSTOS, Sebastián (Este)".
    // La localidad se sigue contemplando: se concatena al nombre sólo para matchear.
    const filteredClients = useMemo(() => {
        const conLoc = clients.map(c => ({ ...c, name: `${c.name} ${c.localidad ?? ''}`.trim() }));
        const codsOk = new Set(buscarClientes(conLoc, clientSearch).resultados.map(c => c.cod));
        return clients.filter(c => codsOk.has(c.cod));
    }, [clients, clientSearch]);

    const selectedClientName = useMemo(
        () => clients.find(c => c.cod === codCliente)?.name ?? null,
        [clients, codCliente]
    );

    const numeroIM = rec.infomanager_response?.recibo?.numero ?? null;
    const etiquetaMedio = (m: string) => MEDIOS_PAGO_UI.find(x => x.value === m)?.label ?? m;
    const postear = async (ruta: string, cuerpo: unknown) => {
        const r = await fetch(`/api/recibos/${rec.id}${ruta}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(cuerpo),
        });
        const d = await r.json().catch(() => ({}));
        return { ok: r.ok && d.ok, d };
    };
    /**
     * Un recibo ya emitido (Mati, 06/10/2026, MONTENORT): lo que cambia en IM no se guarda sólo acá. El medio (la cuenta)
     * se corrige en IM con el mismo número, después de confirmar; monto, cliente y fecha todavía van a mano en IM.
     * Los textos se guardan acá, como siempre.
     */
    const guardarEmitido = async (montoNum: number) => {
        const cambiosIM: Record<string, unknown> = {};
        if (Number(codCliente) !== Number(rec.cod_cliente)) cambiosIM.cod_cliente = Number(codCliente);
        if (Math.abs(montoNum - Number(rec.monto)) >= 0.01) cambiosIM.monto = montoNum;
        if ((fecha || null) !== (rec.fecha_comprobante ?? null)) cambiosIM.fecha_comprobante = fecha;
        if (medio !== normalizeMedioUI(rec.medio_pago)) cambiosIM.medio_pago = medio;
        let enIM = false;
        if (Object.keys(cambiosIM).length) {
            const plan = await postear('/corregir', { accion: 'plan', cambios: cambiosIM });
            if (!plan.ok) { setMsg({ kind: 'err', text: plan.d.error || 'No se pudo revisar el recibo en IM' }); return; }
            const p = plan.d.plan;
            if (p.tipo === 'no_se_puede') { setMsg({ kind: 'err', text: p.motivo }); return; }
            if (p.tipo === 'anular_reemitir') {
                setMsg({ kind: 'err', text: 'Cambiar el monto, el cliente o la fecha de un recibo ya emitido todavía se corrige a mano en IM: anulalo allá y cargalo de nuevo.' });
                return;
            }
            if (p.tipo === 'cuenta' && !window.confirm(`En InfoManager, el recibo ${plan.d.recibo_im ?? ''} pasa de ${etiquetaMedio(normalizeMedioUI(rec.medio_pago))} (cuenta ${p.desde}) a ${etiquetaMedio(medio)} (cuenta ${p.hacia}).\n\nConserva el número, el importe y las facturas. Queda registrado quién lo corrigió.\n\n¿Corregir en IM?`)) return;
            const hecho = await postear('/corregir', { accion: 'corregir', cambios: cambiosIM });
            if (!hecho.ok) { setMsg({ kind: 'err', text: hecho.d.error || 'No se pudo corregir en IM' }); return; }
            enIM = p.tipo === 'cuenta';
        }
        const textos: Record<string, string | null> = {};
        if ((bancoOrigen || null) !== (rec.banco_origen ?? null)) textos.banco_origen = bancoOrigen || null;
        if ((referencia || null) !== (rec.referencia ?? null)) textos.referencia = referencia || null;
        if ((observaciones || null) !== (rec.observaciones ?? null)) textos.observaciones = observaciones || null;
        if (Object.keys(textos).length) {
            const t = await postear('/editar', textos);
            if (!t.ok) { setMsg({ kind: 'err', text: t.d.error || 'No se pudieron guardar los cambios' }); return; }
        }
        setMsg({ kind: 'ok', text: enIM ? 'Corregido en IM y en la app' : 'Cambios guardados' });
        setTimeout(onSaved, enIM ? 1500 : 700);
    };

    const save = async () => {
        const montoNum = Number(monto);
        if (!codCliente || Number(codCliente) <= 0) { setMsg({ kind: 'err', text: 'Cargá el cliente' }); return; }
        if (!monto || !isFinite(montoNum) || montoNum <= 0) { setMsg({ kind: 'err', text: 'El monto debe ser mayor a 0' }); return; }
        setBusy(true); setMsg(null);
        try {
            if (rec.status === 'imputado') { await guardarEmitido(montoNum); return; }
            const res = await fetch(`/api/recibos/${rec.id}/editar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({
                    cod_cliente: Number(codCliente),
                    monto: montoNum,
                    fecha_comprobante: fecha || null,
                    medio_pago: medio,
                    banco_origen: bancoOrigen || null,
                    referencia: referencia || null,
                    observaciones: observaciones || null,
                }),
            });
            const data = await res.json();
            if (!res.ok || !data.ok) { setMsg({ kind: 'err', text: data.error || `HTTP ${res.status}` }); return; }
            setMsg({ kind: 'ok', text: 'Cambios guardados' });
            setTimeout(onSaved, 700);
        } catch (e: any) {
            setMsg({ kind: 'err', text: e.message });
        } finally { setBusy(false); }
    };

    return (
        <div className="rec-edit">
            <h4>Editar datos del comprobante</h4>

            {rec.status === 'imputado' && (
                <div className="rec-msg rec-msg--err">
                    <AlertCircle size={16} />
                    <span>
                        Este recibo ya está en InfoManager{numeroIM ? ` (RC ${numeroIM})` : ''}. Si cambiás el medio de
                        pago, al guardar se va a corregir en IM también, con el mismo número y después de confirmar.
                        El monto, el cliente y la fecha todavía se corrigen a mano en IM.
                    </span>
                </div>
            )}

            <label className="rec-field">
                <span>Cliente *</span>
                <div className="rec-client-picker">
                    <div className="rec-client-search">
                        <Search size={14} />
                        <input
                            type="text"
                            value={clientSearch}
                            onChange={e => setClientSearch(e.target.value)}
                            placeholder="Buscá por nombre, código o localidad…"
                        />
                    </div>
                    <div className="rec-client-list">
                        {filteredClients.length === 0 && (
                            <div className="rec-client-empty">Sin coincidencias. Cargá el código directo abajo.</div>
                        )}
                        {filteredClients.map(c => (
                            <button
                                key={c.cod}
                                type="button"
                                className={`rec-client-option ${codCliente === c.cod ? 'is-active' : ''}`}
                                onClick={() => setCodCliente(c.cod)}>
                                <strong>{c.name}</strong>
                                <span>Cod {c.cod}{c.localidad ? ` · ${c.localidad}` : ''}</span>
                            </button>
                        ))}
                    </div>
                    <input
                        type="number"
                        className="rec-cod-input"
                        placeholder="o código manual"
                        value={codCliente}
                        onChange={e => setCodCliente(e.target.value)}
                    />
                    {selectedClientName && (
                        <span className="rec-edit-selected">Seleccionado: <strong>{selectedClientName}</strong></span>
                    )}
                </div>
            </label>

            <div className="rec-row">
                <label className="rec-field">
                    <span>Monto *</span>
                    <input type="number" step="0.01" value={monto} onChange={e => setMonto(e.target.value)} />
                </label>
                <label className="rec-field">
                    <span>Fecha del comprobante</span>
                    <input type="date" value={fecha} onChange={e => setFecha(e.target.value)} />
                </label>
            </div>

            <div className="rec-row">
                <label className="rec-field">
                    <span>Medio</span>
                    <select value={medio} onChange={e => setMedio(e.target.value)}>
                        {MEDIOS_PAGO_UI.map(m => (
                            <option key={m.value} value={m.value}>{m.label}</option>
                        ))}
                    </select>
                </label>
                <label className="rec-field">
                    <span>Banco origen</span>
                    <input type="text" value={bancoOrigen} onChange={e => setBancoOrigen(e.target.value)} />
                </label>
            </div>

            <label className="rec-field">
                <span>Referencia</span>
                <input type="text" value={referencia} onChange={e => setReferencia(e.target.value)} />
            </label>

            <label className="rec-field">
                <span>Observaciones</span>
                <textarea rows={2} value={observaciones} onChange={e => setObservaciones(e.target.value)} />
            </label>

            {msg && (
                <div className={`rec-msg rec-msg--${msg.kind}`}>
                    {msg.kind === 'ok' ? <Check size={16} /> : <AlertCircle size={16} />}
                    <span>{msg.text}</span>
                </div>
            )}

            <div className="rec-form-actions">
                <button className="btn-secondary" onClick={onCancel} disabled={busy}>Cancelar</button>
                <button className="btn-primary" onClick={save} disabled={busy}>
                    {busy ? <><Loader2 size={16} className="spin" /> Guardando…</> : <><Check size={16} /> Guardar cambios</>}
                </button>
            </div>
        </div>
    );
}

// ───────────────────────────────────────────────────────────────────────────
// helpers
// ───────────────────────────────────────────────────────────────────────────
function statusLabel(s: string): string {
    switch (s) {
        case 'pendiente_revision': return 'Pendiente';
        case 'aprobado': return 'Anticipo (cargar en IM)';
        case 'imputado': return 'Imputado';
        case 'rechazado': return 'Rechazado';
        case 'error': return 'Error';
        case 'todos': return 'Todos';
        default: return s;
    }
}
function formatMoney(n: number | null | undefined): string {
    if (n == null) return '—';
    return formatCurrency(n);
}
// Versión con 2 decimales: SOLO para el flujo de imputación de recibos, donde
// el centavo es "load-bearing" (el saldo real de la factura tiene decimales y
// el cobrador necesita ver/imputar el monto exacto). El resto de la app sigue
// usando formatMoney (entero) para los displays informativos.
function formatMoneyExact(n: number | null | undefined): string {
    if (n == null) return '—';
    return formatCurrency2(n);
}
function timeAgo(iso: string): string {
    const d = new Date(iso);
    const diff = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diff < 60) return 'hace unos segundos';
    if (diff < 3600) return `hace ${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `hace ${Math.floor(diff / 3600)}h`;
    return `hace ${Math.floor(diff / 86400)}d`;
}
