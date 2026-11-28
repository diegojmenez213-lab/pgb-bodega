// venezuela/modules/analitica.js
import {
  db,
  getTenantRefs,
  doc,
  getDocs,
  setDoc,
  query,
  where,
  writeBatch,
  normalizarIdVE,
  serverTimestamp,
  obtenerFechaLocalIso
} from "../core/db.js";

const DIAS_90_MS = 90 * 24 * 60 * 60 * 1000;
const LOTE_BATCH_MAX = 400;

const METODOS_PAGO = [
  "Efectivo USD",
  "Pago Móvil Bs.",
  "Transferencia Bs.",
  "Zelle",
  "Binance USDT",
  "Punto de Venta Bs.",
  "Efectivo Bs."
];

function getTasaActiva(state) {
  const t = state.tasas || {};
  const bcv = state.modoTasaBCV === "manana" && t.bcvManana ? t.bcvManana : t.bcvHoy;
  return { ...t, bcvActiva: Number(bcv || 0) };
}

function formatearEntradaMoneda(inputEl) {
  const digitos = String(inputEl.value || "").replace(/\D/g, "");
  const centavos = parseInt(digitos || "0", 10);
  const valor = Number((centavos / 100).toFixed(2));
  const texto = valor.toFixed(2);
  inputEl.value = texto;
  requestAnimationFrame(() => {
    try {
      inputEl.setSelectionRange(texto.length, texto.length);
    } catch {}
  });
  return valor;
}

function fijarCursorAlFinal(inputEl) {
  requestAnimationFrame(() => {
    try {
      const len = inputEl.value.length;
      inputEl.setSelectionRange(len, len);
    } catch {}
  });
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
  if (filtro === "3meses") {
    return ahora - DIAS_90_MS;
  }
  return 0;
}

