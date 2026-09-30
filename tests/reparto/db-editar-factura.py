"""054: editar una factura. El remito nuevo reemplaza al viejo EN SU LUGAR, y una sola edición abierta por pedido."""
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
def falla_con(respuesta,texto,nombre):
    check(nombre, respuesta.returncode != 0 and texto in respuesta.stderr)
def identity(): return str(uuid.uuid4())

actor=identity()
sql(f'insert into usuarios(id) values({lit(actor)})')
def hoja(tenant):
    return json.loads(sql(f"select mutar_reparto({lit(tenant)},{lit(actor)},'hoja_crear','{{\"fecha\":\"2026-10-01\"}}')"))
def entrega(h, comp, remito, orden, saldo):
    sql(f"""insert into hojas_ruta_pedidos(hoja_id,im_comprobante_id,im_numero,cod_cliente,cliente_nombre,orden,saldo_anterior,total,
          im_remito_id,im_remito_numero,im_factura_id,im_factura_numero,cod_empresa)
        values({lit(h['id'])},{lit(comp)},78404,665,'CLIENTE',{orden},{saldo},691089.04,{lit(remito)},78404,'59015523',1658,1)""")
def reemplazar(tenant, viejo, nuevo, pedido, ok=True, actor_=None):
    datos={'remito_viejo':viejo,'remito_nuevo':nuevo,'pedido':pedido,'remito_numero':78500,'factura_id':'59015523','factura_numero':1658,
           'total':635491.54,'bultos':12,'kg':310.5,'peso_completo':True,'renglones_sin_peso':0}
    a = lit(actor_ if actor_ is not None else actor) if actor_ != 'null' else 'null'
    return sql(f"select reemplazar_remito_en_hoja({lit(tenant)},{a},{js(datos)})",ok)
def fila(comp): return sql(f"select im_comprobante_id||'|'||im_numero||'|'||im_remito_numero||'|'||orden||'|'||saldo_anterior||'|'||total||'|'||kg from hojas_ruta_pedidos where im_comprobante_id={lit(comp)}")
def version(h): return int(sql(f"select version from hojas_ruta where id={lit(h['id'])}"))

# ── El remito nuevo ocupa el lugar del viejo ───────────────────────────────────
t=identity(); h=hoja(t)
entrega(h,'59015550','59015550',0,0)
entrega(h,'59015555','59015555',1,4284755.44)
v=version(h)
r=json.loads(reemplazar(t,'59015555','59200000','59015299'))
check('contesta la hoja', r=={'ok':True,'hoja':h['numero']})
check('mismo orden y mismo saldo impreso; cambian remito, importe y kilos', fila('59200000')=='59200000|78500|78500|1|4284755.44|635491.54|310.500')
check('el remito viejo ya no está en la hoja', sql("select count(*) from hojas_ruta_pedidos where im_comprobante_id='59015555'")=='0')
check('la hoja sube de versión: una pantalla vieja no la pisa', version(h)==v+1)
r=json.loads(reemplazar(t,'59015555','59200000','59015299'))
check('el reintento no hace nada dos veces', r.get('ya_estaba') is True and version(h)==v+1)

# ── Hojas anteriores al 08/09: la clave es el presupuesto y se conserva ───────
t2=identity(); h2=hoja(t2)
entrega(h2,'58994539','58995120',0,0)
reemplazar(t2,'58995120','59200001','58994539')
check('hoja vieja: la clave sigue siendo el presupuesto', sql("select im_comprobante_id||'|'||im_remito_id||'|'||im_remito_numero from hojas_ruta_pedidos where im_comprobante_id='58994539'")=='58994539|59200001|78500')

# ── Guardas ────────────────────────────────────────────────────────────────────
t3=identity(); h3=hoja(t3)
entrega(h3,'700','700',0,0)
sql(f"select mutar_reparto({lit(t3)},{lit(actor)},'hoja_editar',{js({'hoja_id':h3['id'],'version_esperada':version(h3),'cambios':{'estado':'cerrada'}})})")
falla_con(reemplazar(t3,'700','701','699',ok=False),'no está abierta','con la hoja cerrada no se toca')
check('y la entrega de la hoja cerrada quedó como estaba', sql("select count(*) from hojas_ruta_pedidos where im_comprobante_id='700'")=='1')
falla_con(reemplazar(t3,'800','801','799',ok=False,actor_='null'),'Falta identidad','sin actor no hace nada')
falla_con(sql(f"select reemplazar_remito_en_hoja({lit(t3)},{lit(actor)},{js({'remito_viejo':'x','remito_nuevo':'1','pedido':'2'})})",ok=False),'Comprobantes inválidos','ids que no son números')
r=json.loads(reemplazar(identity(),'900','901','899'))
check('si no estaba en ninguna hoja ni retiro, no hace nada', r=={'ok':True,'hoja':None})

# ── Una sola edición abierta por pedido ────────────────────────────────────────
t4=identity()
def edicion(estado, ok=True):
    return sql(f"insert into facturas_ediciones(tenant_id,id,im_comprobante_id,im_factura_id,estado,paso,datos,creado_por) values({lit(t4)},{lit(identity())},'58994539','58995098',{lit(estado)},'emitir_re','{{}}',{lit(actor)})",ok)
edicion('en_curso')
falla_con(edicion('fallo',ok=False),'duplicate key','una segunda edición abierta del mismo pedido choca')
sql(f"update facturas_ediciones set estado='completo' where tenant_id={lit(t4)}")
edicion('en_curso')
check('terminada la anterior, se puede volver a editar', sql(f"select count(*) from facturas_ediciones where tenant_id={lit(t4)}")=='2')
falla_con(edicion('cualquiera',ok=False),'check','el estado es uno de los conocidos')
sql(f"update facturas_ediciones set estado='cancelada' where tenant_id={lit(t4)} and estado='en_curso'")
edicion('en_curso')
check('una edición cancelada tampoco bloquea la siguiente', sql(f"select count(*) from facturas_ediciones where tenant_id={lit(t4)}")=='3')

print(json.dumps({'db_editar_factura':checks},ensure_ascii=False))
