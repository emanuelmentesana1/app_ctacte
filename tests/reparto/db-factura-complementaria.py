"""059: factura complementaria + remito en el journal de correcciones (opción C, 06/10/2026).
La FA queda como corrección con importe; el RE va a su tabla y NO a facturas_correcciones."""
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

def operacion(tenant, factura, tipos):
    op=identity()
    peticion={'motivo':'no se cargó bolitas según HR 3449','numero_factura':51218,'origen':{'cliente':313,'empresa':1}}
    comps=[{'tipo':t,'datos':{'cod_cliente':313,'cod_empresa':1,'total':{'NC':56755.28,'FA':47364.72,'RE':47364.72,'ND':100}[t]}} for t in tipos]
    original=[{'cod_articulo':320,'cantidad':4,'precio':14188.82}]
    return json.loads(sql(f"select iniciar_operacion_factura({lit(tenant)},{lit(op)},{lit(factura)},0,'productos',{js(peticion)},{js(comps)},{js(original)},{js(original)},{lit(actor)})"))
def paso(tenant, o, resultado, incierto=False):
    token=identity()
    sql(f"select tomar_paso_factura({lit(tenant)},{lit(o['id'])},{o['indice']},{lit(token)})")
    r = 'null' if resultado is None else js(resultado)
    err = "'timeout'" if resultado is None else 'null'
    return json.loads(sql(f"select terminar_paso_factura({lit(tenant)},{lit(o['id'])},{lit(token)},{r},{err},{'true' if incierto else 'false'})"))

# ── NC → FA → RE: la FA queda como corrección y el RE en su tabla ─────────────────────────
t=identity(); fa_original='59051645'
o=operacion(t,fa_original,['NC','FA','RE'])
o=paso(t,o,{'id':'59074743','numero':30215,'tipo':'NC B','total':56755.28})
o=paso(t,o,{'id':'59080001','numero':51300,'tipo':'FA B','total':47364.72})
o=paso(t,o,{'id':'59080002','numero':78700,'tipo':'RE','total':47364.72})
check('la operación termina completa', o['estado']=='completo' and o['indice']==3)
check('la NC y la FA quedan como correcciones de la factura, con su importe',
      sql(f"select string_agg(tipo||':'||total,',' order by tipo) from facturas_correcciones where tenant_id={lit(t)} and im_factura_id={lit(fa_original)}")
      == 'FA B:47364.72,NC B:56755.28')
check('el remito NO entra en facturas_correcciones',
      sql(f"select count(*) from facturas_correcciones where tenant_id={lit(t)} and im_comprobante_id='59080002'")=='0')
check('el remito queda en su tabla, con la factura original y la complementaria',
      sql(f"select im_factura_id||'|'||im_factura_complementaria_id||'|'||numero from facturas_remitos_complementarios where tenant_id={lit(t)} and im_remito_id='59080002'")
      == f'{fa_original}|59080001|78700')
check('la factura queda libre para otra corrección',
      sql(f"select coalesce(operacion_id::text,'-')||'|'||version from facturas_estado_correccion where tenant_id={lit(t)} and im_factura_id={lit(fa_original)}")=='-|1')

# ── IM no contestó la FA: se adopta la encontrada y sigue con el remito ───────────────────
t=identity()
o=operacion(t,'59000001',['FA','RE'])
o=paso(t,o,None,incierto=True)
check('sin respuesta queda incierta', o['estado']=='incierto' and o['indice']==0)
falla_con(sql(f"select adoptar_paso_factura({lit(t)},{lit(o['id'])},1,{js({'id':'59080011','numero':51301,'tipo':'FA B'})})",False),
          'No se registró nada','no se adopta en otro paso que el que está esperando')
o=json.loads(sql(f"select adoptar_paso_factura({lit(t)},{lit(o['id'])},0,{js({'id':'59080011','numero':51301,'tipo':'FA B'})})"))
check('adoptarla avanza al remito', o['estado']=='listo' and o['indice']==1)
falla_con(sql(f"select adoptar_paso_factura({lit(t)},{lit(o['id'])},1,{js({'id':'59080012','numero':78701,'tipo':'RE'})})",False),
          'No se registró nada','una operación que no está incierta no adopta nada')
o=paso(t,o,{'id':'59080012','numero':78701,'tipo':'RE'})
check('el remito toma la factura adoptada',
      sql(f"select im_factura_complementaria_id from facturas_remitos_complementarios where tenant_id={lit(t)} and im_remito_id='59080012'")=='59080011')

# ── Una NC incierta NO se adopta por acá ───────────────────────────────────────────────────
t=identity()
o=operacion(t,'59000002',['NC'])
o=paso(t,o,None,incierto=True)
falla_con(sql(f"select adoptar_paso_factura({lit(t)},{lit(o['id'])},0,{js({'id':'59080021','numero':30300,'tipo':'NC B'})})",False),
          'Sólo se adopta','una NC sin respuesta no se adopta por esta vía')

# ── Un remito no puede quedar dos veces ───────────────────────────────────────────────────
t2=identity()
o=operacion(t2,'59000003',['FA','RE'])
o=paso(t2,o,{'id':'59080031','numero':51310,'tipo':'FA B'})
token=identity()
sql(f"select tomar_paso_factura({lit(t2)},{lit(o['id'])},1,{lit(token)})")
sql(f"insert into facturas_remitos_complementarios(tenant_id,im_remito_id,im_factura_id,operacion_id) values({lit(t2)},'59080032','x',{lit(identity())})")
falla_con(sql(f"select terminar_paso_factura({lit(t2)},{lit(o['id'])},{lit(token)},{js({'id':'59080032','numero':78710,'tipo':'RE'})},null,false)",False),
          'duplicate key','el mismo remito no se registra dos veces')

print(json.dumps({'ok':True,'checks':checks},ensure_ascii=False))
