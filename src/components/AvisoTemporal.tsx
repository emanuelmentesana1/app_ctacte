import { useEffect, useRef } from 'react';
import { Check, X } from 'lucide-react';
import './AvisoTemporal.css';

/**
 * El mensaje de después de una acción que salió bien ("Pedido anulado", "Enlace copiado"): se va
 * solo a los 5 segundos.
 *
 * Mati (04/10/2026): *"siento que todavía hay demasiados carteles, avisos y mensajes en la app de
 * facturación y hojas de ruta; debe estar mareando a Jo"*. Antes estos mensajes quedaban fijos
 * arriba de la lista hasta que alguien tocaba la ✕.
 *
 * 🔑 Los errores NO van acá: un error se queda hasta que alguien lo lea y lo cierre.
 */
export function AvisoTemporal({ texto, onCerrar, segundos = 5 }: { texto: string | null; onCerrar: () => void; segundos?: number }) {
    // 🪤 El padre pasa una función nueva en cada render: con ella en las dependencias, el reloj
    // volvería a cero con cada render y el mensaje no se iría nunca.
    const cerrar = useRef(onCerrar);
    cerrar.current = onCerrar;
    useEffect(() => {
        if (!texto) return;
        const reloj = setTimeout(() => cerrar.current(), segundos * 1000);
        return () => clearTimeout(reloj);
    }, [texto, segundos]);
    if (!texto) return null;
    return (
        <div className="aviso-temporal" role="status">
            <Check size={15} />
            <span>{texto}</span>
            <button type="button" onClick={() => cerrar.current()} aria-label="Cerrar el mensaje"><X size={14} /></button>
        </div>
    );
}
