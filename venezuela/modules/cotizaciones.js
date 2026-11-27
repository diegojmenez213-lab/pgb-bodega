// venezuela/modules/cotizaciones.js
import {
  db,
  getTenantRefs,
  doc,
  getDocs,
  deleteDoc,
  runTransaction,
  normalizarIdVE,
  serverTimestamp,
  obtenerFechaLocalIso
} from "../core/db.js";
import { abrirDocumentoPDF } from "./documentos-pdf.js";

function getTasaActiva(state) {
  const t = state.tasas || {};
  const bcv = state.modoTasaBCV === "manana" && t.bcvManana ? t.bcvManana : t.bcvHoy;
  return { ...t, bcvActiva: Number(bcv || 0) };
}

function parseMultiplicadorTexto(raw) {
  const limpio = String(raw || "").replace(",", ".").trim();
  if (!limpio || limpio === "." || limpio.endsWith(".")) return null;
  const num = Number(limpio);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
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

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);
  const fMayor = Number(state.empresa?.precios?.factorMayor) || 2.0;
  const fDetal = Number(state.empresa?.precios?.factorDetal) || 2.5;

  root.innerHTML = `
    <div class="space-y-4 max-w-7xl mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Cotizaciones</h1>
          <p class="text-xs text-slate-500">Genera presupuestos en PDF y conviértelos en Nota de Entrega con un clic.</p>
        </div>
        <div class="text-xs font-extrabold px-3 py-1.5 rounded-xl bg-slate-100 text-slate-700 font-mono-ve">
          Próxima Cotización: #<span id="nextCotFolioTxt">---</span>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div class="lg:col-span-7 space-y-3">
          <div id="boxClienteCot" class="ve-card p-3 space-y-2 relative">
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input id="cotCliDoc" type="text" autocomplete="off" placeholder="Cédula / RIF" class="bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold uppercase" />
              <input id="cotCliNom" type="text" autocomplete="off" placeholder="Nombre / Razón Social" class="bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold" />
              <div class="flex gap-1.5">
                <select id="cotTarifa" class="flex-1 bg-slate-50 border border-slate-300 rounded-xl px-2.5 py-2 text-xs font-bold">
                  <option value="detal">Detal (×${fDetal})</option>
                  <option value="mayor">Mayor (×${fMayor})</option>
                  <option value="custom">Mult.</option>
                </select>
                <input
                  id="cotMult"
                  type="text"
                  inputmode="decimal"
                  value="${fDetal}"
                  title="Multiplicador libre sobre costo"
                  class="w-20 bg-white border border-slate-300 rounded-xl px-2 py-2 text-xs font-mono-ve font-extrabold text-center"
                />
              </div>
            </div>
            <div id="sugerenciasCliCot" class="hidden bg-white border border-slate-300 rounded-xl shadow-lg max-h-44 overflow-y-auto divide-y divide-slate-100"></div>
          </div>

          <div class="ve-card p-3 space-y-2">
            <div class="flex items-center gap-2">
              <input id="cotBusq" type="text" placeholder="Buscar producto disponible (Almacén o Planta)..." class="flex-1 bg-slate-50 border border-slate-300 rounded-xl px-3 py-2.5 text-xs font-bold outline-none focus:border-slate-950" />
              <button id="btnToggleBusqCot" type="button" class="px-3 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-extrabold cursor-pointer shrink-0">
                Disponibles
              </button>
            </div>
            <div id="cotResultados" class="space-y-1.5 max-h-72 overflow-y-auto">
              <div class="text-xs text-slate-400 text-center py-6">Escribe o toca "Disponibles" para agregar repuestos...</div>
            </div>
          </div>
        </div>

        <div class="lg:col-span-5 space-y-3">
          <div class="ve-card space-y-3">
            <div class="flex items-center justify-between">
              <h2 class="text-sm font-extrabold text-slate-900">Ítems Cotizados (<span id="cotCantItemsBadge">0</span> und)</h2>
              <button id="btnLimpiarCot" type="button" class="text-[11px] font-bold text-rose-600 cursor-pointer">Limpiar</button>
            </div>

            <div id="cotCarrito" class="space-y-2 max-h-72 overflow-y-auto">
              <div class="text-xs text-slate-400 text-center py-6">Sin productos en la cotización.</div>
            </div>

            <div class="pt-3 border-t border-slate-200 space-y-1">
              <div class="flex justify-between text-base font-extrabold text-slate-950">
                <span>TOTAL USD</span>
                <span id="cotTotalUsd" class="font-mono-ve">$0.00</span>
              </div>
              <div class="flex justify-between text-xs font-bold text-slate-500">
                <span>Total Bs. (BCV)</span>
                <span id="cotTotalBs" class="font-mono-ve">Bs. 0.00</span>
              </div>
            </div>

            <button id="btnGuardarCot" type="button" class="w-full py-3.5 rounded-2xl bg-slate-950 hover:bg-slate-800 text-white text-xs font-extrabold uppercase tracking-wider cursor-pointer">
              Guardar Cotización y Generar PDF
            </button>
          </div>
        </div>
      </div>

      <div class="space-y-2.5 pt-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-sm font-extrabold text-slate-900">Cotizaciones Guardadas</h2>
          <input id="busqCotGuardadas" type="text" placeholder="Buscar cotización..." class="bg-white border border-slate-300 rounded-xl px-3 py-1.5 text-xs font-bold" />
        </div>
        <div id="listaCotizaciones" class="space-y-2">
          <div class="ve-card text-center py-8 text-xs text-slate-500 font-bold">Cargando cotizaciones...</div>
        </div>
      </div>
    </div>
  `;

  let catalogo = [];
  let clientes = [];
  let cotizaciones = [];
  let carrito = [];
  let factorActual = fDetal;
  let ultimoFolioCot = Number(state.empresa?.correlativos?.cotizacionActual || 0);
  let busqAbierta = false;
  let guardando = false;
  let ultimoClienteAplicadoId = "";

  const docEl = root.querySelector("#cotCliDoc");
  const nomEl = root.querySelector("#cotCliNom");
  const sugCliEl = root.querySelector("#sugerenciasCliCot");
  const tarifaEl = root.querySelector("#cotTarifa");
  const multEl = root.querySelector("#cotMult");
  const busqEl = root.querySelector("#cotBusq");
  const resEl = root.querySelector("#cotResultados");
  const cartEl = root.querySelector("#cotCarrito");

  function actualizarFolioUI() {
    root.querySelector("#nextCotFolioTxt").textContent = String(ultimoFolioCot + 1).padStart(5, "0");
  }

  function sincronizarSelectTarifaConFactor(val) {
    if (Math.abs(val - fMayor) < 0.001) tarifaEl.value = "mayor";
    else if (Math.abs(val - fDetal) < 0.001) tarifaEl.value = "detal";
    else tarifaEl.value = "custom";
  }

  function aplicarFactorCot(nuevoFactor, sincronizarInput = false) {
    const val = parseMultiplicadorTexto(nuevoFactor);
    if (val === null) return;
    factorActual = val;
    if (sincronizarInput) {
      multEl.value = String(val);
      sincronizarSelectTarifaConFactor(val);
    }
    if (carrito.length) {
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

      aplicarFactorCot(fCli, true);
    }
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
        <button type="button" class="btn-pick-cli-cot w-full text-left px-3 py-2 text-xs hover:bg-slate-100 flex items-center justify-between gap-2 cursor-pointer" data-clid="${encodeURIComponent(c.id)}">
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
    const btn = e.target.closest(".btn-pick-cli-cot");
    if (!btn) return;
    const clid = decodeURIComponent(btn.dataset.clid || "");
    const cli = clientes.find((c) => c.id === clid);
    sugCliEl.classList.add("hidden");
    if (cli) aplicarClienteDetectado(cli, { rellenarDoc: true, rellenarNom: true, forzar: true });
  });

  root.addEventListener("click", (e) => {
    if (!e.target.closest("#boxClienteCot")) {
      sugCliEl.classList.add("hidden");
    }
  });

  function buscarClientePorNombreExacto(texto) {
    const norm = normalizarBusquedaTexto(texto);
    if (!norm || norm.length < 3) return null;
    return clientes.find((c) => normalizarBusquedaTexto(c.nombre || "") === norm) || null;
  }

  docEl.addEventListener("input", () => {
    renderSugerenciasCliente(docEl.value);
    const id = normalizarIdVE(docEl.value);
    const cli = clientes.find((c) => c.id === id);
    if (cli) {
      aplicarClienteDetectado(cli, { rellenarDoc: false, rellenarNom: true, forzar: false });
      sugCliEl.classList.add("hidden");
    } else {
      ultimoClienteAplicadoId = "";
    }
  });

  docEl.addEventListener("blur", () => {
    const id = normalizarIdVE(docEl.value);
    const cli = clientes.find((c) => c.id === id);
    if (cli) aplicarClienteDetectado(cli, { rellenarDoc: true, rellenarNom: true, forzar: false });
  });

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
    if (tarifaEl.value === "mayor") aplicarFactorCot(fMayor, true);
    else if (tarifaEl.value === "detal") aplicarFactorCot(fDetal, true);
    else multEl.focus();
  });

  multEl.addEventListener("input", () => {
    tarifaEl.value = "custom";
    aplicarFactorCot(multEl.value, false);
  });

  multEl.addEventListener("blur", () => {
    const val = parseMultiplicadorTexto(multEl.value);
    if (val !== null) {
      multEl.value = String(val);
      sincronizarSelectTarifaConFactor(val);
      aplicarFactorCot(val, false);
    } else {
      multEl.value = String(factorActual);
    }
  });

  function renderTotales() {
    const total = carrito.reduce((acc, it) => acc + it.cantidad * it.precioUsd, 0);
    const tasas = getTasaActiva(state);
    root.querySelector("#cotTotalUsd").textContent = `$${total.toFixed(2)}`;
    root.querySelector("#cotTotalBs").textContent = tasas.bcvActiva ? `Bs. ${(total * tasas.bcvActiva).toFixed(2)}` : "Bs. --";
    root.querySelector("#cotCantItemsBadge").textContent = String(
      carrito.reduce((acc, it) => acc + Number(it.cantidad || 0), 0)
    );
  }

  function renderCarrito() {
    if (!carrito.length) {
      cartEl.innerHTML = `<div class="text-xs text-slate-400 text-center py-6">Sin productos en la cotización.</div>`;
    } else {
      cartEl.innerHTML = carrito.map((it, idx) => `
        <div class="p-2.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2" data-cidx="${idx}">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="font-mono-ve text-[11px] font-extrabold text-slate-900">${it.codigo}</div>
              <div class="text-[11px] font-semibold text-slate-600 truncate">${it.descripcion}</div>
            </div>
            <button type="button" class="btn-rm-cot text-xs font-bold text-rose-600 cursor-pointer px-1.5">✕</button>
          </div>
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-1">
              <button type="button" class="btn-menos-cot w-7 h-7 rounded-lg bg-white border border-slate-300 text-xs font-extrabold cursor-pointer">−</button>
              <input type="number" min="1" value="${it.cantidad}" class="inp-cant-cot w-14 h-7 bg-white border border-slate-300 rounded-lg px-1 text-xs font-extrabold text-center font-mono-ve" />
              <button type="button" class="btn-mas-cot w-7 h-7 rounded-lg bg-slate-950 text-white text-xs font-extrabold cursor-pointer">+</button>
            </div>
            <div class="flex items-center gap-1">
              <span class="text-[10px] font-bold text-slate-500">$</span>
              <input type="text" inputmode="numeric" value="${Number(it.precioUsd).toFixed(2)}" class="inp-prec-cot w-20 h-7 bg-white border border-slate-300 rounded-lg px-1.5 text-xs font-bold text-right font-mono-ve" />
            </div>
            <div class="item-sub-cot font-mono-ve text-xs font-extrabold text-slate-900">$${(it.cantidad * it.precioUsd).toFixed(2)}</div>
          </div>
        </div>
      `).join("");
    }
    renderTotales();
  }

  function renderBusqueda() {
    const q = busqEl.value.trim();
    if (!q && !busqAbierta) {
      resEl.innerHTML = `<div class="text-xs text-slate-400 text-center py-6">Escribe o toca "Disponibles" para agregar repuestos...</div>`;
      return;
    }

    const disponibles = catalogo.filter((p) => cumpleFiltroEstricto(p, q)).slice(0, 25);
    if (!disponibles.length) {
      resEl.innerHTML = `<div class="text-xs text-slate-500 font-bold text-center py-6">No disponible / Sin stock en Almacén ni en Planta.</div>`;
      return;
    }

    resEl.innerHTML = disponibles.map((p) => {
      const dispAlm = Math.max(0, Number(p.stockAlmacen || 0));
      const dispPla = Math.max(0, Number(p.stockPlanta || 0));
      const precio = Number(((p.costoUsd || 0) * factorActual).toFixed(2));
      return `
        <div class="p-2.5 rounded-xl border border-slate-200 hover:bg-slate-50 flex items-center justify-between gap-2 cursor-pointer select-none" data-pid="${encodeURIComponent(p.id)}">
          <div class="min-w-0 flex-1 pointer-events-none">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="font-mono-ve text-xs font-extrabold text-slate-900">${p.codigo}</span>
              ${dispAlm > 0
                ? `<span class="text-[9px] font-extrabold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800">Almacén: ${dispAlm}</span>`
                : `<span class="text-[9px] font-extrabold px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-900">Planta: ${dispPla}</span>`}
              ${p.proveedor ? `<span class="text-[9px] font-bold text-slate-400">${p.proveedor}</span>` : ""}
            </div>
            <div class="text-[11px] font-semibold text-slate-600 truncate mt-0.5">${p.descripcion}</div>
          </div>
          <button type="button" class="px-3 py-1.5 rounded-xl bg-slate-950 text-white text-xs font-extrabold cursor-pointer shrink-0">+ $${precio.toFixed(2)}</button>
        </div>
      `;
    }).join("");
  }

  root.querySelector("#btnToggleBusqCot").addEventListener("click", () => {
    busqAbierta = !busqAbierta;
    renderBusqueda();
  });

  busqEl.addEventListener("input", () => {
    busqAbierta = Boolean(busqEl.value.trim());
    renderBusqueda();
  });

  resEl.addEventListener("click", (e) => {
    const row = e.target.closest("[data-pid]");
    if (!row) return;
    const prodId = decodeURIComponent(row.dataset.pid || "");
    const p = catalogo.find((x) => x.id === prodId);
    if (!p) return;

    const dispAlm = Math.max(0, Number(p.stockAlmacen || 0));
    const origenInicial = dispAlm > 0 ? "almacen" : "planta";
    const ex = carrito.find((x) => x.prodId === p.id);
    if (ex) {
      ex.cantidad += 1;
    } else {
      carrito.push({
        id: p.id,
        prodId: p.id,
        codigo: p.codigo || p.id,
        descripcion: p.descripcion || p.codigo || p.id,
        proveedor: p.proveedor || "",
        costoUsd: Number(p.costoUsd || 0),
        precioUsd: Number(((p.costoUsd || 0) * factorActual).toFixed(2)),
        cantidad: 1,
        origen: origenInicial
      });
    }
    busqAbierta = false;
    busqEl.value = "";
    renderBusqueda();
    renderCarrito();
  });

  cartEl.addEventListener("focusin", (e) => {
    if (e.target.classList.contains("inp-prec-cot")) fijarCursorAlFinal(e.target);
  });

  cartEl.addEventListener("input", (e) => {
    const row = e.target.closest("[data-cidx]");
    if (!row) return;
    const idx = Number(row.dataset.cidx);
    if (e.target.classList.contains("inp-cant-cot")) {
      carrito[idx].cantidad = Math.max(1, parseInt(e.target.value, 10) || 1);
    } else if (e.target.classList.contains("inp-prec-cot")) {
      carrito[idx].precioUsd = formatearEntradaMoneda(e.target);
    }
    const sub = row.querySelector(".item-sub-cot");
    if (sub) sub.textContent = `$${(carrito[idx].cantidad * carrito[idx].precioUsd).toFixed(2)}`;
    renderTotales();
  });

  cartEl.addEventListener("click", (e) => {
    if (e.target.classList.contains("inp-prec-cot")) {
      fijarCursorAlFinal(e.target);
      return;
    }
    const row = e.target.closest("[data-cidx]");
    if (!row) return;
    const idx = Number(row.dataset.cidx);
    if (e.target.closest(".btn-rm-cot")) {
      carrito.splice(idx, 1);
      renderCarrito();
    } else if (e.target.closest(".btn-mas-cot")) {
      carrito[idx].cantidad += 1;
      renderCarrito();
    } else if (e.target.closest(".btn-menos-cot")) {
      if (carrito[idx].cantidad > 1) carrito[idx].cantidad -= 1;
      else carrito.splice(idx, 1);
      renderCarrito();
    }
  });

  root.querySelector("#btnLimpiarCot").addEventListener("click", () => {
    carrito = [];
    ultimoClienteAplicadoId = "";
    sugCliEl.classList.add("hidden");
    renderCarrito();
  });

  root.querySelector("#btnGuardarCot").addEventListener("click", async () => {
    if (guardando) return;
    if (!carrito.length) return alert("Agrega al menos un producto a la cotización.");

    const docCli = normalizarIdVE(docEl.value) || "V-00000000";
    const nomCli = nomEl.value.trim() || "Consumidor Final";
    const totalUsd = Number(carrito.reduce((acc, it) => acc + it.cantidad * it.precioUsd, 0).toFixed(2));
    const tasas = getTasaActiva(state);
    const now = Date.now();
    const fechaLocalHoy = obtenerFechaLocalIso(now);

    guardando = true;
    const btn = root.querySelector("#btnGuardarCot");
    btn.disabled = true;
    btn.textContent = "Guardando...";

    try {
      const { cotGuardada, nuevoNum } = await runTransaction(db, async (tx) => {
        // 1. Lectura primero
        const empSnap = await tx.get(refs.empresaRef);
        const actual = Number(empSnap.data()?.correlativos?.cotizacionActual || 0);
        const sigNum = actual + 1;
        const sigFolio = String(sigNum).padStart(5, "0");

        const payload = {
          id: sigFolio,
          folio: sigFolio,
          numero: sigNum,
          fechaIso: fechaLocalHoy,
          creadoTs: now,
          cliente: { documento: docCli, nombre: nomCli },
          items: carrito,
          totalUsd,
          multiplicador: factorActual,
          tasaBcvUsada: tasas.bcvActiva,
          monedas: ["USD", "BS"],
          usuario: state.sesion.usuario || "Administrador",
          creadoEn: serverTimestamp()
        };

        // 2. Escrituras después
        tx.set(doc(refs.cotizaciones(), sigFolio), payload);
        tx.set(refs.empresaRef, { correlativos: { cotizacionActual: sigNum } }, { merge: true });

        if (docCli !== "V-00000000") {
          tx.set(
            doc(refs.clientes(), docCli),
            {
              documento: docCli,
              nombre: nomCli,
              ultimoMultiplicador: factorActual,
              actualizadoEn: serverTimestamp()
            },
            { merge: true }
          );
        }

        return { cotGuardada: payload, nuevoNum: sigNum };
      });

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

      ultimoFolioCot = nuevoNum;
      if (state.empresa?.correlativos) state.empresa.correlativos.cotizacionActual = nuevoNum;
      actualizarFolioUI();

      carrito = [];
      ultimoClienteAplicadoId = "";
      renderCarrito();
      await cargarCotizaciones();
      abrirDocumentoPDF("cotizacion", cotGuardada, state);
    } catch (err) {
      alert("Error guardando cotización: " + err.message);
    } finally {
      guardando = false;
      btn.disabled = false;
      btn.textContent = "Guardar Cotización y Generar PDF";
    }
  });

  function renderListaCotizaciones() {
    const q = root.querySelector("#busqCotGuardadas").value.trim().toLowerCase();
    const cont = root.querySelector("#listaCotizaciones");

    const filtradas = cotizaciones.filter((c) => {
      if (!q) return true;
      return `${c.folio || ""} ${c.cliente?.nombre || ""} ${c.cliente?.documento || ""}`.toLowerCase().includes(q);
    });

    if (!filtradas.length) {
      cont.innerHTML = `<div class="ve-card text-center py-8 text-xs text-slate-500 font-bold">No hay cotizaciones guardadas.</div>`;
      return;
    }

    cont.innerHTML = filtradas.map((c) => `
      <div class="ve-card p-3.5 flex flex-wrap items-center justify-between gap-2" data-cotid="${c.id}">
        <div>
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-mono-ve text-xs font-extrabold text-slate-950">#${c.folio || c.id}</span>
            <span class="text-[10px] font-bold text-slate-500">${c.fechaIso || "---"}</span>
            ${c.multiplicador ? `<span class="text-[10px] font-mono-ve font-extrabold px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">×${c.multiplicador}</span>` : ""}
          </div>
          <div class="text-xs font-extrabold text-slate-800 mt-0.5">${c.cliente?.nombre || "Consumidor Final"} (${c.cliente?.documento || "---"})</div>
        </div>
        <div class="flex items-center gap-2">
          <div class="text-right mr-1">
            <div class="font-mono-ve text-sm font-extrabold text-slate-950">$${Number(c.totalUsd || 0).toFixed(2)}</div>
            <div class="font-mono-ve text-[10px] text-slate-500">${(c.items || []).length} ítem(s)</div>
          </div>
          <button type="button" class="btn-conv-cot px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold cursor-pointer">
            Facturar →
          </button>
          <button type="button" class="btn-pdf-cot px-3 py-1.5 rounded-xl bg-slate-950 hover:bg-slate-800 text-white text-xs font-extrabold cursor-pointer">
            PDF
          </button>
          <button type="button" class="btn-del-cot px-2.5 py-1.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-bold cursor-pointer">
            ✕
          </button>
        </div>
      </div>
    `).join("");
  }

  root.querySelector("#listaCotizaciones").addEventListener("click", async (e) => {
    const card = e.target.closest("[data-cotid]");
    if (!card) return;
    const cot = cotizaciones.find((x) => x.id === card.dataset.cotid);
    if (!cot) return;

    if (e.target.closest(".btn-conv-cot")) {
      state.cotizacionPendiente = cot;
      if (typeof window.NEXUS_VE_NAV === "function") {
        window.NEXUS_VE_NAV("caja-pos");
      }
    } else if (e.target.closest(".btn-pdf-cot")) {
      abrirDocumentoPDF("cotizacion", cot, state);
    } else if (e.target.closest(".btn-del-cot")) {
      if (!confirm(`¿Eliminar la cotización #${cot.folio || cot.id}?`)) return;
      await deleteDoc(doc(refs.cotizaciones(), cot.id));
      await cargarCotizaciones();
    }
  });

  root.querySelector("#busqCotGuardadas").addEventListener("input", renderListaCotizaciones);

  if (window.__veCotTasaHandler) {
    window.removeEventListener("ve-tasa-changed", window.__veCotTasaHandler);
  }
  window.__veCotTasaHandler = () => {
    if (state.rutaActual !== "cotizaciones") return;
    renderTotales();
  };
  window.addEventListener("ve-tasa-changed", window.__veCotTasaHandler);

  async function cargarCotizaciones() {
    const snap = await getDocs(refs.cotizaciones());
    cotizaciones = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => Number(b.creadoTs || 0) - Number(a.creadoTs || 0));
    renderListaCotizaciones();
  }

  actualizarFolioUI();
  const [snapCat, snapCli] = await Promise.all([
    getDocs(refs.catalogo()),
    getDocs(refs.clientes())
  ]);
  catalogo = snapCat.docs.map((d) => ({ id: d.id, ...d.data() }));
  clientes = snapCli.docs.map((d) => ({ id: d.id, ...d.data() }));
  await cargarCotizaciones();
  renderCarrito();
}
