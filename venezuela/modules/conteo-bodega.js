// venezuela/modules/conteo-bodega.js
import {
  db,
  getTenantRefs,
  doc,
  getDocs,
  setDoc,
  writeBatch,
  serverTimestamp,
  obtenerFechaLocalIso
} from "../core/db.js";

const PASO_PAGINA = 100;
const LOTE_BATCH_MAX = 400;

function escaparHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizarGrupo(valor, respaldo) {
  const limpio = String(valor || "").trim().toUpperCase();
  return limpio || respaldo;
}

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);

  root.innerHTML = `
    <div id="conteoWrap" class="space-y-4 max-w-6xl mx-auto">
      <!-- Encabezado y progreso -->
      <div class="ve-card p-3.5 space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 class="text-base font-extrabold text-slate-900">Conteo Digital de Almacén</h1>
            <p id="subConteo" class="text-xs text-slate-500">Cargando inventario...</p>
          </div>
          <div class="flex flex-wrap items-center gap-1.5">
            <button id="btnReiniciarMarcas" type="button" class="px-3 py-1.5 rounded-xl bg-amber-50 hover:bg-amber-100 border border-amber-300 text-amber-900 text-[11px] font-extrabold cursor-pointer">
              ↻ Nuevo ciclo
            </button>
            <button id="btnRecargarConteo" type="button" class="px-2.5 py-1.5 rounded-xl bg-white border border-slate-200 hover:bg-slate-50 text-xs font-bold cursor-pointer" title="Sincronizar con servidor">
              ↻
            </button>
          </div>
        </div>

        <!-- Barra de progreso del proveedor/vista actual -->
        <div class="space-y-1">
          <div class="flex flex-wrap justify-between gap-2 text-[11px] font-extrabold text-slate-700">
            <span id="txtProgresoConteo">0 de 0 revisados (0%)</span>
            <span id="txtUnidadesContadas" class="font-mono-ve text-emerald-700">0 und físicas</span>
          </div>
          <div class="w-full h-2.5 bg-slate-200 rounded-full overflow-hidden">
            <div id="barProgresoConteo" class="h-full bg-emerald-600 transition-all" style="width:0%"></div>
          </div>
        </div>

        <!-- Selector rápido por Proveedor (chips con avance) -->
        <div class="space-y-1.5 pt-1 border-t border-slate-100">
          <div class="text-[10px] font-extrabold uppercase tracking-wider text-slate-400">
            Control por Proveedor (toca uno para contar su lista)
          </div>
          <div id="chipsProveedores" class="flex flex-wrap gap-1.5"></div>
        </div>
      </div>

      <!-- Buscador, agrupación y filtros de estado -->
      <div class="ve-card p-3 space-y-2.5">
        <div class="grid grid-cols-1 sm:grid-cols-12 gap-2">
          <input id="busqConteo" type="text" placeholder="Buscar por código, medida, descripción o marca..." class="sm:col-span-6 bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold outline-none focus:border-slate-950" />
          <select id="selProvConteo" class="sm:col-span-3 bg-slate-50 border border-slate-300 rounded-xl px-2.5 py-2 text-xs font-bold">
            <option value="">Todos los Proveedores</option>
          </select>
          <select id="selAgruparConteo" class="sm:col-span-3 bg-slate-50 border border-slate-300 rounded-xl px-2.5 py-2 text-xs font-bold">
            <option value="proveedor">Agrupar por Proveedor</option>
            <option value="categoria">Agrupar por Categoría</option>
          </select>
        </div>

        <div class="flex flex-wrap gap-1.5" id="filtrosEstadoConteo">
          <button type="button" data-est="pendientes" class="btn-est-c px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-950 text-white cursor-pointer">Pendientes</button>
          <button type="button" data-est="todos" class="btn-est-c px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-100 text-slate-700 cursor-pointer">Todos</button>
          <button type="button" data-est="contados" class="btn-est-c px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-100 text-slate-700 cursor-pointer">Contados ✓</button>
          <button type="button" data-est="con_stock" class="btn-est-c px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-100 text-slate-700 cursor-pointer">Con Stock (&gt;0)</button>
        </div>
      </div>

      <!-- Lista de conteo -->
      <div id="listaConteo" class="space-y-2.5">
        <div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">Cargando productos para conteo...</div>
      </div>
    </div>
  `;

  const wrapEl = root.querySelector("#conteoWrap");
  let productos = [];
  let proveedores = [];
  let provSeleccionado = "";
  let estadoFiltro = "pendientes";
  let modoAgrupacion = "proveedor";
  let cargando = false;

  const guardandoIds = new Set();
  const borradoresStock = new Map();
  const gruposCerrados = new Set();
  const limitesPorGrupo = new Map();

  const chipsEl = root.querySelector("#chipsProveedores");
  const selProvEl = root.querySelector("#selProvConteo");
  const selAgrupEl = root.querySelector("#selAgruparConteo");
  const busqEl = root.querySelector("#busqConteo");
  const listaEl = root.querySelector("#listaConteo");
  const btnRecargarEl = root.querySelector("#btnRecargarConteo");

  function claveGrupoDeProducto(p) {
    return modoAgrupacion === "proveedor"
      ? normalizarGrupo(p.proveedor, "SIN PROVEEDOR")
      : normalizarGrupo(p.categoria, "SIN CATEGORÍA");
  }

  function obtenerProveedoresUnicos() {
    const mapa = new Map();
    for (const pr of proveedores) {
      const nom = normalizarGrupo(pr.nombre || pr.id, "GENERAL");
      if (!mapa.has(nom)) {
        mapa.set(nom, { nombre: nom, total: 0, contados: 0, stockTotal: 0 });
      }
    }
    for (const p of productos) {
      const nom = normalizarGrupo(p.proveedor, "SIN PROVEEDOR");
      if (!mapa.has(nom)) {
        mapa.set(nom, { nombre: nom, total: 0, contados: 0, stockTotal: 0 });
      }
      const stat = mapa.get(nom);
      stat.total += 1;
      if (p.contado) stat.contados += 1;
      stat.stockTotal += Math.max(0, Number(p.stockAlmacen || 0));
    }
    return Array.from(mapa.values())
      .filter((x) => x.total > 0)
      .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  }

  function renderChipsYSelectProveedores() {
    const stats = obtenerProveedoresUnicos();
    const totalGlobal = productos.length;
    const contadosGlobal = productos.filter((p) => p.contado).length;

    if (provSeleccionado && !stats.some((s) => s.nombre === provSeleccionado)) {
      provSeleccionado = "";
    }

    selProvEl.innerHTML =
      `<option value="">Todos los Proveedores (${stats.length})</option>` +
      stats.map((s) => {
        const nomEsc = escaparHtml(s.nombre);
        return `<option value="${nomEsc}" ${provSeleccionado === s.nombre ? "selected" : ""}>${nomEsc} (${s.contados}/${s.total})</option>`;
      }).join("");

    const chipTodos = `
      <button type="button" data-prov="" class="btn-chip-prov px-3 py-1.5 rounded-xl text-[11px] font-extrabold cursor-pointer transition ${
        !provSeleccionado
          ? "bg-slate-950 text-white"
          : "bg-slate-100 text-slate-700 hover:bg-slate-200"
      }">
        Todos (${contadosGlobal}/${totalGlobal})
      </button>
    `;

    const chipsProvs = stats.map((s) => {
      const act = provSeleccionado === s.nombre;
      const completo = s.total > 0 && s.contados === s.total;
      return `
        <button type="button" data-prov="${encodeURIComponent(s.nombre)}" class="btn-chip-prov px-3 py-1.5 rounded-xl text-[11px] font-extrabold cursor-pointer transition flex items-center gap-1.5 ${
          act
            ? "bg-sky-900 text-white"
            : (completo
              ? "bg-emerald-50 border border-emerald-300 text-emerald-900 hover:bg-emerald-100"
              : "bg-white border border-slate-300 text-slate-800 hover:bg-slate-50")
        }">
          <span>${escaparHtml(s.nombre)}</span>
          <span class="font-mono-ve opacity-85">${s.contados}/${s.total}${completo ? " ✓" : ""}</span>
        </button>
      `;
    }).join("");

    chipsEl.innerHTML = chipTodos + chipsProvs;
  }

  function actualizarBarraProgreso() {
    const universo = provSeleccionado
      ? productos.filter((p) => normalizarGrupo(p.proveedor, "SIN PROVEEDOR") === provSeleccionado)
      : productos;

    const total = universo.length;
    const contados = universo.filter((p) => p.contado).length;
    const unidades = universo.reduce((acc, p) => acc + Math.max(0, Number(p.stockAlmacen || 0)), 0);
    const pct = total ? Math.round((contados / total) * 100) : 0;

    root.querySelector("#subConteo").textContent = provSeleccionado
      ? `Contando proveedor: ${provSeleccionado} • ${total} productos`
      : `Vista global: ${total} productos en almacén`;

    root.querySelector("#txtProgresoConteo").textContent = `${contados} de ${total} revisados (${pct}%)`;
    root.querySelector("#txtUnidadesContadas").textContent = `${unidades} und físicas`;
    root.querySelector("#barProgresoConteo").style.width = `${pct}%`;
  }

  function cumpleFiltroProducto(p) {
    const q = busqEl.value.trim().toLowerCase();
    const prov = normalizarGrupo(p.proveedor, "SIN PROVEEDOR");
    if (provSeleccionado && prov !== provSeleccionado) return false;

    if (estadoFiltro === "pendientes" && p.contado) return false;
    if (estadoFiltro === "contados" && !p.contado) return false;
    if (estadoFiltro === "con_stock" && Number(p.stockAlmacen || 0) <= 0) return false;

    if (q) {
      const txt = `${p.codigo || ""} ${p.descripcion || ""} ${p.marca || ""} ${p.categoria || ""} ${prov}`.toLowerCase();
      if (!txt.includes(q)) return false;
    }
    return true;
  }

  function obtenerFiltrados() {
    return productos
      .filter(cumpleFiltroProducto)
      .sort((a, b) => String(a.descripcion || "").localeCompare(String(b.descripcion || ""), "es"));
  }

  function cardProductoHTML(p) {
    const stockAlm = Math.max(0, Number(p.stockAlmacen || 0));
    const stockPla = Math.max(0, Number(p.stockPlanta || 0));
    const prov = normalizarGrupo(p.proveedor, "SIN PROVEEDOR");
    const cat = normalizarGrupo(p.categoria, "SIN CATEGORÍA");
    const contado = Boolean(p.contado);
    const valorInput = borradoresStock.has(p.id) ? borradoresStock.get(p.id) : String(stockAlm);
    const editado = borradoresStock.has(p.id) && String(borradoresStock.get(p.id)) !== String(stockAlm);

    return `
      <div class="fila-conteo p-3 rounded-xl border transition ${
        contado ? "bg-emerald-50/50 border-emerald-200" : "bg-slate-50 border-slate-200"
      } flex flex-col sm:flex-row sm:items-center justify-between gap-2.5" data-id="${encodeURIComponent(p.id)}">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="font-mono-ve text-xs font-extrabold text-slate-900">${escaparHtml(p.codigo || p.id)}</span>
            <span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-sky-50 border border-sky-200 text-sky-900">${escaparHtml(prov)}</span>
            <span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white border border-slate-200 text-slate-600">${escaparHtml(cat)}</span>
            ${contado
              ? `<span class="badge-estado text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">✓ CONTADO</span>`
              : `<span class="badge-estado text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-amber-100 text-amber-900">PENDIENTE</span>`}
          </div>
          <div class="text-xs font-semibold text-slate-800 mt-0.5">${escaparHtml(p.descripcion || "")}</div>
          <div class="text-[10px] font-bold text-slate-400 mt-0.5">
            Marca: ${escaparHtml(p.marca || "GENÉRICO")} • Ref. Planta: <span class="font-mono-ve text-sky-700">${stockPla}</span> • Costo: <span class="font-mono-ve">$${Number(p.costoUsd || 0).toFixed(2)}</span>
          </div>
        </div>

        <div class="flex items-center justify-between sm:justify-end gap-1.5 shrink-0">
          <div class="flex items-center gap-1">
            <button type="button" class="btn-menos w-8 h-8 rounded-lg bg-white border border-slate-300 text-sm font-extrabold text-slate-800 cursor-pointer">−</button>
            <input type="number" inputmode="numeric" min="0" value="${escaparHtml(valorInput)}" class="inp-stock-c w-16 h-8 bg-white border ${editado ? "border-amber-400 ring-1 ring-amber-300" : "border-slate-300"} rounded-lg px-1.5 text-xs font-mono-ve font-extrabold text-center" />
            <button type="button" class="btn-mas w-8 h-8 rounded-lg bg-slate-950 text-white text-sm font-extrabold cursor-pointer">+</button>
          </div>
          <button type="button" class="btn-cero-ok px-2.5 h-8 rounded-lg bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 text-[11px] font-extrabold cursor-pointer" title="Confirmar que hay 0 en estante">
            0 ✓
          </button>
          <button type="button" class="btn-guardar-c px-3 h-8 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold cursor-pointer">
            Guardar
          </button>
        </div>
      </div>
    `;
  }

  function renderEstadoVacio() {
    listaEl.innerHTML = `
      <div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">
        ${estadoFiltro === "pendientes"
          ? "¡Excelente! No quedan productos pendientes en esta vista."
          : "No hay productos que coincidan con este filtro."}
      </div>
    `;
  }

  function render() {
    if (!wrapEl.isConnected || !root.isConnected) return;
    renderChipsYSelectProveedores();
    actualizarBarraProgreso();

    const filtrados = obtenerFiltrados();
    if (!filtrados.length) {
      renderEstadoVacio();
      return;
    }

    const grupos = new Map();
    for (const p of filtrados) {
      const clave = claveGrupoDeProducto(p);
      if (!grupos.has(clave)) grupos.set(clave, []);
      grupos.get(clave).push(p);
    }

    const clavesOrdenadas = Array.from(grupos.keys()).sort((a, b) => a.localeCompare(b, "es"));
    listaEl.innerHTML = clavesOrdenadas.map((clave) => {
      const items = grupos.get(clave);
      const contadosGrupo = items.filter((x) => x.contado).length;
      const limite = limitesPorGrupo.get(clave) || PASO_PAGINA;
      const visibles = items.slice(0, limite);
      const restantes = Math.max(0, items.length - visibles.length);
      const abierto = !gruposCerrados.has(clave);

      return `
        <details class="ve-card p-3" data-grupo="${encodeURIComponent(clave)}" ${abierto ? "open" : ""}>
          <summary class="cursor-pointer flex items-center justify-between gap-2 text-xs font-extrabold text-slate-900">
            <span>${modoAgrupacion === "proveedor" ? "🏭 " : "📁 "}${escaparHtml(clave)}</span>
            <span class="badge-conteo-grupo px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700 font-mono-ve text-[10px]">
              ${contadosGrupo}/${items.length} contados
            </span>
          </summary>
          <div class="grupo-items mt-3 space-y-2">
            ${visibles.map(cardProductoHTML).join("")}
          </div>
          ${restantes > 0 ? `
            <div class="wrap-ver-mas pt-2.5 text-center">
              <button type="button" class="btn-ver-mas px-3.5 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-[11px] font-extrabold cursor-pointer" data-grupo="${encodeURIComponent(clave)}">
                Mostrar ${Math.min(PASO_PAGINA, restantes)} más (${restantes} restantes)
              </button>
            </div>
          ` : ""}
        </details>
      `;
    }).join("");
  }

  function actualizarTrasGuardarItem(prod, rowEl) {
    if (!root.isConnected) return;
    renderChipsYSelectProveedores();
    actualizarBarraProgreso();

    const detailsEl = rowEl.closest("details");
    const clave = detailsEl ? decodeURIComponent(detailsEl.dataset.grupo || "") : "";

    if (!cumpleFiltroProducto(prod)) {
      rowEl.remove();
    } else {
      rowEl.outerHTML = cardProductoHTML(prod);
    }

    if (detailsEl && clave) {
      const itemsGrupo = obtenerFiltrados().filter((p) => claveGrupoDeProducto(p) === clave);
      if (!itemsGrupo.length) {
        detailsEl.remove();
      } else {
        const contadosGrupo = itemsGrupo.filter((x) => x.contado).length;
        const badge = detailsEl.querySelector(".badge-conteo-grupo");
        if (badge) badge.textContent = `${contadosGrupo}/${itemsGrupo.length} contados`;

        const visiblesDom = detailsEl.querySelectorAll(".fila-conteo").length;
        const restantes = Math.max(0, itemsGrupo.length - visiblesDom);
        const wrapVerMas = detailsEl.querySelector(".wrap-ver-mas");

        if (restantes > 0) {
          if (wrapVerMas) {
            const btnMas = wrapVerMas.querySelector(".btn-ver-mas");
            if (btnMas) {
              btnMas.textContent = `Mostrar ${Math.min(PASO_PAGINA, restantes)} más (${restantes} restantes)`;
            }
          }
        } else if (wrapVerMas) {
          wrapVerMas.remove();
        }

        if (visiblesDom === 0 && restantes > 0) {
          render();
          return;
        }
      }
    }

    if (!listaEl.querySelector("details")) {
      renderEstadoVacio();
    }
  }

  function establecerBloqueoFila(rowEl, bloqueada) {
    if (!rowEl) return;
    rowEl.querySelectorAll("button, input").forEach((el) => {
      el.disabled = bloqueada;
    });
  }

  async function guardarConteoItem(prodId, nuevaCantidad, rowEl, btnEl = null) {
    if (guardandoIds.has(prodId)) return;
    const prod = productos.find((x) => x.id === prodId);
    if (!prod) return;

    const cant = Math.max(0, Math.round(Number(nuevaCantidad) || 0));
    const textoOriginal = btnEl ? btnEl.textContent : "";

    guardandoIds.add(prodId);
    establecerBloqueoFila(rowEl, true);
    if (btnEl) btnEl.textContent = "...";

    try {
      const now = Date.now();
      const fechaIso = obtenerFechaLocalIso(now);

      await setDoc(doc(refs.catalogo(), prod.id), {
        stockAlmacen: cant,
        contado: true,
        ultimoConteoTs: now,
        ultimoConteoFechaIso: fechaIso,
        ultimoConteoPor: state.sesion?.usuario || "Administrador",
        actualizadoEn: serverTimestamp()
      }, { merge: true });

      prod.stockAlmacen = cant;
      prod.contado = true;
      prod.ultimoConteoTs = now;
      prod.ultimoConteoFechaIso = fechaIso;
      borradoresStock.delete(prod.id);

      state.parchearStockCatalogo?.([{ id: prod.id, stockAlmacen: cant }]);

      actualizarTrasGuardarItem(prod, rowEl);
    } catch (err) {
      alert("Error guardando conteo: " + err.message);
      if (root.isConnected) {
        establecerBloqueoFila(rowEl, false);
        if (btnEl) btnEl.textContent = textoOriginal;
      }
    } finally {
      guardandoIds.delete(prodId);
    }
  }

  listaEl.addEventListener("toggle", (e) => {
    const details = e.target;
    if (details?.tagName !== "DETAILS") return;
    const clave = decodeURIComponent(details.dataset.grupo || "");
    if (!clave) return;
    if (details.open) gruposCerrados.delete(clave);
    else gruposCerrados.add(clave);
  }, true);

  listaEl.addEventListener("input", (e) => {
    if (!e.target.classList.contains("inp-stock-c")) return;
    const row = e.target.closest(".fila-conteo");
    if (!row) return;
    const prodId = decodeURIComponent(row.dataset.id || "");
    borradoresStock.set(prodId, e.target.value);
    e.target.classList.add("border-amber-400", "ring-1", "ring-amber-300");
    e.target.classList.remove("border-slate-300");
  });

  listaEl.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" || !e.target.classList.contains("inp-stock-c")) return;
    e.preventDefault();
    const row = e.target.closest(".fila-conteo");
    if (!row) return;
    const prodId = decodeURIComponent(row.dataset.id || "");
    await guardarConteoItem(prodId, e.target.value, row, row.querySelector(".btn-guardar-c"));
  });

  listaEl.addEventListener("click", async (e) => {
    if (e.target.closest("#btnReintentarCarga")) {
      await cargarConteo(true, true);
      return;
    }

    const btnVerMas = e.target.closest(".btn-ver-mas");
    if (btnVerMas) {
      const clave = decodeURIComponent(btnVerMas.dataset.grupo || "");
      const actual = limitesPorGrupo.get(clave) || PASO_PAGINA;
      limitesPorGrupo.set(clave, actual + PASO_PAGINA);
      render();
      return;
    }

    const row = e.target.closest(".fila-conteo");
    if (!row) return;
    const prodId = decodeURIComponent(row.dataset.id || "");
    if (guardandoIds.has(prodId)) return;

    const inp = row.querySelector(".inp-stock-c");
    if (!inp) return;

    if (e.target.closest(".btn-mas")) {
      const nuevoVal = String(Math.max(0, parseInt(inp.value, 10) || 0) + 1);
      inp.value = nuevoVal;
      borradoresStock.set(prodId, nuevoVal);
      inp.classList.add("border-amber-400", "ring-1", "ring-amber-300");
      inp.classList.remove("border-slate-300");
    } else if (e.target.closest(".btn-menos")) {
      const nuevoVal = String(Math.max(0, (parseInt(inp.value, 10) || 0) - 1));
      inp.value = nuevoVal;
      borradoresStock.set(prodId, nuevoVal);
      inp.classList.add("border-amber-400", "ring-1", "ring-amber-300");
      inp.classList.remove("border-slate-300");
    } else if (e.target.closest(".btn-cero-ok")) {
      inp.value = "0";
      borradoresStock.set(prodId, "0");
      await guardarConteoItem(prodId, 0, row, e.target.closest(".btn-cero-ok"));
    } else if (e.target.closest(".btn-guardar-c")) {
      await guardarConteoItem(prodId, inp.value, row, e.target.closest(".btn-guardar-c"));
    }
  });

  chipsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-chip-prov");
    if (!btn) return;
    provSeleccionado = decodeURIComponent(btn.dataset.prov || "");
    render();
  });

  selProvEl.addEventListener("change", () => {
    provSeleccionado = selProvEl.value;
    render();
  });

  selAgrupEl.addEventListener("change", () => {
    modoAgrupacion = selAgrupEl.value;
    limitesPorGrupo.clear();
    gruposCerrados.clear();
    render();
  });

  root.querySelector("#filtrosEstadoConteo").addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-est-c");
    if (!btn) return;
    estadoFiltro = btn.dataset.est;
    root.querySelectorAll(".btn-est-c").forEach((b) => {
      const act = b.dataset.est === estadoFiltro;
      b.className = act
        ? "btn-est-c px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-950 text-white cursor-pointer"
        : "btn-est-c px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-100 text-slate-700 cursor-pointer";
    });
    render();
  });

  // Reinicia solo las marcas de "contado" para iniciar un nuevo ciclo de auditoría sin borrar stock
  root.querySelector("#btnReiniciarMarcas").addEventListener("click", async () => {
    const objetivo = provSeleccionado
      ? productos.filter((p) => normalizarGrupo(p.proveedor, "SIN PROVEEDOR") === provSeleccionado && p.contado)
      : productos.filter((p) => p.contado);

    if (!objetivo.length) {
      return alert("No hay productos marcados como contados para reiniciar en esta vista.");
    }

    const etiqueta = provSeleccionado ? `del proveedor ${provSeleccionado}` : "de TODO el almacén";
    if (!confirm(`¿Iniciar un nuevo ciclo de conteo ${etiqueta}?\n\nSe quitará la marca "Contado ✓" a ${objetivo.length} producto(s) para volver a revisarlos (sus cantidades actuales de stock NO se borran).`)) {
      return;
    }

    const btn = root.querySelector("#btnReiniciarMarcas");
    btn.disabled = true;
    btn.textContent = "Reiniciando...";

    try {
      const colRef = refs.catalogo();
      for (let i = 0; i < objetivo.length; i += LOTE_BATCH_MAX) {
        const slice = objetivo.slice(i, i + LOTE_BATCH_MAX);
        const batch = writeBatch(db);
        for (const p of slice) {
          batch.set(doc(colRef, p.id), { contado: false, actualizadoEn: serverTimestamp() }, { merge: true });
        }
        await batch.commit();
        for (const p of slice) {
          p.contado = false;
        }
      }
      render();
      alert(`Listo: ${objetivo.length} producto(s) quedaron pendientes para el nuevo ciclo de conteo.`);
    } catch (err) {
      render();
      alert("Error al reiniciar ciclo: " + err.message);
    } finally {
      if (root.isConnected) {
        btn.disabled = false;
        btn.textContent = "↻ Nuevo ciclo";
      }
    }
  });

  async function cargarConteo(forzar = false, limpiarBorradores = false) {
    if (cargando) return;
    cargando = true;
    btnRecargarEl.disabled = true;
    btnRecargarEl.textContent = "...";

    try {
      const [listaCat, listaProv] = await Promise.all([
        typeof state.obtenerCatalogo === "function"
          ? state.obtenerCatalogo({ forzar })
          : getDocs(refs.catalogo()).then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))),
        typeof state.obtenerProveedores === "function"
          ? state.obtenerProveedores({ forzar })
          : getDocs(refs.proveedores()).then((s) =>
              s.docs.map((d) => ({ id: d.id, ...d.data() }))
                .sort((a, b) => String(a.nombre || "").localeCompare(String(b.nombre || ""), "es"))
            )
      ]);

      if (!root.isConnected) return;

      productos = listaCat;
      proveedores = listaProv;

      if (limpiarBorradores) {
        borradoresStock.clear();
      }
      render();
    } catch (err) {
      if (!root.isConnected) return;
      root.querySelector("#subConteo").textContent = "Error al cargar inventario";
      listaEl.innerHTML = `
        <div class="ve-card text-center py-10 space-y-3">
          <div class="text-xs font-extrabold text-rose-700">No se pudo cargar el inventario para conteo.</div>
          <div class="text-[11px] text-slate-500">${escaparHtml(err?.message || "Verifica tu conexión e intenta de nuevo.")}</div>
          <button id="btnReintentarCarga" type="button" class="px-4 py-2 rounded-xl bg-slate-950 text-white text-xs font-extrabold cursor-pointer">
            Reintentar
          </button>
        </div>
      `;
    } finally {
      cargando = false;
      if (root.isConnected) {
        btnRecargarEl.disabled = false;
        btnRecargarEl.textContent = "↻";
      }
    }
  }

  busqEl.addEventListener("input", render);
  btnRecargarEl.addEventListener("click", () => cargarConteo(true, true));

  await cargarConteo(false, false);
}
