// venezuela/modules/analitica.js
import {
  db,
  getTenantRefs,
  collection,
  doc,
  getDocs,
  writeBatch,
  normalizarIdVE,
  serverTimestamp
} from "../core/db.js";

function getTasaActiva(state) {
  const t = state.tasas || {};
  const bcv = state.modoTasaBCV === "manana" && t.bcvManana ? t.bcvManana : t.bcvHoy;
  return { ...t, bcvActiva: Number(bcv || 0) };
}

function diasEntre(inicioTs, finTs) {
  if (!inicioTs || !finTs) return 0;
  return Math.max(0, (finTs - inicioTs) / 86400000);
}

function formatearFechaHora(ts, fechaIso = "") {
  if (!ts) return fechaIso || "---";
  try {
    return new Intl.DateTimeFormat("es-VE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true
    }).format(new Date(Number(ts)));
  } catch {
    return fechaIso || "---";
  }
}

function inicioRangoTs(filtro, ahora = Date.now()) {
  const d = new Date(ahora);
  if (filtro === "semana") {
    const diaSemana = d.getDay();
    const diffLunes = (diaSemana + 6) % 7;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - diffLunes).getTime();
  }
  if (filtro === "mes") {
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  }
  return 0;
}

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);
  const cierresCol = collection(db, "empresas", state.sesion.tenantId, "cierresCaja");

  root.innerHTML = `
    <div class="space-y-5 max-w-6xl mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Analítica & Cierre de Caja</h1>
          <p class="text-xs text-slate-500">
            Cuadra ventas + abonos por método de pago (incluyendo sobrepagos), cierra caja y evalúa el historial de crédito.
          </p>
        </div>
        <button id="btnCerrarCaja" type="button" class="px-4 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-extrabold cursor-pointer">
          🔒 Cerrar Caja (<span id="cntNotasAbiertas">0</span> notas)
        </button>
      </div>

      <div class="ve-card p-3 flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap gap-1.5" id="filtroRangoBtns">
          <button type="button" data-rango="jornada" class="btn-rango px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-950 text-white cursor-pointer">Jornada Actual</button>
          <button type="button" data-rango="semana" class="btn-rango px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-100 text-slate-700 cursor-pointer">Esta Semana</button>
          <button type="button" data-rango="mes" class="btn-rango px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-100 text-slate-700 cursor-pointer">Este Mes</button>
          <button type="button" data-rango="todo" class="btn-rango px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-100 text-slate-700 cursor-pointer">Todo el Historial</button>
        </div>
        <div id="infoCierreReciente" class="text-[11px] font-bold text-slate-500"></div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div class="ve-card p-4">
          <div class="text-[10px] font-extrabold uppercase text-slate-400">Ventas del Período (USD)</div>
          <div id="kpiVentasUsd" class="font-mono-ve text-xl font-extrabold text-slate-900 mt-1">$0.00</div>
          <div id="kpiVentasBs" class="font-mono-ve text-xs font-bold text-slate-500 mt-0.5">Bs. 0.00</div>
        </div>

        <div class="ve-card p-4">
          <div class="text-[10px] font-extrabold uppercase text-slate-400">Abonos de Facturas Anteriores</div>
          <div id="kpiAbonosUsd" class="font-mono-ve text-xl font-extrabold text-sky-700 mt-1">$0.00</div>
          <div id="kpiAbonosCount" class="text-xs font-bold text-slate-500 mt-0.5">0 abonos en caja</div>
        </div>

        <div class="ve-card p-4">
          <div class="text-[10px] font-extrabold uppercase text-slate-400">Total Ingreso Real en Caja</div>
          <div id="kpiCajaTotalUsd" class="font-mono-ve text-xl font-extrabold text-emerald-700 mt-1">$0.00</div>
          <div id="kpiUtilidadSub" class="text-xs font-bold text-slate-500 mt-0.5">Utilidad: $0.00</div>
        </div>

        <div class="ve-card p-4">
          <div class="text-[10px] font-extrabold uppercase text-slate-400">Cartera a Crédito Activa</div>
          <div id="kpiCreditoUsd" class="font-mono-ve text-xl font-extrabold text-rose-700 mt-1">$0.00</div>
          <div id="kpiClientesCred" class="text-xs font-bold text-slate-500 mt-0.5">0 clientes con crédito</div>
        </div>
      </div>

      <!-- Desglose exacto por Método de Pago -->
      <div class="ve-card p-4 space-y-2.5 border-emerald-200">
        <div>
          <h2 class="text-xs font-extrabold uppercase tracking-wider text-emerald-900">
            Cuadre por Método de Pago (Ventas + Abonos del Período)
          </h2>
          <p class="text-[11px] text-slate-500">
            Exactamente cuánto dinero debe haber en cada cuenta o gaveta física (incluye sobrepagos recibidos).
          </p>
        </div>
        <div id="gridMetodosCaja" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <div class="text-xs text-slate-400 py-3">Sin ingresos registrados en este período.</div>
        </div>
      </div>

      <!-- Detalle exacto de abonos cobrados en caja -->
      <div class="ve-card p-4 space-y-2.5 border-sky-200">
        <div class="flex items-center justify-between gap-2">
          <div>
            <h2 class="text-xs font-extrabold uppercase tracking-wider text-sky-900">
              Abonos Cobrados en Caja (Facturas Pendientes)
            </h2>
            <p class="text-[11px] text-slate-500">
              Cada abono muestra cliente, número de nota pendiente, método de pago, fecha y hora para cuadrar el efectivo/transferencias.
            </p>
          </div>
          <span id="badgeAbonosCaja" class="px-2.5 py-0.5 rounded-full bg-sky-100 text-sky-900 text-[11px] font-extrabold">0</span>
        </div>
        <div id="listaAbonosCaja" class="space-y-1.5 max-h-72 overflow-y-auto">
          <div class="text-xs text-slate-400 py-4 text-center">Sin abonos cobrados en este período.</div>
        </div>
      </div>

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

      <div class="ve-card p-4 space-y-2.5">
        <h2 class="text-xs font-extrabold uppercase tracking-wider text-slate-500">Cierres de Caja Archivados</h2>
        <div id="listaCierres" class="space-y-2">
          <div class="text-xs text-slate-400 py-4 text-center">Sin cierres registrados aún.</div>
        </div>
      </div>
    </div>
  `;

  let rangoActual = "jornada";
  let todasNotas = [];
  let cierres = [];

  function filtrarNotasPorRango(notasRaw) {
    const validas = notasRaw.filter((n) => !n.anulada);
    if (rangoActual === "jornada") return validas.filter((n) => !n.cierreId);
    const desdeTs = inicioRangoTs(rangoActual);
    if (!desdeTs) return validas;
    return validas.filter((n) => Number(n.creadoTs || 0) >= desdeTs);
  }

  function obtenerAbonosEnRango(notasRaw) {
    const desdeTs = rangoActual === "jornada"
      ? (cierres[0]?.cerradoTs || 0)
      : inicioRangoTs(rangoActual);

    const lista = [];
    for (const n of notasRaw) {
      if (n.anulada || !Array.isArray(n.abonos)) continue;
      for (const ab of n.abonos) {
        const ts = Number(ab.ts || 0);
        if (!desdeTs || ts > desdeTs) {
          const monto = Number(ab.montoUsd || 0);
          const sobre = Number(ab.sobrepagoUsd || 0);
          lista.push({
            folio: n.folio || n.id,
            clienteNombre: n.cliente?.nombre || "Consumidor Final",
            clienteDoc: n.cliente?.documento || "",
            montoUsd: monto,
            sobrepagoUsd: sobre,
            totalFisicoUsd: Number((monto + sobre).toFixed(2)),
            metodo: ab.metodo || "Efectivo USD",
            usandoSaldoFavor: Boolean(ab.usandoSaldoFavor),
            fechaHoraTxt: ab.fechaHoraTxt || formatearFechaHora(ts, ab.fechaIso),
            usuario: ab.usuario || "Admin",
            ts
          });
        }
      }
    }
    return lista.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }

  function calcularDesgloseMetodos(notasRango, abonosRango) {
    const mapa = new Map();
    const sumar = (metodo, monto) => {
      const m = metodo || "Efectivo USD";
      const val = Number(monto || 0);
      if (val <= 0) return;
      mapa.set(m, Number(((mapa.get(m) || 0) + val).toFixed(2)));
    };

    for (const n of notasRango) {
      if (Array.isArray(n.pagos)) {
        for (const p of n.pagos) sumar(p.metodo, p.montoUsd);
      }
    }
    for (const a of abonosRango) {
      if (!a.usandoSaldoFavor) sumar(a.metodo, a.totalFisicoUsd);
    }
    return Array.from(mapa.entries()).sort((a, b) => b[1] - a[1]);
  }

  function pintarAnalitica() {
    const ahora = Date.now();
    const tasas = getTasaActiva(state);
    const notasAbiertas = todasNotas.filter((n) => !n.anulada && !n.cierreId);
    root.querySelector("#cntNotasAbiertas").textContent = String(notasAbiertas.length);

    const ultimoCierre = cierres[0];
    root.querySelector("#infoCierreReciente").textContent = ultimoCierre
      ? `Último cierre: ${ultimoCierre.fechaHoraTxt || ultimoCierre.fechaIso || ""} ($${Number(ultimoCierre.totalVentasUsd || 0).toFixed(2)} ventas + $${Number(ultimoCierre.totalAbonosUsd || 0).toFixed(2)} abonos)`
      : "Aún no se ha realizado ningún cierre de caja.";

    const notasRango = filtrarNotasPorRango(todasNotas);
    const abonosRango = obtenerAbonosEnRango(todasNotas);
    const desgloseMetodos = calcularDesgloseMetodos(notasRango, abonosRango);

    const ventasUsd = notasRango.reduce((acc, n) => acc + Number(n.totalUsd || 0), 0);
    const utilidadUsd = notasRango.reduce((acc, n) => acc + Number(n.utilidadUsd || 0), 0);
    const pagosNotasRangoUsd = notasRango.reduce(
      (acc, n) => acc + (Array.isArray(n.pagos) ? n.pagos.reduce((s, p) => s + Number(p.montoUsd || 0), 0) : 0),
      0
    );
    const abonosEfectivoCajaUsd = abonosRango
      .filter((a) => !a.usandoSaldoFavor)
      .reduce((acc, a) => acc + a.totalFisicoUsd, 0);
    const totalCajaRealUsd = Number((pagosNotasRangoUsd + abonosEfectivoCajaUsd).toFixed(2));

    const porCliente = new Map();
    let carteraActivaUsd = 0;

    for (const n of todasNotas) {
      if (n.anulada) continue;
      const saldo = Number(n.saldoPendienteUsd ?? (n.esCredito ? n.totalUsd : 0) ?? 0);
      if (saldo > 0.01) carteraActivaUsd += saldo;

      const fueCredito = Boolean(n.esCredito) || Number(n.diasCredito || 0) > 0 || saldo > 0.01 || (Array.isArray(n.abonos) && n.abonos.length > 0);
      if (!fueCredito) continue;

      const docId = normalizarIdVE(n.cliente?.documento || "") || "V-00000000";
      const nombre = (n.cliente?.nombre || "").trim() || "Consumidor Final";
      const plazo = Math.max(1, Number(n.diasCredito || 15));
      const inicioTs = Number(n.creadoTs || 0);

      let finReferenciaTs = ahora;
      if (saldo <= 0.01) {
        const ultimoAbonoTs = Array.isArray(n.abonos) && n.abonos.length
          ? Math.max(...n.abonos.map((a) => Number(a.ts || 0)))
          : 0;
        finReferenciaTs = Number(n.saldadaTs || ultimoAbonoTs || n.venceTs || inicioTs);
      }

      const diasTomados = diasEntre(inicioTs, finReferenciaTs);
      const diferenciaDias = Number((diasTomados - plazo).toFixed(1));

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

    const peores = evaluados.filter((c) => c.vecesPasado > 0).sort((a, b) => b.scoreAtraso - a.scoreAtraso);
    const mejores = evaluados.filter((c) => c.vecesPasado === 0).sort((a, b) => b.totalCreditoUsd - a.totalCreditoUsd);

    root.querySelector("#kpiVentasUsd").textContent = `$${ventasUsd.toFixed(2)}`;
    root.querySelector("#kpiVentasBs").textContent = tasas.bcvActiva ? `Bs. ${(ventasUsd * tasas.bcvActiva).toFixed(2)}` : "Bs. --";
    root.querySelector("#kpiAbonosUsd").textContent = `$${abonosEfectivoCajaUsd.toFixed(2)}`;
    root.querySelector("#kpiAbonosCount").textContent = `${abonosRango.length} abono(s) registrado(s)`;
    root.querySelector("#kpiCajaTotalUsd").textContent = `$${totalCajaRealUsd.toFixed(2)}`;
    root.querySelector("#kpiUtilidadSub").textContent = `Utilidad: $${utilidadUsd.toFixed(2)} (${notasRango.length} notas)`;
    root.querySelector("#kpiCreditoUsd").textContent = `$${carteraActivaUsd.toFixed(2)}`;
    root.querySelector("#kpiClientesCred").textContent = `${evaluados.length} clientes con crédito`;

    root.querySelector("#gridMetodosCaja").innerHTML = desgloseMetodos.length
      ? desgloseMetodos.map(([met, val]) => `
        <div class="p-3 rounded-xl bg-emerald-50/60 border border-emerald-200 flex items-center justify-between gap-2">
          <span class="text-xs font-extrabold text-slate-800 truncate">${met}</span>
          <span class="font-mono-ve text-sm font-extrabold text-emerald-800">$${val.toFixed(2)}</span>
        </div>
      `).join("")
      : `<div class="text-xs text-slate-400 py-3 col-span-full text-center">Sin ingresos registrados en este período.</div>`;

    root.querySelector("#badgeAbonosCaja").textContent = String(abonosRango.length);
    root.querySelector("#listaAbonosCaja").innerHTML = abonosRango.length
      ? abonosRango.map((a) => `
        <div class="p-2.5 rounded-xl bg-sky-50/70 border border-sky-200 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div class="min-w-0 flex-1">
            <div class="font-extrabold text-slate-900">
              Abono de ${a.clienteNombre} • <span class="font-mono-ve text-sky-900">Nota pendiente #${a.folio}</span>
              ${a.sobrepagoUsd > 0.01 ? `<span class="text-[10px] font-bold text-emerald-700 ml-1">(+$${a.sobrepagoUsd.toFixed(2)} a favor)</span>` : ""}
            </div>
            <div class="text-[11px] text-slate-600 font-mono-ve">
              ${a.fechaHoraTxt} • <strong>${a.metodo}</strong> • por ${a.usuario}
            </div>
          </div>
          <div class="font-mono-ve text-sm font-extrabold text-emerald-700 shrink-0">
            +$${a.totalFisicoUsd.toFixed(2)}
          </div>
        </div>
      `).join("")
      : `<div class="text-xs text-slate-400 py-4 text-center">Sin abonos cobrados en este período.</div>`;

    root.querySelector("#badgePeores").textContent = String(peores.length);
    root.querySelector("#badgeMejores").textContent = String(mejores.length);

    root.querySelector("#listaPeoresClientes").innerHTML = peores.length
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

    root.querySelector("#listaMejoresClientes").innerHTML = mejores.length
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

    root.querySelector("#listaCierres").innerHTML = cierres.length
      ? cierres.slice(0, 10).map((ci) => `
        <div class="p-3 rounded-xl bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div>
            <span class="font-mono-ve font-extrabold text-slate-900">${ci.id}</span>
            <span class="text-slate-500 ml-2">${ci.fechaHoraTxt || ci.fechaIso || ""} • ${ci.cantidadNotas || 0} notas • ${ci.cantidadAbonos || 0} abonos • por ${ci.usuario || "Admin"}</span>
          </div>
          <div class="font-mono-ve font-extrabold text-slate-900">
            Ventas: $${Number(ci.totalVentasUsd || 0).toFixed(2)} • Abonos: <span class="text-sky-700">$${Number(ci.totalAbonosUsd || 0).toFixed(2)}</span>
          </div>
        </div>
      `).join("")
      : `<div class="text-xs text-slate-400 py-4 text-center">Sin cierres registrados aún.</div>`;
  }

  root.querySelector("#filtroRangoBtns").addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-rango");
    if (!btn) return;
    rangoActual = btn.dataset.rango;
    root.querySelectorAll(".btn-rango").forEach((b) => {
      const act = b.dataset.rango === rangoActual;
      b.className = act
        ? "btn-rango px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-950 text-white cursor-pointer"
        : "btn-rango px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-100 text-slate-700 cursor-pointer";
    });
    pintarAnalitica();
  });

  root.querySelector("#btnCerrarCaja").addEventListener("click", async () => {
    const abiertas = todasNotas.filter((n) => !n.anulada && !n.cierreId);
    const abonosAbiertos = obtenerAbonosEnRango(todasNotas);
    if (!abiertas.length && !abonosAbiertos.length) {
      return alert("No hay notas ni abonos abiertos en la jornada actual para cerrar.");
    }

    const totalVentas = abiertas.reduce((acc, n) => acc + Number(n.totalUsd || 0), 0);
    const totalUtilidad = abiertas.reduce((acc, n) => acc + Number(n.utilidadUsd || 0), 0);
    const totalAbonos = abonosAbiertos
      .filter((a) => !a.usandoSaldoFavor)
      .reduce((acc, a) => acc + a.totalFisicoUsd, 0);
    const desglose = Object.fromEntries(calcularDesgloseMetodos(abiertas, abonosAbiertos));

    if (!confirm(`¿Cerrar caja con ${abiertas.length} nota(s) ($${totalVentas.toFixed(2)}) y ${abonosAbiertos.length} abono(s) ($${totalAbonos.toFixed(2)})?`)) {
      return;
    }

    const btn = root.querySelector("#btnCerrarCaja");
    btn.disabled = true;

    try {
      const now = Date.now();
      const cierreId = `CIERRE-${new Date(now).toISOString().slice(0, 10)}-${String(now).slice(-4)}`;
      const fechaHoraTxt = formatearFechaHora(now);

      const batch = writeBatch(db);
      batch.set(doc(cierresCol, cierreId), {
        cierreId,
        fechaIso: new Date(now).toISOString().slice(0, 10),
        fechaHoraTxt,
        cerradoTs: now,
        cantidadNotas: abiertas.length,
        cantidadAbonos: abonosAbiertos.length,
        totalVentasUsd: Number(totalVentas.toFixed(2)),
        totalAbonosUsd: Number(totalAbonos.toFixed(2)),
        totalUtilidadUsd: Number(totalUtilidad.toFixed(2)),
        desgloseMetodos: desglose,
        usuario: state.sesion?.usuario || "Administrador",
        creadoEn: serverTimestamp()
      });

      for (const n of abiertas) {
        batch.set(doc(refs.notasEntrega(), n.id), {
          cierreId,
          cerradoEnTs: now
        }, { merge: true });
      }

      const nuevaJornadaId = new Date(now + 86400000).toISOString().slice(0, 10);
      batch.set(refs.empresaRef, { jornadaActivaId: nuevaJornadaId }, { merge: true });

      await batch.commit();
      if (state.empresa) state.empresa.jornadaActivaId = nuevaJornadaId;

      await cargarDatos();
      alert(`Caja cerrada (${cierreId}). Ventas, abonos y desglose por método quedaron archivados.`);
    } catch (err) {
      alert("Error al cerrar caja: " + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  async function cargarDatos() {
    const [snapNotas, snapCierres] = await Promise.all([
      getDocs(refs.notasEntrega()),
      getDocs(cierresCol)
    ]);
    todasNotas = snapNotas.docs.map((d) => ({ id: d.id, ...d.data() }));
    cierres = snapCierres.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.cerradoTs || 0) - (a.cerradoTs || 0));
    pintarAnalitica();
  }

  await cargarDatos();
}
