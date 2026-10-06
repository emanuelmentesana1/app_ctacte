import { describe, it, expect } from 'vitest';
import {
    normalizarBorrador, cuentasDeLaRendicion, planDeEmision, saldosPorRepartidor, resumenParaIM,
    type Borrador, type ReciboDeLaHoja,
} from './rendicionEfectivo.js';
import type { ReciboIMLite, ReciboAppLite } from './duplicadosRecibo.js';

/**
 * Etapa 2 de la rendición (diseño aprobado por Mati el 04/10/2026): la oficina carga lo cobrado
 * por cliente, los gastos del viaje y el efectivo contado, y la app emite los recibos de efectivo
 * a Caja Repartos. Decisiones de Mati que fijan estos tests:
 *  2. el efectivo se imputa primero a la deuda más vieja;
 *  3. lo cuenta Anto y lo controla Maca; la diferencia NO se descuenta en el momento: se acumula
 *     en un saldo mensual por repartidor;
 *  4. la app anota los gastos del viaje.
 * Riesgo 1 del diseño: si Anto ya cargó el recibo a mano en IM, la app NO lo emite de nuevo.
 */

const CAJA = '1110009';
const HOJA = { numero: 3449, fecha: '2026-10-05' };
const fa = (id: string, fecha: string, saldo: number) => ({ id, fecha_factura: fecha, numero: id, saldo, tipo_comprobante: 'FA' });
const reciboIM = (p: Partial<ReciboIMLite> & { cuenta?: string; importe?: number }): ReciboIMLite => ({
    id_recibo: p.id_recibo ?? '58990001', numero: p.numero ?? '0001-00090001', fecha: p.fecha ?? HOJA.fecha,
    cliente: p.cliente ?? { codigo: 722 }, importe_total: p.importe ?? 412_300,
    items: [{ tipo_pago: 'EFECTIVO', importe: p.importe ?? 412_300, cuenta_contable: p.cuenta ?? CAJA }],
});
const borrador = (p: Partial<Borrador> = {}): Borrador => ({ efectivo: [], gastos: [], efectivo_contado: null, observaciones: null, ...p });

describe('normalizarBorrador — lo que se guarda de la rendición', () => {
    const clientes = [722, 815];

    it('guarda el efectivo por cliente, los gastos y el contado, en centavos', () => {
        const r = normalizarBorrador({
            efectivo: [{ cod_cliente: 722, importe: '412300.456' }, { cod_cliente: 815, importe: 0 }],
            gastos: [{ concepto: 'Ayudante', importe: 18000 }],
            efectivo_contado: '394000',
        }, clientes);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        // El cliente que no pagó (0) no es una línea: no hay recibo que emitir.
        expect(r.borrador.efectivo).toEqual([{ cod_cliente: 722, importe: 412_300.46 }]);
        expect(r.borrador.gastos).toEqual([{ concepto: 'Ayudante', importe: 18_000, detalle: null }]);
        expect(r.borrador.efectivo_contado).toBe(394_000);
    });

    it('🔴 un cliente que no está en la hoja no se acepta (el recibo saldría con otra hoja)', () => {
        const r = normalizarBorrador({ efectivo: [{ cod_cliente: 999, importe: 1000 }] }, clientes);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/999/);
    });

    it('el mismo cliente dos veces se rechaza: sería un recibo doble', () => {
        const r = normalizarBorrador({ efectivo: [{ cod_cliente: 722, importe: 1000 }, { cod_cliente: 722, importe: 2000 }] }, clientes);
        expect(r.ok).toBe(false);
    });

    it('importes negativos o que no son números se rechazan', () => {
        expect(normalizarBorrador({ efectivo: [{ cod_cliente: 722, importe: -5 }] }, clientes).ok).toBe(false);
        expect(normalizarBorrador({ efectivo: [{ cod_cliente: 722, importe: 'mucho' }] }, clientes).ok).toBe(false);
        expect(normalizarBorrador({ efectivo_contado: -1 }, clientes).ok).toBe(false);
    });

    it('gastos: concepto de la lista, importe mayor a 0, y "Otro" pide detalle', () => {
        expect(normalizarBorrador({ gastos: [{ concepto: 'Viático raro', importe: 100 }] }, clientes).ok).toBe(false);
        expect(normalizarBorrador({ gastos: [{ concepto: 'Combustible', importe: 0 }] }, clientes).ok).toBe(false);
        expect(normalizarBorrador({ gastos: [{ concepto: 'Otro', importe: 500 }] }, clientes).ok).toBe(false);
        const r = normalizarBorrador({ gastos: [{ concepto: 'Otro', importe: 500, detalle: ' gomería ' }] }, clientes);
        expect(r.ok && r.borrador.gastos[0].detalle).toBe('gomería');
    });

    it('contado vacío = todavía no se contó (no es cero)', () => {
        const r = normalizarBorrador({ efectivo_contado: '' }, clientes);
        expect(r.ok && r.borrador.efectivo_contado).toBe(null);
    });
});

