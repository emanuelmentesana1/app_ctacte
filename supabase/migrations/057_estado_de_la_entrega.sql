-- Migration 057 — Estado de cada entrega de una hoja de ruta: «No salió» (05/10/2026). Idempotente.
--
-- Mati (05/10/2026): una entrega cuya mercadería no salió (su remito se anuló en InfoManager) tiene
-- que dejar de contar en lo entregado del chofer DESDE EL PANEL, no a mano en un Excel. Pasó en
-- septiembre con LEAL y BUSTOS (hoja 3402): la liquidación de NIÑO los seguía sumando.
--
-- Se guarda como ESTADO de la entrega, con motivo, quién y cuándo (no un sí/no): la etapa 3 de
-- Rendiciones (entregó todo / una parte / rechazó) lo amplía sin otra tabla. Hoy el único estado es
-- 'no_salio'; null = la entrega salió normal.
--
-- 🔴 Se puede marcar también en una hoja CERRADA: es justo el caso (se descubre al liquidar). Por eso
-- no pasa por `mutar_reparto`, que con razón no deja tocar una hoja cerrada. Todo cambio queda en el
-- historial de la entrega y sube la versión de la hoja (las pantallas abiertas se enteran).
--
-- No cambia nada de lo que ya existe: suma columnas que empiezan vacías y una función nueva.

alter table hojas_ruta_pedidos add column if not exists estado_entrega text;
alter table hojas_ruta_pedidos add column if not exists estado_entrega_motivo text;
alter table hojas_ruta_pedidos add column if not exists estado_entrega_por uuid;
alter table hojas_ruta_pedidos add column if not exists estado_entrega_at timestamptz;
alter table hojas_ruta_pedidos add column if not exists estado_entrega_historial jsonb not null default '[]'::jsonb;

comment on column hojas_ruta_pedidos.estado_entrega is
  'null = salió normal. no_salio = la mercadería no salió: no cuenta en lo entregado del chofer (liquidación).';
comment on column hojas_ruta_pedidos.estado_entrega_historial is
  'Cada cambio de estado: estado, motivo, por, at y el estado anterior. No se borra.';

create or replace function marcar_estado_entrega(p_tenant uuid, p_actor uuid, p_datos jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare
  h hojas_ruta; p hojas_ruta_pedidos;
  nuevo text := nullif(p_datos->>'estado', '');
  motivo text := nullif(btrim(coalesce(p_datos->>'motivo', '')), '');
  version_esperada bigint := nullif(p_datos->>'version_esperada', '')::bigint;
begin
  if p_tenant is null or p_actor is null then raise exception 'Falta identidad de la operación'; end if;
  if nuevo is not null and nuevo <> 'no_salio' then raise exception 'Estado de entrega inválido'; end if;
  if nuevo is not null and (motivo is null or char_length(motivo) < 3) then raise exception 'Falta el motivo'; end if;
  select * into h from hojas_ruta where tenant_id = p_tenant and id = (p_datos->>'hoja_id')::uuid for update;
  if not found then raise exception 'Hoja no encontrada'; end if;
  if version_esperada is null or h.version <> version_esperada then raise exception 'La hoja cambió. Actualizá antes de continuar'; end if;
  select * into p from hojas_ruta_pedidos where hoja_id = h.id and im_comprobante_id = p_datos->>'im_comprobante_id' for update;
  if not found then raise exception 'La entrega cambió de hoja'; end if;
  if p.estado_entrega is not distinct from nuevo then raise exception 'La entrega ya está en ese estado'; end if;
  update hojas_ruta_pedidos set
    estado_entrega = nuevo, estado_entrega_motivo = motivo, estado_entrega_por = p_actor, estado_entrega_at = now(),
    estado_entrega_historial = coalesce(estado_entrega_historial, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'estado', nuevo, 'motivo', motivo, 'por', p_actor, 'at', now(), 'anterior', p.estado_entrega))
  where id = p.id;
  update hojas_ruta set version = version + 1 where tenant_id = p_tenant and id = h.id;
  return jsonb_build_object('version', h.version + 1, 'estado', nuevo);
end $$;

revoke all on function marcar_estado_entrega(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function marcar_estado_entrega(uuid,uuid,jsonb) to service_role;
