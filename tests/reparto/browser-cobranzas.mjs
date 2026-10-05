import fs from 'node:fs/promises';
import { browser, results, out, base, reply, assert, test } from './browser-fixtures.mjs';

/**
 * Cobranzas de la app de vendedores (S32, 04/10/2026). Mati: *"hay que agilizar toda la parte
 * de gestión de cuentas corrientes: carga de recibos, aprobación, etc."*.
 *
 * Medido antes de tocar: Anto decide un recibo cada 45 s y toca las facturas a mano; después de
 * aprobar espera 1,8 s y vuelve a una lista que se recarga entera. El vendedor que toca "Pago" en
 * la tarjeta de un cliente cae en la lista de recibos y tiene que buscar al cliente de nuevo.
 */

const anto = { id: 'u-anto', rol: 'administrativo', nombre: 'Anto', email: 'anto@example.invalid', cod_vendedor: null };
const julio = { id: 'u-julio', rol: 'vendedor', nombre: 'Julio', email: 'julio@example.invalid', cod_vendedor: 4 };
const clientes = [{ cod: '722', name: 'CLIENTE ALFA' }, { cod: '815', name: 'CLIENTE BETA' }];
const recibo = (id, cod, monto) => ({
  id, cod_cliente: Number(cod), cod_vendedor: 4, monto, fecha_comprobante: '2026-10-02', medio_pago: 'mercadopago',
  status: 'pendiente_revision', foto_url: `t/${id}.jpg`, foto_signed_url: null, ocr_confidence: null,
  created_at: '2026-10-02T14:00:00Z',
});
const pendientes = [recibo('r1', '722', 250_000), recibo('r2', '815', 80_000)];
const detalle = (r) => ({
  ...r, ocr_raw: null, banco_origen: null, referencia: null, observaciones: null, factura_asociada: null,
  infomanager_recibo_id: null, mp_status: 'verified', mp_candidates: [], mp_payment_id: null, cod_empresa: null,
});
// IM manda la factura nueva primero: la preselección tiene que ordenar por antigüedad igual.
const facturasDe = {
  r1: [
    { id: 2002, tipo_comprobante: 'FA', punto_de_venta: '777', numero: '51000', fecha_factura: '2026-09-28', importe_factura: 300_000, saldo: 300_000, dias_deuda: 5 },
    { id: 2001, tipo_comprobante: 'FA', punto_de_venta: '777', numero: '50900', fecha_factura: '2026-09-10', importe_factura: 100_000, saldo: 100_000, dias_deuda: 23 },
  ],
  r2: [{ id: 3001, tipo_comprobante: 'FA', punto_de_venta: '777', numero: '51010', fecha_factura: '2026-09-29', importe_factura: 80_000, saldo: 80_000, dias_deuda: 4 }],
};
const invoices = [
  { COD_CLIENT: '722', CLIENTES_N: 'CLIENTE ALFA', SALDO: 400_000, DIAS_EMISI: 23 },
  { COD_CLIENT: '815', CLIENTES_N: 'CLIENTE BETA', SALDO: 80_000, DIAS_EMISI: 4 },
];

