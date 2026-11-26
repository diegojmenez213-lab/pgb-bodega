// venezuela/modules/cotizaciones.js
import {
  getTenantRefs,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  normalizarIdVE,
  serverTimestamp
} from "../core/db.js";
import { imprimirDocumentoCarta } from "./documentos-pdf.js";

const HORAS_72_MS = 72 * 60 * 60 * 1000;

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

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);
  const fMayor = Number(state.empresa?.precios?.factorMayor) || 2.0;
  const fDetal = Number(state.empresa?.precios?.factorDetal) || 2.5;

  root.innerHTML = `
    <div class="space-y-4 max-w-6xl mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Cotizaciones (PDF • 72h)</h1>
          <p class="text-xs text-slate-500">Usa tarifa Detal, Mayor o escribe cualquier multiplicador sobre costo (ej. 2.3).</p>
        </div>
        <div class="flex gap-1.5">
          <button id="tabNuevaCot" type="button" class="px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-950 text-white cursor-pointer">+ Nueva Cotización</button>
          <button id="tabListaCot" type="button" class="px-3 py-1.5 rounded-xl text-xs font-extrabold bg-white border border-slate-200 text-slate-700 cursor-pointer">Activas (<span id="countCot">0</span>)</button>
        </div>
      </div>

      <!-- Nueva Cotización -->
      <section id="viewNuevaCot" class="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div class="lg:col-span-7 space-y-3">
          <div class="ve-card p-3 space-y-2">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input id="cotCliDoc" type="text" placeholder="Cédula / RIF *" class="bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold uppercase" />
              <input id="cotCliNom" type="text" placeholder="Nombre del Cliente *" class="bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold" />
            </div>
            <div class="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div class="flex flex-wrap items-center gap-2 text-xs font-bold">
                <span class="text-slate-500">Tarifa:</span>
                <select id="cotTarifa" class="bg-slate-50 border border-slate-300 rounded-lg px-2 py-1 text-xs font-bold">
                  <option value="detal">Detal (×${fDetal})</option>
                  <option value="mayor">Mayor (×${fMayor})</option>
                  <option value="custom">Personalizado</option>
                </select>
                <span class="text-slate-500">Mult. (×):</span>
                <input
                  id="cotMult"
                  type="text"
                  inputmode="decimal"
                  value="${fDetal}"
                  class="w-20 bg-white border border-slate-300 rounded-lg px-2 py-1 text-xs font-mono-ve font-extrabold text-center"
                />
              </div>
              <div id="cotCliBadge" class="text-[11px] font-bold text-emerald-700 hidden">✓ Cliente registrado</div>
            </div>
          </div>

          <!-- Buscador de productos -->
          <div class="ve-card p-3 space-y-2">
            <div class="flex items-center gap-2">
              <input id="cotBusqProd" type="text" placeholder="Buscar repuesto por código, descripción o marca..." class="flex-1 bg-slate-50 border border-slate-300 rounded-xl px-3 py-2.5 text-xs font-bold outline-none focus:border-slate-900" />
              <button id="btnToggleBusqCot" type="button" class="px-3 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-extrabold cursor-pointer shrink-0">
                Catálogo
              </button>
            </div>
            <div id="cotResultados" class="space-y-1.5 max-h-72 overflow-y-auto">
              <div class="text-xs text-slate-400 text-center py-4">Escribe o toca "Catálogo" para agregar productos...</div>
            </div>
          </div>
        </div>

        <!-- Carrito Cotización -->
        <div id="cotResumenCard" class="lg:col-span-5">
          <div class="ve-card space-y-3">
            <div class="flex items-center justify-between">
              <h2 class="text-sm font-extrabold text-slate-900">Detalle del Presupuesto (<span id="cotCantItemsBadge">0</span> und)</h2>
              <button id="btnLimpiarCot" type="button" class="text-[11px] font-bold text-rose-600 cursor-pointer">Limpiar</button>
            </div>

            <div id="cotItems" class="space-y-2 max-h-80 overflow-y-auto">
              <div class="text-xs text-slate-400 text-center py-6">Agrega productos desde el buscador.</div>
            </div>

            <div class="pt-3 border-t border-slate-200 space-y-1.5">
              <div class="flex justify-between text-sm font-extrabold text-slate-950">
                <span>TOTAL USD</span>
                <span id="cotTotalUsd" class="font-mono-ve">$0.00</span>
              </div>
              <div class="flex justify-between text-xs font-bold text-slate-500">
                <span>Ref. Bs. (BCV)</span>
                <span id="cotTotalBs" class="font-mono-ve">Bs. 0.00</span>
              </div>
            </div>

            <div class="flex flex-wrap gap-2 text-[11px] font-bold text-slate-600">
              <label class="flex items-center gap-1"><input type="checkbox" class="cot-mon" value="USD" checked /> USD</label>
              <label class="flex items-center gap-1"><input type="checkbox" class="cot-mon" value="BS" checked /> Bs.</label>
              <label class="flex items-center gap-1"><input type="checkbox" class="cot-mon" value="USDT" /> USDT</label>
              <label class="flex items-center gap-1"><input type="checkbox" class="cot-mon" value="EUR" /> EUR</label>
            </div>

            <div class="grid grid-cols-2 gap-2 pt-1">
              <button id="btnGuardarCot" type="button" class="py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-900 text-xs font-extrabold cursor-pointer">
                Guardar 72h
              </button>
              <button id="btnGenerarPdfCot" type="button" class="py-2.5 rounded-xl bg-slate-950 hover:bg-slate-800 text-white text-xs font-extrabold cursor-pointer">
                Generar PDF
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- Lista de Cotizaciones Activas -->
      <section id="viewListaCot" class="hidden space-y-2">
        <div id="listaCotizaciones" class="space-y-2">
          <div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">Cargando cotizaciones...</div>
        </div>
      </section>
    </div>
  `;

  let catalogo = [];
  let clientes = [];
  let cotizaciones = [];
  let carrito = [];
  let factorActual = fDetal;
  let busqAbierta = false;

  const docEl = root.querySelector("#cotCliDoc");
  const nomEl = root.querySelector("#cotCliNom");
  const tarifaEl = root.querySelector("#cotTarifa");
  const multEl = root.querySelector("#cotMult");
  const badgeCli = root.querySelector("#cotCliBadge");
  const busqEl = root.querySelector("#cotBusqProd");
  const resEl = root.querySelector("#cotResultados");
  const itemsEl = root.querySelector("#cotItems");

  function aplicarFactor(nuevoFactor, { sincronizarInput = false, actualizarCarrito = true } = {}) {
    const val = parseMultiplicadorTexto(nuevoFactor);
    if (val === null) return;
    factorActual = val;
    if (sincronizarInput) {
      multEl.value = String(val);
    }
    if (actualizarCarrito && carrito.length) {
      carrito = carrito.map((it) => ({
        ...it,
        precioUsd: Number(((it.costoUsd || 0) * factorActual).toFixed(2))
      }));
      renderCarrito();
    }
    if (busqAbierta || busqEl.value.trim()) renderBusqueda();
  }

  function obtenerMonedas() {
    const arr = Array.from(root.querySelectorAll(".cot-mon:checked")).map((el) => el.value);
    return arr.length ? arr : ["USD"];
  }

  function calcularTotal() {
    return carrito.reduce((acc, it) => acc + it.cantidad * it.precioUsd, 0);
  }

  function agregarProductoCotizacion(prodId, cantAgregar = 1) {
    const p = catalogo.find((x) => x.id === prodId || x.codigo === prodId);
    if (!p) return;
    const sum = Math.max(1, parseInt(cantAgregar, 10) || 1);

    const ex = carrito.find((x) => x.id === p.id);
    if (ex) {
      ex.cantidad += sum;
    } else {
      carrito.push({
        id: p.id,
        codigo: p.codigo || p.id,
        descripcion: p.descripcion || p.codigo || p.id,
        costoUsd: Number(p.costoUsd || 0),
        precioUsd: Number(((p.costoUsd || 0) * factorActual).toFixed(2)),
        cantidad: sum,
        origen: (p.stockAlmacen || 0) > 0 ? "almacen" : "planta"
      });
    }

    renderCarrito();
    busqAbierta = false;
    busqEl.value = "";
    resEl.innerHTML = `<div class="text-xs text-emerald-700 font-bold text-center py-2">✓ Agregado al presupuesto. Toca "Catálogo" o escribe para sumar más.</div>`;
    root.querySelector("#cotResumenCard")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function renderCarrito() {
    const total = calcularTotal();
    const tasas = getTasaActiva(state);
    const totalUnds = carrito.reduce((acc, it) => acc + Number(it.cantidad || 0), 0);
    root.querySelector("#cotCantItemsBadge").textContent = String(totalUnds);
    root.querySelector("#cotTotalUsd").textContent = `$${total.toFixed(2)}`;
    root.querySelector("#cotTotalBs").textContent = tasas.bcvActiva ? `Bs. ${(total * tasas.bcvActiva).toFixed(2)}` : "Bs. --";

    if (!carrito.length) {
      itemsEl.innerHTML = `<div class="text-xs text-slate-400 text-center py-6">Agrega productos desde el buscador.</div>`;
      return;
    }

    itemsEl.innerHTML = carrito.map((it, idx) => `
      <div class="p-2.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2" data-idx="${idx}">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="font-mono-ve text-[11px] font-extrabold text-slate-900">${it.codigo}</div>
            <div class="text-[11px] font-semibold text-slate-600 truncate">${it.descripcion}</div>
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
            <input type="number" step="0.01" min="0" value="${Number(it.precioUsd).toFixed(2)}" class="inp-prec w-20 h-7 bg-white border border-slate-300 rounded-lg px-1.5 text-xs font-bold text-right font-mono-ve" />
          </div>
          <div class="font-mono-ve text-xs font-extrabold text-slate-900">$${(it.cantidad * it.precioUsd).toFixed(2)}</div>
        </div>
      </div>
    `).join("");
  }

  function renderBusqueda() {
    const q = busqEl.value.trim().toLowerCase();
    if (!q && !busqAbierta) {
      resEl.innerHTML = `<div class="text-xs text-slate-400 text-center py-4">Escribe o toca "Catálogo" para agregar productos...</div>`;
      return;
    }

    const matches = (q
      ? catalogo.filter((p) => `${p.codigo || ""} ${p.descripcion || ""} ${p.marca || ""}`.toLowerCase().includes(q))
      : catalogo
    ).slice(0, 25);

    if (!matches.length) {
      resEl.innerHTML = `<div class="text-xs text-slate-400 text-center py-4">Sin resultados para "${q}".</div>`;
      return;
    }

    resEl.innerHTML = matches.map((p) => {
      const precio = Number(((p.costoUsd || 0) * factorActual).toFixed(2));
      return `
        <div class="fila-prod-cot p-2.5 rounded-xl border border-slate-200 hover:bg-slate-50 active:bg-slate-100 flex items-center justify-between gap-2 cursor-pointer select-none" data-id="${encodeURIComponent(p.id)}">
          <div class="min-w-0 flex-1 pointer-events-none">
            <div class="font-mono-ve text-xs font-extrabold text-slate-900">${p.codigo} <span class="font-sans text-[10px] text-slate-400">${p.marca || ""}</span></div>
            <div class="text-[11px] font-semibold text-slate-600 truncate">${p.descripcion}</div>
            <div class="text-[10px] font-bold text-slate-500">Alm: <span class="text-emerald-700">${p.stockAlmacen ?? 0}</span> • Planta: <span class="text-sky-700">${p.stockPlanta ?? 0}</span></div>
          </div>
          <button type="button" class="btn-add-cot px-3 py-1.5 rounded-xl bg-slate-950 text-white text-xs font-extrabold cursor-pointer shrink-0" data-id="${encodeURIComponent(p.id)}">
            + $${precio.toFixed(2)}
          </button>
        </div>
      `;
    }).join("");
  }

  root.querySelector("#btnToggleBusqCot").addEventListener("click", () => {
    busqAbierta = !busqAbierta;
    if (!busqAbierta && !busqEl.value.trim()) {
      resEl.innerHTML = `<div class="text-xs text-slate-400 text-center py-4">Catálogo retraído.</div>`;
    } else {
      renderBusqueda();
    }
  });

  resEl.addEventListener("click", (e) => {
    const target = e.target.closest("[data-id]");
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    const prodId = decodeURIComponent(target.dataset.id || "");
    agregarProductoCotizacion(prodId, 1);
  });

  itemsEl.addEventListener("input", (e) => {
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

  itemsEl.addEventListener("click", (e) => {
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
      if (carrito[idx].cantidad > 1) {
        carrito[idx].cantidad -= 1;
      } else {
        carrito.splice(idx, 1);
      }
      renderCarrito();
    }
  });

  docEl.addEventListener("blur", () => {
    const id = normalizarIdVE(docEl.value);
    const cli = clientes.find((c) => c.id === id);
    if (cli) {
      docEl.value = cli.id;
      nomEl.value = cli.nombre || "";
      const fCli = Number(cli.factorPersonalizado) || (cli.tarifa === "mayor" ? fMayor : fDetal);
      tarifaEl.value = cli.tarifa === "mayor" ? "mayor" : (cli.tarifa === "especial" ? "custom" : "detal");
      aplicarFactor(fCli, { sincronizarInput: true, actualizarCarrito: true });
      badgeCli.textContent = `✓ Cliente registrado (${cli.tarifa || "detal"})`;
      badgeCli.classList.remove("hidden");
    } else {
      badgeCli.classList.add("hidden");
    }
  });

  tarifaEl.addEventListener("change", () => {
    if (tarifaEl.value === "mayor") aplicarFactor(fMayor, { sincronizarInput: true, actualizarCarrito: true });
    else if (tarifaEl.value === "detal") aplicarFactor(fDetal, { sincronizarInput: true, actualizarCarrito: true });
    else multEl.focus();
  });

  multEl.addEventListener("input", () => {
    tarifaEl.value = "custom";
    aplicarFactor(multEl.value, { sincronizarInput: false, actualizarCarrito: true });
  });

  multEl.addEventListener("blur", () => {
    const val = parseMultiplicadorTexto(multEl.value);
    if (val !== null) {
      multEl.value = String(val);
      aplicarFactor(val, { sincronizarInput: false, actualizarCarrito: true });
    } else {
      multEl.value = String(factorActual);
    }
  });

  root.querySelector("#btnLimpiarCot").addEventListener("click", () => {
    carrito = [];
    renderCarrito();
  });

  async function persistirCotizacion() {
    const docCli = normalizarIdVE(docEl.value);
    const nomCli = nomEl.value.trim();
    if (!docCli || !nomCli) {
      alert("Ingresa Cédula/RIF y Nombre del cliente.");
      return null;
    }
    if (!carrito.length) {
      alert("Agrega al menos un producto.");
      return null;
    }

    const folio = `COT-${String(Date.now()).slice(-6)}`;
    const now = Date.now();
    const payload = {
      folio,
      cliente: { documento: docCli, nombre: nomCli },
      items: carrito,
      multiplicador: factorActual,
      totalUsd: calcularTotal(),
      monedas: obtenerMonedas(),
      creadoTs: now,
      expiraTs: now + HORAS_72_MS,
      creadoEn: serverTimestamp()
    };

    await setDoc(doc(refs.cotizaciones(), folio), payload);
    await cargarCotizaciones();
    return payload;
  }

  root.querySelector("#btnGuardarCot").addEventListener("click", async () => {
    const saved = await persistirCotizacion();
    if (!saved) return;
    alert(`Cotización ${saved.folio} guardada (válida por 72 horas).`);
    carrito = [];
    renderCarrito();
  });

  root.querySelector("#btnGenerarPdfCot").addEventListener("click", async () => {
    const saved = await persistirCotizacion();
    if (!saved) return;

    imprimirDocumentoCarta({
      tipo: "COTIZACIÓN",
      folio: saved.folio,
      empresa: state.empresa,
      cliente: saved.cliente,
      items: saved.items,
      totalUsd: saved.totalUsd,
      monedas: saved.monedas,
      tasas: getTasaActiva(state),
      observaciones: "Presupuesto válido por 72 horas. Guarda este PDF para enviarlo por WhatsApp o correo."
    });

    carrito = [];
    renderCarrito();
  });

  function renderListaCot() {
    root.querySelector("#countCot").textContent = cotizaciones.length;
    const cont = root.querySelector("#listaCotizaciones");

    if (!cotizaciones.length) {
      cont.innerHTML = `<div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">No hay cotizaciones activas.</div>`;
      return;
    }

    cont.innerHTML = cotizaciones.map((c) => {
      const horasRest = Math.max(0, Math.round(((c.expiraTs || 0) - Date.now()) / 3600000));
      return `
        <div class="ve-card p-3.5 flex flex-wrap items-center justify-between gap-2" data-id="${c.id}">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-mono-ve text-xs font-extrabold text-slate-900">${c.folio || c.id}</span>
              <span class="text-xs font-bold text-slate-800">${c.cliente?.nombre || ""}</span>
              <span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">Expira en ${horasRest}h</span>
            </div>
            <div class="text-[11px] text-slate-500 mt-0.5">${c.items?.length || 0} ítems • Total: <strong class="text-slate-900">$${Number(c.totalUsd || 0).toFixed(2)}</strong></div>
          </div>
          <div class="flex items-center gap-1.5">
            <button type="button" class="btn-pdf px-3 py-1.5 rounded-xl bg-slate-950 text-white text-xs font-extrabold cursor-pointer">Generar PDF</button>
            <button type="button" class="btn-a-caja px-3 py-1.5 rounded-xl bg-emerald-600 text-white text-xs font-extrabold cursor-pointer">Pasar a Caja →</button>
            <button type="button" class="btn-del-cot px-2.5 py-1.5 rounded-xl bg-rose-50 text-rose-700 text-xs font-bold cursor-pointer">✕</button>
          </div>
        </div>
      `;
    }).join("");
  }

  root.querySelector("#listaCotizaciones").addEventListener("click", async (e) => {
    const card = e.target.closest("[data-id]");
    if (!card) return;
    const cot = cotizaciones.find((x) => x.id === card.dataset.id);
    if (!cot) return;

    if (e.target.closest(".btn-pdf")) {
      imprimirDocumentoCarta({
        tipo: "COTIZACIÓN",
        folio: cot.folio || cot.id,
        empresa: state.empresa,
        cliente: cot.cliente,
        items: cot.items || [],
        totalUsd: cot.totalUsd || 0,
        monedas: cot.monedas || ["USD", "BS"],
        tasas: getTasaActiva(state),
        observaciones: "Presupuesto válido por 72 horas. Precios sujetos a disponibilidad."
      });
    } else if (e.target.closest(".btn-a-caja")) {
      state.cotizacionPendiente = cot;
      if (typeof window.NEXUS_VE_NAV === "function") {
        window.NEXUS_VE_NAV("caja-pos");
      }
    } else if (e.target.closest(".btn-del-cot")) {
      if (!confirm(`¿Eliminar cotización ${cot.folio}?`)) return;
      await deleteDoc(doc(refs.cotizaciones(), cot.id));
      await cargarCotizaciones();
    }
  });

  const tabNueva = root.querySelector("#tabNuevaCot");
  const tabLista = root.querySelector("#tabListaCot");
  const viewNueva = root.querySelector("#viewNuevaCot");
  const viewLista = root.querySelector("#viewListaCot");

  tabNueva.addEventListener("click", () => {
    viewNueva.classList.remove("hidden");
    viewLista.classList.add("hidden");
    tabNueva.className = "px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-950 text-white cursor-pointer";
    tabLista.className = "px-3 py-1.5 rounded-xl text-xs font-extrabold bg-white border border-slate-200 text-slate-700 cursor-pointer";
  });

  tabLista.addEventListener("click", () => {
    viewNueva.classList.add("hidden");
    viewLista.classList.remove("hidden");
    tabLista.className = "px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-950 text-white cursor-pointer";
    tabNueva.className = "px-3 py-1.5 rounded-xl text-xs font-extrabold bg-white border border-slate-200 text-slate-700 cursor-pointer";
  });

  async function cargarCotizaciones() {
    const snap = await getDocs(refs.cotizaciones());
    const ahora = Date.now();
    const activas = [];
    for (const d of snap.docs) {
      const data = { id: d.id, ...d.data() };
      if (data.expiraTs && data.expiraTs < ahora) {
        deleteDoc(doc(refs.cotizaciones(), d.id)).catch(() => {});
      } else {
        activas.push(data);
      }
    }
    cotizaciones = activas.sort((a, b) => (b.creadoTs || 0) - (a.creadoTs || 0));
    renderListaCot();
  }

  busqEl.addEventListener("input", () => {
    busqAbierta = Boolean(busqEl.value.trim());
    renderBusqueda();
  });

  const [snapCat, snapCli] = await Promise.all([getDocs(refs.catalogo()), getDocs(refs.clientes())]);
  catalogo = snapCat.docs.map((d) => ({ id: d.id, ...d.data() }));
  clientes = snapCli.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderCarrito();
  await cargarCotizaciones();
}
