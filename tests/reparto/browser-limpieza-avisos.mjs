import fs from 'node:fs/promises';
import {browser,results,out,row,reply,presupuestos,setup,assert,test} from './browser-fixtures.mjs';

/**
 * LA LIMPIEZA DE AVISOS (04/10/2026). Mati: *"siento que todavía hay demasiados carteles, avisos y
 * mensajes en la app de facturación y hojas de ruta; debe estar mareando a Jo con tanta info"*.
 *
 * Regla: un aviso visible por pantalla, primero lo que frena. Lo informativo va a un ⓘ, el "listo"
 * de una acción se va solo a los 5 s, y lo que tiene que arreglar otra persona va a un informe.
 */
const bajoLista = { ...row('101', 'CLIENTE ALFA'), gravedad: { pierde_margen: 12000, cobra_de_mas: 0 },
  avisos: ['ALPISTE: lista 13 en vez de 12'], revision: { estado: 'aprobado', observacion: null, revisado_at: '2026-09-10T12:00:00Z' },
  hoja_id: 'h1', renglones_sin_peso: 3 };
const conFaltante = { ...row('102', 'CLIENTE BETA'), faltantes: [{ cod_articulo: 5, descripcion: 'SORGO', pedido: 10, disponible: 2 }] };
const facturadoPorElPanel = { ...row('103', 'CLIENTE GAMA'), factura: { im_factura_id: '9', numero: 51071, tipo: 'FA B', fecha: null, origen: 'nuestra' } };
const deducido = { ...row('104', 'CLIENTE DELTA'), factura: { im_factura_id: '8', numero: 51072, tipo: 'FA B', fecha: '2026-09-10', origen: 'deducida' } };
const conContadores = rs => ({ ...presupuestos(rs), pierde_margen: 6, con_cantidad_rara: 1, ya_facturados: 43, sin_stock: 23 });
const conPresupuestos = rs => p => {
  p.route('**/api/presupuestos?**', r => reply(r, conContadores(rs)));
  p.route('**/api/presupuestos', r => reply(r, conContadores(rs)));
};

