// venezuela/modules/analitica.js
import { getTenantRefs, getDocs } from "../core/db.js";
import { imprimirDocumentoCarta } from "./documentos-pdf.js";

function hoyIso() {
  return new Date().toISOString().slice(0, 10);
}

function haceDiasIso(dias) {
  return new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
}

async function cargarChartJS() {
  if (window.Chart) return window.Chart;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("No se pudo cargar Chart.js"));
    document.head.appendChild(s);
  });
  return window.Chart;
}

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);

  root.innerHTML = `
    <div class="space-y-4 max-w-6xl mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Analítica & Registro de Caja</h1>
          <p class="text-xs text-slate-500">Consulta cualquier día o rango (hoy, ayer, hace 10 días) con gráficas y arqueo completo.</p>
        </div>
        <div class="flex flex-wrap items-end gap-1.5">
          <div>
            <label class="text-[10px] font-bold text-slate-500 block">Desde</label>
            <input id="anaDesde" type="date" value="${hoyIso()}" class="bg-white border border-slate-300 rounded-xl px-2.5 py-1.5 text-xs font-bold" />
          </div>
          <div>
            <label class="text-[10px] font-bold text-slate-500 block">Hasta</label>
            <input id="anaHasta" type="date" value="${hoyIso()}" class="bg-white border border-slate-300 rounded-xl px-2.5 py-1.5 text-xs font-bold" />
          </div>
          <button type="button" id="btnAnaHoy" class="px-2.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-xs font-extrabold cursor-pointer">Hoy</button>
          <button type="button" id="btnAnaAyer" class="px-2.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-xs font-extrabold cursor-pointer">Ayer</button>
          <button type="button" id="btnAna10d" class="px-2.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-xs font-extrabold cursor-pointer">10d</button>
          <button type="button" id="btnAnaFiltrar" class="px-3.5 py-2 rounded-xl bg-slate-950 text-white text-xs font-extrabold cursor-pointer">Ver Caja</button>
        </div>
      </div>

      <!-- KPIs principales -->
      <div class="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div class="ve-card">
          <div class="text-[10px] font-extrabold text-slate-400">VENTA BRUTA</div>
          <div id="kpiVentas" class="text-xl font-extrabold font-mono-ve mt-1">$0.00</div>
        </div>
        <div class="ve-card">
          <div class="text-[10px] font-extrabold text-slate-400">INVERSIÓN / COSTO</div>
          <div id="kpiCosto" class="text-xl font-extrabold font-mono-ve text-slate-600 mt-1">$0.00</div>
        </div>
        <div class="ve-card border-emerald-200 bg-emerald-50/40">
          <div class="text-[10px] font-extrabold text-emerald-700">GANANCIA NETA</div>
          <div id="kpiUtilidad" class="text-xl font-extrabold font-mono-ve text-emerald-700 mt-1">$0.00</div>
        </div>
        <div class="ve-card">
          <div class="text-[10px] font-extrabold text-slate-400">NOTAS / CLIENTES</div>
          <div id="kpiDocs" class="text-xl font-extrabold font-mono-ve mt-1">0</div>
        </div>
        <div class="ve-card border-amber-200 bg-amber-50/40">
          <div class="text-[10px] font-extrabold text-amber-800">CLIENTES EN CRÉDITO</div>
          <div id="kpiCreditos" class="text-xl font-extrabold font-mono-ve text-amber-800 mt-1">0</div>
        </div>
      </div>

      <!-- Gráficas profesionales -->
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div class="lg:col-span-7 ve-card space-y-2">
          <div class="flex items-center justify-between">
            <h2 class="text-xs font-extrabold uppercase tracking-wider text-slate-500">Venta vs. Costo vs. Ganancia Neta (USD)</h2>
            <span id="margenPromTxt" class="text-[11px] font-extrabold text-emerald-700">Margen: 0%</span>
          </div>
          <div class="relative h-56">
            <canvas id="chartFlujo"></canvas>
          </div>
        </div>

        <div class="lg:col-span-5 ve-card space-y-2">
          <h2 class="text-xs font-extrabold uppercase tracking-wider text-slate-500">Distribución por Método de Pago</h2>
          <div class="relative h-56">
            <canvas id="chartPagos"></canvas>
          </div>
        </div>
      </div>

      <!-- Desglose numérico de métodos de pago + Notas emitidas -->
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div class="lg:col-span-4 ve-card space-y-2 h-fit">
          <h2 class="text-xs font-extrabold uppercase tracking-wider text-slate-500">Arqueo por Método de Pago</h2>
          <div id="desglosePagos" class="space-y-1.5 text-xs">
            <div class="text-slate-400 py-4 text-center">Sin pagos registrados.</div>
          </div>
        </div>

        <div class="lg:col-span-8 space-y-2">
          <h2 class="text-xs font-extrabold uppercase tracking-wider text-slate-500 px-1">Registro de Notas de Entrega del Período</h2>
          <div id="viewNotas" class="space-y-2"></div>
        </div>
      </div>
    </div>
  `;

  let todasNotas = [];
  let chartFlujoInst = null;
  let chartPagosInst = null;

  const desdeEl = root.querySelector("#anaDesde");
  const hastaEl = root.querySelector("#anaHasta");
  const viewNotas = root.querySelector("#viewNotas");

  async function actualizarGraficas(diasLabels, ventasArr, costoArr, utilArr, metodosLabels, metodosVals) {
    try {
      const Chart = await cargarChartJS();
      const ctxFlujo = root.querySelector("#chartFlujo").getContext("2d");
      const ctxPagos = root.querySelector("#chartPagos").getContext("2d");

      if (chartFlujoInst) chartFlujoInst.destroy();
      if (chartPagosInst) chartPagosInst.destroy();

      chartFlujoInst = new Chart(ctxFlujo, {
        type: "bar",
        data: {
          labels: diasLabels.length ? diasLabels : ["Sin datos"],
          datasets: [
            { label: "Venta ($)", data: ventasArr.length ? ventasArr : [0], backgroundColor: "#0f172a", borderRadius: 6 },
            { label: "Costo ($)", data: costoArr.length ? costoArr : [0], backgroundColor: "#94a3b8", borderRadius: 6 },
            { label: "Ganancia ($)", data: utilArr.length ? utilArr : [0], backgroundColor: "#16a34a", borderRadius: 6 }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } } },
          scales: { y: { beginAtZero: true } }
        }
      });

      const colores = ["#0f172a", "#16a34a", "#0284c7", "#d97706", "#7c3aed", "#db2777", "#0d9488"];
      chartPagosInst = new Chart(ctxPagos, {
        type: "doughnut",
        data: {
          labels: metodosLabels.length ? metodosLabels : ["Sin pagos"],
          datasets: [{
            data: metodosVals.length ? metodosVals : [1],
            backgroundColor: metodosVals.length ? colores : ["#e2e8f0"],
            borderWidth: 2,
            borderColor: "#ffffff"
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } } }
        }
      });
    } catch (e) {
      console.warn("Chart no disponible:", e);
    }
  }

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

    // Clientes únicos con crédito activo en el sistema
    const deudoresSet = new Set();
    for (const n of todasNotas) {
      const saldo = Number(n.saldoPendienteUsd ?? (n.esCredito ? n.totalUsd : 0) ?? 0);
      if (saldo > 0.01) {
        deudoresSet.add(String(n.cliente?.documento || n.cliente?.nombre || n.id).toUpperCase());
      }
    }

    root.querySelector("#kpiVentas").textContent = `$${totalVentas.toFixed(2)}`;
    root.querySelector("#kpiCosto").textContent = `$${totalCosto.toFixed(2)}`;
    root.querySelector("#kpiUtilidad").textContent = `$${totalUtil.toFixed(2)}`;
    root.querySelector("#kpiDocs").textContent = String(notas.length);
    root.querySelector("#kpiCreditos").textContent = String(deudoresSet.size);
    root.querySelector("#margenPromTxt").textContent = `Margen neto: ${margen}%`;

    // Agrupar por día para gráfica
    const porDia = new Map();
    for (const n of notas) {
      const f = n.fechaIso || "Sin fecha";
      if (!porDia.has(f)) porDia.set(f, { venta: 0, costo: 0, util: 0 });
      const row = porDia.get(f);
      const v = Number(n.totalUsd || 0);
      const c = Number(n.costoTotalUsd || 0);
      const u = Number(n.utilidadUsd ?? (v - c));
      row.venta += v;
      row.costo += c;
      row.util += u;
    }
    const diasOrdenados = Array.from(porDia.entries()).sort((a, b) => a[0].localeCompare(b[0]));

    // Métodos de pago
    const porMetodo = new Map();
    for (const n of notas) {
      for (const p of n.pagos || []) {
        const m = p.metodo || "Otro";
        porMetodo.set(m, (porMetodo.get(m) || 0) + Number(p.montoUsd || 0));
      }
      const saldoPend = Number(n.saldoPendienteUsd ?? 0);
      if (saldoPend > 0.01) {
        porMetodo.set("A Crédito (Por Cobrar)", (porMetodo.get("A Crédito (Por Cobrar)") || 0) + saldoPend);
      }
    }
    const metodosOrdenados = Array.from(porMetodo.entries()).sort((a, b) => b[1] - a[1]);

    const desEl = root.querySelector("#desglosePagos");
    if (!metodosOrdenados.length) {
      desEl.innerHTML = `<div class="text-slate-400 py-4 text-center">Sin pagos registrados en esta fecha.</div>`;
    } else {
      desEl.innerHTML = metodosOrdenados.map(([m, val]) => `
        <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 border border-slate-200">
          <span class="font-bold text-slate-700">${m}</span>
          <span class="font-mono-ve font-extrabold text-slate-950">$${val.toFixed(2)}</span>
        </div>
      `).join("");
    }

    if (!notas.length) {
      viewNotas.innerHTML = `<div class="ve-card text-center py-8 text-xs text-slate-500 font-bold">No hay registros de caja para la fecha seleccionada.</div>`;
    } else {
      viewNotas.innerHTML = notas.map((n) => {
        const utilNota = Number(n.utilidadUsd ?? (Number(n.totalUsd || 0) - Number(n.costoTotalUsd || 0)));
        const metTxt = (n.pagos || []).map((p) => `${p.metodo}: $${Number(p.montoUsd || 0).toFixed(2)}`).join(" • ");
        return `
          <div class="ve-card p-3.5 flex flex-wrap items-center justify-between gap-2" data-folio="${n.id}">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-mono-ve text-xs font-extrabold text-slate-950">N° ${n.folio || n.id}</span>
                <span class="text-xs font-bold text-slate-800">${n.cliente?.nombre || "Consumidor Final"}</span>
                <span class="text-[10px] font-bold text-slate-400">${n.fechaIso || ""}</span>
                ${n.esCredito && Number(n.saldoPendienteUsd || 0) > 0.01 ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">Crédito $${Number(n.saldoPendienteUsd).toFixed(2)}</span>` : ""}
              </div>
              <div class="text-[11px] text-slate-500 mt-0.5">
                Venta: <strong class="text-slate-900">$${Number(n.totalUsd || 0).toFixed(2)}</strong> • Costo: $${Number(n.costoTotalUsd || 0).toFixed(2)} • Ganancia: <strong class="text-emerald-700">$${utilNota.toFixed(2)}</strong>
              </div>
              ${metTxt ? `<div class="text-[10px] font-semibold text-slate-400 mt-0.5">${metTxt}</div>` : ""}
            </div>
            <button type="button" class="btn-reprint px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-xs font-bold cursor-pointer">
              PDF
            </button>
          </div>
        `;
      }).join("");
    }

    actualizarGraficas(
      diasOrdenados.map((d) => d[0].slice(5)),
      diasOrdenados.map((d) => Number(d[1].venta.toFixed(2))),
      diasOrdenados.map((d) => Number(d[1].costo.toFixed(2))),
      diasOrdenados.map((d) => Number(d[1].util.toFixed(2))),
      metodosOrdenados.map((m) => m[0]),
      metodosOrdenados.map((m) => Number(m[1].toFixed(2)))
    );
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

  root.querySelector("#btnAnaHoy").addEventListener("click", () => {
    desdeEl.value = hoyIso();
    hastaEl.value = hoyIso();
    render();
  });

  root.querySelector("#btnAnaAyer").addEventListener("click", () => {
    const ayer = haceDiasIso(1);
    desdeEl.value = ayer;
    hastaEl.value = ayer;
    render();
  });

  root.querySelector("#btnAna10d").addEventListener("click", () => {
    desdeEl.value = haceDiasIso(10);
    hastaEl.value = hoyIso();
    render();
  });

  root.querySelector("#btnAnaFiltrar").addEventListener("click", render);

  const snapNotas = await getDocs(refs.notasEntrega());
  todasNotas = snapNotas.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.creadoTs || 0) - (a.creadoTs || 0));
  render();
}
