import { describe, it, expect } from 'vitest';
import { recibosQueFaltanEnIM, type ImputadoApp } from './controlReciboIM.js';

/**
 * S32 · mejora 7 (04/10/2026). En septiembre, 3 recibos que emitió la app ya no estaban en IM: los
 * borraron allá y dos se volvieron a cargar a mano. La app los seguía mostrando como imputados.
 */
const ap = (p: Partial<ImputadoApp>): ImputadoApp => ({
    id: 'a', cod_cliente: 722, monto: 150_000, fecha_comprobante: '2026-09-17', infomanager_recibo_id: '58884698',
    imputado_at: '2026-09-17T17:04:03Z', cod_empresa: 1, ...p,
});
const enIM = (ids: string[]) => ids.map(id => ({ id_recibo: Number(id), fecha: '2026-09-17', cliente: { codigo: '722' }, importe_total: 150_000 }));
const ahora = Date.parse('2026-10-04T12:00:00Z');

describe('recibosQueFaltanEnIM', () => {
    it('🔑 el recibo que la app imputó y IM ya no lista aparece', () => {
        const r = recibosQueFaltanEnIM([ap({ id: 'a' }), ap({ id: 'b', infomanager_recibo_id: '58891124' })], enIM(['58891124']), ahora);
        expect(r.map(x => x.id)).toEqual(['a']);
    });

    it('los que están en IM no se avisan', () => {
        expect(recibosQueFaltanEnIM([ap({})], enIM(['58884698']), ahora)).toEqual([]);
    });

    it('lo recién imputado (menos de 10 min) no se juzga todavía', () => {
        expect(recibosQueFaltanEnIM([ap({ imputado_at: '2026-10-04T11:55:00Z' })], [], ahora)).toEqual([]);
    });

    it('sin número de IM (anticipo cargado a mano) no hay qué buscar', () => {
        expect(recibosQueFaltanEnIM([ap({ infomanager_recibo_id: null })], [], ahora)).toEqual([]);
    });
});
