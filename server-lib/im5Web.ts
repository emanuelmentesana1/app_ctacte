/**
 * La API INTERNA de la web de IM5 (la que usa la pantalla de InfoManager), no la API oficial. Sólo para lo que la
 * oficial no hace: corregir un recibo ya emitido (Mati, 06/10/2026).
 *
 * Entra con el usuario de IM5 de Mati: `IM5_USUARIO` / `IM5_PASSWORD`, cargadas por él en EasyPanel (decisión de Mati:
 * por ahora su usuario; más adelante uno general). El resto tiene valor de fábrica, leído de la pantalla el 06/10/2026:
 * el código técnico de la base, la versión de la web (v1.0.436) y un id de dispositivo propio del servidor (la pantalla
 * manda el suyo en `x-im5-cliente` y en la cookie `im5_cliente`).
 *
 * 🪤 Es una API sin documentar: una versión nueva de IM5 la puede cambiar. Si el login empieza a fallar por la versión,
 * se ajusta `IM5_VERSION` (la manda la pantalla al entrar).
 */
import type { DetalleReciboIM5 } from './im5Recibos.js';

const BASE = (process.env.IM5_URL || 'https://app.infomanager.com.ar/IM5').replace(/\/$/, '');
const CLIENTE = process.env.IM5_CLIENTE || 'f9298c44-d4b7-49bc-8769-4b277e003aa0';

export const im5Configurado = () => !!(process.env.IM5_USUARIO && process.env.IM5_PASSWORD);

export class ErrorIM5 extends Error {
    /** true = IM5 no contestó: no se sabe si lo pedido se hizo. */
    constructor(mensaje: string, public status: number, public sinRespuesta = false) { super(mensaje); }
}

const encabezados = (token?: string) => ({
    'Content-Type': 'application/json', Accept: 'application/json', 'x-im5-cliente': CLIENTE, Cookie: `im5_cliente=${CLIENTE}`,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

let token: string | null = null;

async function entrar(): Promise<string> {
    if (!im5Configurado()) throw new ErrorIM5('Faltan IM5_USUARIO e IM5_PASSWORD en el servidor: no puedo entrar a IM5.', 503);
    let r: Response;
    try {
        r = await fetch(`${BASE}/api/auth/login`, {
            method: 'POST', headers: encabezados(), signal: AbortSignal.timeout(20_000),
            body: JSON.stringify({
                base: process.env.IM5_TECNICO || 'elmanantialsrl_base', usuario: process.env.IM5_USUARIO, clave: process.env.IM5_PASSWORD,
                version: process.env.IM5_VERSION || 'v1.0.436', basePath: '/IM5',
            }),
        });
    } catch (e) { throw new ErrorIM5(`IM5 no contestó al entrar (${e instanceof Error ? e.message : String(e)}).`, 502, true); }
    const d = await r.json().catch(() => null) as { token?: string; error?: string; mensaje?: string } | null;
    if (!r.ok || !d?.token) throw new ErrorIM5(`IM5 no dejó entrar (${r.status}${d?.error || d?.mensaje ? `: ${d.error || d.mensaje}` : ''}).`, 502);
    return d.token;
}

async function pedir<T>(metodo: 'GET' | 'PUT' | 'POST', ruta: string, cuerpo?: unknown): Promise<T> {
    for (let intento = 0; intento < 2; intento++) {
        token ??= await entrar();
        let r: Response;
        try {
            r = await fetch(`${BASE}${ruta}`, {
                method: metodo, headers: encabezados(token), signal: AbortSignal.timeout(30_000),
                body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
            });
        } catch (e) {
            // 🔴 Sin respuesta no se sabe si IM5 lo grabó: quien llama verifica releyendo, no reintenta a ciegas.
            throw new ErrorIM5(`IM5 no contestó (${e instanceof Error ? e.message : String(e)}).`, 502, true);
        }
        // Sesión vencida: se entra de nuevo UNA vez. Con 401 IM5 no grabó nada.
        if (r.status === 401 && intento === 0) { token = null; continue; }
        const d = await r.json().catch(() => null) as ({ success?: boolean; error?: string; mensaje?: string } & T) | null;
        if (!r.ok || !d || d.success === false) throw new ErrorIM5(`IM5 rechazó el pedido (${r.status}${d?.error || d?.mensaje ? `: ${d.error || d.mensaje}` : ''}).`, r.status === 404 ? 404 : 502);
        return d as T;
    }
    throw new ErrorIM5('IM5 no aceptó la sesión.', 502);
}

export const im5 = {
    /** El detalle de un comprobante: cabecera, facturas imputadas y pagos. */
    comprobante: (id: string) => pedir<DetalleReciboIM5>('GET', `/api/comprobantes/${encodeURIComponent(id)}`),
    /** Graba la edición de un recibo (mismo número). El cuerpo lo arma `cuerpoEdicionRecibo`. */
    editarRecibo: (id: string, cuerpo: unknown) => pedir<{ success: boolean; id?: number }>('PUT', `/api/comprobantes/recibo/${encodeURIComponent(id)}`, cuerpo),
};
