import { describe, it, expect } from 'vitest';
import { leerMonto, leerFecha, fechaPosible, cuentaDestino, datosDelTexto, combinar } from './ocrComprobante';

/**
 * Lo que el OCR del celular (Tesseract) lee de un comprobante. Los textos son lecturas reales de la
 * prueba del 05/10/2026 (40 fotos: 38 bien, 0 datos equivocados), ANONIMIZADOS: sin nombres, CUIT
 * ni cuentas de personas. Los errores de lectura se dejaron como salieron ("0ctubre", "s 152.750").
 */

const HOY = '2026-10-02';

describe('leerMonto', () => {
    it('MercadoPago: el importe grande debajo de la fecha', () => {
        expect(leerMonto('Comprobante de transferencia\n2/0ctubre/2026 a las 19:57\n$ 9.500\nMotivo: Varios')).toBe(9_500);
    });

    it('el OCR lee "$" como "s" (Naranja X)', () => {
        expect(leerMonto('Comprobante de transferencia\nEnviaste\ns 152.750\n02/0CT/2026-16:59h')).toBe(152_750);
    });

    it('🪤 "CC $N* 1221-2 374-1" es la cuenta de origen, no el monto (Galicia)', () => {
        expect(leerMonto('Transferencia enviada\n$300.000\n02/10/2026 : 22:37 h\nDe:\nNOMBRE APELLIDO\nCC $N* 1221-2 374-1')).toBe(300_000);
    });

    it('🪤 "CC ARS 8165" son los últimos dígitos de una cuenta; gana el importe rotulado "Monto" (Macro)', () => {
        const t = 'Desde\nNOMBRE APELLIDO\nCuenta\nBanco Macro - Banco Macro - CC ARS 8165\nMonto\n$ 596.861\nConcepto\nVarios\nFecha y hora\n01/10/2026 - 15:23 h';
        expect(leerMonto(t)).toBe(596_861);
    });

    it('con centavos y "Importe debitado" (Santander); "CTA $ 069-075045/5" no es un monto', () => {
        expect(leerMonto('Comprobante de Transferencia\nImporte debitado $ 418.769,30\nCuenta débito CTA $ 069-075045/5')).toBe(418_769.3);
    });

    it('AstroPay escribe "ARS" y punto decimal', () => {
        expect(leerMonto('Comprobante de Transferencia\n02/10/26 - 09:18 hs\nARS 114116.00')).toBe(114_116);
    });

    it('lo ilegible queda vacío: mejor vacío que mal', () => {
        expect(leerMonto('a: e $ RS - Ñ\n| S 5')).toBe(null);        // menos de $100: basura
        expect(leerMonto('2/0ctubre/2026 a las 12:41.\n$ 199.1839%')).toBe(null);   // dígito pegado: no se adivina
        expect(leerMonto('Comprobante de transferencia\nMotivo: Varios')).toBe(null);
    });
});

describe('leerFecha y fechaPosible', () => {
    it('lee las formas de los bancos y billeteras, aunque el OCR cambie la "o" por un cero', () => {
        expect(leerFecha('2/0ctubre/2026 alas 15:33.')).toBe('2026-10-02');
        expect(leerFecha('02/0CT/2026-16:59h')).toBe('2026-10-02');
        expect(leerFecha('25/SEP/2026-11:41 h')).toBe('2026-09-25');
        expect(leerFecha('02/10/2026 : 22:37 h')).toBe('2026-10-02');
        expect(leerFecha('02/10/26 - 09:18 hs')).toBe('2026-10-02');
        expect(leerFecha('Jueves, 11 de junio de 2026 a las 11:31 hs')).toBe('2026-06-11');
        expect(leerFecha('30/septiembre/2026 a las 20:04.')).toBe('2026-09-30');
        expect(leerFecha('5 de setiembre de 2026')).toBe('2026-09-05');
    });

    it('una fecha que no existe no se acepta', () => {
        expect(leerFecha('31/02/2026')).toBe(null);
    });

    it('🪤 una fecha imposible es un error del OCR ("02/OCT" leído "02/07"): queda vacía', () => {
        expect(fechaPosible('2026-07-02', HOY)).toBe(null);           // tres meses antes de la carga
        expect(fechaPosible('2026-10-04', HOY)).toBe(null);           // en el futuro
        expect(fechaPosible('2026-09-25', HOY)).toBe('2026-09-25');   // una semana antes: normal
        expect(fechaPosible('2026-10-03', HOY)).toBe('2026-10-03');   // mañana: la hora del celular puede estar corrida
    });
});

describe('cuentaDestino — a qué cuenta de Semillero fue la transferencia', () => {
    it('la CVU de la cuenta principal de MercadoPago', () => {
        expect(cuentaDestino('Semillero El Manantial SRL\nMercado Pago\nCVU: 0000003100040304751385')).toBe('mercadopago');
    });

    it('🔑 la CVU de la Cuenta Recaudadora 1, aunque el OCR la parta en dos renglones', () => {
        expect(cuentaDestino('Cuenta destino 000000310009926622617\n0\nTitular cuenta destino')).toBe('recaudadora_1');
    });

    it('sin una cuenta conocida, o con las dos, no se afirma nada', () => {
        expect(cuentaDestino('CVU: 0000003100000000000001')).toBe(null);
        expect(cuentaDestino('0000003100040304751385\n0000003100099266226170')).toBe(null);
    });
});

describe('datosDelTexto y combinar', () => {
    it('junta monto, fecha posible y cuenta de una lectura', () => {
        const t = 'mercado\npago\nComprobante de transferencia\n1/octubre/2026 a las 22:52.\n$ 337.651\nMotivo: Varios\nCVU: 0000003100040304751385';
        expect(datosDelTexto(t, HOY)).toEqual({ monto: 337_651, fecha: '2026-10-01', medio: 'mercadopago' });
    });

    it('la segunda lectura sólo completa lo que le faltó a la primera', () => {
        const primera = { monto: null, fecha: '2026-10-02', medio: null };
        const segunda = { monto: 199_183, fecha: '2026-09-01', medio: 'mercadopago' as const };
        expect(combinar(primera, segunda)).toEqual({ monto: 199_183, fecha: '2026-10-02', medio: 'mercadopago' });
    });
});
