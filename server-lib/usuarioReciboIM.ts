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

/** El login de IM de quien aprueba; si no lo tiene cargado, el de la app. */
export function usuarioIMDelAprobador(fila: { im_usuario?: string | null } | null | undefined, porDefecto: string): string {
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
