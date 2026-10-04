import { useOperacionReparto } from './RepartoContext';
import { useDialogoReparto, estiloDialogo } from '../utils/useDialogoReparto';
import { useEffect, useMemo, useRef, useState } from 'react';
import { X, AlertTriangle, Trash2, Plus, Loader2, CheckCircle2, Info } from 'lucide-react';
import { authHeaders, getUser } from '../utils/auth';
import { aplicarPrecioDeLista } from '../utils/precioDeLista';
import './CorregirFacturaModal.css';

/**
 * CORREGIR UNA FACTURA YA EMITIDA.
 *
 * Mati (09/09/2026): *"llaman los repartidores a facturación porque hay algún problema, se puso
 * mal una lista o hay un artículo mal cargado... que sea lo más rápido y ágil y simple posible"*.
 *
 * 🔴 La factura NO se toca: es un comprobante fiscal. Lo que se hace es dejarla como debería
 * quedar y el panel emite la nota de crédito por lo que baja y la de débito por lo que sube.
 *
 * 🔑 Toda la pantalla es una sola idea: **editás la factura como si se pudiera**, y abajo ves en
 * vivo qué comprobantes van a salir. Nadie tiene que pensar en notas de crédito hasta el final.
 */

interface Renglon {
  cod_articulo: number;
  cantidad: number;
  /** BRUTO, el precio de lista. Lo que la factura cobró es esto menos el descuento. */
  precio: number | null;
  cotizacion?: string;
  descuento_porc?: number | null;
  descripcion?: string;
  iva_por?: number | null;
  cod_lista_precios?: number | null;
}

interface Factura {
  id: string; numero: number | null; fecha: string;
  cod_cliente: number; cliente_nombre: string | null;
  categoria_iva: string | null; letra: 'A' | 'B' | null;
}

interface Vista { nc: Renglon[]; nd: Renglon[]; total_nc: number; total_nd: number; diferencia: number }
const LISTAS: Array<[number, string]> = [[12, 'Lista 1'], [13, 'Lista 2'], [14, 'Lista 3'], [15, 'Lista 4']];

const money = (n: number) => '$' + Number(n ?? 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/**
 * 🔴 Lo que el renglón cobra DE VERDAD. Mati (10/09/2026): *"al calcular la NC no está tomando el
 * descuento que tiene ese producto, lo hace por el total"*. La pantalla mostraba el bruto, así que
 * el TOTAL de la factura tampoco coincidía con la factura: en la FA B 50422 decía $699.708,64
 * donde InfoManager dice $587.301,91.
 */
const importeDe = (r: { cantidad: number; precio: number | null; descuento_porc?: number | null }) =>
  r.cantidad * Number(r.precio ?? 0) * (1 - (Number(r.descuento_porc ?? 0) || 0) / 100);
const nun = (v: string) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) && n >= 0 ? n : 0; };

