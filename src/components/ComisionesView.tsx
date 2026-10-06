import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { DollarSign, Loader2, AlertCircle, RefreshCw, Trophy, Eye, EyeOff, Replace, Plus, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import type { ViewPeriod } from './PeriodSelector';
import './ComisionesView.css';

const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const CATEGORIA_ORDER = ['5%', '4%', '3.5%', '1%', 'especial'] as const;
const PRIVACY_STORAGE_KEY = 'ctacte:comisiones:privacy';
const MASKED = '$ ••••';

// Vendedores comerciales visibles (espejo de COD_VENDEDORES_VISIBLES en
// server-lib/comisionesShared.ts). Si se suma un vendedor allá, agregarlo acá.
const VENDEDORES_OVERRIDE = [
    { cod: 2, nombre: 'Sebastián' },
    { cod: 3, nombre: 'Marcelo' },
    { cod: 4, nombre: 'Julio' },
    { cod: 12, nombre: 'Brian' },
];
const vendorName = (cod: number | null | undefined): string =>
    VENDEDORES_OVERRIDE.find(v => v.cod === cod)?.nombre ?? (cod != null ? `Vend ${cod}` : '—');

interface OverrideItem {
    id_comprobante: number;
    cod_vendedor: number;
    cod_vendedor_original: number | null;
    motivo: string | null;
    created_at: string;
}

type Categoria = typeof CATEGORIA_ORDER[number];

interface BreakdownEntry { neto: number; comision: number; lineas: number }
interface DescuentoRebotes {
    total_rebotado: number; descuento: number; renglones: number;
    /** Rebotes por error de la empresa / depósito: el 3% se SUMA (desde septiembre 2026). */
    total_empresa?: number; bonificacion?: number; renglones_empresa?: number;
}
/** Premio por cumplimiento del objetivo (server-lib/premioObjetivo.ts). */
interface PremioObjetivo {
    pct_cumplimiento: number | null;
    tasa: number;
    base: number;
    premio_bruto: number;
    productos_total: number;
    productos_cumplidos: number;
    reducido: boolean;
    premio: number;
}
interface ComisionVendedor {
    cod_vendedor: number;
    nombre: string;
    email: string | null;
    activo: boolean;
    neto_total: number;
    comision_total: number;
    /** Ajustes del 3% por rebotes: −M.C. Vendedor, +empresa/depósito. */
    rebotes: DescuentoRebotes | null;
    comision_neta: number;
    premio?: PremioObjetivo | null;
    /** comision_neta + premio. */
    comision_a_cobrar?: number;
    num_lineas: number;
    num_comprobantes: number;
    breakdown: Record<Categoria, BreakdownEntry>;
}

interface ComisionesResponse {
    ok: boolean;
    year: number;
    month: number;
    items: ComisionVendedor[];
    totales: {
        neto_total: number;
        comision_total: number;
        rebotes_descuento?: number;
        rebotes_bonificacion?: number;
        comision_neta?: number;
        premio?: number;
        comision_a_cobrar?: number;
        num_lineas: number;
        num_comprobantes: number;
        breakdown: Record<Categoria, BreakdownEntry>;
    };
    categoria_labels: Record<Categoria, string>;
    rebotes_rige?: boolean;
    rebotes_error?: boolean;
    premio_rige?: boolean;
    premio_estimado?: boolean;
    premio_error?: boolean;
}

interface Props {
    isAdmin: boolean;
    viewPeriod: ViewPeriod;
    userCodVendedor: number | null;
}

const fmtMoney = (n: number) =>
    new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n);

// Wrapper: si el modo privacidad está activo, devuelve "$ ••••" en vez del
// monto real. Pensado para mostrar la pantalla al cliente sin revelar plata.
const fmtMoneyMaybe = (n: number, hidden: boolean) => hidden ? MASKED : fmtMoney(n);
const fmtPct = (n: number) => `${(n * 100).toLocaleString('es-AR', { maximumFractionDigits: 1 })}%`;

/**
 * "−$ 30.606 y +$ 13.241": lo que se restó y se sumó a la comisión por rebotes.
 * El signo va siempre, aun en modo privacidad, para que se lea qué se ajustó.
 */
