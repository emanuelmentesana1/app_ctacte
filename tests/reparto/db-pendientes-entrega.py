"""055: mercadería ya facturada que viaja con un pedido nuevo. La lista se guarda entera o no se guarda."""
import json
import subprocess
import sys
import uuid

container = sys.argv[1]
assert container.startswith('ctacte-audit-db-')
checks = []
def sql(query, ok=True):
    p = subprocess.run(['docker','exec',container,'psql','-U','postgres','-Atq','-v','ON_ERROR_STOP=1','-c',
                        "SET statement_timeout='5s';"+query],text=True,capture_output=True,timeout=8)
    if ok:
        assert p.returncode == 0, p.stderr
        return p.stdout.strip()
    return p
def lit(v): return "'"+str(v).replace("'","''")+"'"
def js(v): return lit(json.dumps(v))+'::jsonb'
def check(name,condition):
    assert condition,name
    checks.append(name)
def identity(): return str(uuid.uuid4())

tenant=identity(); otro_tenant=identity(); actor=identity(); jo=identity()
def guardar(destino,origen,lista,ok=True,t=None):
    return sql(f"select guardar_pendientes_entrega({lit(t or tenant)},{lit(destino)},{lit(origen) if origen else 'null'},{js(lista)},{lit(actor)})",ok)
def de(pr,t=None):
    return sql(f"select coalesce(string_agg(descripcion||'×'||trim_scale(cantidad)::text||'|'||coalesce(im_renglon_id,'-')||'|'||coalesce(cod_articulo::text,'-'),' · ' order by orden),'∅') "
               f"from pendientes_entrega where tenant_id={lit(t or tenant)} and im_comprobante_id={lit(pr)}")

# ── Editar la lista de un presupuesto ──────────────────────────────────────────
guardar('58954399','58954399',[
    {'descripcion':'MAIZ LEALES 25 PENDIENTE','cantidad':10,'im_renglon_id':'58955053'},
    {'descripcion':'MEZCLA GALLO PREMIUM','cantidad':300,'cod_articulo':491,'factura_ref':'FA B 50680'},
])
check('se guarda en el orden en que se mandó',
      de('58954399')=='MAIZ LEALES 25 PENDIENTE×10|58955053|- · MEZCLA GALLO PREMIUM×300|-|491')
guardar('58954399','58954399',[{'descripcion':'MEZCLA GALLO PREMIUM','cantidad':250,'cod_articulo':491}])
check('la lista nueva REEMPLAZA a la anterior: lo que no viene se borra',de('58954399')=='MEZCLA GALLO PREMIUM×250|-|491')
guardar('58954399','58954399',[])
check('una lista vacía deja el presupuesto sin pendientes',de('58954399')=='∅')

# ── Rehacer el presupuesto: todo pasa al nuevo, nada queda en el viejo ─────────
guardar('100','100',[{'descripcion':'ANILLO FRUTA PENDIENTE','cantidad':6}])
guardar('200','100',[{'descripcion':'ANILLO FRUTA PENDIENTE','cantidad':6},
                     {'descripcion':'QUEBRADO GRUESO PENDIENTE','cantidad':1,'im_renglon_id':'777'}])
check('el presupuesto viejo queda sin pendientes',de('100')=='∅')
check('y el nuevo los tiene todos',de('200')=='ANILLO FRUTA PENDIENTE×6|-|- · QUEBRADO GRUESO PENDIENTE×1|777|-')

# ── Quién lo cargó y cuándo no se pierden al volver a guardar ──────────────────
guardar('300','300',[{'descripcion':'PROVENZAL PENDIENTE','cantidad':2,'creado_por':jo,'created_at':'2026-09-08T10:00:00Z'}])
check('se conserva quién lo cargó',sql(f"select creado_por from pendientes_entrega where im_comprobante_id='300' and tenant_id={lit(tenant)}")==jo)
check('y cuándo',sql(f"select to_char(created_at at time zone 'UTC','YYYY-MM-DD HH24:MI') from pendientes_entrega where im_comprobante_id='300' and tenant_id={lit(tenant)}")=='2026-09-08 10:00')
guardar('300','300',[{'descripcion':'PROVENZAL PENDIENTE','cantidad':3}])
check('sin dato, queda quien guarda',sql(f"select creado_por from pendientes_entrega where im_comprobante_id='300' and tenant_id={lit(tenant)}")==actor)

