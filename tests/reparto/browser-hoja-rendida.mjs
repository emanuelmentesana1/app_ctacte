import fs from 'node:fs/promises';
import {browser,results,out,rows,reply,setup,assert,test} from './browser-fixtures.mjs';

// Mati (06/10/2026), puntos 3 y 4 del piloto de la 3449: imprimir la hoja de ruta CON los recibos que impactan
// (qué recibo, a qué factura, efectivo o transferencia) y, al cerrar la hoja, ver toda la info antes de confirmar.
const hoja={version:1,id:'h1',numero:3449,fecha:'2026-10-05',turno:'Mañana',camion:null,camion_id:null,capacidad_kg:null,chofer:'VICTOR',chofer_id:'ch1',estado:'abierta',facturada:true,
  pedidos:rows.map(x=>({...x,saldo_anterior:25000,im_remito_numero:5000,im_factura_numero:4000,facturado_at:'2026-10-05'})),totales:{pedidos:2,bultos:20,kg:600},carga:{porcentaje:12,excedido:false,sobra_kg:4400}};
const impresion={hoja,clientes:rows.map(x=>({cod_empresa:1,cod_cliente:x.cod_cliente,cliente_nombre:x.cliente_nombre,saldo_anterior:25000,total:150000,bultos:10,kg:300,comprobantes:[{im_numero:5000,bultos:10,kg:300,total:150000,facturado:true}]})),
  totales:{clientes:2,comprobantes:2,bultos:20,kg:600,total:300000},fraccionado:[],fraccionado_completo:true,dias_faltantes:[],fraccionado_totales:{productos:0,paquetes:0,kg:0},sin_saldo:0};
const resumen={ok:true,hoja:{id:'h1',numero:3449,fecha:'2026-10-05',estado:'abierta',chofer:'VICTOR',nombre:null},
  clientes:[
    {cod_cliente:101,cliente:'CLIENTE ALFA',entregado:150000,saldo_anterior:25000,cobrado:175000,queda:0,estado:'pago',no_salieron:0,recibos:[
      {medio:'efectivo',numero:'30156395',fecha:'2026-10-05',importe:150000,origen:'app',facturas:[{numero:'777-50861',importe:125000},{numero:'777-50999',importe:25000}]},
      {medio:'mercadopago',numero:'30156410',fecha:'2026-10-05',importe:25000,origen:'app',facturas:[{numero:'777-51000',importe:25000}]}]},
    {cod_cliente:102,cliente:'CLIENTE BETA',entregado:150000,saldo_anterior:0,cobrado:138720,queda:11280,estado:'parcial',no_salieron:0,recibos:[
      {medio:'efectivo',numero:'30150001',fecha:'2026-10-05',importe:50000,origen:'im',facturas:null},
      {medio:'recaudadora_1',numero:null,fecha:'2026-10-06',importe:88720,origen:'pendiente',facturas:null}]}],
  totales:{entregado:300000,cobrado:313720,queda:11280,por_medio:{efectivo:200000,mercadopago:25000,recaudadora_1:88720},recibos:3,sin_detalle:1,pendientes:1},
  rendicion:{gastos:[{concepto:'Ayudante',importe:18000,detalle:null}],efectivo:200000,total_gastos:18000,debe_entregar:182000,contado:181956,diferencia:-44,contado_por:'Anto',contado_at:'2026-10-06T12:46:15Z',controlado_por:null,controlado_at:null},
  gastos_im:[],asiento_id:null,consultado:{im_recibos:true,im_mayor:true}};

