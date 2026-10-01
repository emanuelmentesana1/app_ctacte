-- Migration 055 — Mercadería ya facturada que viaja con un pedido nuevo (01/10/2026). Idempotente.
--
-- Mati: *"este presupu tiene articulos cargados a mano sin costo, esto pasa porque es mercaderia
-- que ya estaba facturada y remitida antes.. y jo la agrega unicamente para que la puedan cargar en
-- la parte de logistica, no hay que facturarla de nuevo"*. Eligió que los guarde la app y que salgan
-- en el papel que firma el cliente.
--
-- Hasta ahora se escribían en InfoManager como renglones SIN código en $0 ("MAIZ LEALES 25
-- PENDIENTE"): 24 presupuestos en septiembre. Tres problemas, los tres por la API de IM, que exige
-- `cod_articulo` en todo renglón:
--   · rehacer el presupuesto los borraba, así que la app se negaba a agregarle un producto
--     (CARDENES, PR 59080, 01/10/2026);
--   · desde que la app factura (09/09) no salen en la factura ni en el remito: el cliente no firma
--     en ningún papel que los recibió;
--   · la hoja de ruta no los ve: no suman bultos ni kilos al camión.
--
-- Ahora viven acá, colgados del presupuesto con el que viajan. Nunca van a InfoManager: no se
-- facturan y no mueven stock (ya lo movió el remito original).
begin;

create table if not exists pendientes_entrega (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  -- El presupuesto con el que viaja. Si se rehace, la app los pasa al nuevo.
  im_comprobante_id text not null,
  -- El renglón escrito a mano en InfoManager del que salió, si salió de ahí. Es lo que evita
  -- pasarlo dos veces (un reintento de facturar) y mostrarlo repetido mientras sigue en IM.
  im_renglon_id text,
  -- Con artículo la hoja de ruta sabe cuánto pesa; sin artículo es sólo el texto que venía de IM.
  cod_articulo int check (cod_articulo is null or cod_articulo > 0),
  descripcion text not null check (length(btrim(descripcion)) between 1 and 200),
  cantidad numeric(14,3) not null check (cantidad > 0),
  -- De qué factura sale ("FA B 50680"). Texto libre: es para quien lo lee, no para cruzar datos.
  factura_ref text check (factura_ref is null or length(factura_ref) <= 60),
  orden int not null default 0,
  creado_por uuid,
  created_at timestamptz not null default now()
);

-- Se consulta siempre por presupuesto: "qué más lleva éste".
create index if not exists pendientes_entrega_comprobante_idx
  on pendientes_entrega (tenant_id, im_comprobante_id);

-- 🪤 Un renglón de IM se pasa UNA vez a cada presupuesto. Índice completo y no parcial: el
-- `on conflict` de PostgREST no sabe nombrar el predicado de un índice parcial. Los NULL no chocan
-- entre sí, así que lo cargado en la app (sin renglón de IM) no tiene tope.
create unique index if not exists pendientes_entrega_renglon_uidx
  on pendientes_entrega (tenant_id, im_comprobante_id, im_renglon_id);

alter table pendientes_entrega enable row level security;
drop policy if exists pendientes_entrega_service on pendientes_entrega;
create policy pendientes_entrega_service on pendientes_entrega for all to service_role using (true) with check (true);

/**
 * Deja en `p_destino` EXACTAMENTE la lista que se manda, y nada de `p_origen`.
 *
 * Es una sola transacción a propósito. Al rehacer un presupuesto, mover lo que ya había y sumar
 * los renglones de IM son dos escrituras: separadas, un corte entre las dos deja el presupuesto
 * nuevo sin la mitad de sus pendientes, y como el viejo se anula después, no queda de dónde
 * sacarlos. Así, o queda todo o no cambia nada (y la app anula el nuevo en vez del viejo).
 *
 * `p_origen` = `p_destino` cuando sólo se edita la lista; distinto cuando se rehízo el presupuesto.
 * Cada elemento: {descripcion, cantidad, cod_articulo?, factura_ref?, im_renglon_id?, creado_por?,
 * created_at?}. Quién lo cargó y cuándo se conservan: la app los manda de las filas que ya había.
 */
create or replace function guardar_pendientes_entrega(
  p_tenant uuid, p_destino text, p_origen text, p_lista jsonb, p_usuario uuid
) returns integer language plpgsql security invoker set search_path = public as $$
declare
  v_n integer;
begin
  if p_destino is null or p_destino !~ '^[0-9]+$' then
    raise exception 'presupuesto inválido: %', p_destino using errcode = '22023';
  end if;
  if p_lista is null or jsonb_typeof(p_lista) <> 'array' then
    raise exception 'la lista de pendientes tiene que ser un array' using errcode = '22023';
  end if;

  delete from pendientes_entrega
   where tenant_id = p_tenant
     and im_comprobante_id in (p_destino, coalesce(p_origen, p_destino));

  insert into pendientes_entrega
    (tenant_id, im_comprobante_id, im_renglon_id, cod_articulo, descripcion, cantidad, factura_ref, orden, creado_por, created_at)
  select p_tenant, p_destino,
         nullif(btrim(x->>'im_renglon_id'), ''),
         nullif(x->>'cod_articulo', '')::int,
         btrim(x->>'descripcion'),
         (x->>'cantidad')::numeric,
         nullif(btrim(x->>'factura_ref'), ''),
         (t.ord - 1)::int,
         coalesce(nullif(x->>'creado_por', '')::uuid, p_usuario),
         coalesce(nullif(x->>'created_at', '')::timestamptz, now())
    from jsonb_array_elements(p_lista) with ordinality as t(x, ord);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function guardar_pendientes_entrega(uuid, text, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function guardar_pendientes_entrega(uuid, text, text, jsonb, uuid) to service_role;

commit;

-- PostgREST cachea el esquema: sin esto la tabla nueva "no existe" para la app hasta que se reinicie.
notify pgrst, 'reload schema';
