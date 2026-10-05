import fs from 'node:fs/promises';
import {browser,results,out,row,item,reply,presupuestos,setup,assert,test} from './browser-fixtures.mjs';

/**
 * LA LIMPIEZA DE AVISOS (04/10/2026). Mati: *"siento que todavía hay demasiados carteles, avisos y
 * mensajes en la app de facturación y hojas de ruta; debe estar mareando a Jo con tanta info"*.
 *
 * Regla: un aviso visible por pantalla, primero lo que frena. Lo informativo va a un ⓘ, el "listo"
 * de una acción se va solo a los 5 s, y lo que tiene que arreglar otra persona va a un informe.
 */
// 🪤 pierde_margen CUENTA artículos en una lista más barata; no son pesos (el 04/10 el informe
// salió en producción con "$21").
const bajoLista = { ...row('101', 'CLIENTE ALFA'), gravedad: { pierde_margen: 2, cobra_de_mas: 0 },
  avisos: ['ALPISTE: lista 13 en vez de 12', 'MIJO: lista 13 en vez de 12'], revision: { estado: 'aprobado', observacion: null, revisado_at: '2026-09-10T12:00:00Z' },
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
      assert(/CLIENTE ALFA/.test(lista) && /ALPISTE/.test(lista) && /MIJO/.test(lista), `El informe de precios no trae el caso: "${lista}"`);
      const columnas = await dialogo.locator('th').allInnerTexts();
      assert(columnas.some(t => /^artículos$/i.test(t.trim())) && !columnas.some(t => /margen/i.test(t)), `Las columnas no dicen que se cuentan artículos: ${columnas.join(' | ')}`);
      const cuenta = (await dialogo.locator('tbody tr').first().locator('td').last().innerText()).trim();
      assert(cuenta === '2', `La última columna no cuenta artículos: "${cuenta}"`);
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

  await test('🔴 Editor: vacío, "ya facturado" no ocupa lugar; el enlace del buscador lo suma y el cuadro queda compacto', async () => {
    // Mati (05/10/2026): el cuadro vacío era "MUY invasivo" y "al pedo".
    const vacio = { items: [item(11, 'PRODUCTO ALFA')], pendientes: [], pendientes_disponibles: true, pendientes_error: null,
      comprobante: { im_comprobante_id: '101', numero: 101, cod_cliente: 101, cliente_nombre: 'CLIENTE ALFA', fecha: '2026-09-10', huella: 'v101' } };
    const { page, ctx } = await setup(1440, { beforeGoto: async p => {
      conPresupuestos([row('101', 'CLIENTE ALFA')])(p);
      await p.route('**/api/presupuestos/101', r => reply(r, vacio));
      await p.route('**/api/articulos/buscar?**', r => reply(r, { ok: true, articulos: [{ cod_articulo: 491, descripcion: 'MEZCLA GALLO PREMIUM', unidad_de_medida: null, equivalencia_um: 1, precio_venta: 1330 }] }));
    } });
    try {
      await page.locator('.pr-abrir').first().click();
      const editor = page.locator('.pr-detalle');
      await editor.locator('.ed-buscar').waitFor();
      assert(await editor.locator('.ed-pendientes').count() === 0, 'El cuadro de lo ya facturado aparece vacío');
      assert(!/Para sumar mercadería ya facturada/.test(await editor.innerText()), 'Sigue la explicación del cuadro vacío');
      await editor.screenshot({ path: `${out}/editor-ya-facturado-vacio.png` });
      await editor.getByRole('button', { name: /sumar ya facturado/ }).click();
      const buscador = editor.locator('.ed-buscar input');
      assert(/ya facturado/i.test(await buscador.getAttribute('placeholder') ?? ''), 'El buscador no avisa que lo que se elija va como ya facturado');
      await buscador.fill('gallo');
      await buscador.press('Enter');
      await editor.locator('.ed-res', { hasText: 'MEZCLA GALLO PREMIUM' }).waitFor();
      await editor.screenshot({ path: `${out}/editor-ya-facturado-buscando.png` });
      await editor.locator('.ed-res', { hasText: 'MEZCLA GALLO PREMIUM' }).click();
      // 🔴 Entra como ya facturado, nunca como un renglón que se cobra.
      await editor.locator('.ed-pend-tabla').waitFor();
      assert(/MEZCLA GALLO PREMIUM/.test(await editor.locator('.ed-pend-tabla').innerText()), 'No entró como ya facturado');
      assert(!/MEZCLA GALLO PREMIUM/.test(await editor.locator('.ed-tabla:not(.ed-pend-tabla)').innerText()), 'Entró como un renglón que se cobra');
      assert(await editor.locator('.ed-pend-tabla thead').count() === 0, 'Con renglones sigue la fila de títulos: no quedó compacto');
      await editor.screenshot({ path: `${out}/editor-ya-facturado-compacto.png` });
      // Y el modo se apaga: lo próximo que se busque vuelve a ser un producto que se cobra.
      assert(!/ya facturado/i.test(await buscador.getAttribute('placeholder') ?? ''), 'El buscador quedó en modo "ya facturado"');
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
  // ─── Facturación ──────────────────────────────────────────────────────────────────────────
  const FACTURADA = (extra = {}) => ({ ...row('101', 'CLIENTE ALFA'), im_factura_id: '501', im_factura_numero: 51031, im_factura_tipo: 'FA B',
    im_remito_id: '601', im_remito_numero: 78304, facturado_at: '2026-09-29', notas: [], ...extra });
  const control = estado => ({ estado, texto: estado === 'coinciden' ? 'Coinciden las cantidades.' : 'Sin dato.', diferencias: [], checked_at: '2026-09-11T15:00:00.000Z' });
  const tablero = (p, cuerpo) => p.route('**/api/facturacion?**', r => reply(r, { pendientes: [], facturados: [], totales: { pendientes: 0, facturados: 0 }, ...cuerpo }));
  const aFacturacion = async page => {
    await page.locator('.of-tabs').getByRole('button', { name: 'Facturación', exact: true }).click();
  };

  await test('Facturación: un pendiente sin problema no dice "listo"; una falta sí se ve; los frenados van a un ⓘ', async () => {
    const { page, ctx } = await setup(1440, { beforeGoto: p => tablero(p, {
      pendientes: [row('101', 'CLIENTE ALFA'), { ...row('102', 'CLIENTE BETA'), falta_remito: true, im_factura_numero: 50900 }],
      totales: { pendientes: 2, facturados: 0 }, observados: 2,
    }) });
    try {
      await aFacturacion(page);
      const filas = page.locator('.fc-tabla tbody tr');
      await filas.nth(1).waitFor();
      assert(await filas.nth(0).locator('.fc-badge').count() === 0, 'Sigue el badge "listo"');
      assert(/falta el remito/.test(await filas.nth(1).locator('.fc-badge').innerText()), 'Se perdió el aviso de la falta de remito');
      assert(/2 frenados en Presupuestos/.test(await page.locator('.fc-info').innerText()), 'Los frenados no quedaron en el ⓘ');
      assert(await page.locator('p.fc-nota', { hasText: 'con un problema marcado' }).count() === 0, 'Sigue la nota fija de los frenados');
    } finally { await ctx.close(); }
  });

  await test('Emisión trabada: el badge queda y las salidas van a "Resolver"', async () => {
    const trabada = { ...row('101', 'CLIENTE ALFA'), estado_emision: 'incierto', im_factura_numero: 50900, im_remito_numero: null, facturado_at: null };
    const { page, ctx } = await setup(1440, { beforeGoto: p => tablero(p, { pendientes: [trabada], totales: { pendientes: 1, facturados: 0 } }) });
    try {
      await aFacturacion(page);
      const fila = page.locator('.fc-tabla tbody tr').first();
      await fila.locator('.fc-badge.grave', { hasText: 'emisión por verificar' }).waitFor();
      assert(!(await fila.getByRole('button', { name: 'Ya lo hice en IM' }).isVisible()), 'Las salidas siguen a la vista');
      await fila.locator('.fc-menu-boton', { hasText: 'Resolver' }).click();
      assert(await fila.getByRole('button', { name: 'Ya lo hice en IM' }).isVisible(), 'El menú "Resolver" no muestra las salidas');
      assert(await fila.getByRole('button', { name: 'No está en IM' }).isVisible(), 'Falta "No está en IM" en el menú');
    } finally { await ctx.close(); }
  });

  await test('🔴 Facturadas: ni "Coinciden" ni "Sin dato" ni "Anular" a la vista; están en "⋯"', async () => {
    const { page, ctx } = await setup(1440, { beforeGoto: p => tablero(p, {
      facturados: [FACTURADA({ control_fa_re: control('coinciden') }), FACTURADA({ im_comprobante_id: '102', cliente_nombre: 'CLIENTE BETA', control_fa_re: control('no_verificado') })],
      totales: { pendientes: 0, facturados: 2 },
    }) });
    try {
      await aFacturacion(page);
      await page.locator('.fc-facturados summary').first().click();
      const filas = page.locator('.fc-facturados tbody tr');
      await filas.nth(1).waitFor();
      assert(await page.getByRole('button', { name: /Coinciden|Sin dato/ }).count() === 0, 'Siguen los botones de comparar en cada fila');
      assert(!(await filas.nth(0).locator('.fc-anular').isVisible()), '"Anular" sigue a la vista en cada fila');
      assert(!(await filas.nth(0).locator('.fc-fecha').isVisible()), '"Fecha" sigue a la vista en cada fila');
      await filas.nth(0).locator('.fc-menu-boton').click();
      for (const accion of ['Comparar con el remito', 'Fecha', 'Anular']) {
        assert(await filas.nth(0).getByRole('button', { name: new RegExp(accion) }).isVisible(), `El menú no tiene "${accion}"`);
      }
    } finally { await ctx.close(); }
  });

  await test('Facturar: el cartel rojo en una línea; la fecha máxima y "cómo se emite" a un ⓘ; el stock negativo plegado', async () => {
    const previa = { fecha_maxima_emision: '2026-09-30', max_adelanto_dias: 7, punto_de_venta: 777, no_se_puede: 0, ya_facturados: 0,
      pedidos: [{ ...row('101', 'CLIENTE ALFA'), estado: 'listo', letra: 'B', renglones: 1, sin_stock: [{ cod_articulo: 5, descripcion: 'SORGO', pedido: 10, disponible: 2 }] }],
      a_emitir: { facturas: 1, remitos: 1, clientes: 1, total: 150000, letras: { A: 0, B: 1 } } };
    const { page, ctx } = await setup(1440, { beforeGoto: async p => {
      await tablero(p, { pendientes: [row('101', 'CLIENTE ALFA')], totales: { pendientes: 1, facturados: 0 } });
      await p.route('**/api/facturacion/previa?**', r => reply(r, previa));
    } });
    try {
      await aFacturacion(page);
      await page.locator('.fc-tabla tbody input[type=checkbox]').first().check();
      await page.getByRole('button', { name: 'Facturar 1', exact: true }).click();
      const grave = page.locator('.fac-alerta.grave');
      await grave.waitFor();
      const texto = (await grave.innerText()).trim();
      assert(/No se deshace desde acá/.test(texto) && texto.length < 90, `El cartel rojo no es de una línea: "${texto}"`);
      const modal = await page.locator('.fac-modal').innerText();
      assert(!/de a un pedido por vez/.test(modal), 'El párrafo de cómo se emite sigue fijo');
      assert(!/Fecha máxima permitida/.test(modal), 'La fecha máxima sigue fija');
      assert(/Fecha máxima permitida: 2026-09-30/.test(await page.locator('.fac-ayuda').first().getAttribute('title') ?? ''), 'La fecha máxima no quedó en el ⓘ');
      const negativo = page.locator('details.fac-negativo');
      assert(await negativo.count() === 1 && await negativo.getAttribute('open') === null, 'El stock negativo no quedó plegado');
      assert(/stock en negativo/.test(await negativo.locator('summary').innerText()), 'El resumen del stock negativo no dice qué pasa');
    } finally { await ctx.close(); }
  });

  await test('Editar factura: la explicación es una línea, con el detalle en el ⓘ', async () => {
    const factura = { factura: { id: '501', numero: 51031, letra: 'B', cliente_nombre: 'CLIENTE ALFA', fecha: '2026-09-29' },
      version: 0, operacion: null, bloqueo_productos: null, sin_articulo: [],
      renglones: [{ cod_articulo: 650, descripcion: 'MANI C/ CHOCOLATE', cantidad: 12, precio: 9936, descuento_porc: 0, cod_lista_precios: 12 }] };
    const { page, ctx } = await setup(1440, { beforeGoto: async p => {
      await tablero(p, { facturados: [FACTURADA()], totales: { pendientes: 0, facturados: 1 } });
      await p.route('**/api/facturacion/corregir/501', r => reply(r, factura));
      await p.route('**/api/facturacion/editar', r => reply(r, { previsualizacion: { rehace_factura: false,
        factura: { numero: 51031, tipo: 'FA B', total_actual: 119232, total_nuevo: 119232 },
        remito: { numero: 78304, total_actual: 119232, total_nuevo: 119232 }, vuelve: [], sale: [], hoja: null } }));
    } });
    try {
      await aFacturacion(page);
      await page.locator('.fc-facturados summary').first().click();
      await page.getByRole('button', { name: 'Editar', exact: true }).click();
      const sub = page.locator('.cf-sub').first();
      await sub.waitFor();
      assert(/Si cambia/.test(await sub.innerText()), `La línea no explica qué pasa: "${await sub.innerText()}"`);
      assert(/Dejá la factura como tiene que quedar/.test(await sub.getAttribute('title') ?? ''), 'El detalle no quedó en el ⓘ');
      assert(!/Dejá la factura como tiene que quedar/.test(await page.locator('.cf-modal').innerText()), 'El recuadro de ayuda sigue fijo');
    } finally { await ctx.close(); }
  });

  // ─── Hojas de ruta ─────────────────────────────────────────────────────────
  /** Un remito listo para salir, como lo arma /api/hojas-ruta/pendientes. */
  const remito = (id, nombre, extra = {}) => ({ ...row(id, nombre), im_numero: 5000 + Number(id), factura_origen: 'unica',
    im_factura_numero: 4000 + Number(id), im_factura_tipo: 'FA B', renglones_sin_peso: 0, de_otro_dia: false,
    observaciones: null, hoja_id: null, ...extra });
  const enHoja = (id, extra = {}) => ({ im_comprobante_id: id, im_numero: 5000 + Number(id), cliente_nombre: 'CLIENTE ' + id,
    cod_cliente: Number(id), total: 150000, saldo_anterior: 0, bultos: 10, kg: 300, tipo_comprobante: 'RE', peso_completo: true,
    im_factura_numero: 4000 + Number(id), im_remito_numero: 5000 + Number(id), facturado_at: '2026-09-10', ...extra });
  const HOJA = pedidos => ({ version: 1, id: 'h1', numero: 3405, nombre: null, fecha: '2026-09-10', turno: null, transporte: null,
    camion: null, camion_id: null, capacidad_kg: null, cod_zona: 9, estado: 'abierta', facturada: true, chofer: null,
    chofer_id: null, cerrada_at: null, pedidos, totales: { pedidos: pedidos.length, bultos: 10 * pedidos.length, kg: 300 * pedidos.length },
    carga: { completa: true, porcentaje: null, excedido: false, sobra_kg: null } });
  const aHojas = async (page, pendientes, hojas = []) => {
    await page.route('**/api/hojas-ruta/pendientes**', r => reply(r, { pendientes, dias_sin_items: [] }));
    await page.route('**/api/hojas-ruta?**', r => reply(r, { hojas }));
    await page.locator('.of-tabs').getByRole('button', { name: 'Hojas de ruta', exact: true }).click();
    await page.locator('.hr-zona-head').first().waitFor();
  };

  await test('🔴 Hojas: queda "sin factura"; se van el "⚠" por zona, "zona estimada" y "sin peso"; la deducida va a un ⓘ', async () => {
    const { page, ctx } = await setup(1440);
    try {
      await aHojas(page, [
        remito('201', 'CLIENTE SIN FACTURA', { im_factura_numero: null, factura_origen: 'ninguna' }),
        remito('202', 'CLIENTE DEDUCIDA', { factura_origen: 'elegida' }),
        remito('203', 'CLIENTE ESTIMADA', { zona_origen: 'nombre' }),
        remito('204', 'CLIENTE SIN PESO', { renglones_sin_peso: 2, peso_completo: false }),
      ]);
      // "Sin factura" es EL aviso de la pantalla: se queda.
      assert(/1 sin factura/.test(await page.locator('.hr-resumen .hr-chip-aviso.grave').innerText()), 'Se perdió el aviso de "sin factura"');
      // El "⚠" por zona repetía ese número, y su ayuda decía "por debajo de lista".
      assert(await page.locator('.hr-zona-alerta').count() === 0, 'Sigue el "⚠" por zona');
      const deducida = page.locator('.hr-resumen .hr-info', { hasText: '1 con factura deducida' });
      assert(await deducida.count() === 1, 'La factura deducida no quedó en un ⓘ');
      assert(/más de una factura/.test(await deducida.getAttribute('title') ?? ''), 'El ⓘ no explica qué es una factura deducida');
      await page.locator('.hr-zona-abrir').first().click();
      await page.locator('.hr-ped').nth(3).waitFor();
      const lista = await page.locator('.hr-col-pedidos').innerText();
      for (const viejo of ['zona estimada', 'sin peso']) assert(!lista.includes(viejo), `La lista todavía dice "${viejo}"`);
      // Lo de cada fila que sí importa sigue: la falta de factura y la factura dudosa.
      assert(/sin factura/.test(await page.locator('.hr-ped', { hasText: 'CLIENTE SIN FACTURA' }).innerText()), 'La fila perdió "sin factura"');
      assert(/4202 \?/.test(await page.locator('.hr-ped', { hasText: 'CLIENTE DEDUCIDA' }).innerText()), 'La fila perdió la factura dudosa');
    } finally { await ctx.close(); }
  });

  await test('Hojas: los clientes sin zona van a un informe para quien carga clientes en IM', async () => {
    const { page, ctx } = await setup(1440);
    try {
      await aHojas(page, [
        remito('201', 'CLIENTE CON ZONA'),
        remito('203', 'CLIENTE ESTIMADA', { zona_origen: 'nombre', cod_zona: 4, zona: 'Concepción / Monteros' }),
        remito('205', 'CLIENTE SIN ZONA', { zona_origen: 'ninguno', cod_zona: null, zona: 'Sin zona' }),
        remito('206', 'CLIENTE SIN ZONA', { zona_origen: 'ninguno', cod_zona: null, zona: 'Sin zona', cod_cliente: 205 }),
      ]);
      await page.locator('.hr-resumen').getByRole('button', { name: /Informes/ }).click();
      const dialogo = page.getByRole('dialog', { name: 'Informes del rango' });
      await dialogo.waitFor();
      const texto = await dialogo.innerText();
      assert(/CLIENTE ESTIMADA/.test(texto) && /CLIENTE SIN ZONA/.test(texto), `El informe no trae a los clientes sin zona: "${texto}"`);
      assert(!/CLIENTE CON ZONA/.test(texto), 'El informe trae a un cliente que tiene la zona cargada');
      assert(/No se manda a nadie/.test(texto), 'No aclara que el informe no se manda');
      const fila = dialogo.locator('tbody tr', { hasText: 'CLIENTE SIN ZONA' });
      assert(await fila.count() === 1, 'Repite al cliente por cada pedido');
      assert((await fila.locator('td').last().innerText()).trim() === '2', 'No cuenta los pedidos del cliente');
      await page.keyboard.press('Escape');
      await dialogo.waitFor({ state: 'detached' });
    } finally { await ctx.close(); }
  });

  await test('🔴 Hojas: "enlace copiado" y el retiro sin vueltas se van solos; el "pero…" del retiro se queda', async () => {
    let sinFacturar = 0;
    const { page, ctx } = await setup(1440, { beforeGoto: async p => {
      // En un navegador sin pantalla el portapapeles no anda: se simula que copió.
      await p.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } }));
      await p.route('**/api/retiros', r => r.request().method() === 'POST'
        ? reply(r, { ok: true, agregados: 1, sin_facturar: sinFacturar }) : r.fallback());
    } });
    try {
      page.on('dialog', d => d.accept());
      await aHojas(page, [remito('201', 'CLIENTE ALFA'), remito('202', 'CLIENTE BETA')], [HOJA([enHoja('301')])]);
      await page.getByRole('button', { name: 'Copiar enlace a hoja 3405' }).click();
      const listo = page.locator('.aviso-temporal');
      await listo.waitFor();
      assert(/Enlace a hoja 3405 copiado/.test(await listo.innerText()), 'No avisa que se copió el enlace');
      assert(await page.locator('.hr-aviso', { hasText: 'copiado' }).count() === 0, 'El "copiado" sigue como cartel fijo');
      await listo.waitFor({ state: 'detached', timeout: 8000 });

      const retirar = async () => {
        await page.locator('.hr-ped input[type=checkbox]').first().check();
        await page.getByRole('button', { name: /Retira el cliente/ }).click();
      };
      await page.locator('.hr-zona-abrir').first().click();
      await retirar();
      await page.locator('.aviso-temporal', { hasText: 'retiro en sucursal' }).waitFor();
      assert(await page.locator('.hr-aviso', { hasText: 'retiro en sucursal' }).count() === 0, 'El retiro sin vueltas sigue como cartel fijo');

      sinFacturar = 1;
      await retirar();
      const pero = page.locator('.hr-aviso', { hasText: 'todavía sin facturar' });
      await pero.waitFor();
      await page.waitForTimeout(6000);
      assert(await pero.isVisible(), 'El "pero…" del retiro se fue solo: nadie lo llegó a leer');
    } finally { await ctx.close(); }
  });

  await test('Hoja: "sin saldo" pasa a un ⓘ; "Importe por verificar" se queda', async () => {
    const { page, ctx } = await setup(1440);
    try {
      await aHojas(page, [remito('201', 'CLIENTE ALFA')], [HOJA([
        enHoja('301', { saldo_anterior: null }),
        enHoja('302', { importe_error: 'No pude verificar el importe de la factura 4302.' }),
      ])]);
      // Con un importe por verificar la hoja arranca desplegada: es la que hay que mirar.
      const filas = page.locator('.hr-hoja-ped');
      await filas.nth(1).waitFor();
      const saldo = filas.nth(0).locator('.hr-sin-saldo');
      assert(await saldo.count() === 1 && /no se pudo traer el saldo/i.test(await saldo.getAttribute('title') ?? ''), '"sin saldo" no quedó en un ⓘ');
      assert(await filas.nth(0).locator('.hr-sinpeso').count() === 0, '"sin saldo" sigue pintado como aviso');
      assert(/Importe por verificar/.test(await filas.nth(1).innerText()), 'Se perdió "Importe por verificar"');
    } finally { await ctx.close(); }
  });
} finally {
  await browser.close();
  await fs.writeFile(out + '/browser-limpieza-avisos.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (results.cases.some(c => !c.passed) || results.consoleErrors.length) process.exit(1);
}
