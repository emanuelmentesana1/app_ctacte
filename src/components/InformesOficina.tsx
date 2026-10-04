import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';
import './InformesOficina.css';

/**
 * LO QUE TIENE QUE VER OTRA PERSONA, fuera de la pantalla de Jo.
 *
 * Mati (04/10/2026), al aprobar la limpieza de avisos: los precios por debajo de lista son para
 * él, los faltantes de stock para el depósito y los clientes sin zona para quien los carga en
 * InfoManager. *"Dejalos armados en la app o como archivo, pero NO los mandes por Slack ni
 * Telegram sin preguntar"*: acá se ven y se bajan en CSV; no se mandan a ningún lado.
 */
export interface SeccionInforme {
    clave: string;
    titulo: string;
    para: string;
    columnas: string[];
    filas: Array<Array<string | number>>;
    vacio: string;
}

const celda = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export function InformesOficina({ titulo, secciones, onCerrar }: { titulo: string; secciones: SeccionInforme[]; onCerrar: () => void }) {
    const [activa, setActiva] = useState(secciones[0]?.clave);
    const s = secciones.find(x => x.clave === activa) ?? secciones[0];
    useEffect(() => {
        const tecla = (e: KeyboardEvent) => { if (e.key === 'Escape') onCerrar(); };
        window.addEventListener('keydown', tecla);
        return () => window.removeEventListener('keydown', tecla);
    }, [onCerrar]);
    function bajarCsv() {
        if (!s?.filas.length) return;
        // Punto y coma y BOM: así lo abre bien el Excel en castellano.
        const texto = '﻿' + [s.columnas, ...s.filas].map(f => f.map(celda).join(';')).join('\n');
        const url = URL.createObjectURL(new Blob([texto], { type: 'text/csv;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url; a.download = `${s.clave}.csv`; a.click();
        URL.revokeObjectURL(url);
    }
    if (!s) return null;
    return (
        <div className="inf-fondo" onClick={onCerrar}>
            <div className="inf-modal" role="dialog" aria-label={titulo} onClick={e => e.stopPropagation()}>
                <header>
                    <h3>{titulo}</h3>
                    <button type="button" onClick={onCerrar} aria-label="Cerrar los informes"><X size={18} /></button>
                </header>
                <nav className="inf-secciones">
                    {secciones.map(x => (
                        <button type="button" key={x.clave} className={x.clave === s.clave ? 'on' : ''} onClick={() => setActiva(x.clave)}>
                            {x.titulo} <b>{x.filas.length}</b>
                        </button>
                    ))}
                </nav>
                <p className="inf-para">Para {s.para}. No se manda a nadie: queda acá.</p>
                {s.filas.length ? (
                    <div className="inf-tabla">
                        <table>
                            <thead><tr>{s.columnas.map(c => <th key={c}>{c}</th>)}</tr></thead>
                            <tbody>{s.filas.map((f, i) => <tr key={i}>{f.map((v, j) => <td key={j}>{v}</td>)}</tr>)}</tbody>
                        </table>
                    </div>
                ) : <p className="inf-vacio">{s.vacio}</p>}
                <footer>
                    <button type="button" className="inf-csv" onClick={bajarCsv} disabled={!s.filas.length}><Download size={14} /> Bajar CSV</button>
                </footer>
            </div>
        </div>
    );
}
