import fs from 'node:fs/promises';
import { browser, results, out, reply, setup, assert, test } from './browser-fixtures.mjs';

/**
 * Rendir el efectivo de la hoja en la app (etapa 2 del diseño que aprobó Mati el 04/10/2026).
 * La oficina carga lo cobrado por cliente (el papel de la hoja), los gastos del viaje y lo contado;
 * la app calcula la diferencia y emite los recibos a Caja Repartos. La emisión arranca APAGADA:
 * nada se escribe en IM sin el sí de Mati.
 */

const fila = (cod, nombre, p = {}) => ({
  cod_cliente: cod, cliente: nombre, llevo: 412_300, nc: 0, nd: 0, entregado: 412_300, saldo_anterior: 120_000,
  efectivo: 0, recibos_efectivo: [], transferencias: [], cobrado: 0, queda: 412_300, estado: 'sin_cobro', compartido: false, ...p,
});
const hoja = (p = {}) => ({
  id: 'h3449', numero: 3449, fecha: '2026-10-05', estado: 'abierta', chofer: 'VICTOR', nombre: null,
  fecha_efectiva: '2026-10-05', fecha_corrida: false, gastos: [],
  filas: [
    fila(101, 'CLIENTE ALFA'),
    // Anto ya lo cargó a mano en IM: la app no lo vuelve a emitir.
    fila(102, 'CLIENTE BETA', { llevo: 50_000, entregado: 50_000, efectivo: 50_000, cobrado: 50_000, queda: 0, estado: 'pago', recibos_efectivo: [{ id_recibo: '58990777', numero: '0000-30155777', fecha: '2026-10-05', importe: 50_000 }] }),
  ],
  totales: { clientes: 2, llevo: 462_300, nc: 0, entregado: 462_300, efectivo: 50_000, transferencias: 0, cobrado: 50_000, gastos: 0, debe_entregar: 50_000, sin_cobro: 1, parcial: 0, de_mas: 0 },
  asiento_id: null, ...p,
});
const rango = (p = {}) => ({
  ok: true, consultado: { im_recibos: true, im_mayor: true }, hojas: [hoja()], asientos: [], fuera_de_hoja: [], rendiciones_app: [], ...p,
});
const sinRendicion = { ok: true, hoja: { id: 'h3449', numero: 3449, fecha: '2026-10-05', estado: 'abierta', chofer: 'VICTOR' }, rendicion: null, recibos: [], emision: { tope: 0, cuenta: '1110009' } };
const conRendicion = (p = {}) => ({
  ...sinRendicion,
  rendicion: {
    efectivo: [{ cod_cliente: 101, importe: 412_300 }, { cod_cliente: 102, importe: 50_000 }], gastos: [{ concepto: 'Ayudante', importe: 18_000, detalle: null }],
    efectivo_contado: 444_000, observaciones: null, version: 2, contado_por: 'Anto', contado_at: '2026-10-06T12:00:00Z', controlado_por: null, controlado_at: null,
    lo_conto_quien_pregunta: true, cuentas: { efectivo: 462_300, gastos: 18_000, debe_entregar: 444_300, contado: 444_000, diferencia: -300 }, ...p,
  },
});
const plan = {
  ok: true, tope: 0, fecha: '2026-10-05', cuenta: '1110009', consultado: { im: true },
  plan: [
    { cod_cliente: 101, importe: 412_300, estado: 'listo', comprobantes: [{ id: 'FA1', importe_a_pagar: 120_000 }, { id: 'FA2', importe_a_pagar: 292_300 }] },
    { cod_cliente: 102, importe: 50_000, estado: 'salteado', motivo: 'Ya está cargado a mano en IM (recibo 0000-30155777, $50000.00): no se emite de nuevo.', recibo_im: '58990777' },
  ],
};

