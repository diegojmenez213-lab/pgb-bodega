// venezuela/modules/caja-pos.js
import {
  db,
  getTenantRefs,
  doc,
  getDoc,
  getDocs,
  writeBatch,
  normalizarIdVE,
  serverTimestamp
} from "../core/db.js";
import { imprimirDocumentoCarta, imprimirTicket80mm } from "./documentos-pdf.js";

function getTasaActiva(state) {
  const t = state.tasas || {};
  const bcv = state.modoTasaBCV === "manana" && t.bcvManana ? t.bcvManana : t.bcvHoy;
  return { ...t, bcvActiva: Number(bcv || 0) };
}

const METODOS_PAGO = [
  "Efectivo USD",
  "Pago Móvil Bs.",
  "Transferencia Bs.",
  "Zelle",
  "Binance USDT",
  "Punto de Venta Bs.",
  "Efectivo Bs."
];

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);
  const fMayor = Number(state.empresa?.precios?.factorMayor) || 2.0;
  const fDetal = Number(state.empresa?.precios?.factorDetal) || 2.5;

  root.innerHTML = `
    <div class="space-y-4 max-w-7xl mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Caja / Nota de Entrega</h1>
          <p class="text-[11px] text-slate-500 hidden sm:block">
            Atajos PC: <strong class="font-mono-ve">F1</strong> Buscar • <strong class="font-mono-ve">F2</strong> Cliente • <strong class="font-mono-ve">F4</strong> Tarifa • <strong class="font-mono-ve">F8</strong> Limpiar • <strong class="font-mono-ve">F9</strong> Emitir Nota
          </p>
        </div>
        <div class="text-xs font-extrabold px-3 py-1.5 rounded-xl bg-slate-100 text-slate-700 font-mono-ve">
          Próximo Folio: #<span id="nextFolioTxt">---</span>
        </div>
      </div>

      <!-- Alerta automática de deuda acumulada del cliente -->
      <div id="alertaDeudaCliente" class="hidden ve-card border-rose-300 bg-rose-50/80 p-3.5 flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-2.5 text-xs">
          <span class="text-lg">⚠️</span>
          <div>
            <div id="txtAlertaDeuda" class="font-extrabold text-rose-900"></div>
            <div id="subAlertaDeuda" class="text-[11px] text-rose-700 font-semibold"></div>
          </div>
        </div>
        <button id="btnVerDeudaCliente" type="button" class="px-3.5 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-extrabold cursor-pointer">
          Ver deuda →
        </button>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <!-- Izquierda: Cliente y Buscador -->
        <div class="lg:col-span-7 space-y-3">
          <div class="ve-card p-3 space-y-2">
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input id="posCliDoc" type="text" placeholder="Cédula / RIF (F2)" class="bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold uppercase" />
              <input id="posCliNom" type="text" placeholder="Nombre / Razón Social" class="bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold" />
              <div class="flex gap-1.5">
                <select id="posTarifa" class="flex-1 bg-slate-50 border border-slate-300 rounded-xl px-2.5 py-2 text-xs font-bold">
                  <option value="detal">Detal (×${fDetal})</option>
                  <option value="mayor">Mayor (×${fMayor})</option>
                  <option value="custom">Mult.</option>
                </select>
                <input id="posMult" type="number" step="0.05" min="0.1" value="${fDetal}" title="Multiplicador libre sobre costo" class="w-20 bg-white border border-slate-300 rounded-xl px-2 py-2 text-xs font-mono-ve font-extrabold text-center" />
              </div>
            </div>
          </div>

          <div class="ve-card p-3 space-y-2">
            <input id="posBusq" type="text" placeholder="Buscar producto por código, descripción o marca (F1)..." class="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2.5 text-xs font-bold outline-none focus:border-slate-950" />
            <div id="posResultados" class="space-y-1.5 max-h-80 overflow-y-auto">
              <div class="text-xs text-slate-400 text-center py-6">Escribe para agregar repuestos a la Nota de Entrega...</div>
            </div>
          </div>
        </div>

        <!-- Derecha: Carrito, Condición Contado/Crédito, Pagos y Emisión -->
        <div class="lg:col-span-5 space-y-3">
          <div class="ve-card space-y-3">
            <div class="flex items-center justify-between">
              <h2 class="text-sm font-extrabold text-slate-900">Ítems de la Nota</h2>
              <button id="btnLimpiarPos" type="button" class="text-[11px] font-bold text-rose-600 cursor-pointer">Limpiar (F8)</button>
            </div>

            <div id="posCarrito" class="space-y-2 max-h-64 overflow-y-auto">
              <div class="text-xs text-slate-400 text-center py-6">Carrito vacío.</div>
            </div>

            <!-- Totales -->
            <div class="pt-3 border-t border-slate-200 space-y-1">
              <div class="flex justify-between text-base font-extrabold text-slate-950">
                <span>TOTAL USD</span>
                <span id="posTotalUsd" class="font-mono-ve">$0.00</span>
              </div>
              <div class="flex justify-between text-xs font-bold text-slate-500">
                <span>Total Bs. (BCV)</span>
                <span id="posTotalBs" class="font-mono-ve">Bs. 0.00</span>
              </div>
            </div>

            <!-- Condición de Venta: Contado vs Crédito -->
            <div class="pt-2 border-t border-slate-200 space-y-2">
              <div class="grid grid-cols-2 gap-1.5 bg-slate-100 p-1 rounded-xl">
                <button type="button" id="btnModoContado" class="py-2 rounded-lg text-xs font-extrabold bg-slate-950 text-white cursor-pointer">
                  Contado
                </button>
                <button type="button" id="btnModoCredito" class="py-2 rounded-lg text-xs font-extrabold text-slate-700 cursor-pointer">
                  Crédito
                </button>
              </div>

              <!-- Plazo de Crédito: 7, 15, 30 o Manual -->
              <div id="panelCredito" class="hidden p-2.5 rounded-xl bg-amber-50/80 border border-amber-200 space-y-2">
                <div class="flex items-center justify-between">
                  <span class="text-[11px] font-extrabold text-amber-900">Plazo del Crédito</span>
                  <span id="resumenPlazoTxt" class="text-[11px] font-mono-ve font-extrabold text-amber-800">15 días</span>
                </div>
                <div class="grid grid-cols-4 gap-1.5">
                  <button type="button" data-dias="7" class="btn-dias py-1.5 rounded-lg text-xs font-extrabold bg-white border border-amber-300 text-amber-900 cursor-pointer">7d</button>
                  <button type="button" data-dias="15" class="btn-dias py-1.5 rounded-lg text-xs font-extrabold bg-amber-600 text-white border border-amber-600 cursor-pointer">15d</button>
                  <button type="button" data-dias="30" class="btn-dias py-1.5 rounded-lg text-xs font-extrabold bg-white border border-amber-300 text-amber-900 cursor-pointer">30d</button>
                  <button type="button" id="btnDiasManual" class="py-1.5 rounded-lg text-xs font-extrabold bg-white border border-slate-300 text-slate-800 cursor-pointer">Manual</button>
                </div>
                <div id="wrapDiasManual" class="hidden flex items-center gap-2 pt-1">
                  <label class="text-[11px] font-bold text-amber-900">Días exactos:</label>
                  <input id="inpDiasManual" type="number" min="1" max="365" value="10" class="w-24 bg-white border border-amber-300 rounded-lg px-2.5 py-1 text-xs font-mono-ve font-extrabold" />
                </div>
              </div>
            </div>

            <!-- Hasta 4 Formas de Pago / Abono inicial -->
            <div class="pt-2 border-t border-slate-200 space-y-2">
              <div class="flex items-center justify-between">
                <span id="tituloPagosLbl" class="text-[11px] font-extrabold uppercase text-slate-500">Formas de Pago (máx 4)</span>
                <button id="btnAddPago" type="button" class="text-[11px] font-extrabold text-slate-900 hover:underline cursor-pointer">+ Agregar pago</button>
              </div>
              <div id="posPagos" class="space-y-1.5"></div>
              <div id="filaRestante" class="flex justify-between text-[11px] font-bold">
                <span id="lblRestante" class="text-slate-500">Restante por cubrir:</span>
                <span id="posRestante" class="font-mono-ve text-rose-600">$0.00</span>
              </div>
            </div>

            <!-- Monedas del documento y Formato -->
            <div class="pt-2 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2 text-[11px] font-bold text-slate-600">
              <div class="flex gap-2">
                <label class="flex items-center gap-1"><input type="checkbox" class="pos-mon" value="USD" checked /> USD</label>
                <label class="flex items-center gap-1"><input type="checkbox" class="pos-mon" value="BS" checked /> Bs.</label>
                <label class="flex items-center gap-1"><input type="checkbox" class="pos-mon" value="USDT" /> USDT</label>
                <label class="flex items-center gap-1"><input type="checkbox" class="pos-mon" value="EUR" /> EUR</label>
              </div>
              <select id="posFormatoPrint" class="bg-slate-50 border border-slate-300 rounded-lg px-2 py-1 text-[11px] font-bold">
                <option value="carta">PDF Carta</option>
                <option value="ticket">Ticket 80mm</option>
                <option value="ninguno">Solo guardar</option>
              </select>
            </div>

            <button id="btnEmitirNota" type="button" class="w-full py-3.5 rounded-2xl bg-slate-950 hover:bg-slate-800 text-white text-xs font-extrabold uppercase tracking-wider cursor-pointer">
              Emitir Nota de Entrega (F9)
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  let catalogo = [];
  let clientes = [];
  let todasNotas = [];
  let carrito = [];
  let pagos = [{ metodo: "Efectivo USD", montoUsd: 0 }];
  let factorActual = fDetal;
  let ultimoFolio = Number(state.empresa?.correlativos?.notaEntregaActual || 0);
  let esCredito = false;
  let diasCredito = 15;

  const docEl = root.querySelector("#posCliDoc");
  const nomEl = root.querySelector("#posCliNom");
  const tarifaEl = root.querySelector("#posTarifa");
  const multEl = root.querySelector("#posMult");
  const busqEl = root.querySelector("#posBusq");
  const resEl = root.querySelector("#posResultados");
  const cartEl = root.querySelector("#posCarrito");
  const pagosEl = root.querySelector("#posPagos");
  const alertaBox = root.querySelector("#alertaDeudaCliente");

  function aplicarFactorPos(nuevoFactor) {
    const val = Number(nuevoFactor);
    if (isNaN(val) || val <= 0) return;
    factorActual = val;
    multEl.value = String(val);
    if (carrito.length) {
      carrito = carrito.map((it) => ({
        ...it,
        precioUsd: Number(((it.costoUsd || 0) * factorActual).toFixed(2))
      }));
      renderCarrito();
    }
    renderBusqueda();
  }

  function actualizarFolioUI() {
    root.querySelector("#nextFolioTxt").textContent = String(ultimoFolio + 1).padStart(5, "0");
  }

  function totalVenta() {
    return carrito.reduce((acc, it) => acc + it.cantidad * it.precioUsd, 0);
  }

  function chequearDeudaClienteActual() {
    const docId = normalizarIdVE(docEl.value);
    if (!docId || docId.length < 5) {
      alertaBox.classList.add("hidden");
      return;
    }

    const pendientes = todasNotas.filter((n) => {
      if (normalizarIdVE(n.cliente?.documento || "") !== docId) return false;
      const saldo = Number(n.saldoPendienteUsd ?? (n.esCredito ? n.totalUsd : 0) ?? 0);
      return saldo > 0.01;
    });

    if (!pendientes.length) {
      alertaBox.classList.add("hidden");
      return;
    }

    const totalDeuda = pendientes.reduce(
      (acc, n) => acc + Number(n.saldoPendienteUsd ?? n.totalUsd ?? 0),
      0
    );
    const nombreCli = nomEl.value.trim() || pendientes[0]?.cliente?.nombre || docId;

    root.querySelector("#txtAlertaDeuda").textContent =
      `${nombreCli} (${docId}) tiene una deuda total de $${totalDeuda.toFixed(2)}.`;
    root.querySelector("#subAlertaDeuda").textContent = pendientes.length === 1
      ? `Corresponde a 1 factura/nota pendiente por $${totalDeuda.toFixed(2)}.`
      : `Suma de ${pendientes.length} facturas/notas pendientes: $${totalDeuda.toFixed(2)}.`;
    alertaBox.classList.remove("hidden");
  }

  root.querySelector("#btnVerDeudaCliente").addEventListener("click", () => {
    if (typeof window.NEXUS_VE_NAV === "function") {
      window.NEXUS_VE_NAV("deudores");
    }
  });

  function actualizarEstadoCreditoUI() {
    const btnCon = root.querySelector("#btnModoContado");
    const btnCre = root.querySelector("#btnModoCredito");
    const panelCre = root.querySelector("#panelCredito");
    const lblRest = root.querySelector("#lblRestante");
    const titPag = root.querySelector("#tituloPagosLbl");

    if (!esCredito) {
      btnCon.className = "py-2 rounded-lg text-xs font-extrabold bg-slate-950 text-white cursor-pointer";
      btnCre.className = "py-2 rounded-lg text-xs font-extrabold text-slate-700 cursor-pointer";
      panelCre.classList.add("hidden");
      titPag.textContent = "Formas de Pago (máx 4)";
      lblRest.textContent = "Restante por cubrir:";
    } else {
      btnCre.className = "py-2 rounded-lg text-xs font-extrabold bg-amber-600 text-white cursor-pointer";
      btnCon.className = "py-2 rounded-lg text-xs font-extrabold text-slate-700 cursor-pointer";
      panelCre.classList.remove("hidden");
      titPag.textContent = "Abono Inicial / Pagos (opcional)";
      lblRest.textContent = "Quedará a crédito:";
      if (pagos.length === 1 && pagos[0].auto !== false) {
        pagos[0].montoUsd = 0;
        pagos[0].auto = false;
      }
    }
    renderPagos();
  }

  function seleccionarDiasCredito(dias, esManual = false) {
    diasCredito = Math.max(1, parseInt(dias, 10) || 15);
    root.querySelector("#resumenPlazoTxt").textContent = `${diasCredito} días`;
    root.querySelectorAll(".btn-dias").forEach((b) => {
      const activo = !esManual && Number(b.dataset.dias) === diasCredito;
      b.className = activo
        ? "btn-dias py-1.5 rounded-lg text-xs font-extrabold bg-amber-600 text-white border border-amber-600 cursor-pointer"
        : "btn-dias py-1.5 rounded-lg text-xs font-extrabold bg-white border border-amber-300 text-amber-900 cursor-pointer";
    });
    const btnMan = root.querySelector("#btnDiasManual");
    btnMan.className = esManual
      ? "py-1.5 rounded-lg text-xs font-extrabold bg-slate-950 text-white border border-slate-950 cursor-pointer"
      : "py-1.5 rounded-lg text-xs font-extrabold bg-white border border-slate-300 text-slate-800 cursor-pointer";
  }

  root.querySelector("#btnModoContado").addEventListener("click", () => {
    esCredito = false;
    if (pagos.length === 1) pagos[0].auto = true;
    actualizarEstadoCreditoUI();
  });

  root.querySelector("#btnModoCredito").addEventListener("click", () => {
    esCredito = true;
    actualizarEstadoCreditoUI();
  });

  root.querySelectorAll(".btn-dias").forEach((btn) => {
    btn.addEventListener("click", () => {
      root.querySelector("#wrapDiasManual").classList.add("hidden");
      seleccionarDiasCredito(Number(btn.dataset.dias), false);
    });
  });

  root.querySelector("#btnDiasManual").addEventListener("click", () => {
    const wrap = root.querySelector("#wrapDiasManual");
    wrap.classList.toggle("hidden");
    const inp = root.querySelector("#inpDiasManual");
    inp.focus();
    seleccionarDiasCredito(Number(inp.value) || 10, true);
  });

  root.querySelector("#inpDiasManual").addEventListener("input", (e) => {
    seleccionarDiasCredito(Number(e.target.value) || 1, true);
  });

  function renderPagos() {
    const total = totalVenta();
    if (!esCredito && pagos.length === 1 && pagos[0].auto !== false) {
      pagos[0].montoUsd = Number(total.toFixed(2));
    }

    pagosEl.innerHTML = pagos.map((p, idx) => `
      <div class="flex items-center gap-1.5" data-pidx="${idx}">
        <select class="sel-met flex-1 bg-slate-50 border border-slate-300 rounded-lg px-2 py-1.5 text-xs font-bold">
          ${METODOS_PAGO.map((m) => `<option value="${m}" ${p.metodo === m ? "selected" : ""}>${m}</option>`).join("")}
        </select>
        <input type="number" step="0.01" min="0" value="${Number(p.montoUsd || 0).toFixed(2)}" class="inp-pmonto w-24 bg-white border border-slate-300 rounded-lg px-2 py-1.5 text-xs font-mono-ve font-bold text-right" />
        ${pagos.length > 1 ? `<button type="button" class="btn-rm-pago text-xs font-bold text-rose-600 px-1 cursor-pointer">✕</button>` : ""}
      </div>
    `).join("");

    const cubierto = pagos.reduce((acc, p) => acc + Number(p.montoUsd || 0), 0);
    const restante = Math.max(0, total - cubierto);
    const restEl = root.querySelector("#posRestante");
    restEl.textContent = `$${restante.toFixed(2)}`;
    restEl.className = esCredito
      ? "font-mono-ve text-amber-800"
      : (restante <= 0.01 ? "font-mono-ve text-emerald-700" : "font-mono-ve text-rose-600");
  }

  function renderCarrito() {
    const total = totalVenta();
    const tasas = getTasaActiva(state);
    root.querySelector("#posTotalUsd").textContent = `$${total.toFixed(2)}`;
    root.querySelector("#posTotalBs").textContent = tasas.bcvActiva ? `Bs. ${(total * tasas.bcvActiva).toFixed(2)}` : "Bs. --";

    if (!carrito.length) {
      cartEl.innerHTML = `<div class="text-xs text-slate-400 text-center py-6">Carrito vacío.</div>`;
    } else {
      cartEl.innerHTML = carrito.map((it, idx) => `
        <div class="p-2.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5" data-idx="${idx}">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="flex items-center gap-1.5">
                <span class="font-mono-ve text-[11px] font-extrabold text-slate-900">${it.codigo}</span>
                <button type="button" class="btn-origen text-[9px] font-extrabold px-1.5 py-0.5 rounded-full cursor-pointer ${
                  it.origen === "almacen" ? "bg-emerald-100 text-emerald-800" : "bg-sky-100 text-sky-800"
                }">${it.origen === "almacen" ? "ALMACÉN" : "PLANTA"}</button>
              </div>
              <div class="text-[11px] font-semibold text-slate-600 truncate">${it.descripcion}</div>
            </div>
            <button type="button" class="btn-rm text-xs font-bold text-rose-600 cursor-pointer">✕</button>
          </div>
          <div class="flex items-center justify-between gap-2">
            <input type="number" min="1" value="${it.cantidad}" class="inp-cant w-14 bg-white border border-slate-300 rounded-lg px-1.5 py-1 text-xs font-bold text-center" />
            <div class="flex items-center gap-1">
              <span class="text-[10px] font-bold text-slate-500">$</span>
              <input type="number" step="0.01" min="0" value="${Number(it.precioUsd).toFixed(2)}" class="inp-prec w-20 bg-white border border-slate-300 rounded-lg px-1.5 py-1 text-xs font-bold text-right font-mono-ve" />
            </div>
            <div class="font-mono-ve text-xs font-extrabold text-slate-900">$${(it.cantidad * it.precioUsd).toFixed(2)}</div>
          </div>
        </div>
      `).join("");
    }
    renderPagos();
  }

  function renderBusqueda() {
    const q = busqEl.value.trim().toLowerCase();
    if (!q) {
      resEl.innerHTML = `<div class="text-xs text-slate-400 text-center py-6">Escribe para agregar repuestos a la Nota de Entrega...</div>`;
      return;
    }

    const matches = catalogo.filter((p) =>
      `${p.codigo || ""} ${p.descripcion || ""} ${p.marca || ""}`.toLowerCase().includes(q)
    ).slice(0, 25);

    if (!matches.length) {
      resEl.innerHTML = `<div class="text-xs text-slate-400 text-center py-6">Sin resultados.</div>`;
      return;
    }

    resEl.innerHTML = matches.map((p) => {
      const precio = Number(((p.costoUsd || 0) * factorActual).toFixed(2));
      return `
        <div class="p-2.5 rounded-xl border border-slate-200 hover:bg-slate-50 flex items-center justify-between gap-2">
          <div class="min-w-0 flex-1">
            <div class="font-mono-ve text-xs font-extrabold text-slate-900">${p.codigo} <span class="font-sans text-[10px] text-slate-400">${p.marca || ""}</span></div>
            <div class="text-[11px] font-semibold text-slate-600 truncate">${p.descripcion}</div>
            <div class="text-[10px] font-bold text-slate-500">Alm: <strong class="text-emerald-700">${p.stockAlmacen ?? 0}</strong> • Planta: <strong class="text-sky-700">${p.stockPlanta ?? 0}</strong></div>
          </div>
          <button type="button" class="btn-add-pos px-3 py-1.5 rounded-xl bg-slate-950 text-white text-xs font-extrabold cursor-pointer shrink-0" data-id="${p.id}">
            + $${precio.toFixed(2)}
          </button>
        </div>
      `;
    }).join("");
  }

  resEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-add-pos");
    if (!btn) return;
    const p = catalogo.find((x) => x.id === btn.dataset.id);
    if (!p) return;

    const ex = carrito.find((x) => x.id === p.id);
    if (ex) {
      ex.cantidad += 1;
    } else {
      carrito.push({
        id: p.id,
        codigo: p.codigo,
        descripcion: p.descripcion,
        costoUsd: Number(p.costoUsd || 0),
        precioUsd: Number(((p.costoUsd || 0) * factorActual).toFixed(2)),
        cantidad: 1,
        origen: (p.stockAlmacen || 0) > 0 ? "almacen" : "planta"
      });
    }
    renderCarrito();
  });

  cartEl.addEventListener("input", (e) => {
    const row = e.target.closest("[data-idx]");
    if (!row) return;
    const idx = Number(row.dataset.idx);
    if (e.target.classList.contains("inp-cant")) {
      carrito[idx].cantidad = Math.max(1, parseInt(e.target.value, 10) || 1);
    } else if (e.target.classList.contains("inp-prec")) {
      carrito[idx].precioUsd = Math.max(0, parseFloat(e.target.value) || 0);
    }
    renderCarrito();
  });

  cartEl.addEventListener("click", (e) => {
    const row = e.target.closest("[data-idx]");
    if (!row) return;
    const idx = Number(row.dataset.idx);
    if (e.target.closest(".btn-rm")) {
      carrito.splice(idx, 1);
      renderCarrito();
    } else if (e.target.closest(".btn-origen")) {
      carrito[idx].origen = carrito[idx].origen === "almacen" ? "planta" : "almacen";
      renderCarrito();
    }
  });

  pagosEl.addEventListener("change", (e) => {
    const row = e.target.closest("[data-pidx]");
    if (!row) return;
    const idx = Number(row.dataset.pidx);
    if (e.target.classList.contains("sel-met")) pagos[idx].metodo = e.target.value;
  });

  pagosEl.addEventListener("input", (e) => {
    const row = e.target.closest("[data-pidx]");
    if (!row) return;
    const idx = Number(row.dataset.pidx);
    if (e.target.classList.contains("inp-pmonto")) {
      pagos[idx].auto = false;
      pagos[idx].montoUsd = Math.max(0, parseFloat(e.target.value) || 0);
      const cubierto = pagos.reduce((acc, p) => acc + Number(p.montoUsd || 0), 0);
      const rest = Math.max(0, totalVenta() - cubierto);
      const restEl = root.querySelector("#posRestante");
      restEl.textContent = `$${rest.toFixed(2)}`;
      restEl.className = esCredito
        ? "font-mono-ve text-amber-800"
        : (rest <= 0.01 ? "font-mono-ve text-emerald-700" : "font-mono-ve text-rose-600");
    }
  });

  pagosEl.addEventListener("click", (e) => {
    if (!e.target.closest(".btn-rm-pago")) return;
    const idx = Number(e.target.closest("[data-pidx]").dataset.pidx);
    pagos.splice(idx, 1);
    renderPagos();
  });

  root.querySelector("#btnAddPago").addEventListener("click", () => {
    if (pagos.length >= 4) return alert("Máximo 4 formas de pago por documento.");
    const cubierto = pagos.reduce((acc, p) => acc + Number(p.montoUsd || 0), 0);
    const rest = Math.max(0, Number((totalVenta() - cubierto).toFixed(2)));
    pagos.push({ metodo: "Pago Móvil Bs.", montoUsd: rest, auto: false });
    renderPagos();
  });

  docEl.addEventListener("input", chequearDeudaClienteActual);
  docEl.addEventListener("blur", () => {
    const id = normalizarIdVE(docEl.value);
    const cli = clientes.find((c) => c.id === id);
    if (cli) {
      docEl.value = cli.id;
      if (!nomEl.value.trim()) nomEl.value = cli.nombre || "";
      const fCli = Number(cli.factorPersonalizado) || (cli.tarifa === "mayor" ? fMayor : fDetal);
      tarifaEl.value = cli.tarifa === "mayor" ? "mayor" : (cli.tarifa === "especial" ? "custom" : "detal");
      aplicarFactorPos(fCli);
    }
    chequearDeudaClienteActual();
  });

  tarifaEl.addEventListener("change", () => {
    if (tarifaEl.value === "mayor") aplicarFactorPos(fMayor);
    else if (tarifaEl.value === "detal") aplicarFactorPos(fDetal);
    else multEl.focus();
  });

  multEl.addEventListener("input", () => {
    tarifaEl.value = "custom";
    aplicarFactorPos(multEl.value);
  });

  function limpiarCaja() {
    carrito = [];
    esCredito = false;
    diasCredito = 15;
    pagos = [{ metodo: "Efectivo USD", montoUsd: 0 }];
    actualizarEstadoCreditoUI();
    renderCarrito();
  }

  root.querySelector("#btnLimpiarPos").addEventListener("click", limpiarCaja);

  async function emitirNota() {
    if (!carrito.length) return alert("Agrega al menos un producto.");
    const btn = root.querySelector("#btnEmitirNota");
    btn.disabled = true;
    btn.textContent = "Emitiendo...";

    try {
      const empSnap = await getDoc(refs.empresaRef);
      const actual = Number(empSnap.data()?.correlativos?.notaEntregaActual || ultimoFolio || 0);
      const nuevoNum = actual + 1;
      const folio = String(nuevoNum).padStart(5, "0");

      const totalUsd = Number(totalVenta().toFixed(2));
      const costoTotalUsd = Number(carrito.reduce((acc, it) => acc + it.cantidad * (it.costoUsd || 0), 0).toFixed(2));
      const utilidadUsd = Number((totalUsd - costoTotalUsd).toFixed(2));
      const pagosValidos = pagos.filter((p) => Number(p.montoUsd) > 0);
      const abonoInicial = Number(pagosValidos.reduce((acc, p) => acc + Number(p.montoUsd || 0), 0).toFixed(2));
      const saldoPendienteUsd = esCredito ? Math.max(0, Number((totalUsd - abonoInicial).toFixed(2))) : 0;

      const tasas = getTasaActiva(state);
      const monedas = Array.from(root.querySelectorAll(".pos-mon:checked")).map((el) => el.value);
      const docCli = normalizarIdVE(docEl.value) || "V-00000000";
      const nomCli = nomEl.value.trim() || "Consumidor Final";
      const now = Date.now();

      const batch = writeBatch(db);

      batch.set(doc(refs.notasEntrega(), folio), {
        folio,
        numero: nuevoNum,
        fechaIso: new Date().toISOString().slice(0, 10),
        creadoTs: now,
        cliente: { documento: docCli, nombre: nomCli },
        items: carrito,
        pagos: pagosValidos,
        esCredito: esCredito && saldoPendienteUsd > 0.01,
        diasCredito: esCredito ? diasCredito : 0,
        venceTs: esCredito ? now + diasCredito * 86400000 : now,
        saldoPendienteUsd,
        totalUsd,
        costoTotalUsd,
        utilidadUsd,
        multiplicador: factorActual,
        tasaBcvUsada: tasas.bcvActiva,
        monedas: monedas.length ? monedas : ["USD", "BS"],
        usuario: state.sesion.usuario || "Administrador",
        creadoEn: serverTimestamp()
      });

      batch.set(refs.empresaRef, { correlativos: { notaEntregaActual: nuevoNum } }, { merge: true });

      // Descuenta SOLO lo vendido desde Almacén; lo de Planta NO se descuenta de Planta
      for (const it of carrito) {
        if (it.origen === "almacen") {
          const prod = catalogo.find((p) => p.id === it.id);
          const nuevoStock = Math.max(0, (prod?.stockAlmacen || 0) - it.cantidad);
          if (prod) prod.stockAlmacen = nuevoStock;
          batch.set(doc(refs.catalogo(), it.id), {
            stockAlmacen: nuevoStock,
            ultimaVentaTs: now
          }, { merge: true });
        } else {
          batch.set(doc(refs.catalogo(), it.id), {
            pedidosPlantaCount: (catalogo.find((p) => p.id === it.id)?.pedidosPlantaCount || 0) + Number(it.cantidad || 1),
            ultimaVentaTs: now
          }, { merge: true });
        }
      }

      await batch.commit();
      ultimoFolio = nuevoNum;
      if (state.empresa?.correlativos) state.empresa.correlativos.notaEntregaActual = nuevoNum;
      actualizarFolioUI();

      const snapNotas = await getDocs(refs.notasEntrega());
      todasNotas = snapNotas.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (typeof window.NEXUS_VE_REFRESH_ALERTAS === "function") {
        await window.NEXUS_VE_REFRESH_ALERTAS();
      }

      const formato = root.querySelector("#posFormatoPrint").value;
      const obsCredito = esCredito && saldoPendienteUsd > 0.01
        ? `Venta a crédito (${diasCredito} días). Saldo pendiente: $${saldoPendienteUsd.toFixed(2)}.`
        : "";

      const docData = {
        tipo: "NOTA DE ENTREGA",
        folio,
        empresa: state.empresa,
        cliente: { documento: docCli, nombre: nomCli },
        items: carrito,
        totalUsd,
        monedas: monedas.length ? monedas : ["USD", "BS"],
        tasas,
        pagos: pagosValidos,
        observaciones: obsCredito
      };

      if (formato === "carta") imprimirDocumentoCarta(docData);
      else if (formato === "ticket") imprimirTicket80mm(docData);
      else alert(`Nota de Entrega N° ${folio} emitida correctamente.`);

      limpiarCaja();
      chequearDeudaClienteActual();
      renderBusqueda();
    } catch (err) {
      alert("Error emitiendo Nota de Entrega: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Emitir Nota de Entrega (F9)";
    }
  }

  root.querySelector("#btnEmitirNota").addEventListener("click", emitirNota);

  const onKeyDown = (e) => {
    if (state.rutaActual !== "caja-pos") return;
    if (e.key === "F1") { e.preventDefault(); busqEl.focus(); }
    else if (e.key === "F2") { e.preventDefault(); docEl.focus(); }
    else if (e.key === "F4") {
      e.preventDefault();
      tarifaEl.value = tarifaEl.value === "detal" ? "mayor" : "detal";
      tarifaEl.dispatchEvent(new Event("change"));
    }
    else if (e.key === "F8") { e.preventDefault(); limpiarCaja(); }
    else if (e.key === "F9") { e.preventDefault(); emitirNota(); }
  };
  window.addEventListener("keydown", onKeyDown);

  busqEl.addEventListener("input", renderBusqueda);

  actualizarFolioUI();
  const [snapCat, snapCli, snapNotas] = await Promise.all([
    getDocs(refs.catalogo()),
    getDocs(refs.clientes()),
    getDocs(refs.notasEntrega())
  ]);
  catalogo = snapCat.docs.map((d) => ({ id: d.id, ...d.data() }));
  clientes = snapCli.docs.map((d) => ({ id: d.id, ...d.data() }));
  todasNotas = snapNotas.docs.map((d) => ({ id: d.id, ...d.data() }));

  if (state.cotizacionPendiente) {
    const cot = state.cotizacionPendiente;
    state.cotizacionPendiente = null;
    docEl.value = cot.cliente?.documento || "";
    nomEl.value = cot.cliente?.nombre || "";
    if (cot.multiplicador) aplicarFactorPos(cot.multiplicador);
    carrito = (cot.items || []).map((it) => ({ ...it }));
    chequearDeudaClienteActual();
  }

  renderCarrito();
}
