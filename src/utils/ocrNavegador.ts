/**
 * El OCR corre EN EL CELULAR (Tesseract): la foto no sale del teléfono para leerse y no hay costo
 * por uso. Lo eligió Mati el 05/10/2026 (opción 1), activado porque la prueba leyó bien 38 de 40.
 *
 * El motor y el modelo de español se sirven desde la propia app (`/ocr`, los copia
 * `scripts/copiar-ocr.mjs` al compilar): no dependen de un CDN. Se bajan recién cuando alguien elige
 * una foto (unos 6 MB la primera vez) y el celular los guarda para la próxima.
 */
import type { Worker } from 'tesseract.js';
import { datosDelTexto, combinar, type DatosComprobante } from './ocrComprobante';

/** Las fotos de cámara (12 MP) se achican: medido, igual de preciso y varias veces más rápido. */
const LADO_MAXIMO = 2000;
/** Si tarda más que esto, se sigue sin OCR: el vendedor tipea como siempre. */
const TIEMPO_MAXIMO_MS = 45_000;

type Tesseract = typeof import('tesseract.js');
let motor: Promise<{ T: Tesseract; lector: Worker }> | null = null;

function obtenerMotor() {
    motor ??= import('tesseract.js').then(async T => ({
        T,
        lector: await T.createWorker('spa', T.OEM.LSTM_ONLY, {
            workerPath: '/ocr/worker.min.js', corePath: '/ocr', langPath: '/ocr', workerBlobURL: false,
        }),
    }));
    // Si falló (sin conexión, por ejemplo), se reintenta con la próxima foto.
    motor.catch(() => { motor = null; });
    return motor;
}

async function achicar(foto: Blob): Promise<Blob | HTMLCanvasElement> {
    const img = await createImageBitmap(foto);   // respeta la orientación de la foto
    const escala = Math.min(1, LADO_MAXIMO / Math.max(img.width, img.height));
    if (escala === 1) { img.close(); return foto; }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * escala);
    canvas.height = Math.round(img.height * escala);
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
    img.close();
    return canvas;
}

/** Monto, fecha y cuenta destino de la foto. null si no se pudo leer (no es imagen, falló el motor, tardó). */
export async function leerComprobante(foto: File, hoyISO: string): Promise<DatosComprobante | null> {
    if (!foto.type.startsWith('image/')) return null;
    const leer = async () => {
        const { T, lector } = await obtenerMotor();
        const imagen = await achicar(foto);
        // Modo 4 (una columna de tamaños variables): lee el monto grande de MercadoPago, que el modo de
        // fábrica (6) saltea. Si falta algo, una segunda lectura en modo 6 completa.
        await lector.setParameters({ tessedit_pageseg_mode: T.PSM.SINGLE_COLUMN });
        let datos = datosDelTexto((await lector.recognize(imagen)).data.text, hoyISO);
        if (datos.monto == null || datos.fecha == null) {
            await lector.setParameters({ tessedit_pageseg_mode: T.PSM.SINGLE_BLOCK });
            datos = combinar(datos, datosDelTexto((await lector.recognize(imagen)).data.text, hoyISO));
        }
        return datos;
    };
    try {
        return await Promise.race([leer(), new Promise<null>(r => setTimeout(() => r(null), TIEMPO_MAXIMO_MS))]);
    } catch {
        return null;
    }
}
