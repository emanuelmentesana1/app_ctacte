import fs from 'node:fs/promises';
import { browser, results, out, reply, setup, assert, test } from './browser-fixtures.mjs';

/**
 * Rendiciones, etapa 1 (sólo lectura), aprobada por Mati el 04/10/2026. Muestra por hoja y por
 * cliente lo cobrado contra lo entregado, y si la caja del día cuadra con el asiento de IM.
 */

const fila = (cod, nombre, p = {}) => ({
  cod_cliente: cod, cliente: nombre, llevo: 400_000, nc: 0, nd: 0, entregado: 400_000, saldo_anterior: 120_000,
  efectivo: 400_000, recibos_efectivo: [{ id_recibo: '1', numero: '0000-30155001', fecha: '2026-09-21', importe: 400_000 }],
  transferencias: [], cobrado: 400_000, queda: 0, estado: 'pago', compartido: false, ...p,
});
const hoja = (numero, chofer, filas, p = {}) => ({
  id: `h${numero}`, numero, fecha: '2026-09-21', estado: 'cerrada', chofer, nombre: null,
  fecha_efectiva: '2026-09-21', fecha_corrida: false, filas, gastos: [],
  totales: {
    clientes: filas.length, llevo: filas.reduce((s, f) => s + f.llevo, 0), nc: 0, entregado: filas.reduce((s, f) => s + f.entregado, 0),
    efectivo: filas.reduce((s, f) => s + f.efectivo, 0), transferencias: 0, cobrado: filas.reduce((s, f) => s + f.cobrado, 0),
    gastos: 0, debe_entregar: filas.reduce((s, f) => s + f.efectivo, 0),
    sin_cobro: filas.filter(f => f.estado === 'sin_cobro').length, parcial: 0, de_mas: 0,
  },
  asiento_id: '12', ...p,
});
const asiento = (p = {}) => ({
  id: '12', fecha: '2026-09-22', descripcion: '3423,3424-AS', hojas: [3423, 3424], hojas_fuera: [],
  entregado: 800_000, cobrado_efectivo: 800_000, cobrado_fuera_de_hoja: 0, gastos: 0, otros_pagos: [],
  diferencia_calculada: 0, diferencia_registrada: null, cuadra: true, ...p,
});
const respuesta = (p = {}) => ({
  ok: true, desde: '2026-09-21', hasta: '2026-09-21', consultado: { im_recibos: true, im_mayor: true },
  hojas: [
    hoja(3423, 'VICTOR', [fila(101, 'CLIENTE ALFA'), fila(102, 'CLIENTE BETA', { efectivo: 0, recibos_efectivo: [], cobrado: 0, queda: 400_000, estado: 'sin_cobro' })]),
    hoja(3424, 'NIÑO', [fila(103, 'CLIENTE GAMMA')]),
  ],
  asientos: [asiento()], fuera_de_hoja: [], ...p,
});

async function abrir(width, datos) {
  const seen = [];
  const { page, ctx } = await setup(width, {
    beforeGoto: async (_page, c) => {
      await c.route('**/api/rendiciones*', route => {
        const u = new URL(route.request().url());
        seen.push(u.pathname + u.search);
        // La pantalla descarta una respuesta de otro rango: se contesta con el rango pedido.
        return reply(route, { ...datos, desde: u.searchParams.get('desde'), hasta: u.searchParams.get('hasta') });
      });
    },
  });
  await page.locator('.of-tabs button[aria-label="Hojas de ruta"]').click();
  await page.locator('.en-subtabs button[aria-label="Rendiciones"]').click();
  await page.locator('.rd-root').waitFor();
  return { page, ctx, seen };
}

try {
  await test('Rendiciones: muestra el cuadre del día, cada hoja y lo cobrado por cliente', async () => {
    const { page, ctx, seen } = await abrir(1440, respuesta());
    try {
      await page.locator('.rd-dia').first().waitFor();
      assert(seen.length >= 1, 'No pidió /api/rendiciones');
      const dia = await page.locator('.rd-dia').first().innerText();
      assert(/cuadra/i.test(dia), `El día no dice que cuadra: ${dia}`);
      assert(dia.includes('3423') && dia.includes('3424'), 'El asiento no muestra sus hojas');
      const tarjeta = page.locator('.rd-hoja', { hasText: '3423' });
      assert((await tarjeta.innerText()).includes('VICTOR'), 'La hoja no muestra el chofer');
      await tarjeta.locator('.rd-hoja-head').click();
      const filas = tarjeta.locator('.rd-fila:not(.rd-encabezado)');
      assert(await filas.count() === 2, 'No aparecen los 2 clientes de la hoja');
      assert((await tarjeta.locator('.rd-fila', { hasText: 'CLIENTE BETA' }).innerText()).match(/sin cobro/i), 'El cliente que no pagó no dice "sin cobro"');
    } finally { await ctx.close(); }
  });

  await test('Rendiciones: avisa cuando la caja del día no cuadra y muestra los cobros fuera de la hoja', async () => {
    const datos = respuesta({
      asientos: [asiento({ cuadra: false, diferencia_calculada: 366.93, entregado: 799_633.07 })],
      fuera_de_hoja: [{ fecha: '2026-09-21', total: 1_453_417, recibos: [{ id_recibo: '9', numero: '0000-30155999', fecha: '2026-09-21', cod_cliente: 999, cliente: 'CLIENTE OMEGA', importe: 1_453_417 }] }],
    });
    const { page, ctx } = await abrir(1440, datos);
    try {
      const dia = await page.locator('.rd-dia').first().innerText();
      assert(/no cuadra/i.test(dia) && dia.includes('367'), `No avisa la diferencia: ${dia}`);
      const fuera = await page.locator('.rd-fuera').first().innerText();
      assert(fuera.includes('CLIENTE OMEGA') && fuera.includes('1.453.417'), `No muestra el cobro fuera de hoja: ${fuera}`);
    } finally { await ctx.close(); }
  });

  await test('Rendiciones: es sólo lectura — no ofrece emitir, cerrar ni aprobar', async () => {
    const { page, ctx } = await abrir(1440, respuesta());
    try {
      await page.locator('.rd-hoja').first().waitFor();
      const botones = await page.locator('.rd-root button').allInnerTexts();
      assert(!botones.some(b => /emitir|cerrar|aprobar|imputar/i.test(b)), `Hay botones que escriben: ${botones.join(' | ')}`);
    } finally { await ctx.close(); }
  });

  await test('Rendiciones: en el celular no se desborda', async () => {
    const { page, ctx } = await abrir(390, respuesta());
    try {
      await page.locator('.rd-hoja').first().waitFor();
      await page.locator('.rd-hoja .rd-hoja-head').first().click();
      const m = await page.evaluate(() => ({ vw: window.innerWidth, root: document.querySelector('.rd-root').scrollWidth }));
      assert(m.root <= m.vw, `La rendición se sale de la pantalla: ${JSON.stringify(m)}`);
    } finally { await ctx.close(); }
  });
} finally {
  await browser.close();
  await fs.writeFile(out + '/browser-rendiciones.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (results.cases.some(c => !c.passed) || results.consoleErrors.length) process.exit(1);
}
