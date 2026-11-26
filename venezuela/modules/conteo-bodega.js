// venezuela/modules/conteo-bodega.js
import {
  db,
  getTenantRefs,
  doc,
  getDocs,
  setDoc,
  writeBatch,
  serverTimestamp
} from "../core/db.js";

function normalizarIdProveedor(nombre) {
  return String(nombre || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);

  root.innerHTML = `
    <div class="space-y-4 max-w-6xl mx-auto">
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
            <button id="btnRecargarConteo" type="button" class="px-2.5 py-1.5 rounded-xl bg-white border border-slate-200 text-xs font-bold cursor-pointer">
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

  let productos = [];
  let proveedores = [];
  let provSeleccionado = "";
  let estadoFiltro = "pendientes";
  let modoAgrupacion = "proveedor";

  const chipsEl = root.querySelector("#chipsProveedores");
  const selProvEl = root.querySelector("#selProvConteo");
  const selAgrupEl = root.querySelector("#selAgruparConteo");
  const busqEl = root.querySelector("#busqConteo");
  const listaEl = root.querySelector("#listaConteo");

  function obtenerProveedoresUnicos() {
    const mapa = new Map();
    for (const pr of proveedores) {
      const nom = (pr.nombre || pr.id || "GENERAL").toUpperCase();
      mapa.set(nom, { nombre: nom, total: 0, contados: 0, stockTotal: 0 });
    }
    for (const p of productos) {
      const nom = (p.proveedor || "SIN PROVEEDOR").toUpperCase();
      if (!mapa.has(nom)) {
        mapa.set(nom, { nombre: nom, total: 0, contados: 0, stockTotal: 0 });
      }
      const stat = mapa.get(nom);
      stat.total += 1;
      if (p.contado) stat.contados += 1;
      stat.stockTotal += Number(p.stockAlmacen || 0);
    }
    return Array.from(mapa.values())
      .filter((x) => x.total > 0)
      .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  }

  function renderChipsYSelectProveedores() {
    const stats = obtenerProveedoresUnicos();
    const totalGlobal = productos.length;
    const contadosGlobal = productos.filter((p) => p.contado).length;

    selProvEl.innerHTML =
      `<option value="">Todos los Proveedores (${stats.length})</option>` +
      stats.map((s) => `<option value="${s.nombre}" ${provSeleccionado === s.nombre ? "selected" : ""}>${s.nombre} (${s.contados}/${s.total})</option>`).join("");

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
          <span>${s.nombre}</span>
          <span class="font-mono-ve opacity-85">${s.contados}/${s.total}${completo ? " ✓" : ""}</span>
        </button>
      `;
    }).join("");

    chipsEl.innerHTML = chipTodos + chipsProvs;
  }

  function actualizarBarraProgreso() {
    const universo = provSeleccionado
      ? productos.filter((p) => (p.proveedor || "SIN PROVEEDOR").toUpperCase() === provSeleccionado)
      : productos;

    const total = universo.length;
    const contados = universo.filter((p) => p.contado).length;
    const unidades = universo.reduce((acc, p) => acc + Number(p.stockAlmacen || 0), 0);
    const pct = total ? Math.round((contados / total) * 100) : 0;

    root.querySelector("#subConteo").textContent = provSeleccionado
      ? `Contando proveedor: ${provSeleccionado} • ${total} productos`
      : `Vista global: ${total} productos en almacén`;

    root.querySelector("#txtProgresoConteo").textContent = `${contados} de ${total} revisados (${pct}%)`;
    root.querySelector("#txtUnidadesContadas").textContent = `${unidades} und físicas`;
    root.querySelector("#barProgresoConteo").style.width = `${pct}%`;
  }

  function obtenerFiltrados() {
    const q = busqEl.value.trim().toLowerCase();

    return productos
      .filter((p) => {
        const prov = (p.proveedor || "SIN PROVEEDOR").toUpperCase();
        if (provSeleccionado && prov !== provSeleccionado) return false;

        if (estadoFiltro === "pendientes" && p.contado) return false;
        if (estadoFiltro === "contados" && !p.contado) return false;
        if (estadoFiltro === "con_stock" && Number(p.stockAlmacen || 0) <= 0) return false;

        if (q) {
          const txt = `${p.codigo || ""} ${p.descripcion || ""} ${p.marca || ""} ${p.categoria || ""} ${prov}`.toLowerCase();
          if (!txt.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => (a.descripcion || "").localeCompare(b.descripcion || "", "es"));
  }

  function cardProductoHTML(p) {
    const stockAlm = Math.max(0, Number(p.stockAlmacen || 0));
    const stockPla = Math.max(0, Number(p.stockPlanta || 0));
    const prov = (p.proveedor || "SIN PROVEEDOR").toUpperCase();
    const contado = Boolean(p.contado);

    return `
      <div class="fila-conteo p-3 rounded-xl border transition ${
        contado ? "bg-emerald-50/50 border-emerald-200" : "bg-slate-50 border-slate-200"
      } flex flex-col sm:flex-row sm:items-center justify-between gap-2.5" data-id="${encodeURIComponent(p.id)}">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="font-mono-ve text-xs font-extrabold text-slate-900">${p.codigo || p.id}</span>
            <span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-sky-50 border border-sky-200 text-sky-900">${prov}</span>
            <span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white border border-slate-200 text-slate-600">${p.categoria || "SIN CATEGORÍA"}</span>
            ${contado
              ? `<span class="badge-estado text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">✓ CONTADO</span>`
              : `<span class="badge-estado text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-amber-100 text-amber-900">PENDIENTE</span>`}
          </div>
          <div class="text-xs font-semibold text-slate-800 mt-0.5">${p.descripcion || ""}</div>
          <div class="text-[10px] font-bold text-slate-400 mt-0.5">
            Marca: ${p.marca || "GENÉRICO"} • Ref. Planta: <span class="font-mono-ve text-sky-700">${stockPla}</span> • Costo: <span class="font-mono-ve">$${Number(p.costoUsd || 0).toFixed(2)}</span>
          </div>
        </div>

        <div class="flex items-center justify-between sm:justify-end gap-1.5 shrink-0">
          <div class="flex items-center gap-1">
            <button type="button" class="btn-menos w-8 h-8 rounded-lg bg-white border border-slate-300 text-sm font-extrabold text-slate-800 cursor-pointer">−</button>
            <input type="number" min="0" value="${stockAlm}" class="inp-stock-c w-16 h-8 bg-white border border-slate-300 rounded-lg px-1.5 text-xs font-mono-ve font-extrabold text-center" />
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

  function render() {
    renderChipsYSelectProveedores();
    actualizarBarraProgreso();

    const filtrados = obtenerFiltrados();
    if (!filtrados.length) {
      listaEl.innerHTML = `
        <div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">
          ${estadoFiltro === "pendientes"
            ? "¡Excelente! No quedan productos pendientes en esta vista."
            : "No hay productos que coincidan con este filtro."}
        </div>
      `;
      return;
    }

    const grupos = new Map();
    for (const p of filtrados) {
      const clave = modoAgrupacion === "proveedor"
        ? (p.proveedor || "SIN PROVEEDOR").toUpperCase()
        : (p.categoria || "SIN CATEGORÍA").toUpperCase();
      if (!grupos.has(clave)) grupos.set(clave, []);
      grupos.get(clave).push(p);
    }

    const clavesOrdenadas = Array.from(grupos.keys()).sort((a, b) => a.localeCompare(b, "es"));
    listaEl.innerHTML = clavesOrdenadas.map((clave) => {
      const items = grupos.get(clave);
      const contadosGrupo = items.filter((x) => x.contado).length;
      return `
        <details class="ve-card p-3" open>
          <summary class="cursor-pointer flex items-center justify-between gap-2 text-xs font-extrabold text-slate-900">
            <span>${modoAgrupacion === "proveedor" ? "🏭 " : "📁 "}${clave}</span>
            <span class="px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700 font-mono-ve text-[10px]">
              ${contadosGrupo}/${items.length} contados
            </span>
          </summary>
          <div class="mt-3 space-y-2">
            ${items.slice(0, 100).map(cardProductoHTML).join("")}
            ${items.length > 100 ? `<div class="text-[11px] text-center text-slate-400 font-bold py-1">Mostrando 100 de ${items.length}. Usa el buscador o filtra por proveedor para ir más rápido.</div>` : ""}
          </div>
        </details>
      `;
    }).join("");
  }

  async function guardarConteoItem(prodId, nuevaCantidad, btnEl = null) {
    const prod = productos.find((x) => x.id === prodId);
    if (!prod) return;

    const cant = Math.max(0, Math.round(Number(nuevaCantidad) || 0));
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.textContent = "...";
    }

    try {
      const now = Date.now();
      await setDoc(doc(refs.catalogo(), prod.id), {
        stockAlmacen: cant,
        contado: true,
        ultimoConteoTs: now,
        ultimoConteoPor: state.sesion?.usuario || "Administrador",
        actualizadoEn: serverTimestamp()
      }, { merge: true });

      prod.stockAlmacen = cant;
      prod.contado = true;
      prod.ultimoConteoTs = now;

      render();
    } catch (err) {
      alert("Error guardando conteo: " + err.message);
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.textContent = "Guardar";
      }
    }
  }

  listaEl.addEventListener("click", async (e) => {
    const row = e.target.closest(".fila-conteo");
    if (!row) return;
    const prodId = decodeURIComponent(row.dataset.id || "");
    const inp = row.querySelector(".inp-stock-c");

    if (e.target.closest(".btn-mas")) {
      inp.value = String(Math.max(0, parseInt(inp.value, 10) || 0) + 1);
    } else if (e.target.closest(".btn-menos")) {
      inp.value = String(Math.max(0, (parseInt(inp.value, 10) || 0) - 1));
    } else if (e.target.closest(".btn-cero-ok")) {
      inp.value = "0";
      await guardarConteoItem(prodId, 0, e.target.closest(".btn-cero-ok"));
    } else if (e.target.closest(".btn-guardar-c")) {
      await guardarConteoItem(prodId, inp.value, e.target.closest(".btn-guardar-c"));
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
      ? productos.filter((p) => (p.proveedor || "SIN PROVEEDOR").toUpperCase() === provSeleccionado && p.contado)
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
      const LOTE = 400;
      for (let i = 0; i < objetivo.length; i += LOTE) {
        const slice = objetivo.slice(i, i + LOTE);
        const batch = writeBatch(db);
        for (const p of slice) {
          batch.set(doc(colRef, p.id), { contado: false, actualizadoEn: serverTimestamp() }, { merge: true });
          p.contado = false;
        }
        await batch.commit();
      }
      render();
      alert(`Listo: ${objetivo.length} producto(s) quedaron pendientes para el nuevo ciclo de conteo.`);
    } catch (err) {
      alert("Error al reiniciar ciclo: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "↻ Nuevo ciclo";
    }
  });

  async function cargarConteo() {
    const [snapCat, snapProv] = await Promise.all([
      getDocs(refs.catalogo()),
      getDocs(refs.proveedores())
    ]);
    productos = snapCat.docs.map((d) => ({ id: d.id, ...d.data() }));
    proveedores = snapProv.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));

    render();
  }

  busqEl.addEventListener("input", render);
  root.querySelector("#btnRecargarConteo").addEventListener("click", cargarConteo);

  await cargarConteo();
}