async function abrir(user, { alAprobar, duplicados, lote, controlIM, alSubir } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => localStorage.setItem('auth_token', 'audit-local-only'));
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  await page.clock.setFixedTime(new Date('2026-10-03T14:00:00Z'));
  page.on('pageerror', e => results.consoleErrors.push(e.message));
  const seen = [];
  await ctx.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.hostname !== '127.0.0.1') return route.abort();
    if (!u.pathname.startsWith('/api/')) return route.continue();
    const metodo = route.request().method();
    seen.push(`${metodo} ${u.pathname}${u.search}`);
    if (u.pathname === '/api/me') return reply(route, { ok: true, user });
    if (u.pathname === '/api/telemetria/vista') return route.fulfill({ status: 204, body: '' });
    if (u.pathname === '/api/data') return reply(route, { invoices, clientDbMap: {} });
    if (u.pathname === '/api/goals') return reply(route, { ok: true, items: [] });
    if (u.pathname === '/api/notificaciones') return reply(route, { ok: true, items: [], notificaciones: [] });
    if (u.pathname === '/api/clientes/lookup') return reply(route, { ok: true, items: clientes });
    if (u.pathname === '/api/recibos/mp-config') return reply(route, { ok: true, activas: 3, total: 3, cuentas: [] });
    if (u.pathname === '/api/recibos/control-im') return reply(route, controlIM ?? { ok: true, dias: 14, revisados: 0, faltan: [] });
    if (u.pathname === '/api/recibos/lote' && metodo === 'POST') {
      const body = JSON.parse(route.request().postData() || '{}');
      return reply(route, lote ? lote(body) : { ok: true, tope: 3, plan: [], consultado: { im: true } });
    }
    if (u.pathname === '/api/recibos/posibles-duplicados') {
      if (!duplicados) return reply(route, { ok: true, app: [], im: [], consultado: { app: true, im: true } });
      return reply(route, { ok: true, ...duplicados(u.searchParams), consultado: { app: true, im: true } });
    }
    if (u.pathname === '/api/recibos/upload' && metodo === 'POST') {
      alSubir?.(route.request().postData() ?? '');
      return reply(route, { ok: true, comprobante: { id: 'nuevo' }, ocr: null });
    }
    if (u.pathname === '/api/recibos') return reply(route, { ok: true, recibos: pendientes, periodo: 'últimos 30 días', truncado: false });
    let m = u.pathname.match(/^\/api\/recibos\/(r\d)\/facturas-candidatas$/);
    if (m) return reply(route, { ok: true, cod_cliente: 0, cod_empresa: 1, facturas: facturasDe[m[1]] ?? [] });
    m = u.pathname.match(/^\/api\/recibos\/(r\d)\/aprobar$/);
    if (m && metodo === 'POST') {
      alAprobar?.(m[1], JSON.parse(route.request().postData() || '{}'));
      return reply(route, { ok: true, recibo_id: '5899900' + m[1].slice(1) });
    }
    m = u.pathname.match(/^\/api\/recibos\/(r\d)$/);
    if (m) return reply(route, { ok: true, recibo: detalle(pendientes.find(r => r.id === m[1])) });
    return reply(route, { error: 'Ruta sin fixture: ' + u.pathname }, 501);
  });
  await page.goto(base + '/');
  await page.locator('button[title="Cargar pago"]').waitFor();
  return { page, ctx, seen };
}

