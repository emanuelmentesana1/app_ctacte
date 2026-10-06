import fs from 'node:fs/promises';
import {browser,results,out,rows,reply,setup,assert,test,user} from './browser-fixtures.mjs';

/**
 * Corregir el remito (Mati, 06/10/2026, opción 2 para DIAZ en la hoja 3402): el RE 77382 se borró en IM y
 * la mercadería salió con el RE 77399. Desde la hoja, admin o gerente, con motivo. El botón aparece sólo
 * donde hace falta: en la entrega con el remito anulado o borrado en IM.
 */
const pedido = (id, nombre, extra = {}) => ({ ...rows[0], im_comprobante_id: id, im_numero: 77382, cliente_nombre: nombre,
  cod_cliente: 812, total: 2682199.99, saldo_anterior: 0, kg: 1775.82, bultos: 642, im_factura_numero: null, im_remito_numero: 77382,
  facturado_at: '2026-09-09', tipo_comprobante: 'RE', ...extra });
const hoja = pedidos => ({ version: 6, id: 'h1', numero: 3402, nombre: null, fecha: '2026-09-09', turno: null, transporte: null, camion: null,
  camion_id: null, capacidad_kg: null, cod_zona: 9, estado: 'cerrada', facturada: true, chofer: 'NIÑO', chofer_id: 'c1', cerrada_at: '2026-09-10',
  pedidos, totales: { pedidos: pedidos.length, bultos: 20, kg: 600 }, carga: { completa: true, porcentaje: null, excedido: false, sobra_kg: null } });
const avisoDiaz = { hoja_id: 'h1', hoja: 3402, im_comprobante_id: '58783918', cliente_nombre: 'DIAZ, Alfredo (Este)', total: 2682199.99, remito: 77382 };

async function pantalla({ rol = 'admin', capacidad = true, alCorregir, respuesta } = {}) {
  let corregido = false;
  const r = await setup(1440, {
    url: '/reparto?etapa=hojas&desde=2026-09-09&hasta=2026-09-09&hoja=h1', ready: '.hr-hoja',
    beforeGoto: async p => {
      await p.route('**/api/me', r2 => reply(r2, { ok: true, user: { ...user, rol } }));
      await p.route('**/api/hojas-ruta?**', r2 => reply(r2, { hojas: [hoja([
        corregido
          ? pedido('58785809', 'DIAZ, Alfredo (Este)', { im_numero: 77399, im_remito_numero: 77399, im_factura_numero: 50406,
              remito_historial: [{ numero_anterior: 77382, remito_numero: 77399, motivo: 'el RE 77382 se borró en IM; salió con el RE 77399' }] })
          : pedido('58783918', 'DIAZ, Alfredo (Este)'),
        pedido('58786004', 'MARTIN, Marcelo (Y. B)', { im_numero: 77405, im_remito_numero: 77405, cod_cliente: 474, total: 1000 }),
      ])], capacidades: { nombre: true, estado_entrega: true, corregir_remito: capacidad } }));
      await p.route('**/api/hojas-ruta/remitos-anulados**', r2 => reply(r2, { ok: true, entregas: corregido ? [] : [avisoDiaz] }));
      await p.route('**/api/hojas-ruta/h1/entregas/*/remito', async r2 => {
        if (alCorregir) alCorregir(r2.request());
        if (respuesta) return reply(r2, respuesta.body, respuesta.status);
        corregido = true;
        await reply(r2, { ok: true, version: 7, im_comprobante_id: '58785809', remito_numero: 77399 });
      });
    },
  });
  if (await r.page.locator('.hr-hoja.plegada').count()) await r.page.locator('.hr-hoja .hr-plegar').first().click();
  await r.page.locator('.hr-hoja-ped').first().waitFor();
  return r;
}

