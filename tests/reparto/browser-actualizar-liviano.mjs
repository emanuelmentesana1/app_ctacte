import fs from 'node:fs/promises';
import {browser,results,out,rows,reply,setup,assert,test} from './browser-fixtures.mjs';

/**
 * ⏱️ 06/10/2026 — "Actualizar" liviano en Facturación (puntos 5 y 7, sí de Mati).
 *
 *  · Volver a la pestaña ya NO relee todo contra InfoManager: sólo pregunta si hay presupuestos
 *    nuevos (Supabase) y, si los hay, lo avisa.
 *  · El aviso cuenta sólo lo que la pantalla todavía no tiene, y su botón actualiza.
 */
const LEIDO = '2026-09-11T14:59:00.000Z';

async function abrir(page, novedades) {
  const tablero = [];
  await page.route('**/api/facturacion?**', r => {
    tablero.push(r.request().url());
    return reply(r, { pendientes: rows, facturados: [], leido_at: LEIDO, totales: { pendientes: 2, importe_pendiente: 300000 } });
  });
  const consultas = [];
  await page.route('**/api/facturacion/novedades?**', r => {
    consultas.push(new URL(r.request().url()).searchParams);
    return reply(r, { ok: true, ids: novedades });
  });
  await page.locator('.of-tabs').getByRole('button', { name: 'Facturación', exact: true }).click();
  await page.locator('.fc-root').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.fc-root input[type=checkbox]').length > 1);
  return { tablero, consultas };
}

const volverALaPestaña = page => page.evaluate(() => window.dispatchEvent(new Event('focus')));

try {
  for (const width of [390, 1440]) await test(`Volver a la pestaña no relee: avisa los nuevos y Actualizar los trae (${width})`, async () => {
    const { page, ctx } = await setup(width);
    try {
      // 101 ya está en pantalla: el aviso cuenta sólo el 999.
      const { tablero, consultas } = await abrir(page, ['101', '999']);
      const lecturas = tablero.length;
      // 🪤 Un minuto después: la recarga vieja esperaba 30 s entre una y otra, y con el reloj fijo
      // del harness este test no la habría detectado.
      await page.clock.setFixedTime(new Date('2026-09-11T15:01:00Z'));
      await volverALaPestaña(page);
      const aviso = page.locator('.fc-novedades');
      await aviso.waitFor();
      const texto = await aviso.innerText();
      assert(/Hay\s*1\s*presupuesto nuevo/.test(texto), `El aviso no cuenta bien: "${texto}"`);
      assert(tablero.length === lecturas, 'Volver a la pestaña volvió a leer el tablero contra IM');
      // La consulta lleva el momento de la última lectura que dio el servidor, no la hora de la PC.
      assert(consultas[0]?.get('leido_at') === LEIDO, `leido_at mal: ${consultas[0]?.get('leido_at')}`);

      // Se lee entero en el celular.
      const r = await aviso.boundingBox();
      assert(r && r.x >= -1 && r.x + r.width <= width + 1, `El aviso se sale de la pantalla en ${width}`);

      await aviso.getByRole('button', { name: /Actualizar/ }).click();
      await page.waitForFunction(n => document.querySelectorAll('.fc-novedades').length === 0, null);
      assert(tablero.length === lecturas + 1, 'El botón del aviso no actualizó');
      assert(/refrescar=1/.test(tablero.at(-1)), 'El botón del aviso no pidió una lectura actualizada');
      // 🪤 Y la lista no se vació mientras tanto: siguen las dos filas.
      assert(await page.locator('.fc-root').getByText('CLIENTE ALFA').count() > 0, 'La lista quedó vacía');
      await page.screenshot({ path: `${out}/actualizar-liviano-${width}.png`, fullPage: true });
    } finally { await ctx.close(); }
  });

  await test('Sin presupuestos nuevos no aparece ningún aviso', async () => {
    const { page, ctx } = await setup(1440);
    try {
      const { consultas } = await abrir(page, ['101', '102']);
      await volverALaPestaña(page);
      for (let i = 0; i < 20 && !consultas.length; i++) await page.waitForTimeout(50);
      assert(consultas.length === 1, 'No consultó las novedades al volver');
      await page.waitForTimeout(100);
      assert(await page.locator('.fc-novedades').count() === 0, 'Avisó presupuestos que ya están en pantalla');
    } finally { await ctx.close(); }
  });
} finally {
  await browser.close();
  await fs.writeFile(`${out}/resultados-actualizar-liviano.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}
if (results.cases.some(c => !c.passed) || results.consoleErrors.length) process.exitCode = 1;