try {
  await test('🔴 Presupuestos: arriba no quedan chips; lo del rango está en Informes', async () => {
    const { page, ctx } = await setup(1440, { beforeGoto: conPresupuestos([bajoLista, conFaltante]) });
    try {
      // El 02/10 decían "6 por debajo de lista · 1 con cantidad rara · 43 ya facturados · 23 sin stock"
      // con 2 presupuestos para facturar.
      assert(await page.locator('.pr-chip').count() === 0, 'Siguen los chips del resumen');
      for (const viejo of ['por debajo de lista', 'ya facturados', 'con cantidad rara']) {
        assert(!(await page.locator('.pr-resumen').innerText()).includes(viejo), `El resumen todavía dice "${viejo}"`);
      }
      await page.getByRole('button', { name: /Informes/ }).click();
      const dialogo = page.getByRole('dialog', { name: 'Informes del rango' });
      await dialogo.waitFor();
      const lista = await dialogo.innerText();
      assert(/CLIENTE ALFA/.test(lista) && /ALPISTE/.test(lista) && /12\.000/.test(lista), `El informe de precios no trae el caso: "${lista}"`);
      assert(/No se manda a nadie/.test(lista), 'No aclara que el informe no se manda');
      await dialogo.getByRole('button', { name: /Sin stock/ }).click();
      const stock = await dialogo.innerText();
      assert(/SORGO/.test(stock) && /\b8\b/.test(stock), `El informe del depósito no dice cuánto falta: "${stock}"`);
      await page.keyboard.press('Escape');
      await dialogo.waitFor({ state: 'detached' });
    } finally { await ctx.close(); }
  });

  await test('Presupuestos: la fila ya no dice "aprobado", "en una hoja", "sin peso" ni la FA del panel', async () => {
    const { page, ctx } = await setup(1440, { beforeGoto: conPresupuestos([bajoLista, facturadoPorElPanel, deducido]) });
    try {
      await page.getByRole('button', { name: /^Todos/ }).click();
      await page.locator('.pr-fila', { hasText: 'CLIENTE GAMA' }).waitFor();
      const texto = await page.locator('.pr-root').innerText();
      for (const viejo of ['aprobado', 'en una hoja', 'sin peso']) assert(!texto.includes(viejo), `La lista todavía dice "${viejo}"`);
      assert(!(await page.locator('.pr-fila', { hasText: 'CLIENTE GAMA' }).locator('.pr-badge').count()), 'La factura del panel sigue con badge');
      // La deducida sí: puede ser una factura de otro pedido, y facturar de nuevo la duplica.
      const deducida = await page.locator('.pr-fila', { hasText: 'CLIENTE DELTA' }).locator('.pr-badge').innerText();
      assert(/51072 \?/.test(deducida), `Se perdió el aviso de la factura deducida: "${deducida}"`);
      // Y el problema de la fila se sigue viendo.
      assert(await page.locator('.pr-fila', { hasText: 'CLIENTE ALFA' }).locator('.pr-badge.grave').count() === 1, 'Se perdió el badge de problemas');
    } finally { await ctx.close(); }
  });

  await test('🔴 El "listo" de una acción se va solo; un error se queda', async () => {
    let falla = false;
    const { page, ctx } = await setup(1440, { beforeGoto: async p => {
      conPresupuestos([conFaltante])(p);
      await p.route('**/api/presupuestos/*/anular', r => falla
        ? reply(r, { error: 'InfoManager no contestó' }, 502)
        : reply(r, { ok: true, numero: 102 }));
    } });
    try {
      page.on('dialog', d => d.accept('cargado dos veces'));
      await page.locator('.pr-anular').first().click();
      const listo = page.locator('.aviso-temporal');
      await listo.waitFor();
      assert(/Pedido 102 anulado/.test(await listo.innerText()), 'No avisa que se anuló');
      await listo.waitFor({ state: 'detached', timeout: 8000 });
      falla = true;
      await page.locator('.pr-anular').first().click();
      const error = page.locator('.pr-aviso', { hasText: 'InfoManager no contestó' });
      await error.waitFor();
      await page.waitForTimeout(6000);
      assert(await error.isVisible(), 'El error se fue solo: nadie lo llegó a leer');
    } finally { await ctx.close(); }
  });

  await test('Por artículo: sin chip rojo; el número queda en el filtro y las ayudas a un toque', async () => {
    const consolidado = {
      ok: true,
      articulos: [{ cod_articulo: 5, descripcion: 'SORGO', pedidos: 2, pedido: 30, facturado: 0, disponible: 10, falta: 20,
        quienes: [
          { im_comprobante_id: '101', im_numero: 101, cliente_nombre: 'CLIENTE ALFA', cantidad: 20, sugerido: 7, revision_estado: null },
          { im_comprobante_id: '102', im_numero: 102, cliente_nombre: 'CLIENTE BETA', cantidad: 10, sugerido: 3, revision_estado: 'observado' },
        ], quienes_facturados: [] }],
      totales: { articulos: 1, faltantes: 1, sin_renglones: 0 },
    };
    const { page, ctx } = await setup(1440, { beforeGoto: async p => {
      conPresupuestos([conFaltante])(p);
      await p.route('**/api/presupuestos/consolidado**', r => reply(r, consolidado));
    } });
    try {
      await page.getByRole('button', { name: /Por artículo/ }).click();
      await page.getByText('SORGO').first().waitFor();
      assert(await page.locator('.co-chip').count() === 0, 'Sigue el chip "sin stock suficiente"');
      assert(/Sólo lo que no alcanza \(1\)/.test(await page.locator('.co-check').innerText()), 'El filtro no muestra cuántos faltan');
      await page.getByText('SORGO').first().click();
      await page.locator('.co-quienes').waitFor();
      const quienes = await page.locator('.co-quienes').innerText();
      assert(!/sin revisar/.test(quienes), 'Sigue el tag "sin revisar"');
      assert(/observado/.test(quienes), 'Se perdió el tag "observado"');
      assert(!/No alcanza para todos/.test(quienes), 'La ayuda sigue fija en la pantalla');
      assert(/proporción/.test(await page.locator('th', { hasText: 'Sugerido' }).getAttribute('title') ?? ''), 'La ayuda de "sugerido" no está en el ⓘ');
    } finally { await ctx.close(); }
  });
} finally {
  await browser.close();
  await fs.writeFile(out + '/browser-limpieza-avisos.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (results.cases.some(c => !c.passed) || results.consoleErrors.length) process.exit(1);
}