export function CorregirFacturaModal(
  { idFactura, onCerrar, onListo }: { idFactura: string; onCerrar: () => void; onListo: () => void },
) {
    const operacionGlobal = useOperacionReparto('CorregirFacturaModal');
  const [factura, setFactura] = useState<Factura | null>(null);
  const [originales, setOriginales] = useState<Renglon[]>([]);
  const [filas, setFilas] = useState<Renglon[]>([]);
  const [motivo, setMotivo] = useState('');
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [vista, setVista] = useState<Vista | null>(null);
  const [emitiendo, setEmitiendo] = useState(false);
  const [resultado, setResultado] = useState<{ emitidos: any[]; fallados: string[] } | null>(null);
  /** El buscador para agregar un producto que no está en la factura. */
  const [buscando, setBuscando] = useState('');
  const [candidatos, setCandidatos] = useState<any[]>([]);
  /** Renglones escritos a mano con plata adentro: la nota no los puede incluir. */
  const [sinArticulo, setSinArticulo] = useState<Array<{ descripcion: string; importe: number }>>([]);
  /**
   * 🔑 El modo financiero. Mati (10/09/2026): *"la NC puede ser financiera, por alguna diferencia
   * de cambio, o sea que no necesariamente tiene que dar de baja algún producto"*. Es otra cosa
   * que corregir renglones, así que es otra pantalla y no un caso raro de la misma.
   */
  /**
   * 🔑 'editar' es el modo por defecto desde el 30/09/2026. Mati, por Jorgelina: *"InfoManager es
   * más fácil ya que sólo edita la factura y listo... no podemos hacer que se pueda modificar la
   * factura y no tener que emitir tantos comprobantes?"*. La misma grilla, pero al guardar la app
   * rehace factura y remito (editarFactura.ts) en vez de emitir notas.
   */
  const [modo, setModo] = useState<'editar' | 'productos' | 'financiera'>('editar');
  const [finTipo, setFinTipo] = useState<'NC' | 'ND'>('NC');
  const [finImporte, setFinImporte] = useState('');
  const [finMotivo, setFinMotivo] = useState('');
  /** "Editar factura": cómo quedaría, por qué no se puede, y cómo terminó (o dónde quedó). */
  const [vistaEdicion, setVistaEdicion] = useState<any>(null);
  const [avisoEdicion, setAvisoEdicion] = useState<string | null>(null);
  const [resultadoEdicion, setResultadoEdicion] = useState<any>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [bloqueoProductos, setBloqueoProductos] = useState<string | null>(null);
  const [pendiente, setPendiente] = useState<any>(null);
  const operacionId = useRef<string | null>(null);
  const envioEnCurso = useRef(false);
  const cerrar = () => { if (!envioEnCurso.current) onCerrar(); };
  const [propietarioBorrador] = useState(() => getUser()?.email ?? "sesion");
  const borradorCargado = useRef(false);
  const facturaActual = useRef<any>(null);
  const [borradorDesactualizado, setBorradorDesactualizado] = useState(false);
  const [erroresPrecio, setErroresPrecio] = useState<Record<string, string>>({});
  const [intentoPrecio, setIntentoPrecio] = useState(0);
  const faltanPrecios = filas.some(f => f.precio == null);
  const claveCotizacion = JSON.stringify(filas.filter(f => f.precio == null).map(f => ({
    cod: f.cod_articulo, lista: f.cod_lista_precios, cotizacion: f.cotizacion,
  })));
  const claveBorrador = `reparto:${propietarioBorrador}:borrador-correccion:${idFactura}`;
  const clavePendiente = `reparto:${propietarioBorrador}:correccion:${idFactura}`;
  /**
   * 🔑 "Cancelar" DESCARTA el borrador; la X y Escape lo conservan (cierre sin querer). Jo, 30/09/2026,
   * con la FA B 50963: *"cada vez que pone cancelar se vuelven a cambiar los cambios para que ella
   * confirme, y no tenemos forma de volver atrás"*. Lo pendiente de emitir (`clavePendiente`) no se toca.
   */
  const cancelar = () => {
    if (envioEnCurso.current) return;
    try { sessionStorage.removeItem(claveBorrador); } catch { /* Sin persistencia local. */ }
    onCerrar();
  };

  useEffect(() => {
    const impedirSalida = (e: BeforeUnloadEvent) => { if (envioEnCurso.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', impedirSalida);
    return () => window.removeEventListener('beforeunload', impedirSalida);
  }, []);

  useEffect(() => {
    let vivo = true; const controller = new AbortController();
    (async () => {
      setCargando(true); setError(null);
      try {
        const r = await fetch(`/api/facturacion/corregir/${idFactura}`, { headers: authHeaders(), signal: controller.signal });
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.error ?? 'No se pudo leer la factura');
        if (!vivo) return;
        facturaActual.current = d;
        setFactura(d.factura);
        setVersion(d.version);
        setBloqueoProductos(d.bloqueo_productos ?? null);
        let local: any = null;
        try { local = JSON.parse(sessionStorage.getItem(clavePendiente) ?? 'null'); } catch { /* Sin borrador local. */ }
        const op = d.operacion;
        setPendiente(op ?? (local ? { id: local.body.operacion_id, clase: local.clase, estado: 'verificar', entrada: local.entrada, motivo: local.body.motivo, version: local.body.version, puede_retomar: true } : null));
        operacionId.current = op?.id ?? local?.body.operacion_id ?? null;
        setSinArticulo(d.sin_articulo ?? []);
        setOriginales(d.renglones);
        setFilas(d.renglones.map((x: Renglon) => ({ ...x })));
        try {
          const borrador = JSON.parse(sessionStorage.getItem(claveBorrador) ?? 'null');
          if (borrador && Array.isArray(borrador.filas) && Array.isArray(borrador.originales) && !op && !local) {
            setFilas(borrador.filas); setOriginales(borrador.originales); setVersion(borrador.version);
            setMotivo(borrador.motivo ?? ''); setModo(borrador.modo ?? 'editar');
            setFinTipo(borrador.finTipo ?? 'NC'); setFinImporte(borrador.finImporte ?? ''); setFinMotivo(borrador.finMotivo ?? '');
            setBorradorDesactualizado(borrador.version !== d.version);
          }
        } catch { /* No adoptar un borrador ilegible. */ }
        borradorCargado.current = true;
      } catch (e: any) {
        if (vivo) setError(e?.message ?? 'Error de conexión');
      } finally {
        if (vivo) setCargando(false);
      }
    })();
    return () => { vivo = false; controller.abort(); };
  }, [idFactura, clavePendiente, claveBorrador]);

  useEffect(() => {
    if (!borradorCargado.current || cargando || resultado || pendiente) return;
    try { sessionStorage.setItem(claveBorrador, JSON.stringify({ version, originales, filas, motivo, modo, finTipo, finImporte, finMotivo })); } catch { /* La sesión puede impedir almacenamiento. */ }
  }, [claveBorrador, version, originales, filas, motivo, modo, finTipo, finImporte, finMotivo, cargando, resultado, pendiente]);

  // Precio de la lista elegida, sin adoptar respuestas de otra selección ni del artículo retirado.
  useEffect(() => {
    if (cargando || pendiente || borradorDesactualizado) return;
    const pendientes = JSON.parse(claveCotizacion) as Array<{ cod: number; lista: number; cotizacion?: string }>;
    if (!pendientes.length) return;
    const ctrl = new AbortController();
    setErroresPrecio({});
    void (async () => {
      for (const p of pendientes) {
        if (ctrl.signal.aborted) return;
        try {
          const r = await fetch(`/api/pedidos/precio?cod_articulo=${p.cod}&cod_lista=${p.lista}`, { headers: authHeaders(), signal: ctrl.signal });
          const d = await r.json();
          if (ctrl.signal.aborted) return;
          const cambio = r.ok ? aplicarPrecioDeLista({ precio: 0 }, d, p.lista) : null;
          if (!cambio) throw new Error('No se pudo consultar el precio.');
          if (cambio.sinPrecio) throw new Error('Sin precio en esta lista. Elegí otra.');
          setVista(null);
          setFilas(fs => fs.map(f => f.cod_articulo === p.cod && f.cod_lista_precios === p.lista &&
            f.cotizacion === p.cotizacion && f.precio == null ? { ...f, precio: cambio.precio } : f));
        } catch (e: any) {
          if (!ctrl.signal.aborted) setErroresPrecio(es => ({ ...es, [p.cod]: e?.message ?? 'No se pudo consultar el precio.' }));
        }
      }
    })();
    return () => ctrl.abort();
  }, [claveCotizacion, intentoPrecio, cargando, pendiente, borradorDesactualizado]);

  const totalOriginal = useMemo(
    () => originales.reduce((s, r) => s + importeDe(r), 0), [originales]);
  const totalNuevo = useMemo(
    () => filas.reduce((s, r) => s + importeDe(r), 0), [filas]);
  const hayCambios = useMemo(() => {
    const firma = (rs: Renglon[]) => JSON.stringify(rs.map(r => [r.cod_articulo, r.cantidad, r.precio, r.descuento_porc ?? 0])
      .sort((a, b) => Number(a[0]) - Number(b[0])));
    return firma(filas) !== firma(originales);
  }, [filas, originales]);

  /**
   * La previsualización sale del MISMO cálculo que después emite, en el servidor. Si la hiciera
   * la pantalla por su cuenta, podría prometer una cosa y salir otra.
   */
  useEffect(() => {
    setVista(null);
    if (modo !== 'productos' || !hayCambios || faltanPrecios || pendiente || bloqueoProductos || borradorDesactualizado) return;
    let vivo = true; const controller = new AbortController();
    const t = setTimeout(async () => {
      try {
        const r = await fetch('/api/facturacion/corregir', {
          method: 'POST', signal: controller.signal, headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ im_factura_id: idFactura, renglones: filas, version }),
        });
        const d = await r.json().catch(() => null);
        if (vivo) setVista(r.ok ? d : null);
      } catch { if (vivo) setVista(null); }
    }, 350);   // sin esto sale una consulta por tecla mientras se escribe un precio
    return () => { vivo = false; controller.abort(); clearTimeout(t); };
  }, [modo, filas, hayCambios, faltanPrecios, idFactura, version, pendiente, bloqueoProductos, borradorDesactualizado]);

  /**
   * La vista previa de "Editar factura", del servidor: el mismo cálculo que después ejecuta. SIN
   * cambios también se pide, porque si el remito no dice lo mismo que la factura (lo que deja
   * editarla en la pantalla de IM) se rehace él solo, sin tocar la factura.
   */
  useEffect(() => {
    setVistaEdicion(null); setAvisoEdicion(null);
    if (modo !== 'editar' || cargando || !factura || faltanPrecios || pendiente || borradorDesactualizado || resultadoEdicion) return;
    let vivo = true; const controller = new AbortController();
    const t = setTimeout(async () => {
      try {
        const r = await fetch('/api/facturacion/editar', {
          method: 'POST', signal: controller.signal, headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ im_factura_id: idFactura, ...(hayCambios ? { renglones: filas } : {}) }),
        });
        const d = await r.json().catch(() => null);
        if (!vivo) return;
        if (r.ok && d?.previsualizacion) setVistaEdicion(d.previsualizacion);
        // Quedó una edición a mitad de camino: se muestra para retomarla, no se arranca otra.
        else if (r.ok && d?.abierta) setResultadoEdicion(d.abierta);
        else setAvisoEdicion(d?.error ?? 'No pude calcular cómo quedaría.');
      } catch { if (vivo) setAvisoEdicion(null); }
    }, 350);
    return () => { vivo = false; controller.abort(); clearTimeout(t); };
  }, [modo, cargando, factura, filas, hayCambios, faltanPrecios, idFactura, pendiente, borradorDesactualizado, resultadoEdicion]);

  // Buscar un producto para agregar. Reusa el buscador del catálogo que ya usa el vendedor.
  useEffect(() => {
    const q = buscando.trim();
    if (q.length < 2) { setCandidatos([]); return; }
    let vivo = true; const controller = new AbortController();
    setCandidatos([]);
    const t = setTimeout(async () => {
      try {
        // El mismo buscador que usa el editor de presupuestos: catálogo completo, por
        // descripción o por código.
        const r = await fetch(`/api/articulos/buscar?q=${encodeURIComponent(q)}`, { headers: authHeaders(), signal: controller.signal });
        const d = await r.json().catch(() => null);
        if (vivo) setCandidatos(r.ok ? (d?.articulos ?? []).slice(0, 8) : []);
      } catch { if (vivo) setCandidatos([]); }
    }, 300);
    return () => { vivo = false; controller.abort(); clearTimeout(t); };
  }, [buscando]);

  const tocar = (i: number, campo: 'cantidad' | 'precio' | 'descuento_porc', valor: string) => {
    setVista(null);
    // El descuento es un porcentaje: fuera de 0-100 el servidor rechaza la nota entera.
    const n = campo === 'descuento_porc' ? Math.min(100, Math.max(0, nun(valor))) : nun(valor);
    setFilas(fs => fs.map((f, j) => j === i ? { ...f, [campo]: n } : f));
    return n;
  };

  /**
   * 🔴 LO QUE SE ESTÁ TIPEANDO SE MUESTRA TAL CUAL. Mati (01/10/2026): *"hay que poner para que la
   * app se pueda poner decimales en las cantidades"*. El campo mostraba el número ya convertido, y
   * "9," es 9: la coma desaparecía en el acto y, al seguir tipeando, "9,5" quedaba **95** — una
   * nota por diez veces la cantidad, sin aviso. IM acepta decimales (el granel va por kilo).
   *
   * Mientras el campo tiene el foco se ve el texto; al salir, el número. Si lo tipeado no es lo que
   * queda guardado (un descuento de 150 se guarda 100), se muestra lo guardado en el acto.
   */
  const [tecleado, setTecleado] = useState<Record<string, string>>({});
  const escribir = (i: number, cod: number, campo: 'cantidad' | 'precio' | 'descuento_porc', valor: string) => {
    // Sólo dígitos y un separador: una letra antes dejaba la cantidad en cero.
    if (!/^\d*[.,]?\d*$/.test(valor)) return;
    const n = tocar(i, campo, valor);
    const leido = Number(valor.replace(',', '.'));
    // Vacío o sólo el separador ("," para escribir ",5") todavía no es un número: se espera.
    const aMedias = valor === '' || /^[.,]$/.test(valor);
    setTecleado(t => {
      const c = { ...t };
      if (aMedias || leido === n) c[`${cod}:${campo}`] = valor; else delete c[`${cod}:${campo}`];
      return c;
    });
  };
  const soltar = (cod: number, campo: string) => setTecleado(t => { const c = { ...t }; delete c[`${cod}:${campo}`]; return c; });

  const cambiarLista = (cod: number, lista: number) => {
    setVista(null);
    setFilas(fs => fs.map(f => f.cod_articulo === cod ? { ...f, cod_lista_precios: lista,
      ...(cod !== 13819 ? { precio: null, cotizacion: crypto.randomUUID() } : {}),
    } : f));
  };

  const sacar = (i: number) => setFilas(fs => fs.filter((_, j) => j !== i));

  /**
   * 🔑 DEVOLVER TODO DE UN CLIC. Mati (24/09/2026): *"agregar un botón en las NC para poder
   * seleccionar todos los productos de una sola vez"*. Para una devolución total había que apretar
   * el tacho renglón por renglón.
   *
   * Pone las cantidades en 0 en vez de sacar los renglones: siguen a la vista, se puede volver a
   * subir uno solo si algo sí quedó, y el server ya toma el 0 como "sale entero". La nota sale como
   * devolución, así que la mercadería reingresa al stock.
   */
  const todoEnCero = filas.length > 0 && filas.every(f => !(Number(f.cantidad) > 0));
  const devolverTodo = () => {
    setVista(null);
    setFilas(fs => todoEnCero
      ? fs.map(f => ({ ...f, cantidad: originales.find(o => o.cod_articulo === f.cod_articulo)?.cantidad ?? f.cantidad }))
      : fs.map(f => ({ ...f, cantidad: 0 })));
  };

  const agregar = (a: any) => {
    const cod = Number(a.cod_articulo);
    if (filas.some(f => f.cod_articulo === cod)) { setBuscando(''); setCandidatos([]); return; }
    setFilas(fs => [...fs, {
      cod_articulo: cod, cantidad: 1, precio: cod === 13819 ? 0 : null,
      cotizacion: crypto.randomUUID(),
      descuento_porc: 0,
      descripcion: String(a.descripcion ?? `Artículo ${cod}`),
      // El servidor verifica IVA para productos nuevos; no inventar una alícuota0.
      cod_lista_precios: LISTAS.some(([l]) => l === fs.at(-1)?.cod_lista_precios) ? fs.at(-1)!.cod_lista_precios : 12,
    }]);
    setBuscando(''); setCandidatos([]);
  };

  async function enviar(clase: 'productos' | 'financiera', entrada: any, motivoEnviar: string, versionOriginal: number | null = version) {
    if (envioEnCurso.current || borradorDesactualizado || (clase === 'productos' && faltanPrecios)) return;
    if (!operacionGlobal.comenzar()) return;
    envioEnCurso.current = true;
    setEmitiendo(true); setError(null);
    const id = operacionId.current ?? crypto.randomUUID();
    operacionId.current = id;
    const body = { im_factura_id: idFactura, ...entrada, motivo: motivoEnviar, emitir: true, operacion_id: id, version: versionOriginal };
    const url = clase === 'productos' ? '/api/facturacion/corregir' : '/api/facturacion/nota-financiera';
    // El borrador conserva exactamente la petición ante pérdida de respuesta o recarga.
    try { sessionStorage.setItem(clavePendiente, JSON.stringify({ clase, entrada, body })); } catch { /* El servidor conserva el journal. */ }
    setPendiente({ id, clase, entrada, motivo: motivoEnviar, version: versionOriginal, estado: 'verificar', puede_retomar: true });
    try {
      const r = await fetch(url, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error ?? 'No se pudo verificar el resultado. Retomá la misma operación.');
      if (!d.ok) {
        setPendiente(d.operacion ?? { id, clase, entrada, motivo: motivoEnviar, estado: 'incierto', puede_retomar: false });
        setError(d.operacion?.error ? null : (d.fallados ?? []).join(' ')); onListo(); return;
      }
      try { sessionStorage.removeItem(clavePendiente); sessionStorage.removeItem(claveBorrador); borradorCargado.current = false; } catch { /* Sin persistencia local. */ }
      setPendiente(null);
      setResultado({ emitidos: d.emitidos ?? [], fallados: d.fallados ?? [] });
      onListo();
    } catch (e: any) {
      setError(e?.message ?? 'Se perdió la respuesta. Conservamos la misma operación para verificarla.');
    } finally {
      envioEnCurso.current = false; setEmitiendo(false); operacionGlobal.terminar();
    }
  }

  /** Guarda la edición, o la retoma donde quedó (el servidor sabe en qué paso está). */
  async function guardarEdicion() {
    if (envioEnCurso.current || (!vistaEdicion && !resultadoEdicion)) return;
    if (vistaEdicion) {
      const v = vistaEdicion;
      const texto = v.rehace_factura
        ? `Se anula la ${v.factura.tipo ?? 'factura'} ${v.factura.numero ?? ''} y sale una nueva por ${money(v.factura.total_nuevo)}, con la misma fecha.\nEl remito ${v.remito.numero ?? ''} se rehace igual a ella.`
        : `El remito ${v.remito.numero ?? ''} se rehace igual a la factura. La factura no se toca.`;
      if (!confirm(`${texto}\n¿Seguimos?`)) return;
    }
    if (!operacionGlobal.comenzar()) return;
    envioEnCurso.current = true; setEmitiendo(true); setError(null);
    try {
      const r = await fetch('/api/facturacion/editar', {
        method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ im_factura_id: idFactura, confirmar: true, motivo, ...(hayCambios && !resultadoEdicion ? { renglones: filas } : {}) }),
      });
      const d = await r.json().catch(() => null);
      if (!d) throw new Error('Se perdió la respuesta. Volvé a abrir la factura: la edición quedó anotada y se retoma desde ahí.');
      if (d.estado) {
        setResultadoEdicion(d);
        if (d.ok) { try { sessionStorage.removeItem(claveBorrador); } catch { /* Sin persistencia local. */ } borradorCargado.current = false; }
        onListo();
      } else if (d.abierta) {
        setResultadoEdicion({ ...d.abierta, error: d.error ?? d.abierta.error });
      } else {
        setError(d.error ?? 'No se pudo editar la factura.');
      }
    } catch (e: any) {
      setError(e?.message ?? 'Error de conexión');
    } finally {
      envioEnCurso.current = false; setEmitiendo(false); operacionGlobal.terminar();
    }
  }

  async function emitirFinanciera() {
    const importe = nun(finImporte);
    if (!(importe > 0) || !finMotivo.trim() || pendiente) return;
    if (!confirm(`Se va a emitir una ${finTipo} por ${money(importe)} en InfoManager.\nMotivo: ${finMotivo.trim()}\n¿Seguimos?`)) return;
    await enviar('financiera', { tipo: finTipo, importe }, finMotivo.trim());
  }

  async function emitir() {
    if (!vista || faltanPrecios || pendiente || bloqueoProductos) return;
    const detalle = [vista.nc.length ? `NC ${money(vista.total_nc)}` : '', vista.nd.length ? `ND ${money(vista.total_nd)}` : ''].filter(Boolean).join(' y ');
    if (!confirm(`Se va a emitir ${detalle} en InfoManager.\n¿Seguimos?`)) return;
    await enviar('productos', { renglones: filas }, motivo);
  }

  const dialogo = useDialogoReparto(cerrar);
  return (
    <dialog ref={dialogo} style={estiloDialogo} aria-label="Corregir factura" className="cf-fondo" onClick={e => { if (e.target === e.currentTarget) cerrar(); }}>
      <div className="cf-modal">
        <header className="cf-header">
          <h3>
            {modo === 'editar' ? 'Editar' : 'Corregir'} factura {factura?.letra ?? ''} {factura?.numero ?? ''}
            {factura?.cliente_nombre && <small> · {factura.cliente_nombre}</small>}
          </h3>
          <button onClick={cerrar} disabled={emitiendo} aria-label="Cerrar corrección"><X size={18} /></button>
        </header>

        {cargando && <p className="cf-cargando"><Loader2 size={16} className="spin" /> Leyendo la factura en InfoManager…</p>}
        {error && <div className="cf-error"><AlertTriangle size={15} /> <span>{error}</span></div>}

        {borradorDesactualizado && <div className="cf-error" role="alert">La factura cambió desde este borrador. Se conserva para comparar; hay que revisar los datos actuales antes de emitir.
          <button onClick={() => { const d = facturaActual.current; setFilas(d.renglones); setOriginales(d.renglones); setVersion(d.version); setMotivo(''); setFinImporte(''); setFinMotivo(''); setBorradorDesactualizado(false); sessionStorage.removeItem(claveBorrador); }}>Descartar borrador y revisar versión actual</button>
        </div>}
        {pendiente && !resultado && (
          <div className="cf-error">
            <span>{pendiente.instruccion ?? (pendiente.estado === 'listo' && pendiente.error && !pendiente.emitidos?.length
                ? 'InfoManager rechazó el intento. Corregí el motivo indicado antes de retomarlo.'
                : `Hay una operación ${pendiente.estado === 'listo' ? 'pendiente de terminar' : 'por verificar'}. Las notas confirmadas no se vuelven a emitir.`)}
              {!!pendiente.emitidos?.length && <p>Notas ya registradas: {pendiente.emitidos.map((n: any) => `${n.tipo} ${n.numero ?? ''} por ${money(n.total)}`).join('; ')}.</p>}
              {pendiente.error && <details><summary>Ver detalle del rechazo</summary><p>{pendiente.error}</p></details>}
              {pendiente.puede_retomar && <button disabled={emitiendo} onClick={() => void enviar(pendiente.clase, pendiente.entrada, pendiente.motivo, pendiente.version ?? version)}>Retomar / verificar operación</button>}
              {pendiente.puede_cancelar && <button disabled={emitiendo} onClick={async () => {
                if (!operacionGlobal.comenzar()) return; envioEnCurso.current = true; setEmitiendo(true);
                let cancelado = false;
                try {
                  const r = await fetch(`/api/facturacion/operaciones/${pendiente.id}`, { method: 'DELETE', headers: authHeaders() });
                  const d = await r.json(); if (!r.ok) throw new Error(d.error);
                  sessionStorage.removeItem(clavePendiente); cancelado = true; onListo();
                } catch (e: any) { setError(e.message); }
                finally { envioEnCurso.current = false; setEmitiendo(false); operacionGlobal.terminar(); }
                if (cancelado) cerrar();
              }}>Cancelar el intento rechazado</button>}
              {!pendiente.puede_retomar && !pendiente.instruccion && ' Verificá los comprobantes en InfoManager antes de continuar.'}
            </span>
          </div>
        )}
        {bloqueoProductos && !resultado && modo === 'productos' && <div className="cf-error">{bloqueoProductos}</div>}
        {resultadoEdicion ? (
          <div className="cf-listo">
            {resultadoEdicion.ok ? <>
              {resultadoEdicion.factura_nueva && (
                <p className="cf-ok"><CheckCircle2 size={16} /> <span>Salió la <b>{resultadoEdicion.factura_nueva.tipo} {resultadoEdicion.factura_nueva.numero}</b>. La {resultadoEdicion.factura_vieja?.tipo ?? 'factura'} {resultadoEdicion.factura_vieja?.numero} quedó anulada.</span></p>
              )}
              {/* El texto va en un <span>: `.cf-ok` es flex y, suelto, cada pedazo quedaba en su propia columna. */}
              <p className="cf-ok"><CheckCircle2 size={16} /> <span>Salió el remito <b>{resultadoEdicion.remito_nuevo?.numero}</b>. El {resultadoEdicion.remito_viejo?.numero} quedó anulado y lo que no salió volvió al stock.</span></p>
              {resultadoEdicion.hoja && <p className="cf-ok"><CheckCircle2 size={16} /> <span>La hoja de ruta {resultadoEdicion.hoja} ya lleva el remito nuevo.</span></p>}
              <button className="cf-btn primario" onClick={cerrar}>Listo</button>
            </> : <>
              <p className="cf-mal"><AlertTriangle size={16} /> <span>{resultadoEdicion.error ?? 'La edición quedó a mitad de camino.'}</span></p>
              {resultadoEdicion.factura_nueva && <p className="cf-nota">La factura nueva ({resultadoEdicion.factura_nueva.numero}) ya salió: al retomar no se vuelve a emitir.</p>}
              <div className="cf-pie">
                <button className="cf-btn" onClick={cerrar} disabled={emitiendo}>Cerrar</button>
                {/* 'cancelada': el primer paso falló sin cambiar nada, así que se vuelve a la grilla. */}
                {resultadoEdicion.estado === 'cancelada' ? (
                  <button className="cf-btn primario" onClick={() => setResultadoEdicion(null)}>Volver a la factura</button>
                ) : resultadoEdicion.estado !== 'incierto' && (
                  <button className="cf-btn primario" onClick={() => void guardarEdicion()} disabled={emitiendo}>
                    {emitiendo ? <><Loader2 size={15} className="spin" /> Retomando…</> : 'Retomar donde quedó'}
                  </button>
                )}
              </div>
            </>}
          </div>
        ) : resultado ? (
          <div className="cf-listo">
            {resultado.emitidos.map((e, i) => (
              <p key={i} className="cf-ok"><CheckCircle2 size={16} /> Salió la <b>{e.tipo} {e.numero}</b> por {money(e.total)}.</p>
            ))}
            {resultado.fallados.map((f, i) => (
              <p key={'f' + i} className="cf-mal"><AlertTriangle size={16} /> {f}</p>
            ))}
            <button className="cf-btn primario" onClick={cerrar}>Listo</button>
          </div>
        ) : !cargando && factura && (
          <fieldset disabled={emitiendo || !!pendiente || borradorDesactualizado} style={{ border: 0, padding: 0, minWidth: 0 }}>
            <div className="cf-solapas">
              <button className={modo === 'editar' ? 'activa' : ''} onClick={() => setModo('editar')}>
                Editar factura
              </button>
              <button className={modo === 'productos' ? 'activa' : ''} onClick={() => setModo('productos')}>
                Con notas (NC/ND)
              </button>
              <button className={modo === 'financiera' ? 'activa' : ''} onClick={() => setModo('financiera')}>
                Ajuste financiero
              </button>
            </div>

            {modo === 'financiera' ? (
              <div className="cf-financiera">
                {/* 🔑 No saca mercadería: es plata. Diferencia de cambio, intereses, bonificación. */}
                {/* 🔄 04/10/2026: una línea; el detalle, en el ⓘ.
                    🪤 Decía "lo descuenta" siempre, y una ND SUMA: el texto afirmaba lo contrario de lo
                    que iba a pasar con la mitad de las notas. */}
                <p className="cf-sub" title={`Para lo que no saca mercadería: una diferencia de cambio, intereses, una bonificación. Va contra la factura ${factura.numero}, así que la hoja de ruta ${finTipo === 'ND' ? 'lo suma al pedido' : 'lo descuenta del pedido'}.`}>
                  <Info size={13} /> No saca mercadería: la hoja de ruta {finTipo === 'ND' ? 'lo suma al pedido' : 'lo descuenta del pedido'}.
                </p>
                <div className="cf-fila-fin">
                  <label>
                    <span>Comprobante</span>
                    <select value={finTipo} onChange={e => setFinTipo(e.target.value as 'NC' | 'ND')}>
                      <option value="NC">Nota de crédito · le devolvemos plata</option>
                      <option value="ND">Nota de débito · le cobramos de más</option>
                    </select>
                  </label>
                  <label>
                    <span>Importe</span>
                    <input inputMode="decimal" value={finImporte} placeholder="0,00"
                           onChange={e => setFinImporte(e.target.value)} />
                  </label>
                </div>
                <label className="cf-fila-motivo">
                  <span>Motivo</span>
                  <input value={finMotivo} maxLength={100}
                         onChange={e => setFinMotivo(e.target.value)}
                         placeholder="Diferencia por cambio de mercadería, interés factura 18/8…" />
                </label>
                {nun(finImporte) > 0 && finMotivo.trim() && (
                  <p className="cf-dif">
                    {finTipo === 'NC'
                      ? <>Se le devuelven <b>{money(nun(finImporte))}</b>.</>
                      : <>Se le cobran <b>{money(nun(finImporte))}</b> de más.</>}
                  </p>
                )}
                <div className="cf-pie">
                  <button className="cf-btn" onClick={cancelar} disabled={emitiendo}>Cancelar</button>
                  <button className="cf-btn primario" onClick={() => void emitirFinanciera()}
                          disabled={emitiendo || !(nun(finImporte) > 0) || !finMotivo.trim()}>
                    {emitiendo ? <><Loader2 size={15} className="spin" /> Emitiendo…</>
                      : `Emitir la ${finTipo === 'NC' ? 'nota de crédito' : 'nota de débito'}`}
                  </button>
                </div>
              </div>
            ) : (
            <>
            {/* 🔄 04/10/2026: era un recuadro fijo; ahora una línea corta con el detalle en el ⓘ. */}
            {modo === 'editar' ? (
              <p className="cf-sub" title="Dejá la factura como tiene que quedar y guardá. Si cambia, la app la reemplaza por una nueva con la misma fecha, y el remito, el stock y la hoja de ruta se acomodan solos.">
                <Info size={13} /> Si cambia, la app la reemplaza por una nueva con la misma fecha.
              </p>
            ) : (
              /* 🪤 La factura no se modifica. Que se lea antes de tocar nada: queda a la vista, corto. */
              <p className="cf-sub" title={`La factura ${factura.numero} no se toca: es un comprobante fiscal. Dejá los renglones como tendrían que haber quedado y abajo vas a ver qué notas salen.`}>
                <Info size={13} /> La factura {factura.numero} no se toca: salen notas.
              </p>
            )}

            {/* 🔴 Plata de la factura que la nota no puede tocar: IM exige código de artículo. */}
            {!!sinArticulo.length && (
              <div className="cf-error cf-sinart">
                <AlertTriangle size={15} />
                <span>
                  Esta factura tiene {sinArticulo.length === 1 ? 'un renglón escrito a mano' : `${sinArticulo.length} renglones escritos a mano`} por{' '}
                  <b>{money(sinArticulo.reduce((s, r) => s + r.importe, 0))}</b>
                  {' '}({sinArticulo.map(r => r.descripcion).join(', ')}) que <b>no entran</b> en la
                  nota, porque InfoManager exige un código de artículo. Si hay que devolver eso
                  también, esa parte va por InfoManager.
                </span>
              </div>
            )}

            {modo === 'productos' && <div className="cf-herramientas">
              <button type="button" className="cf-btn cf-devolver-todo" onClick={devolverTodo} disabled={!filas.length}
                      title={todoEnCero ? 'Volver a las cantidades de la factura' : 'Pone todas las cantidades en 0: la nota acredita la factura entera y la mercadería vuelve al stock'}>
                {todoEnCero ? 'Restaurar cantidades' : 'Devolver todo'}
              </button>
            </div>}
            <div className="cf-tabla-scroll"><table className="cf-tabla">
              <thead>
                <tr>
                  <th>Producto</th><th className="n">Cantidad</th><th className="n">Precio</th>
                  <th className="n">Desc.</th>
                  <th className="n">Importe</th><th className="n">Facturado</th><th />
                </tr>
              </thead>
              <tbody>
                {filas.map((f, i) => {
                  const orig = originales.find(o => o.cod_articulo === f.cod_articulo);
                  const cambio = !orig || Math.abs(orig.cantidad - f.cantidad) > 0.0001
                    || f.precio == null || Math.abs(Number(orig.precio) - f.precio) > 0.00005
                    || Math.abs(Number(orig.descuento_porc ?? 0) - Number(f.descuento_porc ?? 0)) > 0.00005;
                  return (
                    <tr key={f.cod_articulo} className={cambio ? 'cambiado' : ''}>
                      <td>{f.descripcion ?? `Artículo ${f.cod_articulo}`}
                        {/**
                          * 🔑 EL CÓDIGO A LA VISTA. Mati (22/09/2026): *"en la parte de emisión de
                          * la NC estaría bueno que aparezcan los códigos de los productos"*. Es lo
                          * que se busca en InfoManager, y es lo único que distingue descripciones
                          * que se parecen: MAIZ QUEBRADO FINO / MEDIANO / GRUESO x 30 KG.
                          *
                          * Dice "Cód." igual que el buscador de abajo, que ya lo mostraba así.
                          */}
                        <div className="cf-lista"><span className="cf-cod">Cód. {f.cod_articulo}</span>
                          <select aria-label={`Lista de ${f.descripcion}`} value={f.cod_lista_precios ?? ''}
                          onChange={e => cambiarLista(f.cod_articulo, Number(e.target.value))}>
                          {!LISTAS.some(([cod]) => cod === f.cod_lista_precios) && <option value={f.cod_lista_precios ?? ''} disabled>{f.cod_lista_precios ? `Lista IM ${f.cod_lista_precios}` : 'Precio original'}</option>}
                          {LISTAS.map(([cod, nombre]) => <option key={cod} value={cod}>{nombre}</option>)}
                        </select></div>
                      </td>
                      <td className="n">
                        <input aria-label={`Cantidad de ${f.descripcion}`} inputMode="decimal"
                               value={tecleado[`${f.cod_articulo}:cantidad`] ?? String(f.cantidad)}
                               onChange={e => escribir(i, f.cod_articulo, 'cantidad', e.target.value)}
                               onBlur={() => soltar(f.cod_articulo, 'cantidad')} />
                      </td>
                      <td className="n">
                        <input aria-label={`Precio de ${f.descripcion}`} inputMode="decimal" disabled={f.precio == null}
                               value={f.precio == null ? '' : tecleado[`${f.cod_articulo}:precio`] ?? String(f.precio)}
                               onChange={e => escribir(i, f.cod_articulo, 'precio', e.target.value)}
                               onBlur={() => soltar(f.cod_articulo, 'precio')} />
                        {f.precio == null && <div className="cf-precio-pendiente">{erroresPrecio[f.cod_articulo] ?? 'Consultando precio…'}
                          {erroresPrecio[f.cod_articulo] && <button type="button" onClick={() => setIntentoPrecio(n => n + 1)}>Reintentar precio</button>}
                        </div>}
                      </td>
                      {/* 🔑 Editable desde el 30/09/2026. Mati: *"necesitamos también poder modificar
                          el % de descuento en la factura, actualmente está bloqueado"*. El servidor
                          ya calculaba la nota por la diferencia de neto, y si sólo cambia el descuento
                          sale FINANCIERA: no mueve stock (ver subtipoNota). */}
                      <td className="n cf-desc">
                        <input aria-label={`Descuento de ${f.descripcion}`} inputMode="decimal"
                               value={tecleado[`${f.cod_articulo}:descuento_porc`] ?? String(f.descuento_porc ?? 0)}
                               onChange={e => escribir(i, f.cod_articulo, 'descuento_porc', e.target.value)}
                               onBlur={() => soltar(f.cod_articulo, 'descuento_porc')} />
                      </td>
                      <td className="n">{f.precio == null ? '—' : money(importeDe(f))}</td>
                      <td className="n cf-antes">
                        {orig ? money(importeDe(orig)) : <span className="cf-nuevo">nuevo</span>}
                      </td>
                      <td className="c">
                        <button className="cf-sacar" title="Sacar este producto" onClick={() => sacar(i)}>
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {/* Los que se sacaron: siguen a la vista, si no se pierde qué se quitó. */}
                {originales.filter(o => !filas.some(f => f.cod_articulo === o.cod_articulo)).map(o => (
                  <tr key={'out' + o.cod_articulo} className="sacado">
                    <td>{o.descripcion ?? `Artículo ${o.cod_articulo}`}</td>
                    <td className="n">—</td><td className="n">—</td><td className="n">—</td><td className="n">—</td>
                    <td className="n cf-antes">{money(importeDe(o))}</td>
                    <td className="c">
                      <button className="cf-sacar" title="Volver a ponerlo"
                              onClick={() => setFilas(fs => [...fs, { ...o }])}>
                        <Plus size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4}>TOTAL</td>
                    <td className="n">{faltanPrecios ? 'Pendiente' : money(totalNuevo)}</td>
                  <td className="n cf-antes">{money(totalOriginal)}</td>
                  <td />
                </tr>
              </tfoot>
            </table></div>

            <div className="cf-agregar">
              <input aria-label="Buscar producto para corregir" value={buscando} onChange={e => setBuscando(e.target.value)}
                     placeholder="Agregar un producto que faltó…" />
              {!!candidatos.length && (
                <ul className="cf-candidatos">
                  {candidatos.map(a => (
                    <li key={a.cod_articulo}>
                      <button onClick={() => agregar(a)}>
                        {a.descripcion} <span>Cód. {a.cod_articulo}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {modo === 'editar' && vistaEdicion && (
              <div className="cf-resumen">
                <h4>Cómo queda</h4>
                {vistaEdicion.rehace_factura ? (
                  <p>La {vistaEdicion.factura.tipo ?? 'factura'} {vistaEdicion.factura.numero} ({money(vistaEdicion.factura.total_actual)}) se anula y sale una nueva por <b>{money(vistaEdicion.factura.total_nuevo)}</b>, con la misma fecha.</p>
                ) : (
                  <p>La factura queda como está. El remito {vistaEdicion.remito.numero} ({money(vistaEdicion.remito.total_actual)}) <b>no coincide con ella</b> y se rehace por {money(vistaEdicion.remito.total_nuevo)}.</p>
                )}
                {vistaEdicion.rehace_factura && <p>El remito {vistaEdicion.remito.numero} se rehace igual a la factura nueva{vistaEdicion.hoja ? ` y se cambia en la hoja ${vistaEdicion.hoja}` : ''}.</p>}
                {!vistaEdicion.rehace_factura && vistaEdicion.hoja && <p>En la hoja {vistaEdicion.hoja} se cambia por el remito nuevo.</p>}
                {!!vistaEdicion.vuelve.length && (
                  <div className="cf-comp nc"><b>Vuelve al stock</b>
                    <ul>{vistaEdicion.vuelve.map((x: any) => <li key={x.cod_articulo}>{x.cantidad} × {x.descripcion} <span className="cf-cod">Cód. {x.cod_articulo}</span></li>)}</ul>
                  </div>
                )}
                {!!vistaEdicion.sale.length && (
                  <div className="cf-comp nd"><b>Sale del stock</b>
                    <ul>{vistaEdicion.sale.map((x: any) => <li key={x.cod_articulo}>{x.cantidad} × {x.descripcion} <span className="cf-cod">Cód. {x.cod_articulo}</span></li>)}</ul>
                  </div>
                )}
              </div>
            )}
            {modo === 'editar' && avisoEdicion && !vistaEdicion && (
              <p className={hayCambios ? 'cf-error' : 'cf-nota'}>{avisoEdicion}</p>
            )}

            {modo === 'productos' && vista && (
              <div className="cf-resumen">
                <h4>Lo que se va a emitir</h4>
                {!!vista.nc.length && (
                  <div className="cf-comp nc">
                    <b>Nota de crédito {factura.letra} · {money(vista.total_nc)}</b>
                    <ul>{vista.nc.map((r, i) => (
                      <li key={i}>
                        {r.descripcion ?? `Artículo ${r.cod_articulo}`} — {r.cantidad} × {money(Number(r.precio))}
                        {r.descuento_porc ? ` − ${r.descuento_porc}%` : ''} = {money(importeDe(r))}
                      </li>
                    ))}</ul>
                  </div>
                )}
                {!!vista.nd.length && (
                  <div className="cf-comp nd">
                    <b>Nota de débito {factura.letra} · {money(vista.total_nd)}</b>
                    <ul>{vista.nd.map((r, i) => (
                      <li key={i}>
                        {r.descripcion ?? `Artículo ${r.cod_articulo}`} — {r.cantidad} × {money(Number(r.precio))}
                        {r.descuento_porc ? ` − ${r.descuento_porc}%` : ''} = {money(importeDe(r))}
                      </li>
                    ))}</ul>
                  </div>
                )}
                <p className="cf-dif">
                  {vista.diferencia < 0
                    ? <>Al cliente se le devuelven <b>{money(-vista.diferencia)}</b>.</>
                    : <>Al cliente se le cobran <b>{money(vista.diferencia)}</b> de más.</>}
                </p>
              </div>
            )}

            <div className="cf-pie">
              <input aria-label="Motivo de la corrección" className="cf-motivo" value={motivo} maxLength={200}
                     onChange={e => setMotivo(e.target.value)}
                     placeholder="Motivo (va en las observaciones): lista mal cargada, no lo quiso…" />
              <button className="cf-btn" onClick={cancelar} disabled={emitiendo}>Cancelar</button>
              {modo === 'editar' ? (
                <button className="cf-btn primario" onClick={() => void guardarEdicion()}
                        disabled={!vistaEdicion || faltanPrecios || emitiendo}>
                  {emitiendo ? <><Loader2 size={15} className="spin" /> Guardando…</>
                    : vistaEdicion && !vistaEdicion.rehace_factura ? 'Rehacer el remito' : 'Guardar cambios'}
                </button>
              ) : (
                <button className="cf-btn primario" onClick={() => void emitir()}
                        disabled={!vista || faltanPrecios || emitiendo || !!bloqueoProductos || (!vista.nc.length && !vista.nd.length)}>
                  {emitiendo ? <><Loader2 size={15} className="spin" /> Emitiendo…</> : 'Emitir la corrección'}
                </button>
              )}
            </div>
            </>
            )}
          </fieldset>
        )}
      </div>
    </dialog>
  );
}
