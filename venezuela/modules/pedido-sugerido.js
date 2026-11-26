// venezuela/modules/pedido-sugerido.js
import { getTenantRefs, getDocs } from "../core/db.js";

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
          <h1 class="text-lg font-extrabold text-slate-900">Asesor & Pedido Sugerido</h1>
          <p class="text-xs text-slate-500">Calcula reposición ideal según ventas de los últimos 30 días y disponibilidad en Planta.</p>
        </div>
        <button id="btnExportPedido" class="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold cursor-pointer">
          ↓ Exportar Pedido Excel
        </button>
      </div>

      <div class="ve-card p-3 flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap items-center gap-3">
          <div>
            <label class="text-[10px] font-bold text-slate-500 block">Cobertura deseada (días)</label>
            <input id="diasCobertura" type="number" min="7" max="90" value="30" class="w-24 bg-slate-50 border border-slate-300 rounded-xl px-3 py-1.5 text-xs font-extrabold" />
          </div>
          <label class="flex items-center gap-2 text-xs font-bold text-slate-700 pt-3 cursor-pointer">
            <input id="chkSoloPlanta" type="checkbox" checked />
            Solo disponibles en Planta
          </label>
        </div>
        <div class="text-right">
          <div class="text-[10px] font-extrabold text-slate-400">INVERSIÓN ESTIMADA</div>
          <div id="totalInversion" class="text-lg font-extrabold font-mono-ve text-slate-950">$0.00</div>
        </div>
      </div>

      <div id="listaSugerido" class="space-y-2">
        <div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">Analizando historial de ventas...</div>
      </div>
    </div>
  `;

  let catalogo = [];
  let ventas30d = new Map();
  let sugeridosActuales = [];

  const diasEl = root.querySelector("#diasCobertura");
  const soloPlantaEl = root.querySelector("#chkSoloPlanta");
  const listaEl = root.querySelector("#listaSugerido");

  function calcular() {
    const dias = Math.max(7, Number(diasEl.value) || 30);
    const soloPlanta = soloPlantaEl.checked;
    const factor = dias / 30;

    const res = [];
    for (const p of catalogo) {
      const vendidos = ventas30d.get(p.id) || 0;
      if (vendidos <= 0) continue;

      const meta = Math.ceil(vendidos * factor);
      const actual = Number(p.stockAlmacen || 0);
      const pedir = meta - actual;
      if (pedir <= 0) continue;

      const dispPlanta = Number(p.stockPlanta || 0);
      if (soloPlanta && dispPlanta <= 0) continue;

      const cantFinal = soloPlanta ? Math.min(pedir, dispPlanta) : pedir;
      const inversion = cantFinal * Number(p.costoUsd || 0);

      res.push({
        ...p,
        vendidos30d: vendidos,
        sugerido: cantFinal,
        inversion
      });
    }

    res.sort((a, b) => b.vendidos30d - a.vendidos30d);
    sugeridosActuales = res;

    const totalInv = res.reduce((acc, x) => acc + x.inversion, 0);
    root.querySelector("#totalInversion").textContent = `$${totalInv.toFixed(2)}`;

    if (!res.length) {
      listaEl.innerHTML = `
        <div class="ve-card text-center py-10 space-y-1">
          <div class="text-sm font-extrabold text-slate-900">Sin reposiciones urgentes</div>
          <p class="text-xs text-slate-500">A medida que emitas Notas de Entrega, el asesor calculará automáticamente qué debes pedir a Planta.</p>
        </div>
      `;
      return;
    }

    listaEl.innerHTML = res.map((p) => `
      <div class="ve-card p-3.5 flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-mono-ve text-xs font-extrabold text-slate-900">${p.codigo || p.id}</span>
            <span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">${p.marca || ""}</span>
            <span class="text-[10px] font-extrabold text-emerald-700">Vendidos 30d: ${p.vendidos30d}</span>
          </div>
          <div class="text-xs font-semibold text-slate-700 mt-0.5">${p.descripcion || ""}</div>
          <div class="text-[11px] text-slate-400">Almacén: ${p.stockAlmacen ?? 0} • Planta: ${p.stockPlanta ?? 0}</div>
        </div>
        <div class="text-right shrink-0">
          <div class="text-xs font-extrabold text-slate-950">Pedir: <span class="font-mono-ve text-emerald-700">${p.sugerido} und</span></div>
          <div class="text-[11px] font-mono-ve text-slate-500">Inversión: $${p.inversion.toFixed(2)}</div>
        </div>
      </div>
    `).join("");
  }

  root.querySelector("#btnExportPedido").addEventListener("click", async () => {
    if (!sugeridosActuales.length) return alert("No hay ítems sugeridos para exportar.");
    const XLSX = await cargarSheetJS();
    const rows = sugeridosActuales.map((p) => ({
      Codigo: p.codigo || p.id,
      Descripcion: p.descripcion || "",
      Proveedor: p.proveedor || "",
      Vendidos_30d: p.vendidos30d,
      Stock_Almacen: p.stockAlmacen ?? 0,
      Stock_Planta: p.stockPlanta ?? 0,
      Cantidad_Sugerida: p.sugerido,
      Costo_Unit_USD: Number(p.costoUsd || 0),
      Inversion_USD: Number(p.inversion.toFixed(2))
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Pedido_Sugerido");
    XLSX.writeFile(wb, `Pedido_Sugerido_${new Date().toISOString().slice(0, 10)}.xlsx`);
  });

  diasEl.addEventListener("input", calcular);
  soloPlantaEl.addEventListener("change", calcular);

  const hace30d = Date.now() - 30 * 86400000;
  const [snapCat, snapNotas] = await Promise.all([getDocs(refs.catalogo()), getDocs(refs.notasEntrega())]);
  catalogo = snapCat.docs.map((d) => ({ id: d.id, ...d.data() }));

  snapNotas.forEach((d) => {
    const n = d.data();
    if ((n.creadoTs || 0) < hace30d) return;
    for (const it of n.items || []) {
      ventas30d.set(it.id, (ventas30d.get(it.id) || 0) + Number(it.cantidad || 0));
    }
  });

  calcular();
}
