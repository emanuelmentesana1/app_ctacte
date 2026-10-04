/**
 * ¿Los recibos que emitió la app siguen en InfoManager? Lógica pura.
 *
 * S32 · mejora 7 (04/10/2026). En septiembre, 3 recibos emitidos por la app ya no existían en IM
 * (los borraron allá; dos se volvieron a cargar a mano, uno en otra caja y con otra fecha) y la
 * app los seguía mostrando como imputados. `GET /api/v2/recibos` no lista los anulados ni los
 * borrados: el que falta es justamente el que hay que mirar.
 */
export interface ImputadoApp {
    id: string;
    cod_cliente: number;
    monto: number;
    fecha_comprobante: string | null;
    infomanager_recibo_id: string | null;
    imputado_at: string | null;
    cod_empresa: number | null;
    reviewed_by_nombre?: string | null;
}

/** Lo recién emitido puede tardar en verse: no se juzga hasta pasados 10 minutos. */
const MARGEN_MS = 10 * 60_000;

export function recibosQueFaltanEnIM(app: ImputadoApp[], enIM: Array<{ id_recibo: number | string }>, ahora = Date.now()): ImputadoApp[] {
    const vivos = new Set(enIM.map(r => String(r.id_recibo)));
    return app.filter(r => r.infomanager_recibo_id
        && !(r.imputado_at && ahora - Date.parse(r.imputado_at) < MARGEN_MS)
        && !vivos.has(String(r.infomanager_recibo_id)));
}
