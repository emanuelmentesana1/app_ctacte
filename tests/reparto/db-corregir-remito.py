"""058: corregir el remito de una entrega. La entrega pasa a ser el remito nuevo, también en una hoja cerrada,
y la base no deja que un remito quede en dos entregas."""
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
def hoja(tenant, fecha='2026-09-09'):
    return json.loads(sql(f"select mutar_reparto({lit(tenant)},{lit(actor)},'hoja_crear',{js({'fecha':fecha})})"))
def entrega(h, comp, remito, numero, cliente=812, orden=0):
    sql(f"""insert into hojas_ruta_pedidos(hoja_id,im_comprobante_id,im_numero,cod_cliente,cliente_nombre,orden,saldo_anterior,total,kg,bultos,fecha,
          im_remito_id,im_remito_numero)
        values({lit(h['id'])},{lit(comp)},{numero},{cliente},'DIAZ, Alfredo (Este)',{orden},2426713.32,2682199.99,1775.82,642,'2026-09-09',{lit(remito)},{numero})""")
def version(h): return int(sql(f"select version from hojas_ruta where id={lit(h['id'])}"))
def cerrar(t, h):
    sql(f"select mutar_reparto({lit(t)},{lit(actor)},'hoja_editar',{js({'hoja_id':h['id'],'version_esperada':version(h),'cambios':{'estado':'cerrada'}})})")
def corregir(t, h, clave, nuevo, numero=77399, ok=True, version_=None, motivo='el RE 77382 se borró en IM; salió con el RE 77399', actor_=None):
    datos={'hoja_id':h['id'],'im_comprobante_id':clave,'remito_id':nuevo,'remito_numero':str(numero),'remito_fecha':'2026-09-10',
           'motivo':motivo,'version_esperada':version(h) if version_ is None else version_}
    a = 'null' if actor_ == 'null' else lit(actor)
    return sql(f"select corregir_remito_entrega({lit(t)},{a},{js(datos)})",ok)

# ── DIAZ en una hoja CERRADA: la entrega pasa a ser el RE 77399 ────────────────
t=identity(); h=hoja(t)
entrega(h,'58783918','58783918',77382)
entrega(h,'58784016','58784016',77383,cliente=1347,orden=1)
cerrar(t,h)
v=version(h)
r=json.loads(corregir(t,h,'58783918','58785809'))
check('contesta la versión nueva y la clave nueva', r=={'version':v+1,'im_comprobante_id':'58785809','remito_numero':77399})
check('la entrega es el RE 77399, en su lugar y con el mismo importe, kilos y saldo',
      sql("select im_comprobante_id||'|'||im_numero||'|'||im_remito_id||'|'||im_remito_numero||'|'||orden||'|'||saldo_anterior||'|'||total||'|'||kg||'|'||fecha from hojas_ruta_pedidos where cod_cliente=812")
      == '58785809|77399|58785809|77399|0|2426713.32|2682199.99|1775.820|2026-09-10')
h_reg=json.loads(sql("select remito_historial from hojas_ruta_pedidos where cod_cliente=812"))
check('queda el registro: clave y número anteriores, motivo y quién',
      len(h_reg)==1 and h_reg[0]['clave_anterior']=='58783918' and h_reg[0]['numero_anterior']==77382 and h_reg[0]['por']==actor
      and h_reg[0]['motivo']=='el RE 77382 se borró en IM; salió con el RE 77399' and h_reg[0]['remito_id']=='58785809')
check('la hoja sube de versión y sigue cerrada', version(h)==v+1 and sql(f"select estado from hojas_ruta where id={lit(h['id'])}")=='cerrada')
check('el remito viejo ya no está en ninguna hoja', sql("select count(*) from hojas_ruta_pedidos where im_comprobante_id='58783918'")=='0')
falla_con(corregir(t,h,'58785809','58785809',ok=False),'ya es el remito','repetirlo no hace nada')

