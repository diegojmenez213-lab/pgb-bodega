// venezuela/modules/caja-pos.js
import {
  db,
  getTenantRefs,
  doc,
  getDocs,
  setDoc,
  query,
  where,
  runTransaction,
  increment,
  normalizarIdVE,
  serverTimestamp,
  obtenerFechaLocalIso
} from "../core/db.js";

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

function convertirUsdAMoneda(montoUsd, moneda, tasas) {
  const usd = Number(montoUsd || 0);
  const bcv = Number(tasas.bcvActiva || tasas.bcvHoy || 0);
  const eur = Number(tasas.eur || 0);
  const usdt = Number(tasas.usdt || 0);

  if (moneda === "USD") return { ok: true, texto: `$${usd.toFixed(2)}` };
  if (moneda === "BS") {
    if (!bcv) return { ok: false, texto: "Bs. --" };
    return { ok: true, texto: `Bs. ${(usd * bcv).toFixed(2)}` };
  }
  if (moneda === "USDT") {
    const val = (bcv > 0 && usdt > 0) ? (usd * bcv) / usdt : usd;
    return { ok: true, texto: `${val.toFixed(2)} USDT` };
  }
  if (moneda === "EUR") {
    if (!bcv || !eur) return { ok: false, texto: "€ --" };
    return { ok: true, texto: `€ ${((usd * bcv) / eur).toFixed(2)}` };
  }
  return { ok: true, texto: `$${usd.toFixed(2)}` };
}

function parseMultiplicadorTexto(raw) {
  const limpio = String(raw || "").replace(",", ".").trim();
  if (!limpio || limpio === "." || limpio.endsWith(".")) return null;
  const num = Number(limpio);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

function normalizarBusquedaTexto(txt) {
  return String(txt || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9/.\-]+/g, " ")
    .trim();
}

