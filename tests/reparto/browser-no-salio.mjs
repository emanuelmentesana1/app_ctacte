import fs from 'node:fs/promises';
import {browser,results,out,rows,reply,setup,assert,test,user} from './browser-fixtures.mjs';

/**
 * «No salió» (Mati, 05/10/2026). LEAL y BUSTOS (hoja 3402) no salieron —sus remitos se anularon— y la
 * liquidación de NIÑO los seguía sumando. Desde la hoja se marca la entrega y deja de contar.
 * Cambia un pago: sólo admin y gerente, con motivo, y también en una hoja CERRADA.
 */
const pedido = (id, nombre, extra = {}) => ({ ...rows[0], im_comprobante_id: id, im_numero: 77000 + Number(id.slice(-2)), cliente_nombre: nombre,
  cod_cliente: Number(id.slice(-3)), total: 382717.69, saldo_anterior: 0, kg: 300, bultos: 10, im_factura_numero: null, im_remito_numero: 77383,
  facturado_at: '2026-09-09', ...extra });
const hoja = pedidos => ({ version: 5, id: 'h1', numero: 3402, nombre: null, fecha: '2026-09-09', turno: null, transporte: null, camion: null,
  camion_id: null, capacidad_kg: null, cod_zona: 9, estado: 'cerrada', facturada: true, chofer: 'NIÑO', chofer_id: 'c1', cerrada_at: '2026-09-10',
  pedidos, totales: { pedidos: pedidos.length, bultos: 20, kg: 600 }, carga: { completa: true, porcentaje: null, excedido: false, sobra_kg: null } });

async function pantalla({ rol = 'admin', capacidad = true, alMarcar } = {}) {
  let marcado = false;
  const r = await setup(1440, {
    url: '/reparto?etapa=hojas&desde=2026-09-09&hasta=2026-09-09&hoja=h1', ready: '.hr-hoja',
    beforeGoto: async p => {
      await p.route('**/api/me', r2 => reply(r2, { ok: true, user: { ...user, rol } }));
      await p.route('**/api/hojas-ruta?**', r2 => reply(r2, { hojas: [hoja([
        pedido('58784016', 'LEAL, Paulina (Este)', marcado ? { estado_entrega: 'no_salio', estado_entrega_motivo: 'remito anulado 29/09, no salió' } : {}),
        pedido('58783742', 'BUSTOS, Sebastián (Este)', { total: 1368965.37 }),
      ])], capacidades: { nombre: true, estado_entrega: capacidad } }));
      await p.route('**/api/hojas-ruta/h1/entregas/*/estado', async r2 => { marcado = true; if (alMarcar) alMarcar(r2.request()); await reply(r2, { ok: true, version: 6, estado: 'no_salio' }); });
    },
  });
  if (await r.page.locator('.hr-hoja.plegada').count()) await r.page.locator('.hr-hoja .hr-plegar').first().click();
  await r.page.locator('.hr-hoja-ped').first().waitFor();
  return r;
}

try {
  await test('🔴 Un admin marca «no salió» en una hoja cerrada: manda el motivo y la versión, y la entrega queda tachada', async () => {
    let enviado = null, url = '';
    const { page, ctx } = await pantalla({ alMarcar: q => { enviado = q.postDataJSON(); url = q.url(); } });
    try {
      page.on('dialog', d => d.accept(d.type() === 'prompt' ? 'remito anulado 29/09, no salió' : undefined));
      const fila = page.locator('.hr-hoja-ped', { hasText: 'LEAL' });
      await fila.getByRole('button', { name: 'No salió' }).click();
      await page.locator('.hr-hoja-ped.no-salio', { hasText: 'LEAL' }).waitFor();
      assert(/\/api\/hojas-ruta\/h1\/entregas\/58784016\/estado$/.test(url), `Fue a otra ruta: ${url}`);
      assert(enviado?.estado === 'no_salio' && enviado?.motivo === 'remito anulado 29/09, no salió' && enviado?.version_esperada === 5,
        `No mandó lo que correspondía: ${JSON.stringify(enviado)}`);
      assert(/no salió/.test(await page.locator('.hr-hoja-ped.no-salio').innerText()), 'La fila no dice que no salió');
      assert(await page.locator('.hr-hoja-ped.no-salio').getByRole('button', { name: 'Salió' }).count() === 1, 'No se puede deshacer');
      assert(await page.locator('.hr-hoja-ped.no-salio', { hasText: 'BUSTOS' }).count() === 0, 'Tachó otra entrega');
    } finally { await ctx.close(); }
  });

  await test('🔴 Un administrativo no ve el botón: cambia un pago', async () => {
    const { page, ctx } = await pantalla({ rol: 'administrativo' });
    try { assert(await page.getByRole('button', { name: 'No salió' }).count() === 0, 'Un administrativo puede marcar «no salió»'); }
    finally { await ctx.close(); }
  });

  await test('Sin la migración 057 el botón no aparece', async () => {
    const { page, ctx } = await pantalla({ capacidad: false });
    try { assert(await page.getByRole('button', { name: 'No salió' }).count() === 0, 'Ofrece marcar sin la migración'); }
    finally { await ctx.close(); }
  });

  await test('🔴 La Liquidación muestra lo que no salió y el total con centavos', async () => {
    const liq = { ok: true, mes: '2026-09', desde: '2026-09-01', hasta: '2026-09-30',
      choferes: [{ chofer_id: 'c1', chofer: 'NIÑO', hojas: 24, pedidos: 312, clientes: 168, bultos: 1, kg: 1, despachado: 1, notas_credito: 0, notas_debito: 0,
        importe: 187828401.89, no_salieron: { entregas: 2, importe: 660059.55 }, numeros: [3402] }],
      totales: { hojas: 24, pedidos: 312, kg: 1, importe: 187828401.89, no_salieron: { entregas: 2, importe: 660059.55 } }, sin_cerrar: { hojas: 0, importe: 0 } };
    const { page, ctx } = await setup(1440, { url: '/reparto?etapa=hojas&desde=2026-09-01&hasta=2026-09-30', ready: '.hr-root',
      beforeGoto: p => p.route('**/api/liquidacion**', r2 => reply(r2, liq)) });
    try {
      await page.getByRole('button', { name: /Liquidación/ }).first().click();
      const card = page.locator('.lq-chofer', { hasText: 'NIÑO' });
      await card.waitFor();
      const texto = await card.innerText();
      assert(/\$187\.828\.401,89/.test(texto), `El total no va con centavos: "${texto}"`);
      assert(/no salieron 2 entregas por \$660\.059,55/.test(texto), `No muestra lo que no salió: "${texto}"`);
    } finally { await ctx.close(); }
  });
} finally {
  await browser.close();
  await fs.writeFile(out + '/browser-no-salio.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (results.cases.some(c => !c.passed) || results.consoleErrors.length) process.exit(1);
}