async function abrir(width, { datosRango = rango(), detalle = sinRendicion } = {}) {
  const pedidos = [];
  const { page, ctx } = await setup(width, {
    beforeGoto: async (_page, c) => {
      await c.route('**/api/rendiciones*', route => {
        const u = new URL(route.request().url());
        return reply(route, { ...datosRango, desde: u.searchParams.get('desde'), hasta: u.searchParams.get('hasta') });
      });
      await c.route('**/api/rendiciones/saldos*', route => reply(route, { ok: true, mes: '2026-10', saldos: [{ chofer: 'VICTOR', hojas: 1, contadas: 1, saldo: -300, sin_controlar: 1 }], hojas: [] }));
      await c.route('**/api/rendiciones/hoja/**', async route => {
        const r = route.request();
        const cuerpo = r.postData() ? JSON.parse(r.postData()) : null;
        pedidos.push({ metodo: r.method(), ruta: new URL(r.url()).pathname, cuerpo });
        if (r.method() === 'GET') return reply(route, detalle);
        if (r.method() === 'PUT') return reply(route, conRendicion({ efectivo: cuerpo.efectivo, gastos: cuerpo.gastos, efectivo_contado: cuerpo.efectivo_contado }));
        if (r.url().endsWith('/emitir')) return reply(route, plan);
        if (r.url().endsWith('/controlar')) return reply(route, conRendicion({ controlado_por: 'Maca', controlado_at: '2026-10-06T13:00:00Z', lo_conto_quien_pregunta: false }));
        return reply(route, { error: 'no simulado' }, 500);
      });
    },
  });
  await page.locator('.of-tabs button[aria-label="Hojas de ruta"]').click();
  await page.locator('.en-subtabs button[aria-label="Rendiciones"]').click();
  await page.locator('.rd-hoja').first().waitFor();
  return { page, ctx, pedidos };
}
async function abrirRendir(page) {
  await page.locator('.rd-hoja-head').first().click();
  await page.locator('.rd-hoja button', { hasText: 'Rendir en la app' }).click();
  await page.locator('.rr-root').waitFor();
}