describe('cuentasDeLaRendicion — la cuenta de la oficina', () => {
    it('🔑 debe entregar = efectivo − gastos; diferencia = contado − debe entregar', () => {
        const c = cuentasDeLaRendicion(borrador({
            efectivo: [{ cod_cliente: 722, importe: 412_300 }, { cod_cliente: 815, importe: 100_000 }],
            gastos: [{ concepto: 'Ayudante', importe: 18_000, detalle: null }],
            efectivo_contado: 494_000,
        }));
        expect(c).toEqual({ efectivo: 512_300, gastos: 18_000, debe_entregar: 494_300, contado: 494_000, diferencia: -300 });
    });

    it('sin contado no hay diferencia todavía', () => {
        expect(cuentasDeLaRendicion(borrador({ efectivo: [{ cod_cliente: 722, importe: 1000 }] })).diferencia).toBe(null);
    });
});

describe('planDeEmision — qué recibos emite la app y cuáles no', () => {
    const base = {
        hoja: HOJA,
        efectivo: [{ cod_cliente: 722, importe: 412_300 }],
        existentes: [] as ReciboDeLaHoja[],
        enIM: [] as ReciboIMLite[] | null,
        enApp: [] as ReciboAppLite[],
        pendientesDe: (_c: number) => [fa('FA2', '2026-10-05', 412_300), fa('FA1', '2026-09-20', 120_000)] as ReturnType<typeof fa>[] | null,
        cuentaCaja: CAJA,
        tope: 20,
    };

    it('🔑 un cobro en efectivo se imputa de la deuda más vieja a la más nueva', () => {
        const [p] = planDeEmision(base);
        expect(p.estado).toBe('listo');
        expect(p.comprobantes).toEqual([
            { id: 'FA1', importe_a_pagar: 120_000, etiqueta: 'FA FA1', fecha: '2026-09-20' },
            { id: 'FA2', importe_a_pagar: 292_300, etiqueta: 'FA FA2', fecha: '2026-10-05' },
        ]);
    });

    it('la vista previa nombra la factura como la ve Anto: tipo, punto de venta y número', () => {
        const [p] = planDeEmision({ ...base, pendientesDe: () => [{ id: '58123', tipo_comprobante: 'FA', punto_de_venta: 3, numero: 142847, fecha_factura: '2026-09-20', saldo: 500_000 }] });
        expect(p.comprobantes?.[0]).toMatchObject({ id: '58123', etiqueta: 'FA 3-142847', fecha: '2026-09-20' });
    });

    it('🔴 si Anto ya lo cargó a mano en IM (Caja Repartos, fecha de la hoja), NO se emite de nuevo', () => {
        const [p] = planDeEmision({ ...base, enIM: [reciboIM({ id_recibo: '58990777', importe: 412_300 })] });
        expect(p.estado).toBe('salteado');
        expect(p.motivo).toMatch(/a mano/i);
        expect(p.recibo_im).toBe('58990777');
    });

    it('🪤 también si lo cargó con OTRO importe: el cliente ya tiene su recibo de efectivo de ese reparto', () => {
        const [p] = planDeEmision({ ...base, enIM: [reciboIM({ importe: 400_000 })] });
        expect(p.estado).toBe('salteado');
    });

    it('un recibo a otra caja (una transferencia) no frena el efectivo... salvo que tenga el mismo importe', () => {
        const otraCaja = planDeEmision({ ...base, enIM: [reciboIM({ cuenta: '1120003', importe: 50_000 })] });
        expect(otraCaja[0].estado).toBe('listo');
        const mismoImporte = planDeEmision({ ...base, enIM: [reciboIM({ cuenta: '1120003', importe: 412_300 })] });
        expect(mismoImporte[0].estado).toBe('salteado');
        expect(mismoImporte[0].motivo).toMatch(/repetido/i);
    });

    describe('pagos parecidos (Mati, 06/10/2026: Seranil en la 3450 «es de otro día y de otra factura»)', () => {
        const reciboApp = (p: Partial<ReciboAppLite>): ReciboAppLite => ({
            id: 'app1', cod_cliente: 722, monto: 412_000, fecha_comprobante: HOJA.fecha, created_at: `${HOJA.fecha}T15:00:00Z`,
            status: 'imputado', infomanager_recibo_id: '58000001', factura_asociada: '#FA9·$412000.00', ...p,
        });

        it('🔑 un pago parecido de OTRO día no es el mismo pago: se emite', () => {
            const [p] = planDeEmision({ ...base, enApp: [reciboApp({ fecha_comprobante: '2026-09-29', created_at: '2026-09-29T15:00:00Z' })] });
            expect(p.estado).toBe('listo');
        });

        it('del MISMO día pero a OTRA factura, tampoco frena', () => {
            const [p] = planDeEmision({ ...base, enApp: [reciboApp({ factura_asociada: '#FA9·$412000.00' })] });
            expect(p.estado).toBe('listo');
        });

        it('🔴 del mismo día, por un importe parecido y a la MISMA factura, frena', () => {
            const [p] = planDeEmision({ ...base, enApp: [reciboApp({ factura_asociada: '#FA2·$412000.00' })] });
            expect(p.estado).toBe('salteado');
            expect(p.motivo).toMatch(/repetido/i);
        });

        it('🔴 del mismo día y sin saber a qué factura fue (todavía sin aprobar), frena: mejor revisarlo', () => {
            const [p] = planDeEmision({ ...base, enApp: [reciboApp({ status: 'pendiente_revision', infomanager_recibo_id: null, factura_asociada: null, monto: 412_300 })] });
            expect(p.estado).toBe('salteado');
        });

        it('🔑 «Emitir igual, lo revisé» (Mati, 06/10): con la marca, el posible repetido se emite y el paso dice quién lo revisó', () => {
            const revisado = { por: 'u-anto', nombre: 'Anto', at: '2026-10-06T16:00:00Z', importe: 412_300 };
            const [p] = planDeEmision({ ...base, efectivo: [{ cod_cliente: 722, importe: 412_300, revisado }], enApp: [reciboApp({ factura_asociada: '#FA2·$412000.00' })] });
            expect(p.estado).toBe('listo');
            expect(p.revisado).toEqual(revisado);
        });

        it('si después cambió el importe, la marca ya no vale', () => {
            const revisado = { por: 'u-anto', nombre: 'Anto', at: '2026-10-06T16:00:00Z', importe: 400_000 };
            const [p] = planDeEmision({ ...base, efectivo: [{ cod_cliente: 722, importe: 412_300, revisado }], enApp: [reciboApp({ factura_asociada: '#FA2·$412000.00' })] });
            expect(p.estado).toBe('salteado');
        });

        it('🔴 la marca NO saltea «ya cargado a mano en Caja Repartos»: eso sí es el mismo efectivo', () => {
            const revisado = { por: 'u-anto', nombre: 'Anto', at: '2026-10-06T16:00:00Z', importe: 412_300 };
            const [p] = planDeEmision({ ...base, efectivo: [{ cod_cliente: 722, importe: 412_300, revisado }], enIM: [reciboIM({ importe: 412_300 })] });
            expect(p.estado).toBe('salteado');
            expect(p.motivo).toMatch(/a mano/i);
        });

        it('un recibo de IM parecido de otro día (no de Caja Repartos) no frena', () => {
            const [p] = planDeEmision({ ...base, enIM: [reciboIM({ cuenta: '1120003', importe: 412_300, fecha: '2026-10-08' })] });
            expect(p.estado).toBe('listo');
        });
    });

    it('🔴 si IM no contestó, no se emite nada: no se puede descartar un duplicado', () => {
        const [p] = planDeEmision({ ...base, enIM: null });
        expect(p.estado).toBe('salteado');
    });

    it('si IM no devolvió las facturas pendientes del cliente, se saltea', () => {
        const [p] = planDeEmision({ ...base, pendientesDe: () => null });
        expect(p.estado).toBe('salteado');
    });

    it('paga más que toda su deuda: el resto es anticipo y la API no lo hace ⇒ a mano', () => {
        const [p] = planDeEmision({ ...base, efectivo: [{ cod_cliente: 722, importe: 900_000 }] });
        expect(p.estado).toBe('salteado');
        expect(p.motivo).toMatch(/anticipo/i);
    });

    it('🔑 el recibo que la app ya emitió figura como emitido y no se repite', () => {
        const existentes = [{ id: 'c1', cod_cliente: 722, monto: 412_300, status: 'imputado', infomanager_recibo_id: '58991000' }];
        // Su propio recibo en IM no cuenta como "cargado a mano".
        const [p] = planDeEmision({ ...base, existentes, enIM: [reciboIM({ id_recibo: '58991000' })] });
        expect(p.estado).toBe('emitido');
        expect(p.recibo_im).toBe('58991000');
    });

    it('🪤 emitido por un importe y después cambiaron el papel: no se emite otro, se corrige en IM', () => {
        const existentes = [{ id: 'c1', cod_cliente: 722, monto: 400_000, status: 'imputado', infomanager_recibo_id: '58991000' }];
        const [p] = planDeEmision({ ...base, existentes });
        expect(p.estado).toBe('salteado');
        expect(p.motivo).toMatch(/58991000/);
    });

    it('un intento que falló se vuelve a planear sobre el MISMO registro (no se crea otro)', () => {
        const existentes = [{ id: 'c1', cod_cliente: 722, monto: 412_300, status: 'error', infomanager_recibo_id: null, error_msg: 'IM rechazó' }];
        const [p] = planDeEmision({ ...base, existentes });
        expect(p.estado).toBe('listo');
        expect(p.recibo_app_id).toBe('c1');
    });

    it('tope del piloto: pasado el tope, el resto queda en espera', () => {
        const efectivo = [722, 815, 901].map((cod_cliente, i) => ({ cod_cliente, importe: 10_000 + i }));
        const r = planDeEmision({ ...base, efectivo, tope: 2 });
        expect(r.map(x => x.estado)).toEqual(['listo', 'listo', 'en_espera']);
    });
});

