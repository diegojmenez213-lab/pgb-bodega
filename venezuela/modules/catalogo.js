// venezuela/modules/catalogo.js
import {
  db,
  getTenantRefs,
  doc,
  getDocs,
  setDoc,
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

function limpiarDocId(codigo) {
  return String(codigo || "").trim().toUpperCase().replace(/[\/\\#?\[\]]/g, "_").slice(0, 120);
}

function parseNumero(val) {
  if (typeof val === "number") return isNaN(val) ? 0 : val;
  const s = String(val || "0").replace(/[^0-9.,-]/g, "").replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function mapearFilaExcel(row) {
  const keys = Object.keys(row);
  const buscar = (patrones) => {
    const k = keys.find((key) =>
      patrones.some((p) => key.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(p))
    );
    return k ? row[k] : "";
  };

  const codigo = String(buscar(["codigo", "cod", "sku", "ref", "parte"]) || "").trim().toUpperCase();
  const descripcion = String(buscar(["descripcion", "nombre", "producto", "detalle", "articulo"]) || "").trim();
  if (!codigo && !descripcion) return null;

  return {
    id: limpiarDocId(codigo || descripcion),
    codigo: codigo || limpiarDocId(descripcion),
    descripcion: descripcion || codigo,
    categoria: String(buscar(["categoria", "grupo", "linea", "familia"]) || "SIN CATEGORÍA").trim().toUpperCase(),
    marca: String(buscar(["marca", "aplicacion", "vehiculo", "fabricante"]) || "GENÉRICO").trim().toUpperCase(),
    proveedor: String(buscar(["proveedor", "planta", "suplidor"]) || "RTC DIESEL PARTS").trim().toUpperCase(),
    costoUsd: parseNumero(buscar(["costo", "precio", "valor", "usd", "pvp", "neto"])),
    stockPlanta: Math.max(0, Math.round(parseNumero(buscar(["stock", "cant", "existencia", "disponible", "planta"]))))
  };
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
          <input id="busqCat" type="text" placeholder="Buscar código o descripción..." class="lg:col-span-2 bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold outline-none focus:border-slate-900" />
          <select id="filtroCat" class="bg-slate-50 border border-slate-300 rounded-xl px-2.5 py-2 text-xs font-bold">
            <option value="">Todas las Categorías</option>
          </select>
          <label class="flex items-center gap-2 text-xs font-bold text-slate-700 px-2 cursor-pointer">
            <input id="chkSoloStock" type="checkbox" />
            Ocultar en 0
          </label>
        </div>
      </div>

      <!-- Registro de cambios vigente de Planta (reemplaza los cambios anteriores al actualizar) -->
      <div id="panelCambiosPlanta" class="hidden ve-card border-sky-200 bg-sky-50/40 space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="text-xs font-extrabold uppercase tracking-wider text-sky-950">Registro de Cambios (Última Actualización de Planta)</h2>
            <p id="metaUltimaAct" class="text-[11px] text-sky-800 font-semibold"></p>
          </div>
          <div id="resumenBadgesCambios" class="flex flex-wrap gap-1.5 text-[11px] font-extrabold"></div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-2.5 text-xs">
          <div class="bg-white rounded-xl border border-emerald-200 p-2.5 space-y-1">
            <div class="font-extrabold text-emerald-800">✦ Productos Nuevos (cargados en Almacén en 0)</div>
            <div id="listNuevosPlanta" class="max-h-36 overflow-y-auto space-y-1 text-[11px] text-slate-700"></div>
          </div>

          <div class="bg-white rounded-xl border border-sky-200 p-2.5 space-y-1">
            <div class="font-extrabold text-sky-800">↑ Llegaron / Sin Existencia Antes</div>
            <div id="listLlegaronPlanta" class="max-h-36 overflow-y-auto space-y-1 text-[11px] text-slate-700"></div>
          </div>

          <div class="bg-white rounded-xl border border-rose-200 p-2.5 space-y-1">
            <div class="font-extrabold text-rose-800">↓ Había Antes y Ahora No Hay</div>
            <div id="listAgotadosPlanta" class="max-h-36 overflow-y-auto space-y-1 text-[11px] text-slate-700"></div>
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
  let origen = "almacen"; // "almacen" | "planta"

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
    panelCambios.classList.toggle("hidden", esAlm || !ultimoReportePlanta);
  }

  function renderPanelCambios() {
    if (!ultimoReportePlanta || origen !== "planta") {
      panelCambios.classList.add("hidden");
      return;
    }
    panelCambios.classList.remove("hidden");
    const r = ultimoReportePlanta;
    const nuevos = r.nuevos || [];
    const llegaron = r.llegaron || [];
    const agotados = r.agotados || [];

    root.querySelector("#metaUltimaAct").textContent =
      `Archivo: ${r.archivo || "Excel"} • Fecha: ${r.fechaIso || "---"} (se reemplazan los cambios anteriores al volver a actualizar)`;

    root.querySelector("#resumenBadgesCambios").innerHTML = `
      <span class="px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-900">Nuevos: ${nuevos.length}</span>
      <span class="px-2.5 py-1 rounded-full bg-sky-100 text-sky-900">Llegaron: ${llegaron.length}</span>
      <span class="px-2.5 py-1 rounded-full bg-rose-100 text-rose-900">No hay: ${agotados.length}</span>
    `;

    const pintLista = (arr, vacio) => arr.length
      ? arr.slice(0, 80).map((x) => `<div class="py-0.5 border-b border-slate-100 last:border-0"><strong class="font-mono-ve">${x.codigo}</strong> - ${x.descripcion}</div>`).join("")
      : `<div class="text-slate-400 py-2">${vacio}</div>`;

    root.querySelector("#listNuevosPlanta").innerHTML = pintLista(nuevos, "Sin productos nuevos en este Excel.");
    root.querySelector("#listLlegaronPlanta").innerHTML = pintLista(llegaron, "Ningún producto sin existencia reingresó.");
    root.querySelector("#listAgotadosPlanta").innerHTML = pintLista(agotados, "Ningún producto pasó a sin existencia.");
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

    // Clasificado automáticamente por Categorías en orden alfabético (A -> Z)
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
    progTxt.textContent = `Leyendo ${file.name}...`;

    try {
      const XLSX = await cargarSheetJS();
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });

      const mapaExcel = new Map();
      for (const r of rows) {
        const it = mapearFilaExcel(r);
        if (it && it.id) mapaExcel.set(it.id, it);
      }
      const itemsExcel = Array.from(mapaExcel.values());
      if (!itemsExcel.length) {
        progWrap.classList.add("hidden");
        return alert("No se encontraron filas válidas en el Excel.");
      }

      const esAlmacen = origen === "almacen";
      const msg = esAlmacen
        ? `Se cargarán ${itemsExcel.length} productos con Almacén en 0 para el conteo físico. ¿Continuar?`
        : `Se actualizará Planta con ${itemsExcel.length} productos (sin afectar stock de Almacén). Los productos nuevos se crearán en Almacén con stock 0 y se reemplazarán los cambios anteriores. ¿Continuar?`;

      if (!confirm(msg)) {
        progWrap.classList.add("hidden");
        return;
      }

      const anterioresMap = new Map(productos.map((p) => [p.id, p]));
      const nuevos = [];
      const llegaron = [];
      const agotados = [];

      if (!esAlmacen) {
        for (const it of itemsExcel) {
          const prev = anterioresMap.get(it.id);
          const prevPlanta = Number(prev?.stockPlanta || 0);
          if (!prev) {
            nuevos.push({ codigo: it.codigo, descripcion: it.descripcion });
          } else if (prevPlanta <= 0 && it.stockPlanta > 0) {
            llegaron.push({ codigo: it.codigo, descripcion: it.descripcion });
          } else if (prevPlanta > 0 && it.stockPlanta <= 0) {
            agotados.push({ codigo: it.codigo, descripcion: it.descripcion });
          }
        }
        // Productos que antes tenían existencia en Planta y ya no vienen en el Excel
        for (const [id, prev] of anterioresMap.entries()) {
          if (!mapaExcel.has(id) && Number(prev.stockPlanta || 0) > 0) {
            agotados.push({ codigo: prev.codigo || id, descripcion: prev.descripcion || "" });
          }
        }
      }

      const colRef = refs.catalogo();
      const LOTE = 400;
      const totalOps = itemsExcel.length + (!esAlmacen ? agotados.length : 0);
      let hechas = 0;

      for (let i = 0; i < itemsExcel.length; i += LOTE) {
        const slice = itemsExcel.slice(i, i + LOTE);
        const batch = writeBatch(db);
        for (const it of slice) {
          const prev = anterioresMap.get(it.id);
          const payload = {
            codigo: it.codigo,
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
            // Si es un producto nuevo de Planta, se crea automáticamente en Almacén con stock 0
            if (!prev) {
              payload.stockAlmacen = 0;
              payload.contado = false;
            }
          }

          batch.set(doc(colRef, it.id), payload, { merge: true });
        }
        await batch.commit();
        hechas += slice.length;
        const pct = Math.min(100, Math.round((hechas / Math.max(1, totalOps)) * 100));
        progBar.style.width = `${pct}%`;
        progPct.textContent = `${pct}%`;
        progTxt.textContent = `Actualizando ${hechas} de ${totalOps}...`;
      }

      // Si actualizamos Planta, los que ya no están en la lista pasan a stockPlanta = 0 (sin tocar Almacén)
      if (!esAlmacen) {
        const faltantesEnExcel = Array.from(anterioresMap.values()).filter(
          (p) => !mapaExcel.has(p.id) && Number(p.stockPlanta || 0) > 0
        );
        for (let i = 0; i < faltantesEnExcel.length; i += LOTE) {
          const slice = faltantesEnExcel.slice(i, i + LOTE);
          const batch = writeBatch(db);
          for (const p of slice) {
            batch.set(doc(colRef, p.id), { stockPlanta: 0, actualizadoEn: serverTimestamp() }, { merge: true });
          }
          await batch.commit();
          hechas += slice.length;
        }

        // Reemplaza el reporte anterior de Planta por el nuevo (documento fijo "ultimo_planta")
        const reportePayload = {
          archivo: file.name,
          fechaIso: new Date().toISOString().slice(0, 10),
          nuevos,
          llegaron,
          agotados,
          actualizadoEn: serverTimestamp()
        };
        await setDoc(doc(refs.historialNovedades(), "ultimo_planta"), reportePayload);
        ultimoReportePlanta = reportePayload;
      }

      progWrap.classList.add("hidden");
      alert(
        esAlmacen
          ? `¡Listo! ${itemsExcel.length} productos cargados en Almacén (en 0) por categoría.`
          : `¡Planta actualizada! Nuevos en Almacén (en 0): ${nuevos.length} • Llegaron: ${llegaron.length} • Sin existencia: ${agotados.length}.`
      );
      await cargarCatalogo();
    } catch (err) {
      progWrap.classList.add("hidden");
      alert("Error actualizando Excel: " + err.message);
    }
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
