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

function sumarDiasIso(dias) {
  const f = new Date(Date.now() + Number(dias || 0) * 86400000);
  return f.toISOString().slice(0, 10);
}

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);

  root.innerHTML = `
    <div class="space-y-4 max-w-6xl mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Pedido Sugerido Inteligente</h1>
          <p class="text-xs text-slate-500">Diagnóstico de rotación (últimos 30 días), contexto de compra y ventana del próximo pedido.</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button id="btnGenerarPedido" type="button" class="px-4 py-2 rounded-xl bg-slate-950 hover:bg-slate-800 text-white text-xs font-extrabold cursor-pointer">
            ⚡ Generar Pedido Sugerido
          </button>
          <button id="btnExportPedido" type="button" class="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold cursor-pointer">
            ↓ Exportar Excel
          </button>
        </div>
      </div>

      <div class="ve-card p-3.5 space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex flex-wrap items-center gap-3">
            <div>
              <label class="text-[10px] font-bold text-slate-500 block">Cobertura de este pedido (días)</label>
              <input id="diasCobertura" type="number" min="5" max="90" value="15" class="w-24 bg-slate-50 border border-slate-300 rounded-xl px-3 py-1.5 text-xs font-extrabold" />
            </div>
            <div>
              <label class="text-[10px] font-bold text-slate-500 block">Proveedor</label>
              <select id="filtroProvSug" class="bg-slate-50 border border-slate-300 rounded-xl px-2.5 py-1.5 text-xs font-extrabold">
                <option value="">Todos los Proveedores</option>
              </select>
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

        <div id="cajaProximoPedido" class="p-3 rounded-xl bg-slate-950 text-white flex flex-wrap items-center justify-between gap-2 text-xs">
          <div>
            <div class="text-[10px] font-extrabold uppercase tracking-wider text-emerald-400">Planificación del Próximo Pedido</div>
            <div id="txtProximoPedido" class="font-semibold text-slate-100 mt-0.5">
              Genera el análisis para calcular la ventana de reposición.
            </div>
          </div>
          <div id="badgeFechaProximo" class="px-3 py-1.5 rounded-xl bg-white/10 font-mono-ve text-xs font-extrabold text-emerald-300">
            ---
          </div>
        </div>
      </div>

      <div id="cajaExplicacionGeneral" class="hidden ve-card p-3.5 border-sky-200 bg-sky-50/50 space-y-1.5">
        <div class="text-[11px] font-extrabold uppercase tracking-wider text-sky-950">
          Por qué se está moviendo y por qué se sugiere pedir esto
        </div>
        <p id="txtExplicacionGeneral" class="text-xs text-slate-700 leading-relaxed"></p>
      </div>

      <div class="flex flex-wrap gap-1.5">
        <button type="button" data-tab="aumentar" class="tab-sug px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-950 text-white cursor-pointer">
          Aumentar / Pedir (<span id="cntAumentar">0</span>)
        </button>
        <button type="button" data-tab="mantener" class="tab-sug px-3 py-1.5 rounded-xl text-xs font-extrabold bg-white border border-slate-200 text-slate-700 cursor-pointer">
          Mantener Stock (<span id="cntMantener">0</span>)
        </button>
        <button type="button" data-tab="no-pedir" class="tab-sug px-3 py-1.5 rounded-xl text-xs font-extrabold bg-white border border-slate-200 text-slate-700 cursor-pointer">
          No Pedir / Ofertar +30d (<span id="cntNoPedir">0</span>)
        </button>
      </div>

      <div id="listaSugerido" class="space-y-2.5">
        <div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">
          Toca "⚡ Generar Pedido Sugerido" para obtener el diagnóstico completo.
        </div>
      </div>
    </div>
  `;

  let catalogo = [];
  let ventas30d = new Map();
  let pedidosPlanta30d = new Map();
  let plantaRealOverride = new Map();
  let tabActiva = "aumentar";
  let listaAumentar = [];
  let listaMantener = [];
  let listaNoPedir = [];
  let resumenGeneral = {
    diasCobertura: 15,
    provFiltro: "",
    soloPlanta: true,
    totalUndPedir: 0,
    totalInv: 0,
    itemsAltaRotacion: 0,
    itemsQuiebrePlanta: 0,
    totalVendidos30d: 0
  };

  const diasEl = root.querySelector("#diasCobertura");
  const provEl = root.querySelector("#filtroProvSug");
  const soloPlantaEl = root.querySelector("#chkSoloPlanta");
  const listaEl = root.querySelector("#listaSugerido");

  function getPlantaEfectiva(p) {
    if (plantaRealOverride.has(p.id)) {
      return Math.max(0, Number(plantaRealOverride.get(p.id) || 0));
    }
    return Math.max(0, Number(p.stockPlanta || 0));
  }

  function poblarProveedores() {
    const provs = Array.from(
      new Set(catalogo.map((p) => (p.proveedor || "").trim().toUpperCase()).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b, "es"));

    const actual = provEl.value;
    provEl.innerHTML =
      `<option value="">Todos los Proveedores (${provs.length})</option>` +
      provs.map((pr) => `<option value="${pr}" ${actual === pr ? "selected" : ""}>${pr}</option>`).join("");
  }

  async function cargarDatosFrescos() {
    const hace30d = Date.now() - DIAS_30_MS;
    const [snapCat, snapNotas] = await Promise.all([getDocs(refs.catalogo()), getDocs(refs.notasEntrega())]);
    catalogo = snapCat.docs.map((d) => ({ id: d.id, ...d.data() }));

    ventas30d = new Map();
    pedidosPlanta30d = new Map();

    snapNotas.forEach((d) => {
      const n = d.data();
      if (n.anulada) return;
      if ((n.creadoTs || 0) < hace30d) return;
      for (const it of n.items || []) {
        const cant = Number(it.cantidad || 0);
        if (cant <= 0) continue;
        const pid = it.prodId || it.id;
        ventas30d.set(pid, (ventas30d.get(pid) || 0) + cant);
        if (it.origen === "planta") {
          pedidosPlanta30d.set(pid, (pedidosPlanta30d.get(pid) || 0) + cant);
        }
      }
    });

    poblarProveedores();
  }

  function actualizarExplicacionGeneral() {
    const box = root.querySelector("#cajaExplicacionGeneral");
    const txt = root.querySelector("#txtExplicacionGeneral");

    if (tabActiva !== "aumentar" || !listaAumentar.length) {
      box.classList.add("hidden");
      return;
    }

    const {
      diasCobertura,
      provFiltro,
      soloPlanta,
      totalUndPedir,
      totalInv,
      itemsAltaRotacion,
      itemsQuiebrePlanta,
      totalVendidos30d
    } = resumenGeneral;

    const ambito = provFiltro ? `del proveedor ${provFiltro}` : "en el catálogo filtrado";
    const partes = [
      `Se está moviendo un volumen de ${totalVendidos30d} und en los últimos 30 días ${ambito}, con ${listaAumentar.length} referencia(s) que requieren reposición (${totalUndPedir} und en total por $${totalInv.toFixed(2)} a precio costo) para cubrir ${diasCobertura} días.`
    ];

    const motivos = [];
    if (itemsAltaRotacion > 0) {
      motivos.push(`${itemsAltaRotacion} referencia(s) con salida rápida y poco stock en almacén (se les añade margen de seguridad para no quedarse cortos)`);
    }
    if (itemsQuiebrePlanta > 0) {
      motivos.push(`${itemsQuiebrePlanta} referencia(s) pedidas desde Planta sin existencia física en almacén`);
    }
    if (motivos.length) {
      partes.push(`La compra se concentra principalmente en ${motivos.join(" y ")}.`);
    } else {
      partes.push(`El pedido responde a la reposición normal según el ritmo de salida de los últimos 30 días y tu stock actual en almacén.`);
    }

    if (soloPlanta) {
      partes.push(`Solo se consideran cantidades disponibles en Planta (incluyendo ajustes reales de Planta que hayas ingresado aquí).`);
    }

    txt.textContent = partes.join(" ");
    box.classList.remove("hidden");
  }

  function generarAnalisis() {
    const diasCobertura = Math.max(5, Number(diasEl.value) || 15);
    const provFiltro = provEl.value;
    const soloPlanta = soloPlantaEl.checked;
    const factor = diasCobertura / 30;
    const corte30d = Date.now() - DIAS_30_MS;

    listaAumentar = [];
    listaMantener = [];
    listaNoPedir = [];

    let totalUndPedir = 0;
    let itemsAltaRotacion = 0;
    let itemsQuiebrePlanta = 0;
    let totalVendidos30d = 0;

    for (const p of catalogo) {
      const provNombre = (p.proveedor || "SIN PROVEEDOR").toUpperCase();
      if (provFiltro && provNombre !== provFiltro) continue;

      const vendidos = ventas30d.get(p.id) || 0;
      const pedidosDePlanta = pedidosPlanta30d.get(p.id) || 0;
      const actual = Number(p.stockAlmacen || 0);
      const dispPlantaLista = Math.max(0, Number(p.stockPlanta || 0));
      const dispPlanta = getPlantaEfectiva(p);
      const tieneAjustePlanta = plantaRealOverride.has(p.id);
      const costo = Number(p.costoUsd || 0);
      const sinMovimiento30d = !p.ultimaVentaTs || p.ultimaVentaTs < corte30d;
      const ritmoDiario = vendidos / 30;
      const diasAutonomiaActual = ritmoDiario > 0 ? Math.floor(actual / ritmoDiario) : 99;

      if (pedidosDePlanta > 0 && actual <= 0) {
        const basePedir = Math.max(1, Math.ceil(pedidosDePlanta * factor));
        if (!soloPlanta || dispPlanta > 0) {
          const cantFinal = soloPlanta ? Math.min(basePedir, dispPlanta) : basePedir;
          const notaPlanta = dispPlanta < basePedir && soloPlanta
            ? ` (topado a ${dispPlanta} und disponibles reales en Planta vs. ${basePedir} requeridas)`
            : "";
          const contexto = `En los últimos 30 días se solicitaron ${pedidosDePlanta} und desde Planta sin stock en Almacén (stock físico actual: 0). Conviene abastecer ${cantFinal} und para cubrir ${diasCobertura} días${notaPlanta}.`;
          listaAumentar.push({
            ...p,
            proveedor: provNombre,
            stockPlantaLista: dispPlantaLista,
            stockPlantaEfectivo: dispPlanta,
            tieneAjustePlanta,
            vendidos30d: vendidos,
            pedidosPlanta: pedidosDePlanta,
            sugerido: cantFinal,
            etiqueta: "Sin stock en Almacén • Alta demanda en Planta",
            contexto,
            proximoRevisionDias: Math.max(3, Math.ceil(diasCobertura * 0.7)),
            inversion: cantFinal * costo
          });
          totalUndPedir += cantFinal;
          itemsQuiebrePlanta += 1;
          totalVendidos30d += vendidos;
        }
        continue;
      }

      if (vendidos > 0) {
        const metaCobertura = Math.ceil(vendidos * factor);
        const pedirBase = Math.max(0, metaCobertura - actual);
        const seAgotaRapido = actual <= Math.max(1, Math.ceil(vendidos * 0.25));
        const pedirFinalCalculado = seAgotaRapido
          ? Math.max(0, Math.ceil(metaCobertura * 1.25) - actual)
          : pedirBase;

        if (pedirFinalCalculado > 0 && (!soloPlanta || dispPlanta > 0)) {
          const cantFinal = soloPlanta ? Math.min(pedirFinalCalculado, dispPlanta) : pedirFinalCalculado;
          const notaPlanta = cantFinal < pedirFinalCalculado && soloPlanta
            ? ` (ajustado a ${cantFinal} und por disponibilidad real en Planta de ${dispPlanta})`
            : "";
          const contexto = seAgotaRapido
            ? `En los últimos 30 días salieron ${vendidos} und (~${ritmoDiario.toFixed(1)}/día) y en Almacén quedan ${actual} und (~${diasAutonomiaActual} días de autonomía). Se sugieren ${cantFinal} und con margen extra para cubrir ${diasCobertura} días${notaPlanta}.`
            : `En los últimos 30 días se movieron ${vendidos} und (~${ritmoDiario.toFixed(1)}/día) y en Almacén hay ${actual} und. Para cubrir ${diasCobertura} días (meta ${metaCobertura} und) conviene pedir ${cantFinal} und${notaPlanta}.`;

          listaAumentar.push({
            ...p,
            proveedor: provNombre,
            stockPlantaLista: dispPlantaLista,
            stockPlantaEfectivo: dispPlanta,
            tieneAjustePlanta,
            vendidos30d: vendidos,
            pedidosPlanta: pedidosDePlanta,
            sugerido: cantFinal,
            etiqueta: seAgotaRapido ? "Rotación alta • Margen de seguridad" : "Reposición planificada",
            contexto,
            proximoRevisionDias: Math.max(4, Math.min(diasCobertura, diasAutonomiaActual + Math.round(diasCobertura * 0.6))),
            inversion: cantFinal * costo
          });
          totalUndPedir += cantFinal;
          if (seAgotaRapido) itemsAltaRotacion += 1;
          totalVendidos30d += vendidos;
        } else {
          const contexto = `En los últimos 30 días vendió ${vendidos} und (~${ritmoDiario.toFixed(1)}/día) y el stock actual en Almacén (${actual} und) cubre el ritmo actual sin necesidad de pedir hoy.`;
          listaMantener.push({
            ...p,
            proveedor: provNombre,
            stockPlantaLista: dispPlantaLista,
            stockPlantaEfectivo: dispPlanta,
            tieneAjustePlanta,
            vendidos30d: vendidos,
            pedidosPlanta: pedidosDePlanta,
            sugerido: 0,
            etiqueta: "Stock saludable • Mantener",
            contexto,
            proximoRevisionDias: diasCobertura,
            inversion: 0
          });
        }
      } else if (actual > 0 && sinMovimiento30d) {
        const contexto = `Lleva más de 30 días sin registrar ventas y mantiene ${actual} und en Almacén. No conviene pedir más de este código; conviene impulsarlo en ofertas o combos.`;
        listaNoPedir.push({
          ...p,
          proveedor: provNombre,
          stockPlantaLista: dispPlantaLista,
          stockPlantaEfectivo: dispPlanta,
          tieneAjustePlanta,
          vendidos30d: 0,
          pedidosPlanta: 0,
          sugerido: 0,
          etiqueta: "Sin movimiento +30d • No pedir / Ofertar",
          contexto,
          proximoRevisionDias: 30,
          inversion: 0
        });
      }
    }

    listaAumentar.sort((a, b) => b.inversion - a.inversion || b.vendidos30d - a.vendidos30d);
    listaMantener.sort((a, b) => b.vendidos30d - a.vendidos30d);
    listaNoPedir.sort((a, b) => ((b.stockAlmacen || 0) * (b.costoUsd || 0)) - ((a.stockAlmacen || 0) * (a.costoUsd || 0)));

    root.querySelector("#cntAumentar").textContent = String(listaAumentar.length);
    root.querySelector("#cntMantener").textContent = String(listaMantener.length);
    root.querySelector("#cntNoPedir").textContent = String(listaNoPedir.length);

    const totalInv = listaAumentar.reduce((acc, x) => acc + x.inversion, 0);
    root.querySelector("#totalInversion").textContent = `$${totalInv.toFixed(2)}`;

    resumenGeneral = {
      diasCobertura,
      provFiltro,
      soloPlanta,
      totalUndPedir,
      totalInv,
      itemsAltaRotacion,
      itemsQuiebrePlanta,
      totalVendidos30d
    };

    const menorRevision = listaAumentar.length
      ? Math.min(...listaAumentar.map((x) => x.proximoRevisionDias || diasCobertura))
      : diasCobertura;
    const fechaEstimada = sumarDiasIso(menorRevision);

    root.querySelector("#txtProximoPedido").textContent = listaAumentar.length
      ? `Pedido proyectado para ${diasCobertura} días${provFiltro ? ` (${provFiltro})` : ""}. Vuelve a revisar en aprox. ${menorRevision} días.`
      : `Con el stock actual no hay compras urgentes hoy. Revisa nuevamente en ${diasCobertura} días o cuando baje el stock de tus ítems principales.`;
    root.querySelector("#badgeFechaProximo").textContent = `Próxima revisión: ~${menorRevision}d (${fechaEstimada})`;

    renderTab();
  }

  function renderTab() {
    actualizarExplicacionGeneral();

    const arr = tabActiva === "aumentar"
      ? listaAumentar
      : tabActiva === "mantener"
        ? listaMantener
        : listaNoPedir;

    if (!arr.length) {
      listaEl.innerHTML = `<div class="ve-card text-center py-8 text-xs text-slate-500 font-bold">No hay productos en este grupo para el análisis actual.</div>`;
      return;
    }

    listaEl.innerHTML = arr.slice(0, 100).map((p) => {
      const badgeColor = tabActiva === "aumentar"
        ? "bg-emerald-100 text-emerald-900"
        : tabActiva === "mantener"
          ? "bg-sky-100 text-sky-900"
          : "bg-amber-100 text-amber-950";

      return `
        <div class="ve-card p-3.5 space-y-2" data-spid="${p.id}">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-mono-ve text-xs font-extrabold text-slate-950">${p.codigo || p.id}</span>
                <span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-sky-50 border border-sky-200 text-sky-900">${p.proveedor}</span>
                <span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full ${badgeColor}">${p.etiqueta}</span>
                ${p.tieneAjustePlanta ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-amber-100 text-amber-900">Planta ajustada: ${p.stockPlantaEfectivo}</span>` : ""}
              </div>
              <div class="text-xs font-extrabold text-slate-800 mt-1">${p.descripcion || ""}</div>
            </div>

            <div class="text-right shrink-0">
              ${tabActiva === "aumentar" ? `
                <div class="text-xs font-extrabold text-slate-950">Pedir: <span class="font-mono-ve text-sm text-emerald-700">${p.sugerido} und</span></div>
                <div class="text-[11px] font-mono-ve text-slate-600">Costo: $${p.inversion.toFixed(2)}</div>
              ` : `
                <div class="text-xs font-extrabold text-slate-700">No pedir (0 und)</div>
                <div class="text-[11px] font-mono-ve text-slate-400">Almacén: ${p.stockAlmacen ?? 0} und</div>
              `}
            </div>
          </div>

          <p class="text-[11px] text-slate-600 bg-slate-50 border border-slate-200/80 rounded-xl p-2.5 leading-relaxed">
            ${p.contexto}
          </p>

          <div class="flex flex-wrap items-center justify-between gap-2 text-[10px] font-bold text-slate-500 pt-0.5">
            <div class="flex items-center gap-2 flex-wrap">
              <span>Almacén: <strong class="text-slate-800">${p.stockAlmacen ?? 0}</strong></span>
              <span>• Planta lista: <strong class="text-slate-800">${p.stockPlantaLista}</strong></span>
              <span class="inline-flex items-center gap-1">
                • Planta real:
                <input type="number" min="0" value="${p.stockPlantaEfectivo}" class="inp-planta-real w-14 bg-white border border-slate-300 rounded px-1.5 py-0.5 text-[11px] font-mono-ve font-extrabold text-slate-900" title="Ajusta aquí si en Planta hay menos de lo que dice la lista" />
              </span>
              <span>• Vendidos 30d: <strong class="text-slate-800">${p.vendidos30d}</strong></span>
            </div>
            <span class="text-slate-700">Revisar en ~${p.proximoRevisionDias} días (${sumarDiasIso(p.proximoRevisionDias)})</span>
          </div>
        </div>
      `;
    }).join("");
  }

  listaEl.addEventListener("change", (e) => {
    if (!e.target.classList.contains("inp-planta-real")) return;
    const card = e.target.closest("[data-spid]");
    if (!card) return;
    const pid = card.dataset.spid;
    const val = Math.max(0, parseInt(e.target.value, 10) || 0);
    plantaRealOverride.set(pid, val);
    generarAnalisis();
  });

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

  root.querySelector("#btnGenerarPedido").addEventListener("click", async () => {
    const btn = root.querySelector("#btnGenerarPedido");
    btn.disabled = true;
    btn.textContent = "Calculando...";
    try {
      await cargarDatosFrescos();
      generarAnalisis();
    } finally {
      btn.disabled = false;
      btn.textContent = "⚡ Generar Pedido Sugerido";
    }
  });

  diasEl.addEventListener("change", generarAnalisis);
  provEl.addEventListener("change", generarAnalisis);
  soloPlantaEl.addEventListener("change", generarAnalisis);

  root.querySelector("#btnExportPedido").addEventListener("click", async () => {
    if (!listaAumentar.length) return alert("Primero genera o ten ítems en 'Aumentar / Pedir'.");
    const XLSX = await cargarSheetJS();
    const rows = listaAumentar.map((p) => ({
      Proveedor: p.proveedor || "SIN PROVEEDOR",
      Codigo: p.codigo || p.id,
      Descripcion: p.descripcion || "",
      Diagnostico: p.etiqueta,
      Contexto: p.contexto,
      Vendidos_30d: p.vendidos30d,
      Pedidos_Planta_30d: p.pedidosPlanta || 0,
      Almacen: p.stockAlmacen ?? 0,
      Planta_Lista: p.stockPlantaLista ?? 0,
      Planta_Real_Usada: p.stockPlantaEfectivo ?? 0,
      Pedir_Und: p.sugerido,
      Proxima_Revision_Dias: p.proximoRevisionDias,
      Fecha_Proxima_Revision: sumarDiasIso(p.proximoRevisionDias),
      Costo_Unit_USD: Number(p.costoUsd || 0),
      Inversion_USD: Number(p.inversion.toFixed(2))
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Pedido_Sugerido");
    const sufijoProv = provEl.value ? `_${provEl.value.replace(/[^A-Z0-9]+/gi, "_")}` : "";
    XLSX.writeFile(wb, `Pedido_Sugerido${sufijoProv}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  });

  await cargarDatosFrescos();
  generarAnalisis();
}