describe('saldosPorRepartidor — la diferencia se acumula en el mes (decisión 3)', () => {
    it('🔑 suma las diferencias contadas de cada repartidor y cuenta las que falta controlar', () => {
        const s = saldosPorRepartidor([
            { hoja_numero: 3449, fecha: '2026-10-05', chofer: 'VICTOR', diferencia: -300, controlada: true },
            { hoja_numero: 3452, fecha: '2026-10-06', chofer: 'VICTOR', diferencia: 1_000, controlada: false },
            { hoja_numero: 3450, fecha: '2026-10-05', chofer: 'NIÑO', diferencia: null, controlada: false },
        ]);
        expect(s).toEqual([
            { chofer: 'NIÑO', hojas: 1, contadas: 0, saldo: 0, sin_controlar: 0 },
            { chofer: 'VICTOR', hojas: 2, contadas: 2, saldo: 700, sin_controlar: 1 },
        ]);
    });
});

describe('resumenParaIM — lo que Anto copia en IM (la API no crea asientos ni órdenes de pago)', () => {
    it('🔑 un asiento por día con los números de hoja, la diferencia y una OP por gasto', () => {
        const r = resumenParaIM([
            { numero: 3449, contado: 494_000, diferencia: -300, gastos: [{ concepto: 'Ayudante', importe: 18_000, detalle: null }] },
            { numero: 3450, contado: 1_000_000, diferencia: 0, gastos: [{ concepto: 'Otro', importe: 2_500, detalle: 'gomería' }] },
        ]);
        expect(r.asiento).toEqual({ texto: '3449,3450-AS', importe: 1_494_000 });
        expect(r.diferencia).toEqual({ importe: -300 });
        expect(r.ops).toEqual([
            { hoja: 3449, texto: 'según HR 3449 - Ayudante', importe: 18_000 },
            { hoja: 3450, texto: 'según HR 3450 - gomería', importe: 2_500 },
        ]);
        expect(r.faltan_contar).toEqual([]);
    });

    it('si una hoja del día no se contó todavía, no hay asiento: falta ese dato', () => {
        const r = resumenParaIM([{ numero: 3449, contado: null, diferencia: null, gastos: [] }]);
        expect(r.asiento).toBe(null);
        expect(r.faltan_contar).toEqual([3449]);
    });
});