# ── O todo o nada ──────────────────────────────────────────────────────────────
guardar('400','400',[{'descripcion':'ZIMPI X 25 PENDIENTE','cantidad':15}])
r=guardar('500','400',[{'descripcion':'ZIMPI X 25 PENDIENTE','cantidad':15},{'descripcion':'SIN CANTIDAD','cantidad':0}],ok=False)
check('una cantidad en cero se rechaza',r.returncode!=0 and 'pendientes_entrega_cantidad_check' in r.stderr)
check('🔴 y el rechazo no deja el viejo vacío: no se movió nada',de('400')=='ZIMPI X 25 PENDIENTE×15|-|-' and de('500')=='∅')
r=guardar('500','400',[{'descripcion':'   ','cantidad':1}],ok=False)
check('una descripción en blanco se rechaza',r.returncode!=0 and 'pendientes_entrega_descripcion_check' in r.stderr)
r=guardar('500','400',[{'descripcion':'X','cantidad':1,'cod_articulo':0}],ok=False)
check('un artículo 0 no es un artículo',r.returncode!=0 and 'pendientes_entrega_cod_articulo_check' in r.stderr)
r=guardar('5O0','400',[],ok=False)
check('el presupuesto destino tiene que ser un id de IM',r.returncode!=0 and 'presupuesto inválido' in r.stderr)
r=sql(f"select guardar_pendientes_entrega({lit(tenant)},'500','400','{{}}'::jsonb,{lit(actor)})",False)
check('la lista tiene que ser un array',r.returncode!=0 and 'array' in r.stderr)
check('después de cada rechazo, el viejo sigue intacto',de('400')=='ZIMPI X 25 PENDIENTE×15|-|-')

# ── El renglón de IM se pasa una sola vez ──────────────────────────────────────
sql(f"insert into pendientes_entrega(tenant_id,im_comprobante_id,im_renglon_id,descripcion,cantidad) values({lit(tenant)},'600','888','CERDO PENDIENTE',5)")
r=sql(f"insert into pendientes_entrega(tenant_id,im_comprobante_id,im_renglon_id,descripcion,cantidad) values({lit(tenant)},'600','888','CERDO PENDIENTE',5)",False)
check('🔑 el mismo renglón de IM no entra dos veces al mismo presupuesto',r.returncode!=0 and 'pendientes_entrega_renglon_uidx' in r.stderr)
sql(f"insert into pendientes_entrega(tenant_id,im_comprobante_id,im_renglon_id,descripcion,cantidad) values({lit(tenant)},'600','888','CERDO PENDIENTE',5) "
    "on conflict (tenant_id,im_comprobante_id,im_renglon_id) do nothing")
check('y el reintento con on conflict no falla ni duplica',sql(f"select count(*) from pendientes_entrega where tenant_id={lit(tenant)} and im_comprobante_id='600'")=='1')
sql(f"insert into pendientes_entrega(tenant_id,im_comprobante_id,descripcion,cantidad) values({lit(tenant)},'600','A',1),({lit(tenant)},'600','B',1)")
check('lo cargado en la app (sin renglón de IM) no tiene tope',sql(f"select count(*) from pendientes_entrega where tenant_id={lit(tenant)} and im_comprobante_id='600'")=='3')

# ── Cada empresa ve lo suyo ────────────────────────────────────────────────────
guardar('58954399','58954399',[{'descripcion':'DE OTRA BASE','cantidad':1}],t=otro_tenant)
guardar('58954399','58954399',[],t=tenant)
check('guardar en un tenant no toca el otro',de('58954399',t=otro_tenant)=='DE OTRA BASE×1|-|-')

# ── Permisos ───────────────────────────────────────────────────────────────────
check('RLS activa',sql("select relrowsecurity from pg_class where relname='pendientes_entrega'")=='t')
check('la función no la puede llamar anon',sql("select has_function_privilege('anon','guardar_pendientes_entrega(uuid,text,text,jsonb,uuid)','execute')")=='f')
check('ni authenticated',sql("select has_function_privilege('authenticated','guardar_pendientes_entrega(uuid,text,text,jsonb,uuid)','execute')")=='f')
check('sí el service_role',sql("select has_function_privilege('service_role','guardar_pendientes_entrega(uuid,text,text,jsonb,uuid)','execute')")=='t')

print(json.dumps({'scope':'055 PostgreSQL real, datos ficticios y cero red','passed':len(checks),'checks':checks},ensure_ascii=False,indent=2))
