-- Migration 058 — Corregir el remito de una entrega de la hoja de ruta (06/10/2026). Idempotente.
--
-- Mati (06/10/2026), opción 2 para DIAZ (hoja 3402): el RE 77382 se borró en InfoManager y la mercadería
-- salió con el RE 77399, que la app había emitido para ese mismo presupuesto. La hoja seguía apuntando al
-- remito borrado: el aviso «remito anulado en IM» no se iba y el RE 77399 figuraba sin hoja.
--
-- 🔑 La entrega PASA A SER el remito nuevo: cambia su clave (`im_comprobante_id`), igual que al editar una
-- factura (`reemplazar_remito_en_hoja`, 054). La clave es el remito que viajó y es única en todas las hojas,
-- así que la base misma impide que un remito quede en dos entregas.
--
-- 🔴 También en una hoja CERRADA: es cuando se descubre, al liquidar. No toca importes ni kilos: antes de
-- llamar a esto el servidor verifica contra IM que el remito nuevo sea del mismo cliente, por el mismo
-- importe, y que la entrega quede con las mismas notas. Lo confirmado al cierre se sigue encontrando por la
-- clave anterior, que queda en `remito_historial` (el respaldo del cierre no se reescribe).
--
-- Frena si la entrega tiene notas (NC/ND) cargadas en la hoja: cuelgan de la clave vieja (como en la 054).
-- No cambia nada de lo que ya existe: suma una columna que empieza vacía y una función nueva.

alter table hojas_ruta_pedidos add column if not exists remito_historial jsonb not null default '[]'::jsonb;

comment on column hojas_ruta_pedidos.remito_historial is
  'Cada corrección del remito: clave_anterior, numero_anterior, remito_id, remito_numero, motivo, por, at. No se borra.';

create or replace function corregir_remito_entrega(p_tenant uuid, p_actor uuid, p_datos jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare
  h hojas_ruta; p hojas_ruta_pedidos; otra int;
  nuevo text := nullif(btrim(coalesce(p_datos->>'remito_id', '')), '');
  numero int;
  motivo text := nullif(btrim(coalesce(p_datos->>'motivo', '')), '');
  version_esperada bigint := nullif(p_datos->>'version_esperada', '')::bigint;
begin
  if p_tenant is null or p_actor is null then raise exception 'Falta identidad de la operación'; end if;
  if coalesce(nuevo, '') !~ '^[0-9]+$' or coalesce(p_datos->>'remito_numero', '') !~ '^[0-9]{1,9}$' then raise exception 'Remito inválido'; end if;
  numero := (p_datos->>'remito_numero')::int;
  if motivo is null or char_length(motivo) < 3 then raise exception 'Falta el motivo'; end if;
  -- El mismo lock que `mutar_reparto`: nadie asigna ese remito a otra hoja mientras tanto.
  insert into reparto_control values (p_tenant) on conflict do nothing;
  perform 1 from reparto_control where tenant_id = p_tenant for update;
  select * into h from hojas_ruta where tenant_id = p_tenant and id = (p_datos->>'hoja_id')::uuid for update;
  if not found then raise exception 'Hoja no encontrada'; end if;
  if h.estado = 'anulada' then raise exception 'La hoja % está anulada', h.numero; end if;
  if version_esperada is null or h.version <> version_esperada then raise exception 'La hoja cambió. Actualizá antes de continuar'; end if;
  select * into p from hojas_ruta_pedidos where hoja_id = h.id and im_comprobante_id = p_datos->>'im_comprobante_id' for update;
  if not found then raise exception 'La entrega cambió de hoja'; end if;
  -- Las hojas anteriores al 08/09/2026 guardan el PRESUPUESTO como clave: ésas no se tocan desde acá.
  if p.im_comprobante_id is distinct from coalesce(p.im_remito_id, p.im_comprobante_id) then
    raise exception 'La entrega se identifica por su presupuesto (hoja anterior al 08/09/2026): su remito no se corrige desde acá';
  end if;
  if p.im_comprobante_id = nuevo then raise exception 'La entrega ya es el remito %', numero; end if;
  if exists (select 1 from hojas_ruta_ajustes a where a.tenant_id = p_tenant and a.im_comprobante_id = p.im_comprobante_id) then
    raise exception 'La entrega tiene notas (NC/ND) cargadas en la hoja %: no se puede corregir el remito', h.numero;
  end if;
  -- 🔴 El remito nuevo no puede estar en otra entrega: ni como clave, ni como remito, ni por el presupuesto
  -- del que salió (las hojas anteriores al 08/09 guardan el presupuesto).
  select hh.numero into otra from hojas_ruta_pedidos x join hojas_ruta hh on hh.id = x.hoja_id
   where hh.tenant_id = p_tenant and x.id <> p.id
     and (nuevo in (x.im_comprobante_id, x.im_remito_id)
       or x.im_comprobante_id in (select pf.im_comprobante_id from presupuestos_facturados pf where pf.tenant_id = p_tenant and pf.im_remito_id = nuevo))
   limit 1;
  if found then raise exception 'El remito % ya está en la hoja %', numero, otra; end if;
  if exists (select 1 from retiros_sucursal r where r.tenant_id = p_tenant
     and (nuevo in (r.im_comprobante_id, r.im_remito_id)
       or r.im_comprobante_id in (select pf.im_comprobante_id from presupuestos_facturados pf where pf.tenant_id = p_tenant and pf.im_remito_id = nuevo))) then
    raise exception 'El remito % está en Retiros en sucursal', numero;
  end if;
  update hojas_ruta_pedidos set
    im_comprobante_id = nuevo, im_numero = numero, im_remito_id = nuevo, im_remito_numero = numero,
    -- El fraccionado y el peso piden los renglones por la fecha del comprobante (037).
    fecha = coalesce(nullif(p_datos->>'remito_fecha', '')::date, fecha),
    remito_historial = coalesce(remito_historial, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'clave_anterior', p.im_comprobante_id, 'numero_anterior', coalesce(p.im_remito_numero, p.im_numero),
      'remito_id', nuevo, 'remito_numero', numero, 'motivo', motivo, 'por', p_actor, 'at', now()))
  where id = p.id;
  update hojas_ruta set version = version + 1 where tenant_id = p_tenant and id = h.id;
  return jsonb_build_object('version', h.version + 1, 'im_comprobante_id', nuevo, 'remito_numero', numero);
end $$;

revoke all on function corregir_remito_entrega(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function corregir_remito_entrega(uuid,uuid,jsonb) to service_role;