/**
 * Mati (06/10/2026, durante el piloto de la 3449): al rendir se tiene que poder ELEGIR a qué factura se
 * imputa cada recibo. La vista previa propone de la más vieja a la más nueva y se puede cambiar o
 * repartir; la suma tiene que dar lo cobrado (±$5) y la elección se guarda con la rendición.
 */
describe('residuos de centavos (hoja 3449, 06/10/2026)', () => {
    it('🔑 una factura vieja con saldo de $1 o menos no frena la rendición: se trata como saldada', () => {
        const [p] = planDeEmision({
            hoja: HOJA, efectivo: [{ cod_cliente: 836, importe: 240_212 }], existentes: [], enIM: [], enApp: [], cuentaCaja: CAJA, tope: 20,
            pendientesDe: () => [fa('RESIDUO', '2026-08-01', 0.92), fa('FA51183', '2026-10-05', 240_212.03)],
        });
        expect(p.estado).toBe('listo');
        expect(p.comprobantes?.map(c => [c.id, c.importe_a_pagar])).toEqual([['FA51183', 240_212]]);
        expect(p.pendientes?.map(f => f.id)).toEqual(['FA51183']);   // tampoco se ofrece para elegir
    });
});

describe('elegir la factura de cada recibo', () => {
    const plan = (efectivo: Array<{ cod_cliente: number; importe: number; facturas?: Array<{ id: string; importe: number }> }>, pendientes = [fa('FA2', '2026-10-05', 412_300), fa('FA1', '2026-09-20', 120_000)]) => planDeEmision({
        hoja: HOJA, efectivo, existentes: [], enIM: [], enApp: [], pendientesDe: () => pendientes, cuentaCaja: CAJA, tope: 20,
    });

    it('🔑 la elección se guarda con la línea, si suma lo cobrado (±$5)', () => {
        const r = normalizarBorrador({ efectivo: [{ cod_cliente: 722, importe: 412_300, facturas: [{ id: 'FA2', importe: 412_300 }] }] }, [722]);
        expect(r.ok && r.borrador.efectivo[0].facturas).toEqual([{ id: 'FA2', importe: 412_300 }]);
    });

    it('🔴 si la elección no suma lo cobrado, o repite una factura, no se guarda', () => {
        const noSuma = normalizarBorrador({ efectivo: [{ cod_cliente: 722, importe: 412_300, facturas: [{ id: 'FA2', importe: 400_000 }] }] }, [722]);
        expect(noSuma.ok).toBe(false);
        if (!noSuma.ok) expect(noSuma.error).toMatch(/722/);
        const repetida = normalizarBorrador({ efectivo: [{ cod_cliente: 722, importe: 412_300, facturas: [{ id: 'FA2', importe: 200_000 }, { id: 'FA2', importe: 212_300 }] }] }, [722]);
        expect(repetida.ok).toBe(false);
    });

    it('🔑 sin elección, la vista previa propone la más vieja y trae las pendientes para poder cambiar', () => {
        const [p] = plan([{ cod_cliente: 722, importe: 412_300 }]);
        expect(p.elegida).toBe(false);
        expect(p.pendientes?.map(f => [f.id, f.saldo])).toEqual([['FA1', 120_000], ['FA2', 412_300]]);
    });

    it('🔑 con elección, se imputa a lo elegido (aunque no sea la más vieja)', () => {
        const [p] = plan([{ cod_cliente: 722, importe: 412_300, facturas: [{ id: 'FA2', importe: 412_300 }] }]);
        expect(p.estado).toBe('listo');
        expect(p.elegida).toBe(true);
        expect(p.comprobantes?.map(c => [c.id, c.importe_a_pagar])).toEqual([['FA2', 412_300]]);
    });

    it('repartir entre varias facturas', () => {
        const [p] = plan([{ cod_cliente: 722, importe: 412_300, facturas: [{ id: 'FA2', importe: 312_300 }, { id: 'FA1', importe: 100_000 }] }]);
        expect(p.comprobantes?.map(c => [c.id, c.importe_a_pagar])).toEqual([['FA2', 312_300], ['FA1', 100_000]]);
    });

    it('🔴 si una factura elegida ya no está pendiente, o no le alcanza el saldo, ese cliente no se emite', () => {
        const [yaNo] = plan([{ cod_cliente: 722, importe: 412_300, facturas: [{ id: 'FA9', importe: 412_300 }] }]);
        expect(yaNo.estado).toBe('salteado');
        expect(yaNo.motivo).toMatch(/FA9/);
        const [noAlcanza] = plan([{ cod_cliente: 722, importe: 412_300, facturas: [{ id: 'FA1', importe: 412_300 }] }]);
        expect(noAlcanza.estado).toBe('salteado');
        expect(noAlcanza.pendientes?.length).toBe(2);   // igual se muestran, para elegir de nuevo
    });
});
