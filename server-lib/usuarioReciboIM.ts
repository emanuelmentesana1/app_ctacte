/**
 * Con qué usuario de InfoManager se emite un recibo. Lógica pura, sin side-effects (recibos.ts
 * hace process.exit al importarse sin variables de entorno: acá se testea solo).
 *
 * S32 · mejora 5 (Mati, 04/10/2026): *"los recibos tienen que entrar a IM con el usuario de QUIEN
 * APRUEBA"*. Hasta hoy entraban todos con el usuario de la app ("matias") y en IM no se sabía
 * quién los aprobó. No hacen falta credenciales por persona: la API entra con las de la app y
 * `usuario` es un campo del recibo que tiene que existir en IM. El login de cada persona ya está
 * en `usuarios.im_usuario` (migración 026; Anto = "anto") y Pedidos lo usa igual.
 */

/**
 * Quien cobra con una caja propia en IM. Mati (06/10/2026): lo que aprueba Jorgelina tiene que salir con
 * "CONY CAJA", su usuario de caja, para que le impacte en su caja y pueda hacer sus rendiciones. En IM,
 * CONY CAJA es quien carga los recibos de la Caja Chica 2 (verificado el 06/10 en una muestra de recibos).
 * 🪤 Va aparte de `usuarios.im_usuario`: "jorgelina" también lo usan facturar, editar facturas y las notas,
 * y ahí IM exige un usuario con el punto de venta vinculado.
 */
const CAJA_PROPIA: Record<string, { usuario: string; cuenta: string }> = {
    jorgelina: { usuario: 'CONY CAJA', cuenta: '1110004' },
};

/** El usuario de caja y la cuenta de efectivo propios de quien aprueba; null si no tiene. */
export function cajaDelAprobador(fila: { im_usuario?: string | null } | null | undefined): { usuario: string; cuenta: string } | null {
    return CAJA_PROPIA[String(fila?.im_usuario ?? '').trim()] ?? null;
}

/** El login de IM de quien aprueba (su usuario de caja, si tiene); si no lo tiene cargado, el de la app. */
export function usuarioIMDelAprobador(fila: { im_usuario?: string | null } | null | undefined, porDefecto: string): string {
    const caja = cajaDelAprobador(fila);
    if (caja) return caja.usuario;
    const propio = String(fila?.im_usuario ?? '').trim();
    return propio || porDefecto;
}

/**
 * ¿IM rechazó el recibo POR el usuario? Sólo en ese caso tiene sentido reintentar con el de la
 * app: cualquier otro rechazo (importes, facturas) se repetiría igual.
 */
export function esRechazoPorUsuario(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') return false;
    return /usuario/i.test(JSON.stringify(raw));
}