try {
  const {page,ctx}=await setup(1440);
  const cierres=[];
  await page.route('**/api/hojas-ruta?**',r=>reply(r,{hojas:[hoja]}));
  await page.route('**/api/hojas-ruta/h1/impresion',r=>reply(r,impresion));
  await page.route('**/api/rendiciones/hoja/h1/resumen',r=>reply(r,resumen));
  await page.route('**/api/hojas-ruta/h1',r=>{
    if(r.request().method()!=='PUT')return reply(r,{error:'sin fixture'},501);
    cierres.push(JSON.parse(r.request().postData()||'{}'));
    return reply(r,{ok:true,hoja:{...hoja,estado:'cerrada',version:2}});
  });
  await page.locator('.of-tabs button').filter({hasText:'Hojas de ruta'}).click();
  await page.locator('.hr-hoja').waitFor();

  await test('🔑 la hoja impresa con los recibos: número, medio, a qué facturas y lo que no se sabe',async()=>{
    await page.getByTitle('Imprimir la hoja y el listado de fraccionado',{exact:true}).click();
    await page.locator('.imp-tabs button').filter({hasText:'Con los recibos'}).click();
    await page.getByText('RC 30156395',{exact:false}).first().waitFor();
    const papel=await page.locator('.imp-hoja').innerText();
    for(const t of ['777-50861','777-50999','RC 30156410','MercadoPago','Cargado a mano en IM','Cuenta Recaudadora 1','sin aprobar','Pagó todo','Pagó parte'])
      assert(papel.includes(t),`El papel no dice «${t}»`);
    assert(await page.locator('.imp-btn').filter({hasText:'Imprimir'}).isEnabled(),'No se puede imprimir');
    await page.pdf({path:`${out}/hoja-con-recibos.pdf`,format:'A4',printBackground:true});
  });

  await test('🔑 el cierre de la hoja: gastos, lo que debía entregar, lo contado, la diferencia, quién contó y quién controló',async()=>{
    const papel=await page.locator('.imp-hoja').innerText();
    for(const t of ['Ayudante','18.000,00','182.000,00','181.956,00','44,00','Contó','Anto','Sin controlar','Efectivo','200.000,00','88.720,00'])
      assert(papel.includes(t),`Falta «${t}» en el cierre`);
    await page.screenshot({path:`${out}/hoja-con-recibos.png`,fullPage:true});
    await page.locator('.imp-cerrar').click();
  });

  await test('🔴 «Cerrar hoja» muestra todo primero y sólo cierra al confirmar',async()=>{
    // Las hojas arrancan plegadas (22/09/2026): los botones del pie se ven al desplegarla.
    if(await page.locator('.hr-hoja .hr-plegar').first().getAttribute('title')==='Desplegar')await page.locator('.hr-hoja .hr-plegar').first().click();
    await page.locator('.hr-hoja-pie button').filter({hasText:'Cerrar hoja'}).click();
    await page.getByText('¿Cerrar la hoja 3449?',{exact:false}).waitFor();
    await page.getByText('RC 30156395',{exact:false}).first().waitFor();
    await page.screenshot({path:`${out}/cierre-hoja.png`,fullPage:true});
    await page.locator('.hrd-cierre button').filter({hasText:'Cancelar'}).click();
    await page.waitForTimeout(300);
    assert(!(await page.getByText('¿Cerrar la hoja 3449?',{exact:false}).count()),'Cancelar no cerró el resumen');
    assert(cierres.length===0,'Cancelar cerró la hoja igual');
    await page.locator('.hr-hoja-pie button').filter({hasText:'Cerrar hoja'}).click();
    await page.locator('.hrd-cierre button').filter({hasText:/^\s*Cerrar hoja\s*$/}).click();
    for(let i=0;i<20&&!cierres.length;i++)await page.waitForTimeout(100);
    assert(cierres.length===1&&cierres[0].estado==='cerrada',`No cerró la hoja: ${JSON.stringify(cierres)}`);
  });
  await ctx.close();
} finally {await fs.writeFile(`${out}/browser-hoja-rendida-resultados.json`,JSON.stringify(results,null,2));await browser.close();}
console.log(JSON.stringify(results,null,2));
if(results.consoleErrors.length||results.cases.some(c=>c.passed===false))process.exitCode=1;
