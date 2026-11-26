// venezuela/modules/inventario-planta.js
import {
  db,
  getTenantRefs,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  writeBatch,
  increment,
  normalizarIdVE,
  serverTimestamp
} from "../core/db.js";
import { imprimirDocumentoCarta, imprimirTicket80mm } from "./documentos-pdf.js";

function getTasaActiva(state) {
  const t = state.tasas || {};
  const bcv = state.modoTasaBCV === "manana" && t.bcvManana ? t.bcvManana : t.bcvHoy;
  return { ...t, bcvActiva: Number(bcv || 0) };
}

function formatearFechaHora(ts) {
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
    return new Date(Number(ts)).toISOString().slice(0, 10);
  }
}

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);

  root.innerHTML = `
    <div class="space-y-4 max-w-6xl mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Historial de Notas y Cierre Diario</h1>
          <p class="text-xs text-slate-500">
            Carga rápida de la jornada actual. Activa el Archivo Infinito para filtrar por rango de fechas, folio, nombre o cédula.
          </p>
        </div>
        <button id="btnCerrarCajaHist" type="button" class="px-4 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-extrabold cursor-pointer">
          🔒 Cerrar Caja del Día
        </button>
      </div>

      <!-- Resumen de lo que va del día -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div class="ve-card p-3.5">
          <div class="text-[10px] font-extrabold uppercase text-slate-400">Notas Abiertas Hoy</div>
          <div id="histCantHoy" class="font-mono-ve text-lg font-extrabold text-slate-900 mt-0.5">0</div>
        </div>
        <div class="ve-card p-3.5">
          <div class="text-[10px] font-extrabold uppercase text-slate-400">Vendido Hoy (USD)</div>
          <div id="histTotalHoy" class="font-mono-ve text-lg font-extrabold text-emerald-700 mt-0.5">$0.00</div>
        </div>
        <div class="ve-card p-3.5">
          <div class="text-[10px] font-extrabold uppercase text-slate-400">Ref. Bs. Hoy (BCV)</div>
          <div id="histBsHoy" class="font-mono-ve text-lg font-extrabold text-slate-700 mt-0.5">Bs. 0.00</div>
        </div>
      </div>

      <!-- Filtro Infinito (Texto + Fechas Desde/Hasta + Condición) -->
      <div class="ve-card p-3 space-y-2.5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <input id="busqNotaHist" type="text" placeholder="Buscar por N° folio, nombre, cédula/RIF o producto..." class="flex-1 min-w-[200px] bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold outline-none focus:border-slate-950" />
          <div class="flex gap-1.5" id="filtroEstadoNotas">
            <button type="button" data-estado="dia" class="btn-est px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-950 text-white cursor-pointer">Del Día</button>
            <button type="button" data-estado="todas" class="btn-est px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-100 text-slate-700 cursor-pointer">Archivo Infinito</button>
          </div>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 border-t border-slate-100">
          <div class="flex flex-col gap-0.5">
            <label class="text-[10px] font-extrabold uppercase text-slate-400">Desde</label>
            <input id="filtroFechaDesde" type="date" class="bg-slate-50 border border-slate-300 rounded-lg px-2 py-1.5 text-xs font-bold" />
          </div>
          <div class="flex flex-col gap-0.5">
            <label class="text-[10px] font-extrabold uppercase text-slate-400">Hasta</label>
            <input id="filtroFechaHasta" type="date" class="bg-slate-50 border border-slate-300 rounded-lg px-2 py-1.5 text-xs font-bold" />
          </div>
          <div class="flex flex-col gap-0.5">
            <label class="text-[10px] font-extrabold uppercase text-slate-400">Condición</label>
            <select id="filtroCondicion" class="bg-slate-50 border border-slate-300 rounded-lg px-2 py-1.5 text-xs font-bold">
              <option value="todas">Todas</option>
              <option value="contado">Contado</option>
              <option value="credito">Crédito</option>
              <option value="anuladas">Anuladas</option>
            </select>
          </div>
          <div class="flex items-end">
            <button id="btnLimpiarFiltrosHist" type="button" class="w-full py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-extrabold cursor-pointer">
              Limpiar filtros
            </button>
          </div>
        </div>
      </div>

      <div id="listaNotasHist" class="space-y-2.5">
        <div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">Cargando notas de la jornada...</div>
      </div>
    </div>
  `;

  let notas = [];
  let archivoCompletoCargado = false;
  let vistaEstado = "dia";

  const busqEl = root.querySelector("#busqNotaHist");
  const desdeEl = root.querySelector("#filtroFechaDesde");
  const hastaEl = root.querySelector("#filtroFechaHasta");
  const condEl = root.querySelector("#filtroCondicion");
  const contEl = root.querySelector("#listaNotasHist");

  function actualizarResumenDia() {
    const abiertas = notas.filter((n) => !n.anulada && !n.cierreId);
    const totalHoy = abiertas.reduce((acc, n) => acc + Number(n.totalUsd || 0), 0);
    const tasas = getTasaActiva(state);

    root.querySelector("#histCantHoy").textContent = String(abiertas.length);
    root.querySelector("#histTotalHoy").textContent = `$${totalHoy.toFixed(2)}`;
    root.querySelector("#histBsHoy").textContent = tasas.bcvActiva
      ? `Bs. ${(totalHoy * tasas.bcvActiva).toFixed(2)}`
      : "Bs. --";
  }

  function renderNotas() {
    actualizarResumenDia();
    const q = busqEl.value.trim().toLowerCase();
    const fDesde = desdeEl.value;
    const fHasta = hastaEl.value;
    const fCond = condEl.value;

    const base = vistaEstado === "dia"
      ? notas.filter((n) => !n.cierreId)
      : notas;

    const filtradas = base.filter((n) => {
      const fecha = String(n.fechaIso || "");
      if (fDesde && fecha && fecha < fDesde) return false;
      if (fHasta && fecha && fecha > fHasta) return false;

      if (fCond === "anuladas" && !n.anulada) return false;
      if (fCond === "contado" && (n.anulada || n.esCredito)) return false;
      if (fCond === "credito" && (n.anulada || !n.esCredito)) return false;

      if (q) {
        const itemsTxt = (n.items || []).map((it) => `${it.codigo} ${it.descripcion}`).join(" ");
        const txt = `${n.folio || n.id || ""} ${n.cliente?.nombre || ""} ${n.cliente?.documento || ""} ${itemsTxt}`.toLowerCase();
        if (!txt.includes(q)) return false;
      }
      return true;
    });

    if (!filtradas.length) {
      contEl.innerHTML = `<div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">${
        vistaEstado === "dia"
          ? "Jornada limpia: no hay notas con esos filtros en el día actual."
          : "No se encontraron notas en el archivo con esos filtros."
      }</div>`;
      return;
    }

    contEl.innerHTML = filtradas.map((n) => {
      const anulada = Boolean(n.anulada);
      const archivada = Boolean(n.cierreId);
      const abonosCount = Array.isArray(n.abonos) ? n.abonos.length : 0;
      const condTxt = n.esCredito && Number(n.saldoPendienteUsd || 0) > 0.01
        ? `Crédito (Saldo: $${Number(n.saldoPendienteUsd).toFixed(2)})`
        : "Contado";

      return `
        <div class="ve-card p-3.5 space-y-2 ${anulada ? "opacity-60 bg-rose-50/40" : ""}" data-id="${n.id}">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-mono-ve text-xs font-extrabold text-slate-900">Nota #${n.folio || n.id}</span>
              <span class="text-xs font-extrabold text-slate-800">${n.cliente?.nombre || "Consumidor Final"}</span>
              <span class="font-mono-ve text-[11px] text-slate-500">${n.cliente?.documento || ""}</span>
              ${anulada ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-rose-100 text-rose-800">ANULADA</span>` : ""}
              ${!anulada && archivada ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-slate-200 text-slate-700">Archivada</span>` : ""}
              ${!anulada && !archivada ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">Abierta hoy</span>` : ""}
              ${abonosCount > 0 ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-sky-100 text-sky-800">${abonosCount} abono(s)</span>` : ""}
            </div>
            <div class="text-right">
              <div class="font-mono-ve text-sm font-extrabold text-slate-900">$${Number(n.totalUsd || 0).toFixed(2)}</div>
              <div class="text-[10px] font-bold text-slate-500">${n.fechaIso || ""} • ${condTxt}</div>
            </div>
          </div>

          <div class="text-[11px] text-slate-600">
            ${(n.items || []).map((it) => `${it.cantidad}× ${it.codigo}`).join(", ")}
          </div>

          <div class="flex flex-wrap items-center justify-end gap-1.5 pt-1">
            <button type="button" class="btn-pdf-nota px-3 py-1.5 rounded-xl bg-slate-950 text-white text-xs font-extrabold cursor-pointer">
              Ver PDF
            </button>
            <button type="button" class="btn-tkt-nota px-2.5 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold cursor-pointer">
              Ticket 80mm
            </button>
            ${!anulada ? `
              <button type="button" class="btn-anular-nota px-3 py-1.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-extrabold cursor-pointer">
                Anular y devolver stock
              </button>
            ` : ""}
          </div>
        </div>
      `;
    }).join("");
  }

  async function anularNota(nota) {
    if (nota.anulada) return;

    const abonos = Array.isArray(nota.abonos) ? nota.abonos : [];
    const totalAbonadoEfectivo = Number(
      abonos
        .filter((a) => !a.usandoSaldoFavor)
        .reduce((acc, a) => acc + Number(a.montoUsd || 0), 0)
        .toFixed(2)
    );

    const docCli = normalizarIdVE(nota.cliente?.documento || "");
    let destinoAbonos = "ninguno";

    if (totalAbonadoEfectivo > 0.01) {
      const pasarAFavor = confirm(
        `⚠️ Esta nota (#${nota.folio || nota.id}) ya tiene $${totalAbonadoEfectivo.toFixed(2)} abonados.\n\n` +
        `• Pulsa ACEPTAR para acreditar esos $${totalAbonadoEfectivo.toFixed(2)} al SALDO A FAVOR del cliente.\n` +
        `• Pulsa CANCELAR para registrar una DEVOLUCIÓN / SALIDA DE CAJA por $${totalAbonadoEfectivo.toFixed(2)}.`
      );
      if (pasarAFavor) {
        if (!docCli || docCli === "V-00000000") {
          return alert("No se puede acreditar saldo a favor a Consumidor Final. Usa Devolución de Caja.");
        }
        destinoAbonos = "favor";
      } else {
        if (!confirm(`¿Confirmas anular Nota #${nota.folio || nota.id} y registrar una Salida de Caja (devolución) por $${totalAbonadoEfectivo.toFixed(2)}?`)) {
          return;
        }
        destinoAbonos = "devolucion";
      }
    } else {
      if (!confirm(`¿Anular Nota #${nota.folio || nota.id} por $${Number(nota.totalUsd || 0).toFixed(2)}? Se devolverá el stock al inventario y se ajustará el saldo a favor si aplica.`)) {
        return;
      }
    }

    const batch = writeBatch(db);
    const now = Date.now();

    batch.set(doc(refs.notasEntrega(), nota.id), {
      anulada: true,
      anuladaEnTs: now,
      destinoAbonosAlAnular: destinoAbonos,
      saldoPendienteUsd: 0,
      esCredito: false,
      tieneAbonosSinCerrar: false,
      actualizadoEn: serverTimestamp()
    }, { merge: true });

    const favorUsado = Number(nota.saldoFavorAplicadoUsd || 0);
    const sobrepagoGen = Number(nota.sobrepagoUsd || 0);
    const extraFavorPorAbonos = destinoAbonos === "favor" ? totalAbonadoEfectivo : 0;

    if (docCli && docCli !== "V-00000000" && (favorUsado > 0.01 || sobrepagoGen > 0.01 || extraFavorPorAbonos > 0.01)) {
      const cliRef = doc(refs.clientes(), docCli);
      const cliSnap = await getDoc(cliRef);
      const actualFavor = Number(cliSnap.data()?.saldoAFavorUsd || 0);
      const favorFinal = Math.max(
        0,
        Number((actualFavor + favorUsado - sobrepagoGen + extraFavorPorAbonos).toFixed(2))
      );
      batch.set(cliRef, {
        saldoAFavorUsd: favorFinal,
        actualizadoEn: serverTimestamp()
      }, { merge: true });
    }

    if (destinoAbonos === "devolucion" && totalAbonadoEfectivo > 0.01) {
      const gastoId = `DEV-${nota.folio || nota.id}-${now}`;
      batch.set(doc(refs.gastosCaja(), gastoId), {
        id: gastoId,
        montoUsd: totalAbonadoEfectivo,
        metodo: abonos[abonos.length - 1]?.metodo || "Efectivo USD",
        motivo: `Devolución por anulación de Nota #${nota.folio || nota.id} (${nota.cliente?.nombre || "Cliente"})`,
        cierreId: null,
        creadoTs: now,
        fechaIso: new Date(now).toISOString().slice(0, 10),
        fechaHoraTxt: formatearFechaHora(now),
        usuario: state.sesion?.usuario || "Administrador",
        creadoEn: serverTimestamp()
      });
    }

    for (const it of (nota.items || [])) {
      if (!it.id) continue;
      if (it.origen === "almacen") {
        batch.set(doc(refs.catalogo(), it.id), {
          stockAlmacen: increment(Number(it.cantidad || 1)),
          actualizadoEn: serverTimestamp()
        }, { merge: true });
      } else {
        batch.set(doc(refs.catalogo(), it.id), {
          pedidosPlantaCount: increment(-Number(it.cantidad || 1)),
          actualizadoEn: serverTimestamp()
        }, { merge: true });
      }
    }

    await batch.commit();
    if (typeof window.NEXUS_VE_REFRESH_ALERTAS === "function") {
      await window.NEXUS_VE_REFRESH_ALERTAS();
    }
    await cargarDatos(archivoCompletoCargado);
    alert(`Nota #${nota.folio || nota.id} anulada correctamente.`);
  }

  async function cerrarCajaDia() {
    const [snapAbiertas, snapDeudas, snapAbonosPend, snapGastos] = await Promise.all([
      getDocs(query(refs.notasEntrega(), where("cierreId", "==", null))),
      getDocs(query(refs.notasEntrega(), where("saldoPendienteUsd", ">", 0))),
      getDocs(query(refs.notasEntrega(), where("tieneAbonosSinCerrar", "==", true))),
      getDocs(query(refs.gastosCaja(), where("cierreId", "==", null)))
    ]);

    const abiertas = snapAbiertas.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((n) => !n.anulada);

    const gastosAbiertos = snapGastos.docs.map((d) => ({ id: d.id, ...d.data() }));

    const mapaRev = new Map();
    for (const d of [...snapAbiertas.docs, ...snapDeudas.docs, ...snapAbonosPend.docs]) {
      mapaRev.set(d.id, { id: d.id, ...d.data() });
    }

    const abonosAbiertos = [];
    const notasConAbonosAbiertos = new Set();
    for (const n of mapaRev.values()) {
      if (n.anulada || !Array.isArray(n.abonos)) continue;
      for (const ab of n.abonos) {
        if (ab.cierreId === null || ab.cierreId === undefined) {
          notasConAbonosAbiertos.add(n.id);
          abonosAbiertos.push({
            metodo: ab.metodo || "Efectivo USD",
            usandoSaldoFavor: Boolean(ab.usandoSaldoFavor),
            totalFisicoUsd: Number((Number(ab.montoUsd || 0) + Number(ab.sobrepagoUsd || 0)).toFixed(2))
          });
        }
      }
    }

    if (!abiertas.length && !abonosAbiertos.length && !gastosAbiertos.length) {
      return alert("No hay notas, abonos ni salidas abiertas en la jornada actual para cerrar.");
    }

    const totalVentas = abiertas.reduce((acc, n) => acc + Number(n.totalUsd || 0), 0);
    const totalUtilidad = abiertas.reduce((acc, n) => acc + Number(n.utilidadUsd || 0), 0);
    const pagosVentas = abiertas.reduce(
      (acc, n) => acc + (Array.isArray(n.pagos) ? n.pagos.reduce((s, p) => s + Number(p.montoUsd || 0), 0) : 0),
      0
    );
    const totalAbonos = abonosAbiertos
      .filter((a) => !a.usandoSaldoFavor)
      .reduce((acc, a) => acc + a.totalFisicoUsd, 0);
    const totalGastos = gastosAbiertos.reduce((acc, g) => acc + Number(g.montoUsd || 0), 0);
    const netoCaja = Number((pagosVentas + totalAbonos - totalGastos).toFixed(2));

    const desgloseMap = new Map();
    const sumarMet = (m, v) => {
      const val = Number(v || 0);
      if (Math.abs(val) < 0.005) return;
      const key = m || "Efectivo USD";
      desgloseMap.set(key, Number(((desgloseMap.get(key) || 0) + val).toFixed(2)));
    };
    for (const n of abiertas) {
      if (Array.isArray(n.pagos)) {
        for (const p of n.pagos) sumarMet(p.metodo, p.montoUsd);
      }
    }
    for (const a of abonosAbiertos) {
      if (!a.usandoSaldoFavor) sumarMet(a.metodo, a.totalFisicoUsd);
    }
    for (const g of gastosAbiertos) {
      sumarMet(g.metodo, -Number(g.montoUsd || 0));
    }

    if (!confirm(`¿Cerrar caja?\n• Notas: ${abiertas.length} ($${totalVentas.toFixed(2)})\n• Abonos: ${abonosAbiertos.length} ($${totalAbonos.toFixed(2)})\n• Salidas: ${gastosAbiertos.length} (-$${totalGastos.toFixed(2)})\n• Neto en caja: $${netoCaja.toFixed(2)}`)) {
      return;
    }

    const btn = root.querySelector("#btnCerrarCajaHist");
    btn.disabled = true;

    try {
      const now = Date.now();
      const cierreId = `CIERRE-${new Date(now).toISOString().slice(0, 10)}-${String(now).slice(-4)}`;
      const fechaHoraTxt = formatearFechaHora(now);

      const batch = writeBatch(db);
      batch.set(doc(refs.cierresCaja(), cierreId), {
        cierreId,
        fechaIso: new Date(now).toISOString().slice(0, 10),
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
        desgloseMetodos: Object.fromEntries(desgloseMap),
        usuario: state.sesion?.usuario || "Administrador",
        creadoEn: serverTimestamp()
      });

      for (const n of abiertas) {
        batch.set(doc(refs.notasEntrega(), n.id), { cierreId, cerradoEnTs: now }, { merge: true });
      }

      for (const notaId of notasConAbonosAbiertos) {
        const nota = mapaRev.get(notaId);
        if (!nota || !Array.isArray(nota.abonos)) continue;
        const abonosSellados = nota.abonos.map((ab) => (
          ab.cierreId === null || ab.cierreId === undefined ? { ...ab, cierreId } : ab
        ));
        batch.set(doc(refs.notasEntrega(), notaId), {
          abonos: abonosSellados,
          tieneAbonosSinCerrar: false
        }, { merge: true });
      }

      for (const g of gastosAbiertos) {
        batch.set(doc(refs.gastosCaja(), g.id), { cierreId, cerradoEnTs: now }, { merge: true });
      }

      const nuevaJornadaId = new Date(now + 86400000).toISOString().slice(0, 10);
      batch.set(refs.empresaRef, { jornadaActivaId: nuevaJornadaId }, { merge: true });

      await batch.commit();
      if (state.empresa) state.empresa.jornadaActivaId = nuevaJornadaId;

      await cargarDatos(archivoCompletoCargado);
      alert(`Caja cerrada (${cierreId}). Todo lo del día quedó archivado.`);
    } catch (err) {
      alert("Error al cerrar caja: " + err.message);
    } finally {
      btn.disabled = false;
    }
  }

  contEl.addEventListener("click", async (e) => {
    const card = e.target.closest("[data-id]");
    if (!card) return;
    const nota = notas.find((x) => x.id === card.dataset.id);
    if (!nota) return;

    const tasas = getTasaActiva(state);
    const docPayload = {
      tipo: "NOTA DE ENTREGA",
      folio: nota.folio || nota.id,
      empresa: state.empresa,
      cliente: nota.cliente || {},
      items: nota.items || [],
      totalUsd: Number(nota.totalUsd || 0),
      monedas: nota.monedas || ["USD", "BS"],
      tasas: nota.tasaBcvUsada ? { ...tasas, bcvActiva: Number(nota.tasaBcvUsada) } : tasas,
      pagos: nota.pagos || [],
      fecha: nota.fechaIso || ""
    };

    if (e.target.closest(".btn-pdf-nota")) {
      imprimirDocumentoCarta(docPayload);
    } else if (e.target.closest(".btn-tkt-nota")) {
      imprimirTicket80mm(docPayload);
    } else if (e.target.closest(".btn-anular-nota")) {
      await anularNota(nota);
    }
  });

  root.querySelector("#filtroEstadoNotas").addEventListener("click", async (e) => {
    const btn = e.target.closest(".btn-est");
    if (!btn) return;
    vistaEstado = btn.dataset.estado;
    root.querySelectorAll(".btn-est").forEach((b) => {
      const act = b.dataset.estado === vistaEstado;
      b.className = act
        ? "btn-est px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-950 text-white cursor-pointer"
        : "btn-est px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-100 text-slate-700 cursor-pointer";
    });
    if (vistaEstado === "todas" && !archivoCompletoCargado) {
      contEl.innerHTML = `<div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">Cargando archivo histórico completo...</div>`;
      await cargarDatos(true);
    } else {
      renderNotas();
    }
  });

  root.querySelector("#btnLimpiarFiltrosHist").addEventListener("click", () => {
    busqEl.value = "";
    desdeEl.value = "";
    hastaEl.value = "";
    condEl.value = "todas";
    renderNotas();
  });

  root.querySelector("#btnCerrarCajaHist").addEventListener("click", cerrarCajaDia);
  busqEl.addEventListener("input", renderNotas);
  desdeEl.addEventListener("change", renderNotas);
  hastaEl.addEventListener("change", renderNotas);
  condEl.addEventListener("change", renderNotas);

  async function cargarDatos(cargarTodo = false) {
    if (cargarTodo) {
      const snapNotas = await getDocs(refs.notasEntrega());
      notas = snapNotas.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.creadoTs || 0) - (a.creadoTs || 0));
      archivoCompletoCargado = true;
    } else {
      const snapAbiertas = await getDocs(query(refs.notasEntrega(), where("cierreId", "==", null)));
      notas = snapAbiertas.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.creadoTs || 0) - (a.creadoTs || 0));
    }
    renderNotas();
  }

  await cargarDatos(false);
}
