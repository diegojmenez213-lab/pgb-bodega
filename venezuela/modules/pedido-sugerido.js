// venezuela/modules/pedido-sugerido.js
import { getTenantRefs, getDocs } from "../core/db.js";

const DIAS_30_MS = 30 * 24 * 60 * 60 * 1000;

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

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);

  root.innerHTML = `
    <div class="space-y-4 max-w-6xl mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Pedido Sugerido Inteligente</h1>
          <p class="text-xs text-slate-500">Clasifica qué pedir más, qué mantener en almacén y qué no pedir (+30 días sin moverse).</p>
        </div>
        <div class="flex items-center gap-2">
          <button id="btnGenerarPedido" type="button" class="px-4 py-2 rounded-xl bg-slate-950 hover:bg-slate-800 text-white text-xs font-extrabold cursor-pointer">
            ⚡ Generar Pedido Sugerido
          </button>
          <button id="btnExportPedido" type="button" class="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold cursor-pointer">
            ↓ Exportar Excel
          </button>
        </div>
      </div>

      <div class="ve-card p-3 flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap items-center gap-3">
          <div>
            <label class="text-[10px] font-bold text-slate-500 block">Días de cobertura</label>
            <input id="diasCobertura" type="number" min="7" max="90" value="30" class="w-24 bg-slate-50 border border-slate-300 rounded-xl px-3 py-1.5 text-xs font-extrabold" />
          </div>
          <label class="flex items-center gap-2 text-xs font-bold text-slate-700 pt-3 cursor-pointer">
            <input id="chkSoloPlanta" type="checkbox" checked />
            Solo disponibles en Planta
          </label>
        </div>
        <div class="text-right">
          <div class="text-[10px] font-extrabold text-slate-400">INVERSIÓN ESTIMADA DEL PEDIDO</div>
          <div id="totalInversion" class="text-lg font-extrabold font-mono-ve text-slate-950">$0.00</div>
        </div>
      </div>

      <!-- Tabs de clasificación -->
      <div class="flex flex-wrap gap-1.5">
        <button type="button" data-tab="aumentar" class="tab-sug px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-950 text-white cursor-pointer">
          Aumentar Cantidad (<span id="cntAumentar">0</span>)
        </button>
        <button type="button" data-tab="mantener" class="tab-sug px-3 py-1.5 rounded-xl text-xs font-extrabold bg-white border border-slate-200 text-slate-700 cursor-pointer">
          Mantener Stock (<span id="cntMantener">0</span>)
        </button>
        <button type="button" data-tab="no-pedir" class="tab-sug px-3 py-1.5 rounded-xl text-xs font-extrabold bg-white border border-slate-200 text-slate-700 cursor-pointer">
          No Pedir / Ofertar +30d (<span id="cntNoPedir">0</span>)
        </button>
      </div>

      <div id="listaSugerido" class="space-y-2">
        <div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">
          Toca "⚡ Generar Pedido Sugerido" para analizar tu inventario y ventas.
        </div>
      </div>
    </div>
  `;

  let catalogo = [];
  let ventas30d = new Map();
  let tabActiva = "aumentar";
  let listaAumentar = [];
  let listaMantener = [];
  let listaNoPedir = [];

  const diasEl = root.querySelector("#diasCobertura");
  const soloPlantaEl = root.querySelector("#chkSoloPlanta");
  const listaEl = root.querySelector("#listaSugerido");

  function generarAnalisis() {
    const dias = Math.max(7, Number(diasEl.value) || 30);
    const soloPlanta = soloPlantaEl.checked;
    const factor = dias / 30;
    const corte30d = Date.now() - DIAS_30_MS;

    listaAumentar = [];
    listaMantener = [];
    listaNoPedir = [];

    for (const p of catalogo) {
      const vendidos = ventas30d.get(p.id) || 0;
      const actual = Number(p.stockAlmacen || 0);
      const dispPlanta = Number(p.stockPlanta || 0);
      const costo = Number(p.costoUsd || 0);
      const sinMovimiento30d = !p.ultimaVentaTs || p.ultimaVentaTs < corte30d;

      if (vendidos > 0) {
        // Producto con rotación activa
        const meta = Math.ceil(vendidos * factor);
        const pedirBase = Math.max(0, meta - actual);
        // Si se está quedando en 0 rápido (stock menor al 25% de la venta mensual), sugerimos margen extra (+30%)
        const seAgotaRapido = actual <= Math.max(1, Math.ceil(vendidos * 0.25));
        const pedirConMargen = seAgotaRapido ? Math.ceil((meta * 1.3) - actual) : pedirBase;

        if (pedirConMargen > 0 && (!soloPlanta || dispPlanta > 0)) {
          const cantFinal = soloPlanta ? Math.min(pedirConMargen, dispPlanta) : pedirConMargen;
          listaAumentar.push({
            ...p,
            vendidos30d: vendidos,
            sugerido: cantFinal,
            motivo: seAgotaRapido ? "Alto flujo • se agota rápido (+30%)" : "Reposición según cobertura",
            inversion: cantFinal * costo
          });
        } else {
          listaMantener.push({
            ...p,
            vendidos30d: vendidos,
            sugerido: 0,
            motivo: "Stock suficiente para su rotación actual",
            inversion: 0
          });
        }
      } else if (actual > 0 && sinMovimiento30d) {
        // Sin ventas en +30 días y con stock en almacén -> No pedir / Ofertar
        listaNoPedir.push({
          ...p,
          vendidos30d: 0,
          sugerido: 0,
          motivo: "Más de 30 días sin venderse • ideal para ofrecer/promocionar",
          inversion: 0
        });
      }
    }

    listaAumentar.sort((a, b) => b.vendidos30d - a.vendidos30d);
    listaMantener.sort((a, b) => b.vendidos30d - a.vendidos30d);
    listaNoPedir.sort((a, b) => ((b.stockAlmacen || 0) * (b.costoUsd || 0)) - ((a.stockAlmacen || 0) * (a.costoUsd || 0)));

    root.querySelector("#cntAumentar").textContent = String(listaAumentar.length);
    root.querySelector("#cntMantener").textContent = String(listaMantener.length);
    root.querySelector("#cntNoPedir").textContent = String(listaNoPedir.length);

    const totalInv = listaAumentar.reduce((acc, x) => acc + x.inversion, 0);
    root.querySelector("#totalInversion").textContent = `$${totalInv.toFixed(2)}`;

    renderTab();
  }

  function renderTab() {
    const arr = tabActiva === "aumentar"
      ? listaAumentar
      : tabActiva === "mantener"
        ? listaMantener
        : listaNoPedir;

    if (!arr.length) {
      listaEl.innerHTML = `<div class="ve-card text-center py-8 text-xs text-slate-500 font-bold">No hay productos en esta categoría actualmente.</div>`;
      return;
    }

    listaEl.innerHTML = arr.slice(0, 100).map((p) => {
      const badgeColor = tabActiva === "aumentar"
        ? "bg-emerald-100 text-emerald-800"
        : tabActiva === "mantener"
          ? "bg-sky-100 text-sky-800"
          : "bg-amber-100 text-amber-900";

      return `
        <div class="ve-card p-3.5 flex flex-wrap items-center justify-between gap-2">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-mono-ve text-xs font-extrabold text-slate-900">${p.codigo || p.id}</span>
              <span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full ${badgeColor}">${p.motivo}</span>
            </div>
            <div class="text-xs font-semibold text-slate-700 mt-0.5">${p.descripcion || ""}</div>
            <div class="text-[11px] text-slate-400">
              Almacén: <strong class="text-slate-700">${p.stockAlmacen ?? 0}</strong> • Planta: <strong class="text-slate-700">${p.stockPlanta ?? 0}</strong> • Vendidos 30d: <strong class="text-slate-700">${p.vendidos30d}</strong>
            </div>
          </div>
          <div class="text-right shrink-0">
            ${tabActiva === "aumentar" ? `
              <div class="text-xs font-extrabold text-slate-950">Pedir: <span class="font-mono-ve text-emerald-700">${p.sugerido} und</span></div>
              <div class="text-[11px] font-mono-ve text-slate-500">Costo: $${p.inversion.toFixed(2)}</div>
            ` : `
              <div class="text-xs font-extrabold text-slate-600">No pedir (0 und)</div>
              <div class="text-[11px] font-mono-ve text-slate-400">Stock actual: ${p.stockAlmacen ?? 0}</div>
            `}
          </div>
        </div>
      `;
    }).join("");
  }

  root.querySelectorAll(".tab-sug").forEach((btn) => {
    btn.addEventListener("click", () => {
      tabActiva = btn.dataset.tab;
      root.querySelectorAll(".tab-sug").forEach((b) => {
        b.className = b.dataset.tab === tabActiva
          ? "tab-sug px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-950 text-white cursor-pointer"
          : "tab-sug px-3 py-1.5 rounded-xl text-xs font-extrabold bg-white border border-slate-200 text-slate-700 cursor-pointer";
      });
      renderTab();
    });
  });

  root.querySelector("#btnGenerarPedido").addEventListener("click", generarAnalisis);
  diasEl.addEventListener("change", generarAnalisis);
  soloPlantaEl.addEventListener("change", generarAnalisis);

  root.querySelector("#btnExportPedido").addEventListener("click", async () => {
    if (!listaAumentar.length) return alert("Primero genera o ten ítems en 'Aumentar Cantidad'.");
    const XLSX = await cargarSheetJS();
    const rows = listaAumentar.map((p) => ({
      Codigo: p.codigo || p.id,
      Descripcion: p.descripcion || "",
      Motivo: p.motivo,
      Vendidos_30d: p.vendidos30d,
      Almacen: p.stockAlmacen ?? 0,
      Planta: p.stockPlanta ?? 0,
      Pedir_Und: p.sugerido,
      Costo_Unit_USD: Number(p.costoUsd || 0),
      Inversion_USD: Number(p.inversion.toFixed(2))
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Pedido_Sugerido");
    XLSX.writeFile(wb, `Pedido_Sugerido_${new Date().toISOString().slice(0, 10)}.xlsx`);
  });

  const hace30d = Date.now() - DIAS_30_MS;
  const [snapCat, snapNotas] = await Promise.all([getDocs(refs.catalogo()), getDocs(refs.notasEntrega())]);
  catalogo = snapCat.docs.map((d) => ({ id: d.id, ...d.data() }));

  snapNotas.forEach((d) => {
    const n = d.data();
    if ((n.creadoTs || 0) < hace30d) return;
    for (const it of n.items || []) {
      ventas30d.set(it.id, (ventas30d.get(it.id) || 0) + Number(it.cantidad || 0));
    }
  });

  generarAnalisis();
}
