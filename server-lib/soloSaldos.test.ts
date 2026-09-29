import { describe, it, expect } from 'vitest';
import { rutaPermitidaSoloSaldos, esSoloSaldos, type ConsultaModulos } from './soloSaldos.js';

/**
 * "Saldos de clientes" (29/09/2026): la tablet compartida de Casa Central tiene que ver la DEUDA
 * de los clientes y nada más. Mati: *"a lo sumo que se vea solo la deuda de los clientes"*.
 */

describe('rutaPermitidaSoloSaldos — lista BLANCA de lo que ve alguien de sólo saldos', () => {
    it('deja pasar lo justo para ver la deuda', () => {
        expect(rutaPermitidaSoloSaldos('GET', '/api/me')).toBe(true);
        expect(rutaPermitidaSoloSaldos('GET', '/api/data')).toBe(true);
        expect(rutaPermitidaSoloSaldos('GET', '/api/data?nocache=1')).toBe(true);
        expect(rutaPermitidaSoloSaldos('POST', '/api/telemetria/vista')).toBe(true);
    });

    // 🔴 Lo que motivó todo: objetivos, comisiones y ranking del equipo en una tablet a mano de cualquiera.
    it('frena objetivos, comisiones, rebotes, actividad y notificaciones', () => {
        for (const p of ['/api/goals', '/api/goals/snapshot', '/api/product-goals', '/api/comisiones',
            '/api/comisiones/sucursal', '/api/rebotes', '/api/activity', '/api/notificaciones',
            '/api/cartera', '/api/cartera/clientes', '/api/reportes/ventas']) {
            expect(rutaPermitidaSoloSaldos('GET', p), p).toBe(false);
        }
    });

    it('frena toda escritura, aunque la ruta de lectura esté permitida', () => {
        expect(rutaPermitidaSoloSaldos('POST', '/api/data')).toBe(false);
        expect(rutaPermitidaSoloSaldos('POST', '/api/pedidos')).toBe(false);
        expect(rutaPermitidaSoloSaldos('POST', '/api/recibos/upload')).toBe(false);
        expect(rutaPermitidaSoloSaldos('POST', '/api/usuarios/change-password')).toBe(false);
        expect(rutaPermitidaSoloSaldos('POST', '/api/articulos/refrescar')).toBe(false);
    });

    // 🪤 Que un prefijo no se cuele por parecido: /api/database no es /api/data.
    it('compara la ruta entera, no el prefijo', () => {
        expect(rutaPermitidaSoloSaldos('GET', '/api/data-extra')).toBe(false);
        expect(rutaPermitidaSoloSaldos('GET', '/api/me/otra')).toBe(false);
        expect(rutaPermitidaSoloSaldos('GET', '/api/clientes/lookup')).toBe(false);
    });
});

describe('esSoloSaldos — misma regla que el panel: la excepción por persona manda sobre el rol', () => {
    const base = (propio: boolean | null, porRol: boolean, error = false): ConsultaModulos => ({
        propio: async () => (error ? { error: true } : { error: false, habilitado: propio }),
        porRol: async () => ({ error: false, tiene: porRol }),
    });

    it('con el módulo habilitado a mano → sólo saldos', async () => {
        expect(await esSoloSaldos({ sub: 'tablet', rol: 'administrativo' }, base(true, false))).toBe(true);
    });

    it('con la excepción en false gana la excepción, aunque el rol lo tenga', async () => {
        expect(await esSoloSaldos({ sub: 'x', rol: 'administrativo' }, base(false, true))).toBe(false);
    });

    it('sin excepción decide el rol (hoy ningún rol lo trae: nadie cambia)', async () => {
        expect(await esSoloSaldos({ sub: 'x', rol: 'vendedor' }, base(null, false))).toBe(false);
        expect(await esSoloSaldos({ sub: 'x', rol: 'vendedor' }, base(null, true))).toBe(true);
    });

    it('si la base no contesta devuelve null (el que llama decide), no un false que abra la puerta', async () => {
        expect(await esSoloSaldos({ sub: 'x', rol: 'administrativo' }, base(null, false, true))).toBe(null);
    });

    it('sin usuario no es sólo saldos (esa puerta la cierra el login, no esto)', async () => {
        expect(await esSoloSaldos(undefined, base(true, true))).toBe(false);
    });
});
