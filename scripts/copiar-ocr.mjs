/**
 * Copia a `dist/ocr` el motor de OCR (Tesseract) y el modelo de español, para que el celular los baje
 * de la propia app y no de un CDN (ver src/utils/ocrNavegador.ts). Corre después de `vite build`.
 *
 * Cada celular baja UNA variante del motor (la que soporta su navegador), el lector y el modelo:
 * unos 6 MB la primera vez.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const destino = path.resolve('dist/ocr');
const archivos = [
  ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'],
  // El mismo modelo con el que se midió la precisión (38 de 40, 05/10/2026).
  ['node_modules/@tesseract.js-data/spa/4.0.0_best_int/spa.traineddata.gz', 'spa.traineddata.gz'],
];

await mkdir(destino, { recursive: true });
for (const [origen, nombre] of archivos) await copyFile(path.resolve(origen), path.join(destino, nombre));
console.log(`OCR: ${archivos.length} archivos copiados a dist/ocr`);