# ── Guardas ────────────────────────────────────────────────────────────────────
falla_con(corregir(t,h,'58784016','58785810',ok=False,version_=v),'La hoja cambió','con la versión vieja no se toca')
falla_con(corregir(t,h,'58784016','58785810',ok=False,motivo=' '),'Falta el motivo','sin motivo no se toca')
falla_con(corregir(t,h,'58784016','58785810',ok=False,actor_='null'),'Falta identidad','sin actor no se toca')
falla_con(corregir(t,h,'58784016','RE 77399',ok=False),'Remito inválido','un id que no es número no se acepta')

# El remito nuevo ya está en otra entrega: como clave, como remito o por el presupuesto del que salió.
h2=hoja(t,'2026-09-10')
entrega(h2,'58799999','58799999',77500,cliente=600)
entrega(h2,'58780000','58781111',58100,cliente=601,orden=1)
sql(f"insert into presupuestos_facturados(tenant_id,im_comprobante_id,cod_cliente,im_remito_id) values({lit(t)},'58780000',601,'58782222')")
falla_con(corregir(t,h,'58784016','58799999',77500,ok=False),'ya está en la hoja','un remito que es clave en otra hoja no se repite')
falla_con(corregir(t,h,'58784016','58781111',77450,ok=False),'ya está en la hoja','un remito que es el remito de otra entrega no se repite')
falla_con(corregir(t,h,'58784016','58782222',77460,ok=False),'ya está en la hoja','un remito cuyo presupuesto está en otra hoja no se repite')
sql(f"insert into retiros_sucursal(tenant_id,im_comprobante_id,cod_cliente,fecha,im_remito_id) values({lit(t)},'58790001',1347,'2026-09-10','58790001')")
falla_con(corregir(t,h,'58784016','58790001',77600,ok=False),'Retiros en sucursal','un remito que el cliente retira no va a una hoja')
check('nada de eso tocó a LEAL', sql("select im_comprobante_id||'|'||jsonb_array_length(remito_historial) from hojas_ruta_pedidos where cod_cliente=1347")=='58784016|0')

# Con notas cargadas en la hoja, cuelgan de la clave vieja: no se toca (como en la 054).
# (Una nota sólo se ata a una entrega con factura unívoca: la 043 lo exige.)
sql("update hojas_ruta_pedidos set im_factura_id='58784000' where im_comprobante_id='58784016'")
sql(f"insert into hojas_ruta_ajustes(tenant_id,hoja_id,im_comprobante_id,cod_cliente,tipo,motivo,importe) values({lit(t)},{lit(h['id'])},'58784016',1347,'nd','DIF LISTAS',10)")
falla_con(corregir(t,h,'58784016','58785811',77401,ok=False),'tiene notas','con una nota en la hoja no se toca')

# Las hojas anteriores al 08/09 guardan el presupuesto como clave.
t3=identity(); h3=hoja(t3)
entrega(h3,'58650000','58650099',76000)
falla_con(corregir(t3,h3,'58650000','58650100',76001,ok=False),'presupuesto','una entrega guardada por presupuesto no se corrige desde acá')

# Una hoja anulada no se corrige.
t4=identity(); h4=hoja(t4)
entrega(h4,'58600000','58600000',76500)
sql(f"select mutar_reparto({lit(t4)},{lit(actor)},'hoja_editar',{js({'hoja_id':h4['id'],'version_esperada':version(h4),'cambios':{'estado':'anulada'}})})")
falla_con(corregir(t4,h4,'58600000','58600001',76501,ok=False),'anulada','en una hoja anulada no se toca')

check('sólo el servidor la puede llamar',
      sql("select has_function_privilege('anon','corregir_remito_entrega(uuid,uuid,jsonb)','execute')::text||has_function_privilege('authenticated','corregir_remito_entrega(uuid,uuid,jsonb)','execute')::text")=='falsefalse')

print(json.dumps({'db_corregir_remito':checks},ensure_ascii=False))
