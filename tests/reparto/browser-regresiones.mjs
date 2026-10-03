import fs from 'node:fs/promises';
import {browser,results,out,base,user,row,rows,presupuestos,item,reply,setup,assert,test} from './browser-fixtures.mjs';
try {
  for(const width of [1440,768,390,360]) {
    await test('Navegación y ancho '+width, async()=>{
      const {page,ctx}=await setup(width);
      try {
        for(const tab of ['Presupuestos','Fraccionado','Facturación','Hojas de ruta']) {
          await page.locator('.of-tabs').getByRole('button',{name:tab,exact:true}).click();
          await page.waitForTimeout(120);
          const m=await page.evaluate(()=>({width:document.querySelector('.of-body').clientWidth,scroll:document.querySelector('.of-body').scrollWidth}));
          assert(m.scroll <= m.width+2,`${tab}: contenido ${m.scroll}px excede contenedor ${m.width}px`);
          await page.screenshot({path:`${out}/ui-${width}-${tab.replaceAll(' ','-')}.png`,fullPage:true});
        }
      } finally { await ctx.close(); }
    });
  }
  await test('Detalle conserva identidad y guarda productos del cliente correcto', async()=>{
    const {page,ctx}=await setup();
    try {
      let releaseA,releaseB;
      const gateA=new Promise(r=>releaseA=r),gateB=new Promise(r=>releaseB=r);
      await page.route('**/api/presupuestos/101',async r=>{await gateA;await reply(r,{items:[item(11,'PRODUCTO ALFA')],comprobante:{im_comprobante_id:'101',numero:101,cod_cliente:101,cliente_nombre:'CLIENTE ALFA',fecha:'2026-09-10',observaciones:'OBS ALFA',huella:'v101'}}).catch(()=>{});});
      await page.route('**/api/presupuestos/102',async r=>{await gateB;await reply(r,{items:[item(22,'PRODUCTO BETA')],comprobante:{im_comprobante_id:'102',numero:102,cod_cliente:102,cliente_nombre:'CLIENTE BETA',fecha:'2026-09-10',observaciones:'OBS BETA',huella:'v102'}}).catch(()=>{});});
      await page.locator('.pr-abrir').nth(0).click();
      await page.locator('.pr-abrir').nth(1).click();
      releaseA(); await page.waitForTimeout(150);
      assert(!await page.locator('.ed-tabla tbody tr').filter({hasText:'PRODUCTO ALFA'}).isVisible(),'Respuesta ALFA aparece bajo BETA');
      releaseB(); await page.locator('.ed-tabla tbody tr').filter({hasText:'PRODUCTO BETA'}).waitFor().catch(async e=>{await fs.writeFile(`${out}/detalle-fallo.html`,await page.content());await page.screenshot({path:`${out}/detalle-fallo.png`,fullPage:true});throw e;});
      let saved;
      await page.route('**/api/presupuestos/102/editar',async r=>{saved=r.request().postDataJSON();await reply(r,{ok:true,modo:'cantidades',im_numero:102});});
      page.on('dialog',d=>d.accept());
      await page.locator('.pr-detalle .ed-cant').fill('3');
      await page.locator('.pr-detalle').getByRole('button',{name:/Guardar/}).click();
      await page.waitForTimeout(150);
      assert(saved?.items?.[0]?.cod_articulo===22,'Guardado tiene artículos de otro cliente');
      assert(saved?.huella==='v102','Guardado no conserva versión origen');
      await page.screenshot({path:`${out}/detalle-correcto.png`,fullPage:true});
    } finally { await ctx.close(); }
  });
  /** 🔄 15/09/2026: se eliminó Aprobar. Lo que queda es Observar, que usa el mismo camino. */
  await test('Observar usa la versión del detalle visible, no la del listado',async()=>{
    const {page,ctx}=await setup();
    try {
      let enviado=null;
      await page.route('**/api/presupuestos/101',r=>reply(r,{items:[item(11,'PRODUCTO REVISADO')],comprobante:{im_comprobante_id:'101',numero:101,cod_cliente:101,fecha:'2026-09-10',huella:'detalle-actual'}}));
      await page.route('**/api/presupuestos/101/revision',r=>{enviado=r.request().postDataJSON();return reply(r,{error:'Conflicto simulado'},409);});
      await page.locator('.pr-abrir').nth(0).click();
      await page.locator('.ed-tabla tbody tr').filter({hasText:'PRODUCTO REVISADO'}).waitFor();
      await page.getByRole('button',{name:'Observar',exact:true}).nth(0).click();
      await page.locator('.pr-observar input').fill('falta stock');
      await page.locator('.pr-observar').getByRole('button',{name:'Guardar',exact:true}).click();
      await page.getByText('Conflicto simulado',{exact:true}).waitFor();
      assert(enviado?.huella==='detalle-actual','Se envió la versión vieja del listado');
      assert(enviado?.estado==='observado',`Mandó otro estado: ${JSON.stringify(enviado)}`);
    } finally {await ctx.close();}
  });

  /**
   * 🔴 YA NO HAY QUE APROBAR PARA FACTURAR. Mati (15/09/2026): *"eliminar el paso donde se
   * aprueban los presupuestos... una vez que se editan, directamente se pueda facturar"*.
   */
  await test('No hay paso de aprobar: el presupuesto se puede facturar sin visto bueno', async()=>{
    const {page,ctx}=await setup();
    try {
      assert(await page.getByRole('button',{name:'Aprobar',exact:true}).count()===0,'Sigue estando el botón Aprobar');
      // Y el que queda es el freno, no la confirmación.
      assert(await page.getByRole('button',{name:'Observar',exact:true}).count()>0,'Se perdió el botón Observar');
    } finally {await ctx.close();}
  });
  /**
   * 🔴 Mati (11/09/2026), después de aprobar un presupuesto: *"¿qué es borrador?"*.
   *
   * El cartel de abajo salía por tener el detalle abierto y fuera del filtro, sin mirar si había
   * cambios. Como marcarlo lo saca del filtro por defecto, abrir uno para mirarlo y marcarlo ya
   * lo disparaba.
   */
  await test('Observar un PR abierto sin editar NO lo llama borrador', async()=>{
    const {page,ctx}=await setup();
    try {
      await page.route('**/api/presupuestos/101',r=>reply(r,{items:[item(11,'PRODUCTO LIMPIO')],comprobante:{im_comprobante_id:'101',numero:101,cod_cliente:101,fecha:'2026-09-10',huella:'v101'}}));
      await page.route('**/api/presupuestos/101/revision',r=>reply(r,{ok:true}));
      await page.locator('.pr-abrir').nth(0).click();
      await page.locator('.ed-tabla tbody tr').filter({hasText:'PRODUCTO LIMPIO'}).waitFor();
      // Marcarlo lo saca de "Para facturar", que es el filtro por defecto: el panel de abajo aparece.
      await page.getByRole('button',{name:'Observar',exact:true}).nth(0).click();
      await page.locator('.pr-observar input').fill('falta stock');
      await page.locator('.pr-observar').getByRole('button',{name:'Guardar',exact:true}).click();
      await page.locator('.pr-detalle').waitFor();
      const texto = await page.locator('.pr-detalle-motivo').innerText();
      assert(!/borrador/i.test(texto), `Sigue diciendo borrador sin cambios: "${texto}"`);
      assert(/fuera del filtro/i.test(texto), `Perdió la explicación de por qué está abajo: "${texto}"`);
      // Y el aviso de borradores REALES de arriba no se inventa ninguno.
      assert(await page.getByText('Borradores sin guardar:').count()===0,'Inventó un borrador sin guardar');
      // 🔑 Se marcó de verdad: está en "Con problema", no sólo ausente de la palabra.
      await page.getByRole('button',{name:/^Con problema/}).click();
      await page.locator('.pr-fila').filter({hasText:'CLIENTE ALFA'}).waitFor();
    } finally {await ctx.close();}
  });

  /**
   * 🪤 Astra (11/09/2026): `reparto.borradores` es un Map pelado y escribirlo no re-renderiza.
   * Si se edita DESPUÉS de que el detalle quedó fuera del filtro, el cartel seguía afirmando lo
   * que ya no era cierto. Se prueba el ciclo entero sin tocar el filtro en el medio.
   */
  await test('El cartel se actualiza al ensuciar y al revertir, sin tocar el filtro', async()=>{
    const {page,ctx}=await setup();
    try {
      await page.route('**/api/presupuestos/101',r=>reply(r,{items:[item(11,'PRODUCTO LIMPIO')],comprobante:{im_comprobante_id:'101',numero:101,cod_cliente:101,fecha:'2026-09-10',huella:'v101'}}));
      await page.route('**/api/presupuestos/101/revision',r=>reply(r,{ok:true}));
      await page.locator('.pr-abrir').nth(0).click();
      await page.locator('.pr-detalle .ed-cant').waitFor();
      const original = await page.locator('.pr-detalle .ed-cant').inputValue();
      await page.getByRole('button',{name:'Observar',exact:true}).nth(0).click();
      await page.locator('.pr-observar input').fill('falta stock');
      await page.locator('.pr-observar').getByRole('button',{name:'Guardar',exact:true}).click();
      await page.locator('.pr-detalle-motivo').waitFor();
      assert(!/borrador/i.test(await page.locator('.pr-detalle-motivo').innerText()),'Arranca diciendo borrador');

      // Ensuciar ACÁ ABAJO, con el detalle ya fuera del filtro.
      await page.locator('.pr-detalle .ed-cant').fill('7');
      await page.locator('.pr-detalle-motivo').filter({hasText:/borrador/i}).waitFor();
      assert(await page.getByText('Borradores sin guardar:').isVisible(),'No apareció el aviso de borradores reales');

      // Y al volver al valor original tiene que dejar de decirlo.
      await page.locator('.pr-detalle .ed-cant').fill(original);
      await page.locator('.pr-detalle-motivo').filter({hasText:/^Detalle del PR/}).waitFor();
      assert(await page.getByText('Borradores sin guardar:').count()===0,'Quedó un borrador después de revertir');
    } finally {await ctx.close();}
  });

  /** La otra cara: con un cambio de verdad, el cartel SÍ tiene que avisar y proteger. */
  await test('Con cambios sin guardar sí dice borrador y no se pierden al filtrar', async()=>{
    const {page,ctx}=await setup();
    try {
      await page.route('**/api/presupuestos/101',r=>reply(r,{items:[item(11,'PRODUCTO EDITADO')],comprobante:{im_comprobante_id:'101',numero:101,cod_cliente:101,fecha:'2026-09-10',huella:'v101'}}));
      await page.locator('.pr-abrir').nth(0).click();
      await page.locator('.pr-detalle .ed-cant').waitFor();
      await page.locator('.pr-detalle .ed-cant').fill('7');
      // Se lo saca del filtro por búsqueda, sin aprobarlo: el borrador tiene que sobrevivir.
      await page.locator('.pr-buscador input').fill('CLIENTE BETA');
      await page.locator('.pr-detalle').waitFor();
      const texto = await page.locator('.pr-detalle-motivo').innerText();
      assert(/borrador/i.test(texto), `No avisa que hay cambios sin guardar: "${texto}"`);
      assert(/sin guardar/i.test(texto), `No dice que son cambios sin guardar: "${texto}"`);
      assert(await page.locator('.pr-detalle .ed-cant').inputValue()==='7','Se perdió el cambio al filtrar');
      assert(await page.getByText('Borradores sin guardar:').isVisible(),'Perdió el aviso de borradores reales');
    } finally {await ctx.close();}
  });

  await test('Respuesta de rango antiguo no reemplaza la actual', async()=>{
    const {page,ctx}=await setup();
    try {
      let release;
      const gate=new Promise(r=>release=r);
      await page.route('**/api/presupuestos?**',async route=>{
        const desde=new URL(route.request().url()).searchParams.get('desde');
        if(desde==='2026-09-08') await gate;
        await reply(route,presupuestos([row('201','DATOS DEL '+desde,desde)])).catch(()=>{});
      });
      await page.locator('.of-rango input').nth(0).fill('2026-09-08');
      await page.locator('.of-rango input').nth(0).fill('2026-09-09');
      await page.getByText('DATOS DEL 2026-09-09',{exact:true}).waitFor();
      release(); await page.waitForTimeout(150);
      assert(!await page.getByText('DATOS DEL 2026-09-08',{exact:true}).isVisible(),'Datos viejos reemplazan la fecha actual');
      assert(await page.getByText('DATOS DEL 2026-09-09',{exact:true}).isVisible(),'Se perdió la respuesta actual');
    } finally { await ctx.close(); }
  });
  await test('Fraccionado no imprime datos anteriores después de error', async()=>{
    const {page,ctx}=await setup();
    try {
      await page.locator('.of-tabs button').filter({hasText:'Fraccionado'}).click();
      await page.getByText('ALPISTE AUDITORÍA',{exact:true}).waitFor();
      await page.route('**/api/presupuestos/fraccionado?**',r=>reply(r,{error:'Corte simulado de InfoManager'},502));
      await page.locator('.of-rango input').nth(0).fill('2026-09-08');
      await page.getByText('Corte simulado de InfoManager',{exact:true}).waitFor();
      assert(!await page.getByRole('button',{name:'Imprimir',exact:true}).isEnabled(),'Imprimir está habilitado tras error');
      assert(!await page.getByText('ALPISTE AUDITORÍA',{exact:true}).isVisible(),'Quedaron filas anteriores bajo fecha nueva');
      await page.pdf({path:`${out}/fraccionado-error.pdf`,format:'A4'});
    } finally { await ctx.close(); }
  });
  await test('Elegir todos comprueba pertenencia, preserva selección visible', async()=>{
    const {page,ctx}=await setup();
    try {
      await page.locator('.of-tabs button').filter({hasText:'Facturación'}).click();
      await page.locator('.fc-tabla').waitFor();
      await page.locator('.fc-tabla tbody input[type=checkbox]').nth(0).check();
      await page.locator('.fc-buscador input').fill('BETA');
      assert(!await page.getByTitle('Elegir todos',{exact:true}).isChecked(),'Encabezado marcado por selección de otro cliente');
      assert(await page.getByRole('status').filter({hasText:/seleccionados.*fuera/}).isVisible(),'No advierte selección fuera del filtro');
      await page.getByTitle('Elegir todos',{exact:true}).check();
      await page.locator('.fc-buscador input').fill('');
      assert(await page.locator('.fc-tabla tbody input:checked').count()===2,'Elegir visibles borra la selección anterior');
    } finally { await ctx.close(); }
  });
  await test('Cambiar de etapa conserva borradores y evita consultas de vistas ocultas', async()=>{
    const {page,ctx,seen}=await setup();
    try {
      await page.locator('.pr-abrir').first().click();
      await page.locator('.pr-detalle .ed-cant').fill('7');
      await page.locator('.of-tabs').getByRole('button',{name:'Facturación',exact:true}).click();
      await page.locator('.fc-tabla').waitFor();
      await page.locator('.fc-tabla tbody input[type=checkbox]').first().check();
      const start=seen.length;
      await page.locator('.of-rango input').nth(0).fill('2026-09-08');
      await page.waitForTimeout(150);
      assert(!seen.slice(start).some(url=>/^\/api\/presupuestos(?:\?|\/consolidado|\/fraccionado)/.test(url)), 'Cambiar el rango consulta una etapa oculta');
      await page.locator('.of-tabs').getByRole('button',{name:'Presupuestos',exact:true}).click();
      await page.locator('.pr-detalle .ed-cant').waitFor();
      assert(await page.locator('.pr-detalle .ed-cant').inputValue()==='7','Se perdió el borrador al volver a la etapa');
      await page.locator('.ps-subtabs').getByRole('button',{name:'Por artículo',exact:true}).click();
      await page.waitForTimeout(150);
      const subStart=seen.length;
      await page.locator('.of-rango input').nth(0).fill('2026-09-07');
      await page.waitForTimeout(150);
      assert(!seen.slice(subStart).some(url=>/^\/api\/presupuestos\?/.test(url)), 'Por pedido oculta sigue consultando el rango');
      await page.locator('.ps-subtabs').getByRole('button',{name:'Por pedido',exact:true}).click();
      await page.locator('.pr-detalle .ed-cant').waitFor();
      assert(await page.locator('.pr-detalle .ed-cant').inputValue()==='7','Se perdió el borrador al cambiar de subsección');
    } finally { await ctx.close(); }
  });
  /**
   * 🔑 01/10/2026 — CARDENES, PR 59080: mercadería ya facturada escrita a mano en IM ("MEZCLA GALLO
   * PREM", $0). Mati eligió que la guarde la app: se ve aparte, se carga con el mismo buscador y
   * guardar sólo eso no toca InfoManager.
   */
  const conPendientes=(extra={})=>({items:[item(11,'PRODUCTO ALFA')],comprobante:{im_comprobante_id:'101',numero:101,cod_cliente:101,cliente_nombre:'CLIENTE ALFA',fecha:'2026-09-10',huella:'v101'},
    pendientes:[{id:null,im_renglon_id:'5001',cod_articulo:null,descripcion:'MEZCLA GALLO PREM',cantidad:300,factura_ref:null,origen:'im'}],pendientes_disponibles:true,pendientes_error:null,...extra});
  await test('Lo ya facturado va aparte, se carga con el buscador y guardarlo no toca InfoManager', async()=>{
    const {page,ctx}=await setup();
    try {
      await page.route('**/api/presupuestos?**',r=>reply(r,presupuestos([{...row('101','CLIENTE ALFA'),pendientes:[{descripcion:'MEZCLA GALLO PREM',cantidad:300,origen:'im'}]},row('102','CLIENTE BETA')])));
      await page.route('**/api/presupuestos/101',r=>reply(r,conPendientes()));
      await page.route('**/api/articulos/buscar?**',r=>reply(r,{ok:true,articulos:[{cod_articulo:491,descripcion:'MEZCLA GALLO PREMIUM',unidad_de_medida:null,equivalencia_um:1,precio_venta:1330}]}));
      let saved=null,dialogos=0;
      await page.route('**/api/presupuestos/101/editar',async r=>{saved=r.request().postDataJSON();await reply(r,{ok:true,modo:'pendientes',im_numero:101});});
      page.on('dialog',d=>{dialogos++;d.accept();});
      // En la fila, sin abrirla: quien arma el pedido tiene que verlo. (La lista ya cargó: se actualiza.)
      await page.locator('.pr-top').getByRole('button',{name:/Actualizar/}).click();
      await page.locator('.pr-pendientes').first().waitFor();
      assert(/Lleva además, ya facturado: 300 MEZCLA GALLO PREM/.test(await page.locator('.pr-pendientes').first().innerText()),'La fila no muestra lo que lleva sin cobrar');
      await page.locator('.pr-abrir').nth(0).click();
      await page.locator('.ed-pendientes').waitFor();
      assert(/MEZCLA GALLO PREM/.test(await page.locator('.ed-pend-tabla').innerText()),'No se ve el renglón escrito en IM');
      assert(/en InfoManager/.test(await page.locator('.ed-pend-tabla').innerText()),'No dice que está escrito en InfoManager');
      assert(!/MEZCLA GALLO PREM/.test(await page.locator('.ed-tabla:not(.ed-pend-tabla)').innerText()),'Lo ya facturado aparece entre los renglones que se cobran');
      await page.locator('.ed-buscar input').fill('gallo');
      await page.locator('.ed-buscar input').press('Enter');
      await page.locator('.ed-res-pend').first().click();
      await page.locator('input[aria-label="Cantidad ya facturada de MEZCLA GALLO PREMIUM"]').fill('150');
      await page.locator('input[aria-label="Factura de MEZCLA GALLO PREMIUM"]').fill('FA B 50680');
      assert(!await page.getByText('Al guardar se',{exact:false}).isVisible(),'Sumar algo ya facturado no tiene por qué rehacer el presupuesto');
      const boton=page.locator('.pr-detalle .ed-pie button').last();
      assert(/^\s*Guardar\s*$/.test(await boton.innerText()),`El botón dice "${await boton.innerText()}"`);
      await page.screenshot({path:`${out}/pendientes-editor.png`,fullPage:true});
      await boton.click();
      await page.waitForTimeout(200);
      assert(dialogos===0,'Pidió confirmar algo que no rehace nada');
      assert(saved,'No se guardó');
      assert(saved.items.length===1&&saved.items[0].cod_articulo===11,'Mandó los pendientes como renglones a facturar');
      assert(JSON.stringify(saved.pendientes)===JSON.stringify([
        {id:null,im_renglon_id:'5001',cod_articulo:null,descripcion:'MEZCLA GALLO PREM',cantidad:300,factura_ref:null,origen:'im'},
        {id:null,im_renglon_id:null,cod_articulo:491,descripcion:'MEZCLA GALLO PREMIUM',cantidad:150,factura_ref:'FA B 50680',origen:'app'},
      ]),`Lista mal armada: ${JSON.stringify(saved.pendientes)}`);
      await page.getByText('se guardó lo que lleva sin cobrar',{exact:false}).waitFor();
      await page.screenshot({path:`${out}/pendientes-guardado.png`,fullPage:true});
    } finally { await ctx.close(); }
  });
  await test('Tocar lo escrito en InfoManager avisa ANTES que se rehace el presupuesto', async()=>{
    const {page,ctx}=await setup();
    try {
      await page.route('**/api/presupuestos/101',r=>reply(r,conPendientes()));
      let saved=null,mensaje='';
      await page.route('**/api/presupuestos/101/editar',async r=>{saved=r.request().postDataJSON();await reply(r,{ok:true,modo:'recreado',im_numero:59400});});
      page.on('dialog',d=>{mensaje=d.message();d.accept();});
      await page.locator('.pr-abrir').nth(0).click();
      await page.locator('input[aria-label="Cantidad ya facturada de MEZCLA GALLO PREM"]').fill('200');
      await page.getByText('Al guardar se',{exact:false}).waitFor();
      await page.locator('.pr-detalle .ed-pie button').last().click();
      await page.waitForTimeout(200);
      assert(/pasa a la app/.test(mensaje),`La confirmación no dice que lo escrito en IM pasa a la app: "${mensaje}"`);
      assert(saved?.pendientes?.[0]?.cantidad===200&&saved.pendientes[0].origen==='im','No viajó el cambio de lo escrito en IM');
    } finally { await ctx.close(); }
  });
  await test('Si no se pudo leer lo ya facturado, guardar no manda una lista vacía', async()=>{
    const {page,ctx}=await setup();
    try {
      await page.route('**/api/presupuestos/101',r=>reply(r,conPendientes({pendientes:null,pendientes_disponibles:false,pendientes_error:'No pude leer lo que lleva sin cobrar: corte simulado'})));
      let saved=null;
      await page.route('**/api/presupuestos/101/editar',async r=>{saved=r.request().postDataJSON();await reply(r,{ok:true,modo:'cantidades',im_numero:101});});
      await page.locator('.pr-abrir').nth(0).click();
      await page.getByText('corte simulado',{exact:false}).waitFor();
      assert(!await page.locator('.ed-res-pend').count(),'Ofrece cargar sin haber podido leer la lista');
      await page.locator('.pr-detalle .ed-cant').fill('3');
      await page.locator('.pr-detalle .ed-pie button').last().click();
      await page.waitForTimeout(200);
      assert(saved&&!('pendientes' in saved),`Mandó una lista que no leyó: ${JSON.stringify(saved?.pendientes)}`);
    } finally { await ctx.close(); }
  });
  await test('La hoja impresa dice qué lleva sin cobrar y no rompe el total del cliente', async()=>{
    const {page,ctx}=await setup();
    try {
      const h={version:1,id:'h1',numero:3450,fecha:'2026-10-02',turno:'Mañana',camion:'Camión 5000',camion_id:'c1',capacidad_kg:5000,chofer:'Chofer auditoría',chofer_id:'ch1',estado:'abierta',facturada:true,pedidos:rows.map(x=>({...x,saldo_anterior:25000,im_remito_numero:5000,im_factura_numero:4000,facturado_at:'2026-10-02'})),totales:{pedidos:2,bultos:20,kg:600},carga:{porcentaje:12,excedido:false,sobra_kg:4400}};
      await page.route('**/api/hojas-ruta?**',r=>reply(r,{hojas:[h]}));
      const clientes=[
        {cod_empresa:1,cod_cliente:742,cliente_nombre:'CARDENES, Walter (Alberdi)',saldo_anterior:25000,total:1044690.4,bultos:330,kg:700,
          comprobantes:[{im_numero:78400,im_remito_numero:78400,bultos:330,kg:700,total:1044690.4,facturado:true,
            pendientes:[{descripcion:'MEZCLA GALLO PREMIUM',cantidad:300,factura_ref:'FA B 50680'},{descripcion:'MAIZ LEALES 25 PENDIENTE',cantidad:10,factura_ref:null}]}]},
        {cod_empresa:1,cod_cliente:5,cliente_nombre:'OTRO CLIENTE',saldo_anterior:0,total:150000,bultos:10,kg:300,comprobantes:[{im_numero:78401,bultos:10,kg:300,total:150000,facturado:true}]},
      ];
      await page.route('**/api/hojas-ruta/h1/impresion',r=>reply(r,{hoja:h,clientes,totales:{clientes:2,comprobantes:2,bultos:340,kg:1000,total:1194690.4},fraccionado:[],fraccionado_completo:true,dias_faltantes:[],fraccionado_totales:{productos:0,paquetes:0,kg:0},sin_saldo:0}));
      await page.locator('.of-tabs button').filter({hasText:'Hojas de ruta'}).click();
      await page.locator('.hr-hoja').waitFor();
      await page.getByTitle('Imprimir la hoja y el listado de fraccionado',{exact:true}).click();
      await page.locator('.imp-pendiente').waitFor();
      const fila=await page.locator('.imp-pendiente').innerText();
      assert(/Lleva además, ya facturado \(no se cobra\)/.test(fila),`Falta el rótulo: "${fila}"`);
      assert(/300 MEZCLA GALLO PREMIUM \(FA B 50680\)/.test(fila)&&/10 MAIZ LEALES 25 PENDIENTE/.test(fila),`Falta lo que lleva: "${fila}"`);
      assert(await page.locator('.imp-pendiente').count()===1,'Sale en un cliente que no lleva nada');
      // El total y el saldo del cliente siguen siendo UNA celda que abarca también esta fila.
      const span=await page.locator('.imp-grupo').first().locator('td.total-cli').getAttribute('rowspan');
      assert(span==='2',`El total del cliente no abarca la fila nueva (rowspan ${span})`);
      assert(!/pedidos/.test(await page.locator('.imp-grupo').first().locator('td.total-cli').innerText()),'Cuenta la fila de lo ya facturado como otro pedido');
      await page.screenshot({path:`${out}/hoja-con-pendientes.png`,fullPage:true});
    } finally { await ctx.close(); }
  });
  /**
   * 🔴 01/10/2026 — Mati: *"hay que poner para que la app se pueda poner decimales en las
   * cantidades al facturar, parece que no está contemplado"*. InfoManager las acepta (0,5 kg de
   * almendras, 6,8 de banana en septiembre) y el servidor ya calcula la nota con 4 decimales, pero
   * en Corregir factura cada tecla se convertía a número: "9," quedaba "9" y la coma no se podía
   * escribir nunca. Se tipea tecla por tecla, como en el teclado del celular.
   */
  await test('Corregir factura acepta cantidad, precio y descuento con decimales (coma o punto)', async()=>{
    const {page,ctx}=await setup();
    try {
      await page.route('**/api/facturacion?**',r=>reply(r,{pendientes:[],facturados:[{...rows[0],im_factura_id:'501',im_factura_numero:501,im_factura_tipo:'FA B',notas:[]}],totales:{pendientes:0,facturados:1}}));
      await page.route('**/api/facturacion/corregir/501',r=>reply(r,{factura:{id:'501',numero:501,letra:'B',cliente_nombre:'CLIENTE ALFA',fecha:'2026-09-10'},version:3,operacion:null,bloqueo_productos:null,renglones:[{cod_articulo:11,descripcion:'PRODUCTO A',cantidad:10,precio:100,descuento_porc:0,iva_por:21}]}));
      let enviado=null;
      await page.route('**/api/facturacion/corregir',r=>{enviado=r.request().postDataJSON();return reply(r,{ok:true,version:3,nc:[],nd:[],total_nc:0,total_nd:0,diferencia:0});});
      await page.locator('.of-tabs').getByRole('button',{name:'Facturación',exact:true}).click();
      await page.locator('.fc-facturados summary').click();
      // "Corregir" hoy; "Editar" con la solapa de notas aparte cuando salga la edición de facturas.
      await page.getByRole('button',{name:/^(Corregir|Editar)$/}).first().click();
      const solapaNotas=page.getByRole('button',{name:'Con notas (NC/ND)',exact:true});
      // 🪤 Las solapas aparecen cuando terminó de cargar la factura: preguntar antes daba "no está" y el test seguía en Editar.
      await page.locator('.cf-tabla').waitFor();
      if(await solapaNotas.isVisible().catch(()=>false)) await solapaNotas.click();
      const tipear=async(etiqueta,texto)=>{
        const campo=page.getByLabel(etiqueta,{exact:true});
        await campo.waitFor();
        await campo.click(); await campo.press('Control+a'); await campo.press('Backspace');
        await campo.pressSequentially(texto);
        return campo;
      };
      const ultimo=async(campo,valor)=>{
        for(let i=0;i<80&&enviado?.renglones?.[0]?.[campo]!==valor;i++)await new Promise(r=>setTimeout(r,25));
        return enviado?.renglones?.[0]?.[campo];
      };

      const cant=await tipear('Cantidad de PRODUCTO A','9,5');
      assert(await cant.inputValue()==='9,5',`La coma no se pudo escribir en la cantidad: quedó "${await cant.inputValue()}"`);
      const q=await ultimo('cantidad',9.5);
      assert(q===9.5,`No mandó la cantidad con decimales: ${JSON.stringify(q)}`);
      // Una letra no es una cantidad: se ignora, no deja el renglón en cero.
      await cant.pressSequentially('x');
      assert(await cant.inputValue()==='9,5',`Una letra cambió la cantidad: "${await cant.inputValue()}"`);
      await cant.press('Tab');
      assert(['9.5','9,5'].includes(await cant.inputValue()),`Al salir del campo la cantidad quedó "${await cant.inputValue()}"`);

      // Empezar por la coma, como se dice: ",5" es medio kilo.
      const media=await tipear('Cantidad de PRODUCTO A',',5');
      assert(await media.inputValue()===',5',`No se pudo empezar por la coma: quedó "${await media.inputValue()}"`);
      assert(await ultimo('cantidad',0.5)===0.5,'No mandó 0,5');

      const precio=await tipear('Precio de PRODUCTO A','99.75');
      assert(await precio.inputValue()==='99.75',`El punto no se pudo escribir en el precio: quedó "${await precio.inputValue()}"`);
      assert(await ultimo('precio',99.75)===99.75,'No mandó el precio con decimales');

      const desc=await tipear('Descuento de PRODUCTO A','12,5');
      assert(await desc.inputValue()==='12,5',`La coma no se pudo escribir en el descuento: quedó "${await desc.inputValue()}"`);
      assert(await ultimo('descuento_porc',12.5)===12.5,'No mandó el descuento con decimales');
      // El tope de 0-100 se sigue viendo al instante.
      await desc.fill('150');
      assert(await desc.inputValue()==='100',`Aceptó un descuento fuera de 0-100: ${await desc.inputValue()}`);
      await page.screenshot({path:`${out}/correccion-decimales.png`,fullPage:true});
    } finally { await ctx.close(); }
  });
} finally {
  await fs.writeFile(`${out}/browser-regresiones.json`,JSON.stringify(results,null,2));
  await browser.close();
}
console.log(JSON.stringify(results,null,2));
if(results.cases.some(c=>!c.passed)||results.consoleErrors.length)process.exitCode=1;
