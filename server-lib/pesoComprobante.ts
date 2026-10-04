/**
 * Cuánto pesa un pedido: bultos y kilos.
 *
 * 🔑 **Define en qué camión entra la mercadería.** La flota es 1×5.000 kg, 2×7.000 kg y
 * 1×12.000 kg (Mati, 07/09/2026): si el número está mal, se arma una hoja de ruta que no
 * entra en el camión y eso se descubre en el galpón, cargando.
 *
 * Es lo que la hoja de ruta de InfoManager muestra como `Cantidad` y `Cantidad UME`. La
 * fórmula se dedujo de la hoja real nº 3394 y se verificó contra cinco remitos de ese día.
 * Los BULTOS dan exactos en los cinco. Los KILOS dan exactos en tres, y en los otros dos
 * difieren en 0,02 y 0,04 kg.
 *
 * 📌 De dónde sale esa diferencia: del artículo 661 (PASTA DE MANI, 485 g × 12 = 5,82 kg).
 * Nosotros usamos 5,82 —lo que dice el catálogo— y en la hoja de IM ese renglón entra como
 * 5,80, así que IM parece recortar la equivalencia a UN decimal. Se deja el valor exacto a
 * propósito: es el peso real y la diferencia es del 0,3% de UN artículo, irrelevante para
 * decidir un camión. Queda anotado por si alguna vez alguien compara los dos números y se
 * pregunta por los centavos. (Hipótesis con dos casos, no verificada del todo: haría falta un
 * artículo con equivalencia tipo 5,86 para saber si IM trunca o redondea.)
 */

export interface RenglonPesable {
  cantidad: number | string | null | undefined;
  /** Kilos por bulto, del catálogo de IM. Una bolsa de 25 kg trae 25; el granel trae 1. */
  equivalencia_um: number | null | undefined;
  /** No lleva peso por decisión (ver `sinPesoAProposito`): sin equivalencia pesa 0 kg y no es "sin verificar". */
  sin_peso_a_proposito?: boolean;
}

/**
 * SIN PESO A PROPÓSITO (Mati, 03/10/2026): *"los accesorios y los venenos (raticidas, cebos, etc.) NO
 * llevan peso, y está bien que queden en 0"*. La hoja 3448 salía "sin verificar" por macetas, ganchos,
 * un raticida y orejas: renglones que nunca van a tener peso.
 *  - Todo el rubro 11 "Accesorios y Venenos" de IM, incluidos los artículos que se den de alta después.
 *  - Y cuatro códigos de otros rubros, también por decisión de Mati: FORRAJES VARIOS, las BOLSAS vacías
 *    de empaque de 1 y 10 kg, y NUEZ PELADA LIGHT.
 * 🔑 Sólo vale con la equivalencia en 0: si en IM se le carga un peso, manda el peso.
 */
const RUBRO_SIN_PESO = 11;
const CODIGOS_SIN_PESO = new Set([13818, 2100, 2102, 617]);
export function sinPesoAProposito(cod: unknown, art: { cod_rubro?: number | null } | null | undefined): boolean {
  // Sin el artículo en el catálogo no se sabe qué es: no se asume nada.
  if (!art) return false;
  return Number(art.cod_rubro) === RUBRO_SIN_PESO || CODIGOS_SIN_PESO.has(Number(cod));
}

export interface Peso {
  /** Cuántos paquetes viajan. Es lo que se cuenta al cargar el camión. */
  bultos: number;
  /** Cuánto pesan. Lo que se compara contra la capacidad del camión. */
  kg: number;
  /**
   * Renglones que no se pudieron pesar (cantidad ilegible o sin equivalencia en el catálogo). Se informa porque
   * si son muchos, `kg` MIENTE POR ABAJO y la hoja puede sobrecargar el camión sin avisar.
   */
  renglones_sin_peso: number;
}

/** Dos decimales. 4,2 × 3 en punto flotante da 12,600000000000001 y eso no es un peso. */
const dos = (n: number) => Math.round(n * 100) / 100;

export function pesoDeRenglones(renglones: RenglonPesable[]): Peso {
  let bultos = 0;
  let kg = 0;
  let sinPeso = 0;
  for (const r of renglones ?? []) {
    const dato = r?.cantidad;
    const cant = Number(dato);
    // Number(null), Number('') y Number(false) dan cero: no acreditan un peso conocido.
    if ((typeof dato !== 'number' && typeof dato !== 'string') ||
        (typeof dato === 'string' && !dato.trim()) || !Number.isFinite(cant) || cant < 0 ||
        !Number.isFinite((bultos + cant) * 100)) { sinPeso += 1; continue; }
    if (cant === 0) continue; // Cero explícito: no viaja mercadería en este renglón.
    bultos += cant;
    const eq = Number(r?.equivalencia_um);
    // 🪤 Un artículo sin equivalencia cargada pesa CERO, no uno. Verificado contra IM: con el
    // fallback de 1 kg por unidad, el remito 77147 daba 564,64 en vez de 492,60. El bulto sí
    // cuenta —el paquete viaja igual— pero los kilos no se inventan.
    const conPeso = Number.isFinite(eq) && eq > 0;
    if (conPeso && Number.isFinite((kg + cant * eq) * 100)) kg += cant * eq;
    // Un accesorio o un veneno sin equivalencia pesa 0 kg a sabiendas: no deja la hoja "sin verificar".
    else if (conPeso || !r?.sin_peso_a_proposito) sinPeso += 1;
  }
  return { bultos: dos(bultos), kg: dos(kg), renglones_sin_peso: sinPeso };
}

/**
 * ¿Entra en el camión? Devuelve el porcentaje ocupado para poder pintarlo antes de que se
 * pase, no después.
 */
export function cargaDelCamion(kgTotal: number, capacidadKg: number | null | undefined): {
  porcentaje: number | null; excedido: boolean; sobra_kg: number | null;
} {
  const cap = Number(capacidadKg);
  if (!Number.isFinite(cap) || cap <= 0) return { porcentaje: null, excedido: false, sobra_kg: null };
  const pct = dos((kgTotal / cap) * 100);
  return { porcentaje: pct, excedido: kgTotal > cap, sobra_kg: dos(cap - kgTotal) };
}
