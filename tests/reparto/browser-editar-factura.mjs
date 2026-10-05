import fs from 'node:fs/promises';
import {browser,results,out,rows,reply,setup,assert,test} from './browser-fixtures.mjs';

/**
 * EDITAR UNA FACTURA (30/09/2026). Mati, por Jorgelina: "InfoManager es más fácil ya que sólo edita
 * la factura y listo, y en la app tiene que ponerse a emitir NC y ND". El modal abre en "Editar
 * factura": al guardar, la app rehace factura y remito (editarFactura.ts) en vez de emitir notas.
 */
const FILA = (extra = {}) => ({ ...rows[0], im_factura_id: '501', im_factura_numero: 51031, im_factura_tipo: 'FA B',
  im_remito_id: '601', im_remito_numero: 78304, facturado_at: '2026-09-29', notas: [], ...extra });
const FACTURA = { factura: { id: '501', numero: 51031, letra: 'B', cliente_nombre: 'CLIENTE ALFA', fecha: '2026-09-29' },
  version: 0, operacion: null, bloqueo_productos: null,
  renglones: [
    { cod_articulo: 650, descripcion: 'MANI C/ CHOCOLATE', cantidad: 12, precio: 9936, descuento_porc: 0, cod_lista_precios: 12 },
    { cod_articulo: 685, descripcion: 'PASTA DE MANI NATURAL 4KG x 2u', cantidad: 2, precio: 34945.592, descuento_porc: 0, cod_lista_precios: 12 },
  ] };
const SOLO_REMITO = { rehace_factura: false,
  factura: { numero: 51031, tipo: 'FA B', total_actual: 189123.18, total_nuevo: 189123.18 },
  remito: { numero: 78304, total_actual: 145809.34, total_nuevo: 189123.18 },
  vuelve: [{ cod_articulo: 663, cantidad: 2, descripcion: 'PASTA DE MANI NATURAL X 3K' }],
  sale: [{ cod_articulo: 685, cantidad: 2, descripcion: 'PASTA DE MANI NATURAL 4KG x 2u' }], hoja: 3440 };

async function abrir(page, { editar, fila } = {}) {
  await page.route('**/api/facturacion?**', r => reply(r, { pendientes: [], facturados: [FILA(fila)], totales: { pendientes: 0, facturados: 1 } }));
  await page.route('**/api/facturacion/corregir/501', r => reply(r, FACTURA));
  if (editar) await page.route('**/api/facturacion/editar', editar);
  await page.locator('.of-tabs').getByRole('button', { name: 'Facturación', exact: true }).click();
  await page.locator('.fc-facturados summary').click();
}

