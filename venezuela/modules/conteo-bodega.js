// venezuela/modules/conteo-bodega.js
import {
  getTenantRefs,
  doc,
  getDocs,
  updateDoc,
  serverTimestamp
} from "../core/db.js";

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);

  root.innerHTML = `
    <div class="space-y-4 max-w-5xl mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Conteo Digital de Almacén</h1>
          <p class="text-xs text-slate-500">Levanta el inventario físico desde cero sin perder el hilo.</p>
        </div>
        <button id="btnRecargarConteo" class="px-3 py-1.5 rounded-xl text-xs font-bold bg-white border border-slate-200 hover:bg-slate-50 cursor-pointer">
          ↻ Actualizar
        </button>
      </div>

      <!-- Barra de progreso -->
      <div class="ve-card space-y-2">
        <div class="flex items-center justify-between text-xs font-extrabold">
          <span id="txtProgreso">Cargando catálogo...</span>
          <span id="txtPct" class="font-mono-ve text-emerald-700">0%</span>
        </div>
        <div class="w-full h-2.5 bg-slate-200 rounded-full overflow-hidden">
          <div id="barProgreso" class="h-full bg-emerald-600 transition-all" style="width:0%"></div>
        </div>
      </div>

      <!-- Filtros rápidos -->
      <div class="ve-card flex flex-wrap items-center gap-2">
        <input id="busquedaConteo" type="text" placeholder="Buscar por código, descripción o marca..." class="flex-1 min-w-[200px] bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold outline-none focus:border-slate-900" />
        <select id="filtroCatConteo" class="bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold max-w-[200px]">
          <option value="">Todas las categorías</option>
        </select>
        <button id="btnSoloPendientes" type="button" class="px-3.5 py-2 rounded-xl text-xs font-extrabold bg-slate-950 text-white cursor-pointer">
          Solo pendientes
        </button>
      </div>

      <!-- Lista de conteo -->
      <div id="listaConteo" class="space-y-2">
        <div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">Cargando productos...</div>
      </div>

      <div id="paginacionConteo" class="flex items-center justify-center gap-2 hidden">
        <button id="btnMasConteo" class="px-4 py-2 rounded-xl bg-white border border-slate-300 text-xs font-extrabold hover:bg-slate-50 cursor-pointer">
          Cargar más productos
        </button>
      </div>
    </div>
  `;

  let productos = [];
  let soloPendientes = true;
  let limiteRender = 60;

  const inputBusq = root.querySelector("#busquedaConteo");
  const selectCat = root.querySelector("#filtroCatConteo");
  const btnPend = root.querySelector("#btnSoloPendientes");
  const listaEl = root.querySelector("#listaConteo");
  const pagEl = root.querySelector("#paginacionConteo");

  function actualizarProgreso() {
    const total = productos.length;
    const contados = productos.filter((p) => p.contado === true).length;
    const pendientes = total - contados;
    const pct = total ? Math.round((contados / total) * 100) : 0;

    root.querySelector("#txtProgreso").textContent = `${contados} contados • ${pendientes} pendientes (Total: ${total})`;
    root.querySelector("#txtPct").textContent = `${pct}%`;
    root.querySelector("#barProgreso").style.width = `${pct}%`;
  }

  function poblarCategorias() {
    const cats = Array.from(new Set(productos.map((p) => p.categoria || "SIN CATEGORÍA"))).sort();
    selectCat.innerHTML = `<option value="">Todas las categorías (${cats.length})</option>` +
      cats.map((c) => `<option value="${c}">${c}</option>`).join("");
  }

  function filtrarLista() {
    const q = inputBusq.value.trim().toLowerCase();
    const cat = selectCat.value;

    return productos.filter((p) => {
      if (soloPendientes && p.contado === true) return false;
      if (cat && (p.categoria || "SIN CATEGORÍA") !== cat) return false;
      if (q) {
        const hay = `${p.codigo || ""} ${p.descripcion || ""} ${p.marca || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function render() {
    actualizarProgreso();
    const filtrados = filtrarLista();

    if (!filtrados.length) {
      listaEl.innerHTML = `
        <div class="ve-card text-center py-10 space-y-1">
          <div class="text-sm font-extrabold text-slate-900">
            ${soloPendientes ? "¡Todo contado en este filtro!" : "Sin coincidencias"}
          </div>
          <p class="text-xs text-slate-500">Prueba cambiando la búsqueda o desactivando "Solo pendientes".</p>
        </div>
      `;
      pagEl.classList.add("hidden");
      return;
    }

    const visibles = filtrados.slice(0, limiteRender);
    listaEl.innerHTML = visibles.map((p) => `
      <div class="ve-card p-3.5 flex flex-wrap items-center justify-between gap-3 ${p.contado ? "border-emerald-200 bg-emerald-50/30" : ""}" data-id="${p.id}">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-mono-ve text-xs font-extrabold text-slate-900">${p.codigo || p.id}</span>
            <span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">${p.marca || "GENÉRICO"}</span>
            <span class="text-[10px] font-bold text-slate-400">${p.categoria || ""}</span>
            ${p.contado ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">✓ Contado</span>` : ""}
          </div>
          <div class="text-xs font-semibold text-slate-700 mt-1">${p.descripcion || ""}</div>
          <div class="text-[11px] text-slate-400 mt-0.5">Planta: <strong class="text-slate-600">${p.stockPlanta ?? 0}</strong></div>
        </div>

        <div class="flex items-center gap-1.5">
          <input
            type="number"
            min="0"
            value="${p.stockAlmacen ?? 0}"
            class="inp-cant w-20 bg-white border border-slate-300 rounded-xl px-2.5 py-2 text-center font-mono-ve text-sm font-extrabold outline-none focus:border-slate-950"
          />
          <button type="button" class="btn-cero px-2.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-extrabold cursor-pointer" title="Confirmar en 0">
            0 ✓
          </button>
          <button type="button" class="btn-guardar px-3.5 py-2 rounded-xl bg-slate-950 hover:bg-slate-800 text-white text-xs font-extrabold cursor-pointer">
            Guardar
          </button>
        </div>
      </div>
    `).join("");

    pagEl.classList.toggle("hidden", filtrados.length <= limiteRender);
  }

  async function guardarConteoItem(id, cantidad, cardEl) {
    const cant = Math.max(0, Math.round(Number(cantidad) || 0));
    const btn = cardEl.querySelector(".btn-guardar");
    btn.disabled = true;
    btn.textContent = "...";

    try {
      await updateDoc(doc(refs.catalogo(), id), {
        stockAlmacen: cant,
        contado: true,
        contadoEn: serverTimestamp()
      });

      const idx = productos.findIndex((p) => p.id === id);
      if (idx >= 0) {
        productos[idx].stockAlmacen = cant;
        productos[idx].contado = true;
      }
      render();
    } catch (err) {
      alert("Error guardando conteo: " + err.message);
      btn.disabled = false;
      btn.textContent = "Guardar";
    }
  }

  listaEl.addEventListener("click", (e) => {
    const card = e.target.closest("[data-id]");
    if (!card) return;
    const id = card.dataset.id;

    if (e.target.closest(".btn-guardar")) {
      const val = card.querySelector(".inp-cant").value;
      guardarConteoItem(id, val, card);
    } else if (e.target.closest(".btn-cero")) {
      guardarConteoItem(id, 0, card);
    }
  });

  async function cargarDatos() {
    listaEl.innerHTML = `<div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">Cargando catálogo...</div>`;
    const snap = await getDocs(refs.catalogo());
    productos = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.descripcion || "").localeCompare(b.descripcion || "", "es"));
    poblarCategorias();
    render();
  }

  btnPend.addEventListener("click", () => {
    soloPendientes = !soloPendientes;
    limiteRender = 60;
    btnPend.className = soloPendientes
      ? "px-3.5 py-2 rounded-xl text-xs font-extrabold bg-slate-950 text-white cursor-pointer"
      : "px-3.5 py-2 rounded-xl text-xs font-extrabold bg-white border border-slate-300 text-slate-700 cursor-pointer";
    render();
  });

  inputBusq.addEventListener("input", () => { limiteRender = 60; render(); });
  selectCat.addEventListener("change", () => { limiteRender = 60; render(); });
  root.querySelector("#btnMasConteo").addEventListener("click", () => { limiteRender += 60; render(); });
  root.querySelector("#btnRecargarConteo").addEventListener("click", cargarDatos);

  await cargarDatos();
}