try {
  await test('Rendir: se carga lo cobrado, los gastos y lo contado, y la diferencia se ve al tipear', async () => {
    const { page, ctx, pedidos } = await abrir(1440);
    try {
      await abrirRendir(page);
      // Lo que Anto ya cargó a mano en IM no se tipea de nuevo: viene de IM y no se edita.
      assert(await page.locator('input[aria-label="Efectivo cobrado a CLIENTE BETA"]').count() === 0, 'El cliente ya cargado en IM se puede editar');
      assert(/a mano/i.test(await page.locator('.rr-fila', { hasText: 'CLIENTE BETA' }).innerText()), 'No dice que BETA ya está cargado a mano en IM');
      await page.locator('input[aria-label="Efectivo cobrado a CLIENTE ALFA"]').fill('412300');
      await page.locator('button', { hasText: 'Agregar gasto' }).click();
      await page.locator('select[aria-label="Concepto del gasto"]').selectOption('Ayudante');
      await page.locator('input[aria-label="Importe del gasto"]').fill('18000');
      await page.locator('input[aria-label="Efectivo contado"]').fill('444000');
      const cuentas = await page.locator('.rr-cuentas').innerText();
      assert(cuentas.includes('462.300') && cuentas.includes('444.300'), `No suma bien efectivo y "debe entregar": ${cuentas}`);
      assert(/−\$300/.test(cuentas) && /falt/i.test(cuentas), `No muestra que faltaron $300: ${cuentas}`);
      await page.locator('button.rr-guardar').click();
      await page.locator('.aviso-temporal').waitFor();
      const put = pedidos.find(p => p.metodo === 'PUT');
      assert(put, 'No guardó (no hubo PUT)');
      assert(JSON.stringify(put.cuerpo.efectivo) === JSON.stringify([{ cod_cliente: 101, importe: 412_300 }, { cod_cliente: 102, importe: 50_000 }]), `Efectivo mal mandado: ${JSON.stringify(put.cuerpo.efectivo)}`);
      assert(put.cuerpo.gastos[0].concepto === 'Ayudante' && put.cuerpo.gastos[0].importe === 18_000, `Gasto mal mandado: ${JSON.stringify(put.cuerpo.gastos)}`);
      assert(put.cuerpo.efectivo_contado === 444_000, 'Contado mal mandado');
    } finally { await ctx.close(); }
  });

  await test('Rendir: la vista previa muestra a qué facturas va cada recibo y Emitir está apagado hasta el sí de Mati', async () => {
    const { page, ctx, pedidos } = await abrir(1440, { detalle: conRendicion() });
    try {
      await abrirRendir(page);
      await page.locator('button.rr-vista').click();
      await page.locator('.rr-plan').waitFor();
      const planTxt = await page.locator('.rr-plan').innerText();
      assert(planTxt.includes('FA1') && planTxt.includes('FA2'), `La vista previa no muestra las facturas: ${planTxt}`);
      assert(/a mano/i.test(planTxt), 'La vista previa no explica por qué BETA no se emite');
      const emitir = page.locator('button.rr-emitir');
      assert(await emitir.isDisabled(), 'Emitir está habilitado sin el sí de Mati');
      assert(/Mati/.test(await page.locator('.rr-emision-apagada').getAttribute('title') ?? ''), 'El ⓘ no explica por qué no se puede emitir');
      assert(!pedidos.some(p => p.cuerpo?.accion === 'emitir'), 'Mandó a emitir');
    } finally { await ctx.close(); }
  });

  await test('Rendir: sin la migración 056 la rendición sigue en sólo lectura y lo dice', async () => {
    const { page, ctx } = await abrir(1440, { datosRango: rango({ rendiciones_app: null }) });
    try {
      await page.locator('.rd-hoja-head').first().click();
      assert(await page.locator('.rd-hoja button', { hasText: 'Rendir en la app' }).count() === 0, 'Ofrece rendir sin la migración');
      const info = page.locator('.rd-info', { hasText: 'Sólo lectura' });
      assert(/056/.test(await info.getAttribute('title') ?? ''), 'El ⓘ no dice que falta la migración 056');
    } finally { await ctx.close(); }
  });

  await test('Rendir: quien contó no puede controlar; otra persona sí (lo cuenta Anto, lo controla Maca)', async () => {
    const { page, ctx } = await abrir(1440, { detalle: conRendicion() });
    try {
      await abrirRendir(page);
      assert(await page.locator('button.rr-controlar').isDisabled(), 'Quien contó puede controlarse a sí mismo');
    } finally { await ctx.close(); }
    const otra = await abrir(1440, { detalle: conRendicion({ lo_conto_quien_pregunta: false }) });
    try {
      await abrirRendir(otra.page);
      await otra.page.locator('button.rr-controlar').click();
      await otra.page.locator('.rr-controlado').waitFor();
      assert(/Maca/.test(await otra.page.locator('.rr-controlado').innerText()), 'No muestra quién controló');
      assert(otra.pedidos.some(p => p.ruta.endsWith('/controlar')), 'No mandó el control');
    } finally { await otra.ctx.close(); }
  });

  await test('Rendir: el día trae lo que hay que copiar en IM y el saldo del mes por repartidor', async () => {
    const enApp = [{ hoja_id: 'h3449', efectivo: [{ cod_cliente: 101, importe: 412_300 }], gastos: [{ concepto: 'Ayudante', importe: 18_000, detalle: null }], efectivo_contado: 394_000, diferencia: -300, contado_at: '2026-10-06T12:00:00Z', controlado_at: null }];
    const { page, ctx } = await abrir(1440, { datosRango: rango({ rendiciones_app: enApp }) });
    try {
      const im = await page.locator('.rd-para-im').first().innerText();
      assert(im.includes('3449-AS') && im.includes('394.000'), `No muestra el asiento para IM: ${im}`);
      assert(im.includes('según HR 3449 - Ayudante'), `No muestra la orden de pago del gasto: ${im}`);
      const saldos = await page.locator('.rd-saldos').innerText();
      assert(saldos.includes('VICTOR') && /−\$300/.test(saldos), `No muestra el saldo del mes: ${saldos}`);
    } finally { await ctx.close(); }
  });

  await test('Rendir: en el celular no se desborda', async () => {
    const { page, ctx } = await abrir(390, { detalle: conRendicion() });
    try {
      await abrirRendir(page);
      const m = await page.evaluate(() => ({ vw: window.innerWidth, root: document.querySelector('.rd-root').scrollWidth }));
      assert(m.root <= m.vw, `La rendición se sale de la pantalla: ${JSON.stringify(m)}`);
    } finally { await ctx.close(); }
  });
} finally {
  await browser.close();
  await fs.writeFile(out + '/browser-rendir.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (results.cases.some(c => !c.passed) || results.consoleErrors.length) process.exit(1);
}
