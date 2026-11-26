// venezuela/modules/analitica.js
import { getTenantRefs, getDocs, normalizarIdVE } from "../core/db.js";

function getTasaActiva(state) {
  const t = state.tasas || {};
  const bcv = state.modoTasaBCV === "manana" && t.bcvManana ? t.bcvManana : t.bcvHoy;
  return { ...t, bcvActiva: Number(bcv || 0) };
}

function diasEntre(inicioTs, finTs) {
  if (!inicioTs || !finTs) return 0;
  return Math.max(0, (finTs - inicioTs) / 86400000);
}

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);

  root.innerHTML = `
    <div class="space-y-5 max-w-6xl mx-auto">
      <div>
        <h1 class="text-lg font-extrabold text-slate-900">Analítica & Comportamiento de Crédito</h1>
        <p class="text-xs text-slate-500">
          Revisa tus ingresos, utilidad y qué clientes pagan a tiempo o antes vs. quiénes se pasan de los días de crédito.
        </p>
      </div>

      <!-- KPIs generales -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div class="ve-card p-4">
          <div class="text-[10px] font-extrabold uppercase text-slate-400">Ventas Totales (USD)</div>
          <div id="kpiVentasUsd" class="font-mono-ve text-xl font-extrabold text-slate-900 mt-1">$0.00</div>
          <div id="kpiVentasBs" class="font-mono-ve text-xs font-bold text-slate-500 mt-0.5">Bs. 0.00</div>
        </div>

        <div class="ve-card p-4">
          <div class="text-[10px] font-extrabold uppercase text-slate-400">Utilidad Estimada</div>
          <div id="kpiUtilidadUsd" class="font-mono-ve text-xl font-extrabold text-emerald-700 mt-1">$0.00</div>
          <div id="kpiMargenPct" class="text-xs font-bold text-slate-500 mt-0.5">Margen: 0%</div>
        </div>

        <div class="ve-card p-4">
          <div class="text-[10px] font-extrabold uppercase text-slate-400">Cartera a Crédito Activa</div>
          <div id="kpiCreditoUsd" class="font-mono-ve text-xl font-extrabold text-rose-700 mt-1">$0.00</div>
          <div id="kpiClientesCred" class="text-xs font-bold text-slate-500 mt-0.5">0 clientes con crédito</div>
        </div>
      </div>

      <!-- Ranking Mejores vs Peores Pagadores a Crédito -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div class="ve-card p-4 space-y-3 border-rose-200">
          <div class="flex items-center justify-between">
            <div>
              <h2 class="text-xs font-extrabold uppercase tracking-wider text-rose-800">
                Se Pasan de los Días de Crédito (Atrasados / Riesgo)
              </h2>
              <p class="text-[11px] text-slate-500">Ordenados por mayor exceso de días sobre el plazo pactado.</p>
            </div>
            <span id="badgePeores" class="px-2.5 py-0.5 rounded-full bg-rose-100 text-rose-800 text-[11px] font-extrabold">0</span>
          </div>
          <div id="listaPeoresClientes" class="space-y-2 max-h-96 overflow-y-auto">
            <div class="text-xs text-slate-400 py-6 text-center">Analizando historial...</div>
          </div>
        </div>

        <div class="ve-card p-4 space-y-3 border-emerald-200">
          <div class="flex items-center justify-between">
            <div>
              <h2 class="text-xs font-extrabold uppercase tracking-wider text-emerald-800">
                Mejores Clientes (Pagan al Día o Antes)
              </h2>
              <p class="text-[11px] text-slate-500">Cumplen dentro o antes del plazo de días de crédito.</p>
            </div>
            <span id="badgeMejores" class="px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[11px] font-extrabold">0</span>
          </div>
          <div id="listaMejoresClientes" class="space-y-2 max-h-96 overflow-y-auto">
            <div class="text-xs text-slate-400 py-6 text-center">Analizando historial...</div>
          </div>
        </div>
      </div>
    </div>
  `;

  const snapNotas = await getDocs(refs.notasEntrega());
  const notas = snapNotas.docs.map((d) => ({ id: d.id, ...d.data() }));
  const ahora = Date.now();
  const tasas = getTasaActiva(state);

  const ventasUsd = notas.reduce((acc, n) => acc + Number(n.totalUsd || 0), 0);
  const utilidadUsd = notas.reduce((acc, n) => acc + Number(n.utilidadUsd || 0), 0);
  const margen = ventasUsd > 0 ? ((utilidadUsd / ventasUsd) * 100).toFixed(1) : "0.0";

  // Agrupar notas que tuvieron condición de crédito o saldo pendiente
  const porCliente = new Map();
  let carteraActivaUsd = 0;

  for (const n of notas) {
    const saldo = Number(n.saldoPendienteUsd ?? (n.esCredito ? n.totalUsd : 0) ?? 0);
    if (saldo > 0.01) carteraActivaUsd += saldo;

    const fueCredito = Boolean(n.esCredito) || Number(n.diasCredito || 0) > 0 || saldo > 0.01 || (Array.isArray(n.abonos) && n.abonos.length > 0);
    if (!fueCredito) continue;

    const docId = normalizarIdVE(n.cliente?.documento || "") || "V-00000000";
    const nombre = (n.cliente?.nombre || "").trim() || "Consumidor Final";
    const plazo = Math.max(1, Number(n.diasCredito || 15));
    const inicioTs = Number(n.creadoTs || 0);

    // Si ya está saldada, usamos la fecha de saldo o el último abono; si sigue abierta, medimos hasta hoy
    let finReferenciaTs = ahora;
    if (saldo <= 0.01) {
      const ultimoAbonoTs = Array.isArray(n.abonos) && n.abonos.length
        ? Math.max(...n.abonos.map((a) => Number(a.ts || 0)))
        : 0;
      finReferenciaTs = Number(n.saldadaTs || ultimoAbonoTs || n.venceTs || inicioTs);
    }

    const diasTomados = diasEntre(inicioTs, finReferenciaTs);
    const diferenciaDias = Number((diasTomados - plazo).toFixed(1)); // > 0 significa que se pasó del plazo

    if (!porCliente.has(docId)) {
      porCliente.set(docId, {
        documento: docId,
        nombre,
        totalCreditoUsd: 0,
        saldoPendienteUsd: 0,
        operaciones: 0,
        vecesPasado: 0,
        sumaExcesoDias: 0,
        sumaDiasTomados: 0,
        sumaPlazos: 0
      });
    }

    const c = porCliente.get(docId);
    c.totalCreditoUsd += Number(n.totalUsd || 0);
    c.saldoPendienteUsd += saldo;
    c.operaciones += 1;
    c.sumaDiasTomados += diasTomados;
    c.sumaPlazos += plazo;
    if (diferenciaDias > 0.5) {
      c.vecesPasado += 1;
      c.sumaExcesoDias += diferenciaDias;
    }
  }

  const evaluados = Array.from(porCliente.values()).map((c) => {
    const promDias = c.operaciones ? (c.sumaDiasTomados / c.operaciones).toFixed(1) : "0.0";
    const promPlazo = c.operaciones ? (c.sumaPlazos / c.operaciones).toFixed(0) : "15";
    const promExceso = c.vecesPasado ? (c.sumaExcesoDias / c.vecesPasado).toFixed(1) : "0.0";
    const scoreAtraso = c.sumaExcesoDias + (c.saldoPendienteUsd > 0.01 && c.vecesPasado > 0 ? 15 : 0);
    return { ...c, promDias, promPlazo, promExceso, scoreAtraso };
  });

  const peores = evaluados
    .filter((c) => c.vecesPasado > 0)
    .sort((a, b) => b.scoreAtraso - a.scoreAtraso);

  const mejores = evaluados
    .filter((c) => c.vecesPasado === 0)
    .sort((a, b) => b.totalCreditoUsd - a.totalCreditoUsd);

  root.querySelector("#kpiVentasUsd").textContent = `$${ventasUsd.toFixed(2)}`;
  root.querySelector("#kpiVentasBs").textContent = tasas.bcvActiva ? `Bs. ${(ventasUsd * tasas.bcvActiva).toFixed(2)}` : "Bs. --";
  root.querySelector("#kpiUtilidadUsd").textContent = `$${utilidadUsd.toFixed(2)}`;
  root.querySelector("#kpiMargenPct").textContent = `Margen: ${margen}%`;
  root.querySelector("#kpiCreditoUsd").textContent = `$${carteraActivaUsd.toFixed(2)}`;
  root.querySelector("#kpiClientesCred").textContent = `${evaluados.length} clientes con historial a crédito`;

  root.querySelector("#badgePeores").textContent = String(peores.length);
  root.querySelector("#badgeMejores").textContent = String(mejores.length);

  const contPeores = root.querySelector("#listaPeoresClientes");
  const contMejores = root.querySelector("#listaMejoresClientes");

  contPeores.innerHTML = peores.length
    ? peores.map((c) => `
      <div class="p-3 rounded-xl bg-rose-50/60 border border-rose-200 flex items-center justify-between gap-2">
        <div class="min-w-0 flex-1">
          <div class="text-xs font-extrabold text-slate-900 truncate">${c.nombre} <span class="font-mono-ve text-[10px] text-slate-500">(${c.documento})</span></div>
          <div class="text-[11px] text-rose-800 font-semibold mt-0.5">
            Se pasó en <strong>${c.vecesPasado}</strong> de ${c.operaciones} crédito(s) • Prom. exceso: <strong>+${c.promExceso}d</strong> (tarda ~${c.promDias}d vs plazo ${c.promPlazo}d)
          </div>
        </div>
        <div class="text-right shrink-0">
          <div class="font-mono-ve text-xs font-extrabold text-rose-700">$${c.totalCreditoUsd.toFixed(2)}</div>
          ${c.saldoPendienteUsd > 0.01 ? `<div class="font-mono-ve text-[10px] font-bold text-rose-900">Debe: $${c.saldoPendienteUsd.toFixed(2)}</div>` : `<div class="text-[10px] font-bold text-slate-500">Al día hoy</div>`}
        </div>
      </div>
    `).join("")
    : `<div class="text-xs text-slate-400 py-6 text-center">Ningún cliente se ha pasado de sus días de crédito.</div>`;

  contMejores.innerHTML = mejores.length
    ? mejores.map((c) => `
      <div class="p-3 rounded-xl bg-emerald-50/60 border border-emerald-200 flex items-center justify-between gap-2">
        <div class="min-w-0 flex-1">
          <div class="text-xs font-extrabold text-slate-900 truncate">${c.nombre} <span class="font-mono-ve text-[10px] text-slate-500">(${c.documento})</span></div>
          <div class="text-[11px] text-emerald-800 font-semibold mt-0.5">
            <strong>100% puntual</strong> en ${c.operaciones} crédito(s) • Prom. pago: <strong>${c.promDias}d</strong> (plazo ${c.promPlazo}d)
          </div>
        </div>
        <div class="text-right shrink-0">
          <div class="font-mono-ve text-xs font-extrabold text-emerald-800">$${c.totalCreditoUsd.toFixed(2)}</div>
          ${c.saldoPendienteUsd > 0.01 ? `<div class="font-mono-ve text-[10px] font-bold text-amber-800">Pendiente: $${c.saldoPendienteUsd.toFixed(2)}</div>` : `<div class="text-[10px] font-bold text-emerald-700">Pagado</div>`}
        </div>
      </div>
    `).join("")
    : `<div class="text-xs text-slate-400 py-6 text-center">Aún no hay clientes con historial puntual a crédito.</div>`;
}