try {
  await test('Anto: las facturas vienen elegidas, de la deuda más vieja a la más nueva', async () => {
    const { page, ctx } = await abrir(anto);
    try {
      await page.locator('button[title="Cargar pago"]').click();
      await page.locator('.rec-item', { hasText: 'CLIENTE ALFA' }).click();
      await page.locator('.rec-factura').first().waitFor();
      const vieja = page.locator('.rec-factura', { hasText: '50900' });
      const nueva = page.locator('.rec-factura', { hasText: '51000' });
      assert(await vieja.locator('input[type=checkbox]').isChecked(), 'La factura más vieja no quedó elegida');
      assert(await nueva.locator('input[type=checkbox]').isChecked(), 'La segunda factura no quedó elegida');
      assert(await vieja.locator('.rec-importe-input').inputValue() === '100000', 'La más vieja tiene que ir entera (100000)');
      assert(await nueva.locator('.rec-importe-input').inputValue() === '150000', 'La más nueva lleva el resto (150000)');
    } finally { await ctx.close(); }
  });

  await test('Anto: al aprobar pasa directo al siguiente pendiente, sin volver a la lista', async () => {
    const aprobados = [];
    const { page, ctx, seen } = await abrir(anto, { alAprobar: (id, body) => aprobados.push({ id, body }) });
    try {
      await page.locator('button[title="Cargar pago"]').click();
      await page.locator('.rec-item', { hasText: 'CLIENTE ALFA' }).click();
      await page.locator('.rec-factura').first().waitFor();
      const listasAntes = seen.filter(s => s.startsWith('GET /api/recibos?')).length;
      const t0 = Date.now();
      await page.locator('.rec-approval-actions .btn-primary').click();
      await page.locator('.rec-detail h3', { hasText: 'CLIENTE BETA' }).waitFor({ timeout: 3000 });
      const ms = Date.now() - t0;
      assert(aprobados.length === 1 && aprobados[0].id === 'r1', `No se aprobó r1: ${JSON.stringify(aprobados)}`);
      const imputado = Object.fromEntries((aprobados[0].body.comprobantes ?? []).map(c => [String(c.id), Number(c.importe_a_pagar)]));
      assert(imputado['2001'] === 100_000 && imputado['2002'] === 150_000, `Imputación inesperada: ${JSON.stringify(imputado)}`);
      assert(seen.filter(s => s.startsWith('GET /api/recibos?')).length === listasAntes, 'Volvió a pedir la lista entera entre un recibo y el siguiente');
      assert(ms < 2500, `Tardó ${ms} ms en mostrar el siguiente`);
      results.medicion = { ...(results.medicion ?? {}), ms_hasta_el_siguiente: ms };
    } finally { await ctx.close(); }
  });

  await test('Vendedor: "Pago" en la tarjeta del cliente abre la carga con ese cliente elegido', async () => {
    const { page, ctx } = await abrir(julio);
    try {
      await page.locator('.vs-nav-btn', { hasText: 'Cobranzas' }).click();
      const tarjeta = page.locator('.vs-client[data-client-cod="722"]');
      await tarjeta.waitFor();
      await tarjeta.locator('.vs-qa.pay').click();
      await page.locator('.recibos-header h2', { hasText: 'Cargar comprobante' }).waitFor({ timeout: 3000 });
      const elegido = page.locator('.rec-client-option.is-active');
      assert(await elegido.count() === 1, 'No quedó ningún cliente elegido');
      assert((await elegido.innerText()).includes('CLIENTE ALFA'), 'Quedó elegido otro cliente');
      assert(await page.locator('.rec-cod-input').inputValue() === '722', 'El código del cliente no quedó cargado');
    } finally { await ctx.close(); }
  });
  const enIM = { app: [], im: [{ id_recibo: '58999123', numero: '0000-30155729', fecha: '2026-10-02', importe: 250_000, dias: 0, cuentas: ['1120003'] }] };

  await test('Vendedor: si el pago ya figura, avisa y pide confirmar antes de enviar', async () => {
    const { page, ctx } = await abrir(julio, { duplicados: () => enIM });
    try {
      await page.locator('.vs-nav-btn', { hasText: 'Cobranzas' }).click();
      await page.locator('.vs-client[data-client-cod="722"] .vs-qa.pay').click();
      await page.locator('.rec-upload').waitFor();
      await page.locator('.rec-field select').first().selectOption('efectivo');
      await page.locator('.rec-field input[inputmode="decimal"]').fill('250000');
      await page.locator('.rec-field input[type="date"]').fill('2026-10-02');
      const aviso = page.locator('.rec-upload .rec-dup');
      await aviso.waitFor({ timeout: 4000 });
      assert((await aviso.innerText()).includes('30155729'), 'El aviso no muestra el recibo de IM');
      const enviar = page.locator('.rec-form-actions .btn-primary');
      assert(await enviar.isDisabled(), 'Con un posible repetido no debería dejar enviar sin confirmar');
      await aviso.locator('input[type="checkbox"]').check();
      assert(await enviar.isEnabled(), 'Confirmado "es otro pago", tiene que dejar enviar');
    } finally { await ctx.close(); }
  });

  /**
   * OCR en el celular (S32 · mejora 8, Mati 05/10/2026): corre de verdad (Tesseract, servido por la
   * app desde /ocr) sobre un comprobante dibujado acá. No se usan fotos reales: tienen datos de clientes.
   * La transferencia va a la Recaudadora 1 y el medio de fábrica es MercadoPago: el error que se
   * repitió 26 veces entre mayo y octubre.
   */
  async function subirComprobanteDibujado(page) {
    const b64 = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 800; c.height = 700;
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#111';
      const linea = (t, y, px, peso = '') => { g.font = `${peso} ${px}px sans-serif`; g.fillText(t, 40, y); };
      linea('Comprobante de transferencia', 90, 40, 'bold');
      linea('2/octubre/2026 a las 12:41.', 150, 32);
      linea('$ 418.769', 270, 72, 'bold');
      linea('Motivo: Varios', 330, 30);
      linea('Para', 430, 30);
      linea('Semillero El Manantial', 480, 34, 'bold');
      linea('CVU: 0000003100099266226170', 530, 30);
      return c.toDataURL('image/png').split(',')[1];
    });
    await page.locator('.rec-upload input[type="file"]').setInputFiles({ name: 'comprobante.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
  }

  await test('Vendedor: el OCR del celular completa monto y fecha, y avisa si la cuenta no es la elegida', async () => {
    let subido = '';
    const { page, ctx } = await abrir(julio, { alSubir: cuerpo => { subido = cuerpo; } });
    try {
      await page.locator('.vs-nav-btn', { hasText: 'Cobranzas' }).click();
      await page.locator('.vs-client[data-client-cod="722"] .vs-qa.pay').click();
      await page.locator('.rec-upload').waitFor();
      await subirComprobanteDibujado(page);
      const aviso = page.locator('.rec-foto-difiere');
      await aviso.waitFor({ timeout: 90_000 });
      assert(await page.locator('.rec-field input[inputmode="decimal"]').inputValue() === '418769', 'No completó el monto de la foto');
      assert(await page.locator('.rec-field input[type="date"]').inputValue() === '2026-10-02', 'No completó la fecha de la foto');
      assert(/Recaudadora 1/.test(await aviso.innerText()), `El aviso no dice a qué cuenta fue: ${await aviso.innerText()}`);
      await aviso.locator('.rec-foto-cambiar').click();
      assert(await page.locator('.rec-field select').first().inputValue() === 'recaudadora_1', '"Cambiar" no corrigió el medio');
      await page.locator('.rec-foto-ok').waitFor({ timeout: 3000 });
      await page.locator('.rec-form-actions .btn-primary').click();
      await page.locator('.rec-msg--ok').waitFor({ timeout: 5000 });
      assert(/name="ocr_celular"[\s\S]*"monto":418769/.test(subido), 'No mandó lo que leyó el celular');
    } finally { await ctx.close(); }
  });

  await test('Vendedor: lo que ya tipeó no se pisa; si no coincide con la foto, avisa', async () => {
    const { page, ctx } = await abrir(julio);
    try {
      await page.locator('.vs-nav-btn', { hasText: 'Cobranzas' }).click();
      await page.locator('.vs-client[data-client-cod="722"] .vs-qa.pay').click();
      await page.locator('.rec-upload').waitFor();
      await page.locator('.rec-field input[inputmode="decimal"]').fill('400000');
      await subirComprobanteDibujado(page);
      const aviso = page.locator('.rec-foto-difiere');
      await aviso.waitFor({ timeout: 90_000 });
      assert(await page.locator('.rec-field input[inputmode="decimal"]').inputValue() === '400000', 'Pisó el monto que había tipeado');
      const texto = await aviso.innerText();
      assert(texto.includes('418.769') && texto.includes('400.000'), `El aviso no muestra las dos cifras: ${texto}`);
    } finally { await ctx.close(); }
  });

  await test('Anto: el detalle avisa si el pago ya figura en IM y deja rechazarlo en un toque', async () => {
    const { page, ctx } = await abrir(anto, { duplicados: () => enIM });
    try {
      await page.locator('button[title="Cargar pago"]').click();
      await page.locator('.rec-item', { hasText: 'CLIENTE ALFA' }).click();
      const aviso = page.locator('.rec-detail .rec-dup');
      await aviso.waitFor({ timeout: 4000 });
      assert((await aviso.innerText()).includes('30155729'), 'El aviso no muestra el recibo de IM');
      await aviso.locator('button', { hasText: 'Rechazar' }).click();
      const motivo = await page.locator('.rec-rechazo-input').inputValue();
      assert(/ya imputado/i.test(motivo) && motivo.includes('30155729'), `Motivo inesperado: "${motivo}"`);
    } finally { await ctx.close(); }
  });

  await test('Vendedor: la tarjeta del cliente avisa "pago en revisión"', async () => {
    const { page, ctx } = await abrir(julio);
    try {
      await page.locator('.vs-nav-btn', { hasText: 'Cobranzas' }).click();
      const chip = page.locator('.vs-client[data-client-cod="722"] .vs-pago-revision');
      await chip.waitFor({ timeout: 4000 });
      assert((await chip.innerText()).includes('250'), `El chip no muestra el importe: "${await chip.innerText()}"`);
    } finally { await ctx.close(); }
  });
  await test('Anto: aprueba en lote los verificados por MercadoPago, con el plan a la vista', async () => {
    const pedidos = [];
    const lote = (body) => {
      pedidos.push(body);
      const plan = [
        { id: 'r1', cod_cliente: 722, monto: 250_000, fecha: '2026-10-02', estado: 'listo', comprobantes: [{ id: '2001', importe_a_pagar: 100_000 }, { id: '2002', importe_a_pagar: 150_000 }] },
        { id: 'r2', cod_cliente: 815, monto: 80_000, fecha: '2026-10-02', estado: 'salteado', motivo: 'Tiene observaciones del vendedor: revisalo a mano.' },
      ];
      return body.accion === 'plan'
        ? { ok: true, tope: 3, plan, consultado: { im: true } }
        : { ok: true, tope: 3, plan, resultados: [{ id: 'r1', ok: true, recibo_id: '58999001' }], frenado: false };
    };
    const { page, ctx } = await abrir(anto, { lote });
    try {
      await page.locator('button[title="Cargar pago"]').click();
      await page.locator('.rec-lote-abrir').click();
      const panel = page.locator('.rec-lote');
      await panel.locator('.rec-lote-listo', { hasText: 'CLIENTE ALFA' }).waitFor();
      // Los salteados van plegados (menos ruido); al abrirlos se ve el motivo de cada uno.
      await panel.locator('.rec-lote-salteados summary').click();
      assert((await panel.locator('.rec-lote-salteados').innerText()).includes('observaciones'), 'No muestra por qué se salteó el de CLIENTE BETA');
      await panel.locator('button', { hasText: 'Aprobar 1' }).click();
      await panel.locator('.rec-lote-resultado', { hasText: '58999001' }).waitFor({ timeout: 4000 });
      const aprobar = pedidos.find(p => p.accion === 'aprobar');
      assert(aprobar && JSON.stringify(aprobar.ids) === '["r1"]', `Mandó otros ids: ${JSON.stringify(aprobar)}`);
    } finally { await ctx.close(); }
  });
  await test('Anto: la lista avisa si un recibo de la app ya no está en IM (borrado allá)', async () => {
    const controlIM = { ok: true, dias: 14, revisados: 40, faltan: [{ id: 'x', cod_cliente: 722, monto: 700_089, fecha_comprobante: '2026-09-24', infomanager_recibo_id: '58965142', imputado_at: '2026-09-25T11:46:02Z', cod_empresa: 1, reviewed_by_nombre: 'Anto' }] };
    const { page, ctx } = await abrir(anto, { controlIM });
    try {
      await page.locator('button[title="Cargar pago"]').click();
      const aviso = page.locator('.rec-control-im');
      await aviso.waitFor({ timeout: 4000 });
      assert((await aviso.innerText()).includes('1 recibo'), `El aviso no dice cuántos: ${await aviso.innerText()}`);
      await aviso.locator('button').first().click();
      assert((await aviso.innerText()).includes('58965142'), 'No muestra el número del recibo de IM');
    } finally { await ctx.close(); }
  });
} finally {
  await browser.close();
  await fs.writeFile(out + '/browser-cobranzas.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (results.cases.some(c => !c.passed) || results.consoleErrors.length) process.exit(1);
}
