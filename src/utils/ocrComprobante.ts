/**
 * Monto, fecha y cuenta destino de un comprobante, a partir del texto que lee el OCR del celular
 * (Tesseract). Lógica PURA: se testea sola.
 *
 * S32 · mejora 8 (Mati, 05/10/2026): OCR gratis en el celular, activado si leía bien 9 de cada 10.
 * Prueba con 40 fotos reales: 38 con monto y fecha bien, 0 datos equivocados (20 de 20 en las fotos
 * de control, que no se usaron para ajustar). Cuando duda, deja el campo vacío: el vendedor lo tipea
 * como siempre.
 */

export type MedioDetectado = 'mercadopago' | 'recaudadora_1';
export interface DatosComprobante { monto: number | null; fecha: string | null; medio: MedioDetectado | null }

const MESES: Record<string, number> = {
    ene: 1, enero: 1, feb: 2, febrero: 2, mar: 3, marzo: 3, abr: 4, abril: 4, may: 5, mayo: 5, jun: 6, junio: 6,
    jul: 7, julio: 7, ago: 8, agosto: 8, sep: 9, sept: 9, set: 9, septiembre: 9, setiembre: 9,
    oct: 10, octubre: 10, nov: 11, noviembre: 11, dic: 12, diciembre: 12,
};
/** El OCR confunde la "o" con el cero: "0ctubre", "02/0CT/2026". */
const mesDe = (s: string) => MESES[s.toLowerCase().replace(/0/g, 'o').replace(/[^a-záéíóú]/g, '')] ?? null;

function valida(anio: number, mes: number, dia: number): string | null {
    const y = anio < 100 ? 2000 + anio : anio;
    if (y < 2020 || y > 2035 || mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
    const iso = `${y}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    return new Date(`${iso}T12:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null;
}

/** La primera fecha válida del texto, en el orden de lectura (la del comprobante va arriba). */
export function leerFecha(texto: string): string | null {
    const c: Array<{ i: number; iso: string | null }> = [];
    for (const m of texto.matchAll(/\b(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{4}|\d{2})(?!\d)/g)) c.push({ i: m.index ?? 0, iso: valida(+m[3], +m[2], +m[1]) });
    for (const m of texto.matchAll(/\b(\d{1,2})\s*(?:[/.-]|\s+de\s+|\s+)([A-Za-z0áéíóú]{3,10})\.?\s*(?:[/.-]|\s+de\s+|\s+|,\s*)(\d{4})(?!\d)/g)) {
        const mes = mesDe(m[2]);
        if (mes) c.push({ i: m.index ?? 0, iso: valida(+m[3], mes, +m[1]) });
    }
    for (const m of texto.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) c.push({ i: m.index ?? 0, iso: valida(+m[1], +m[2], +m[3]) });
    return c.filter(x => x.iso).sort((a, b) => a.i - b.i)[0]?.iso ?? null;
}

/**
 * 🪤 Una fecha imposible es un error de lectura ("02/OCT" leído "02/07"): entre 45 días antes de la
 * carga y el día siguiente (la hora del celular puede estar corrida). Fuera de eso, vacía.
 */
export function fechaPosible(iso: string | null, hoyISO: string): string | null {
    if (!iso) return null;
    const dias = (Date.parse(`${iso}T12:00:00Z`) - Date.parse(`${hoyISO.slice(0, 10)}T12:00:00Z`)) / 86_400_000;
    return dias >= -45 && dias <= 1 ? iso : null;
}

/** "596.861", "418.769,30", "114116.00", "1,234.50". */
function aNumero(s: string): number | null {
    const v = s.replace(/\s+/g, '');
    let m: RegExpMatchArray | null;
    if ((m = v.match(/^(\d{1,3}(?:\.\d{3})+)(?:,(\d{1,2}))?$/))) return Number(`${m[1].replace(/\./g, '')}.${m[2] ?? 0}`);
    if ((m = v.match(/^(\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/))) return Number(`${m[1].replace(/,/g, '')}.${m[2] ?? 0}`);
    if ((m = v.match(/^(\d+)(?:[.,](\d{2}))?$/))) return Number(`${m[1]}.${m[2] ?? 0}`);
    return null;
}

/**
 * El importe con signo pesos. El OCR lee "$" como "s", "S" o "§"; AstroPay escribe "ARS".
 *  · Gana el que sigue a "Monto", "Importe" o "Enviaste" (en el renglón o en los dos de arriba).
 *  · 🪤 "CC ARS 8165" o "$...1385" son números de cuenta, no el monto.
 *  · Menos de $100 no es un pago de acá: es basura de la lectura ("| S 5").
 *  · Empate: el primero en la lectura (el monto va arriba).
 */
export function leerMonto(texto: string): number | null {
    const lineas = texto.split(/\r?\n/);
    const importe = /(?:\$|\bARS\b|(?<![A-Za-z])[sS§](?=\s*\d))\s*(\d{1,3}(?:[.,]\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{2})?)(?![\d.,])/g;
    const rotulo = /\b(monto|importe|total|enviaste|transferiste|pagaste|recibiste)\b/i;
    const cuenta = /\b(cc|ca|cta|cuenta|cbu|cvu|alias)\b|\.\.\./i;
    let mejor: { n: number; puntos: number } | null = null;
    for (let i = 0; i < lineas.length; i++) {
        const l = lineas[i];
        for (const m of l.matchAll(importe)) {
            const n = aNumero(m[1]);
            if (n == null || n < 100 || n >= 1e9) continue;
            const antes = l.slice(0, m.index ?? 0);
            if (cuenta.test(antes)) continue;
            let puntos = 0;
            if (rotulo.test(antes) || rotulo.test(lineas[i - 1] ?? '') || rotulo.test(lineas[i - 2] ?? '')) puntos += 2;
            if (/[.,]/.test(m[1])) puntos += 1;   // con separadores: tiene forma de plata
            if (!mejor || puntos > mejor.puntos) mejor = { n, puntos };
        }
    }
    return mejor ? Math.round(mejor.n * 100) / 100 : null;
}

/**
 * Las cuentas de Semillero que se reconocen en una foto (las imprime cada comprobante). Ojo: la
 * Recaudadora 1 es una cuenta de MercadoPago a nombre de una persona; entre mayo y octubre de 2026,
 * 26 pagos que fueron ahí se cargaron como "MercadoPago" (la cuenta principal).
 */
const CUENTAS: Array<{ cvu: string; medio: MedioDetectado }> = [
    { cvu: '0000003100040304751385', medio: 'mercadopago' },
    { cvu: '0000003100099266226170', medio: 'recaudadora_1' },
];

/** A qué cuenta de Semillero fue la transferencia. Con ninguna, o con las dos, no se afirma nada. */
export function cuentaDestino(texto: string): MedioDetectado | null {
    // Sólo los dígitos: el OCR a veces parte la CVU en dos renglones.
    const digitos = texto.replace(/\D/g, '');
    const vistas = CUENTAS.filter(c => digitos.includes(c.cvu));
    return vistas.length === 1 ? vistas[0].medio : null;
}

export function datosDelTexto(texto: string, hoyISO: string): DatosComprobante {
    return { monto: leerMonto(texto), fecha: fechaPosible(leerFecha(texto), hoyISO), medio: cuentaDestino(texto) };
}

/** La segunda lectura sólo completa lo que le faltó a la primera. */
export function combinar(a: DatosComprobante, b: DatosComprobante): DatosComprobante {
    return { monto: a.monto ?? b.monto, fecha: a.fecha ?? b.fecha, medio: a.medio ?? b.medio };
}
