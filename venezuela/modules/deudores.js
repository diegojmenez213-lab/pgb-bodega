// venezuela/modules/deudores.js
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
  serverTimestamp
} from "../core/db.js";
import { imprimirDocumentoCarta } from "./documentos-pdf.js";

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

function equivalenciasTexto(montoUsd, tasas) {
  const usd = Number(montoUsd || 0);
  const bcv = Number(tasas.bcvActiva || tasas.bcvHoy || 0);
  const usdt = Number(tasas.usdt || 0);
  const eur = Number(tasas.eur || 0);
  const partes = [];
  if (bcv > 0) partes.push(`Bs. ${(usd * bcv).toFixed(2)}`);
  const valUsdt = bcv > 0 && usdt > 0 ? (usd * bcv) / usdt : usd;
  partes.push(`${valUsdt.toFixed(2)} USDT`);
  if (bcv > 0 && eur > 0) partes.push(`€ ${((usd * bcv) / eur).toFixed(2)}`);
  return partes.join(" • ");
}

function diasTranscurridos(nota, ahora = Date.now()) {
  const baseTs = Number(nota.creadoTs || 0);
  if (!baseTs) return 0;
  return Math.max(0, Math.floor((ahora - baseTs) / 86400000));
}

function diasRestantesVencimiento(nota, ahora = Date.now()) {
  const plazo = Math.max(1, Number(nota.diasCredito || 15));
  const baseTs = Number(nota.creadoTs || 0);
  const venceTs = Number(nota.venceTs || (baseTs ? baseTs + plazo * 86400000 : 0));
  if (!venceTs) return plazo;
  return (venceTs - ahora) / 86400000;
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

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);

  root.innerHTML = `
    <div class="space-y-4 max-w-6xl mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Deudores Activos</h1>
          <p class="text-xs text-slate-500">Abono global en cascada (FIFO) o por nota individual, con referencia bancaria y límite de crédito editable.</p>
        </div>
        <div class="flex flex-wrap gap-2 text-xs font-extrabold">
          <div class="px-3 py-1.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 font-mono-ve">
            Total por Cobrar: $<span id="sumTotalDeudaUsd">0.00</span>
          </div>
          <div id="pillPorVencer" class="hidden px-3 py-1.5 rounded-xl bg-sky-50 border border-sky-200 text-sky-800 font-mono-ve">
            Por vencer ≤3d: <span id="sumPorVencer">0</span>
          </div>
          <div id="pillVencidas" class="hidden px-3 py-1.5 rounded-xl bg-amber-100 border border-amber-300 text-amber-900 font-mono-ve">
            Vencidas: <span id="sumVencidas">0</span>
          </div>
          <div id="pillCriticos30" class="hidden px-3 py-1.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 font-mono-ve">
            +30d: <span id="sumCriticos30">0</span>
          </div>
        </div>
      </div>

      <div class="ve-card p-3 flex flex-wrap items-center justify-between gap-2">
        <input id="busqDeudor" type="text" placeholder="Buscar cliente por nombre o cédula/RIF..." class="flex-1 min-w-[200px] bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold outline-none focus:border-slate-950" />
        <div class="flex flex-wrap items-center gap-3 text-xs font-bold text-slate-700 px-1">
          <label class="flex items-center gap-1.5 cursor-pointer">
            <input id="chkPorVencer" type="checkbox" />
            Por vencer (≤3d)
          </label>
          <label class="flex items-center gap-1.5 cursor-pointer">
            <input id="chkVencidas" type="checkbox" />
            Vencidas
          </label>
          <label class="flex items-center gap-1.5 cursor-pointer">
            <input id="chkSolo30Dias" type="checkbox" />
            +30 días
          </label>
        </div>
      </div>

      <div id="listaDeudores" class="space-y-2.5">
        <div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">Cargando deudores activos...</div>
      </div>
    </div>
  `;

  let gruposDeudores = [];
  let clientesMap = new Map();
  const expandidos = new Set();
  const abonosAbiertos = new Set();

  const busqEl = root.querySelector("#busqDeudor");
  const porVencerEl = root.querySelector("#chkPorVencer");
  const vencidasEl = root.querySelector("#chkVencidas");
  const solo30El = root.querySelector("#chkSolo30Dias");
  const contEl = root.querySelector("#listaDeudores");

  function construirGrupos(notasRaw) {
    const ahora = Date.now();
    const mapa = new Map();

    for (const n of notasRaw) {
      if (n.anulada) continue;
      const saldo = Number(n.saldoPendienteUsd ?? (n.esCredito ? n.totalUsd : 0) ?? 0);
      if (saldo <= 0.01) continue;

      const docId = normalizarIdVE(n.cliente?.documento || "") || "V-00000000";
      const nombreCli = (n.cliente?.nombre || "").trim() || "Consumidor Final";
      const dias = diasTranscurridos(n, ahora);
      const plazo = Math.max(1, Number(n.diasCredito || 15));
      const diasRest = diasRestantesVencimiento(n, ahora);
      const vencida = diasRest < 0 || dias > plazo;
      const porVencer = !vencida && diasRest <= 3;

      if (!mapa.has(docId)) {
        const cliData = clientesMap.get(docId) || {};
        mapa.set(docId, {
          documento: docId,
          nombre: nombreCli,
          saldoFavorUsd: Number(cliData.saldoAFavorUsd || 0),
          limiteCreditoUsd: Number(cliData.limiteCreditoUsd || 0),
          totalSaldoUsd: 0,
          maxDias: 0,
          tienePorVencer: false,
          tieneVencida: false,
          tieneMas30: false,
          notas: []
        });
      }

      const g = mapa.get(docId);
      if (nombreCli && g.nombre === "Consumidor Final") g.nombre = nombreCli;
      g.totalSaldoUsd = Number((g.totalSaldoUsd + saldo).toFixed(2));
      g.maxDias = Math.max(g.maxDias, dias);
      if (porVencer) g.tienePorVencer = true;
      if (vencida) g.tieneVencida = true;
      if (dias >= 30) g.tieneMas30 = true;

      g.notas.push({
        ...n,
        saldoPendienteUsd: saldo,
        diasTranscurridos: dias,
        plazoDias: plazo,
        diasRestantes: diasRest,
        vencida,
        porVencer
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
    const fPorVencer = porVencerEl.checked;
    const fVencidas = vencidasEl.checked;
    const fSolo30 = solo30El.checked;

    const totalCartera = gruposDeudores.reduce((acc, g) => acc + g.totalSaldoUsd, 0);
    const cntPorVencer = gruposDeudores.filter((g) => g.tienePorVencer).length;
    const cntVencidas = gruposDeudores.filter((g) => g.tieneVencida).length;
    const cntCriticos30 = gruposDeudores.filter((g) => g.tieneMas30).length;

    root.querySelector("#sumTotalDeudaUsd").textContent = totalCartera.toFixed(2);

    const pPv = root.querySelector("#pillPorVencer");
    if (cntPorVencer > 0) {
      pPv.classList.remove("hidden");
      root.querySelector("#sumPorVencer").textContent = String(cntPorVencer);
    } else pPv.classList.add("hidden");

    const pVe = root.querySelector("#pillVencidas");
    if (cntVencidas > 0) {
      pVe.classList.remove("hidden");
      root.querySelector("#sumVencidas").textContent = String(cntVencidas);
    } else pVe.classList.add("hidden");

    const p30 = root.querySelector("#pillCriticos30");
    if (cntCriticos30 > 0) {
      p30.classList.remove("hidden");
      root.querySelector("#sumCriticos30").textContent = String(cntCriticos30);
    } else p30.classList.add("hidden");

    const filtrados = gruposDeudores.filter((g) => {
      if (fSolo30 && !g.tieneMas30) return false;
      if (fVencidas && !g.tieneVencida) return false;
      if (fPorVencer && !g.tienePorVencer) return false;
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
          <div class="btn-toggle-cli flex items-center justify-between gap-3 cursor-pointer select-none">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-sm font-extrabold text-slate-900 truncate">${g.nombre}</span>
                <span class="font-mono-ve text-[11px] font-bold px-2 py-0.5 rounded-lg bg-slate-100 text-slate-700">${g.documento}</span>
                <span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full ${
                  g.notas.length > 1 ? "bg-indigo-100 text-indigo-800" : "bg-slate-100 text-slate-600"
                }">${g.notas.length} ${g.notas.length === 1 ? "nota" : "notas"}</span>
                ${g.tieneMas30 ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-rose-100 text-rose-800">+30 días</span>` : ""}
                ${!g.tieneMas30 && g.tieneVencida ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-amber-100 text-amber-900">Vencida</span>` : ""}
                ${!g.tieneVencida && g.tienePorVencer ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-sky-100 text-sky-800">Por vencer ≤3d</span>` : ""}
                ${g.limiteCreditoUsd > 0 ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-900">Tope: $${g.limiteCreditoUsd.toFixed(2)}</span>` : ""}
                ${g.saldoFavorUsd > 0.01 ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">A favor: $${g.saldoFavorUsd.toFixed(2)}</span>` : ""}
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

          <div class="${abierta ? "" : "hidden"} pt-3 border-t border-slate-200 space-y-2.5">
            <!-- Barra de Límite de Crédito configurable -->
            <div class="p-2.5 rounded-xl bg-amber-50/60 border border-amber-200 flex flex-wrap items-center justify-between gap-2 text-xs">
              <span class="font-bold text-amber-950">
                Límite de crédito: <strong class="font-mono-ve">${g.limiteCreditoUsd > 0 ? `$${g.limiteCreditoUsd.toFixed(2)}` : "Sin límite"}</strong>
              </span>
              <div class="flex items-center gap-1.5">
                <input type="text" inputmode="numeric" value="${g.limiteCreditoUsd.toFixed(2)}" class="inp-lim-cli w-24 bg-white border border-amber-300 rounded-lg px-2 py-1 text-xs font-mono-ve font-bold text-right" title="0.00 = Sin límite" />
                <button type="button" class="btn-save-lim px-2.5 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-extrabold cursor-pointer">
                  Guardar tope
                </button>
              </div>
            </div>

            ${g.saldoFavorUsd > 0.01 ? `
              <div class="p-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-[11px] text-emerald-900">
                <strong>Saldo a favor disponible: $${g.saldoFavorUsd.toFixed(2)}</strong>
                <span class="font-mono-ve ml-1">(${equivalenciasTexto(g.saldoFavorUsd, tasas)})</span>
              </div>
            ` : ""}

            <!-- Abono Global en Cascada (FIFO) cuando tiene más de 1 nota -->
            ${g.notas.length > 1 ? `
              <div class="p-3 rounded-xl bg-indigo-50/70 border border-indigo-200 space-y-2">
                <div class="text-[11px] font-extrabold text-indigo-950">
                  ⚡ Abono Global en Cascada (FIFO) — paga automáticamente desde la nota más vieja a la más nueva
                </div>
                <div class="flex flex-wrap items-center gap-1.5">
                  <select class="sel-met-fifo bg-white border border-indigo-300 rounded-lg px-2 py-1 text-xs font-bold">
                    ${METODOS_PAGO.map((m) => `<option value="${m}">${m}</option>`).join("")}
                  </select>
                  <input type="text" placeholder="Ref." class="inp-ref-fifo w-16 bg-white border border-indigo-300 rounded-lg px-1.5 py-1 text-[11px] font-mono-ve font-bold" />
                  <input type="text" inputmode="numeric" value="${g.totalSaldoUsd.toFixed(2)}" class="inp-monto-fifo w-24 bg-white border border-indigo-300 rounded-lg px-2 py-1 text-xs font-mono-ve font-bold text-right" />
                  <button type="button" class="btn-abono-fifo px-3 py-1.5 rounded-lg bg-indigo-700 hover:bg-indigo-800 text-white text-xs font-extrabold cursor-pointer">
                    Aplicar Abono Global
                  </button>
                </div>
              </div>
            ` : ""}

            ${g.notas.map((n) => {
              const claveNota = `${g.documento}::${n.folio || n.id}`;
              const verAbonos = abonosAbiertos.has(claveNota);
              const abonos = Array.isArray(n.abonos) ? n.abonos : [];
              const badgeEstado = n.diasTranscurridos >= 30
                ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-rose-100 text-rose-800">+30d (${n.diasTranscurridos}d / ${n.plazoDias}d)</span>`
                : (n.vencida
                  ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-amber-100 text-amber-900">Vencida (${n.diasTranscurridos}d / ${n.plazoDias}d)</span>`
                  : (n.porVencer
                    ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-sky-100 text-sky-800">Por vencer en ${Math.max(0, Math.ceil(n.diasRestantes))}d</span>`
                    : `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">${n.diasTranscurridos}d / plazo ${n.plazoDias}d</span>`));

              return `
                <div class="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2" data-folio="${n.folio || n.id}">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="font-mono-ve text-xs font-extrabold text-slate-900">Nota #${n.folio || n.id}</span>
                      <span class="text-[11px] text-slate-500">${n.fechaIso || ""}</span>
                      ${badgeEstado}
                    </div>
                    <div class="font-mono-ve text-xs font-extrabold text-slate-900">
                      Saldo: <span class="text-rose-700">$${Number(n.saldoPendienteUsd).toFixed(2)}</span>
                      <span class="text-slate-400 font-normal">/ $${Number(n.totalUsd || 0).toFixed(2)}</span>
                    </div>
                  </div>

                  <div class="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <div class="flex flex-wrap items-center gap-1.5">
                      <select class="sel-met-abono bg-white border border-slate-300 rounded-lg px-2 py-1 text-xs font-bold">
                        ${METODOS_PAGO.map((m) => `<option value="${m}">${m}</option>`).join("")}
                      </select>
                      <input type="text" placeholder="Ref." class="inp-ref-abono w-16 bg-white border border-slate-300 rounded-lg px-1.5 py-1 text-[11px] font-mono-ve font-bold" />
                      <input
                        type="text"
                        inputmode="numeric"
                        value="${Number(n.saldoPendienteUsd).toFixed(2)}"
                        class="inp-abono w-24 bg-white border border-slate-300 rounded-lg px-2 py-1 text-xs font-mono-ve font-bold text-right"
                      />
                      <button type="button" class="btn-abonar px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold cursor-pointer">
                        Registrar Abono
                      </button>
                      <button type="button" class="btn-saldar px-2.5 py-1.5 rounded-lg bg-slate-950 hover:bg-slate-800 text-white text-xs font-extrabold cursor-pointer">
                        Saldar
                      </button>
                      ${g.saldoFavorUsd > 0.01 ? `
                        <button type="button" class="btn-usar-favor px-2.5 py-1.5 rounded-lg bg-emerald-100 hover:bg-emerald-200 text-emerald-900 text-xs font-extrabold cursor-pointer">
                          Usar saldo a favor
                        </button>
                      ` : ""}
                    </div>
                    <div class="flex items-center gap-1.5">
                      <button type="button" class="btn-hist-abonos px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-700 text-[11px] font-bold cursor-pointer">
                        Abonos (${abonos.length})
                      </button>
                      <button type="button" class="btn-ver-nota px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-700 text-[11px] font-bold cursor-pointer">
                        PDF Nota
                      </button>
                    </div>
                  </div>

                  <div class="${verAbonos ? "" : "hidden"} pt-2 border-t border-slate-200 space-y-1">
                    <div class="text-[10px] font-extrabold uppercase text-slate-400">Historial de Abonos</div>
                    ${abonos.length
                      ? abonos.map((ab) => `
                        <div class="flex items-center justify-between gap-2 text-[11px] bg-white px-2.5 py-1.5 rounded-lg border border-slate-200/80">
                          <span class="font-mono-ve text-slate-600">
                            ${ab.fechaHoraTxt || formatearFechaHora(ab.ts, ab.fechaIso)} • <strong class="text-slate-800">${ab.metodo || "Efectivo USD"}</strong>${ab.referencia ? ` (Ref: ${ab.referencia})` : ""} • ${ab.usuario || "Admin"}
                          </span>
                          <span class="font-mono-ve font-extrabold text-emerald-700">+$${Number(ab.montoUsd || 0).toFixed(2)}</span>
                        </div>
                      `).join("")
                      : `<div class="text-[11px] text-slate-400">Sin abonos registrados aún en esta nota.</div>`}
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        </div>
      `;
    }).join("");
  }

  async function aplicarAbono(docId, folio, montoIngresado, metodo = "Efectivo USD", referencia = "", usandoSaldoFavor = false) {
    const grupo = gruposDeudores.find((g) => g.documento === docId);
    const nota = grupo?.notas.find((n) => (n.folio || n.id) === folio);
    if (!nota) return;

    const monto = Math.max(0, Number(montoIngresado || 0));
    if (monto <= 0) return alert("Ingresa un monto mayor a $0.00.");

    const saldoActual = Number(nota.saldoPendienteUsd || 0);
    const abonoAplicadoANota = Math.min(saldoActual, monto);
    const sobrepago = usandoSaldoFavor ? 0 : Math.max(0, Number((monto - saldoActual).toFixed(2)));
    const nuevoSaldo = Math.max(0, Number((saldoActual - abonoAplicadoANota).toFixed(2)));
    const now = Date.now();
    const tasas = getTasaActiva(state);

    const historialAbonos = Array.isArray(nota.abonos) ? [...nota.abonos] : [];
    historialAbonos.push({
      montoUsd: abonoAplicadoANota,
      sobrepagoUsd: sobrepago,
      montoBs: tasas.bcvActiva ? Number((monto * tasas.bcvActiva).toFixed(2)) : 0,
      metodo: usandoSaldoFavor ? "Saldo a Favor" : metodo,
      referencia: String(referencia || "").trim(),
      usandoSaldoFavor,
      cierreId: null,
      fechaIso: new Date(now).toISOString().slice(0, 10),
      fechaHoraTxt: formatearFechaHora(now),
      ts: now,
      usuario: state.sesion?.usuario || "Administrador"
    });

    const batch = writeBatch(db);
    batch.set(
      doc(refs.notasEntrega(), nota.id),
      {
        saldoPendienteUsd: nuevoSaldo,
        esCredito: nuevoSaldo > 0.01,
        saldadaEn: nuevoSaldo <= 0.01 ? new Date(now).toISOString().slice(0, 10) : (nota.saldadaEn || null),
        saldadaTs: nuevoSaldo <= 0.01 ? now : (nota.saldadaTs || null),
        abonos: historialAbonos,
        actualizadoEn: serverTimestamp()
      },
      { merge: true }
    );

    const actualFavor = Number(clientesMap.get(docId)?.saldoAFavorUsd || 0);
    if (usandoSaldoFavor) {
      const nuevoFavor = Math.max(0, Number((actualFavor - abonoAplicadoANota).toFixed(2)));
      batch.set(
        doc(refs.clientes(), docId),
        { documento: docId, nombre: grupo.nombre, saldoAFavorUsd: nuevoFavor, actualizadoEn: serverTimestamp() },
        { merge: true }
      );
    } else if (sobrepago > 0.01 && docId !== "V-00000000") {
      const nuevoFavor = Number((actualFavor + sobrepago).toFixed(2));
      batch.set(
        doc(refs.clientes(), docId),
        { documento: docId, nombre: grupo.nombre, saldoAFavorUsd: nuevoFavor, actualizadoEn: serverTimestamp() },
        { merge: true }
      );
    }

    await batch.commit();
    if (sobrepago > 0.01 && docId !== "V-00000000") {
      alert(`Abono registrado. Se acreditaron +$${sobrepago.toFixed(2)} al saldo a favor de ${grupo.nombre}.`);
    }

    if (typeof window.NEXUS_VE_REFRESH_ALERTAS === "function") {
      await window.NEXUS_VE_REFRESH_ALERTAS();
    }
    await cargarDeudores();
  }

  async function aplicarAbonoGlobalFIFO(docId, montoTotal, metodo = "Efectivo USD", referencia = "") {
    const grupo = gruposDeudores.find((g) => g.documento === docId);
    if (!grupo || !grupo.notas.length) return;

    let restante = Math.max(0, Number(montoTotal || 0));
    if (restante <= 0) return alert("Ingresa un monto mayor a $0.00.");

    const now = Date.now();
    const tasas = getTasaActiva(state);
    const batch = writeBatch(db);
    let notasAfectadas = 0;

    for (let i = 0; i < grupo.notas.length && restante > 0.009; i++) {
      const nota = grupo.notas[i];
      const saldoActual = Number(nota.saldoPendienteUsd || 0);
      if (saldoActual <= 0.009) continue;

      const esUltima = i === grupo.notas.length - 1;
      const aplicado = Math.min(saldoActual, restante);
      restante = Number((restante - aplicado).toFixed(2));
      const sobrepagoEnEsta = esUltima && restante > 0.01 ? restante : 0;
      if (sobrepagoEnEsta > 0) restante = 0;

      const nuevoSaldo = Math.max(0, Number((saldoActual - aplicado).toFixed(2)));
      const historialAbonos = Array.isArray(nota.abonos) ? [...nota.abonos] : [];
      historialAbonos.push({
        montoUsd: Number(aplicado.toFixed(2)),
        sobrepagoUsd: sobrepagoEnEsta,
        montoBs: tasas.bcvActiva ? Number(((aplicado + sobrepagoEnEsta) * tasas.bcvActiva).toFixed(2)) : 0,
        metodo,
        referencia: String(referencia || "").trim(),
        usandoSaldoFavor: false,
        esFifo: true,
        cierreId: null,
        fechaIso: new Date(now).toISOString().slice(0, 10),
        fechaHoraTxt: formatearFechaHora(now),
        ts: now,
        usuario: state.sesion?.usuario || "Administrador"
      });

      batch.set(
        doc(refs.notasEntrega(), nota.id),
        {
          saldoPendienteUsd: nuevoSaldo,
          esCredito: nuevoSaldo > 0.01,
          saldadaEn: nuevoSaldo <= 0.01 ? new Date(now).toISOString().slice(0, 10) : (nota.saldadaEn || null),
          saldadaTs: nuevoSaldo <= 0.01 ? now : (nota.saldadaTs || null),
          abonos: historialAbonos,
          actualizadoEn: serverTimestamp()
        },
        { merge: true }
      );
      notasAfectadas++;

      if (sobrepagoEnEsta > 0.01 && docId !== "V-00000000") {
        const actualFavor = Number(clientesMap.get(docId)?.saldoAFavorUsd || 0);
        batch.set(
          doc(refs.clientes(), docId),
          {
            documento: docId,
            nombre: grupo.nombre,
            saldoAFavorUsd: Number((actualFavor + sobrepagoEnEsta).toFixed(2)),
            actualizadoEn: serverTimestamp()
          },
          { merge: true }
        );
      }
    }

    await batch.commit();
    alert(`Abono Global FIFO aplicado en ${notasAfectadas} nota(s) de ${grupo.nombre}.`);
    if (typeof window.NEXUS_VE_REFRESH_ALERTAS === "function") {
      await window.NEXUS_VE_REFRESH_ALERTAS();
    }
    await cargarDeudores();
  }

  contEl.addEventListener("focusin", (e) => {
    if (
      e.target.classList.contains("inp-abono") ||
      e.target.classList.contains("inp-monto-fifo") ||
      e.target.classList.contains("inp-lim-cli")
    ) {
      fijarCursorAlFinal(e.target);
    }
  });

  contEl.addEventListener("input", (e) => {
    if (
      e.target.classList.contains("inp-abono") ||
      e.target.classList.contains("inp-monto-fifo") ||
      e.target.classList.contains("inp-lim-cli")
    ) {
      formatearEntradaMoneda(e.target);
    }
  });

  contEl.addEventListener("click", async (e) => {
    if (
      e.target.classList.contains("inp-abono") ||
      e.target.classList.contains("inp-monto-fifo") ||
      e.target.classList.contains("inp-lim-cli")
    ) {
      fijarCursorAlFinal(e.target);
      return;
    }

    const card = e.target.closest("[data-doc]");
    if (!card) return;
    const docId = decodeURIComponent(card.dataset.doc || "");

    if (e.target.closest(".btn-toggle-cli")) {
      if (expandidos.has(docId)) expandidos.delete(docId);
      else expandidos.add(docId);
      render();
      return;
    }

    if (e.target.closest(".btn-save-lim")) {
      const val = Math.max(0, parseFloat(card.querySelector(".inp-lim-cli")?.value || "0"));
      const grupo = gruposDeudores.find((g) => g.documento === docId);
      await setDoc(doc(refs.clientes(), docId), {
        documento: docId,
        nombre: grupo?.nombre || docId,
        limiteCreditoUsd: val,
        actualizadoEn: serverTimestamp()
      }, { merge: true });
      alert(val > 0 ? `Límite de crédito actualizado a $${val.toFixed(2)}.` : "Límite de crédito eliminado (sin tope).");
      await cargarDeudores();
      return;
    }

    if (e.target.closest(".btn-abono-fifo")) {
      const monto = parseFloat(card.querySelector(".inp-monto-fifo")?.value || "0");
      const met = card.querySelector(".sel-met-fifo")?.value || "Efectivo USD";
      const ref = card.querySelector(".inp-ref-fifo")?.value || "";
      await aplicarAbonoGlobalFIFO(docId, monto, met, ref);
      return;
    }

    const rowNota = e.target.closest("[data-folio]");
    if (!rowNota) return;
    const folio = rowNota.dataset.folio;
    const grupo = gruposDeudores.find((g) => g.documento === docId);
    const nota = grupo?.notas.find((n) => (n.folio || n.id) === folio);
    if (!nota) return;

    const metodoSel = rowNota.querySelector(".sel-met-abono")?.value || "Efectivo USD";
    const refTxt = rowNota.querySelector(".inp-ref-abono")?.value || "";

    if (e.target.closest(".btn-abonar")) {
      const val = parseFloat(rowNota.querySelector(".inp-abono")?.value || "0");
      await aplicarAbono(docId, folio, val, metodoSel, refTxt, false);
    } else if (e.target.closest(".btn-saldar")) {
      const inpVal = parseFloat(rowNota.querySelector(".inp-abono")?.value || "0");
      const montoSaldar = inpVal >= Number(nota.saldoPendienteUsd || 0) ? inpVal : Number(nota.saldoPendienteUsd || 0);
      await aplicarAbono(docId, folio, montoSaldar, metodoSel, refTxt, false);
    } else if (e.target.closest(".btn-usar-favor")) {
      const disp = Number(grupo.saldoFavorUsd || 0);
      const aplicar = Math.min(disp, Number(nota.saldoPendienteUsd || 0));
      if (aplicar <= 0) return;
      if (!confirm(`¿Aplicar $${aplicar.toFixed(2)} del saldo a favor de ${grupo.nombre} a la Nota #${folio}?`)) return;
      await aplicarAbono(docId, folio, aplicar, "Saldo a Favor", "", true);
    } else if (e.target.closest(".btn-hist-abonos")) {
      const claveNota = `${docId}::${folio}`;
      if (abonosAbiertos.has(claveNota)) abonosAbiertos.delete(claveNota);
      else abonosAbiertos.add(claveNota);
      render();
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
    const [snapNotas, snapCli] = await Promise.all([
      getDocs(query(refs.notasEntrega(), where("saldoPendienteUsd", ">", 0))),
      getDocs(refs.clientes())
    ]);
    clientesMap = new Map();
    snapCli.forEach((d) => {
      const c = d.data();
      const id = normalizarIdVE(c.documento || d.id);
      clientesMap.set(id, { id, ...c });
    });
    const raw = snapNotas.docs.map((d) => ({ id: d.id, ...d.data() }));
    gruposDeudores = construirGrupos(raw);
    render();
  }

  busqEl.addEventListener("input", render);
  porVencerEl.addEventListener("change", render);
  vencidasEl.addEventListener("change", render);
  solo30El.addEventListener("change", render);

  await cargarDeudores();
}
