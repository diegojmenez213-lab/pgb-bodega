// venezuela/modules/pedido-sugerido.js
import {
  getTenantRefs,
  doc,
  getDocs,
  setDoc,
  serverTimestamp,
  obtenerFechaLocalIso
} from "../core/db.js";

async function cargarSheetJS() {
  if (window.XLSX) return window.XLSX;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.sheetjs.com/xlsx-0.20.2/package/dist/xlsx.full.min.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("No se pudo cargar SheetJS."));
    document.head.appendChild(s);
  });
  return window.XLSX;
}

function normalizarTexto(txt) {
  return String(txt || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function obtenerTsNota(n) {
  if (Number(n?.creadoTs) > 0) return Number(n.creadoTs);
  if (n?.fechaIso && /^\d{4}-\d{2}-\d{2}$/.test(n.fechaIso)) {
    return new Date(`${n.fechaIso}T12:00:00`).getTime();
  }
  return 0;
}

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);

  root.innerHTML = `
    <div class="space-y-4 max-w-6xl mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Pedido Sugerido Inteligente</h1>
          <p class="text-xs text-slate-500">Calcula reposición según ventas reales de los últimos 30 días (sin anuladas) y sincroniza Planta real con Caja.</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button id="btnExportarPedidoExcel" type="button" class="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold cursor-pointer">
            ↓ Exportar Pedido a Excel
          </button>
          <button id="btnRecargarSug" type="button" class="px-3 py-2 rounded-xl bg-slate-950 text-white text-xs font-extrabold cursor-pointer">
            ↻ Actualizar
          </button>
        </div>
      </div>

      <div class="ve-card p-3.5 space-y-3">
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <div>
            <label class="text-[10px] font-extrabold uppercase text-slate-500 block mb-1">Proveedor</label>
            <select id="sugFiltroProv" class="w-full bg-slate-50 border border-slate-300 rounded-xl px-2.5 py-2 text-xs font-bold">
              <option value="">Todos los Proveedores</option>
            </select>
          </div>
          <div>
            <label class="text-[10px] font-extrabold uppercase text-slate-500 block mb-1">Cobertura deseada</label>
            <select id="sugDiasCob" class="w-full bg-slate-50 border border-slate-300 rounded-xl px-2.5 py-2 text-xs font-bold">
              <option value="7">7 días</option>
              <option value="15" selected>15 días</option>
              <option value="30">30 días</option>
              <option value="45">45 días</option>
              <option value="60">60 días</option>
            </select>
          </div>
          <div>
            <label class="text-[10px] font-extrabold uppercase text-slate-500 block mb-1">Buscar producto</label>
            <input id="sugBusq" type="text" placeholder="Código o descripción..." class="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold outline-none focus:border-slate-950" />
          </div>
          <div class="flex items-end pb-1.5">
            <label class="flex items-center gap-2 text-xs font-extrabold text-slate-700 cursor-pointer">
              <input id="sugSoloPlanta" type="checkbox" checked />
              Solo disponibles en Planta
            </label>
          </div>
        </div>
      </div>

      <div id="resumenExplicacionSug" class="ve-card border-sky-200 bg-sky-50/40 p-3.5 space-y-2 text-xs text-slate-800">
        <div class="font-extrabold text-sky-950">Análisis del Inventario (Últimos 30 días)</div>
        <div id="txtExplicacionSug" class="leading-relaxed text-slate-700">Calculando rotación...</div>
        <div id="kpiGridSug" class="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1"></div>
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <button type="button" data-tab="pedir" class="btn-tab-sug p-2.5 rounded-xl border-2 text-left cursor-pointer bg-slate-950 text-white border-slate-950">
          <div class="text-[10px] font-extrabold uppercase opacity-80">Pedir Hoy</div>
          <div id="cntTabPedir" class="font-mono-ve text-base font-extrabold">0</div>
        </button>
        <button type="button" data-tab="agotados_planta" class="btn-tab-sug p-2.5 rounded-xl border-2 text-left cursor-pointer bg-white text-slate-800 border-slate-200">
          <div class="text-[10px] font-extrabold uppercase text-rose-700">Agotados en Planta</div>
          <div id="cntTabAgotados" class="font-mono-ve text-base font-extrabold text-rose-700">0</div>
        </button>
        <button type="button" data-tab="mantener" class="btn-tab-sug p-2.5 rounded-xl border-2 text-left cursor-pointer bg-white text-slate-800 border-slate-200">
          <div class="text-[10px] font-extrabold uppercase text-emerald-700">Stock Saludable</div>
          <div id="cntTabMantener" class="font-mono-ve text-base font-extrabold text-emerald-700">0</div>
        </button>
        <button type="button" data-tab="sin_movimiento" class="btn-tab-sug p-2.5 rounded-xl border-2 text-left cursor-pointer bg-white text-slate-800 border-slate-200">
          <div class="text-[10px] font-extrabold uppercase text-slate-500">Sin Movimiento (30d)</div>
          <div id="cntTabSinMov" class="font-mono-ve text-base font-extrabold text-slate-600">0</div>
        </button>
      </div>

      <div id="listaSugerido" class="space-y-2">
        <div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">Analizando ventas e inventario...</div>
      </div>
    </div>
  `;

  let catalogo = [];
  let notas = [];
  let tabActiva = "pedir";
  let cantPedirManual = new Map();
  let analisisActual = {
    pedir: [],
    agotados_planta: [],
    mantener: [],
    sin_movimiento: []
  };

  const provEl = root.querySelector("#sugFiltroProv");
  const cobEl = root.querySelector("#sugDiasCob");
  const busqEl = root.querySelector("#sugBusq");
  const soloPlantaEl = root.querySelector("#sugSoloPlanta");
  const listaEl = root.querySelector("#listaSugerido");

  function poblarProveedores() {
    const provs = Array.from(
      new Set(catalogo.map((p) => String(p.proveedor || "").trim()).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b, "es"));

    const prevVal = provEl.value;
    provEl.innerHTML =
      `<option value="">Todos los Proveedores (${provs.length})</option>` +
      provs.map((pr) => `<option value="${pr}">${pr}</option>`).join("");
    if (prevVal && provs.includes(prevVal)) provEl.value = prevVal;
  }

  function calcularAnalisis() {
    const diasCob = Math.max(1, parseInt(cobEl.value, 10) || 15);
    const provSel = provEl.value;
    const q = normalizarTexto(busqEl.value);
    const soloDispPlanta = soloPlantaEl.checked;
    const limite30d = Date.now() - 30 * 86400000;

    // Índice rápido de catálogo por id y por código
    const prodPorId = new Map();
    const prodPorCodigo = new Map();
    for (const p of catalogo) {
      prodPorId.set(p.id, p);
      const cod = String(p.codigo || "").trim().toUpperCase();
      if (cod && !prodPorCodigo.has(cod)) prodPorCodigo.set(cod, p);
    }

    // Acumular ventas válidas de los últimos 30 días (ignorando anuladas)
    const ventasPorProd = new Map();
    let notasValidas30d = 0;

    for (const n of notas) {
      if (!n || n.anulada) continue;
      const ts = obtenerTsNota(n);
      if (ts < limite30d) continue;
      notasValidas30d++;

      const vistosEnEstaNota = new Set();
      for (const it of n.items || []) {
        const cant = Math.max(0, Number(it.cantidad || 0));
        if (cant <= 0) continue;

        let pid = it.prodId || it.id || "";
        if (!prodPorId.has(pid) && it.codigo) {
          const matchCod = prodPorCodigo.get(String(it.codigo).trim().toUpperCase());
          if (matchCod) pid = matchCod.id;
        }
        if (!pid) continue;

        const rec = ventasPorProd.get(pid) || {
          vendidos30d: 0,
          vendidosAlmacen30d: 0,
          vendidosPlanta30d: 0,
          frecuenciaNotas: 0,
          ultimaVentaValidaTs: 0
        };

        rec.vendidos30d += cant;
        if (it.origen === "planta") rec.vendidosPlanta30d += cant;
        else rec.vendidosAlmacen30d += cant;
        if (!vistosEnEstaNota.has(pid)) {
          rec.frecuenciaNotas += 1;
          vistosEnEstaNota.add(pid);
        }
        if (ts > rec.ultimaVentaValidaTs) rec.ultimaVentaValidaTs = ts;

        ventasPorProd.set(pid, rec);
      }
    }

    const pedir = [];
    const agotados_planta = [];
    const mantener = [];
    const sin_movimiento = [];

    for (const p of catalogo) {
      if (provSel && String(p.proveedor || "").trim() !== provSel) continue;
      if (q) {
        const txt = normalizarTexto(`${p.codigo || ""} ${p.descripcion || ""} ${p.marca || ""} ${p.proveedor || ""}`);
        if (!txt.includes(q)) continue;
      }

      const v = ventasPorProd.get(p.id) || {
        vendidos30d: 0,
        vendidosAlmacen30d: 0,
        vendidosPlanta30d: 0,
        frecuenciaNotas: 0,
        ultimaVentaValidaTs: 0
      };

      const stockAlmacen = Math.max(0, Number(p.stockAlmacen || 0));
      const stockPlanta = Math.max(0, Number(p.stockPlanta || 0));
      const costoUsd = Math.max(0, Number(p.costoUsd || 0));

      const ritmoDiario = v.vendidos30d / 30;
      const objetivoUnidades = v.vendidos30d > 0 ? Math.ceil(ritmoDiario * diasCob) : 0;
      const pedirNecesario = Math.max(0, objetivoUnidades - stockAlmacen);
      const diasStockActual = ritmoDiario > 0 ? Number((stockAlmacen / ritmoDiario).toFixed(1)) : null;

      let sugeridoBase = 0;
      let motivo = "";

      if (v.vendidos30d <= 0) {
        motivo = stockAlmacen > 0
          ? `Sin ventas en los últimos 30 días (${stockAlmacen} und en Almacén). No requiere reposición.`
          : `Sin ventas registradas en los últimos 30 días.`;
        sin_movimiento.push({
          ...p,
          ...v,
          stockAlmacen,
          stockPlanta,
          costoUsd,
          ritmoDiario,
          objetivoUnidades,
          pedirNecesario: 0,
          pedirFinal: 0,
          diasStockActual,
          motivo
        });
        continue;
      }

      if (pedirNecesario <= 0) {
        motivo = `Stock saludable: vendiste ${v.vendidos30d} und en 30 días y tus ${stockAlmacen} und en Almacén cubren ${diasStockActual} días (meta: ${diasCob}d).`;
        mantener.push({
          ...p,
          ...v,
          stockAlmacen,
          stockPlanta,
          costoUsd,
          ritmoDiario,
          objetivoUnidades,
          pedirNecesario: 0,
          pedirFinal: 0,
          diasStockActual,
          motivo
        });
        continue;
      }

      // Tiene demanda real (vendidos30d > 0) y falta stock en Almacén (pedirNecesario > 0)
      if (soloDispPlanta && stockPlanta <= 0) {
        motivo = `Necesitas ${pedirNecesario} und para cubrir ${diasCob} días (vendiste ${v.vendidos30d} und en 30d y tienes ${stockAlmacen} en Almacén), pero Planta reporta 0 disponibles.`;
        agotados_planta.push({
          ...p,
          ...v,
          stockAlmacen,
          stockPlanta,
          costoUsd,
          ritmoDiario,
          objetivoUnidades,
          pedirNecesario,
          pedirFinal: 0,
          diasStockActual,
          motivo
        });
        continue;
      }

      sugeridoBase = soloDispPlanta
        ? Math.min(pedirNecesario, stockPlanta)
        : pedirNecesario;

      const cantEditada = cantPedirManual.has(p.id)
        ? Math.max(0, Number(cantPedirManual.get(p.id)))
        : sugeridoBase;

      const limitadoPorPlanta = stockPlanta > 0 && stockPlanta < pedirNecesario;
      motivo = `Vendiste ${v.vendidos30d} und en 30 días (${v.frecuenciaNotas} nota${v.frecuenciaNotas === 1 ? "" : "s"}). Almacén actual: ${stockAlmacen} und (~${diasStockActual}d). Necesitas ${pedirNecesario} und para ${diasCob}d` +
        (limitadoPorPlanta
          ? ` (topado a ${stockPlanta} und disponibles en Planta).`
          : stockPlanta <= 0
            ? ` (Planta en 0: consultar proveedor).`
            : `.`);

      pedir.push({
        ...p,
        ...v,
        stockAlmacen,
        stockPlanta,
        costoUsd,
        ritmoDiario,
        objetivoUnidades,
        pedirNecesario,
        sugeridoBase,
        pedirFinal: cantEditada,
        subtotalUsd: Number((cantEditada * costoUsd).toFixed(2)),
        diasStockActual,
        limitadoPorPlanta,
        motivo
      });
    }

    // Ordenar listas por relevancia
    pedir.sort((a, b) => b.vendidos30d - a.vendidos30d || b.pedirNecesario - a.pedirNecesario);
    agotados_planta.sort((a, b) => b.vendidos30d - a.vendidos30d || b.pedirNecesario - a.pedirNecesario);
    mantener.sort((a, b) => b.vendidos30d - a.vendidos30d);
    sin_movimiento.sort((a, b) => b.stockAlmacen - a.stockAlmacen || (a.descripcion || "").localeCompare(b.descripcion || "", "es"));

    analisisActual = { pedir, agotados_planta, mantener, sin_movimiento };

    // KPIs y explicación general
    const totalUndPedir = pedir.reduce((acc, x) => acc + Number(x.pedirFinal || 0), 0);
    const inversionEstimadaUsd = Number(
      pedir.reduce((acc, x) => acc + Number(x.pedirFinal || 0) * Number(x.costoUsd || 0), 0).toFixed(2)
    );
    const totalVendidosGrupo = [...pedir, ...agotados_planta, ...mantener].reduce(
      (acc, x) => acc + Number(x.vendidos30d || 0),
      0
    );
    const top1 = [...pedir, ...agotados_planta, ...mantener].sort((a, b) => b.vendidos30d - a.vendidos30d)[0];

    root.querySelector("#cntTabPedir").textContent = String(pedir.length);
    root.querySelector("#cntTabAgotados").textContent = String(agotados_planta.length);
    root.querySelector("#cntTabMantener").textContent = String(mantener.length);
    root.querySelector("#cntTabSinMov").textContent = String(sin_movimiento.length);

    const ambitoTxt = provSel ? `del proveedor <strong>${provSel}</strong>` : "de todos los proveedores";
    root.querySelector("#txtExplicacionSug").innerHTML =
      notasValidas30d === 0
        ? `Aún no hay ventas válidas registradas en los últimos 30 días. Cuando factures notas en Caja, aquí verás automáticamente qué reponer y cuánto invertir.`
        : `Se analizaron <strong>${notasValidas30d} nota(s) válida(s)</strong> de los últimos 30 días (${totalVendidosGrupo} und vendidas ${ambitoTxt}) para proyectar <strong>${diasCob} días</strong> de inventario. ` +
          `Se sugiere pedir <strong>${pedir.length} producto(s)</strong> (${totalUndPedir} und por <strong>$${inversionEstimadaUsd.toFixed(2)}</strong> costo)` +
          (agotados_planta.length
            ? `, hay <strong>${agotados_planta.length} producto(s) con demanda pero agotados en Planta</strong>`
            : "") +
          (top1 ? ` y tu producto de mayor rotación es <strong>${top1.codigo}</strong> (${top1.vendidos30d} und vendidas).` : ".");

    root.querySelector("#kpiGridSug").innerHTML = `
      <div class="bg-white rounded-xl border border-slate-200 p-2.5">
        <div class="text-[10px] font-extrabold uppercase text-slate-400">Inversión Est. Pedido</div>
        <div class="font-mono-ve text-sm font-extrabold text-slate-950">$${inversionEstimadaUsd.toFixed(2)}</div>
      </div>
      <div class="bg-white rounded-xl border border-slate-200 p-2.5">
        <div class="text-[10px] font-extrabold uppercase text-slate-400">Unidades a Pedir</div>
        <div class="font-mono-ve text-sm font-extrabold text-emerald-700">${totalUndPedir} und</div>
      </div>
      <div class="bg-white rounded-xl border border-slate-200 p-2.5">
        <div class="text-[10px] font-extrabold uppercase text-slate-400">Agotados en Planta</div>
        <div class="font-mono-ve text-sm font-extrabold text-rose-700">${agotados_planta.length} ítems</div>
      </div>
      <div class="bg-white rounded-xl border border-slate-200 p-2.5">
        <div class="text-[10px] font-extrabold uppercase text-slate-400">Stock Saludable</div>
        <div class="font-mono-ve text-sm font-extrabold text-sky-900">${mantener.length} ítems</div>
      </div>
    `;
  }

  function actualizarTabsUI() {
    root.querySelectorAll(".btn-tab-sug").forEach((btn) => {
      const activo = btn.dataset.tab === tabActiva;
      btn.className = activo
        ? "btn-tab-sug p-2.5 rounded-xl border-2 text-left cursor-pointer bg-slate-950 text-white border-slate-950"
        : "btn-tab-sug p-2.5 rounded-xl border-2 text-left cursor-pointer bg-white text-slate-800 border-slate-200 hover:border-slate-400";
    });
  }

  function renderLista() {
    actualizarTabsUI();
    const items = analisisActual[tabActiva] || [];

    if (!items.length) {
      const vacios = {
        pedir: "No hay productos sugeridos para pedir con los filtros actuales.",
        agotados_planta: "No hay productos con demanda agotados en Planta.",
        mantener: "No hay productos en estado de stock saludable en este filtro.",
        sin_movimiento: "No hay productos sin movimiento en este filtro."
      };
      listaEl.innerHTML = `<div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">${vacios[tabActiva]}</div>`;
      return;
    }

    const mostrarInputPedir = tabActiva === "pedir";
    const mostrarInputPlanta = tabActiva === "pedir" || tabActiva === "agotados_planta";

    listaEl.innerHTML = items.slice(0, 150).map((it) => `
      <div class="ve-card p-3.5 space-y-2" data-pid="${encodeURIComponent(it.id)}">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="font-mono-ve text-xs font-extrabold text-slate-950">${it.codigo || it.id}</span>
              ${it.proveedor ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-sky-50 border border-sky-200 text-sky-900">${it.proveedor}</span>` : ""}
              <span class="text-[10px] font-mono-ve font-extrabold px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-900">Costo: $${it.costoUsd.toFixed(2)}</span>
              ${it.vendidos30d > 0 ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">Vendidos 30d: ${it.vendidos30d}</span>` : ""}
            </div>
            <div class="text-xs font-bold text-slate-800 mt-0.5">${it.descripcion || ""}</div>
            <div class="text-[11px] text-slate-600 mt-1 leading-snug">${it.motivo}</div>
          </div>

          <div class="flex flex-wrap items-center gap-2 shrink-0">
            <div class="text-center px-2 py-1 rounded-lg bg-slate-50 border border-slate-200">
              <div class="text-[9px] font-extrabold uppercase text-slate-400">Almacén</div>
              <div class="font-mono-ve text-xs font-extrabold ${it.stockAlmacen > 0 ? "text-emerald-700" : "text-rose-600"}">${it.stockAlmacen}</div>
            </div>

            ${mostrarInputPlanta ? `
              <div class="text-center px-2 py-1 rounded-lg bg-sky-50/70 border border-sky-200">
                <label class="text-[9px] font-extrabold uppercase text-sky-900 block">Planta Real</label>
                <input
                  type="number"
                  min="0"
                  value="${it.stockPlanta}"
                  title="Al cambiar este número se guarda en tu catálogo para Caja y Cotizaciones"
                  class="inp-planta-real w-14 bg-white border border-sky-300 rounded-md px-1 py-0.5 text-xs font-mono-ve font-extrabold text-center text-sky-950"
                />
              </div>
            ` : `
              <div class="text-center px-2 py-1 rounded-lg bg-sky-50/50 border border-sky-200">
                <div class="text-[9px] font-extrabold uppercase text-sky-800">Planta</div>
                <div class="font-mono-ve text-xs font-extrabold text-sky-900">${it.stockPlanta}</div>
              </div>
            `}

            ${mostrarInputPedir ? `
              <div class="text-center px-2 py-1 rounded-lg bg-emerald-50 border border-emerald-300">
                <label class="text-[9px] font-extrabold uppercase text-emerald-900 block">Pedir</label>
                <input
                  type="number"
                  min="0"
                  value="${it.pedirFinal}"
                  class="inp-cant-pedir w-14 bg-white border border-emerald-400 rounded-md px-1 py-0.5 text-xs font-mono-ve font-extrabold text-center text-emerald-950"
                />
              </div>
              <div class="text-right min-w-[68px]">
                <div class="text-[9px] font-extrabold uppercase text-slate-400">Subtotal</div>
                <div class="txt-sub-pedir font-mono-ve text-xs font-extrabold text-slate-950">$${Number(it.subtotalUsd || 0).toFixed(2)}</div>
              </div>
            ` : ""}
          </div>
        </div>
        <div class="msg-sync-planta hidden text-[10px] font-extrabold text-emerald-700"></div>
      </div>
    `).join("") +
    (items.length > 150 ? `<div class="text-[11px] text-center text-slate-400 font-bold py-2">Mostrando 150 de ${items.length}. Usa el filtro por proveedor o el buscador.</div>` : "");
  }

  function recalcularYRenderizar() {
    calcularAnalisis();
    renderLista();
  }

  listaEl.addEventListener("input", (e) => {
    const card = e.target.closest("[data-pid]");
    if (!card) return;
    const pid = decodeURIComponent(card.dataset.pid || "");

    if (e.target.classList.contains("inp-cant-pedir")) {
      const val = Math.max(0, parseInt(e.target.value, 10) || 0);
      cantPedirManual.set(pid, val);
      const item = analisisActual.pedir.find((x) => x.id === pid);
      if (item) {
        item.pedirFinal = val;
        item.subtotalUsd = Number((val * item.costoUsd).toFixed(2));
        const subEl = card.querySelector(".txt-sub-pedir");
        if (subEl) subEl.textContent = `$${item.subtotalUsd.toFixed(2)}`;
      }
      calcularAnalisis();
    }
  });

  // Guardar Planta Real directamente en Firestore para sincronizar con Caja y Cotizaciones
  listaEl.addEventListener("change", async (e) => {
    if (!e.target.classList.contains("inp-planta-real")) return;
    const card = e.target.closest("[data-pid]");
    if (!card) return;
    const pid = decodeURIComponent(card.dataset.pid || "");
    const nuevoStockPlanta = Math.max(0, parseInt(e.target.value, 10) || 0);
    e.target.value = String(nuevoStockPlanta);

    const msgEl = card.querySelector(".msg-sync-planta");
    if (msgEl) {
      msgEl.textContent = "Guardando disponibilidad real de Planta...";
      msgEl.className = "msg-sync-planta text-[10px] font-extrabold text-sky-800";
    }

    try {
      await setDoc(
        doc(refs.catalogo(), pid),
        { stockPlanta: nuevoStockPlanta, actualizadoEn: serverTimestamp() },
        { merge: true }
      );

      const prod = catalogo.find((p) => p.id === pid);
      if (prod) prod.stockPlanta = nuevoStockPlanta;

      // Recalcula sin pisar una cantidad manual salvo si superaba la nueva Planta real
      if (cantPedirManual.has(pid) && soloPlantaEl.checked && cantPedirManual.get(pid) > nuevoStockPlanta) {
        cantPedirManual.set(pid, nuevoStockPlanta);
      }

      recalcularYRenderizar();
    } catch (err) {
      alert("No se pudo guardar la disponibilidad real de Planta: " + err.message);
    }
  });

  root.querySelectorAll(".btn-tab-sug").forEach((btn) => {
    btn.addEventListener("click", () => {
      tabActiva = btn.dataset.tab;
      renderLista();
    });
  });

  root.querySelector("#btnExportarPedidoExcel").addEventListener("click", async () => {
    const listaExport = (analisisActual.pedir || []).filter((x) => Number(x.pedirFinal || 0) > 0);
    if (!listaExport.length) {
      return alert("No hay productos con cantidad mayor a 0 en 'Pedir Hoy' para exportar.");
    }

    try {
      const XLSX = await cargarSheetJS();
      const filas = listaExport.map((it) => ({
        Proveedor: it.proveedor || "GENERAL",
        Codigo: it.codigo || it.id,
        Descripcion: it.descripcion || "",
        "Costo USD": Number(it.costoUsd.toFixed(2)),
        "Vendidos 30d": it.vendidos30d,
        "Stock Almacen": it.stockAlmacen,
        "Planta Real": it.stockPlanta,
        "Cantidad a Pedir": it.pedirFinal,
        "Subtotal Costo USD": Number((it.pedirFinal * it.costoUsd).toFixed(2))
      }));

      const totalUnd = listaExport.reduce((acc, x) => acc + Number(x.pedirFinal || 0), 0);
      const totalCosto = Number(
        listaExport.reduce((acc, x) => acc + Number(x.pedirFinal || 0) * Number(x.costoUsd || 0), 0).toFixed(2)
      );

      filas.push({
        Proveedor: "TOTAL",
        Codigo: "",
        Descripcion: `${listaExport.length} producto(s)`,
        "Costo USD": "",
        "Vendidos 30d": "",
        "Stock Almacen": "",
        "Planta Real": "",
        "Cantidad a Pedir": totalUnd,
        "Subtotal Costo USD": totalCosto
      });

      const ws = XLSX.utils.json_to_sheet(filas);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Pedido Sugerido");

      const provTag = (provEl.value || "TODOS").replace(/[^A-Z0-9]+/gi, "_");
      const fechaHoy = obtenerFechaLocalIso();
      XLSX.writeFile(wb, `Pedido_Sugerido_${provTag}_${fechaHoy}.xlsx`);
    } catch (err) {
      alert("Error generando el Excel: " + err.message);
    }
  });

  provEl.addEventListener("change", () => {
    cantPedirManual.clear();
    recalcularYRenderizar();
  });
  cobEl.addEventListener("change", () => {
    cantPedirManual.clear();
    recalcularYRenderizar();
  });
  busqEl.addEventListener("input", recalcularYRenderizar);
  soloPlantaEl.addEventListener("change", recalcularYRenderizar);
  root.querySelector("#btnRecargarSug").addEventListener("click", cargarDatos);

  async function cargarDatos() {
    const [snapCat, snapNotas] = await Promise.all([
      getDocs(refs.catalogo()),
      getDocs(refs.notasEntrega())
    ]);
    catalogo = snapCat.docs.map((d) => ({ id: d.id, ...d.data() }));
    notas = snapNotas.docs.map((d) => ({ id: d.id, ...d.data() }));
    cantPedirManual.clear();
    poblarProveedores();
    recalcularYRenderizar();
  }

  await cargarDatos();
}