try {
  await test('🔴 Un admin corrige el remito de DIAZ en una hoja cerrada: manda número, motivo y versión, y la fila pasa a ser el RE 77399', async () => {
    let enviado = null, url = '';
    const { page, ctx } = await pantalla({ alCorregir: q => { enviado = q.postDataJSON(); url = q.url(); } });
    try {
      // Primero el número; el motivo se acepta como lo propone la pantalla.
      page.on('dialog', d => d.accept(d.message().startsWith('¿Con qué remito') ? '77399' : d.defaultValue()));
      const diaz = page.locator('.hr-hoja-ped', { hasText: 'DIAZ' });
      await diaz.locator('.hr-badge', { hasText: 'remito anulado en IM' }).waitFor();
      await diaz.getByRole('button', { name: 'Corregir remito' }).click();
      await page.locator('.hr-hoja-ped', { hasText: 'DIAZ' }).locator('.hr-badge', { hasText: 'remito corregido' }).waitFor();
      assert(/\/api\/hojas-ruta\/h1\/entregas\/58783918\/remito$/.test(url), `Fue a otra ruta: ${url}`);
      assert(enviado?.remito_numero === '77399' && enviado?.motivo === 'el RE 77382 se borró en IM; salió con el RE 77399' && enviado?.version_esperada === 6,
        `No mandó lo que correspondía: ${JSON.stringify(enviado)}`);
      const fila = page.locator('.hr-hoja-ped', { hasText: 'DIAZ' });
      const texto = await fila.innerText();
      assert(/RE 77399/.test(texto) && !/77382/.test(texto), `La fila no muestra el remito nuevo: "${texto}"`);
      assert(await fila.locator('.hr-badge', { hasText: 'remito anulado en IM' }).count() === 0, 'Sigue el aviso de remito anulado');
      assert(/77382/.test(await fila.locator('.hr-badge', { hasText: 'remito corregido' }).getAttribute('title')), 'El registro no dice cuál era el remito anterior');
      assert(await fila.getByRole('button', { name: 'Corregir remito' }).count() === 0, 'Sigue ofreciendo corregir');
    } finally { await ctx.close(); }
  });

  await test('🔴 El botón sólo está en la entrega con el remito anulado en IM', async () => {
    const { page, ctx } = await pantalla();
    try {
      await page.locator('.hr-hoja-ped', { hasText: 'DIAZ' }).locator('.hr-badge', { hasText: 'remito anulado en IM' }).waitFor();
      assert(await page.locator('.hr-hoja-ped', { hasText: 'MARTIN' }).getByRole('button', { name: 'Corregir remito' }).count() === 0, 'Ofrece corregir un remito vigente');
      assert(await page.getByRole('button', { name: 'Corregir remito' }).count() === 1, 'No ofrece corregir el de DIAZ');
    } finally { await ctx.close(); }
  });

  await test('🔴 Un administrativo no lo ve, y sin la migración 058 tampoco aparece', async () => {
    for (const opciones of [{ rol: 'administrativo' }, { capacidad: false }]) {
      const { page, ctx } = await pantalla(opciones);
      try {
        await page.locator('.hr-hoja-ped', { hasText: 'DIAZ' }).locator('.hr-badge', { hasText: 'remito anulado en IM' }).waitFor();
        assert(await page.getByRole('button', { name: 'Corregir remito' }).count() === 0, `Ofrece corregir con ${JSON.stringify(opciones)}`);
      } finally { await ctx.close(); }
    }
  });

  await test('Si el servidor frena (otro cliente, otro importe), se ve el motivo y la fila no cambia', async () => {
    const { page, ctx } = await pantalla({ respuesta: { status: 409, body: { error: 'El RE 77399 es del cliente 125, no de DIAZ, Alfredo (Este) (812).' } } });
    try {
      page.on('dialog', d => d.accept(d.message().startsWith('¿Con qué remito') ? '77399' : d.defaultValue()));
      await page.locator('.hr-hoja-ped', { hasText: 'DIAZ' }).getByRole('button', { name: 'Corregir remito' }).click();
      await page.getByText('es del cliente 125').first().waitFor();
      assert(await page.locator('.hr-badge', { hasText: 'remito corregido' }).count() === 0, 'Muestra como corregido algo que el servidor rechazó');
    } finally { await ctx.close(); }
  });

  await test('🔴 La Liquidación habla en singular cuando es una sola entrega', async () => {
    const liq = { ok: true, mes: '2026-09', desde: '2026-09-01', hasta: '2026-09-30',
      choferes: [{ chofer_id: 'c2', chofer: 'VICTOR', hojas: 20, pedidos: 200, clientes: 100, bultos: 1, kg: 1, despachado: 1, notas_credito: 0, notas_debito: 0,
        importe: 122854004.88, no_salieron: { entregas: 1, importe: 277341.86 }, numeros: [3410] }],
      totales: { hojas: 20, pedidos: 200, kg: 1, importe: 122854004.88, no_salieron: { entregas: 1, importe: 277341.86 } }, sin_cerrar: { hojas: 0, importe: 0 } };
    const { page, ctx } = await setup(1440, { url: '/reparto?etapa=hojas&desde=2026-09-01&hasta=2026-09-30', ready: '.hr-root',
      beforeGoto: async p => {
        await p.route('**/api/liquidacion**', r2 => reply(r2, liq));
        await p.route('**/api/hojas-ruta/remitos-anulados**', r2 => reply(r2, { ok: true, entregas: [avisoDiaz] }));
      } });
    try {
      await page.getByRole('button', { name: /Liquidación/ }).first().click();
      const card = page.locator('.lq-chofer', { hasText: 'VICTOR' });
      await card.waitFor();
      const linea = await card.innerText();
      assert(/no salió 1 entrega por \$277\.341,86: no se paga \(marcada en la hoja\)/.test(linea), `La línea no va en singular: "${linea}"`);
      const aviso = page.locator('.lq-aviso', { hasText: 'anulado o borrado' });
      await aviso.waitFor();
      const texto = await aviso.innerText();
      assert(/Si no salió, marcala «No salió»/.test(texto) && !/salieron|marcalas/.test(texto), `El aviso no va en singular: "${texto}"`);
      assert(/usá «Corregir remito» en la hoja/.test(texto), `El aviso no dice cómo corregir el remito: "${texto}"`);
    } finally { await ctx.close(); }
  });
} finally {
  await browser.close();
  await fs.writeFile(out + '/browser-corregir-remito.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (results.cases.some(c => !c.passed) || results.consoleErrors.length) process.exit(1);
}
