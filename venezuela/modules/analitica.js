// venezuela/modules/analitica.js
import { getTenantRefs, getDocs } from "../core/db.js";
import { imprimirDocumentoCarta } from "./documentos-pdf.js";

const DIAS_30_MS = 30 * 24 * 60 * 60 * 1000;

function hoyIso() {
  return new Date().toISOString().slice(0, 10);
}

function haceDiasIso(dias) {
  return new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
}

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);

  root.innerHTML = `
    <div class="space-y-4 max-w-6xl mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Analítica & Cierre de Caja</h1>
          <p class="text-xs text-slate-500">Arqueo multimoneda, utilidad neta real y radar de inventario estancado.</p>
        </div>
        <div class="flex flex-wrap items-end gap-2">
          <div>
            <label class="text-[10px] font-bold text-slate-500 block">Desde</label>
            <input id="anaDesde" type="date" value="${haceDiasIso(7)}" class="bg-white border border-slate-300 rounded-xl px-2.5 py-1.5 text-xs font-bold" />
          </div>
          <div>
            <label class="text-[10px] font-bold text-slate-500 block">Hasta</label>
            <input id="anaHasta" type="date" value="${hoyIso()}" class="bg-white border border-slate-300 rounded-xl px-2.5 py-1.5 text-xs font-bold" />
          </div>
          <button id="btnAnaHoy" class="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-xs font-extrabold cursor-pointer">Hoy</button>
          <button id="btnAnaFiltrar" class="px-3.5 py-2 rounded-xl bg-slate-950 text-white text-xs font-extrabold cursor-pointer">Aplicar</button>
        </div>
      </div>

      <!-- KPIs -->
      <div id="kpiGrid" class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div class="ve-card"><div class="text-[10px] font-extrabold text-slate-400">VENTAS BRUTAS</div><div id="kpiVentas" class="text-xl font-extrabold font-mono-ve mt-1">$0.00</div></div>
        <div class="ve-card"><div class="text-[10px] font-extrabold text-slate-400">COSTO MERCANCÍA</div><div id="kpiCosto" class="text-xl font-extrabold font-mono-ve text-slate-600 mt-1">$0.00</div></div>
        <div class="ve-card border-emerald-200 bg-emerald-50/40"><div class="text-[10px] font-extrabold text-emerald-700">UTILIDAD NETA</div><div id="kpiUtilidad" class="text-xl font-extrabold font-mono-ve text-emerald-700 mt-1">$0.00</div></div>
        <div class="ve-card"><div class="text-[10px] font-extrabold text-slate-400">NOTAS EMITIDAS</div><div id="kpiDocs" class="text-xl font-extrabold font-mono-ve mt-1">0</div></div>
      </div>

      <!-- Gráfica de ventas diarias + Cierre por método de pago -->
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div class="lg:col-span-7 ve-card space-y-3">
          <div class="flex items-center justify-between">
            <h2 class="text-xs font-extrabold uppercase tracking-wider text-slate-500">Flujo Diario (USD)</h2>
            <span id="margenPromTxt" class="text-[11px] font-extrabold text-emerald-700">Margen: 0%</span>
          </div>
          <div id="graficaBarras" class="h-44 flex items-end gap-2 pt-4 pb-1 px-1 overflow-x-auto">
            <div class="text-xs text-slate-400 m-auto">Sin ventas en este período.</div>
          </div>
        </div>

        <div class="lg:col-span-5 ve-card space-y-2">
          <h2 class="text-xs font-extrabold uppercase tracking-wider text-slate-500">Cierre por Método de Pago</h2>
          <div id="desglosePagos" class="space-y-1.5 text-xs">
            <div class="text-slate-400 py-4 text-center">Sin pagos registrados.</div>
          </div>
        </div>
      </div>

      <!-- Tabs: Notas Emitidas / Estancados (+30d) -->
      <div class="flex gap-1.5">
        <button id="tabNotas" class="px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-950 text-white cursor-pointer">Notas Emitidas</button>
        <button id="tabEstancados" class="px-3 py-1.5 rounded-xl text-xs font-extrabold bg-white border border-slate-200 text-slate-700 cursor-pointer">Radar Estancados (+30d)</button>
      </div>

      <div id="viewNotas" class="space-y-2"></div>
      <div id="viewEstancados" class="hidden space-y-2"></div>
    </div>
  `;

  let todasNotas = [];
  let catalogo = [];

  const desdeEl = root.querySelector("#anaDesde");
  const hastaEl = root.querySelector("#anaHasta");
  const viewNotas = root.querySelector("#viewNotas");
  const viewEst = root.querySelector("#viewEstancados");

  function render() {
    const desde = desdeEl.value;
    const hasta = hastaEl.value;

    const notas = todasNotas.filter((n) => {
      const f = n.fechaIso || "";
      if (desde && f < desde) return false;
      if (hasta && f > hasta) return false;
      return true;
    });

    const totalVentas = notas.reduce((a, n) => a + Number(n.totalUsd || 0), 0);
    const totalCosto = notas.reduce((a, n) => a + Number(n.costoTotalUsd || 0), 0);
    const totalUtil = notas.reduce((a, n) => a + Number(n.utilidadUsd ?? (Number(n.totalUsd || 0) - Number(n.costoTotalUsd || 0))), 0);
    const margen = totalVentas > 0 ? ((totalUtil / totalVentas) * 100).toFixed(1) : "0.0";

    root.querySelector("#kpiVentas").textContent = `$${totalVentas.toFixed(2)}`;
    root.querySelector("#kpiCosto").textContent = `$${totalCosto.toFixed(2)}`;
    root.querySelector("#kpiUtilidad").textContent = `$${totalUtil.toFixed(2)}`;
    root.querySelector("#kpiDocs").textContent = String(notas.length);
    root.querySelector("#margenPromTxt").textContent = `Margen neto: ${margen}%`;

    // Gráfica por día
    const porDia = new Map();
    for (const n of notas) {
      const f = n.fechaIso || "Sin fecha";
      porDia.set(f, (porDia.get(f) || 0) + Number(n.totalUsd || 0));
    }
    const dias = Array.from(porDia.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const maxVal = Math.max(1, ...dias.map((d) => d[1]));

    const grafEl = root.querySelector("#graficaBarras");
    if (!dias.length) {
      grafEl.innerHTML = `<div class="text-xs text-slate-400 m-auto">Sin ventas en este período.</div>`;
    } else {
      grafEl.innerHTML = dias.map(([fecha, val]) => {
        const h = Math.max(8, Math.round((val / maxVal) * 100));
        return `
          <div class="flex-1 min-w-[44px] flex flex-col items-center gap-1 h-full justify-end">
            <div class="text-[10px] font-mono-ve font-extrabold text-slate-700">$${val.toFixed(0)}</div>
            <div class="w-full max-w-[36px] rounded-t-lg bg-emerald-600 transition-all" style="height:${h}%"></div>
            <div class="text-[9px] font-bold text-slate-400">${fecha.slice(5)}</div>
          </div>
        `;
      }).join("");
    }

    // Desglose por método de pago
    const porMetodo = new Map();
    for (const n of notas) {
      for (const p of n.pagos || []) {
        const m = p.metodo || "Otro";
        porMetodo.set(m, (porMetodo.get(m) || 0) + Number(p.montoUsd || 0));
      }
    }
    const metodos = Array.from(porMetodo.entries()).sort((a, b) => b[1] - a[1]);
    const desEl = root.querySelector("#desglosePagos");
    if (!metodos.length) {
      desEl.innerHTML = `<div class="text-slate-400 py-4 text-center">Sin pagos registrados.</div>`;
    } else {
      desEl.innerHTML = metodos.map(([m, val]) => `
        <div class="flex items-center justify-between p-2 rounded-xl bg-slate-50 border border-slate-200">
          <span class="font-bold text-slate-700">${m}</span>
          <span class="font-mono-ve font-extrabold text-slate-950">$${val.toFixed(2)}</span>
        </div>
      `).join("");
    }

    // Lista de Notas Emitidas
    if (!notas.length) {
      viewNotas.innerHTML = `<div class="ve-card text-center py-8 text-xs text-slate-500 font-bold">No hay Notas de Entrega en este rango.</div>`;
    } else {
      viewNotas.innerHTML = notas.map((n) => `
        <div class="ve-card p-3.5 flex flex-wrap items-center justify-between gap-2" data-folio="${n.id}">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-mono-ve text-xs font-extrabold text-slate-950">N° ${n.folio || n.id}</span>
              <span class="text-xs font-bold text-slate-800">${n.cliente?.nombre || "Consumidor Final"}</span>
              <span class="text-[10px] font-bold text-slate-400">${n.fechaIso || ""}</span>
            </div>
            <div class="text-[11px] text-slate-500 mt-0.5">
              ${n.items?.length || 0} ítems • Venta: <strong class="text-slate-900">$${Number(n.totalUsd || 0).toFixed(2)}</strong> • Utilidad: <strong class="text-emerald-700">$${Number(n.utilidadUsd || 0).toFixed(2)}</strong>
            </div>
          </div>
          <button type="button" class="btn-reprint px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-xs font-bold cursor-pointer">
            Reimprimir PDF
          </button>
        </div>
      `).join("");
    }

    // Radar de Estancados (+30 días con stock en Almacén)
    const corte = Date.now() - DIAS_30_MS;
    const estancados = catalogo
      .filter((p) => (p.stockAlmacen || 0) > 0 && (!p.ultimaVentaTs || p.ultimaVentaTs < corte))
      .sort((a, b) => ((b.stockAlmacen || 0) * (b.costoUsd || 0)) - ((a.stockAlmacen || 0) * (a.costoUsd || 0)));

    if (!estancados.length) {
      viewEst.innerHTML = `<div class="ve-card text-center py-8 text-xs text-emerald-700 font-bold">¡Excelente! No hay mercancía estancada (+30 días) en Almacén.</div>`;
    } else {
      const capitalInmovilizado = estancados.reduce((acc, p) => acc + (p.stockAlmacen || 0) * (p.costoUsd || 0), 0);
      viewEst.innerHTML = `
        <div class="ve-card bg-amber-50 border-amber-200 flex items-center justify-between text-xs font-extrabold text-amber-900">
          <span>${estancados.length} productos con stock en Almacén sin ventas en +30 días</span>
          <span class="font-mono-ve">Capital: $${capitalInmovilizado.toFixed(2)}</span>
        </div>
      ` + estancados.slice(0, 80).map((p) => `
        <div class="ve-card p-3 flex items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="font-mono-ve text-xs font-extrabold text-slate-900">${p.codigo || p.id}</div>
            <div class="text-xs text-slate-600 truncate">${p.descripcion || ""}</div>
          </div>
          <div class="text-right shrink-0">
            <div class="text-xs font-extrabold text-amber-700">Stock: ${p.stockAlmacen}</div>
            <div class="text-[10px] font-mono-ve text-slate-500">Costo: $${((p.stockAlmacen || 0) * (p.costoUsd || 0)).toFixed(2)}</div>
          </div>
        </div>
      `).join("");
    }
  }

  viewNotas.addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-reprint");
    if (!btn) return;
    const id = btn.closest("[data-folio]").dataset.folio;
    const nota = todasNotas.find((n) => n.id === id);
    if (!nota) return;
    imprimirDocumentoCarta({
      tipo: "NOTA DE ENTREGA",
      folio: nota.folio || nota.id,
      empresa: state.empresa,
      cliente: nota.cliente || {},
      items: nota.items || [],
      totalUsd: nota.totalUsd || 0,
      monedas: nota.monedas || ["USD", "BS"],
      tasas: { bcvActiva: nota.tasaBcvUsada || state.tasas?.bcvHoy || 0, eur: state.tasas?.eur || 0, usdt: state.tasas?.usdt || 0 },
      pagos: nota.pagos || [],
      fecha: nota.fechaIso || ""
    });
  });

  const tabNotas = root.querySelector("#tabNotas");
  const tabEst = root.querySelector("#tabEstancados");
  tabNotas.addEventListener("click", () => {
    viewNotas.classList.remove("hidden");
    viewEst.classList.add("hidden");
    tabNotas.className = "px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-950 text-white cursor-pointer";
    tabEst.className = "px-3 py-1.5 rounded-xl text-xs font-extrabold bg-white border border-slate-200 text-slate-700 cursor-pointer";
  });
  tabEst.addEventListener("click", () => {
    viewNotas.classList.add("hidden");
    viewEst.classList.remove("hidden");
    tabEst.className = "px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-950 text-white cursor-pointer";
    tabNotas.className = "px-3 py-1.5 rounded-xl text-xs font-extrabold bg-white border border-slate-200 text-slate-700 cursor-pointer";
  });

  root.querySelector("#btnAnaHoy").addEventListener("click", () => {
    desdeEl.value = hoyIso();
    hastaEl.value = hoyIso();
    render();
  });
  root.querySelector("#btnAnaFiltrar").addEventListener("click", render);

  const [snapNotas, snapCat] = await Promise.all([getDocs(refs.notasEntrega()), getDocs(refs.catalogo())]);
  todasNotas = snapNotas.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.creadoTs || 0) - (a.creadoTs || 0));
  catalogo = snapCat.docs.map((d) => ({ id: d.id, ...d.data() }));
  render();
}
