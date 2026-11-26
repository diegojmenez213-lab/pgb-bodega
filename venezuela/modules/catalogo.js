// venezuela/modules/catalogo.js
import {
  db,
  getTenantRefs,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  writeBatch,
  serverTimestamp
} from "../core/db.js";

async function cargarSheetJS() {
  if (window.XLSX) return window.XLSX;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.sheetjs.com/xlsx-0.20.2/package/dist/xlsx.full.min.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("No se pudo cargar SheetJS."));
    document.head.appendChild(s);
  });
  return window.XLSX;
}

function normalizarTexto(txt) {
  return String(txt || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizarCodigoClave(cod) {
  return String(cod || "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

function limpiarDocId(codigo) {
  return String(codigo || "")
    .trim()
    .toUpperCase()
    .replace(/[\/\\#?\[\]]/g, "_")
    .slice(0, 120);
}

function parseNumero(val) {
  if (typeof val === "number") return Number.isFinite(val) ? val : 0;
  const limpia = String(val || "")
    .replace(/[^0-9.,-]/g, "")
    .trim();
  if (!limpia) return 0;

  if (limpia.includes(",") && limpia.includes(".")) {
    const ultComa = limpia.lastIndexOf(",");
    const ultPunto = limpia.lastIndexOf(".");
    if (ultComa > ultPunto) {
      const n = parseFloat(limpia.replace(/\./g, "").replace(",", "."));
      return Number.isFinite(n) ? n : 0;
    } else {
      const n = parseFloat(limpia.replace(/,/g, ""));
      return Number.isFinite(n) ? n : 0;
    }
  }
  const n = parseFloat(limpia.replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

// ============================================================
// MOTOR INTELIGENTE DE CRUCE (CÓDIGO + MEDIDAS + PARECIDO)
// ============================================================
const STOPWORDS = new Set([
  "de", "del", "la", "el", "los", "las", "para", "con", "sin", "en", "por", "tipo", "und", "pza", "unidad"
]);

function extraerFirmaTecnica(descripcion = "", marca = "") {
  const raw = `${descripcion} ${marca && marca !== "GENÉRICO" ? marca : ""}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/(\d+)[.\s-]+(\d+\/\d+)/g, "$1_$2")
    .replace(/[*×]/g, " ")
    .replace(/(\d)x(\d)/g, "$1 $2");

  const medidasMatch = raw.match(/\d+_\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?/g) || [];
  const medidas = Array.from(new Set(medidasMatch)).sort();

  const palabras = raw
    .replace(/[^a-z0-9/_]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));

  const palabrasSet = new Set(palabras);
  const textoLimpio = palabras.join(" ");

  const bigramas = new Set();
  const plano = textoLimpio.replace(/\s+/g, "");
  for (let i = 0; i < plano.length - 1; i++) {
    bigramas.add(plano.slice(i, i + 2));
  }

  return { medidas, palabrasSet, bigramas, textoLimpio };
}

function similitudConjuntos(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const x of setA) {
    if (setB.has(x)) inter++;
  }
  return (2 * inter) / (setA.size + setB.size);
}

function medidasCompatibles(medA, medB) {
  if (!medA.length && !medB.length) return true;
  if (medA.length !== medB.length) return false;
  for (let i = 0; i < medA.length; i++) {
    if (medA[i] !== medB[i]) return false;
  }
  return true;
}

function crearIndiceExistentes(productosExistentes) {
  const porId = new Map();
  const porCodigoClave = new Map();
  const indiceTokens = new Map();
  const firmas = new Map();

  for (const p of productosExistentes) {
    porId.set(p.id, p);
    const ck = normalizarCodigoClave(p.codigo || p.id);
    if (ck && ck.length >= 3) porCodigoClave.set(ck, p);

    const firma = extraerFirmaTecnica(p.descripcion || "", p.marca || "");
    firmas.set(p.id, firma);

    const claves = [...firma.medidas, ...firma.palabrasSet];
    for (const cl of claves) {
      if (!indiceTokens.has(cl)) indiceTokens.set(cl, []);
      indiceTokens.get(cl).push(p);
    }
  }

  function buscarCoincidencia(itemExcel, idsYaEmparejados) {
    if (porId.has(itemExcel.id) && !idsYaEmparejados.has(itemExcel.id)) {
      return { prod: porId.get(itemExcel.id), metodo: "codigo" };
    }

    const ck = normalizarCodigoClave(itemExcel.codigo);
    if (ck && ck.length >= 3 && porCodigoClave.has(ck)) {
      const cand = porCodigoClave.get(ck);
      if (!idsYaEmparejados.has(cand.id)) {
        return { prod: cand, metodo: "codigo_norm" };
      }
    }

    const firmaNuevo = extraerFirmaTecnica(itemExcel.descripcion, itemExcel.marca);
    if (!firmaNuevo.palabrasSet.size) return null;

    const candidatos = new Set();
    const clavesBusqueda = firmaNuevo.medidas.length
      ? firmaNuevo.medidas
      : Array.from(firmaNuevo.palabrasSet).slice(0, 4);

    for (const cl of clavesBusqueda) {
      const lista = indiceTokens.get(cl);
      if (lista) {
        for (const c of lista) {
          if (!idsYaEmparejados.has(c.id)) candidatos.add(c);
        }
      }
    }

    let mejorProd = null;
    let mejorScore = 0;
    let metodoGanador = "";

    for (const cand of candidatos) {
      const firmaCand = firmas.get(cand.id);
      if (!firmaCand) continue;

      if (!medidasCompatibles(firmaNuevo.medidas, firmaCand.medidas)) continue;

      const simPalabras = similitudConjuntos(firmaNuevo.palabrasSet, firmaCand.palabrasSet);
      const simBigramas = similitudConjuntos(firmaNuevo.bigramas, firmaCand.bigramas);
      const score = simPalabras * 0.65 + simBigramas * 0.35;

      const umbral = firmaNuevo.medidas.length > 0 ? 0.72 : 0.85;
      if (score >= umbral && score > mejorScore) {
        mejorScore = score;
        mejorProd = cand;
        metodoGanador = firmaNuevo.medidas.length > 0 ? "medidas_nombre" : "parecido_extremo";
      }
    }

    return mejorProd ? { prod: mejorProd, metodo: metodoGanador, score: mejorScore } : null;
  }

  return { buscarCoincidencia };
}

function mapearFilaExcel(row) {
  const keys = Object.keys(row);
  const buscar = (patrones) => {
    const k = keys.find((key) => {
      const nk = normalizarTexto(key);
      return patrones.some((p) => nk.includes(p));
    });
    return k ? row[k] : "";
  };

  const codigoRaw = String(
    buscar(["codigo", "cod", "sku", "ref", "parte", "nro parte", "num parte", "item", "id"]) || ""
  )
    .trim()
    .toUpperCase();

  const descripcion = String(
    buscar(["descripcion", "nombre", "producto", "detalle", "articulo", "repuesto", "concepto"]) || ""
  ).trim();

  if (!codigoRaw && !descripcion) return null;

  const sinCodigo = !codigoRaw;
  const codigo = codigoRaw || limpiarDocId(descripcion);

  return {
    id: limpiarDocId(codigo),
    codigo,
    sinCodigo,
    descripcion: descripcion || codigo,
    categoria: String(
      buscar(["categoria", "grupo", "linea", "familia", "rubro", "tipo"]) || "SIN CATEGORÍA"
    )
      .trim()
      .toUpperCase(),
    marca: String(
      buscar(["marca", "aplicacion", "vehiculo", "fabricante", "modelo"]) || "GENÉRICO"
    )
      .trim()
      .toUpperCase(),
    proveedor: String(
      buscar(["proveedor", "planta", "suplidor", "origen"]) || "RTC DIESEL PARTS"
    )
      .trim()
      .toUpperCase(),
    costoUsd: Number(
      parseNumero(
        buscar(["costo", "precio", "valor", "usd", "pvp", "neto", "unitario", "monto"])
      ).toFixed(2)
    ),
    stockPlanta: Math.max(
      0,
      Math.round(
        parseNumero(
          buscar(["stock", "cant", "cantidad", "existencia", "disponible", "planta", "inv", "und"])
        )
      )
    )
  };
}

function extraerFilasDesdeHoja(XLSX, sheet) {
  const matriz = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (!matriz.length) return [];

  const patronesEncabezado = [
    "codigo", "cod", "sku", "ref", "parte", "item", "id",
    "descripcion", "nombre", "producto", "detalle", "articulo", "repuesto",
    "stock", "cant", "cantidad", "existencia", "disponible", "planta",
    "costo", "precio", "valor", "usd", "pvp", "neto"
  ];

  let filaHeaderIdx = 0;
  let mejorPuntaje = 0;

  for (let i = 0; i < Math.min(matriz.length, 30); i++) {
    const celdas = matriz[i].map(normalizarTexto).filter(Boolean);
    const puntaje = celdas.reduce(
      (acc, c) => acc + (patronesEncabezado.some((p) => c.includes(p)) ? 1 : 0),
      0
    );
    if (puntaje > mejorPuntaje) {
      mejorPuntaje = puntaje;
      filaHeaderIdx = i;
    }
  }

  const headers = matriz[filaHeaderIdx].map((h, idx) => {
    const lim = normalizarTexto(h);
    return lim || `col_${idx}`;
  });

  const items = [];
  for (let r = filaHeaderIdx + 1; r < matriz.length; r++) {
    const fila = matriz[r];
    if (!fila || !fila.some((c) => String(c || "").trim() !== "")) continue;

    const obj = {};
    headers.forEach((h, cIdx) => {
      obj[h] = fila[cIdx];
    });

    const item = mapearFilaExcel(obj);
    if (item && item.id) items.push(item);
  }

  return items;
}

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);
  const fMayor = Number(state.empresa?.precios?.factorMayor) || 2.0;
  const fDetal = Number(state.empresa?.precios?.factorDetal) || 2.5;

  root.innerHTML = `
    <div class="space-y-4 max-w-6xl mx-auto">
      <!-- Inventarios completamente separados -->
      <div class="grid grid-cols-2 gap-2">
        <button id="tabAlmacen" type="button" class="p-3.5 rounded-2xl border-2 text-left transition cursor-pointer bg-slate-950 text-white border-slate-950">
          <div class="text-[10px] font-extrabold uppercase tracking-wider opacity-75">Inventario Independiente</div>
          <div class="text-sm font-extrabold">Almacén Físico</div>
        </button>
        <button id="tabPlanta" type="button" class="p-3.5 rounded-2xl border-2 text-left transition cursor-pointer bg-white text-slate-800 border-slate-200 hover:border-slate-400">
          <div class="text-[10px] font-extrabold uppercase tracking-wider text-slate-400">Lista Proveedor</div>
          <div class="text-sm font-extrabold">Planta</div>
        </button>
      </div>

      <!-- Cabecera y botón Actualizar Excel -->
      <div class="ve-card p-3.5 space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 id="tituloInv" class="text-base font-extrabold text-slate-900">Inventario Almacén Físico</h1>
            <p id="subResumenCat" class="text-xs text-slate-500">Cargando...</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <input id="fileExcelCat" type="file" accept=".xlsx,.xls,.csv" class="hidden" />
            <button id="btnActualizarExcel" type="button" class="px-4 py-2 rounded-xl bg-slate-950 hover:bg-slate-800 text-white text-xs font-extrabold cursor-pointer">
              ↑ Actualizar Excel
            </button>
            <button id="btnRecargarCat" type="button" class="px-2.5 py-2 rounded-xl bg-white border border-slate-200 text-xs font-bold cursor-pointer">
              ↻
            </button>
          </div>
        </div>

        <div id="progExcelWrap" class="hidden space-y-1 pt-1">
          <div class="flex justify-between text-[11px] font-bold text-slate-600">
            <span id="progExcelTxt">Procesando Excel...</span>
            <span id="progExcelPct">0%</span>
          </div>
          <div class="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
            <div id="progExcelBar" class="h-full bg-emerald-600 transition-all" style="width:0%"></div>
          </div>
        </div>

        <!-- Filtros -->
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 pt-1">
          <input id="busqCat" type="text" placeholder="Buscar código, medida o descripción..." class="lg:col-span-2 bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold outline-none focus:border-slate-900" />
          <select id="filtroCat" class="bg-slate-50 border border-slate-300 rounded-xl px-2.5 py-2 text-xs font-bold">
            <option value="">Todas las Categorías</option>
          </select>
          <label class="flex items-center gap-2 text-xs font-bold text-slate-700 px-2 cursor-pointer">
            <input id="chkSoloStock" type="checkbox" />
            Ocultar en 0
          </label>
        </div>
      </div>

      <!-- Registro de cambios inteligente (Última Actualización) -->
      <div id="panelCambiosPlanta" class="hidden ve-card border-sky-200 bg-sky-50/40 space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="text-xs font-extrabold uppercase tracking-wider text-sky-950">Novedades de la Última Actualización Excel</h2>
            <p id="metaUltimaAct" class="text-[11px] text-sky-800 font-semibold"></p>
          </div>
          <div class="flex flex-wrap items-center gap-1.5">
            <div id="resumenBadgesCambios" class="flex flex-wrap gap-1.5 text-[11px] font-extrabold"></div>
            <button id="btnLimpiarNovedades" type="button" class="px-2.5 py-1 rounded-full bg-slate-200 hover:bg-slate-300 text-slate-700 text-[11px] font-extrabold cursor-pointer">
              ✕ Limpiar
            </button>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-2.5 text-xs">
          <div class="bg-white rounded-xl border border-amber-300 p-2.5 space-y-1">
            <div class="font-extrabold text-amber-900">📈 Subieron de Precio Costo</div>
            <div id="listSubieronPrecio" class="max-h-40 overflow-y-auto space-y-1 text-[11px] text-slate-700"></div>
          </div>

          <div class="bg-white rounded-xl border border-emerald-200 p-2.5 space-y-1">
            <div class="font-extrabold text-emerald-800">✦ Productos Nuevos (con Costo)</div>
            <div id="listNuevosPlanta" class="max-h-40 overflow-y-auto space-y-1 text-[11px] text-slate-700"></div>
          </div>

          <div class="bg-white rounded-xl border border-sky-200 p-2.5 space-y-1">
            <div class="font-extrabold text-sky-800">↑ No Había y Ahora Sí (Reingresos)</div>
            <div id="listLlegaronPlanta" class="max-h-40 overflow-y-auto space-y-1 text-[11px] text-slate-700"></div>
          </div>

          <div class="bg-white rounded-xl border border-rose-200 p-2.5 space-y-1">
            <div class="font-extrabold text-rose-800">↓ Había Antes y Ya No Hay</div>
            <div id="listAgotadosPlanta" class="max-h-40 overflow-y-auto space-y-1 text-[11px] text-slate-700"></div>
          </div>
        </div>
      </div>

      <!-- Lista clasificada por Categorías A -> Z -->
      <div id="contenedorCat" class="space-y-2">
        <div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">Cargando inventario...</div>
      </div>
    </div>
  `;

  let productos = [];
  let ultimoReportePlanta = null;
  let origen = "almacen";

  const tabAlm = root.querySelector("#tabAlmacen");
  const tabPla = root.querySelector("#tabPlanta");
  const tituloInv = root.querySelector("#tituloInv");
  const btnAct = root.querySelector("#btnActualizarExcel");
  const fileInput = root.querySelector("#fileExcelCat");
  const busqEl = root.querySelector("#busqCat");
  const catEl = root.querySelector("#filtroCat");
  const soloStockEl = root.querySelector("#chkSoloStock");
  const contEl = root.querySelector("#contenedorCat");
  const panelCambios = root.querySelector("#panelCambiosPlanta");

  function actualizarTabsUI() {
    const esAlm = origen === "almacen";
    tabAlm.className = esAlm
      ? "p-3.5 rounded-2xl border-2 text-left transition cursor-pointer bg-slate-950 text-white border-slate-950"
      : "p-3.5 rounded-2xl border-2 text-left transition cursor-pointer bg-white text-slate-800 border-slate-200 hover:border-slate-400";
    tabPla.className = !esAlm
      ? "p-3.5 rounded-2xl border-2 text-left transition cursor-pointer bg-sky-900 text-white border-sky-900"
      : "p-3.5 rounded-2xl border-2 text-left transition cursor-pointer bg-white text-slate-800 border-slate-200 hover:border-slate-400";

    tituloInv.textContent = esAlm ? "Inventario Almacén Físico" : "Inventario Planta (Proveedor)";
    btnAct.textContent = esAlm ? "↑ Actualizar Excel Almacén (En 0)" : "↑ Actualizar Excel Planta";
    panelCambios.classList.toggle("hidden", !ultimoReportePlanta);
  }

  function renderPanelCambios() {
    if (!ultimoReportePlanta) {
      panelCambios.classList.add("hidden");
      return;
    }
    panelCambios.classList.remove("hidden");
    const r = ultimoReportePlanta;
    const nuevos = r.nuevos || [];
    const llegaron = r.llegaron || [];
    const agotados = r.agotados || [];
    const subieronPrecio = r.subieronPrecio || [];
    const crucesInteligentes = Number(r.crucesInteligentes || 0);

    root.querySelector("#metaUltimaAct").textContent =
      `Archivo: ${r.archivo || "Excel"} • Fecha: ${r.fechaIso || "---"}${crucesInteligentes > 0 ? ` • ${crucesInteligentes} cruce(s) inteligente(s) por medidas/nombre` : ""}`;

    root.querySelector("#resumenBadgesCambios").innerHTML = `
      <span class="px-2.5 py-1 rounded-full bg-amber-100 text-amber-900">Subió precio: ${subieronPrecio.length}</span>
      <span class="px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-900">Nuevos: ${nuevos.length}</span>
      <span class="px-2.5 py-1 rounded-full bg-sky-100 text-sky-900">Reingresos: ${llegaron.length}</span>
      <span class="px-2.5 py-1 rounded-full bg-rose-100 text-rose-900">Agotados: ${agotados.length}</span>
    `;

    root.querySelector("#listSubieronPrecio").innerHTML = subieronPrecio.length
      ? subieronPrecio.slice(0, 100).map((x) => `
          <div class="py-1 border-b border-slate-100 last:border-0 flex items-center justify-between gap-2">
            <div class="min-w-0">
              <strong class="font-mono-ve text-slate-900">${x.codigo}</strong> - ${x.descripcion}
            </div>
            <div class="font-mono-ve text-right shrink-0 text-amber-900 font-extrabold">
              $${Number(x.costoAnterior || 0).toFixed(2)} → $${Number(x.costoNuevo || 0).toFixed(2)}
              <span class="text-rose-600">(+${Number(x.pctSubida || 0).toFixed(1)}%)</span>
            </div>
          </div>
        `).join("")
      : `<div class="text-slate-400 py-2">Ningún producto subió de precio costo.</div>`;

    const pintLista = (arr, vacio, mostrarCosto = true) => arr.length
      ? arr.slice(0, 100).map((x) => `
          <div class="py-0.5 border-b border-slate-100 last:border-0 flex items-center justify-between gap-2">
            <div class="min-w-0 truncate"><strong class="font-mono-ve">${x.codigo}</strong> - ${x.descripcion}</div>
            ${mostrarCosto && x.costoUsd !== undefined ? `<span class="font-mono-ve font-extrabold text-slate-700 shrink-0">$${Number(x.costoUsd || 0).toFixed(2)}</span>` : ""}
          </div>
        `).join("")
      : `<div class="text-slate-400 py-2">${vacio}</div>`;

    root.querySelector("#listNuevosPlanta").innerHTML = pintLista(nuevos, "Sin productos nuevos en este Excel.", true);
    root.querySelector("#listLlegaronPlanta").innerHTML = pintLista(llegaron, "Ningún producto sin existencia reingresó.", true);
    root.querySelector("#listAgotadosPlanta").innerHTML = pintLista(agotados, "Ningún producto pasó a sin existencia.", false);
  }

  function poblarCategorias() {
    const cats = Array.from(new Set(productos.map((p) => p.categoria || "SIN CATEGORÍA"))).sort((a, b) => a.localeCompare(b, "es"));
    catEl.innerHTML = `<option value="">Todas las Categorías (${cats.length})</option>` +
      cats.map((c) => `<option value="${c}">${c}</option>`).join("");
  }

  function obtenerFiltrados() {
    const q = busqEl.value.trim().toLowerCase();
    const cat = catEl.value;
    const soloConStock = soloStockEl.checked;

    return productos
      .filter((p) => {
        if (cat && (p.categoria || "SIN CATEGORÍA") !== cat) return false;
        const stockActual = origen === "almacen" ? (p.stockAlmacen ?? 0) : (p.stockPlanta ?? 0);
        if (soloConStock && stockActual <= 0) return false;
        if (q) {
          const txt = `${p.codigo || ""} ${p.descripcion || ""} ${p.marca || ""} ${p.categoria || ""}`.toLowerCase();
          if (!txt.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => (a.descripcion || "").localeCompare(b.descripcion || "", "es"));
  }

  function filaProductoHTML(p) {
    const costo = Number(p.costoUsd || 0);
    const pMayor = (costo * fMayor).toFixed(2);
    const pDetal = (costo * fDetal).toFixed(2);
    const stock = origen === "almacen" ? (p.stockAlmacen ?? 0) : (p.stockPlanta ?? 0);
    const colorStock = stock > 0
      ? (origen === "almacen" ? "text-emerald-700" : "text-sky-700")
      : "text-slate-400";

    return `
      <div class="p-3 rounded-xl bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-mono-ve text-xs font-extrabold text-slate-900">${p.codigo || p.id}</span>
            <span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white border border-slate-200 text-slate-600">${p.marca || "GENÉRICO"}</span>
            <span class="text-[10px] font-mono-ve font-extrabold px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-900">Costo: $${costo.toFixed(2)}</span>
          </div>
          <div class="text-xs font-semibold text-slate-800 mt-0.5">${p.descripcion || ""}</div>
        </div>
        <div class="flex items-center gap-3 text-right">
          <div>
            <div class="text-[9px] font-extrabold uppercase text-slate-400">${origen === "almacen" ? "Almacén" : "Planta"}</div>
            <div class="font-mono-ve text-sm font-extrabold ${colorStock}">${stock}</div>
          </div>
          <div class="pl-2 border-l border-slate-200">
            <div class="text-[10px] font-bold text-slate-500">Detal: <span class="font-mono-ve text-slate-900 font-extrabold">$${pDetal}</span></div>
            <div class="text-[10px] font-bold text-slate-400">Mayor: <span class="font-mono-ve text-slate-700">$${pMayor}</span></div>
          </div>
        </div>
      </div>
    `;
  }

  function render() {
    actualizarTabsUI();
    renderPanelCambios();

    const filtrados = obtenerFiltrados();
    root.querySelector("#subResumenCat").textContent =
      `${filtrados.length} productos en ${origen === "almacen" ? "Almacén Físico" : "Planta"} • Clasificados por Categoría (A → Z)`;

    if (!filtrados.length) {
      contEl.innerHTML = `<div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">No hay productos cargados. Toca "↑ Actualizar Excel" arriba.</div>`;
      return;
    }

    const grupos = new Map();
    for (const p of filtrados) {
      const cat = p.categoria || "SIN CATEGORÍA";
      if (!grupos.has(cat)) grupos.set(cat, []);
      grupos.get(cat).push(p);
    }

    const catsOrdenadas = Array.from(grupos.keys()).sort((a, b) => a.localeCompare(b, "es"));
    contEl.innerHTML = catsOrdenadas.map((cat) => {
      const items = grupos.get(cat);
      return `
        <details class="ve-card p-3" open>
          <summary class="cursor-pointer flex items-center justify-between text-xs font-extrabold text-slate-900">
            <span>${cat}</span>
            <span class="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[10px]">${items.length} ítems</span>
          </summary>
          <div class="mt-3 space-y-2">
            ${items.slice(0, 120).map(filaProductoHTML).join("")}
            ${items.length > 120 ? `<div class="text-[11px] text-center text-slate-400 font-bold">Mostrando 120 de ${items.length}. Usa el buscador para filtrar.</div>` : ""}
          </div>
        </details>
      `;
    }).join("");
  }

  btnAct.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    fileInput.value = "";

    const progWrap = root.querySelector("#progExcelWrap");
    const progBar = root.querySelector("#progExcelBar");
    const progPct = root.querySelector("#progExcelPct");
    const progTxt = root.querySelector("#progExcelTxt");
    progWrap.classList.remove("hidden");
    progTxt.textContent = `Analizando ${file.name} con motor inteligente...`;

    try {
      const XLSX = await cargarSheetJS();
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });

      const mapaExcel = new Map();
      for (const nombreHoja of wb.SheetNames) {
        const extraidos = extraerFilasDesdeHoja(XLSX, wb.Sheets[nombreHoja]);
        for (const it of extraidos) {
          if (it && it.id) mapaExcel.set(it.id, it);
        }
      }

      const itemsExcel = Array.from(mapaExcel.values());
      if (!itemsExcel.length) {
        progWrap.classList.add("hidden");
        return alert("No se encontraron filas válidas en el Excel.");
      }

      const esAlmacen = origen === "almacen";
      const msg = esAlmacen
        ? `Se procesarán ${itemsExcel.length} productos con cruce inteligente (Almacén en 0 para conteo físico). ¿Continuar?`
        : `Se actualizará Planta con ${itemsExcel.length} productos usando cruce inteligente (código, medidas y nombre) sin alterar tu stock de Almacén. ¿Continuar?`;

      if (!confirm(msg)) {
        progWrap.classList.add("hidden");
        return;
      }

      const indice = crearIndiceExistentes(productos);
      const idsVistosEnExcel = new Set();
      const operaciones = [];

      const nuevos = [];
      const llegaron = [];
      const agotados = [];
      const subieronPrecio = [];
      let crucesInteligentes = 0;

      for (const it of itemsExcel) {
        const match = indice.buscarCoincidencia(it, idsVistosEnExcel);
        const prev = match ? match.prod : null;
        const targetId = prev ? prev.id : it.id;
        idsVistosEnExcel.add(targetId);

        if (match && (match.metodo === "medidas_nombre" || match.metodo === "parecido_extremo")) {
          crucesInteligentes++;
        }

        const prevCosto = Number(prev?.costoUsd || 0);
        const nuevoCosto = Number(it.costoUsd || 0);
        const prevPlanta = Number(prev?.stockPlanta || 0);

        if (!prev) {
          nuevos.push({
            codigo: it.codigo,
            descripcion: it.descripcion,
            costoUsd: nuevoCosto
          });
        } else {
          if (prevCosto > 0 && nuevoCosto > prevCosto + 0.009) {
            const pctSubida = ((nuevoCosto - prevCosto) / prevCosto) * 100;
            subieronPrecio.push({
              codigo: prev.codigo || it.codigo,
              descripcion: it.descripcion || prev.descripcion,
              costoAnterior: prevCosto,
              costoNuevo: nuevoCosto,
              pctSubida: Number(pctSubida.toFixed(1))
            });
          }

          if (!esAlmacen) {
            if (prevPlanta <= 0 && it.stockPlanta > 0) {
              llegaron.push({
                codigo: prev.codigo || it.codigo,
                descripcion: it.descripcion || prev.descripcion,
                costoUsd: nuevoCosto
              });
            } else if (prevPlanta > 0 && it.stockPlanta <= 0) {
              agotados.push({
                codigo: prev.codigo || it.codigo,
                descripcion: it.descripcion || prev.descripcion
              });
            }
          }
        }

        operaciones.push({ targetId, prev, it });
      }

      const faltantesEnExcel = [];
      if (!esAlmacen) {
        for (const prev of productos) {
          if (!idsVistosEnExcel.has(prev.id) && Number(prev.stockPlanta || 0) > 0) {
            faltantesEnExcel.push(prev);
            agotados.push({
              codigo: prev.codigo || prev.id,
              descripcion: prev.descripcion || ""
            });
          }
        }
      }

      subieronPrecio.sort((a, b) => b.pctSubida - a.pctSubida);

      const colRef = refs.catalogo();
      const LOTE = 400;
      const totalOps = operaciones.length + faltantesEnExcel.length;
      let hechas = 0;

      for (let i = 0; i < operaciones.length; i += LOTE) {
        const slice = operaciones.slice(i, i + LOTE);
        const batch = writeBatch(db);
        for (const { targetId, prev, it } of slice) {
          const payload = {
            codigo: it.sinCodigo && prev?.codigo ? prev.codigo : it.codigo,
            descripcion: it.descripcion,
            categoria: it.categoria,
            marca: it.marca,
            proveedor: it.proveedor,
            costoUsd: it.costoUsd,
            actualizadoEn: serverTimestamp()
          };

          if (esAlmacen) {
            payload.stockAlmacen = 0;
            payload.contado = false;
            if (!prev) payload.stockPlanta = 0;
          } else {
            payload.stockPlanta = it.stockPlanta;
            if (!prev) {
              payload.stockAlmacen = 0;
              payload.contado = false;
            }
          }

          batch.set(doc(colRef, targetId), payload, { merge: true });
        }
        await batch.commit();
        hechas += slice.length;
        const pct = Math.min(100, Math.round((hechas / Math.max(1, totalOps)) * 100));
        progBar.style.width = `${pct}%`;
        progPct.textContent = `${pct}%`;
        progTxt.textContent = `Guardando ${hechas} de ${totalOps}...`;
      }

      if (!esAlmacen && faltantesEnExcel.length) {
        for (let i = 0; i < faltantesEnExcel.length; i += LOTE) {
          const slice = faltantesEnExcel.slice(i, i + LOTE);
          const batch = writeBatch(db);
          for (const p of slice) {
            batch.set(doc(colRef, p.id), { stockPlanta: 0, actualizadoEn: serverTimestamp() }, { merge: true });
          }
          await batch.commit();
          hechas += slice.length;
        }
      }

      const reportePayload = {
        archivo: file.name,
        fechaIso: new Date().toISOString().slice(0, 10),
        origenActualizado: origen,
        crucesInteligentes,
        nuevos,
        llegaron,
        agotados,
        subieronPrecio,
        actualizadoEn: serverTimestamp()
      };
      await setDoc(doc(refs.historialNovedades(), "ultimo_planta"), reportePayload);
      ultimoReportePlanta = reportePayload;

      progWrap.classList.add("hidden");
      alert(
        `¡Actualización completada!\n` +
        `• Nuevos: ${nuevos.length}\n` +
        `• Subieron de precio costo: ${subieronPrecio.length}\n` +
        `• No había y ahora sí: ${llegaron.length}\n` +
        `• Había y ya no hay: ${agotados.length}\n` +
        (crucesInteligentes > 0 ? `• Cruces inteligentes (sin código exacto): ${crucesInteligentes}` : "")
      );
      await cargarCatalogo();
    } catch (err) {
      progWrap.classList.add("hidden");
      alert("Error actualizando Excel: " + err.message);
    }
  });

  root.querySelector("#btnLimpiarNovedades").addEventListener("click", async () => {
    if (!confirm("¿Borrar el reporte de novedades de la última actualización?")) return;
    await deleteDoc(doc(refs.historialNovedades(), "ultimo_planta"));
    ultimoReportePlanta = null;
    render();
  });

  async function cargarCatalogo() {
    const [snapCat, snapNov] = await Promise.all([getDocs(refs.catalogo()), getDocs(refs.historialNovedades())]);
    productos = snapCat.docs.map((d) => ({ id: d.id, ...d.data() }));
    const docUltimo = snapNov.docs.find((d) => d.id === "ultimo_planta");
    ultimoReportePlanta = docUltimo ? docUltimo.data() : null;
    poblarCategorias();
    render();
  }

  tabAlm.addEventListener("click", () => { origen = "almacen"; render(); });
  tabPla.addEventListener("click", () => { origen = "planta"; render(); });
  busqEl.addEventListener("input", render);
  catEl.addEventListener("change", render);
  soloStockEl.addEventListener("change", render);
  root.querySelector("#btnRecargarCat").addEventListener("click", cargarCatalogo);

  await cargarCatalogo();
}