try {
  for (const width of [390, 1440]) await test(`FA ≠ RE sin tocar la factura: ofrece rehacer SÓLO el remito (${width} px)`, async () => {
    const { page, ctx } = await setup(width);
    try {
      const pedidos = [];
      await abrir(page, { editar: r => {
        const b = r.request().postDataJSON(); pedidos.push(b);
        return b.confirmar
          ? reply(r, { ok: true, estado: 'completo', paso: 'listo', error: null, factura_nueva: null, remito_nuevo: { id: '9', numero: 78500 }, hoja: 3440, factura_vieja: { numero: 51031, tipo: 'FA B' }, remito_viejo: { numero: 78304 } })
          : reply(r, { previsualizacion: SOLO_REMITO });
      } });
      await page.getByRole('button', { name: 'Editar', exact: true }).click();
      await page.locator('.cf-tabla').waitFor();
      assert(await page.locator('.cf-solapas .activa').innerText() === 'Editar factura', 'No abre en la solapa de editar');
      const resumen = page.locator('.cf-resumen');
      await resumen.waitFor();
      const texto = await resumen.innerText();
      assert(/no coincide/.test(texto) && /78304/.test(texto), `No explica que el remito no coincide: ${texto}`);
      assert(/Vuelve al stock/.test(texto) && /PASTA DE MANI NATURAL X 3K/.test(texto), 'No dice qué vuelve al stock');
      assert(/Sale del stock/.test(texto) && /4KG/.test(texto), 'No dice qué sale del stock');
      assert(/hoja 3440/.test(texto), 'No dice que se cambia en la hoja');
      assert(pedidos.every(p => p.renglones === undefined), 'Sin cambios igual mandó renglones: rehacería la factura');

      // Entra en la pantalla: nada cortado a los costados.
      const caja = await page.locator('.cf-modal').boundingBox();
      assert(caja && caja.x >= -1 && caja.x + caja.width <= width + 1, `El modal se sale de la pantalla en ${width}: ${JSON.stringify(caja)}`);
      await page.screenshot({ path: `${out}/editar-factura-solo-remito-${width}.png`, fullPage: true });

      const boton = page.locator('.cf-pie .primario');
      assert((await boton.innerText()).includes('Rehacer el remito'), `El botón no dice qué hace: ${await boton.innerText()}`);
      let aviso = '';
      page.once('dialog', async d => { aviso = d.message(); await d.accept(); });
      await boton.click();
      await page.locator('.cf-listo').waitFor();
      assert(/factura no se toca/i.test(aviso), `La confirmación no dice que la factura no se toca: ${aviso}`);
      const envio = pedidos.find(p => p.confirmar);
      assert(envio && envio.renglones === undefined && envio.im_factura_id === '501', `Envío incorrecto: ${JSON.stringify(envio)}`);
      const listo = await page.locator('.cf-listo').innerText();
      assert(/remito 78500/.test(listo) && /78304 quedó anulado/.test(listo) && /hoja de ruta 3440/.test(listo), `El resultado no se lee: ${listo}`);
      await page.screenshot({ path: `${out}/editar-factura-listo-${width}.png`, fullPage: true });
    } finally { await ctx.close(); }
  });

  await test('Cambiar la factura: dice que se reemplaza y manda los renglones nuevos', async () => {
    const { page, ctx } = await setup(1440);
    try {
      const pedidos = [];
      await abrir(page, { editar: r => {
        const b = r.request().postDataJSON(); pedidos.push(b);
        if (b.confirmar) return reply(r, { ok: true, estado: 'completo', factura_nueva: { id: '8', numero: 51100, tipo: 'FA B' }, remito_nuevo: { numero: 78500 }, hoja: null, factura_vieja: { numero: 51031, tipo: 'FA B' }, remito_viejo: { numero: 78304 } });
        return b.renglones
          ? reply(r, { previsualizacion: { ...SOLO_REMITO, rehace_factura: true, factura: { numero: 51031, tipo: 'FA B', total_actual: 189123.18, total_nuevo: 169251.18 }, hoja: null } })
          : reply(r, { error: 'No hay nada que cambiar: la factura queda igual y el remito ya coincide con ella.' }, 400);
      } });
      await page.getByRole('button', { name: 'Editar', exact: true }).click();
      await page.locator('.cf-tabla').waitFor();
      // Sin cambios y con el remito igual: se dice, sin alarma, y no se puede guardar.
      await page.locator('.cf-nota').filter({ hasText: 'No hay nada que cambiar' }).waitFor();
      assert(await page.locator('.cf-pie .primario').isDisabled(), 'Deja guardar sin nada que cambiar');

      await page.getByLabel('Cantidad de MANI C/ CHOCOLATE', { exact: true }).fill('10');
      await page.locator('.cf-resumen').filter({ hasText: 'se anula y sale una nueva' }).waitFor();
      assert(/\$\s?169\.251,18/.test(await page.locator('.cf-resumen').innerText()), 'No muestra el total nuevo');
      const boton = page.locator('.cf-pie .primario');
      assert((await boton.innerText()).includes('Guardar cambios'), 'El botón no es Guardar cambios');
      await page.getByLabel('Motivo de la corrección').fill('bajan 2 maní');
      page.once('dialog', d => d.accept());
      await boton.click();
      await page.locator('.cf-listo').waitFor();
      const envio = pedidos.find(p => p.confirmar);
      assert(envio?.renglones?.find(x => x.cod_articulo === 650)?.cantidad === 10, `No mandó la cantidad nueva: ${JSON.stringify(envio)}`);
      assert(envio.motivo === 'bajan 2 maní', 'No mandó el motivo');
      assert(/FA B 51100/.test(await page.locator('.cf-listo').innerText()), 'No dice qué factura salió');
    } finally { await ctx.close(); }
  });

  await test('Lo que el servidor no deja hacer se lee y no se puede guardar', async () => {
    const { page, ctx } = await setup(390);
    try {
      await abrir(page, { editar: r => reply(r, { error: 'La factura 51031 tiene $50.000 cobrados. Desimputá el recibo en InfoManager antes de editarla, o corregila con notas.' }, 409) });
      await page.getByRole('button', { name: 'Editar', exact: true }).click();
      await page.getByLabel('Cantidad de MANI C/ CHOCOLATE', { exact: true }).fill('10');
      await page.locator('.cf-error').filter({ hasText: 'cobrados' }).waitFor();
      assert(await page.locator('.cf-pie .primario').isDisabled(), 'Deja guardar algo que el servidor rechaza');
    } finally { await ctx.close(); }
  });

  await test('Una edición a mitad de camino se retoma desde el modal, sin volver a mandar renglones', async () => {
    const { page, ctx } = await setup(1440);
    try {
      const pedidos = [];
      await abrir(page, { editar: r => {
        const b = r.request().postDataJSON(); pedidos.push(b);
        if (!b.confirmar) return reply(r, { abierta: { ok: false, estado: 'fallo', paso: 'emitir_re', error: 'InfoManager rechazó el remito nuevo: sin conexión', factura_nueva: { id: '8', numero: 51100, tipo: 'FA B' }, remito_nuevo: null, factura_vieja: { numero: 51031 }, remito_viejo: { numero: 78304 } } });
        return reply(r, { ok: true, estado: 'completo', factura_nueva: { id: '8', numero: 51100, tipo: 'FA B' }, remito_nuevo: { numero: 78500 }, hoja: null, factura_vieja: { numero: 51031, tipo: 'FA B' }, remito_viejo: { numero: 78304 } });
      } });
      await page.getByRole('button', { name: 'Editar', exact: true }).click();
      await page.locator('.cf-mal').filter({ hasText: 'sin conexión' }).waitFor();
      assert(/51100\) ya salió/.test(await page.locator('.cf-listo').innerText()), 'No avisa que la factura nueva ya salió');
      await page.getByRole('button', { name: 'Retomar donde quedó' }).click();
      await page.locator('.cf-ok').filter({ hasText: '78500' }).waitFor();
      const envio = pedidos.find(p => p.confirmar);
      assert(envio && envio.renglones === undefined, 'Al retomar mandó renglones');
    } finally { await ctx.close(); }
  });

  await test('Si el primer paso falla sin cambiar nada, se vuelve a la grilla (no se ofrece retomar)', async () => {
    const { page, ctx } = await setup(1440);
    try {
      await abrir(page, { editar: r => r.request().postDataJSON().confirmar
        ? reply(r, { ok: false, estado: 'cancelada', paso: 'emitir_re', error: 'InfoManager rechazó el remito nuevo: sin stock. No se cambió nada: la factura y el remito siguen como estaban.', factura_nueva: null, remito_nuevo: null, factura_vieja: { numero: 51031 }, remito_viejo: { numero: 78304 } }, 409)
        : reply(r, { previsualizacion: SOLO_REMITO }) });
      await page.getByRole('button', { name: 'Editar', exact: true }).click();
      await page.locator('.cf-resumen').waitFor();
      page.once('dialog', d => d.accept());
      await page.locator('.cf-pie .primario').click();
      await page.locator('.cf-mal').filter({ hasText: 'No se cambió nada' }).waitFor();
      assert(await page.getByRole('button', { name: 'Retomar donde quedó' }).count() === 0, 'Ofrece retomar algo que se canceló');
      await page.getByRole('button', { name: 'Volver a la factura' }).click();
      await page.locator('.cf-tabla').waitFor();
      await page.locator('.cf-resumen').waitFor();
    } finally { await ctx.close(); }
  });

  /** 🔴 05/10/2026: una factura que no se puede verificar se marca en su fila; antes tumbaba el tablero. */
  await test('Una factura sin verificar se marca en su fila y no muestra un importe inventado', async () => {
    const { page, ctx } = await setup(390);
    try {
      await abrir(page, { fila: { total: null, importe_error: 'La factura 59042340 está ANULADA en InfoManager.' } });
      const fila = page.locator('.fc-facturados tbody tr').first();
      await fila.getByText(/sin verificar/).waitFor();
      assert(!/NaN/.test(await fila.innerText()), 'Muestra $NaN');
    } finally { await ctx.close(); }
  });

  await test('La fila de una edición sin terminar lo dice y ofrece retomarla', async () => {
    const { page, ctx } = await setup(1440);
    try {
      let enviado = null;
      await abrir(page, { fila: { estado_emision: 'editando' }, editar: r => { enviado = r.request().postDataJSON(); return reply(r, { ok: true, estado: 'completo' }); } });
      const fila = page.locator('.fc-facturados tbody tr').first();
      await fila.getByText('Edición sin terminar').waitFor();
      assert(await fila.getByRole('button', { name: 'Editar', exact: true }).count() === 0, 'Ofrece empezar otra edición encima');
      await fila.getByRole('button', { name: /Retomar edición/ }).click();
      for (let i = 0; i < 40 && !enviado; i++) await new Promise(r => setTimeout(r, 50));
      assert(enviado?.confirmar === true && enviado?.im_factura_id === '501', `Retomar mandó otra cosa: ${JSON.stringify(enviado)}`);
    } finally { await ctx.close(); }
  });
} finally {
  await browser.close();
  await fs.writeFile(`${out}/resultados-editar-factura.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}
if (results.cases.some(c => !c.passed) || results.consoleErrors.length) process.exitCode = 1;
