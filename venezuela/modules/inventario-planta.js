// venezuela/modules/inventario-planta.js
import {
  db,
  getTenantRefs,
  collection,
  doc,
  getDocs,
  writeBatch,
  serverTimestamp
} from "../core/db.js";
import { imprimirDocumentoCarta, imprimirTicket80mm } from "./documentos-pdf.js";

function getTasaActiva(state) {
  const t = state.tasas || {};
  const bcv = state.modoTasaBCV === "manana" && t.bcvManana ? t.bcvManana : t.bcvHoy;
  return { ...t, bcvActiva: Number(bcv || 0) };
}

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);
  const cierresCol = collection(db, "empresas", state.sesion.tenantId, "cierresCaja");

  root.innerHTML = `
    <div class="space-y-4 max-w-6xl mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Historial de Notas y Cierre Diario</h1>
          <p class="text-xs text-slate-500">
            Revisa las notas del día en curso, reimprime PDFs, anula notas devolviendo stock o cierra caja para archivar el día.
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

      <!-- Filtros y búsqueda -->
      <div class="ve-card p-3 flex flex-wrap items-center justify-between gap-2">
        <input id="busqNotaHist" type="text" placeholder="Buscar por N° folio, cliente o cédula/RIF..." class="flex-1 min-w-[200px] bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold outline-none focus:border-slate-950" />
        <div class="flex gap-1.5" id="filtroEstadoNotas">
          <button type="button" data-estado="dia" class="btn-est px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-950 text-white cursor-pointer">Del Día</button>
          <button type="button" data-estado="todas" class="btn-est px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-100 text-slate-700 cursor-pointer">Archivadas / Todas</button>
        </div>
      </div>

      <div id="listaNotasHist" class="space-y-2.5">
        <div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">Cargando notas emitidas...</div>
      </div>
    </div>
  `;

  let notas = [];
  let catalogo = [];
  let vistaEstado = "dia";

  const busqEl = root.querySelector("#busqNotaHist");
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

    const base = vistaEstado === "dia"
      ? notas.filter((n) => !n.cierreId)
      : notas;

    const filtradas = base.filter((n) => {
      if (!q) return true;
      const txt = `${n.folio || n.id || ""} ${n.cliente?.nombre || ""} ${n.cliente?.documento || ""}`.toLowerCase();
      return txt.includes(q);
    });

    if (!filtradas.length) {
      contEl.innerHTML = `<div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">${
        vistaEstado === "dia"
          ? "Jornada limpia: no hay notas pendientes de cierre en este momento."
          : "No se encontraron notas con ese criterio."
      }</div>`;
      return;
    }

    contEl.innerHTML = filtradas.map((n) => {
      const anulada = Boolean(n.anulada);
      const archivada = Boolean(n.cierreId);
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
    if (!confirm(`¿Anular Nota #${nota.folio || nota.id} por $${Number(nota.totalUsd || 0).toFixed(2)}? Se devolverá el stock al inventario.`)) {
      return;
    }

    const batch = writeBatch(db);
    const now = Date.now();

    batch.set(doc(refs.notasEntrega(), nota.id), {
      anulada: true,
      anuladaEnTs: now,
      saldoPendienteUsd: 0,
      esCredito: false,
      actualizadoEn: serverTimestamp()
    }, { merge: true });

    for (const it of (nota.items || [])) {
      const prod = catalogo.find((p) => p.id === it.id || p.codigo === it.codigo);
      if (!prod) continue;
      if (it.origen === "almacen") {
        const devStock = (Number(prod.stockAlmacen) || 0) + Number(it.cantidad || 0);
        prod.stockAlmacen = devStock;
        batch.set(doc(refs.catalogo(), prod.id), {
          stockAlmacen: devStock,
          actualizadoEn: serverTimestamp()
        }, { merge: true });
      } else {
        const restPlanta = Math.max(0, (Number(prod.pedidosPlantaCount) || 0) - Number(it.cantidad || 0));
        prod.pedidosPlantaCount = restPlanta;
        batch.set(doc(refs.catalogo(), prod.id), {
          pedidosPlantaCount: restPlanta,
          actualizadoEn: serverTimestamp()
        }, { merge: true });
      }
    }

    await batch.commit();
    if (typeof window.NEXUS_VE_REFRESH_ALERTAS === "function") {
      await window.NEXUS_VE_REFRESH_ALERTAS();
    }
    await cargarDatos();
    alert(`Nota #${nota.folio || nota.id} anulada y stock devuelto.`);
  }

  async function cerrarCajaDia() {
    const abiertas = notas.filter((n) => !n.anulada && !n.cierreId);
    if (!abiertas.length) {
      return alert("No hay notas abiertas en la jornada actual para cerrar.");
    }

    const totalVentas = abiertas.reduce((acc, n) => acc + Number(n.totalUsd || 0), 0);
    const totalUtilidad = abiertas.reduce((acc, n) => acc + Number(n.utilidadUsd || 0), 0);

    if (!confirm(`¿Cerrar caja con ${abiertas.length} nota(s) por $${totalVentas.toFixed(2)}? Quedarán archivadas y la jornada del día quedará en blanco.`)) {
      return;
    }

    const btn = root.querySelector("#btnCerrarCajaHist");
    btn.disabled = true;

    try {
      const now = Date.now();
      const cierreId = `CIERRE-${new Date(now).toISOString().slice(0, 10)}-${String(now).slice(-4)}`;
      const fechaHoraTxt = new Intl.DateTimeFormat("es-VE", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true
      }).format(new Date(now));

      const batch = writeBatch(db);
      batch.set(doc(cierresCol, cierreId), {
        cierreId,
        fechaIso: new Date(now).toISOString().slice(0, 10),
        fechaHoraTxt,
        cerradoTs: now,
        cantidadNotas: abiertas.length,
        totalVentasUsd: Number(totalVentas.toFixed(2)),
        totalUtilidadUsd: Number(totalUtilidad.toFixed(2)),
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
      alert(`Caja cerrada (${cierreId}). Todo lo del día quedó archivado y listo para empezar un nuevo día.`);
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

  root.querySelector("#filtroEstadoNotas").addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-est");
    if (!btn) return;
    vistaEstado = btn.dataset.estado;
    root.querySelectorAll(".btn-est").forEach((b) => {
      const act = b.dataset.estado === vistaEstado;
      b.className = act
        ? "btn-est px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-950 text-white cursor-pointer"
        : "btn-est px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-100 text-slate-700 cursor-pointer";
    });
    renderNotas();
  });

  root.querySelector("#btnCerrarCajaHist").addEventListener("click", cerrarCajaDia);
  busqEl.addEventListener("input", renderNotas);

  async function cargarDatos() {
    const [snapNotas, snapCat] = await Promise.all([
      getDocs(refs.notasEntrega()),
      getDocs(refs.catalogo())
    ]);
    notas = snapNotas.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.creadoTs || 0) - (a.creadoTs || 0));
    catalogo = snapCat.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderNotas();
  }

  await cargarDatos();
}
