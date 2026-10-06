import type { Request, Response } from 'express';
import type { JwtPayload } from './auth.js';
import { sb, TENANT_ID } from './supabase.js';
import { fechaArgentina } from './infomanager.js';
import { frenaSiNoPuede } from './facturarPresupuestos.js';

/**
 * ⏱️ 06/10/2026 — "HAY N PRESUPUESTOS NUEVOS" (punto 5, sí de Mati vía el Integrador).
 *
 * Jorgelina apretaba Actualizar cada uno o dos minutos para ver si entraban pedidos, y cada vez
 * eran 8 a 13 s contra InfoManager. Esto contesta lo mismo sin tocar IM: el 96% de los
 * presupuestos sale de la app de vendedores (233 de 243 entre el 28/09 y el 09/10), y ésa deja el
 * id del presupuesto en `pedidos_vendedor`. Es una consulta a Supabase.
 *
 * 🪤 No cuenta los que se cargan a mano en InfoManager (el otro 4%): el aviso es una ayuda, no
 * reemplaza a Actualizar. Y sólo avisa si el rango incluye hoy: los pedidos nuevos son de hoy.
 */

/** Tope de ids que se devuelven: la pantalla sólo muestra cuántos son. */
const MAXIMO = 200;

export async function novedadesFacturacion(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  const fecha = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null;
  const desde = fecha(req.query.desde), hasta = fecha(req.query.hasta);
  const leidoAt = String(req.query.leido_at ?? '');
  if (!desde || !hasta || !Number.isFinite(Date.parse(leidoAt))) {
    res.status(400).json({ error: 'Faltan el rango o el momento de la última lectura.' });
    return;
  }
  const hoy = fechaArgentina();
  if (hoy < desde || hoy > hasta) { res.json({ ok: true, ids: [] }); return; }
  /**
   * `updated_at` y no `created_at`: un borrador se crea antes y recibe el presupuesto al enviarse.
   * Lo que se actualizó por otro motivo y ya está en pantalla lo descarta la pantalla, que es la
   * que sabe qué está mostrando.
   */
  const { data, error } = await sb().from('pedidos_vendedor').select('im_presupuesto_id')
    .eq('tenant_id', TENANT_ID).eq('estado', 'enviado')
    .eq('cod_empresa', Number(process.env.PEDIDO_EMPRESA_DEFAULT || 1))
    .not('im_presupuesto_id', 'is', null)
    .gt('updated_at', new Date(leidoAt).toISOString())
    .limit(MAXIMO);
  if (error) { res.status(502).json({ error: `No pude consultar los pedidos nuevos: ${error.message}` }); return; }
  res.json({ ok: true, ids: [...new Set((data ?? []).map((f: any) => String(f.im_presupuesto_id).trim()))] });
}
