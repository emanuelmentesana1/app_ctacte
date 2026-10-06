-- Migration 059 — Factura complementaria + remito en "Con notas" (06/10/2026). Idempotente.
--
-- Mati eligió la opción C: cuando al corregir una factura se AGREGA mercadería, sale una factura
-- complementaria con su remito —el remito descuenta el stock— y no una nota de débito. La ND queda
-- para una diferencia de precio. Disparador: InfoManager rechazó las tres ND que intentó la app
-- (FA 51050, 51136 y 51218), y ninguna ND mueve stock.
--
-- Dos cambios al journal de correcciones (`facturas_operaciones`, 039/041):
--
--  1. `terminar_paso_factura`: el paso `RE` se registra en `facturas_remitos_complementarios` y NO
--     en `facturas_correcciones`. Esa tabla es de comprobantes con importe (total > 0) y la leen
--     las hojas, la liquidación y las rendiciones como notas: un remito ahí rompería todo eso. La
--     factura complementaria (`FA`) sí va a `facturas_correcciones`: suma al cliente como una ND.
--
--  2. `adoptar_paso_factura`: si InfoManager no contestó al emitir la FA o el RE, el servidor lo
--     busca por la marca `[OP:<id>:FA|RE]` de sus observaciones y, si encuentra UNO, lo registra
--     con esto. Sólo desde `incierto` y sólo para el paso en curso.
--
-- No cambia nada de lo que ya existe: la función se reemplaza con la misma firma y el mismo
-- comportamiento para NC y ND.
begin;

create table if not exists facturas_remitos_complementarios (
  tenant_id uuid not null,
  im_remito_id text not null,
  -- La factura que se corrigió (la original), y la complementaria que acompaña a este remito.
  im_factura_id text not null,
  im_factura_complementaria_id text,
  numero integer,
  operacion_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, im_remito_id)
);
create index if not exists facturas_remitos_complementarios_factura_idx
  on facturas_remitos_complementarios (tenant_id, im_factura_id);

alter table facturas_remitos_complementarios enable row level security;
drop policy if exists facturas_remitos_complementarios_service on facturas_remitos_complementarios;
create policy facturas_remitos_complementarios_service on facturas_remitos_complementarios
  for all to service_role using (true) with check (true);

create or replace function terminar_paso_factura(
  p_tenant uuid,p_id uuid,p_token uuid,p_resultado jsonb,p_error text,p_incierto boolean
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare o facturas_operaciones; c jsonb; terminado boolean; fa jsonb;
begin
  -- Orden único con mutar_reparto: tenant antes de factura/operación.
  insert into reparto_control(tenant_id) values(p_tenant) on conflict do nothing;
  perform 1 from reparto_control where tenant_id=p_tenant for update;
  -- Mismo orden de locks que iniciar_operacion_factura.
  perform 1 from facturas_estado_correccion e join facturas_operaciones x
    on x.tenant_id=e.tenant_id and x.im_factura_id=e.im_factura_id
    where x.tenant_id=p_tenant and x.id=p_id for update of e;
  select * into o from facturas_operaciones where tenant_id=p_tenant and id=p_id for update;
  if o.token is distinct from p_token or o.estado<>'emitiendo' then raise exception 'No sos el titular de esta emisión'; end if;
  if p_resultado is null then
    update facturas_operaciones set estado=case when p_incierto then 'incierto' else 'listo' end,
      error=p_error,token=null,updated_at=now() where tenant_id=p_tenant and id=p_id returning * into o;
    return to_jsonb(o);
  end if;
  if coalesce(p_resultado->>'id','') !~ '^[0-9]+$' or coalesce(p_resultado->>'id','') !~ '[1-9]' then raise exception 'Falta un ID decimal positivo del comprobante emitido'; end if;
  c=o.componentes->o.indice;
  if c->>'tipo'='RE' then
    -- 🔑 El remito no es una nota: va a su tabla, con la factura complementaria que ya emitió esta
    -- operación (el último resultado FA).
    select r into fa from jsonb_array_elements(o.resultados) with ordinality as x(r,n) where r->>'tipo' like 'FA%' order by n desc limit 1;
    insert into facturas_remitos_complementarios(tenant_id,im_remito_id,im_factura_id,im_factura_complementaria_id,numero,operacion_id)
      values(p_tenant,p_resultado->>'id',o.im_factura_id,fa->>'id',(p_resultado->>'numero')::int,p_id);
  else
    insert into facturas_correcciones(tenant_id,im_factura_id,im_factura_numero,cod_cliente,
      tipo,im_comprobante_id,numero,total,motivo,creado_por,operacion_id)
      values(p_tenant,o.im_factura_id,(o.peticion->>'numero_factura')::int,
        (c->'datos'->>'cod_cliente')::int,p_resultado->>'tipo',p_resultado->>'id',
        (p_resultado->>'numero')::int,(c->'datos'->>'total')::numeric,o.peticion->>'motivo',o.creado_por,p_id);
  end if;
  terminado=o.indice+1=jsonb_array_length(o.componentes);
  update facturas_operaciones set indice=indice+1,
    resultados=resultados||jsonb_build_array(p_resultado),estado=case when terminado then 'completo' else 'listo' end,
    token=null,error=null,updated_at=now() where tenant_id=p_tenant and id=p_id returning * into o;
  if terminado then
    update facturas_estado_correccion set version=version+1,operacion_id=null,
      renglones=case when o.clase='productos' then o.finales else renglones end
      where tenant_id=p_tenant and im_factura_id=o.im_factura_id;
  end if;
  return to_jsonb(o);
end $$;

/**
 * Registra la FA o el RE complementario que el servidor ENCONTRÓ en InfoManager después de que no
 * contestara. Pasa por `terminar_paso_factura`, así que deja exactamente lo mismo que una
 * emisión con respuesta.
 */
create or replace function adoptar_paso_factura(p_tenant uuid,p_id uuid,p_indice integer,p_resultado jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare o facturas_operaciones; t uuid := gen_random_uuid();
begin
  insert into reparto_control(tenant_id) values(p_tenant) on conflict do nothing;
  perform 1 from reparto_control where tenant_id=p_tenant for update;
  select * into o from facturas_operaciones where tenant_id=p_tenant and id=p_id for update;
  if not found or o.estado<>'incierto' or o.indice<>p_indice then
    raise exception 'La operación no está esperando verificación en ese paso. No se registró nada.';
  end if;
  if coalesce(o.componentes->p_indice->>'tipo','') not in ('FA','RE') then
    raise exception 'Sólo se adopta una factura o un remito complementario.';
  end if;
  update facturas_operaciones set estado='emitiendo',token=t,updated_at=now() where tenant_id=p_tenant and id=p_id;
  return terminar_paso_factura(p_tenant,p_id,t,p_resultado,null,false);
end $$;

revoke all on function adoptar_paso_factura(uuid,uuid,integer,jsonb) from public, anon, authenticated;
grant execute on function adoptar_paso_factura(uuid,uuid,integer,jsonb) to service_role;

commit;
