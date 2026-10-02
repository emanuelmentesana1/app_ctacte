import { describe, it, expect, vi } from 'vitest';
import { deudoresDeCobranza, deVendedores, armarAvisoDeuda, formatearAvisoDeuda, publicarEnSlack, fechaCorta } from './avisoDeuda.js';

/**
 * El aviso de deuda tiene que dar el MISMO número que la pestaña Cobranza (VendorShell.tsx,
 * `clientsAggAll`). Cada caso de abajo es una regla de esa cuenta que es fácil romper.
 */

const comp = (cod: string, saldo: number, dias: number, vend = 'PEREZ Juan', codVend = 4, nombre = `CLIENTE ${cod}`) => ({
    COD_CLIENT: cod,
    CLIENTES_N: nombre,
    COD_VENDED: codVend,
    VENDEDORES: vend,
    SALDO: saldo,
    DIAS_EMISI: dias,
});

const comprobantes = [
    comp('338', 55002, 34, 'PEREZ Juan', 4, 'GONZALES Carolina'), // 34 días
    comp('100', 500000, 15), // justo 15: entra (≥ 15) aunque el chip "+15d" no lo cuente
    comp('101', 300000, 14), // 14: no entra
    comp('102', 800000, 40), // 40 días, pero un recibo lo deja en $1.500 neto: no es deudor
    comp('102', -798500, 2),
    comp('103', 1500, 60), // saldo chico: no cuenta para nada...
    comp('103', 90000, 5), // ...así que el cliente queda con 5 días, no con 60
    comp('104', 200000, 20, 'LOPEZ Ana', 2), // 20 días...
    comp('104', -50000, 45, 'LOPEZ Ana', 2), // ...una NC vieja resta pero NO mueve los días
    comp('104', 100000, 3, 'LOPEZ Ana', 2),
    comp('', 999999, 99), // sin cliente: se ignora
    comp('900', 700000, 90, 'VIEJO Inactivo', 9), // vendedor inactivo: no está en "Todos"
];

const DATOS = { invoices: comprobantes, clientDbMap: { '338': { Localidad: 'BRS' } }, source: 'infomanager' as const };
const ACTIVOS = new Set(['4', '2']);

describe('deudoresDeCobranza (la cuenta de la pestaña Cobranza)', () => {
    const todos = deudoresDeCobranza(deVendedores(comprobantes, ACTIVOS), { '338': { Localidad: 'BRS' } });
    const de = (cod: string) => todos.find((c) => c.cod === cod);

    it('un cliente con saldo neto de $2.000 o menos no es deudor', () => {
        expect(de('102')).toBeUndefined();
    });
    it('un comprobante de $1.500 no mueve los días del cliente', () => {
        expect(de('103')?.dias).toBe(5);
    });
    it('una NC vieja resta del saldo pero no mueve los días', () => {
        expect(de('104')).toMatchObject({ dias: 20, saldo: 250000, comprobantes: 3, vendedor: 'LOPEZ Ana' });
    });
    it('deja afuera los comprobantes sin cliente y los de vendedores inactivos', () => {
        expect(todos.map((c) => c.cod).sort()).toEqual(['100', '101', '103', '104', '338']);
    });
    it('ordena del más atrasado al más reciente, con la localidad', () => {
        expect(todos[0]).toMatchObject({ cod: '338', localidad: 'BRS' });
        expect(todos[todos.length - 1].cod).toBe('103');
    });
});

describe('armarAvisoDeuda', () => {
    const armar = (datos: any = DATOS) => armarAvisoDeuda({
        datos: async () => datos,
        codsActivos: async () => ACTIVOS,
        hoy: '2026-10-02',
        minimo: 15,
    });

    it('15 o más incluye los de 15 justos y deja afuera los de 14', async () => {
        const r = await armar();
        expect(r.atrasados.map((c) => c.cod)).toEqual(['338', '104', '100']);
        expect(r.totalDeudores).toBe(5);
    });

    it('con datos de Sheets o degradados NO publica la lista', async () => {
        const r = await armar({ ...DATOS, degraded: 'InfoManager no respondió' });
        expect(r.atrasados).toEqual([]);
        expect(formatearAvisoDeuda(r)).toMatch(/Hoy no publico la lista/);
        const r2 = await armar({ ...DATOS, source: 'sheets' });
        expect(r2.noConfiable).toBe('fuente sheets');
    });

    it('avisa si los saldos vienen de un cache vencido', async () => {
        const r = await armar({ ...DATOS, stale: true, staleMin: 25 });
        expect(formatearAvisoDeuda(r)).toMatch(/hace 25 min/);
    });

    it('sin vendedores activos falla en vez de mandar una lista vacía', async () => {
        await expect(armarAvisoDeuda({ datos: async () => DATOS, codsActivos: async () => new Set(), hoy: '2026-10-02', minimo: 15 }))
            .rejects.toThrow(/vendedores activos/);
    });
});

describe('formatearAvisoDeuda', () => {
    it('título, resumen, agrupado por vendedor y renglón por cliente', async () => {
        const r = await armarAvisoDeuda({ datos: async () => DATOS, codsActivos: async () => ACTIVOS, hoy: '2026-10-02', minimo: 15 });
        const texto = formatearAvisoDeuda(r);
        expect(texto).toMatch(/^\*Deuda de 15 días o más · vie 02\/10\*/);
        expect(texto).toMatch(/\*3 clientes\* · \$ 805\.002 · de 5 con saldo para cobrar/);
        expect(texto).toMatch(/_PEREZ Juan_ · 2 · \$ 555\.002/);
        expect(texto).toMatch(/_LOPEZ Ana_ · 1 · \$ 250\.000/);
        expect(texto).toMatch(/- \*34 d\* GONZALES Carolina \(338 · BRS\) · \$ 55\.002 · 1 comprob\./);
    });

    it('sin atrasados lo dice', () => {
        expect(formatearAvisoDeuda({ fecha: '2026-10-02', minimo: 15, totalDeudores: 7, atrasados: [] }))
            .toMatch(/Ningún cliente con 15 días o más \(de 7 con saldo para cobrar\)/);
    });

    it('fecha corta en castellano', () => {
        expect(fechaCorta('2026-10-05')).toBe('lun 05/10');
    });
});

describe('publicarEnSlack', () => {
    it('manda el texto por POST al webhook', async () => {
        const f = vi.fn(async () => new Response('ok', { status: 200 }));
        await publicarEnSlack('https://hooks.slack.test/x', 'hola', f as unknown as typeof fetch);
        const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://hooks.slack.test/x');
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({ text: 'hola' });
    });

    it('si Slack rechaza, falla con el motivo', async () => {
        const f = vi.fn(async () => new Response('channel_not_found', { status: 404 }));
        await expect(publicarEnSlack('https://hooks.slack.test/x', 'hola', f as unknown as typeof fetch)).rejects.toThrow(/404: channel_not_found/);
    });
});