async function commitOperacionesEnLotes(operaciones) {
  for (let i = 0; i < operaciones.length; i += LOTE_BATCH_MAX) {
    const slice = operaciones.slice(i, i + LOTE_BATCH_MAX);
    const batch = writeBatch(db);
    for (const op of slice) {
      if (op.merge) batch.set(op.ref, op.data, { merge: true });
      else batch.set(op.ref, op.data);
    }
    await batch.commit();
  }
}

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);

  root.innerHTML = `
    <div id="analiticaWrap" class="space-y-5 max-w-6xl mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Analítica & Cierre de Caja</h1>
          <p class="text-xs text-slate-500">
            Cuadre real (Ventas + Abonos − Salidas) por método de pago. Carga rápida de 3 meses con archivo histórico infinito bajo demanda.
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button id="btnToggleGasto" type="button" class="px-3.5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-extrabold cursor-pointer">
            − Salida / Gasto de Caja
          </button>
          <button id="btnCerrarCaja" type="button" class="px-4 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-extrabold cursor-pointer">
            🔒 Cerrar Caja (<span id="cntNotasAbiertas">0</span>)
          </button>
        </div>
      </div>

      <!-- Formulario rápido de Salida / Gasto de Caja -->
      <div id="panelNuevoGasto" class="hidden ve-card border-amber-300 bg-amber-50/70 p-3.5 space-y-2.5">
        <div class="text-xs font-extrabold text-amber-950">Registrar Salida / Gasto de Caja (Delivery, vueltos, compras, vales...)</div>
        <div class="grid grid-cols-1 sm:grid-cols-12 gap-2">
          <select id="gastoMetodo" class="sm:col-span-3 bg-white border border-amber-300 rounded-xl px-2.5 py-2 text-xs font-bold">
            ${METODOS_PAGO.map((m) => `<option value="${m}">${m}</option>`).join("")}
          </select>
          <input id="gastoMonto" type="text" inputmode="numeric" value="0.00" class="sm:col-span-2 bg-white border border-amber-300 rounded-xl px-2.5 py-2 text-xs font-mono-ve font-extrabold text-right" />
          <input id="gastoMotivo" type="text" placeholder="Motivo / Concepto (ej. Delivery cliente, vuelto, compra...)" class="sm:col-span-5 bg-white border border-amber-300 rounded-xl px-3 py-2 text-xs font-bold" />
          <button id="btnGuardarGasto" type="button" class="sm:col-span-2 py-2 rounded-xl bg-slate-950 hover:bg-slate-800 text-white text-xs font-extrabold cursor-pointer">
            Guardar Salida
          </button>
        </div>
      </div>

      <!-- Filtros de período -->
      <div class="ve-card p-3 flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap gap-1.5" id="filtroRangoBtns">
          <button type="button" data-rango="jornada" class="btn-rango px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-950 text-white cursor-pointer">Jornada Actual</button>
          <button type="button" data-rango="semana" class="btn-rango px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-100 text-slate-700 cursor-pointer">Esta Semana</button>
          <button type="button" data-rango="mes" class="btn-rango px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-100 text-slate-700 cursor-pointer">Este Mes</button>
          <button type="button" data-rango="3meses" class="btn-rango px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-100 text-slate-700 cursor-pointer">Últimos 3 Meses</button>
          <button type="button" data-rango="todo" class="btn-rango px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-100 text-slate-700 cursor-pointer">Archivo Infinito (Todo)</button>
        </div>
        <div id="infoCierreReciente" class="text-[11px] font-bold text-slate-500"></div>
      </div>

      <!-- KPIs -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <div class="ve-card p-3.5">
          <div class="text-[10px] font-extrabold uppercase text-slate-400">Ventas del Período</div>
          <div id="kpiVentasUsd" class="font-mono-ve text-lg font-extrabold text-slate-900 mt-1">$0.00</div>
          <div id="kpiVentasBs" class="font-mono-ve text-[11px] font-bold text-slate-500 mt-0.5">Bs. 0.00</div>
        </div>

        <div class="ve-card p-3.5">
          <div class="text-[10px] font-extrabold uppercase text-slate-400">Abonos Cobrados</div>
          <div id="kpiAbonosUsd" class="font-mono-ve text-lg font-extrabold text-sky-700 mt-1">$0.00</div>
          <div id="kpiAbonosCount" class="text-[11px] font-bold text-slate-500 mt-0.5">0 abonos</div>
        </div>

        <div class="ve-card p-3.5">
          <div class="text-[10px] font-extrabold uppercase text-slate-400">Salidas / Gastos</div>
          <div id="kpiGastosUsd" class="font-mono-ve text-lg font-extrabold text-amber-700 mt-1">-$0.00</div>
          <div id="kpiGastosCount" class="text-[11px] font-bold text-slate-500 mt-0.5">0 salidas</div>
        </div>

        <div class="ve-card p-3.5 border-emerald-200 bg-emerald-50/30">
          <div class="text-[10px] font-extrabold uppercase text-emerald-800">Neto Real en Caja</div>
          <div id="kpiCajaTotalUsd" class="font-mono-ve text-lg font-extrabold text-emerald-700 mt-1">$0.00</div>
          <div id="kpiUtilidadSub" class="text-[11px] font-bold text-slate-500 mt-0.5">Utilidad: $0.00</div>
        </div>

        <div class="ve-card p-3.5">
          <div class="text-[10px] font-extrabold uppercase text-slate-400">Cartera a Crédito</div>
          <div id="kpiCreditoUsd" class="font-mono-ve text-lg font-extrabold text-rose-700 mt-1">$0.00</div>
          <div id="kpiClientesCred" class="text-[11px] font-bold text-slate-500 mt-0.5">0 clientes</div>
        </div>
      </div>

      <!-- Cuadre por Método de Pago -->
      <div class="ve-card p-4 space-y-2.5 border-emerald-200">
        <div>
          <h2 class="text-xs font-extrabold uppercase tracking-wider text-emerald-900">
            Cuadre Real por Método de Pago (Ventas + Abonos − Salidas)
          </h2>
          <p class="text-[11px] text-slate-500">
            Monto exacto que debe haber en cada gaveta física o cuenta bancaria al cerrar.
          </p>
        </div>
        <div id="gridMetodosCaja" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <div class="text-xs text-slate-400 py-3">Sin movimientos registrados en este período.</div>
        </div>
      </div>

      <!-- Detalle de Abonos y Salidas de Caja -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div class="ve-card p-4 space-y-2.5 border-sky-200">
          <div class="flex items-center justify-between gap-2">
            <div>
              <h2 class="text-xs font-extrabold uppercase tracking-wider text-sky-900">Abonos Cobrados en Caja</h2>
              <p class="text-[11px] text-slate-500">Cliente, nota pendiente, método, referencia, fecha y hora.</p>
            </div>
            <span id="badgeAbonosCaja" class="px-2.5 py-0.5 rounded-full bg-sky-100 text-sky-900 text-[11px] font-extrabold">0</span>
          </div>
          <div id="listaAbonosCaja" class="space-y-1.5 max-h-72 overflow-y-auto">
            <div class="text-xs text-slate-400 py-4 text-center">Sin abonos cobrados en este período.</div>
          </div>
        </div>

        <div class="ve-card p-4 space-y-2.5 border-amber-200">
          <div class="flex items-center justify-between gap-2">
            <div>
              <h2 class="text-xs font-extrabold uppercase tracking-wider text-amber-900">Salidas / Gastos de Caja</h2>
              <p class="text-[11px] text-slate-500">Egresos descontados del cuadre de la jornada.</p>
            </div>
            <span id="badgeGastosCaja" class="px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-900 text-[11px] font-extrabold">0</span>
          </div>
          <div id="listaGastosCaja" class="space-y-1.5 max-h-72 overflow-y-auto">
            <div class="text-xs text-slate-400 py-4 text-center">Sin salidas registradas en este período.</div>
          </div>
        </div>
      </div>

      <!-- Ranking Mejores vs Peores Pagadores -->
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

      <!-- Cierres Archivados -->
      <div class="ve-card p-4 space-y-2.5">
        <h2 class="text-xs font-extrabold uppercase tracking-wider text-slate-500">Cierres de Caja Archivados</h2>
        <div id="listaCierres" class="space-y-2">
          <div class="text-xs text-slate-400 py-4 text-center">Sin cierres registrados aún.</div>
        </div>
      </div>
    </div>
  `;

  const wrapEl = root.querySelector("#analiticaWrap");
  let rangoActual = "jornada";
  let archivoCompletoCargado = false;
  let todasNotas = [];
  let todosGastos = [];
  let cierres = [];

  const gastoMontoEl = root.querySelector("#gastoMonto");
  const gastoMotivoEl = root.querySelector("#gastoMotivo");
  const gastoMetodoEl = root.querySelector("#gastoMetodo");
  const btnGuardarGasto = root.querySelector("#btnGuardarGasto");

  gastoMontoEl.addEventListener("focus", () => fijarCursorAlFinal(gastoMontoEl));
  gastoMontoEl.addEventListener("click", () => fijarCursorAlFinal(gastoMontoEl));
  gastoMontoEl.addEventListener("input", () => formatearEntradaMoneda(gastoMontoEl));

  root.querySelector("#btnToggleGasto").addEventListener("click", () => {
    const panel = root.querySelector("#panelNuevoGasto");
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) {
      gastoMontoEl.focus();
      fijarCursorAlFinal(gastoMontoEl);
    }
  });

  btnGuardarGasto.addEventListener("click", async () => {
    const monto = parseFloat(gastoMontoEl.value || "0");
    const motivo = gastoMotivoEl.value.trim();
    const metodo = gastoMetodoEl.value;
    if (monto <= 0) return alert("Ingresa un monto mayor a $0.00.");
    if (!motivo) return alert("Escribe el motivo o concepto de la salida.");

    btnGuardarGasto.disabled = true;
    btnGuardarGasto.textContent = "Guardando...";

    try {
      const now = Date.now();
      const gastoId = `GAS-${now}`;
      await setDoc(doc(refs.gastosCaja(), gastoId), {
        id: gastoId,
        montoUsd: Number(monto.toFixed(2)),
        metodo,
        motivo,
        cierreId: null,
        creadoTs: now,
        fechaIso: obtenerFechaLocalIso(now),
        fechaHoraTxt: formatearFechaHora(now),
        usuario: state.sesion?.usuario || "Administrador",
        creadoEn: serverTimestamp()
      });

      gastoMontoEl.value = "0.00";
      gastoMotivoEl.value = "";
      root.querySelector("#panelNuevoGasto").classList.add("hidden");
      await cargarDatos(archivoCompletoCargado);
    } catch (err) {
      alert("Error al guardar la salida: " + err.message);
    } finally {
      btnGuardarGasto.disabled = false;
      btnGuardarGasto.textContent = "Guardar Salida";
    }
  });

  function filtrarNotasPorRango(notasRaw) {
    const validas = notasRaw.filter((n) => !n.anulada);
    if (rangoActual === "jornada") return validas.filter((n) => !n.cierreId);
    const desdeTs = inicioRangoTs(rangoActual);
    if (!desdeTs) return validas;
    return validas.filter((n) => Number(n.creadoTs || 0) >= desdeTs);
  }

  function filtrarGastosPorRango(gastosRaw) {
    if (rangoActual === "jornada") return gastosRaw.filter((g) => !g.cierreId);
    const desdeTs = inicioRangoTs(rangoActual);
    if (!desdeTs) return gastosRaw;
    return gastosRaw.filter((g) => Number(g.creadoTs || 0) >= desdeTs);
  }

  function obtenerAbonosEnRango(notasRaw) {
    const ultimoCierreTs = cierres[0]?.cerradoTs || 0;
    const desdeTs = inicioRangoTs(rangoActual);

    const lista = [];
    for (const n of notasRaw) {
      if (n.anulada || !Array.isArray(n.abonos)) continue;
      for (const ab of n.abonos) {
        const ts = Number(ab.ts || 0);
        let incluir = false;
        if (rangoActual === "jornada") {
          incluir = ab.cierreId === null || (ab.cierreId === undefined && (!ultimoCierreTs || ts > ultimoCierreTs));
        } else {
          incluir = !desdeTs || ts >= desdeTs;
        }
        if (incluir) {
          const monto = Number(ab.montoUsd || 0);
          const sobre = Number(ab.sobrepagoUsd || 0);
          lista.push({
            notaId: n.id,
            folio: n.folio || n.id,
            clienteNombre: n.cliente?.nombre || "Consumidor Final",
            montoUsd: monto,
            sobrepagoUsd: sobre,
            totalFisicoUsd: Number((monto + sobre).toFixed(2)),
            metodo: ab.metodo || "Efectivo USD",
            referencia: ab.referencia || "",
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

  function calcularDesgloseMetodos(notasRango, abonosRango, gastosRango) {
    const mapa = new Map();
    const sumar = (metodo, delta) => {
      const m = metodo || "Efectivo USD";
      const val = Number(delta || 0);
      if (Math.abs(val) < 0.005) return;
      mapa.set(m, Number(((mapa.get(m) || 0) + val).toFixed(2)));
    };

    for (const n of notasRango) {
      if (Array.isArray(n.pagos)) {
        for (const p of n.pagos) {
          if (p.usandoSaldoFavor || p.metodo === "Saldo a Favor") continue;
          sumar(p.metodo, p.montoUsd);
        }
      }
    }
    for (const a of abonosRango) {
      if (!a.usandoSaldoFavor) sumar(a.metodo, a.totalFisicoUsd);
    }
    for (const g of gastosRango) {
      sumar(g.metodo, -Number(g.montoUsd || 0));
    }
    return Array.from(mapa.entries()).sort((a, b) => b[1] - a[1]);
  }

  function pintarAnalitica() {
    if (!wrapEl.isConnected) return;
    const ahora = Date.now();
    const tasas = getTasaActiva(state);
    const notasAbiertas = todasNotas.filter((n) => !n.anulada && !n.cierreId);
    root.querySelector("#cntNotasAbiertas").textContent = String(notasAbiertas.length);

    const ultimoCierre = cierres[0];
    root.querySelector("#infoCierreReciente").textContent = ultimoCierre
      ? `Último cierre: ${ultimoCierre.fechaHoraTxt || ultimoCierre.fechaIso || ""} (Neto: $${Number(ultimoCierre.netoCajaUsd ?? ultimoCierre.totalVentasUsd ?? 0).toFixed(2)})`
      : "Aún no se ha realizado ningún cierre de caja.";

    const notasRango = filtrarNotasPorRango(todasNotas);
    const abonosRango = obtenerAbonosEnRango(todasNotas);
    const gastosRango = filtrarGastosPorRango(todosGastos);
    const desgloseMetodos = calcularDesgloseMetodos(notasRango, abonosRango, gastosRango);

    const ventasUsd = notasRango.reduce((acc, n) => acc + Number(n.totalUsd || 0), 0);
    const utilidadUsd = notasRango.reduce((acc, n) => acc + Number(n.utilidadUsd || 0), 0);
    const pagosNotasRangoUsd = notasRango.reduce(
      (acc, n) => acc + (
        Array.isArray(n.pagos)
          ? n.pagos.reduce((s, p) => (p.usandoSaldoFavor || p.metodo === "Saldo a Favor" ? s : s + Number(p.montoUsd || 0)), 0)
          : 0
      ),
      0
    );
    const abonosEfectivoCajaUsd = abonosRango
      .filter((a) => !a.usandoSaldoFavor)
      .reduce((acc, a) => acc + a.totalFisicoUsd, 0);
    const gastosUsd = gastosRango.reduce((acc, g) => acc + Number(g.montoUsd || 0), 0);
    const totalCajaRealUsd = Number((pagosNotasRangoUsd + abonosEfectivoCajaUsd - gastosUsd).toFixed(2));

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
    root.querySelector("#kpiAbonosCount").textContent = `${abonosRango.length} abono(s)`;
    root.querySelector("#kpiGastosUsd").textContent = `-$${gastosUsd.toFixed(2)}`;
    root.querySelector("#kpiGastosCount").textContent = `${gastosRango.length} salida(s)`;
    root.querySelector("#kpiCajaTotalUsd").textContent = `$${totalCajaRealUsd.toFixed(2)}`;
    root.querySelector("#kpiUtilidadSub").textContent = `Utilidad: $${utilidadUsd.toFixed(2)} (${notasRango.length} notas)`;
    root.querySelector("#kpiCreditoUsd").textContent = `$${carteraActivaUsd.toFixed(2)}`;
    root.querySelector("#kpiClientesCred").textContent = `${evaluados.length} clientes`;

    root.querySelector("#gridMetodosCaja").innerHTML = desgloseMetodos.length
      ? desgloseMetodos.map(([met, val]) => `
        <div class="p-3 rounded-xl ${val >= 0 ? "bg-emerald-50/60 border-emerald-200" : "bg-rose-50/60 border-rose-200"} border flex items-center justify-between gap-2">
          <span class="text-xs font-extrabold text-slate-800 truncate">${met}</span>
          <span class="font-mono-ve text-sm font-extrabold ${val >= 0 ? "text-emerald-800" : "text-rose-700"}">${val < 0 ? "-" : ""}$${Math.abs(val).toFixed(2)}</span>
        </div>
      `).join("")
      : `<div class="text-xs text-slate-400 py-3 col-span-full text-center">Sin movimientos registrados en este período.</div>`;

    root.querySelector("#badgeAbonosCaja").textContent = String(abonosRango.length);
    root.querySelector("#listaAbonosCaja").innerHTML = abonosRango.length
      ? abonosRango.map((a) => `
        <div class="p-2.5 rounded-xl bg-sky-50/70 border border-sky-200 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div class="min-w-0 flex-1">
            <div class="font-extrabold text-slate-900">
              ${a.clienteNombre} • <span class="font-mono-ve text-sky-900">Nota #${a.folio}</span>
              ${a.sobrepagoUsd > 0.01 ? `<span class="text-[10px] font-bold text-emerald-700 ml-1">(+$${a.sobrepagoUsd.toFixed(2)} a favor)</span>` : ""}
            </div>
            <div class="text-[11px] text-slate-600 font-mono-ve">
              ${a.fechaHoraTxt} • <strong>${a.metodo}</strong>${a.referencia ? ` (Ref: ${a.referencia})` : ""}
            </div>
          </div>
          <div class="font-mono-ve text-sm font-extrabold text-emerald-700 shrink-0">+$${a.totalFisicoUsd.toFixed(2)}</div>
        </div>
      `).join("")
      : `<div class="text-xs text-slate-400 py-4 text-center">Sin abonos cobrados en este período.</div>`;

    root.querySelector("#badgeGastosCaja").textContent = String(gastosRango.length);
    root.querySelector("#listaGastosCaja").innerHTML = gastosRango.length
      ? gastosRango.map((g) => `
        <div class="p-2.5 rounded-xl bg-amber-50/70 border border-amber-200 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div class="min-w-0 flex-1">
            <div class="font-extrabold text-slate-900">${g.motivo || "Salida de caja"}</div>
            <div class="text-[11px] text-slate-600 font-mono-ve">
              ${g.fechaHoraTxt || g.fechaIso || ""} • <strong>${g.metodo}</strong> • por ${g.usuario || "Admin"}
            </div>
          </div>
          <div class="font-mono-ve text-sm font-extrabold text-rose-700 shrink-0">-$${Number(g.montoUsd || 0).toFixed(2)}</div>
        </div>
      `).join("")
      : `<div class="text-xs text-slate-400 py-4 text-center">Sin salidas registradas en este período.</div>`;

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
      ? cierres.slice(0, 15).map((ci) => `
        <div class="p-3 rounded-xl bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div>
            <span class="font-mono-ve font-extrabold text-slate-900">${ci.id}</span>
            <span class="text-slate-500 ml-2">${ci.fechaHoraTxt || ci.fechaIso || ""} • ${ci.cantidadNotas || 0} notas • ${ci.cantidadAbonos || 0} abonos • ${ci.cantidadGastos || 0} salidas</span>
          </div>
          <div class="font-mono-ve font-extrabold text-slate-900">
            Ventas: $${Number(ci.totalVentasUsd || 0).toFixed(2)} • Abonos: <span class="text-sky-700">$${Number(ci.totalAbonosUsd || 0).toFixed(2)}</span> • Gastos: <span class="text-rose-700">-$${Number(ci.totalGastosUsd || 0).toFixed(2)}</span>
          </div>
        </div>
      `).join("")
      : `<div class="text-xs text-slate-400 py-4 text-center">Sin cierres registrados aún.</div>`;
  }

  root.querySelector("#filtroRangoBtns").addEventListener("click", async (e) => {
    const btn = e.target.closest(".btn-rango");
    if (!btn) return;
    rangoActual = btn.dataset.rango;
    root.querySelectorAll(".btn-rango").forEach((b) => {
      const act = b.dataset.rango === rangoActual;
      b.className = act
        ? "btn-rango px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-950 text-white cursor-pointer"
        : "btn-rango px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-100 text-slate-700 cursor-pointer";
    });
    if (rangoActual === "todo" && !archivoCompletoCargado) {
      await cargarDatos(true);
    } else {
      pintarAnalitica();
    }
  });

  root.querySelector("#btnCerrarCaja").addEventListener("click", async () => {
    const rangoPrevio = rangoActual;
    rangoActual = "jornada";
    const abiertas = todasNotas.filter((n) => !n.anulada && !n.cierreId);
    const abonosAbiertos = obtenerAbonosEnRango(todasNotas);
    const gastosAbiertos = todosGastos.filter((g) => !g.cierreId);
    rangoActual = rangoPrevio;

    if (!abiertas.length && !abonosAbiertos.length && !gastosAbiertos.length) {
      return alert("No hay notas, abonos ni salidas abiertas en la jornada actual para cerrar.");
    }

    const totalVentas = abiertas.reduce((acc, n) => acc + Number(n.totalUsd || 0), 0);
    const totalUtilidad = abiertas.reduce((acc, n) => acc + Number(n.utilidadUsd || 0), 0);
    const pagosVentas = abiertas.reduce(
      (acc, n) => acc + (
        Array.isArray(n.pagos)
          ? n.pagos.reduce((s, p) => (p.usandoSaldoFavor || p.metodo === "Saldo a Favor" ? s : s + Number(p.montoUsd || 0)), 0)
          : 0
      ),
      0
    );
    const totalAbonos = abonosAbiertos
      .filter((a) => !a.usandoSaldoFavor)
      .reduce((acc, a) => acc + a.totalFisicoUsd, 0);
    const totalGastos = gastosAbiertos.reduce((acc, g) => acc + Number(g.montoUsd || 0), 0);
    const netoCaja = Number((pagosVentas + totalAbonos - totalGastos).toFixed(2));
    const desglose = Object.fromEntries(calcularDesgloseMetodos(abiertas, abonosAbiertos, gastosAbiertos));

    if (!confirm(`¿Cerrar caja?\n• Notas: ${abiertas.length} ($${totalVentas.toFixed(2)})\n• Abonos: ${abonosAbiertos.length} ($${totalAbonos.toFixed(2)})\n• Salidas: ${gastosAbiertos.length} (-$${totalGastos.toFixed(2)})\n• Neto en caja: $${netoCaja.toFixed(2)}`)) {
      return;
    }

    const btn = root.querySelector("#btnCerrarCaja");
    btn.disabled = true;

    try {
      const now = Date.now();
      const fechaHoyIso = obtenerFechaLocalIso(now);
      const cierreId = `CIERRE-${fechaHoyIso}-${String(now).slice(-4)}`;
      const fechaHoraTxt = formatearFechaHora(now);
      const nuevaJornadaId = obtenerFechaLocalIso(now + 86400000);

      const operaciones = [];

      // Combinar notas abiertas y notas con abonos abiertos para no duplicar escrituras al mismo doc
      const notasConAbonosAbiertos = new Set(abonosAbiertos.map((a) => a.notaId));
      const idsNotasAActualizar = new Set([
        ...abiertas.map((n) => n.id),
        ...notasConAbonosAbiertos
      ]);

      for (const notaId of idsNotasAActualizar) {
        const nota = todasNotas.find((x) => x.id === notaId);
        if (!nota) continue;
        const patch = {};

        if (!nota.cierreId && !nota.anulada) {
          patch.cierreId = cierreId;
          patch.cerradoEnTs = now;
        }
        if (notasConAbonosAbiertos.has(notaId) && Array.isArray(nota.abonos)) {
          patch.abonos = nota.abonos.map((ab) => (
            ab.cierreId === null || ab.cierreId === undefined ? { ...ab, cierreId } : ab
          ));
          patch.tieneAbonosSinCerrar = false;
        }

        if (Object.keys(patch).length) {
          operaciones.push({
            ref: doc(refs.notasEntrega(), notaId),
            data: patch,
            merge: true
          });
        }
      }

      for (const g of gastosAbiertos) {
        operaciones.push({
          ref: doc(refs.gastosCaja(), g.id),
          data: { cierreId, cerradoEnTs: now },
          merge: true
        });
      }

      // Registro del cierre y avance de jornada al final
      operaciones.push({
        ref: doc(refs.cierresCaja(), cierreId),
        data: {
          cierreId,
          fechaIso: fechaHoyIso,
          fechaHoraTxt,
          cerradoTs: now,
          cantidadNotas: abiertas.length,
          cantidadAbonos: abonosAbiertos.length,
          cantidadGastos: gastosAbiertos.length,
          totalVentasUsd: Number(totalVentas.toFixed(2)),
          totalAbonosUsd: Number(totalAbonos.toFixed(2)),
          totalGastosUsd: Number(totalGastos.toFixed(2)),
          netoCajaUsd: netoCaja,
          totalUtilidadUsd: Number(totalUtilidad.toFixed(2)),
          desgloseMetodos: desglose,
          usuario: state.sesion?.usuario || "Administrador",
          creadoEn: serverTimestamp()
        },
        merge: false
      });

      operaciones.push({
        ref: refs.empresaRef,
        data: { jornadaActivaId: nuevaJornadaId },
        merge: true
      });

      await commitOperacionesEnLotes(operaciones);
      if (state.empresa) state.empresa.jornadaActivaId = nuevaJornadaId;

      await cargarDatos(archivoCompletoCargado);
      alert(`Caja cerrada (${cierreId}). Ventas, abonos y salidas quedaron archivados.`);
    } catch (err) {
      alert("Error al cerrar caja: " + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  const onTasaChanged = () => {
    if (!wrapEl.isConnected) {
      window.removeEventListener("ve-tasa-changed", onTasaChanged);
      return;
    }
    pintarAnalitica();
  };
  window.addEventListener("ve-tasa-changed", onTasaChanged);

  async function cargarDatos(cargarTodo = false) {
    const hace90Dias = Date.now() - DIAS_90_MS;
    const snapCierres = await getDocs(refs.cierresCaja());
    cierres = snapCierres.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.cerradoTs || 0) - (a.cerradoTs || 0));

    if (cargarTodo) {
      const [snapNotas, snapGastos] = await Promise.all([
        getDocs(refs.notasEntrega()),
        getDocs(refs.gastosCaja())
      ]);
      todasNotas = snapNotas.docs.map((d) => ({ id: d.id, ...d.data() }));
      todosGastos = snapGastos.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.creadoTs || 0) - (a.creadoTs || 0));
      archivoCompletoCargado = true;
    } else {
      // Ventana rápida: últimos 3 meses + deudas activas + jornada abierta + abonos sin cerrar + gastos abiertos
      const [snapRecientes, snapDeudas, snapAbiertas, snapAbonosPend, snapGastosRec, snapGastosAbiertos] = await Promise.all([
        getDocs(query(refs.notasEntrega(), where("creadoTs", ">=", hace90Dias))),
        getDocs(query(refs.notasEntrega(), where("saldoPendienteUsd", ">", 0))),
        getDocs(query(refs.notasEntrega(), where("cierreId", "==", null))),
        getDocs(query(refs.notasEntrega(), where("tieneAbonosSinCerrar", "==", true))),
        getDocs(query(refs.gastosCaja(), where("creadoTs", ">=", hace90Dias))),
        getDocs(query(refs.gastosCaja(), where("cierreId", "==", null)))
      ]);

      const mapaNotas = new Map();
      for (const s of [snapRecientes, snapDeudas, snapAbiertas, snapAbonosPend]) {
        s.forEach((d) => mapaNotas.set(d.id, { id: d.id, ...d.data() }));
      }
      todasNotas = Array.from(mapaNotas.values());

      const mapaGastos = new Map();
      for (const s of [snapGastosRec, snapGastosAbiertos]) {
        s.forEach((d) => mapaGastos.set(d.id, { id: d.id, ...d.data() }));
      }
      todosGastos = Array.from(mapaGastos.values())
        .sort((a, b) => (b.creadoTs || 0) - (a.creadoTs || 0));
    }

    pintarAnalitica();
  }

  await cargarDatos(false);
}
