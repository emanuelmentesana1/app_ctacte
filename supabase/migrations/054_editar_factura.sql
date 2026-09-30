-- Migration 054 — Editar una factura desde la app (30/09/2026). Idempotente.
--
-- Mati, por Jorgelina: *"InfoManager es más fácil ya que sólo edita la factura y listo, y en la
-- app tiene que ponerse a emitir NC y ND... no podemos hacer que se pueda modificar la factura y
-- no tener que emitir tantos comprobantes? acordate que éstas no pasan por ARCA"*.
--
-- La API de IM no edita renglones, así que editar = anular la factura, emitir la nueva con la misma
-- fecha, rehacer el remito con los renglones de ella y cambiarlo en la hoja de ruta. Son cinco
-- pasos contra IM y ninguno es transaccional: si algo se corta en el medio, la app tiene que saber
-- dónde quedó. Eso es `facturas_ediciones`.
--
-- Por qué hacía falta: editando en la pantalla de IM el remito queda como estaba. El 29-30/09 eso
-- dejó la FAB 51031, la 51034 y la FAA 1658 con remitos que no decían lo mismo que la factura, y
-- el stock descontado de mercadería que no salió.
begin;

create table if not exists facturas_ediciones (
  tenant_id uuid not null,
  id uuid not null,
  -- El pedido (presupuesto) del que salieron la factura y el remito.
  im_comprobante_id text not null,
  -- La factura que se editó (la vieja).
  im_factura_id text not null,
  -- 'cancelada': falló el primer paso sin cambiar nada en IM y el pedido volvió a como estaba.
  estado text not null check (estado in ('en_curso', 'fallo', 'incierto', 'completo', 'cancelada')),
  paso text not null,
  -- La edición entera: renglones, cabecera, comprobantes viejos y nuevos (ver edicionFactura.ts).
  datos jsonb not null,
  error text,
  creado_por uuid references usuarios(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);

-- 🔴 Una sola edición abierta por pedido: dos personas editando la misma factura a la vez
-- emitirían dos facturas nuevas. La segunda choca acá.
create unique index if not exists facturas_ediciones_abierta_uidx
  on facturas_ediciones (tenant_id, im_comprobante_id) where estado in ('en_curso', 'fallo', 'incierto');
create index if not exists facturas_ediciones_factura_idx on facturas_ediciones (tenant_id, im_factura_id);

alter table facturas_ediciones enable row level security;
drop policy if exists facturas_ediciones_service on facturas_ediciones;
create policy facturas_ediciones_service on facturas_ediciones for all to service_role using (true) with check (true);

/**
 * Cambia el remito viejo por el nuevo en la hoja de ruta (o en retiros), EN SU LUGAR: mismo
 * orden, mismo saldo anterior impreso. Sólo cambian los comprobantes, el importe y el peso.
 *
 * Bajo el mismo lock que `mutar_reparto` (reparto_control) y subiendo la versión de la hoja, para
 * que una pantalla abierta con la hoja vieja no pise el cambio.
 *
 * 🪤 Las hojas anteriores al 08/09/2026 guardan el PRESUPUESTO como `im_comprobante_id`; las de
 * ahora, el remito. Se busca por los dos, y la clave sólo cambia cuando era el remito.
 *
 * Idempotente: si la fila ya apunta al remito nuevo, no hace nada (reintento de la edición).
 */
create or replace function reemplazar_remito_en_hoja(p_tenant uuid, p_actor uuid, p_datos jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  viejo text := p_datos->>'remito_viejo';
  nuevo text := p_datos->>'remito_nuevo';
  pedido text := p_datos->>'pedido';
  f hojas_ruta_pedidos; h hojas_ruta; r retiros_sucursal;
begin
  if p_tenant is null or p_actor is null then raise exception 'Falta identidad de la operación'; end if;
  if coalesce(viejo, '') !~ '^[0-9]+$' or coalesce(nuevo, '') !~ '^[0-9]+$' or coalesce(pedido, '') !~ '^[0-9]+$' then
    raise exception 'Comprobantes inválidos';
  end if;
  insert into reparto_control values (p_tenant) on conflict do nothing;
  perform 1 from reparto_control where tenant_id = p_tenant for update;

  select p.* into f from hojas_ruta_pedidos p join hojas_ruta hh on hh.id = p.hoja_id
   where hh.tenant_id = p_tenant and p.im_comprobante_id in (viejo, nuevo, pedido)
   order by (p.im_comprobante_id = nuevo) desc limit 1;
  if found then
    select * into h from hojas_ruta where id = f.hoja_id and tenant_id = p_tenant;
    if f.im_comprobante_id = nuevo or f.im_remito_id = nuevo then
      return jsonb_build_object('ok', true, 'hoja', h.numero, 'ya_estaba', true);
    end if;
    if h.estado <> 'abierta' then
      raise exception 'La hoja % no está abierta. Reabrila antes de editar la factura.', h.numero;
    end if;
    if exists (select 1 from hojas_ruta_ajustes where tenant_id = p_tenant and im_comprobante_id in (viejo, pedido, f.im_comprobante_id)) then
      raise exception 'La entrega tiene notas o ajustes en la hoja %: no se puede reemplazar el remito.', h.numero;
    end if;
    update hojas_ruta_pedidos set
      im_numero = case when im_comprobante_id = viejo then (p_datos->>'remito_numero')::int else im_numero end,
      im_comprobante_id = case when im_comprobante_id = viejo then nuevo else im_comprobante_id end,
      im_remito_id = nuevo,
      im_remito_numero = (p_datos->>'remito_numero')::int,
      im_factura_id = p_datos->>'factura_id',
      im_factura_numero = (p_datos->>'factura_numero')::int,
      total = (p_datos->>'total')::numeric,
      bultos = (p_datos->>'bultos')::numeric,
      kg = (p_datos->>'kg')::numeric,
      peso_completo = (p_datos->>'peso_completo')::boolean,
      renglones_sin_peso = (p_datos->>'renglones_sin_peso')::int,
      datos_consultados_at = now()
    where id = f.id;
    update hojas_ruta set version = version + 1 where id = h.id and tenant_id = p_tenant;
    return jsonb_build_object('ok', true, 'hoja', h.numero);
  end if;

  select * into r from retiros_sucursal
   where tenant_id = p_tenant and im_comprobante_id in (viejo, nuevo, pedido)
   order by (im_comprobante_id = nuevo) desc limit 1;
  if found then
    if r.im_comprobante_id = nuevo or r.im_remito_id = nuevo then
      return jsonb_build_object('ok', true, 'hoja', null, 'retiro', true, 'ya_estaba', true);
    end if;
    update retiros_sucursal set
      im_numero = case when im_comprobante_id = viejo then (p_datos->>'remito_numero')::int else im_numero end,
      im_comprobante_id = case when im_comprobante_id = viejo then nuevo else im_comprobante_id end,
      im_remito_id = nuevo,
      im_remito_numero = (p_datos->>'remito_numero')::int,
      im_factura_id = p_datos->>'factura_id',
      im_factura_numero = (p_datos->>'factura_numero')::int,
      total = (p_datos->>'total')::numeric,
      bultos = (p_datos->>'bultos')::numeric,
      kg = (p_datos->>'kg')::numeric,
      peso_completo = (p_datos->>'peso_completo')::boolean,
      renglones_sin_peso = (p_datos->>'renglones_sin_peso')::int,
      datos_consultados_at = now(),
      version = version + 1
    where id = r.id;
    return jsonb_build_object('ok', true, 'hoja', null, 'retiro', true);
  end if;

  return jsonb_build_object('ok', true, 'hoja', null);
end $$;

revoke all on function reemplazar_remito_en_hoja(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function reemplazar_remito_en_hoja(uuid, uuid, jsonb) to service_role;

commit;
