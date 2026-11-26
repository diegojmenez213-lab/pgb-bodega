// venezuela/modules/catalogo.js
import { getTenantRefs, getDocs } from "../core/db.js";

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

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);
  const fMayor = Number(state.empresa?.precios?.factorMayor) || 2.0;
  const fDetal = Number(state.empresa?.precios?.factorDetal) || 2.5;

  root.innerHTML = `
    <div class="space-y-4 max-w-6xl mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Catálogo de Inventario</h1>
          <p id="subResumenCat" class="text-xs text-slate-500">Cargando productos...</p>
        </div>
        <div class="flex items-center gap-2">
          <button id="btnExportExcel" class="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold cursor-pointer">
            ↓ Exportar Excel
          </button>
          <button id="btnRecargarCat" class="px-3 py-1.5 rounded-xl bg-white border border-slate-200 text-xs font-bold hover:bg-slate-50 cursor-pointer">
            ↻
          </button>
        </div>
      </div>

      <!-- Selector de Origen (Almacén / Planta / Ambos) -->
      <div class="ve-card p-3 space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="inline-flex rounded-xl bg-slate-100 p-1 gap-1" id="origenTabs">
            <button data-origen="ambos" class="orig-btn px-3 py-1.5 rounded-lg text-xs font-extrabold bg-slate-950 text-white cursor-pointer">Ambos</button>
            <button data-origen="almacen" class="orig-btn px-3 py-1.5 rounded-lg text-xs font-extrabold text-slate-600 cursor-pointer">Almacén</button>
            <button data-origen="planta" class="orig-btn px-3 py-1.5 rounded-lg text-xs font-extrabold text-slate-600 cursor-pointer">Planta</button>
          </div>

          <label class="flex items-center gap-2 text-xs font-bold text-slate-700 cursor-pointer">
            <input id="chkSoloStock" type="checkbox" />
            Ocultar en 0
          </label>
        </div>

        <!-- Búsqueda, Orden y Agrupación -->
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
          <input id="busqCat" type="text" placeholder="Buscar código o descripción..." class="lg:col-span-2 bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold outline-none focus:border-slate-900" />
          <select id="modoVista" class="bg-slate-50 border border-slate-300 rounded-xl px-2.5 py-2 text-xs font-bold">
            <option value="az">Orden Alfabético (A → Z)</option>
            <option value="za">Orden Alfabético (Z → A)</option>
            <option value="categoria">Agrupado por Categoría</option>
            <option value="marca">Agrupado por Marca</option>
          </select>
          <select id="filtroCat" class="bg-slate-50 border border-slate-300 rounded-xl px-2.5 py-2 text-xs font-bold">
            <option value="">Todas las Categorías</option>
          </select>
          <select id="filtroMarca" class="bg-slate-50 border border-slate-300 rounded-xl px-2.5 py-2 text-xs font-bold">
            <option value="">Todas las Marcas</option>
          </select>
        </div>
      </div>

      <!-- Contenedor de resultados -->
      <div id="contenedorCat" class="space-y-2">
        <div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">Cargando catálogo...</div>
      </div>

      <div id="pagCat" class="text-center hidden">
        <button id="btnMasCat" class="px-4 py-2 rounded-xl bg-white border border-slate-300 text-xs font-extrabold hover:bg-slate-50 cursor-pointer">
          Mostrar más
        </button>
      </div>
    </div>
  `;

  let productos = [];
  let origen = "ambos"; // "ambos" | "almacen" | "planta"
  let limite = 80;

  const busqEl = root.querySelector("#busqCat");
  const vistaEl = root.querySelector("#modoVista");
  const catEl = root.querySelector("#filtroCat");
  const marcaEl = root.querySelector("#filtroMarca");
  const soloStockEl = root.querySelector("#chkSoloStock");
  const contEl = root.querySelector("#contenedorCat");
  const pagEl = root.querySelector("#pagCat");

  function poblarFiltros() {
    const cats = Array.from(new Set(productos.map((p) => p.categoria || "SIN CATEGORÍA"))).sort();
    const marcas = Array.from(new Set(productos.map((p) => p.marca || "GENÉRICO"))).sort();

    catEl.innerHTML = `<option value="">Todas las Categorías (${cats.length})</option>` +
      cats.map((c) => `<option value="${c}">${c}</option>`).join("");
    marcaEl.innerHTML = `<option value="">Todas las Marcas (${marcas.length})</option>` +
      marcas.map((m) => `<option value="${m}">${m}</option>`).join("");
  }

  function obtenerFiltrados() {
    const q = busqEl.value.trim().toLowerCase();
    const cat = catEl.value;
    const marca = marcaEl.value;
    const soloConStock = soloStockEl.checked;
    const vista = vistaEl.value;

    const lista = productos.filter((p) => {
      if (cat && (p.categoria || "SIN CATEGORÍA") !== cat) return false;
      if (marca && (p.marca || "GENÉRICO") !== marca) return false;

      if (soloConStock) {
        if (origen === "almacen" && (p.stockAlmacen || 0) <= 0) return false;
        if (origen === "planta" && (p.stockPlanta || 0) <= 0) return false;
        if (origen === "ambos" && (p.stockAlmacen || 0) <= 0 && (p.stockPlanta || 0) <= 0) return false;
      }

      if (q) {
        const txt = `${p.codigo || ""} ${p.descripcion || ""} ${p.marca || ""} ${p.categoria || ""}`.toLowerCase();
        if (!txt.includes(q)) return false;
      }
      return true;
    });

    lista.sort((a, b) => {
      const cmp = (a.descripcion || "").localeCompare(b.descripcion || "", "es");
      return vista === "za" ? -cmp : cmp;
    });

    return lista;
  }

  function filaProductoHTML(p) {
    const costo = Number(p.costoUsd || 0);
    const pMayor = (costo * fMayor).toFixed(2);
    const pDetal = (costo * fDetal).toFixed(2);
    const stAlm = p.stockAlmacen ?? 0;
    const stPla = p.stockPlanta ?? 0;

    return `
      <div class="ve-card p-3 flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-mono-ve text-xs font-extrabold text-slate-900">${p.codigo || p.id}</span>
            <span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">${p.marca || "GENÉRICO"}</span>
            <span class="text-[10px] font-semibold text-slate-400">${p.categoria || ""}</span>
          </div>
          <div class="text-xs font-semibold text-slate-800 mt-0.5">${p.descripcion || ""}</div>
        </div>

        <div class="flex items-center gap-3 text-right">
          ${origen !== "planta" ? `
            <div>
              <div class="text-[9px] font-extrabold uppercase text-slate-400">Almacén</div>
              <div class="font-mono-ve text-xs font-extrabold ${stAlm > 0 ? "text-emerald-700" : "text-slate-400"}">${stAlm}</div>
            </div>
          ` : ""}
          ${origen !== "almacen" ? `
            <div>
              <div class="text-[9px] font-extrabold uppercase text-slate-400">Planta</div>
              <div class="font-mono-ve text-xs font-extrabold ${stPla > 0 ? "text-sky-700" : "text-slate-400"}">${stPla}</div>
            </div>
          ` : ""}
          <div class="pl-2 border-l border-slate-200">
            <div class="text-[10px] font-bold text-slate-500">Detal: <span class="font-mono-ve text-slate-900 font-extrabold">$${pDetal}</span></div>
            <div class="text-[10px] font-bold text-slate-400">Mayor: <span class="font-mono-ve text-slate-700">$${pMayor}</span></div>
          </div>
        </div>
      </div>
    `;
  }

  function render() {
    const filtrados = obtenerFiltrados();
    const vista = vistaEl.value;

    root.querySelector("#subResumenCat").textContent = `${filtrados.length} productos mostrados (Total catálogo: ${productos.length})`;

    if (!filtrados.length) {
      contEl.innerHTML = `<div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">No hay productos con esos filtros.</div>`;
      pagEl.classList.add("hidden");
      return;
    }

    if (vista === "categoria" || vista === "marca") {
      const campo = vista === "categoria" ? "categoria" : "marca";
      const grupos = new Map();
      for (const p of filtrados) {
        const key = p[campo] || (vista === "categoria" ? "SIN CATEGORÍA" : "GENÉRICO");
        if (!grupos.has(key)) grupos.set(key, []);
        grupos.get(key).push(p);
      }

      const keysOrdenadas = Array.from(grupos.keys()).sort((a, b) => a.localeCompare(b, "es"));
      contEl.innerHTML = keysOrdenadas.map((k) => {
        const items = grupos.get(k);
        return `
          <details class="ve-card p-3">
            <summary class="cursor-pointer flex items-center justify-between text-xs font-extrabold text-slate-900">
              <span>${k}</span>
              <span class="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[10px]">${items.length} ítems</span>
            </summary>
            <div class="mt-3 space-y-2">
              ${items.slice(0, 100).map(filaProductoHTML).join("")}
              ${items.length > 100 ? `<div class="text-[11px] text-center text-slate-400 font-bold">Mostrando primeros 100 de ${items.length} en este grupo. Usa el buscador para filtrar más.</div>` : ""}
            </div>
          </details>
        `;
      }).join("");
      pagEl.classList.add("hidden");
      return;
    }

    // Vista lista A-Z / Z-A
    const visibles = filtrados.slice(0, limite);
    contEl.innerHTML = visibles.map(filaProductoHTML).join("");
    pagEl.classList.toggle("hidden", filtrados.length <= limite);
  }

  root.querySelectorAll(".orig-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      origen = btn.dataset.origen;
      limite = 80;
      root.querySelectorAll(".orig-btn").forEach((b) => {
        b.className = b.dataset.origen === origen
          ? "orig-btn px-3 py-1.5 rounded-lg text-xs font-extrabold bg-slate-950 text-white cursor-pointer"
          : "orig-btn px-3 py-1.5 rounded-lg text-xs font-extrabold text-slate-600 cursor-pointer";
      });
      render();
    });
  });

  root.querySelector("#btnExportExcel").addEventListener("click", async () => {
    const filtrados = obtenerFiltrados();
    if (!filtrados.length) return alert("No hay datos para exportar.");
    try {
      const XLSX = await cargarSheetJS();
      const rows = filtrados.map((p) => ({
        Codigo: p.codigo || p.id,
        Descripcion: p.descripcion || "",
        Categoria: p.categoria || "",
        Marca: p.marca || "",
        Almacen: p.stockAlmacen ?? 0,
        Planta: p.stockPlanta ?? 0,
        Costo_USD: Number(p.costoUsd || 0),
        Mayor_USD: Number(((p.costoUsd || 0) * fMayor).toFixed(2)),
        Detal_USD: Number(((p.costoUsd || 0) * fDetal).toFixed(2))
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Inventario");
      XLSX.writeFile(wb, `Inventario_${origen}_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (err) {
      alert("Error exportando Excel: " + err.message);
    }
  });

  async function cargarCatalogo() {
    contEl.innerHTML = `<div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">Cargando catálogo...</div>`;
    const snap = await getDocs(refs.catalogo());
    productos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    poblarFiltros();
    render();
  }

  busqEl.addEventListener("input", () => { limite = 80; render(); });
  vistaEl.addEventListener("change", () => { limite = 80; render(); });
  catEl.addEventListener("change", () => { limite = 80; render(); });
  marcaEl.addEventListener("change", () => { limite = 80; render(); });
  soloStockEl.addEventListener("change", () => { limite = 80; render(); });
  root.querySelector("#btnMasCat").addEventListener("click", () => { limite += 80; render(); });
  root.querySelector("#btnRecargarCat").addEventListener("click", cargarCatalogo);

  await cargarCatalogo();
}
