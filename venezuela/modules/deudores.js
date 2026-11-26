// venezuela/modules/deudores.js
import {
  getTenantRefs,
  doc,
  getDocs,
  setDoc,
  normalizarIdVE,
  serverTimestamp
} from "../core/db.js";
import { imprimirDocumentoCarta } from "./documentos-pdf.js";

function getTasaActiva(state) {
  const t = state.tasas || {};
  const bcv = state.modoTasaBCV === "manana" && t.bcvManana ? t.bcvManana : t.bcvHoy;
  return { ...t, bcvActiva: Number(bcv || 0) };
}

function diasTranscurridos(nota, ahora = Date.now()) {
  const baseTs = Number(nota.creadoTs || 0);
  if (!baseTs) return 0;
  return Math.max(0, Math.floor((ahora - baseTs) / 86400000));
}

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);

  root.innerHTML = `
    <div class="space-y-4 max-w-6xl mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Deudores Activos</h1>
          <p class="text-xs text-slate-500">Cada cliente se agrupa en una sola tarjeta con el monto total de sus notas pendientes.</p>
        </div>
        <div class="flex flex-wrap gap-2 text-xs font-extrabold">
          <div class="px-3 py-1.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 font-mono-ve">
            Total por Cobrar: $<span id="sumTotalDeudaUsd">0.00</span>
          </div>
          <div id="pillCriticos30" class="hidden px-3 py-1.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 font-mono-ve">
            +30d: <span id="sumCriticos30">0</span>
          </div>
        </div>
      </div>

      <div class="ve-card p-3 flex flex-wrap items-center justify-between gap-2">
        <input id="busqDeudor" type="text" placeholder="Buscar cliente por nombre o cédula/RIF..." class="flex-1 min-w-[200px] bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold outline-none focus:border-slate-950" />
        <label class="flex items-center gap-2 text-xs font-bold text-slate-700 px-2 cursor-pointer">
          <input id="chkSolo30Dias" type="checkbox" />
          Solo con facturas de +30 días
        </label>
      </div>

      <div id="listaDeudores" class="space-y-2.5">
        <div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">Cargando deudores...</div>
      </div>
    </div>
  `;

  let gruposDeudores = [];
  const expandidos = new Set();

  const busqEl = root.querySelector("#busqDeudor");
  const solo30El = root.querySelector("#chkSolo30Dias");
  const contEl = root.querySelector("#listaDeudores");

  function construirGrupos(notasRaw) {
    const ahora = Date.now();
    const mapa = new Map();

    for (const n of notasRaw) {
      const saldo = Number(n.saldoPendienteUsd ?? (n.esCredito ? n.totalUsd : 0) ?? 0);
      if (saldo <= 0.01) continue;

      const docId = normalizarIdVE(n.cliente?.documento || "") || "V-00000000";
      const nombreCli = (n.cliente?.nombre || "").trim() || "Consumidor Final";
      const dias = diasTranscurridos(n, ahora);
      const plazo = Number(n.diasCredito || 15);
      const vencida = dias > plazo;

      if (!mapa.has(docId)) {
        mapa.set(docId, {
          documento: docId,
          nombre: nombreCli,
          totalSaldoUsd: 0,
          maxDias: 0,
          tieneMas30: false,
          tieneVencida: false,
          notas: []
        });
      }

      const g = mapa.get(docId);
      if (nombreCli && g.nombre === "Consumidor Final") g.nombre = nombreCli;
      g.totalSaldoUsd = Number((g.totalSaldoUsd + saldo).toFixed(2));
      g.maxDias = Math.max(g.maxDias, dias);
      if (dias >= 30) g.tieneMas30 = true;
      if (vencida) g.tieneVencida = true;

      g.notas.push({
        ...n,
        saldoPendienteUsd: saldo,
        diasTranscurridos: dias,
        plazoDias: plazo,
        vencida
      });
    }

    return Array.from(mapa.values())
      .map((g) => {
        g.notas.sort((a, b) => (a.creadoTs || 0) - (b.creadoTs || 0));
        return g;
      })
      .sort((a, b) => b.totalSaldoUsd - a.totalSaldoUsd);
  }

  function render() {
    const q = busqEl.value.trim().toLowerCase();
    const solo30 = solo30El.checked;

    const totalCartera = gruposDeudores.reduce((acc, g) => acc + g.totalSaldoUsd, 0);
    const criticos30 = gruposDeudores.filter((g) => g.tieneMas30).length;

    root.querySelector("#sumTotalDeudaUsd").textContent = totalCartera.toFixed(2);
    const pill30 = root.querySelector("#pillCriticos30");
    if (criticos30 > 0) {
      pill30.classList.remove("hidden");
      root.querySelector("#sumCriticos30").textContent = String(criticos30);
    } else {
      pill30.classList.add("hidden");
    }

    const filtrados = gruposDeudores.filter((g) => {
      if (solo30 && !g.tieneMas30) return false;
      if (q) {
        const txt = `${g.nombre} ${g.documento}`.toLowerCase();
        if (!txt.includes(q)) return false;
      }
      return true;
    });

    if (!filtrados.length) {
      contEl.innerHTML = `<div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">No hay deudores pendientes con ese filtro.</div>`;
      return;
    }

    const tasas = getTasaActiva(state);

    contEl.innerHTML = filtrados.map((g) => {
      const abierta = expandidos.has(g.documento);
      const bsTotal = tasas.bcvActiva ? `Bs. ${(g.totalSaldoUsd * tasas.bcvActiva).toFixed(2)}` : "";

      return `
        <div class="ve-card p-3.5 space-y-3" data-doc="${encodeURIComponent(g.documento)}">
          <!-- Cabecera resumen externa: Nombre, Cédula/RIF y Monto Total -->
          <div class="btn-toggle-cli flex items-center justify-between gap-3 cursor-pointer select-none">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-sm font-extrabold text-slate-900 truncate">${g.nombre}</span>
                <span class="font-mono-ve text-[11px] font-bold px-2 py-0.5 rounded-lg bg-slate-100 text-slate-700">${g.documento}</span>
                <span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full ${
                  g.notas.length > 1 ? "bg-indigo-100 text-indigo-800" : "bg-slate-100 text-slate-600"
                }">${g.notas.length} ${g.notas.length === 1 ? "nota" : "notas"}</span>
                ${g.tieneMas30 ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-rose-100 text-rose-800">+30 días</span>` : ""}
              </div>
              <div class="text-[11px] text-slate-500 mt-0.5">
                Mayor antigüedad: <strong class="text-slate-700">${g.maxDias}d</strong> • Toca para ${abierta ? "ocultar" : "ver y abonar"} facturas
              </div>
            </div>

            <div class="text-right shrink-0">
              <div class="text-[10px] font-extrabold uppercase text-slate-400">Deuda Total</div>
              <div class="font-mono-ve text-base font-extrabold text-rose-700">$${g.totalSaldoUsd.toFixed(2)}</div>
              ${bsTotal ? `<div class="font-mono-ve text-[10px] font-bold text-slate-500">${bsTotal}</div>` : ""}
            </div>
          </div>

          <!-- Detalle desplegable de notas pendientes del cliente -->
          <div class="${abierta ? "" : "hidden"} pt-3 border-t border-slate-200 space-y-2.5">
            ${g.notas.map((n) => `
              <div class="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2" data-folio="${n.folio || n.id}">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="font-mono-ve text-xs font-extrabold text-slate-900">Nota #${n.folio || n.id}</span>
                    <span class="text-[11px] text-slate-500">${n.fechaIso || ""}</span>
                    <span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full ${
                      n.diasTranscurridos >= 30
                        ? "bg-rose-100 text-rose-800"
                        : (n.vencida ? "bg-amber-100 text-amber-900" : "bg-emerald-100 text-emerald-800")
                    }">${n.diasTranscurridos}d / plazo ${n.plazoDias}d</span>
                  </div>
                  <div class="font-mono-ve text-xs font-extrabold text-slate-900">
                    Saldo: <span class="text-rose-700">$${Number(n.saldoPendienteUsd).toFixed(2)}</span>
                    <span class="text-slate-400 font-normal">/ $${Number(n.totalUsd || 0).toFixed(2)}</span>
                  </div>
                </div>

                <div class="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <div class="flex items-center gap-1.5">
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      max="${Number(n.saldoPendienteUsd).toFixed(2)}"
                      value="${Number(n.saldoPendienteUsd).toFixed(2)}"
                      class="inp-abono w-24 bg-white border border-slate-300 rounded-lg px-2 py-1 text-xs font-mono-ve font-bold text-right"
                    />
                    <button type="button" class="btn-abonar px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold cursor-pointer">
                      Registrar Abono
                    </button>
                    <button type="button" class="btn-saldar px-2.5 py-1.5 rounded-lg bg-slate-950 hover:bg-slate-800 text-white text-xs font-extrabold cursor-pointer">
                      Saldar
                    </button>
                  </div>
                  <button type="button" class="btn-ver-nota px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-700 text-[11px] font-bold cursor-pointer">
                    PDF Nota
                  </button>
                </div>
              </div>
            `).join("")}
          </div>
        </div>
      `;
    }).join("");
  }

  async function aplicarAbono(docId, folio, montoUsd) {
    const grupo = gruposDeudores.find((g) => g.documento === docId);
    const nota = grupo?.notas.find((n) => (n.folio || n.id) === folio);
    if (!nota) return;

    const abono = Math.min(Number(nota.saldoPendienteUsd || 0), Math.max(0, Number(montoUsd || 0)));
    if (abono <= 0) return alert("Ingresa un monto de abono mayor a $0.00.");

    const nuevoSaldo = Math.max(0, Number((Number(nota.saldoPendienteUsd || 0) - abono).toFixed(2)));
    const historialAbonos = Array.isArray(nota.abonos) ? [...nota.abonos] : [];
    historialAbonos.push({
      montoUsd: abono,
      fechaIso: new Date().toISOString().slice(0, 10),
      ts: Date.now(),
      usuario: state.sesion?.usuario || "Administrador"
    });

    await setDoc(
      doc(refs.notasEntrega(), nota.id),
      {
        saldoPendienteUsd: nuevoSaldo,
        esCredito: nuevoSaldo > 0.01,
        saldadaEn: nuevoSaldo <= 0.01 ? new Date().toISOString().slice(0, 10) : (nota.saldadaEn || null),
        saldadaTs: nuevoSaldo <= 0.01 ? Date.now() : (nota.saldadaTs || null),
        abonos: historialAbonos,
        actualizadoEn: serverTimestamp()
      },
      { merge: true }
    );

    if (typeof window.NEXUS_VE_REFRESH_ALERTAS === "function") {
      await window.NEXUS_VE_REFRESH_ALERTAS();
    }
    await cargarDeudores();
  }

  contEl.addEventListener("click", async (e) => {
    const card = e.target.closest("[data-doc]");
    if (!card) return;
    const docId = decodeURIComponent(card.dataset.doc || "");

    if (e.target.closest(".btn-toggle-cli")) {
      if (expandidos.has(docId)) expandidos.delete(docId);
      else expandidos.add(docId);
      render();
      return;
    }

    const rowNota = e.target.closest("[data-folio]");
    if (!rowNota) return;
    const folio = rowNota.dataset.folio;
    const grupo = gruposDeudores.find((g) => g.documento === docId);
    const nota = grupo?.notas.find((n) => (n.folio || n.id) === folio);
    if (!nota) return;

    if (e.target.closest(".btn-abonar")) {
      const val = parseFloat(rowNota.querySelector(".inp-abono")?.value || "0");
      await aplicarAbono(docId, folio, val);
    } else if (e.target.closest(".btn-saldar")) {
      await aplicarAbono(docId, folio, Number(nota.saldoPendienteUsd || 0));
    } else if (e.target.closest(".btn-ver-nota")) {
      imprimirDocumentoCarta({
        tipo: "NOTA DE ENTREGA",
        folio: nota.folio || nota.id,
        empresa: state.empresa,
        cliente: nota.cliente || { documento: grupo.documento, nombre: grupo.nombre },
        items: nota.items || [],
        totalUsd: Number(nota.totalUsd || 0),
        monedas: nota.monedas || ["USD", "BS"],
        tasas: getTasaActiva(state),
        pagos: nota.pagos || [],
        observaciones: `Saldo pendiente: $${Number(nota.saldoPendienteUsd || 0).toFixed(2)} • Plazo: ${nota.plazoDias} días.`
      });
    }
  });

  async function cargarDeudores() {
    const snap = await getDocs(refs.notasEntrega());
    const raw = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    gruposDeudores = construirGrupos(raw);
    render();
  }

  busqEl.addEventListener("input", render);
  solo30El.addEventListener("change", render);

  await cargarDeudores();
}