const AjustesRebotes = ({ r, hidden }: { r: DescuentoRebotes | null; hidden: boolean }) => {
    const menos = r?.descuento ?? 0;
    const mas = r?.bonificacion ?? 0;
    if (menos <= 0 && mas <= 0) return null;
    return (
        <span className="cv-ajustes">
            {menos > 0 && <span className="cv-ajuste-menos">−{fmtMoneyMaybe(menos, hidden)}</span>}
            {menos > 0 && mas > 0 && ' y '}
            {mas > 0 && <span className="cv-ajuste-mas">+{fmtMoneyMaybe(mas, hidden)}</span>}
        </span>
    );
};

export const ComisionesView = ({ isAdmin, viewPeriod, userCodVendedor }: Props) => {
    const [data, setData] = useState<ComisionesResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const [isPrivate, setIsPrivate] = useState<boolean>(() => {
        try { return localStorage.getItem(PRIVACY_STORAGE_KEY) === '1'; } catch { return false; }
    });

    const togglePrivate = () => {
        setIsPrivate(prev => {
            const next = !prev;
            try { localStorage.setItem(PRIVACY_STORAGE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
            return next;
        });
    };

    const load = async () => {
        if (abortRef.current) abortRef.current.abort();
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        setLoading(true); setErr(null);
        try {
            const params = new URLSearchParams();
            params.set('year', String(viewPeriod.year));
            params.set('month', String(viewPeriod.month));
            // asOfDay del PeriodSelector → corte hasta esa fecha (incluida).
            // Si no hay asOfDay, el endpoint trae todo el mes (incluyendo
            // facturas con fecha futura del mismo mes).
            if (viewPeriod.asOfDay != null) {
                const asOfDate = `${viewPeriod.year}-${String(viewPeriod.month).padStart(2, '0')}-${String(viewPeriod.asOfDay).padStart(2, '0')}`;
                params.set('asOfDate', asOfDate);
            }
            const res = await fetch(`/api/comisiones?${params.toString()}`, {
                headers: authHeaders(), signal: ctrl.signal,
            });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
            setData(j);
        } catch (e: any) {
            if (e.name === 'AbortError') return;
            setErr(e.message);
        } finally { setLoading(false); }
    };

    useEffect(() => {
        load();
        return () => { if (abortRef.current) abortRef.current.abort(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewPeriod.year, viewPeriod.month, viewPeriod.asOfDay]);

    const monthLabel = viewPeriod.asOfDay != null
        ? `${MONTH_NAMES[viewPeriod.month - 1]} ${viewPeriod.year} · al ${String(viewPeriod.asOfDay).padStart(2, '0')}/${String(viewPeriod.month).padStart(2, '0')}`
        : `${MONTH_NAMES[viewPeriod.month - 1]} ${viewPeriod.year}`;

    // Si vendedor, su única fila. Si admin, ranking + totales.
    const ownItem = !isAdmin && data
        ? data.items.find(v => v.cod_vendedor === userCodVendedor) ?? null
        : null;

    return (
        <div className="cv">
            <header className="cv-head">
                <div className="cv-head-l">
                    <DollarSign size={24} />
                    <h2>Comisiones · {monthLabel}</h2>
                </div>
                <div className="cv-head-actions">
                    <button
                        className="cv-refresh"
                        onClick={togglePrivate}
                        title={isPrivate ? 'Mostrar importes' : 'Ocultar importes (modo privacidad)'}
                        aria-pressed={isPrivate}
                    >
                        {isPrivate ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                    <button className="cv-refresh" onClick={load} disabled={loading} title="Refrescar">
                        {loading ? <Loader2 size={16} className="cv-spin" /> : <RefreshCw size={16} />}
                    </button>
                </div>
            </header>

            {err && <div className="cv-error"><AlertCircle size={16} /> {err}</div>}

            {data?.rebotes_error && (
                <div className="cv-error">
                    <AlertCircle size={16} /> No pude leer los rebotes: la comisión mostrada es BRUTA (sin el descuento del 3%). Reintentá en un rato.
                </div>
            )}

            {data?.premio_error && (
                <div className="cv-error">
                    <AlertCircle size={16} /> No pude leer los objetivos: el premio por objetivo no se está mostrando. Reintentá en un rato.
                </div>
            )}

            {loading && !data && (
                <div className="cv-loading"><Loader2 size={32} className="cv-spin" /> Calculando comisiones…</div>
            )}

            {data && !isAdmin && ownItem && (
                <SingleVendorPanel item={ownItem} categoriaLabels={data.categoria_labels} hidden={isPrivate} premioEstimado={!!data.premio_estimado} />
            )}

            {data && !isAdmin && !ownItem && (
                <div className="cv-empty">
                    <p>No registramos ventas para tu código de vendedor en {monthLabel}.</p>
                </div>
            )}

            {data && isAdmin && (
                <AdminPanel data={data} hidden={isPrivate} onReload={load} />
            )}
        </div>
    );
};

// ──────────────────────────── Vendedor: vista simple ────────────────────────

interface SingleProps { item: ComisionVendedor; categoriaLabels: Record<Categoria, string>; hidden: boolean; premioEstimado: boolean }
const SingleVendorPanel = ({ item, categoriaLabels, hidden, premioEstimado }: SingleProps) => {
    const descuento = item.rebotes?.descuento ?? 0;
    const bonificacion = item.rebotes?.bonificacion ?? 0;
    const ajusta = descuento > 0 || bonificacion > 0;
    return (
    <>
        <div className="cv-hero">
            <span className="cv-hero-label">Tu comisión acumulada</span>
            <strong className="cv-hero-amount">{fmtMoneyMaybe(item.comision_neta ?? item.comision_total, hidden)}</strong>
            <span className="cv-hero-sub">
                Sobre <strong>{fmtMoneyMaybe(item.neto_total, hidden)}</strong> facturado neto · {item.num_comprobantes} comprobantes · {item.num_lineas} líneas
            </span>
            {ajusta && item.rebotes && (
                <span className="cv-hero-rebotes">
                    <AjustesRebotes r={item.rebotes} hidden={hidden} />
                    <span className="cv-hero-rebotes-det">
                        Bruta {fmtMoneyMaybe(item.comision_total, hidden)}
                        {descuento > 0 && <> · −3% de {fmtMoneyMaybe(item.rebotes.total_rebotado, hidden)} mal cargado por vos ({item.rebotes.renglones} renglones)</>}
                        {bonificacion > 0 && <> · +3% de {fmtMoneyMaybe(item.rebotes.total_empresa ?? 0, hidden)} rebotado por la empresa / depósito ({item.rebotes.renglones_empresa ?? 0} renglones)</>}
                        {' '}— detalle en el tab Rebotes
                    </span>
                </span>
            )}
        </div>

        {item.premio && <PremioPanel premio={item.premio} aCobrar={item.comision_a_cobrar ?? item.comision_neta} hidden={hidden} estimado={premioEstimado} />}

        <div className="cv-breakdown">
            <h3>Detalle por categoría</h3>
            <table className="cv-table">
                <thead>
                    <tr>
                        <th>Categoría</th>
                        <th className="num">Neto</th>
                        <th className="num">Líneas</th>
                        <th className="num">Comisión</th>
                    </tr>
                </thead>
                <tbody>
                    {CATEGORIA_ORDER.map(cat => {
                        const e = item.breakdown[cat];
                        if (!e || e.lineas === 0) return null;
                        return (
                            <tr key={cat}>
                                <td>{categoriaLabels[cat]}</td>
                                <td className="num">{fmtMoneyMaybe(e.neto, hidden)}</td>
                                <td className="num">{e.lineas}</td>
                                <td className="num cv-strong">{fmtMoneyMaybe(e.comision, hidden)}</td>
                            </tr>
                        );
                    })}
                </tbody>
                <tfoot>
                    <tr>
                        <td>Total{ajusta ? ' (bruta)' : ''}</td>
                        <td className="num">{fmtMoneyMaybe(item.neto_total, hidden)}</td>
                        <td className="num">{item.num_lineas}</td>
                        <td className="num cv-strong">{fmtMoneyMaybe(item.comision_total, hidden)}</td>
                    </tr>
                    {ajusta && item.rebotes && (
                        <>
                            {descuento > 0 && (
                                <tr className="cv-rebotes-row">
                                    <td>Descuento rebotes (M.C. Vendedor)</td>
                                    <td className="num">{fmtMoneyMaybe(item.rebotes.total_rebotado, hidden)}</td>
                                    <td className="num">{item.rebotes.renglones}</td>
                                    <td className="num cv-rebotes-desc">−{fmtMoneyMaybe(descuento, hidden)}</td>
                                </tr>
                            )}
                            {bonificacion > 0 && (
                                <tr className="cv-rebotes-row--suma">
                                    <td>Rebotes empresa / depósito</td>
                                    <td className="num">{fmtMoneyMaybe(item.rebotes.total_empresa ?? 0, hidden)}</td>
                                    <td className="num">{item.rebotes.renglones_empresa ?? 0}</td>
                                    <td className="num cv-rebotes-suma">+{fmtMoneyMaybe(bonificacion, hidden)}</td>
                                </tr>
                            )}
                            <tr>
                                <td>Comisión neta</td>
                                <td className="num"></td>
                                <td className="num"></td>
                                <td className="num cv-strong">{fmtMoneyMaybe(item.comision_neta, hidden)}</td>
                            </tr>
                        </>
                    )}
                </tfoot>
            </table>
        </div>
    </>
    );
};

// ──────────────────── Premio por cumplimiento del objetivo ──────────────────
// Regla (Manolo, 06/10/2026 — ver server-lib/premioObjetivo.ts): 95% a <100% del
// objetivo en pesos → 7,5% de la comisión neta; 100% o más → 15%; a la mitad si no
// cumplió al menos 2 objetivos de producto. El cálculo lo hace el servidor.

const tramoTexto = (p: PremioObjetivo): string => {
    if (p.pct_cumplimiento == null) return 'Sin objetivo cargado este mes';
    const pct = fmtPct(p.pct_cumplimiento);
    if (p.tasa >= 0.15) return `${pct} del objetivo · 100% o más: 15% de la comisión neta`;
    if (p.tasa > 0) return `${pct} del objetivo · entre 95% y 100%: 7,5% de la comisión neta`;
    return `${pct} del objetivo · desde 95% cobra premio`;
};

const productosTexto = (p: PremioObjetivo): string => {
    if (p.productos_total === 0) return 'Sin objetivos de producto este mes';
    const base = `Objetivos de producto: ${p.productos_cumplidos} de ${p.productos_total} cumplidos`;
    return p.reducido ? `${base} (hacen falta 2): premio reducido 50%` : base;
};

interface PremioProps { premio: PremioObjetivo; aCobrar: number; hidden: boolean; estimado: boolean }
const PremioPanel = ({ premio, aCobrar, hidden, estimado }: PremioProps) => (
    <div className="cv-premio">
        <div className="cv-premio-head">
            <Trophy size={16} /> Premio por objetivo
            {estimado && <span className="cv-premio-tag">estimado al día de hoy</span>}
        </div>
        <strong className="cv-premio-amount">{fmtMoneyMaybe(premio.premio, hidden)}</strong>
        <span className="cv-premio-line">{tramoTexto(premio)}</span>
        <span className={`cv-premio-line${premio.reducido ? ' is-warn' : ''}`}>{productosTexto(premio)}</span>
        {premio.reducido && (
            <span className="cv-premio-line">Sin la reducción serían {fmtMoneyMaybe(premio.premio_bruto, hidden)}</span>
        )}
        <div className="cv-premio-total">
            <span>Comisión neta + premio</span>
            <strong>{fmtMoneyMaybe(aCobrar, hidden)}</strong>
        </div>
    </div>
);

// ──────────────────────────── Admin: ranking ────────────────────────────────

interface AdminProps { data: ComisionesResponse; hidden: boolean; onReload: () => void }
const AdminPanel = ({ data, hidden, onReload }: AdminProps) => {
    const [expanded, setExpanded] = useState<number | null>(null);
    return (
        <>
            <div className="cv-hero">
                <span className="cv-hero-label">Total equipo</span>
                <strong className="cv-hero-amount">{fmtMoneyMaybe(data.totales.comision_neta ?? data.totales.comision_total, hidden)}</strong>
                <span className="cv-hero-sub">
                    Sobre <strong>{fmtMoneyMaybe(data.totales.neto_total, hidden)}</strong> facturado neto · {data.totales.num_comprobantes} comprobantes
                    {(data.totales.rebotes_descuento ?? 0) > 0 && (
                        <> · <span className="cv-hero-menos">−{fmtMoneyMaybe(data.totales.rebotes_descuento!, hidden)}</span> por mal cargados</>
                    )}
                    {(data.totales.rebotes_bonificacion ?? 0) > 0 && (
                        <> · <span className="cv-hero-mas">+{fmtMoneyMaybe(data.totales.rebotes_bonificacion!, hidden)}</span> por rebotes de empresa</>
                    )}
                </span>
                {data.premio_rige && (data.totales.premio ?? 0) > 0 && (
                    <span className="cv-hero-sub">
                        Premios por objetivo{data.premio_estimado ? ' (estimado)' : ''} <strong>+{fmtMoneyMaybe(data.totales.premio!, hidden)}</strong>
                        {' '}· con premios <strong>{fmtMoneyMaybe(data.totales.comision_a_cobrar ?? 0, hidden)}</strong>
                    </span>
                )}
            </div>

            {data.items.length === 0 && (
                <div className="cv-empty"><p>Sin ventas registradas para los vendedores visibles en este período.</p></div>
            )}

            {data.items.length > 0 && (
                <div className="cv-ranking">
                    <h3><Trophy size={16} /> Ranking del mes</h3>
                    <table className="cv-table">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>Vendedor</th>
                                <th className="num">Neto</th>
                                <th className="num">Comprob.</th>
                                <th className="num">Comisión</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.items.map((v, i) => (
                                <Fragment key={v.cod_vendedor}>
                                    <tr className="cv-row" onClick={() => setExpanded(expanded === v.cod_vendedor ? null : v.cod_vendedor)}>
                                        <td className="cv-rank">{i + 1}</td>
                                        <td>{v.nombre}</td>
                                        <td className="num">{fmtMoneyMaybe(v.neto_total, hidden)}</td>
                                        <td className="num">{v.num_comprobantes}</td>
                                        <td className="num cv-strong">
                                            {fmtMoneyMaybe(v.comision_neta ?? v.comision_total, hidden)}
                                            {v.rebotes && ((v.rebotes.descuento ?? 0) > 0 || (v.rebotes.bonificacion ?? 0) > 0) && (
                                                <div className="cv-rebotes-min"><AjustesRebotes r={v.rebotes} hidden={hidden} /></div>
                                            )}
                                            {(v.premio?.premio ?? 0) > 0 && (
                                                <div className="cv-premio-min">+{fmtMoneyMaybe(v.premio!.premio, hidden)} premio</div>
                                            )}
                                        </td>
                                    </tr>
                                    {expanded === v.cod_vendedor && (
                                        <tr className="cv-detail">
                                            <td colSpan={5}>
                                                <div className="cv-detail-grid">
                                                    {CATEGORIA_ORDER.map(cat => {
                                                        const e = v.breakdown[cat];
                                                        if (!e || e.lineas === 0) return null;
                                                        return (
                                                            <div key={cat} className="cv-detail-cat">
                                                                <span className="cv-detail-cat-name">{data.categoria_labels[cat]}</span>
                                                                <span className="cv-detail-cat-neto">Neto {fmtMoneyMaybe(e.neto, hidden)} · {e.lineas} líneas</span>
                                                                <strong className="cv-detail-cat-com">{fmtMoneyMaybe(e.comision, hidden)}</strong>
                                                            </div>
                                                        );
                                                    })}
                                                    {(v.rebotes?.descuento ?? 0) > 0 && (
                                                        <div className="cv-detail-cat cv-detail-cat--rebotes">
                                                            <span className="cv-detail-cat-name">Rebotes M.C. Vendedor</span>
                                                            <span className="cv-detail-cat-neto">Mal cargado {fmtMoneyMaybe(v.rebotes!.total_rebotado, hidden)} · {v.rebotes!.renglones} renglones</span>
                                                            <strong className="cv-detail-cat-com cv-rebotes-desc">−{fmtMoneyMaybe(v.rebotes!.descuento, hidden)}</strong>
                                                        </div>
                                                    )}
                                                    {(v.rebotes?.bonificacion ?? 0) > 0 && (
                                                        <div className="cv-detail-cat cv-detail-cat--suma">
                                                            <span className="cv-detail-cat-name">Rebotes empresa / depósito</span>
                                                            <span className="cv-detail-cat-neto">Rebotado {fmtMoneyMaybe(v.rebotes!.total_empresa ?? 0, hidden)} · {v.rebotes!.renglones_empresa ?? 0} renglones</span>
                                                            <strong className="cv-detail-cat-com cv-rebotes-suma">+{fmtMoneyMaybe(v.rebotes!.bonificacion ?? 0, hidden)}</strong>
                                                        </div>
                                                    )}
                                                    {v.premio && (
                                                        <div className="cv-detail-cat cv-detail-cat--premio">
                                                            <span className="cv-detail-cat-name">Premio por objetivo{data.premio_estimado ? ' (estimado)' : ''}</span>
                                                            <span className="cv-detail-cat-neto">{tramoTexto(v.premio)} · {productosTexto(v.premio)}</span>
                                                            <strong className="cv-detail-cat-com">+{fmtMoneyMaybe(v.premio.premio, hidden)}</strong>
                                                        </div>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                </Fragment>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <OverridesAdmin onReload={onReload} />
        </>
    );
};

// ──────────────────────── Admin: overrides de vendedor ───────────────────────
// Reasigna un comprobante a otro vendedor para comisiones/avance, cuando la
// factura se emitió en IM con el vendedor equivocado y no se puede editar allá.

interface OverridesProps { onReload: () => void }
const OverridesAdmin = ({ onReload }: OverridesProps) => {
    const [open, setOpen] = useState(false);
    const [items, setItems] = useState<OverrideItem[]>([]);
    const [listErr, setListErr] = useState<string | null>(null);
    const [loadingList, setLoadingList] = useState(false);

    // Formulario de alta.
    const [idComp, setIdComp] = useState('');
    const [codVend, setCodVend] = useState<number>(VENDEDORES_OVERRIDE[VENDEDORES_OVERRIDE.length - 1].cod); // default Brian
    const [motivo, setMotivo] = useState('');
    const [saving, setSaving] = useState(false);
    const [formErr, setFormErr] = useState<string | null>(null);

    const [recalc, setRecalc] = useState<string | null>(null);

    const loadList = useCallback(async () => {
        setLoadingList(true); setListErr(null);
        try {
            const res = await fetch('/api/comisiones/overrides', { headers: authHeaders() });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
            setItems(j.items ?? []);
        } catch (e: any) {
            setListErr(e.message);
        } finally { setLoadingList(false); }
    }, []);

    // Carga la lista la primera vez que se abre la sección.
    useEffect(() => { if (open && items.length === 0 && !listErr) loadList(); }, [open, items.length, listErr, loadList]);

    const save = async () => {
        const id = Number(idComp.trim());
        if (!Number.isInteger(id) || id <= 0) { setFormErr('Ingresá un N° de comprobante válido (el "id" del comprobante en IM).'); return; }
        setSaving(true); setFormErr(null);
        try {
            const res = await fetch('/api/comisiones/overrides', {
                method: 'POST',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ id_comprobante: id, cod_vendedor: codVend, motivo: motivo.trim() || null }),
            });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
            setIdComp(''); setMotivo('');
            await loadList();
            onReload(); // refresca el ranking de comisiones (el override aplica en vivo)
        } catch (e: any) {
            setFormErr(e.message);
        } finally { setSaving(false); }
    };

    const remove = async (id: number) => {
        setListErr(null);
        try {
            const res = await fetch(`/api/comisiones/overrides/${id}`, { method: 'DELETE', headers: authHeaders() });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
            await loadList();
            onReload();
        } catch (e: any) {
            setListErr(e.message);
        }
    };

    // Re-agrega vendor_sales_monthly de los meses recientes para que el panel de
    // Objetivos/avance también refleje los overrides (Comisiones ya aplica en vivo).
    const recalcularAvance = async () => {
        setRecalc('Recalculando avance en segundo plano… puede tardar ~30s. Refrescá Objetivos en un momento.');
        try {
            const res = await fetch('/api/goals/backfill', {
                method: 'POST',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ months: 3 }),
            });
            const j = await res.json();
            if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        } catch (e: any) {
            setRecalc(`No se pudo arrancar el recálculo: ${e.message}`);
        }
    };

    return (
        <section className="cv-ov">
            <button className="cv-ov-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}>
                <span><Replace size={15} /> Reasignar comprobantes (override de vendedor)</span>
                {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>

            {open && (
                <div className="cv-ov-body">
                    <p className="cv-ov-hint">
                        Cuando una factura se emitió en InfoManager con el vendedor equivocado y no se puede editar,
                        reasignala acá: la venta pasa a contarse para el vendedor correcto en Comisiones y Avance.
                        No toca InfoManager ni la cuenta corriente.
                    </p>

                    <div className="cv-ov-form">
                        <label className="cv-ov-field">
                            <span>N° comprobante (id)</span>
                            <input
                                type="number" inputMode="numeric" placeholder="57546720"
                                value={idComp} onChange={e => setIdComp(e.target.value)}
                            />
                        </label>
                        <label className="cv-ov-field">
                            <span>Asignar a</span>
                            <select value={codVend} onChange={e => setCodVend(Number(e.target.value))}>
                                {VENDEDORES_OVERRIDE.map(v => (
                                    <option key={v.cod} value={v.cod}>{v.nombre} ({v.cod})</option>
                                ))}
                            </select>
                        </label>
                        <label className="cv-ov-field cv-ov-field-wide">
                            <span>Motivo (opcional)</span>
                            <input
                                type="text" placeholder="Ej: cliente de Brian, FA salió con Marcelo"
                                value={motivo} onChange={e => setMotivo(e.target.value)}
                            />
                        </label>
                        <button className="cv-ov-add" onClick={save} disabled={saving}>
                            {saving ? <Loader2 size={15} className="cv-spin" /> : <Plus size={15} />} Guardar
                        </button>
                    </div>
                    {formErr && <div className="cv-error"><AlertCircle size={16} /> {formErr}</div>}

                    {listErr && <div className="cv-error"><AlertCircle size={16} /> {listErr}</div>}
                    {loadingList && <div className="cv-ov-loading"><Loader2 size={16} className="cv-spin" /> Cargando…</div>}

                    {!loadingList && items.length === 0 && !listErr && (
                        <p className="cv-ov-empty">No hay reasignaciones cargadas.</p>
                    )}

                    {items.length > 0 && (
                        <table className="cv-table cv-ov-table">
                            <thead>
                                <tr>
                                    <th>Comprob.</th>
                                    <th>De → A</th>
                                    <th>Motivo</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {items.map(o => (
                                    <tr key={o.id_comprobante}>
                                        <td>{o.id_comprobante}</td>
                                        <td>{vendorName(o.cod_vendedor_original)} → <strong className="cv-strong">{vendorName(o.cod_vendedor)}</strong></td>
                                        <td className="cv-ov-motivo">{o.motivo ?? '—'}</td>
                                        <td className="num">
                                            <button className="cv-ov-del" onClick={() => remove(o.id_comprobante)} title="Eliminar reasignación">
                                                <Trash2 size={14} />
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}

                    <div className="cv-ov-recalc">
                        <button className="cv-ov-recalc-btn" onClick={recalcularAvance}>
                            <RefreshCw size={14} /> Recalcular avance (Objetivos)
                        </button>
                        <span className="cv-ov-recalc-hint">
                            Comisiones aplica el cambio al instante. Para que el panel de Objetivos también lo refleje, recalculá.
                        </span>
                    </div>
                    {recalc && <div className="cv-ov-recalc-msg">{recalc}</div>}
                </div>
            )}
        </section>
    );
};
