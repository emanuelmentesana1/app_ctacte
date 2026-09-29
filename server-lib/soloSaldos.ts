import { sb } from './supabase.js';

/**
 * "Saldos de clientes" — Cuenta Corriente en modo SÓLO CONSULTA DE DEUDA (29/09/2026).
 *
 * Nació para la tablet compartida de Casa Central. Con el rol administrativo veía la cartera
 * entera, los objetivos, las comisiones y el ranking de cada vendedor, en un aparato que queda a
 * mano de cualquiera. Mati: *"a lo sumo que se vea solo la deuda de los clientes"*.
 *
 * 🔑 Se administra desde el PANEL, como el resto de los permisos: es el módulo `ctacte_saldos`
 * en `modulos`, y se le da a una persona desde la pantalla Accesos. Ningún rol lo trae por
 * defecto, así que hoy no le cambia nada a nadie que no lo tenga puesto a mano. Si alguien
 * tiene los dos (Cuenta Corriente y Saldos), manda el más restrictivo: es una marca explícita.
 *
 * 🔴 El recorte vive en el SERVIDOR. Esconder pestañas en la pantalla no alcanza: fuera del
 * repartidor, ninguna ruta mira el rol, y `/api/goals` o `/api/notificaciones` se le devuelven
 * enteras a quien las pida a mano.
 */
export const MODULO_SOLO_SALDOS = 'ctacte_saldos';

/**
 * Lo único que puede pedir alguien de sólo saldos. Lista BLANCA y ruta ENTERA (sin prefijos),
 * con el mismo criterio que `permisos.ts`: lo que se agregue mañana a la app no se le abre
 * hasta que alguien lo nombre acá.
 */
const PERMITIDAS = new Set<string>([
    'GET /api/me',             // quién soy (y esta misma marca)
    'GET /api/data',           // facturas y saldos: ES la deuda
    'POST /api/telemetria/vista', // qué pestaña abrió; no expone nada
]);

export function rutaPermitidaSoloSaldos(method: string, url: string): boolean {
    const ruta = url.split('?')[0].replace(/\/+$/, '');
    return PERMITIDAS.has(`${method.toUpperCase()} ${ruta}`);
}

/** Las dos lecturas que hacen falta, separadas para poder probar la regla sin base. */
export interface ConsultaModulos {
    propio(usuarioId: string): Promise<{ error: boolean; habilitado?: boolean | null }>;
    porRol(rol: string): Promise<{ error: boolean; tiene?: boolean }>;
}

const consultaSupabase: ConsultaModulos = {
    async propio(usuarioId) {
        const { data, error } = await sb().from('usuario_modulos').select('habilitado')
            .eq('usuario_id', usuarioId).eq('modulo', MODULO_SOLO_SALDOS).maybeSingle();
        if (error) return { error: true };
        return { error: false, habilitado: data ? !!data.habilitado : null };
    },
    async porRol(rol) {
        const { data, error } = await sb().from('rol_modulos').select('modulo')
            .eq('rol', rol).eq('modulo', MODULO_SOLO_SALDOS).maybeSingle();
        if (error) return { error: true };
        return { error: false, tiene: !!data };
    },
};

/**
 * ¿Esta persona está en modo sólo saldos? La MISMA regla que usa el panel para dibujar los
 * módulos (y que copian inventario y el BI en su `tieneModulo`): la excepción por persona manda
 * y, si no hay, decide el rol.
 *
 * Devuelve `null` si la base no contestó. No es `false` a propósito: `false` dejaría ver todo a
 * la tablet justo cuando Supabase tiene un bache.
 */
export async function esSoloSaldos(
    user: { sub?: string; rol?: string } | undefined | null,
    consulta: ConsultaModulos = consultaSupabase,
): Promise<boolean | null> {
    if (!user?.sub) return false;
    const propio = await consulta.propio(user.sub);
    if (propio.error) return null;
    if (propio.habilitado != null) return propio.habilitado;
    if (!user.rol) return false;
    const porRol = await consulta.porRol(user.rol);
    if (porRol.error) return null;
    return !!porRol.tiene;
}

/**
 * Lo mismo con un minuto de memoria: el candado corre en CADA pedido a /api y no vale la pena
 * ir a la base cada vez. Un cambio en Accesos tarda como mucho un minuto en llegar.
 * Los `null` (base caída) no se guardan: el próximo pedido vuelve a preguntar.
 */
const MEMORIA_MS = 60_000;
const memoria = new Map<string, { valor: boolean; vence: number }>();

export async function esSoloSaldosConMemoria(user: { sub?: string; rol?: string } | undefined | null): Promise<boolean | null> {
    if (!user?.sub) return false;
    const clave = `${user.sub}|${user.rol ?? ''}`;
    const hit = memoria.get(clave);
    if (hit && hit.vence > Date.now()) return hit.valor;
    const valor = await esSoloSaldos(user);
    if (valor != null) memoria.set(clave, { valor, vence: Date.now() + MEMORIA_MS });
    return valor;
}
