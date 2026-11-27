// venezuela/modules/inventario-planta.js
import {
  db,
  getTenantRefs,
  doc,
  getDocs,
  runTransaction,
  normalizarIdVE,
  serverTimestamp,
  obtenerFechaLocalIso
} from "../core/db.js";
import { abrirDocumentoPDF } from "./documentos-pdf.js";

const METODOS_PAGO = [
  "Efectivo USD",
  "Pago Móvil Bs.",
  "Transferencia Bs.",
  "Zelle",
  "Binance USDT",
  "Punto de Venta Bs.",
  "Efectivo Bs."
];

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

function tieneAbonosRegistrados(n) {
  return (Array.isArray(n?.abonos) && n.abonos.length > 0) || Number(n?.totalAbonadoUsd || 0) > 0.01;
}

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);

  root.innerHTML = `
    <div class="space-y-4 max-w-6xl mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Ventas Realizadas / Notas de Entrega</h1>
          <p class="text-xs text-slate-500">Consulta notas emitidas, genera PDF o edita notas del día en curso (antes del cierre).</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <input id="busqNotas" type="text" placeholder="Buscar folio, cliente o RIF..." class="bg-white border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold" />
          <button id="btnRecargarNotas" type="button" class="px-3 py-2 rounded-xl bg-slate-950 text-white text-xs font-extrabold cursor-pointer">
            ↻ Actualizar
          </button>
        </div>
      </div>

      <div id="panelEditarNota" class="hidden ve-card border-2 border-sky-400 bg-sky-50/40 p-4 space-y-3">
        <div class="flex items-center justify-between gap-2 border-b border-sky-200 pb-2">
          <div>
            <div class="text-[10px] font-extrabold uppercase tracking-wider text-sky-900">Edición en Jornada Activa</div>
            <h2 id="titEditarNota" class="text-sm font-extrabold text-slate-950">Editando Nota #---</h2>
          </div>
          <button id="btnCerrarEditarNota" type="button" class="px-2.5 py-1 rounded-lg bg-white border border-slate-300 text-xs font-extrabold cursor-pointer">
            ✕ Cancelar
          </button>
        </div>

        <div id="listaItemsEditar" class="space-y-2 max-h-72 overflow-y-auto"></div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2 border-t border-sky-200">
          <div>
            <label class="text-[10px] font-extrabold text-slate-600 block">Condición</label>
            <select id="editCondicion" class="w-full bg-white border border-slate-300 rounded-xl px-2.5 py-1.5 text-xs font-bold">
              <option value="contado">Contado</option>
              <option value="credito">Crédito</option>
            </select>
          </div>
          <div>
            <label class="text-[10px] font-extrabold text-slate-600 block">Días Crédito</label>
            <input id="editDiasCredito" type="number" min="1" max="365" value="15" class="w-full bg-white border border-slate-300 rounded-xl px-2.5 py-1.5 text-xs font-mono-ve font-bold" />
          </div>
          <div class="text-right">
            <div class="text-[10px] font-extrabold text-slate-500">NUEVO TOTAL USD</div>
            <div id="editTotalUsd" class="text-base font-mono-ve font-extrabold text-slate-950">$0.00</div>
            <div id="editNetoMeta" class="text-[10px] font-mono-ve font-bold text-slate-600"></div>
          </div>
        </div>

        <div class="space-y-1.5 pt-2 border-t border-sky-200">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-[11px] font-extrabold text-slate-700">Pagos / Abonos</span>
            <div class="flex items-center gap-2">
              <button id="btnIgualarPagoEdit" type="button" class="px-2 py-1 rounded-lg bg-white border border-sky-300 text-[10px] font-extrabold text-sky-900 cursor-pointer">
                Igualar pago al total
              </button>
              <button id="btnAddPagoEdit" type="button" class="text-[11px] font-extrabold text-sky-900 hover:underline cursor-pointer">+ Agregar pago</button>
            </div>
          </div>
          <div id="editPagosLista" class="space-y-1.5"></div>
          <div id="editEstadoPagos" class="flex justify-between text-[11px] font-bold pt-1">
            <span id="editLblRestante" class="text-slate-600">Restante por cubrir:</span>
            <span id="editValRestante" class="font-mono-ve text-emerald-700">$0.00</span>
          </div>

          <div id="editPanelExcedente" class="hidden p-2.5 rounded-xl bg-amber-50 border border-amber-300 space-y-2">
            <div class="flex items-center justify-between text-[11px]">
              <span class="font-extrabold text-amber-950">Excedente en pagos:</span>
              <span id="editExcedenteUsd" class="font-mono-ve font-extrabold text-amber-900">$0.00</span>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              <button type="button" id="btnEditExcVuelto" class="py-1.5 px-2 rounded-lg text-[11px] font-extrabold bg-sky-700 text-white cursor-pointer">
                💵 Devolver vuelto (ajustar pago)
              </button>
              <button type="button" id="btnEditExcFavor" class="py-1.5 px-2 rounded-lg text-[11px] font-extrabold bg-white border border-sky-300 text-sky-900 cursor-pointer">
                💾 Dejar Saldo a Favor
              </button>
            </div>
          </div>
        </div>

        <div class="flex justify-end gap-2 pt-2">
          <button id="btnGuardarEdicionNota" type="button" class="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold cursor-pointer">
            ✓ Guardar Cambios en la Nota
          </button>
        </div>
      </div>

      <div id="listaNotas" class="space-y-2.5">
        <div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">Cargando notas...</div>
      </div>
    </div>
  `;

  let notas = [];
  let catalogo = [];
  let notaEnEdicion = null;
  let itemsEdicion = [];
  let pagosEdicion = [];
  let modoExcedenteEdit = "vuelto";
  let guardandoEdicion = false;

  function esEditableHoy(n) {
    if (!n || n.anulada || n.cierreId || tieneAbonosRegistrados(n)) return false;
    const hoyLocal = obtenerFechaLocalIso();
    const jornadaActiva = state.empresa?.jornadaActivaId || hoyLocal;
    if (n.jornadaId && jornadaActiva) {
      return n.jornadaId === jornadaActiva;
    }
    return (n.fechaIso || "") === hoyLocal;
  }

  function calcularResumenEdicion() {
    const totalUsd = Number(
      itemsEdicion.reduce((acc, it) => acc + Number(it.cantidad || 0) * Number(it.precioUsd || 0), 0).toFixed(2)
    );
    const docCli = normalizarIdVE(notaEnEdicion?.cliente?.documento || "");
    const esClienteReal = Boolean(docCli && docCli !== "V-00000000");
    const descFavorPrevio = Number(notaEnEdicion?.saldoFavorAplicadoUsd || 0);
    const descFavorNuevo = esClienteReal ? Math.min(descFavorPrevio, totalUsd) : 0;
    const objetivoHoy = Math.max(0, Number((totalUsd - descFavorNuevo).toFixed(2)));
    const pagadoHoy = Number(pagosEdicion.reduce((acc, p) => acc + Number(p.montoUsd || 0), 0).toFixed(2));
    const restante = Math.max(0, Number((objetivoHoy - pagadoHoy).toFixed(2)));
    const excedente = Math.max(0, Number((pagadoHoy - objetivoHoy).toFixed(2)));
    const esCre = root.querySelector("#editCondicion").value === "credito";

    root.querySelector("#editTotalUsd").textContent = `$${totalUsd.toFixed(2)}`;
    root.querySelector("#editNetoMeta").textContent = descFavorNuevo > 0.01
      ? `Saldo a favor aplicado: -$${descFavorNuevo.toFixed(2)} • Neto: $${objetivoHoy.toFixed(2)}`
      : "";

    root.querySelector("#editLblRestante").textContent = esCre ? "Quedará a crédito:" : "Restante por cubrir:";
    const valRestEl = root.querySelector("#editValRestante");
    valRestEl.textContent = `$${restante.toFixed(2)}`;
    valRestEl.className = esCre
      ? "font-mono-ve text-amber-800"
      : (restante <= 0.01 ? "font-mono-ve text-emerald-700" : "font-mono-ve text-rose-600");

    const panelExc = root.querySelector("#editPanelExcedente");
    const btnExcVuelto = root.querySelector("#btnEditExcVuelto");
    const btnExcFavor = root.querySelector("#btnEditExcFavor");

    if (excedente > 0.01) {
      if (!esClienteReal) modoExcedenteEdit = "vuelto";
      root.querySelector("#editExcedenteUsd").textContent = `$${excedente.toFixed(2)}`;
      btnExcFavor.classList.toggle("hidden", !esClienteReal);
      if (modoExcedenteEdit === "vuelto") {
        btnExcVuelto.className = "py-1.5 px-2 rounded-lg text-[11px] font-extrabold bg-sky-700 text-white cursor-pointer";
        btnExcFavor.className = `${esClienteReal ? "" : "hidden "}py-1.5 px-2 rounded-lg text-[11px] font-extrabold bg-white border border-sky-300 text-sky-900 cursor-pointer`;
      } else {
        btnExcFavor.className = "py-1.5 px-2 rounded-lg text-[11px] font-extrabold bg-emerald-700 text-white cursor-pointer";
        btnExcVuelto.className = "py-1.5 px-2 rounded-lg text-[11px] font-extrabold bg-white border border-sky-300 text-sky-900 cursor-pointer";
      }
      panelExc.classList.remove("hidden");
    } else {
      panelExc.classList.add("hidden");
    }

    return {
      totalUsd,
      docCli,
      esClienteReal,
      descFavorPrevio,
      descFavorNuevo,
      objetivoHoy,
      pagadoHoy,
      restante,
      excedente,
      esCre
    };
  }

  root.querySelector("#btnEditExcVuelto").addEventListener("click", () => {
    modoExcedenteEdit = "vuelto";
    calcularResumenEdicion();
  });

  root.querySelector("#btnEditExcFavor").addEventListener("click", () => {
    modoExcedenteEdit = "favor";
    calcularResumenEdicion();
  });

  root.querySelector("#btnIgualarPagoEdit").addEventListener("click", () => {
    const res = calcularResumenEdicion();
    if (!pagosEdicion.length) {
      pagosEdicion = [{ metodo: "Efectivo USD", montoUsd: res.objetivoHoy, referencia: "" }];
    } else {
      pagosEdicion = [{ ...pagosEdicion[0], montoUsd: res.objetivoHoy }];
    }
    renderPagosEdicion();
  });

  function renderItemsEdicion() {
    const cont = root.querySelector("#listaItemsEditar");
    if (!itemsEdicion.length) {
      cont.innerHTML = `<div class="text-xs text-rose-700 font-bold py-3 text-center">La nota debe tener al menos 1 ítem.</div>`;
      calcularResumenEdicion();
      return;
    }

    cont.innerHTML = itemsEdicion.map((it, idx) => `
      <div class="p-2.5 rounded-xl bg-white border border-slate-200 flex flex-wrap items-center justify-between gap-2" data-eidx="${idx}">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="font-mono-ve text-xs font-extrabold text-slate-900">${it.codigo || it.id}</span>
            <span class="text-[9px] font-extrabold px-1.5 py-0.5 rounded-full ${
              it.origen === "planta" ? "bg-sky-100 text-sky-900" : "bg-emerald-100 text-emerald-800"
            }">${(it.origen || "almacen").toUpperCase()}</span>
          </div>
          <div class="text-[11px] font-semibold text-slate-600 truncate">${it.descripcion || ""}</div>
        </div>
        <div class="flex items-center gap-1.5">
          <label class="text-[10px] font-bold text-slate-500">Cant:</label>
          <input type="number" min="1" value="${it.cantidad}" class="inp-ecant w-16 bg-slate-50 border border-slate-300 rounded-lg px-1.5 py-1 text-xs font-mono-ve font-extrabold text-center" />
          <label class="text-[10px] font-bold text-slate-500">$/u:</label>
          <input type="text" inputmode="numeric" value="${Number(it.precioUsd || 0).toFixed(2)}" class="inp-eprec w-20 bg-slate-50 border border-slate-300 rounded-lg px-1.5 py-1 text-xs font-mono-ve font-bold text-right" />
          <button type="button" class="btn-erm-item text-xs font-bold text-rose-600 px-1.5 cursor-pointer">✕</button>
        </div>
      </div>
    `).join("");
    calcularResumenEdicion();
  }

  function renderPagosEdicion() {
    const cont = root.querySelector("#editPagosLista");
    cont.innerHTML = pagosEdicion.map((p, idx) => `
      <div class="flex items-center gap-1.5" data-epidx="${idx}">
        <select class="sel-emet flex-1 min-w-0 bg-white border border-slate-300 rounded-lg px-2 py-1.5 text-xs font-bold">
          ${METODOS_PAGO.map((m) => `<option value="${m}" ${p.metodo === m ? "selected" : ""}>${m}</option>`).join("")}
        </select>
        <input type="text" value="${p.referencia || ""}" placeholder="Ref." class="inp-epref w-16 bg-white border border-slate-300 rounded-lg px-1.5 py-1.5 text-[11px] font-mono-ve font-bold" />
        <input type="text" inputmode="numeric" value="${Number(p.montoUsd || 0).toFixed(2)}" class="inp-epmonto w-24 bg-white border border-slate-300 rounded-lg px-2 py-1.5 text-xs font-mono-ve font-bold text-right" />
        ${pagosEdicion.length > 1 ? `<button type="button" class="btn-erm-pago text-xs font-bold text-rose-600 px-1 cursor-pointer">✕</button>` : ""}
      </div>
    `).join("");
    calcularResumenEdicion();
  }

  function abrirEdicionNota(n) {
    if (!esEditableHoy(n)) {
      return alert("Solo se pueden editar notas de la jornada activa sin cerrar, sin anular y sin abonos registrados.");
    }
    notaEnEdicion = n;
    itemsEdicion = (n.items || []).map((it) => ({ ...it }));
    pagosEdicion = (n.pagos && n.pagos.length)
      ? n.pagos.map((p) => ({ ...p }))
      : [{ metodo: "Efectivo USD", montoUsd: 0, referencia: "" }];
    modoExcedenteEdit = Number(n.sobrepagoUsd || 0) > 0.01 ? "favor" : "vuelto";

    root.querySelector("#titEditarNota").textContent = `Editando Nota #${n.folio || n.id} (${n.cliente?.nombre || "Consumidor Final"})`;
    root.querySelector("#editCondicion").value = n.esCredito ? "credito" : "contado";
    root.querySelector("#editDiasCredito").value = Number(n.diasCredito || 15);
    root.querySelector("#panelEditarNota").classList.remove("hidden");
    renderItemsEdicion();
    renderPagosEdicion();
    root.querySelector("#panelEditarNota").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function cerrarEdicionNota() {
    notaEnEdicion = null;
    itemsEdicion = [];
    pagosEdicion = [];
    modoExcedenteEdit = "vuelto";
    root.querySelector("#panelEditarNota").classList.add("hidden");
  }

  root.querySelector("#btnCerrarEditarNota").addEventListener("click", cerrarEdicionNota);
  root.querySelector("#editCondicion").addEventListener("change", calcularResumenEdicion);

  root.querySelector("#listaItemsEditar").addEventListener("focusin", (e) => {
    if (e.target.classList.contains("inp-eprec")) fijarCursorAlFinal(e.target);
  });

  root.querySelector("#listaItemsEditar").addEventListener("input", (e) => {
    const row = e.target.closest("[data-eidx]");
    if (!row) return;
    const idx = Number(row.dataset.eidx);
    if (e.target.classList.contains("inp-ecant")) {
      itemsEdicion[idx].cantidad = Math.max(1, parseInt(e.target.value, 10) || 1);
    } else if (e.target.classList.contains("inp-eprec")) {
      itemsEdicion[idx].precioUsd = formatearEntradaMoneda(e.target);
    }
    calcularResumenEdicion();
  });

  root.querySelector("#listaItemsEditar").addEventListener("click", (e) => {
    if (e.target.classList.contains("inp-eprec")) {
      fijarCursorAlFinal(e.target);
      return;
    }
    if (!e.target.closest(".btn-erm-item")) return;
    const row = e.target.closest("[data-eidx]");
    if (!row) return;
    itemsEdicion.splice(Number(row.dataset.eidx), 1);
    renderItemsEdicion();
  });

  root.querySelector("#editPagosLista").addEventListener("focusin", (e) => {
    if (e.target.classList.contains("inp-epmonto")) fijarCursorAlFinal(e.target);
  });

  root.querySelector("#editPagosLista").addEventListener("change", (e) => {
    const row = e.target.closest("[data-epidx]");
    if (!row) return;
    const idx = Number(row.dataset.epidx);
    if (e.target.classList.contains("sel-emet")) pagosEdicion[idx].metodo = e.target.value;
  });

  root.querySelector("#editPagosLista").addEventListener("input", (e) => {
    const row = e.target.closest("[data-epidx]");
    if (!row) return;
    const idx = Number(row.dataset.epidx);
    if (e.target.classList.contains("inp-epmonto")) {
      pagosEdicion[idx].montoUsd = formatearEntradaMoneda(e.target);
      calcularResumenEdicion();
    } else if (e.target.classList.contains("inp-epref")) {
      pagosEdicion[idx].referencia = e.target.value.trim();
    }
  });

  root.querySelector("#editPagosLista").addEventListener("click", (e) => {
    if (e.target.classList.contains("inp-epmonto")) {
      fijarCursorAlFinal(e.target);
      return;
    }
    if (!e.target.closest(".btn-erm-pago")) return;
    const row = e.target.closest("[data-epidx]");
    if (!row) return;
    pagosEdicion.splice(Number(row.dataset.epidx), 1);
    renderPagosEdicion();
  });

  root.querySelector("#btnAddPagoEdit").addEventListener("click", () => {
    if (pagosEdicion.length >= 4) return alert("Máximo 4 formas de pago.");
    const res = calcularResumenEdicion();
    pagosEdicion.push({ metodo: "Pago Móvil Bs.", montoUsd: res.restante, referencia: "" });
    renderPagosEdicion();
  });

  function construirItemsEdicionClasificados() {
    const oldAlmPorProd = new Map();
    for (const oldIt of notaEnEdicion?.items || []) {
      const pid = oldIt.prodId || oldIt.id;
      if (!pid || oldIt.origen !== "almacen") continue;
      oldAlmPorProd.set(pid, (oldAlmPorProd.get(pid) || 0) + Number(oldIt.cantidad || 0));
    }

    const dispAlmRestantePorProd = new Map();
    for (const p of catalogo) {
      dispAlmRestantePorProd.set(p.id, Math.max(0, Number(p.stockAlmacen || 0)) + (oldAlmPorProd.get(p.id) || 0));
    }

    const itemsFinales = [];
    const avisosDivision = [];

    for (const it of itemsEdicion) {
      const pid = it.prodId || it.id;
      const cant = Math.max(1, Number(it.cantidad || 1));
      if (it.origen === "almacen" && pid && dispAlmRestantePorProd.has(pid)) {
        const disp = dispAlmRestantePorProd.get(pid);
        if (cant > disp) {
          if (disp > 0) {
            const cantPlanta = cant - disp;
            itemsFinales.push({ ...it, cantidad: disp, origen: "almacen" });
            itemsFinales.push({ ...it, cantidad: cantPlanta, origen: "planta" });
            dispAlmRestantePorProd.set(pid, 0);
            avisosDivision.push(`${it.codigo || pid}: ${disp} und Almacén + ${cantPlanta} und Planta`);
          } else {
            itemsFinales.push({ ...it, cantidad: cant, origen: "planta" });
            avisosDivision.push(`${it.codigo || pid}: ${cant} und Planta (sin stock extra en Almacén)`);
          }
        } else {
          itemsFinales.push({ ...it, cantidad: cant, origen: "almacen" });
          dispAlmRestantePorProd.set(pid, disp - cant);
        }
      } else {
        itemsFinales.push({ ...it, cantidad: cant, origen: it.origen || "almacen" });
      }
    }

    return { itemsFinales, avisosDivision };
  }

  root.querySelector("#btnGuardarEdicionNota").addEventListener("click", async () => {
    if (guardandoEdicion || !notaEnEdicion) return;
    if (!itemsEdicion.length) return alert("Agrega al menos un producto a la nota.");
    if (!esEditableHoy(notaEnEdicion)) {
      return alert("Esta nota ya no pertenece a la jornada activa, está cerrada o ya tiene abonos.");
    }

    const { itemsFinales, avisosDivision } = construirItemsEdicionClasificados();
    if (avisosDivision.length) {
      const ok = confirm(
        `Al aumentar cantidades se supera el stock físico de Almacén:\n\n• ${avisosDivision.join("\n• ")}\n\n¿Guardar dividiendo el excedente hacia Planta?`
      );
      if (!ok) return;
    }

    const res = calcularResumenEdicion();
    const { totalUsd, docCli, esClienteReal, descFavorNuevo, objetivoHoy, restante, excedente, esCre } = res;
    const diasCre = Math.max(1, parseInt(root.querySelector("#editDiasCredito").value, 10) || 15);
    const tasa = Number(notaEnEdicion.tasaBcvUsada || state.tasas?.bcvHoy || 0);

    if (!esCre && restante > 0.01) {
      return alert(`Faltan $${restante.toFixed(2)} por cubrir o cambia la condición a Crédito.`);
    }
    if (esCre && restante > 0.01 && !esClienteReal) {
      return alert("Para dejar saldo a Crédito la nota debe tener una Cédula o RIF real.");
    }

    let pagosLimpios = pagosEdicion
      .filter((p) => Number(p.montoUsd) > 0)
      .map((p) => ({
        metodo: p.metodo,
        montoUsd: Number(Number(p.montoUsd).toFixed(2)),
        montoBs: tasa ? Number((Number(p.montoUsd) * tasa).toFixed(2)) : 0,
        referencia: String(p.referencia || "").trim()
      }));

    const vueltoEntregadoUsd = excedente > 0.01 && modoExcedenteEdit === "vuelto" ? excedente : 0;
    const sobrepagoNuevo = excedente > 0.01 && modoExcedenteEdit === "favor" && esClienteReal ? excedente : 0;

    if (vueltoEntregadoUsd > 0.01 && pagosLimpios.length) {
      let porRestar = vueltoEntregadoUsd;
      const ordenIndices = pagosLimpios
        .map((p, idx) => ({ idx, esEfectivo: p.metodo.toLowerCase().includes("efectivo") }))
        .sort((a, b) => Number(b.esEfectivo) - Number(a.esEfectivo))
        .map((x) => x.idx);

      for (const i of ordenIndices) {
        if (porRestar <= 0.005) break;
        const desc = Math.min(pagosLimpios[i].montoUsd, porRestar);
        pagosLimpios[i].recibidoUsd = pagosLimpios[i].montoUsd;
        pagosLimpios[i].montoUsd = Number((pagosLimpios[i].montoUsd - desc).toFixed(2));
        pagosLimpios[i].montoBs = tasa ? Number((pagosLimpios[i].montoUsd * tasa).toFixed(2)) : 0;
        porRestar = Number((porRestar - desc).toFixed(2));
      }
      pagosLimpios = pagosLimpios.filter((p) => p.montoUsd > 0.005);
    }

    guardandoEdicion = true;
    const btn = root.querySelector("#btnGuardarEdicionNota");
    btn.disabled = true;
    btn.textContent = "Guardando...";

    try {
      const notaRef = doc(refs.notasEntrega(), notaEnEdicion.id);

      await runTransaction(db, async (tx) => {
        // 1. TODAS las lecturas primero (regla estricta de Firestore)
        const snap = await tx.get(notaRef);
        if (!snap.exists()) throw new Error("La nota no existe.");
        const actualData = snap.data();
        if (actualData.anulada || actualData.cierreId) {
          throw new Error("La nota ya fue anulada o cerrada.");
        }
        if (tieneAbonosRegistrados(actualData)) {
          throw new Error("La nota ya tiene abonos registrados en Deudores y no puede editarse.");
        }

        const anteriores = actualData.items || [];
        const resumenProd = new Map();
        const acumular = (lista, campo) => {
          for (const it of lista) {
            const pid = it.prodId || it.id;
            const cant = Number(it.cantidad || 0);
            if (!pid || cant <= 0) continue;
            const rec = resumenProd.get(pid) || { oldAlm: 0, newAlm: 0, oldPla: 0, newPla: 0 };
            if (it.origen === "almacen") rec[`${campo}Alm`] += cant;
            else rec[`${campo}Pla`] += cant;
            resumenProd.set(pid, rec);
          }
        };
        acumular(anteriores, "old");
        acumular(itemsFinales, "new");

        const prodSnaps = new Map();
        for (const pid of resumenProd.keys()) {
          prodSnaps.set(pid, await tx.get(doc(refs.catalogo(), pid)));
        }

        let cliRef = null;
        let favorActualCli = 0;
        if (esClienteReal) {
          cliRef = doc(refs.clientes(), docCli);
          const cliSnap = await tx.get(cliRef);
          favorActualCli = Number(cliSnap.data()?.saldoAFavorUsd || 0);
        }

        // Validar stock físico antes de escribir
        const updatesProd = [];
        for (const [pid, r] of resumenProd.entries()) {
          const pData = prodSnaps.get(pid)?.data() || {};
          const curAlm = Number(pData.stockAlmacen || 0);
          const curPla = Number(pData.stockPlanta || 0);
          const curPed = Number(pData.pedidosPlantaCount || 0);

          const nuevoAlm = curAlm + r.oldAlm - r.newAlm;
          if (nuevoAlm < 0) {
            throw new Error(
              `Stock insuficiente en Almacén para ${pData.codigo || pid} (disponible para esta nota: ${curAlm + r.oldAlm} und).`
            );
          }

          const deltaPla = r.oldPla - r.newPla;
          const nuevoPla = Math.max(0, curPla + deltaPla);
          const nuevoPed = Math.max(0, curPed - deltaPla);

          const payloadProd = {};
          if (r.oldAlm !== r.newAlm) payloadProd.stockAlmacen = nuevoAlm;
          if (r.oldPla !== r.newPla) {
            payloadProd.stockPlanta = nuevoPla;
            payloadProd.pedidosPlantaCount = nuevoPed;
          }
          if (Object.keys(payloadProd).length) {
            updatesProd.push({ pid, payloadProd });
          }
        }

        // 2. TODAS las escrituras después
        for (const { pid, payloadProd } of updatesProd) {
          tx.set(doc(refs.catalogo(), pid), payloadProd, { merge: true });
        }

        if (cliRef) {
          const descFavorRealPrevio = Number(actualData.saldoFavorAplicadoUsd || 0);
          const sobrepagoRealPrevio = Number(actualData.sobrepagoUsd || 0);
          const deltaFavor = descFavorRealPrevio - sobrepagoRealPrevio - descFavorNuevo + sobrepagoNuevo;
          const favorFinalCli = Math.max(0, Number((favorActualCli + deltaFavor).toFixed(2)));
          tx.set(cliRef, {
            documento: docCli,
            nombre: actualData.cliente?.nombre || docCli,
            saldoAFavorUsd: favorFinalCli,
            actualizadoEn: serverTimestamp()
          }, { merge: true });
        }

        const costoTotalUsd = Number(
          itemsFinales.reduce((acc, it) => acc + Number(it.cantidad || 0) * Number(it.costoUsd || 0), 0).toFixed(2)
        );
        const utilidadUsd = Number((totalUsd - costoTotalUsd).toFixed(2));
        const saldoPendienteUsd = esCre ? restante : 0;
        const esCreditoFinal = esCre && saldoPendienteUsd > 0.01;
        const baseTs = Number(actualData.creadoTs || Date.now());
        const venceTs = esCreditoFinal ? baseTs + diasCre * 86400000 : baseTs;

        const monedas = ["USD", "BS"];
        if (pagosLimpios.some((p) => p.metodo.toLowerCase().includes("usdt"))) {
          monedas.push("USDT");
        }

        tx.update(notaRef, {
          items: itemsFinales,
          pagos: pagosLimpios,
          vueltoEntregadoUsd,
          totalUsd,
          costoTotalUsd,
          utilidadUsd,
          saldoFavorAplicadoUsd: descFavorNuevo,
          sobrepagoUsd: sobrepagoNuevo,
          esCredito: esCreditoFinal,
          diasCredito: esCreditoFinal ? diasCre : 0,
          venceTs,
          saldoPendienteUsd,
          monedas,
          editadaEn: serverTimestamp(),
          editadaPor: state.sesion.usuario || "Administrador"
        });
      });

      cerrarEdicionNota();
      await cargarDatos();
      if (typeof window.NEXUS_VE_REFRESH_ALERTAS === "function") {
        await window.NEXUS_VE_REFRESH_ALERTAS();
      }
      alert("✓ Nota actualizada correctamente.");
    } catch (err) {
      alert("No se pudo editar la nota: " + err.message);
    } finally {
      guardandoEdicion = false;
      btn.disabled = false;
      btn.textContent = "✓ Guardar Cambios en la Nota";
    }
  });

  function renderLista() {
    const q = root.querySelector("#busqNotas").value.trim().toLowerCase();
    const cont = root.querySelector("#listaNotas");

    const filtradas = notas.filter((n) => {
      if (!q) return true;
      return `${n.folio || ""} ${n.cliente?.nombre || ""} ${n.cliente?.documento || ""}`.toLowerCase().includes(q);
    });

    if (!filtradas.length) {
      cont.innerHTML = `<div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">No hay notas de entrega registradas.</div>`;
      return;
    }

    cont.innerHTML = filtradas.map((n) => {
      const editable = esEditableHoy(n);
      const conAbonos = tieneAbonosRegistrados(n);
      const fechaTxt = n.fechaIso || (n.creadoTs ? obtenerFechaLocalIso(n.creadoTs) : "---");
      return `
        <div class="ve-card p-3.5 space-y-2 ${n.anulada ? "opacity-60" : ""}" data-nid="${n.id}">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-mono-ve text-xs font-extrabold text-slate-950">#${n.folio || n.id}</span>
                <span class="text-[10px] font-bold text-slate-500">${fechaTxt}</span>
                ${n.anulada ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-rose-100 text-rose-800">ANULADA</span>` : ""}
                ${n.cierreId ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-slate-200 text-slate-700">CERRADA</span>` : ""}
                ${conAbonos && !n.anulada ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-sky-100 text-sky-900">CON ABONOS</span>` : ""}
                ${n.esCredito && Number(n.saldoPendienteUsd || 0) > 0.01
                  ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-amber-100 text-amber-900">Pendiente: $${Number(n.saldoPendienteUsd).toFixed(2)}</span>`
                  : ""}
              </div>
              <div class="text-xs font-extrabold text-slate-800 mt-0.5">${n.cliente?.nombre || "Consumidor Final"} (${n.cliente?.documento || "---"})</div>
            </div>

            <div class="flex items-center gap-2">
              <div class="text-right mr-1">
                <div class="font-mono-ve text-sm font-extrabold text-slate-950">$${Number(n.totalUsd || 0).toFixed(2)}</div>
                <div class="font-mono-ve text-[10px] text-slate-500">${(n.items || []).length} ítem(s)</div>
              </div>
              ${editable ? `
                <button type="button" class="btn-editar-nota px-3 py-1.5 rounded-xl bg-sky-700 hover:bg-sky-800 text-white text-xs font-extrabold cursor-pointer">
                  ✎ Editar
                </button>
              ` : ""}
              <button type="button" class="btn-pdf-nota px-3 py-1.5 rounded-xl bg-slate-950 hover:bg-slate-800 text-white text-xs font-extrabold cursor-pointer">
                PDF
              </button>
              ${!n.anulada && !n.cierreId ? `
                <button type="button" class="btn-anular-nota px-2.5 py-1.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-bold cursor-pointer">
                  Anular
                </button>
              ` : ""}
            </div>
          </div>
        </div>
      `;
    }).join("");
  }

  root.querySelector("#listaNotas").addEventListener("click", async (e) => {
    const card = e.target.closest("[data-nid]");
    if (!card) return;
    const nota = notas.find((x) => x.id === card.dataset.nid);
    if (!nota) return;

    if (e.target.closest(".btn-editar-nota")) {
      abrirEdicionNota(nota);
    } else if (e.target.closest(".btn-pdf-nota")) {
      abrirDocumentoPDF("nota", nota, state);
    } else if (e.target.closest(".btn-anular-nota")) {
      if (!confirm(`¿Anular la Nota #${nota.folio || nota.id}? Se revertirá el stock de Almacén/Planta y los saldos a favor aplicados.`)) return;
      try {
        await runTransaction(db, async (tx) => {
          // 1. TODAS las lecturas primero
          const nRef = doc(refs.notasEntrega(), nota.id);
          const snap = await tx.get(nRef);
          if (!snap.exists()) return;
          const nData = snap.data();
          if (nData.anulada || nData.cierreId) return;

          const revertPorProd = new Map();
          for (const it of nData.items || []) {
            const pid = it.prodId || it.id;
            const cant = Number(it.cantidad || 0);
            if (!pid || cant <= 0) continue;
            const rec = revertPorProd.get(pid) || { alm: 0, pla: 0 };
            if (it.origen === "almacen") rec.alm += cant;
            else rec.pla += cant;
            revertPorProd.set(pid, rec);
          }

          const prodSnaps = new Map();
          for (const pid of revertPorProd.keys()) {
            prodSnaps.set(pid, await tx.get(doc(refs.catalogo(), pid)));
          }

          const docCli = normalizarIdVE(nData.cliente?.documento || "");
          const esClienteReal = Boolean(docCli && docCli !== "V-00000000");
          const descFavor = Number(nData.saldoFavorAplicadoUsd || 0);
          const sobrepago = Number(nData.sobrepagoUsd || 0);
          let cliRef = null;
          let cliFavorActual = 0;

          if (esClienteReal && (descFavor > 0.01 || sobrepago > 0.01)) {
            cliRef = doc(refs.clientes(), docCli);
            const cliSnap = await tx.get(cliRef);
            cliFavorActual = Number(cliSnap.data()?.saldoAFavorUsd || 0);
          }

          // 2. TODAS las escrituras después
          for (const [pid, rec] of revertPorProd.entries()) {
            const pData = prodSnaps.get(pid)?.data() || {};
            const upd = {};
            if (rec.alm > 0) {
              upd.stockAlmacen = Number(pData.stockAlmacen || 0) + rec.alm;
            }
            if (rec.pla > 0) {
              upd.stockPlanta = Number(pData.stockPlanta || 0) + rec.pla;
              upd.pedidosPlantaCount = Math.max(0, Number(pData.pedidosPlantaCount || 0) - rec.pla);
            }
            if (Object.keys(upd).length) {
              tx.set(doc(refs.catalogo(), pid), upd, { merge: true });
            }
          }

          if (cliRef) {
            const favorFinal = Math.max(0, Number((cliFavorActual + descFavor - sobrepago).toFixed(2)));
            tx.set(cliRef, {
              saldoAFavorUsd: favorFinal,
              actualizadoEn: serverTimestamp()
            }, { merge: true });
          }

          tx.update(nRef, {
            anulada: true,
            saldoPendienteUsd: 0,
            anuladaEn: serverTimestamp(),
            anuladaPor: state.sesion.usuario || "Administrador"
          });
        });

        if (notaEnEdicion?.id === nota.id) cerrarEdicionNota();
        await cargarDatos();
        if (typeof window.NEXUS_VE_REFRESH_ALERTAS === "function") {
          await window.NEXUS_VE_REFRESH_ALERTAS();
        }
      } catch (err) {
        alert("No se pudo anular la nota: " + err.message);
      }
    }
  });

  async function cargarDatos() {
    const [snapNotas, snapCat] = await Promise.all([
      getDocs(refs.notasEntrega()),
      getDocs(refs.catalogo())
    ]);
    notas = snapNotas.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => Number(b.creadoTs || 0) - Number(a.creadoTs || 0));
    catalogo = snapCat.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderLista();
  }

  root.querySelector("#busqNotas").addEventListener("input", renderLista);
  root.querySelector("#btnRecargarNotas").addEventListener("click", cargarDatos);

  await cargarDatos();
}