function cumpleFiltroEstricto(prod, queryRaw) {
  const dispAlm = Math.max(0, Number(prod.stockAlmacen || 0));
  const dispPla = Math.max(0, Number(prod.stockPlanta || 0));
  if (dispAlm <= 0 && dispPla <= 0) return false;

  const qNorm = normalizarBusquedaTexto(queryRaw);
  if (!qNorm) return true;

  const codigo = normalizarBusquedaTexto(prod.codigo || prod.id || "");
  const campoCompleto = normalizarBusquedaTexto(
    `${prod.codigo || ""} ${prod.descripcion || ""} ${prod.marca || ""} ${prod.proveedor || ""}`
  );
  const tokensCampo = campoCompleto.split(/\s+/).filter(Boolean);
  const terminos = qNorm.split(/\s+/).filter(Boolean);

  if (terminos.length === 1 && terminos[0].length < 5) {
    const t = terminos[0];
    return codigo.startsWith(t) || tokensCampo.some((w) => w.startsWith(t));
  }

  return terminos.every((t) => {
    if (codigo.includes(t)) return true;
    return tokensCampo.some((w) => w === t || (t.length >= 4 && w.startsWith(t)));
  });
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

      <div id="panelLimiteCredito" class="hidden ve-card border-amber-300 bg-amber-50/60 p-3 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="font-extrabold text-amber-950">Límite de Crédito:</span>
          <span id="txtLimiteActual" class="font-mono-ve font-extrabold text-amber-900">Sin límite</span>
          <span id="txtCupoDisponible" class="text-[11px] font-bold text-slate-600"></span>
        </div>
        <div class="flex items-center gap-1.5">
          <button id="btnEditarLimitePos" type="button" class="px-2.5 py-1 rounded-lg bg-white border border-amber-300 text-amber-900 text-[11px] font-extrabold cursor-pointer">
            Configurar límite
          </button>
          <div id="wrapEditLimitePos" class="hidden flex items-center gap-1.5">
            <input id="inpLimitePos" type="text" inputmode="numeric" value="0.00" class="w-24 bg-white border border-amber-400 rounded-lg px-2 py-1 text-xs font-mono-ve font-bold text-right" title="0.00 = Sin límite" />
            <button id="btnGuardarLimitePos" type="button" class="px-2.5 py-1 rounded-lg bg-amber-600 text-white text-[11px] font-extrabold cursor-pointer">
              Guardar
            </button>
          </div>
        </div>
      </div>

      <div id="panelSaldoFavor" class="hidden ve-card border-emerald-300 bg-emerald-50/80 p-3.5 space-y-2.5">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="text-xs space-y-1">
            <div id="txtSaldoFavor" class="font-extrabold text-emerald-950"></div>
            <div id="equivSaldoFavor" class="font-mono-ve text-[11px] font-bold text-emerald-900"></div>
            <div id="subSaldoFavor" class="text-[11px] text-emerald-800 font-semibold"></div>
          </div>
          <div class="flex items-center gap-1.5">
            <label class="text-[10px] font-extrabold uppercase text-emerald-900">Ver en:</label>
            <select id="selMonedaFavor" class="bg-white border border-emerald-300 rounded-lg px-2 py-1 text-xs font-extrabold text-emerald-950">
              <option value="USD">USD ($)</option>
              <option value="BS">Bolívares (Bs. BCV)</option>
              <option value="USDT">USDT</option>
              <option value="EUR">EUR (€)</option>
            </select>
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5 bg-emerald-100/80 p-1 rounded-xl">
          <button type="button" id="btnDecidirUsarFavor" class="py-2 px-2.5 rounded-lg text-xs font-extrabold bg-emerald-700 text-white cursor-pointer">
            ✓ Restar saldo a favor del total
          </button>
          <button type="button" id="btnDecidirGuardarFavor" class="py-2 px-2.5 rounded-lg text-xs font-extrabold bg-white text-emerald-950 border border-emerald-300 cursor-pointer">
            Guardar aparte y pagar nota completa
          </button>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div class="lg:col-span-7 space-y-3">
          <div id="boxClientePos" class="ve-card p-3 space-y-2 relative">
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input id="posCliDoc" type="text" autocomplete="off" placeholder="Cédula / RIF (F2)" class="bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold uppercase" />
              <input id="posCliNom" type="text" autocomplete="off" placeholder="Nombre / Razón Social" class="bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold" />
              <div class="flex gap-1.5">
                <select id="posTarifa" class="flex-1 bg-slate-50 border border-slate-300 rounded-xl px-2.5 py-2 text-xs font-bold">
                  <option value="detal">Detal (×${fDetal})</option>
                  <option value="mayor">Mayor (×${fMayor})</option>
                  <option value="custom">Mult.</option>
                </select>
                <input
                  id="posMult"
                  type="text"
                  inputmode="decimal"
                  value="${fDetal}"
                  title="Multiplicador libre sobre costo"
                  class="w-20 bg-white border border-slate-300 rounded-xl px-2 py-2 text-xs font-mono-ve font-extrabold text-center"
                />
              </div>
            </div>
            <div id="sugerenciasCliPos" class="hidden bg-white border border-slate-300 rounded-xl shadow-lg max-h-44 overflow-y-auto divide-y divide-slate-100"></div>
          </div>

          <div class="ve-card p-3 space-y-2">
            <div class="flex items-center gap-2">
              <input id="posBusq" type="text" placeholder="Buscar producto disponible (Almacén o Planta) (F1)..." class="flex-1 bg-slate-50 border border-slate-300 rounded-xl px-3 py-2.5 text-xs font-bold outline-none focus:border-slate-950" />
              <button id="btnToggleBusqPos" type="button" class="px-3 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-extrabold cursor-pointer shrink-0">
                Disponibles
              </button>
            </div>
            <div id="posResultados" class="space-y-1.5 max-h-80 overflow-y-auto">
              <div class="text-xs text-slate-400 text-center py-6">Sincronizando catálogo...</div>
            </div>
          </div>
        </div>

        <div id="posCarritoCard" class="lg:col-span-5 space-y-3">
          <div class="ve-card space-y-3">
            <div class="flex items-center justify-between">
              <h2 class="text-sm font-extrabold text-slate-900">Ítems de la Nota (<span id="posCantItemsBadge">0</span> und)</h2>
              <button id="btnLimpiarPos" type="button" class="text-[11px] font-bold text-rose-600 cursor-pointer">Limpiar (F8)</button>
            </div>

            <div id="avisoCostoCotizacion" class="hidden p-2.5 rounded-xl bg-rose-50 border border-rose-300 text-[11px] text-rose-900 space-y-1">
              <div class="font-extrabold">📈 Aviso: el costo subió desde que se hizo esta cotización</div>
              <div id="txtAvisoCostoCotizacion" class="font-semibold leading-snug"></div>
            </div>

            <div id="avisoExcesoAlmacen" class="hidden p-2.5 rounded-xl bg-amber-50 border border-amber-300 text-[11px] text-amber-950 space-y-1">
              <div class="font-extrabold">⚠️ Cantidad superior al stock de Almacén</div>
              <div id="txtAvisoExcesoAlmacen" class="font-semibold leading-snug"></div>
            </div>

            <div id="posCarrito" class="space-y-2 max-h-80 overflow-y-auto">
              <div class="text-xs text-slate-400 text-center py-6">Carrito vacío.</div>
            </div>

            <div class="pt-3 border-t border-slate-200 space-y-1">
              <div class="flex justify-between text-base font-extrabold text-slate-950">
                <span>TOTAL USD</span>
                <span id="posTotalUsd" class="font-mono-ve">$0.00</span>
              </div>
              <div id="filaDescuentoFavor" class="hidden flex justify-between text-xs font-bold text-emerald-700">
                <span>Saldo a favor descontado</span>
                <span id="posDescuentoFavor" class="font-mono-ve">-$0.00</span>
              </div>
              <div id="filaNetoPagar" class="hidden flex justify-between text-sm font-extrabold text-slate-900">
                <span>A PAGAR EN ESTA NOTA</span>
                <span id="posNetoPagar" class="font-mono-ve">$0.00</span>
              </div>
              <div class="flex justify-between text-xs font-bold text-slate-500">
                <span>Total Bs. (BCV)</span>
                <span id="posTotalBs" class="font-mono-ve">Bs. 0.00</span>
              </div>
              <div class="flex justify-between text-[11px] font-bold text-slate-400">
                <span>Ref. USDT (Binance P2P)</span>
                <span id="posTotalUsdt" class="font-mono-ve">0.00 USDT</span>
              </div>
            </div>

            <div class="pt-2 border-t border-slate-200 space-y-2">
              <div class="grid grid-cols-2 gap-1.5 bg-slate-100 p-1 rounded-xl">
                <button type="button" id="btnModoContado" class="py-2 rounded-lg text-xs font-extrabold bg-slate-950 text-white cursor-pointer">
                  Contado
                </button>
                <button type="button" id="btnModoCredito" class="py-2 rounded-lg text-xs font-extrabold text-slate-700 cursor-pointer">
                  Crédito
                </button>
              </div>

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
                <div id="alertaExcesoLimite" class="hidden p-2 rounded-lg bg-rose-100 border border-rose-300 text-[11px] font-extrabold text-rose-900"></div>
              </div>
            </div>

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

              <div id="panelVueltoCambio" class="hidden p-2.5 rounded-xl bg-sky-50 border border-sky-200 space-y-2">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-[11px] font-extrabold text-sky-950">Cambio / Excedente:</span>
                  <div class="text-right">
                    <div id="posVueltoUsd" class="font-mono-ve text-sm font-extrabold text-sky-900">$0.00</div>
                    <div id="posVueltoBs" class="font-mono-ve text-[10px] font-bold text-sky-700">Bs. 0.00</div>
                  </div>
                </div>
                <div class="grid grid-cols-2 gap-1.5">
                  <button type="button" id="btnExcedenteVuelto" class="py-1.5 px-2 rounded-lg text-[11px] font-extrabold bg-sky-700 text-white cursor-pointer">
                    💵 Entregar Vuelto
                  </button>
                  <button type="button" id="btnExcedenteFavor" class="py-1.5 px-2 rounded-lg text-[11px] font-extrabold bg-white border border-sky-300 text-sky-900 cursor-pointer">
                    💾 Dejar Saldo a Favor
                  </button>
                </div>
              </div>
            </div>

            <button id="btnEmitirNota" type="button" class="w-full py-3.5 rounded-2xl bg-slate-950 hover:bg-slate-800 text-white text-xs font-extrabold uppercase tracking-wider cursor-pointer">
              Confirmar Venta y Ver Notas (F9)
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  let catalogo = [];
  let clientes = [];
  let deudasActivas = [];
  let carrito = [];
  let pagos = [{ metodo: "Efectivo USD", montoUsd: 0, referencia: "" }];
  let factorActual = fDetal;
  let ultimoFolio = Number(state.empresa?.correlativos?.notaEntregaActual || 0);
  let esCredito = false;
  let diasCredito = 15;
  let busqAbierta = false;
  let saldoFavorDisponible = 0;
  let deudaActualCliente = 0;
  let limiteCreditoCliente = 0;
  let usarSaldoFavorEnNota = true;
  let modoExcedente = "vuelto";
  let monedaVistaFavor = "USD";
  let cotizacionOrigenId = null;
  let emitiendo = false;
  let ultimoClienteAplicadoId = "";

  const docEl = root.querySelector("#posCliDoc");
  const nomEl = root.querySelector("#posCliNom");
  const sugCliEl = root.querySelector("#sugerenciasCliPos");
  const tarifaEl = root.querySelector("#posTarifa");
  const multEl = root.querySelector("#posMult");
  const busqEl = root.querySelector("#posBusq");
  const resEl = root.querySelector("#posResultados");
  const cartEl = root.querySelector("#posCarrito");
  const pagosEl = root.querySelector("#posPagos");
  const alertaBox = root.querySelector("#alertaDeudaCliente");
  const limiteBox = root.querySelector("#panelLimiteCredito");
  const favorBox = root.querySelector("#panelSaldoFavor");
  const selMonFavor = root.querySelector("#selMonedaFavor");
  const inpLimitePos = root.querySelector("#inpLimitePos");

  function buscarProdCatalogo(itemCarrito) {
    return catalogo.find(
      (x) => x.id === itemCarrito.prodId || x.id === itemCarrito.id || x.codigo === itemCarrito.codigo
    );
  }

  function refrescarAvisoExcesoAlmacen() {
    if (!root.isConnected) return;
    const box = root.querySelector("#avisoExcesoAlmacen");
    const txt = root.querySelector("#txtAvisoExcesoAlmacen");
    const mensajes = [];

    for (const it of carrito) {
      const prod = buscarProdCatalogo(it);
      const dispAlm = Math.max(0, Number(prod?.stockAlmacen || 0));
      const dispPla = Math.max(0, Number(prod?.stockPlanta || 0));

      if (it.origen === "almacen" && it.cantidad > dispAlm) {
        const excedente = it.cantidad - dispAlm;
        if (dispAlm > 0) {
          mensajes.push(
            `<strong>${it.codigo}</strong>: solo hay <strong>${dispAlm} und</strong> en Almacén; se tomarán <strong>${dispAlm} und de Almacén</strong> y <strong>${excedente} und de Planta</strong>${dispPla > 0 ? ` (disponibles en Planta: ${dispPla})` : ""}.`
          );
        } else {
          mensajes.push(
            `<strong>${it.codigo}</strong>: no hay stock en Almacén (0 und); las <strong>${it.cantidad} und</strong> se tomarán de <strong>Planta</strong>${dispPla > 0 ? ` (disponibles: ${dispPla})` : ""}.`
          );
        }
      }
    }

    if (!mensajes.length) {
      box.classList.add("hidden");
      return;
    }

    txt.innerHTML = mensajes.join("<br>");
    box.classList.remove("hidden");
  }

  function sincronizarSelectTarifaConFactor(val) {
    if (Math.abs(val - fMayor) < 0.001) tarifaEl.value = "mayor";
    else if (Math.abs(val - fDetal) < 0.001) tarifaEl.value = "detal";
    else tarifaEl.value = "custom";
  }

  function aplicarFactorPos(nuevoFactor, sincronizarInput = false, recalcularCarrito = true) {
    const val = parseMultiplicadorTexto(nuevoFactor);
    if (val === null) return;
    factorActual = val;
    if (sincronizarInput) {
      multEl.value = String(val);
      sincronizarSelectTarifaConFactor(val);
    }
    if (recalcularCarrito && carrito.length) {
      carrito = carrito.map((it) => ({
        ...it,
        precioUsd: Number(((it.costoUsd || 0) * factorActual).toFixed(2))
      }));
      renderCarrito();
    }
    if (busqAbierta || busqEl.value.trim()) renderBusqueda();
  }

  function aplicarClienteDetectado(cli, { rellenarDoc = true, rellenarNom = true, forzar = false } = {}) {
    if (!cli) return;
    if (rellenarDoc && cli.id && (forzar || !docEl.value.trim() || normalizarIdVE(docEl.value) === cli.id)) {
      docEl.value = cli.id;
    }
    if (rellenarNom && cli.nombre && (forzar || !nomEl.value.trim())) {
      nomEl.value = cli.nombre;
    }

    if (ultimoClienteAplicadoId !== cli.id) {
      ultimoClienteAplicadoId = cli.id;
      const fCli =
        Number(cli.ultimoMultiplicador) ||
        Number(cli.factorPersonalizado) ||
        (cli.tarifa === "mayor" ? fMayor : fDetal);

      aplicarFactorPos(fCli, true, true);
    }

    usarSaldoFavorEnNota = true;
    refrescarEstadoClienteActual();
  }

  function renderSugerenciasCliente(textoRaw) {
    const q = normalizarBusquedaTexto(textoRaw);
    if (!q || q.length < 2) {
      sugCliEl.classList.add("hidden");
      return;
    }

    const matches = clientes.filter((c) => {
      if (!c.id || c.id === "V-00000000") return false;
      const nom = normalizarBusquedaTexto(c.nombre || "");
      const docNorm = normalizarBusquedaTexto(c.id || "");
      return nom.includes(q) || docNorm.includes(q);
    }).slice(0, 8);

    if (!matches.length) {
      sugCliEl.classList.add("hidden");
      return;
    }

    sugCliEl.innerHTML = matches.map((c) => {
      const multGuardado = Number(c.ultimoMultiplicador || c.factorPersonalizado || 0);
      return `
        <button type="button" class="btn-pick-cli-pos w-full text-left px-3 py-2 text-xs hover:bg-slate-100 flex items-center justify-between gap-2 cursor-pointer" data-clid="${encodeURIComponent(c.id)}">
          <div class="min-w-0 truncate">
            <span class="font-extrabold text-slate-900">${c.nombre || c.id}</span>
            <span class="font-mono-ve text-[10px] text-slate-500 ml-1">${c.id}</span>
          </div>
          ${multGuardado > 0 ? `<span class="font-mono-ve text-[10px] font-extrabold px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 shrink-0">×${multGuardado}</span>` : ""}
        </button>
      `;
    }).join("");
    sugCliEl.classList.remove("hidden");
  }

  sugCliEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-pick-cli-pos");
    if (!btn) return;
    const clid = decodeURIComponent(btn.dataset.clid || "");
    const cli = clientes.find((c) => c.id === clid);
    sugCliEl.classList.add("hidden");
    if (cli) aplicarClienteDetectado(cli, { rellenarDoc: true, rellenarNom: true, forzar: true });
  });

  root.addEventListener("click", (e) => {
    if (!e.target.closest("#boxClientePos")) {
      sugCliEl.classList.add("hidden");
    }
  });

  function actualizarFolioUI() {
    if (!root.isConnected) return;
    root.querySelector("#nextFolioTxt").textContent = String(ultimoFolio + 1).padStart(5, "0");
  }

  function totalVenta() {
    return carrito.reduce((acc, it) => acc + it.cantidad * it.precioUsd, 0);
  }

  function montoDescuentoFavorActual() {
    if (saldoFavorDisponible <= 0.01 || !usarSaldoFavorEnNota) return 0;
    return Math.min(saldoFavorDisponible, Number(totalVenta().toFixed(2)));
  }

  function montoObjetivoHoy() {
    return Math.max(0, Number((totalVenta() - montoDescuentoFavorActual()).toFixed(2)));
  }

  function actualizarBotonesExcedente() {
    const btnV = root.querySelector("#btnExcedenteVuelto");
    const btnF = root.querySelector("#btnExcedenteFavor");
    if (modoExcedente === "vuelto") {
      btnV.className = "py-1.5 px-2 rounded-lg text-[11px] font-extrabold bg-sky-700 text-white cursor-pointer";
      btnF.className = "py-1.5 px-2 rounded-lg text-[11px] font-extrabold bg-white border border-sky-300 text-sky-900 cursor-pointer";
    } else {
      btnF.className = "py-1.5 px-2 rounded-lg text-[11px] font-extrabold bg-emerald-700 text-white cursor-pointer";
      btnV.className = "py-1.5 px-2 rounded-lg text-[11px] font-extrabold bg-white border border-sky-300 text-sky-900 cursor-pointer";
    }
  }

  root.querySelector("#btnExcedenteVuelto").addEventListener("click", () => {
    modoExcedente = "vuelto";
    actualizarBotonesExcedente();
  });

  root.querySelector("#btnExcedenteFavor").addEventListener("click", () => {
    modoExcedente = "favor";
    actualizarBotonesExcedente();
  });

  function actualizarBotonesDecisionFavor() {
    const btnUsar = root.querySelector("#btnDecidirUsarFavor");
    const btnGuardar = root.querySelector("#btnDecidirGuardarFavor");
    if (usarSaldoFavorEnNota) {
      btnUsar.className = "py-2 px-2.5 rounded-lg text-xs font-extrabold bg-emerald-700 text-white cursor-pointer";
      btnGuardar.className = "py-2 px-2.5 rounded-lg text-xs font-extrabold bg-white text-emerald-950 border border-emerald-300 cursor-pointer";
    } else {
      btnGuardar.className = "py-2 px-2.5 rounded-lg text-xs font-extrabold bg-emerald-700 text-white cursor-pointer";
      btnUsar.className = "py-2 px-2.5 rounded-lg text-xs font-extrabold bg-white text-emerald-950 border border-emerald-300 cursor-pointer";
    }
  }

  function refrescarEstadoClienteActual() {
    if (!root.isConnected) return;
    const docId = normalizarIdVE(docEl.value);
    if (!docId || docId.length < 5 || docId === "V-00000000") {
      alertaBox.classList.add("hidden");
      limiteBox.classList.add("hidden");
      favorBox.classList.add("hidden");
      saldoFavorDisponible = 0;
      deudaActualCliente = 0;
      limiteCreditoCliente = 0;
      renderTotalesYRestante();
      return;
    }

    const cli = clientes.find((c) => c.id === docId);
    saldoFavorDisponible = Number(cli?.saldoAFavorUsd || 0);
    limiteCreditoCliente = Number(cli?.limiteCreditoUsd || 0);

    const pendientes = deudasActivas.filter((n) => {
      if (n.anulada) return false;
      if (normalizarIdVE(n.cliente?.documento || "") !== docId) return false;
      return Number(n.saldoPendienteUsd || 0) > 0.01;
    });

    deudaActualCliente = Number(
      pendientes.reduce((acc, n) => acc + Number(n.saldoPendienteUsd || 0), 0).toFixed(2)
    );

    limiteBox.classList.remove("hidden");
    if (limiteCreditoCliente > 0) {
      const cupo = Number((limiteCreditoCliente - deudaActualCliente).toFixed(2));
      root.querySelector("#txtLimiteActual").textContent = `$${limiteCreditoCliente.toFixed(2)}`;
      root.querySelector("#txtCupoDisponible").textContent = cupo >= 0
        ? `(Cupo disponible: $${cupo.toFixed(2)})`
        : `(Excedido en $${Math.abs(cupo).toFixed(2)})`;
    } else {
      root.querySelector("#txtLimiteActual").textContent = "Sin límite";
      root.querySelector("#txtCupoDisponible").textContent = "";
    }
    inpLimitePos.value = limiteCreditoCliente.toFixed(2);

    if (saldoFavorDisponible > 0.01) {
      const cliNombre = nomEl.value.trim() || cli?.nombre || docId;
      const tasas = getTasaActiva(state);
      const convFavor = convertirUsdAMoneda(saldoFavorDisponible, monedaVistaFavor, tasas);
      const convBs = convertirUsdAMoneda(saldoFavorDisponible, "BS", tasas);
      const convUsdt = convertirUsdAMoneda(saldoFavorDisponible, "USDT", tasas);
      const convEur = convertirUsdAMoneda(saldoFavorDisponible, "EUR", tasas);

      root.querySelector("#txtSaldoFavor").textContent =
        `${cliNombre} tiene un saldo a favor de $${saldoFavorDisponible.toFixed(2)} (${convFavor.texto}).`;
      root.querySelector("#equivSaldoFavor").textContent =
        `Equivalencia del día: ${convBs.texto} • ${convUsdt.texto}${convEur.ok ? ` • ${convEur.texto}` : ""}`;
      root.querySelector("#subSaldoFavor").textContent = usarSaldoFavorEnNota
        ? "Se descontará automáticamente del total de esta nota."
        : "Quedará intacto para después y se cobrará la nota aparte.";
      actualizarBotonesDecisionFavor();
      favorBox.classList.remove("hidden");
    } else {
      favorBox.classList.add("hidden");
    }

    if (!pendientes.length) {
      alertaBox.classList.add("hidden");
    } else {
      const nombreCli = nomEl.value.trim() || pendientes[0]?.cliente?.nombre || docId;
      root.querySelector("#txtAlertaDeuda").textContent =
        `${nombreCli} (${docId}) tiene una deuda total de $${deudaActualCliente.toFixed(2)}.`;
      root.querySelector("#subAlertaDeuda").textContent = pendientes.length === 1
        ? `Corresponde a 1 nota pendiente por $${deudaActualCliente.toFixed(2)}.`
        : `Suma de ${pendientes.length} notas pendientes: $${deudaActualCliente.toFixed(2)}.`;
      alertaBox.classList.remove("hidden");
    }

    renderTotalesYRestante();
  }

  root.querySelector("#btnEditarLimitePos").addEventListener("click", () => {
    const wrap = root.querySelector("#wrapEditLimitePos");
    wrap.classList.toggle("hidden");
    if (!wrap.classList.contains("hidden")) {
      inpLimitePos.focus();
      fijarCursorAlFinal(inpLimitePos);
    }
  });

  inpLimitePos.addEventListener("input", () => formatearEntradaMoneda(inpLimitePos));
  inpLimitePos.addEventListener("click", () => fijarCursorAlFinal(inpLimitePos));

  root.querySelector("#btnGuardarLimitePos").addEventListener("click", async () => {
    const docId = normalizarIdVE(docEl.value);
    if (!docId || docId === "V-00000000") return;
    const nuevoLim = Math.max(0, parseFloat(inpLimitePos.value) || 0);
    const nomCli = nomEl.value.trim() || clientes.find((c) => c.id === docId)?.nombre || docId;

    await setDoc(doc(refs.clientes(), docId), {
      documento: docId,
      nombre: nomCli,
      limiteCreditoUsd: nuevoLim,
      actualizadoEn: serverTimestamp()
    }, { merge: true });

    const ex = clientes.find((c) => c.id === docId);
    if (ex) ex.limiteCreditoUsd = nuevoLim;
    else clientes.push({ id: docId, documento: docId, nombre: nomCli, limiteCreditoUsd: nuevoLim });

    root.querySelector("#wrapEditLimitePos").classList.add("hidden");
    refrescarEstadoClienteActual();
  });

  selMonFavor.addEventListener("change", () => {
    monedaVistaFavor = selMonFavor.value;
    refrescarEstadoClienteActual();
  });

  root.querySelector("#btnDecidirUsarFavor").addEventListener("click", () => {
    usarSaldoFavorEnNota = true;
    if (!esCredito && pagos.length === 1) pagos[0].auto = true;
    refrescarEstadoClienteActual();
    renderPagos();
  });

  root.querySelector("#btnDecidirGuardarFavor").addEventListener("click", () => {
    usarSaldoFavorEnNota = false;
    if (!esCredito && pagos.length === 1) pagos[0].auto = true;
    refrescarEstadoClienteActual();
    renderPagos();
  });

  root.querySelector("#btnVerDeudaCliente").addEventListener("click", () => {
    if (typeof window.NEXUS_VE_NAV === "function") window.NEXUS_VE_NAV("deudores");
  });

  function renderTotalesYRestante() {
    if (!root.isConnected) return;
    const total = totalVenta();
    const descuento = montoDescuentoFavorActual();
    const objetivo = montoObjetivoHoy();
    const tasas = getTasaActiva(state);

    root.querySelector("#posTotalUsd").textContent = `$${total.toFixed(2)}`;
    root.querySelector("#posTotalBs").textContent = tasas.bcvActiva ? `Bs. ${(total * tasas.bcvActiva).toFixed(2)}` : "Bs. --";
    const convUsdt = convertirUsdAMoneda(total, "USDT", tasas);
    root.querySelector("#posTotalUsdt").textContent = convUsdt.texto;

    const filaDesc = root.querySelector("#filaDescuentoFavor");
    const filaNeto = root.querySelector("#filaNetoPagar");
    if (descuento > 0.01) {
      filaDesc.classList.remove("hidden");
      filaNeto.classList.remove("hidden");
      root.querySelector("#posDescuentoFavor").textContent = `-$${descuento.toFixed(2)}`;
      root.querySelector("#posNetoPagar").textContent = `$${objetivo.toFixed(2)}`;
    } else {
      filaDesc.classList.add("hidden");
      filaNeto.classList.add("hidden");
    }

    const cubierto = pagos.reduce((acc, p) => acc + Number(p.montoUsd || 0), 0);
    const restante = Math.max(0, Number((objetivo - cubierto).toFixed(2)));
    const excedente = Math.max(0, Number((cubierto - objetivo).toFixed(2)));

    const restEl = root.querySelector("#posRestante");
    restEl.textContent = `$${restante.toFixed(2)}`;
    restEl.className = esCredito
      ? "font-mono-ve text-amber-800"
      : (restante <= 0.01 ? "font-mono-ve text-emerald-700" : "font-mono-ve text-rose-600");

    const panelVuelto = root.querySelector("#panelVueltoCambio");
    if (excedente > 0.01) {
      panelVuelto.classList.remove("hidden");
      root.querySelector("#posVueltoUsd").textContent = `$${excedente.toFixed(2)}`;
      root.querySelector("#posVueltoBs").textContent = tasas.bcvActiva
        ? `Bs. ${(excedente * tasas.bcvActiva).toFixed(2)} (BCV)`
        : "Bs. --";
      actualizarBotonesExcedente();
    } else {
      panelVuelto.classList.add("hidden");
    }

    const alertaLim = root.querySelector("#alertaExcesoLimite");
    if (esCredito && limiteCreditoCliente > 0 && (deudaActualCliente + restante) > limiteCreditoCliente + 0.01) {
      const proyectada = Number((deudaActualCliente + restante).toFixed(2));
      alertaLim.textContent = `⚠️ Supera el límite de crédito ($${limiteCreditoCliente.toFixed(2)}). La deuda total quedaría en $${proyectada.toFixed(2)}.`;
      alertaLim.classList.remove("hidden");
    } else {
      alertaLim.classList.add("hidden");
    }
  }

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
    if (!root.isConnected) return;
    const objetivo = montoObjetivoHoy();
    if (!esCredito && pagos.length === 1 && pagos[0].auto !== false) {
      pagos[0].montoUsd = Number(objetivo.toFixed(2));
    }

    pagosEl.innerHTML = pagos.map((p, idx) => `
      <div class="flex items-center gap-1.5" data-pidx="${idx}">
        <select class="sel-met flex-1 min-w-0 bg-slate-50 border border-slate-300 rounded-lg px-2 py-1.5 text-xs font-bold">
          ${METODOS_PAGO.map((m) => `<option value="${m}" ${p.metodo === m ? "selected" : ""}>${m}</option>`).join("")}
        </select>
        <input type="text" value="${p.referencia || ""}" placeholder="Ref." class="inp-pref w-16 bg-slate-50 border border-slate-300 rounded-lg px-1.5 py-1.5 text-[11px] font-mono-ve font-bold" title="Últimos dígitos de referencia (opcional)" />
        <input type="text" inputmode="numeric" value="${Number(p.montoUsd || 0).toFixed(2)}" class="inp-pmonto w-24 bg-white border border-slate-300 rounded-lg px-2 py-1.5 text-xs font-mono-ve font-bold text-right" />
        ${pagos.length > 1 ? `<button type="button" class="btn-rm-pago text-xs font-bold text-rose-600 px-1 cursor-pointer">✕</button>` : ""}
      </div>
    `).join("");

    renderTotalesYRestante();
  }

  function agregarProductoCaja(prodId, cantAgregar = 1) {
    const p = catalogo.find((x) => x.id === prodId || x.codigo === prodId);
    if (!p) return;
    const sum = Math.max(1, parseInt(cantAgregar, 10) || 1);
    const dispAlm = Math.max(0, Number(p.stockAlmacen || 0));
    const origenInicial = dispAlm > 0 ? "almacen" : "planta";

    const ex = carrito.find((x) => x.prodId === p.id && x.origen === origenInicial);
    if (ex) {
      ex.cantidad += sum;
    } else {
      carrito.push({
        id: p.id,
        prodId: p.id,
        codigo: p.codigo || p.id,
        descripcion: p.descripcion || p.codigo || p.id,
        proveedor: p.proveedor || "",
        costoUsd: Number(p.costoUsd || 0),
        precioUsd: Number(((p.costoUsd || 0) * factorActual).toFixed(2)),
        cantidad: sum,
        origen: origenInicial
      });
    }

    renderCarrito();
    busqAbierta = false;
    busqEl.value = "";
    resEl.innerHTML = `<div class="text-xs text-emerald-700 font-bold text-center py-2">✓ Agregado (${origenInicial === "almacen" ? "Almacén" : "Planta"}). Toca "Disponibles" o escribe para sumar más.</div>`;
    root.querySelector("#posCarritoCard")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function renderCarrito() {
    if (!root.isConnected) return;
    const totalUnds = carrito.reduce((acc, it) => acc + Number(it.cantidad || 0), 0);
    root.querySelector("#posCantItemsBadge").textContent = String(totalUnds);
    refrescarAvisoExcesoAlmacen();

    if (!carrito.length) {
      cartEl.innerHTML = `<div class="text-xs text-slate-400 text-center py-6">Carrito vacío.</div>`;
    } else {
      cartEl.innerHTML = carrito.map((it, idx) => {
        const prod = buscarProdCatalogo(it);
        const dispAlm = Math.max(0, Number(prod?.stockAlmacen || 0));
        const dispPla = Math.max(0, Number(prod?.stockPlanta || 0));
        const excedeAlm = it.origen === "almacen" && it.cantidad > dispAlm;

        return `
          <div class="p-2.5 rounded-xl ${excedeAlm ? "bg-amber-50/70 border border-amber-300" : "bg-slate-50 border border-slate-200"} space-y-2" data-idx="${idx}">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="flex items-center gap-1.5 flex-wrap">
                  <span class="font-mono-ve text-[11px] font-extrabold text-slate-900">${it.codigo}</span>
                  <span class="text-[9px] font-extrabold px-1.5 py-0.5 rounded-full ${
                    it.origen === "almacen" ? "bg-emerald-100 text-emerald-800" : "bg-sky-100 text-sky-800"
                  }">${it.origen === "almacen" ? `ALMACÉN (disp: ${dispAlm})` : `PLANTA (disp: ${dispPla})`}</span>
                </div>
                <div class="text-[11px] font-semibold text-slate-600 truncate">${it.descripcion}</div>
                ${excedeAlm ? `<div class="text-[10px] font-extrabold text-amber-900 mt-0.5">Se tomarán ${dispAlm} de Almacén y ${it.cantidad - dispAlm} de Planta</div>` : ""}
              </div>
              <button type="button" class="btn-rm text-xs font-bold text-rose-600 cursor-pointer px-1.5 py-0.5">✕</button>
            </div>
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-1">
                <button type="button" class="btn-menos w-7 h-7 rounded-lg bg-white border border-slate-300 text-xs font-extrabold text-slate-800 cursor-pointer">−</button>
                <input type="number" min="1" value="${it.cantidad}" class="inp-cant w-14 h-7 bg-white border border-slate-300 rounded-lg px-1 text-xs font-extrabold text-center font-mono-ve" />
                <button type="button" class="btn-mas w-7 h-7 rounded-lg bg-slate-950 text-white text-xs font-extrabold cursor-pointer">+</button>
              </div>
              <div class="flex items-center gap-1">
                <span class="text-[10px] font-bold text-slate-500">$</span>
                <input type="text" inputmode="numeric" value="${Number(it.precioUsd).toFixed(2)}" class="inp-prec w-20 h-7 bg-white border border-slate-300 rounded-lg px-1.5 text-xs font-bold text-right font-mono-ve" />
              </div>
              <div class="item-subtotal font-mono-ve text-xs font-extrabold text-slate-900">$${(it.cantidad * it.precioUsd).toFixed(2)}</div>
            </div>
          </div>
        `;
      }).join("");
    }
    renderPagos();
  }

  function renderBusqueda() {
    if (!root.isConnected) return;
    const q = busqEl.value.trim();
    if (!q && !busqAbierta) {
      resEl.innerHTML = `<div class="text-xs text-slate-400 text-center py-6">Escribe o toca "Disponibles" para agregar repuestos con stock...</div>`;
      return;
    }

    const disponibles = catalogo
      .filter((p) => cumpleFiltroEstricto(p, q))
      .slice(0, 25);

    if (!disponibles.length) {
      resEl.innerHTML = `<div class="text-xs text-slate-500 font-bold text-center py-6">No disponible / Sin stock en Almacén ni en Planta.</div>`;
      return;
    }

    resEl.innerHTML = disponibles.map((p) => {
      const dispAlm = Math.max(0, Number(p.stockAlmacen || 0));
      const dispPla = Math.max(0, Number(p.stockPlanta || 0));
      const esAlmacen = dispAlm > 0;
      const precio = Number(((p.costoUsd || 0) * factorActual).toFixed(2));

      return `
        <div class="fila-prod-pos p-2.5 rounded-xl border border-slate-200 hover:bg-slate-50 active:bg-slate-100 flex items-center justify-between gap-2 cursor-pointer select-none" data-id="${encodeURIComponent(p.id)}">
          <div class="min-w-0 flex-1 pointer-events-none">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="font-mono-ve text-xs font-extrabold text-slate-900">${p.codigo}</span>
              ${esAlmacen
                ? `<span class="text-[9px] font-extrabold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800">Almacén: ${dispAlm}</span>`
                : `<span class="text-[9px] font-extrabold px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-900">Planta: ${dispPla}</span>`}
              ${p.proveedor ? `<span class="text-[9px] font-bold text-slate-400">${p.proveedor}</span>` : ""}
            </div>
            <div class="text-[11px] font-semibold text-slate-600 truncate mt-0.5">${p.descripcion}</div>
          </div>
          <button type="button" class="btn-add-pos px-3 py-1.5 rounded-xl bg-slate-950 text-white text-xs font-extrabold cursor-pointer shrink-0" data-id="${encodeURIComponent(p.id)}">
            + $${precio.toFixed(2)}
          </button>
        </div>
      `;
    }).join("");
  }

  root.querySelector("#btnToggleBusqPos").addEventListener("click", () => {
    busqAbierta = !busqAbierta;
    if (!busqAbierta && !busqEl.value.trim()) {
      resEl.innerHTML = `<div class="text-xs text-slate-400 text-center py-6">Listado retraído.</div>`;
    } else {
      renderBusqueda();
    }
  });

  resEl.addEventListener("click", (e) => {
    const target = e.target.closest("[data-id]");
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    agregarProductoCaja(decodeURIComponent(target.dataset.id || ""), 1);
  });

  cartEl.addEventListener("focusin", (e) => {
    if (e.target.classList.contains("inp-prec")) fijarCursorAlFinal(e.target);
  });

  cartEl.addEventListener("input", (e) => {
    const row = e.target.closest("[data-idx]");
    if (!row) return;
    const idx = Number(row.dataset.idx);
    if (e.target.classList.contains("inp-cant")) {
      carrito[idx].cantidad = Math.max(1, parseInt(e.target.value, 10) || 1);
      root.querySelector("#posCantItemsBadge").textContent = String(
        carrito.reduce((acc, it) => acc + Number(it.cantidad || 0), 0)
      );
      refrescarAvisoExcesoAlmacen();
    } else if (e.target.classList.contains("inp-prec")) {
      carrito[idx].precioUsd = formatearEntradaMoneda(e.target);
    }
    const subEl = row.querySelector(".item-subtotal");
    if (subEl) subEl.textContent = `$${(carrito[idx].cantidad * carrito[idx].precioUsd).toFixed(2)}`;
    if (!esCredito && pagos.length === 1 && pagos[0].auto !== false) {
      pagos[0].montoUsd = Number(montoObjetivoHoy().toFixed(2));
      const inpP = pagosEl.querySelector(".inp-pmonto");
      if (inpP) inpP.value = pagos[0].montoUsd.toFixed(2);
    }
    renderTotalesYRestante();
  });

  cartEl.addEventListener("click", (e) => {
    if (e.target.classList.contains("inp-prec")) {
      fijarCursorAlFinal(e.target);
      return;
    }
    const row = e.target.closest("[data-idx]");
    if (!row) return;
    const idx = Number(row.dataset.idx);
    if (e.target.closest(".btn-rm")) {
      carrito.splice(idx, 1);
      renderCarrito();
    } else if (e.target.closest(".btn-mas")) {
      carrito[idx].cantidad += 1;
      renderCarrito();
    } else if (e.target.closest(".btn-menos")) {
      if (carrito[idx].cantidad > 1) carrito[idx].cantidad -= 1;
      else carrito.splice(idx, 1);
      renderCarrito();
    }
  });

  pagosEl.addEventListener("focusin", (e) => {
    if (e.target.classList.contains("inp-pmonto")) fijarCursorAlFinal(e.target);
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
      pagos[idx].montoUsd = formatearEntradaMoneda(e.target);
      renderTotalesYRestante();
    } else if (e.target.classList.contains("inp-pref")) {
      pagos[idx].referencia = e.target.value.trim();
    }
  });

  pagosEl.addEventListener("click", (e) => {
    if (e.target.classList.contains("inp-pmonto")) {
      fijarCursorAlFinal(e.target);
      return;
    }
    if (!e.target.closest(".btn-rm-pago")) return;
    const idx = Number(e.target.closest("[data-pidx]").dataset.pidx);
    pagos.splice(idx, 1);
    renderPagos();
  });

  root.querySelector("#btnAddPago").addEventListener("click", () => {
    if (pagos.length >= 4) return alert("Máximo 4 formas de pago por documento.");
    const cubierto = pagos.reduce((acc, p) => acc + Number(p.montoUsd || 0), 0);
    const rest = Math.max(0, Number((montoObjetivoHoy() - cubierto).toFixed(2)));
    pagos.push({ metodo: "Pago Móvil Bs.", montoUsd: rest, referencia: "", auto: false });
    renderPagos();
  });

  docEl.addEventListener("input", () => {
    renderSugerenciasCliente(docEl.value);
    const id = normalizarIdVE(docEl.value);
    const cli = clientes.find((c) => c.id === id);
    if (cli) {
      aplicarClienteDetectado(cli, { rellenarDoc: false, rellenarNom: true, forzar: false });
      sugCliEl.classList.add("hidden");
    } else {
      ultimoClienteAplicadoId = "";
      refrescarEstadoClienteActual();
    }
  });

  docEl.addEventListener("blur", () => {
    const id = normalizarIdVE(docEl.value);
    const cli = clientes.find((c) => c.id === id);
    if (cli) {
      aplicarClienteDetectado(cli, { rellenarDoc: true, rellenarNom: true, forzar: false });
    } else {
      usarSaldoFavorEnNota = true;
      refrescarEstadoClienteActual();
    }
  });

  function buscarClientePorNombreExacto(texto) {
    const norm = normalizarBusquedaTexto(texto);
    if (!norm || norm.length < 3) return null;
    return clientes.find((c) => normalizarBusquedaTexto(c.nombre || "") === norm) || null;
  }

  nomEl.addEventListener("input", () => {
    renderSugerenciasCliente(nomEl.value);
    const cli = buscarClientePorNombreExacto(nomEl.value);
    if (cli) {
      aplicarClienteDetectado(cli, { rellenarDoc: true, rellenarNom: false, forzar: true });
      sugCliEl.classList.add("hidden");
    }
  });

  nomEl.addEventListener("blur", () => {
    const cli = buscarClientePorNombreExacto(nomEl.value);
    if (cli) aplicarClienteDetectado(cli, { rellenarDoc: true, rellenarNom: false, forzar: true });
  });

  tarifaEl.addEventListener("change", () => {
    if (tarifaEl.value === "mayor") aplicarFactorPos(fMayor, true, true);
    else if (tarifaEl.value === "detal") aplicarFactorPos(fDetal, true, true);
    else multEl.focus();
  });

  multEl.addEventListener("input", () => {
    tarifaEl.value = "custom";
    aplicarFactorPos(multEl.value, false, true);
  });

  multEl.addEventListener("blur", () => {
    const val = parseMultiplicadorTexto(multEl.value);
    if (val !== null) {
      multEl.value = String(val);
      sincronizarSelectTarifaConFactor(val);
      aplicarFactorPos(val, false, true);
    } else {
      multEl.value = String(factorActual);
    }
  });

  function limpiarCaja() {
    carrito = [];
    esCredito = false;
    diasCredito = 15;
    usarSaldoFavorEnNota = true;
    modoExcedente = "vuelto";
    cotizacionOrigenId = null;
    ultimoClienteAplicadoId = "";
    pagos = [{ metodo: "Efectivo USD", montoUsd: 0, referencia: "" }];
    root.querySelector("#avisoCostoCotizacion").classList.add("hidden");
    sugCliEl.classList.add("hidden");
    actualizarEstadoCreditoUI();
    renderCarrito();
  }

  root.querySelector("#btnLimpiarPos").addEventListener("click", limpiarCaja);

  function construirItemsClasificados() {
    const itemsFinales = [];
    const avisosDivision = [];

    for (const it of carrito) {
      const prod = buscarProdCatalogo(it);
      const dispAlm = Math.max(0, Number(prod?.stockAlmacen || 0));
      const cantTotal = Math.max(1, Number(it.cantidad || 1));
      const costoFresco = prod ? Number(prod.costoUsd || 0) : Number(it.costoUsd || 0);

      if (it.origen === "almacen" && cantTotal > dispAlm) {
        if (dispAlm > 0) {
          const cantPlanta = cantTotal - dispAlm;
          itemsFinales.push({
            ...it,
            id: prod?.id || it.prodId || it.id,
            prodId: prod?.id || it.prodId || it.id,
            costoUsd: costoFresco,
            cantidad: dispAlm,
            origen: "almacen"
          });
          itemsFinales.push({
            ...it,
            id: prod?.id || it.prodId || it.id,
            prodId: prod?.id || it.prodId || it.id,
            costoUsd: costoFresco,
            cantidad: cantPlanta,
            origen: "planta"
          });
          avisosDivision.push(`${it.codigo}: ${dispAlm} und de Almacén + ${cantPlanta} und de Planta`);
        } else {
          itemsFinales.push({
            ...it,
            id: prod?.id || it.prodId || it.id,
            prodId: prod?.id || it.prodId || it.id,
            costoUsd: costoFresco,
            cantidad: cantTotal,
            origen: "planta"
          });
          avisosDivision.push(`${it.codigo}: ${cantTotal} und de Planta (sin stock en Almacén)`);
        }
      } else {
        itemsFinales.push({
          ...it,
          id: prod?.id || it.prodId || it.id,
          prodId: prod?.id || it.prodId || it.id,
          costoUsd: costoFresco,
          cantidad: cantTotal,
          origen: it.origen || (dispAlm > 0 ? "almacen" : "planta")
        });
      }
    }

    return { itemsFinales, avisosDivision };
  }

  async function emitirNota() {
    if (emitiendo) return;
    if (!carrito.length) return alert("Agrega al menos un producto.");

    const { itemsFinales, avisosDivision } = construirItemsClasificados();
    if (avisosDivision.length) {
      const ok = confirm(
        `Aviso de clasificación Almacén / Planta:\n\n• ${avisosDivision.join("\n• ")}\n\n¿Confirmar la nota con esta clasificación?`
      );
      if (!ok) return;
    }

    const totalUsd = Number(
      itemsFinales.reduce((acc, it) => acc + it.cantidad * it.precioUsd, 0).toFixed(2)
    );
    const usadoFavor = Math.min(saldoFavorDisponible, totalUsd);
    const objetivoHoy = Math.max(0, Number((totalUsd - (usarSaldoFavorEnNota ? usadoFavor : 0)).toFixed(2)));
    const descuentoAplicado = usarSaldoFavorEnNota ? usadoFavor : 0;
    const tasas = getTasaActiva(state);

    let pagosValidos = pagos
      .filter((p) => Number(p.montoUsd) > 0)
      .map((p) => ({
        metodo: p.metodo,
        montoUsd: Number(Number(p.montoUsd).toFixed(2)),
        montoBs: tasas.bcvActiva ? Number((Number(p.montoUsd) * tasas.bcvActiva).toFixed(2)) : 0,
        referencia: String(p.referencia || "").trim()
      }));

    const totalEntregadoHoy = Number(pagosValidos.reduce((acc, p) => acc + p.montoUsd, 0).toFixed(2));
    const restanteHoy = Math.max(0, Number((objetivoHoy - totalEntregadoHoy).toFixed(2)));
    const excedente = Math.max(0, Number((totalEntregadoHoy - objetivoHoy).toFixed(2)));

    const vueltoEntregadoUsd = excedente > 0.01 && modoExcedente === "vuelto" ? excedente : 0;
    const sobrepagoGenerado = excedente > 0.01 && modoExcedente === "favor" ? excedente : 0;

    const docCli = normalizarIdVE(docEl.value) || "V-00000000";
    const nomCli = nomEl.value.trim() || "Consumidor Final";

    if (!esCredito && restanteHoy > 0.01) {
      return alert(`Faltan $${restanteHoy.toFixed(2)} por cubrir en Formas de Pago. Completa el pago o cambia la condición a Crédito.`);
    }
    if (sobrepagoGenerado > 0.01 && docCli === "V-00000000") {
      return alert(`Para dejar +$${sobrepagoGenerado.toFixed(2)} como Saldo a Favor debes ingresar la Cédula/RIF real del cliente (o selecciona "Entregar Vuelto").`);
    }
    if (esCredito && restanteHoy > 0.01 && docCli === "V-00000000") {
      return alert("Para emitir una nota a Crédito debes ingresar la Cédula o RIF del cliente.");
    }

    if (esCredito && limiteCreditoCliente > 0 && (deudaActualCliente + restanteHoy) > limiteCreditoCliente + 0.01) {
      const proyectada = Number((deudaActualCliente + restanteHoy).toFixed(2));
      if (!confirm(`⚠️ ${nomCli} supera su límite de crédito ($${limiteCreditoCliente.toFixed(2)}).\nSu deuda total quedaría en $${proyectada.toFixed(2)}.\n\n¿Autorizar y emitir esta nota de todas formas?`)) {
        return;
      }
    }

    if (vueltoEntregadoUsd > 0.01 && pagosValidos.length) {
      let porRestar = vueltoEntregadoUsd;
      const ordenIndices = pagosValidos
        .map((p, idx) => ({ idx, esEfectivo: p.metodo.toLowerCase().includes("efectivo") }))
        .sort((a, b) => Number(b.esEfectivo) - Number(a.esEfectivo))
        .map((x) => x.idx);

      for (const i of ordenIndices) {
        if (porRestar <= 0.005) break;
        const desc = Math.min(pagosValidos[i].montoUsd, porRestar);
        pagosValidos[i].recibidoUsd = pagosValidos[i].montoUsd;
        pagosValidos[i].montoUsd = Number((pagosValidos[i].montoUsd - desc).toFixed(2));
        pagosValidos[i].montoBs = tasas.bcvActiva ? Number((pagosValidos[i].montoUsd * tasas.bcvActiva).toFixed(2)) : 0;
        porRestar = Number((porRestar - desc).toFixed(2));
      }
    }

    emitiendo = true;
    const btn = root.querySelector("#btnEmitirNota");
    btn.disabled = true;
    btn.textContent = "Guardando venta...";

    try {
      const costoTotalUsd = Number(
        itemsFinales.reduce((acc, it) => acc + it.cantidad * (it.costoUsd || 0), 0).toFixed(2)
      );
      const utilidadUsd = Number((totalUsd - costoTotalUsd).toFixed(2));
      const saldoPendienteUsd = esCredito ? restanteHoy : 0;

      const monedas = ["USD", "BS"];
      if (pagosValidos.some((p) => p.metodo.toLowerCase().includes("usdt"))) {
        monedas.push("USDT");
      }

      const now = Date.now();
      const fechaHoyLocal = obtenerFechaLocalIso(now);
      const jornadaId = state.empresa?.jornadaActivaId || fechaHoyLocal;
      const cotIdAEliminar = cotizacionOrigenId;

      const { nuevoNum, cambiosStock } = await runTransaction(db, async (tx) => {
        // 1. TODAS las lecturas primero
        const empSnap = await tx.get(refs.empresaRef);
        const actual = Number(empSnap.data()?.correlativos?.notaEntregaActual || 0);
        const sigNum = actual + 1;
        const sigFolio = String(sigNum).padStart(5, "0");

        let cliFavorActual = 0;
        if (docCli !== "V-00000000") {
          const cliSnap = await tx.get(doc(refs.clientes(), docCli));
          cliFavorActual = Number(cliSnap.data()?.saldoAFavorUsd || 0);
        }

        const deltasPorProd = new Map();
        for (const it of itemsFinales) {
          const pid = it.prodId || it.id;
          if (!pid) continue;
          const cant = Number(it.cantidad || 0);
          if (cant <= 0) continue;
          const acc = deltasPorProd.get(pid) || { almacen: 0, planta: 0 };
          if (it.origen === "almacen") acc.almacen += cant;
          else acc.planta += cant;
          deltasPorProd.set(pid, acc);
        }

        const prodSnaps = new Map();
        for (const pid of deltasPorProd.keys()) {
          prodSnaps.set(pid, await tx.get(doc(refs.catalogo(), pid)));
        }

        // 2. TODAS las escrituras después
        tx.set(doc(refs.notasEntrega(), sigFolio), {
          folio: sigFolio,
          numero: sigNum,
          fechaIso: fechaHoyLocal,
          jornadaId,
          cierreId: null,
          anulada: false,
          creadoTs: now,
          cliente: { documento: docCli, nombre: nomCli },
          items: itemsFinales,
          pagos: pagosValidos,
          vueltoEntregadoUsd,
          saldoFavorAplicadoUsd: descuentoAplicado,
          saldoFavorDejadoAparte: !usarSaldoFavorEnNota && saldoFavorDisponible > 0.01,
          sobrepagoUsd: sobrepagoGenerado,
          esCredito: esCredito && saldoPendienteUsd > 0.01,
          diasCredito: esCredito ? diasCredito : 0,
          venceTs: esCredito ? now + diasCredito * 86400000 : now,
          saldoPendienteUsd,
          totalUsd,
          costoTotalUsd,
          utilidadUsd,
          multiplicador: factorActual,
          tasaBcvUsada: tasas.bcvActiva,
          monedas,
          usuario: state.sesion.usuario || "Administrador",
          creadoEn: serverTimestamp()
        });

        tx.set(refs.empresaRef, { correlativos: { notaEntregaActual: sigNum } }, { merge: true });

        if (docCli !== "V-00000000") {
          const nuevoSaldoFavorCli = Math.max(
            0,
            Number((cliFavorActual - descuentoAplicado + sobrepagoGenerado).toFixed(2))
          );
          tx.set(
            doc(refs.clientes(), docCli),
            {
              documento: docCli,
              nombre: nomCli,
              saldoAFavorUsd: nuevoSaldoFavorCli,
              ultimoMultiplicador: factorActual,
              actualizadoEn: serverTimestamp()
            },
            { merge: true }
          );
        }

        const stockActualizado = [];
        for (const [pid, delta] of deltasPorProd.entries()) {
          const pData = prodSnaps.get(pid)?.data() || {};
          const updateProd = { ultimaVentaTs: now };
          const patchLocal = { id: pid };
          if (delta.almacen > 0) {
            const nuevoAlm = Math.max(0, Number(pData.stockAlmacen || 0) - delta.almacen);
            updateProd.stockAlmacen = nuevoAlm;
            patchLocal.stockAlmacen = nuevoAlm;
          }
          if (delta.planta > 0) {
            const nuevoPla = Math.max(0, Number(pData.stockPlanta || 0) - delta.planta);
            updateProd.stockPlanta = nuevoPla;
            updateProd.pedidosPlantaCount = increment(delta.planta);
            patchLocal.stockPlanta = nuevoPla;
          }
          tx.set(doc(refs.catalogo(), pid), updateProd, { merge: true });
          stockActualizado.push(patchLocal);
        }

        if (cotIdAEliminar) {
          tx.delete(doc(refs.cotizaciones(), cotIdAEliminar));
        }

        return { folio: sigFolio, nuevoNum: sigNum, cambiosStock: stockActualizado };
      });

      state.parchearStockCatalogo?.(cambiosStock);

      if (docCli !== "V-00000000") {
        const cliEx = clientes.find((c) => c.id === docCli);
        if (cliEx) {
          cliEx.nombre = nomCli;
          cliEx.ultimoMultiplicador = factorActual;
        } else {
          clientes.push({
            id: docCli,
            documento: docCli,
            nombre: nomCli,
            ultimoMultiplicador: factorActual
          });
        }
      }

      ultimoFolio = nuevoNum;
      if (state.empresa?.correlativos) state.empresa.correlativos.notaEntregaActual = nuevoNum;
      actualizarFolioUI();

      if (typeof window.NEXUS_VE_REFRESH_ALERTAS === "function") {
        await window.NEXUS_VE_REFRESH_ALERTAS();
      }

      limpiarCaja();

      if (typeof window.NEXUS_VE_NAV === "function") {
        window.NEXUS_VE_NAV("inventario-planta");
      }
    } catch (err) {
      alert("Error emitiendo Nota de Entrega: " + err.message);
    } finally {
      emitiendo = false;
      if (root.isConnected) {
        btn.disabled = false;
        btn.textContent = "Confirmar Venta y Ver Notas (F9)";
      }
    }
  }

  root.querySelector("#btnEmitirNota").addEventListener("click", emitirNota);

  if (window.__vePosKeyHandler) {
    window.removeEventListener("keydown", window.__vePosKeyHandler);
  }
  window.__vePosKeyHandler = (e) => {
    if (state.rutaActual !== "caja-pos" || !root.isConnected) return;
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
  window.addEventListener("keydown", window.__vePosKeyHandler);

  if (window.__vePosTasaHandler) {
    window.removeEventListener("ve-tasa-changed", window.__vePosTasaHandler);
  }
  window.__vePosTasaHandler = () => {
    if (state.rutaActual !== "caja-pos" || !root.isConnected) return;
    refrescarEstadoClienteActual();
    renderTotalesYRestante();
  };
  window.addEventListener("ve-tasa-changed", window.__vePosTasaHandler);

  busqEl.addEventListener("input", () => {
    busqAbierta = Boolean(busqEl.value.trim());
    renderBusqueda();
  });

  actualizarFolioUI();
  const [listaCat, snapCli, snapDeudas] = await Promise.all([
    typeof state.obtenerCatalogo === "function"
      ? state.obtenerCatalogo()
      : getDocs(refs.catalogo()).then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))),
    getDocs(refs.clientes()),
    getDocs(query(refs.notasEntrega(), where("saldoPendienteUsd", ">", 0)))
  ]);

  if (!root.isConnected) return;

  catalogo = listaCat;
  clientes = snapCli.docs.map((d) => ({ id: d.id, ...d.data() }));
  deudasActivas = snapDeudas.docs.map((d) => ({ id: d.id, ...d.data() }));

  resEl.innerHTML = `<div class="text-xs text-slate-400 text-center py-6">Escribe o toca "Disponibles" para agregar repuestos con stock...</div>`;

  if (state.cotizacionPendiente) {
    const cot = state.cotizacionPendiente;
    state.cotizacionPendiente = null;
    cotizacionOrigenId = cot.id || cot.folio || null;
    docEl.value = cot.cliente?.documento || "";
    nomEl.value = cot.cliente?.nombre || "";

    const docNormCot = normalizarIdVE(docEl.value);
    if (docNormCot && docNormCot !== "V-00000000") {
      ultimoClienteAplicadoId = docNormCot;
    }

    if (cot.multiplicador) {
      aplicarFactorPos(cot.multiplicador, true, false);
    }

    const alertasCosto = [];
    carrito = (cot.items || []).map((it) => {
      const prod = catalogo.find(
        (x) => x.id === it.prodId || x.id === it.id || x.codigo === it.codigo
      );
      const costoPrevio = Number(it.costoUsd || 0);
      const costoActual = prod ? Number(prod.costoUsd || 0) : costoPrevio;
      if (prod && costoPrevio > 0 && costoActual > costoPrevio + 0.009) {
        alertasCosto.push(
          `<strong>${it.codigo || prod.codigo}</strong>: costo $${costoPrevio.toFixed(2)} → $${costoActual.toFixed(2)} (precio cotizado: $${Number(it.precioUsd || 0).toFixed(2)})`
        );
      }
      const dispAlm = Math.max(0, Number(prod?.stockAlmacen || 0));
      const origenActualizado = dispAlm > 0 ? "almacen" : (it.origen || "planta");
      return {
        ...it,
        id: prod?.id || it.prodId || it.id,
        prodId: prod?.id || it.prodId || it.id,
        costoUsd: costoActual,
        origen: origenActualizado
      };
    });

    if (alertasCosto.length) {
      root.querySelector("#txtAvisoCostoCotizacion").innerHTML = alertasCosto.join("<br>");
      root.querySelector("#avisoCostoCotizacion").classList.remove("hidden");
    }

    refrescarEstadoClienteActual();
  }

  renderCarrito();
}
