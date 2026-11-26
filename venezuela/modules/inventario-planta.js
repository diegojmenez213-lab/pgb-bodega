// venezuela/modules/inventario-planta.js
import {
  db,
  getTenantRefs,
  doc,
  getDocs,
  setDoc,
  writeBatch,
  query,
  orderBy,
  limit,
  serverTimestamp
} from "../core/db.js";

// Carga SheetJS (Excel) solo cuando se abre este módulo
async function cargarSheetJS() {
  if (window.XLSX) return window.XLSX;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.sheetjs.com/xlsx-0.20.2/package/dist/xlsx.full.min.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("No se pudo cargar la librería de Excel."));
    document.head.appendChild(s);
  });
  return window.XLSX;
}

function limpiarDocId(codigo) {
  return String(codigo || "")
    .trim()
    .toUpperCase()
    .replace(/[\/\\#?\[\]]/g, "_")
    .slice(0, 120);
}

function parseNumero(val) {
  if (typeof val === "number") return isNaN(val) ? 0 : val;
  const s = String(val || "0").replace(/[^0-9.,-]/g, "").replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// Detecta columnas automáticamente sin importar mayúsculas o variaciones
function mapearFilaExcel(row, proveedorDefault) {
  const keys = Object.keys(row);
  const buscar = (patrones) => {
    const k = keys.find((key) =>
      patrones.some((p) => key.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(p))
    );
    return k ? row[k] : "";
  };

  const codigo = String(buscar(["codigo", "cod", "sku", "ref", "parte"]) || "").trim().toUpperCase();
  const descripcion = String(buscar(["descripcion", "nombre", "producto", "detalle", "articulo"]) || "").trim();
  if (!codigo && !descripcion) return null;

  const categoria = String(buscar(["categoria", "grupo", "linea", "familia"]) || "SIN CATEGORÍA").trim().toUpperCase();
  const marca = String(buscar(["marca", "aplicacion", "vehiculo", "fabricante"]) || "GENÉRICO").trim().toUpperCase();
  const proveedor = String(buscar(["proveedor", "planta", "suplidor"]) || proveedorDefault || "RTC DIESEL PARTS").trim().toUpperCase();
  const costoUsd = parseNumero(buscar(["costo", "precio", "valor", "usd", "pvp", "neto"]));
  const stockPlanta = Math.max(0, Math.round(parseNumero(buscar(["stock", "cant", "existencia", "disponible", "planta"]))));

  return {
    id: limpiarDocId(codigo || descripcion),
    codigo: codigo || limpiarDocId(descripcion),
    descripcion: descripcion || codigo,
    categoria,
    marca,
    proveedor,
    costoUsd,
    stockPlanta
  };
}

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);

  root.innerHTML = `
    <div class="space-y-4 max-w-5xl mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Actualizar Planta (Excel)</h1>
          <p class="text-xs text-slate-500">Carga inicial en cero, actualización semanal de planta e historial de novedades.</p>
        </div>
        <div class="flex gap-1.5">
          <button id="tabImport" class="px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-950 text-white cursor-pointer">Importar Excel</button>
          <button id="tabNovedades" class="px-3 py-1.5 rounded-xl text-xs font-extrabold bg-white border border-slate-200 text-slate-700 cursor-pointer">Historial Novedades</button>
        </div>
      </div>

      <!-- Vista Importador -->
      <section id="viewImport" class="space-y-4">
        <div class="ve-card space-y-4">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="text-[11px] font-bold text-slate-600 block mb-1">Modo de Importación</label>
              <select id="modoImport" class="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2.5 text-xs font-bold">
                <option value="semanal">Actualización Semanal de Planta (conserva Almacén)</option>
                <option value="inicial">Carga Inicial Base (crea catálogo con Almacén en 0)</option>
              </select>
            </div>
            <div>
              <label class="text-[11px] font-bold text-slate-600 block mb-1">Proveedor / Planta</label>
              <input id="inputProveedor" type="text" value="RTC DIESEL PARTS" class="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2.5 text-xs font-bold uppercase" />
            </div>
          </div>

          <div class="border-2 border-dashed border-slate-300 rounded-2xl p-5 text-center bg-slate-50 space-y-2">
            <input id="fileExcel" type="file" accept=".xlsx,.xls,.csv" class="hidden" />
            <button id="btnElegirExcel" type="button" class="px-4 py-2.5 rounded-xl bg-slate-950 text-white text-xs font-extrabold cursor-pointer">
              Seleccionar Archivo Excel (.xlsx / .csv)
            </button>
            <p id="txtArchivo" class="text-xs text-slate-500 font-medium">
              Columnas detectadas automáticamente: Código, Descripción, Categoría, Marca, Costo/Precio, Stock.
            </p>
          </div>

          <div id="previewBox" class="hidden space-y-3">
            <div id="resumenAnalisis" class="grid grid-cols-2 sm:grid-cols-4 gap-2"></div>
            <div id="progresoWrap" class="hidden space-y-1">
              <div class="flex justify-between text-[11px] font-bold text-slate-600">
                <span id="progresoTxt">Guardando en Firestore...</span>
                <span id="progresoPct">0%</span>
              </div>
              <div class="w-full h-2.5 bg-slate-200 rounded-full overflow-hidden">
                <div id="progresoBar" class="h-full bg-emerald-600 transition-all" style="width:0%"></div>
              </div>
            </div>
            <button id="btnConfirmarImport" type="button" class="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold uppercase tracking-wider cursor-pointer">
              Confirmar y Sincronizar Catálogo
            </button>
          </div>
        </div>
      </section>

      <!-- Vista Historial de Novedades -->
      <section id="viewNovedades" class="hidden space-y-3">
        <div class="ve-card flex flex-wrap items-end gap-2">
          <div>
            <label class="text-[10px] font-bold text-slate-500 block mb-1">Desde</label>
            <input id="filtroDesde" type="date" class="bg-slate-50 border border-slate-300 rounded-xl px-2.5 py-1.5 text-xs font-bold" />
          </div>
          <div>
            <label class="text-[10px] font-bold text-slate-500 block mb-1">Hasta</label>
            <input id="filtroHasta" type="date" class="bg-slate-50 border border-slate-300 rounded-xl px-2.5 py-1.5 text-xs font-bold" />
          </div>
          <button id="btnFiltrarNov" class="px-3.5 py-2 rounded-xl bg-slate-950 text-white text-xs font-extrabold cursor-pointer">Filtrar</button>
        </div>
        <div id="listaNovedades" class="space-y-2">
          <div class="ve-card text-center text-xs text-slate-500 py-8">Cargando historial...</div>
        </div>
      </section>
    </div>
  `;

  let itemsProcesados = [];
  let resumenActual = null;
  let novedadesCache = [];

  const tabImport = root.querySelector("#tabImport");
  const tabNovedades = root.querySelector("#tabNovedades");
  const viewImport = root.querySelector("#viewImport");
  const viewNovedades = root.querySelector("#viewNovedades");

  tabImport.addEventListener("click", () => {
    viewImport.classList.remove("hidden");
    viewNovedades.classList.add("hidden");
    tabImport.className = "px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-950 text-white cursor-pointer";
    tabNovedades.className = "px-3 py-1.5 rounded-xl text-xs font-extrabold bg-white border border-slate-200 text-slate-700 cursor-pointer";
  });

  tabNovedades.addEventListener("click", () => {
    viewImport.classList.add("hidden");
    viewNovedades.classList.remove("hidden");
    tabNovedades.className = "px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-950 text-white cursor-pointer";
    tabImport.className = "px-3 py-1.5 rounded-xl text-xs font-extrabold bg-white border border-slate-200 text-slate-700 cursor-pointer";
    cargarHistorial();
  });

  const fileInput = root.querySelector("#fileExcel");
  root.querySelector("#btnElegirExcel").addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const txtArchivo = root.querySelector("#txtArchivo");
    txtArchivo.textContent = `Leyendo ${file.name}...`;

    try {
      const XLSX = await cargarSheetJS();
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

      const provDefault = root.querySelector("#inputProveedor").value.trim().toUpperCase() || "RTC DIESEL PARTS";
      const mapaUnicos = new Map();
      for (const r of rows) {
        const item = mapearFilaExcel(r, provDefault);
        if (item && item.id) mapaUnicos.set(item.id, item);
      }
      itemsProcesados = Array.from(mapaUnicos.values());

      if (!itemsProcesados.length) {
        txtArchivo.textContent = "No se encontraron filas válidas en el archivo.";
        return;
      }

      // Comparamos contra Firestore para calcular novedades
      txtArchivo.textContent = `Analizando ${itemsProcesados.length} productos contra el catálogo actual...`;
      const snapActual = await getDocs(refs.catalogo());
      const actuales = new Map();
      snapActual.forEach((d) => actuales.set(d.id, d.data()));

      let nuevos = 0, cambioPrecio = 0, cambioProv = 0, enCero = 0;
      const detallesNovedad = [];

      for (const it of itemsProcesados) {
        if (it.costoUsd <= 0) enCero++;
        const prev = actuales.get(it.id);
        if (!prev) {
          nuevos++;
          if (detallesNovedad.length < 40) detallesNovedad.push(`+ Nuevo: ${it.codigo} (${it.descripcion.slice(0, 38)})`);
        } else {
          if (Math.abs((prev.costoUsd || 0) - it.costoUsd) > 0.009) {
            cambioPrecio++;
            if (detallesNovedad.length < 40) detallesNovedad.push(`$ Precio ${it.codigo}: $${prev.costoUsd || 0} → $${it.costoUsd}`);
          }
          if (prev.proveedor && prev.proveedor !== it.proveedor) {
            cambioProv++;
            if (detallesNovedad.length < 40) detallesNovedad.push(`⇄ Proveedor ${it.codigo}: ${prev.proveedor} → ${it.proveedor}`);
          }
        }
      }

      resumenActual = {
        archivo: file.name,
        proveedor: provDefault,
        total: itemsProcesados.length,
        nuevos,
        cambioPrecio,
        cambioProv,
        enCero,
        detallesNovedad,
        actuales
      };

      txtArchivo.textContent = `Archivo listo: ${file.name} (${itemsProcesados.length} productos únicos)`;
      root.querySelector("#resumenAnalisis").innerHTML = `
        <div class="p-3 rounded-xl bg-slate-50 border border-slate-200"><div class="text-[10px] font-bold text-slate-500">TOTAL EXCEL</div><div class="text-lg font-extrabold">${itemsProcesados.length}</div></div>
        <div class="p-3 rounded-xl bg-emerald-50 border border-emerald-200"><div class="text-[10px] font-bold text-emerald-700">NUEVOS</div><div class="text-lg font-extrabold text-emerald-800">${nuevos}</div></div>
        <div class="p-3 rounded-xl bg-amber-50 border border-amber-200"><div class="text-[10px] font-bold text-amber-700">CAMBIO PRECIO</div><div class="text-lg font-extrabold text-amber-800">${cambioPrecio}</div></div>
        <div class="p-3 rounded-xl bg-rose-50 border border-rose-200"><div class="text-[10px] font-bold text-rose-700">PRECIO $0 / PROV</div><div class="text-lg font-extrabold text-rose-800">${enCero} / ${cambioProv}</div></div>
      `;
      root.querySelector("#previewBox").classList.remove("hidden");
    } catch (err) {
      txtArchivo.textContent = "Error leyendo Excel: " + err.message;
    }
  });

  root.querySelector("#btnConfirmarImport").addEventListener("click", async () => {
    if (!itemsProcesados.length || !resumenActual) return;
    const modo = root.querySelector("#modoImport").value;
    const btn = root.querySelector("#btnConfirmarImport");
    const progWrap = root.querySelector("#progresoWrap");
    const progBar = root.querySelector("#progresoBar");
    const progPct = root.querySelector("#progresoPct");
    const progTxt = root.querySelector("#progresoTxt");

    btn.disabled = true;
    btn.textContent = "Sincronizando...";
    progWrap.classList.remove("hidden");

    try {
      const LOTE = 400;
      const total = itemsProcesados.length;
      const colRef = refs.catalogo();

      for (let i = 0; i < total; i += LOTE) {
        const slice = itemsProcesados.slice(i, i + LOTE);
        const batch = writeBatch(db);

        for (const it of slice) {
          const prev = resumenActual.actuales.get(it.id);
          const payload = {
            codigo: it.codigo,
            descripcion: it.descripcion,
            categoria: it.categoria,
            marca: it.marca,
            proveedor: it.proveedor,
            costoUsd: it.costoUsd,
            stockPlanta: it.stockPlanta,
            actualizadoEn: serverTimestamp()
          };

          if (!prev || modo === "inicial") {
            payload.stockAlmacen = 0;
            payload.contado = false;
          }

          batch.set(doc(colRef, it.id), payload, { merge: true });
        }

        await batch.commit();
        const hecho = Math.min(i + LOTE, total);
        const pct = Math.round((hecho / total) * 100);
        progBar.style.width = `${pct}%`;
        progPct.textContent = `${pct}%`;
        progTxt.textContent = `Guardados ${hecho} de ${total} productos...`;
      }

      // Guardar registro en Historial de Novedades
      const fechaIso = new Date().toISOString().slice(0, 10);
      await setDoc(doc(refs.historialNovedades(), `${Date.now()}`), {
        fechaIso,
        modo,
        archivo: resumenActual.archivo,
        proveedor: resumenActual.proveedor,
        total: resumenActual.total,
        nuevos: resumenActual.nuevos,
        cambioPrecio: resumenActual.cambioPrecio,
        cambioProv: resumenActual.cambioProv,
        detalles: resumenActual.detallesNovedad,
        creadoEn: serverTimestamp()
      });

      progTxt.textContent = "¡Catálogo sincronizado correctamente!";
      alert(`Sincronización completa: ${total} productos guardados.`);
    } catch (err) {
      alert("Error guardando lote: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Confirmar y Sincronizar Catálogo";
    }
  });

  async function cargarHistorial() {
    const cont = root.querySelector("#listaNovedades");
    cont.innerHTML = `<div class="ve-card text-center text-xs text-slate-500 py-8">Cargando historial...</div>`;
    try {
      const q = query(refs.historialNovedades(), orderBy("fechaIso", "desc"), limit(50));
      const snap = await getDocs(q);
      novedadesCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderHistorial();
    } catch {
      const snap = await getDocs(refs.historialNovedades());
      novedadesCache = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.fechaIso || "").localeCompare(a.fechaIso || ""));
      renderHistorial();
    }
  }

  function renderHistorial() {
    const desde = root.querySelector("#filtroDesde").value;
    const hasta = root.querySelector("#filtroHasta").value;
    const cont = root.querySelector("#listaNovedades");

    const filtrados = novedadesCache.filter((n) => {
      if (desde && (n.fechaIso || "") < desde) return false;
      if (hasta && (n.fechaIso || "") > hasta) return false;
      return true;
    });

    if (!filtrados.length) {
      cont.innerHTML = `<div class="ve-card text-center text-xs text-slate-500 py-8">No hay novedades registradas en ese rango.</div>`;
      return;
    }

    cont.innerHTML = filtrados.map((n) => `
      <div class="ve-card space-y-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <span class="text-xs font-extrabold text-slate-900">${n.fechaIso || "---"}</span>
            <span class="text-[11px] font-bold text-slate-500 ml-2">${n.proveedor || ""} • ${n.archivo || ""}</span>
          </div>
          <span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 uppercase">${n.modo || "semanal"}</span>
        </div>
        <div class="flex flex-wrap gap-2 text-[11px] font-bold">
          <span class="px-2 py-1 rounded-lg bg-slate-100">Total: ${n.total || 0}</span>
          <span class="px-2 py-1 rounded-lg bg-emerald-50 text-emerald-700">Nuevos: ${n.nuevos || 0}</span>
          <span class="px-2 py-1 rounded-lg bg-amber-50 text-amber-700">Precios: ${n.cambioPrecio || 0}</span>
          <span class="px-2 py-1 rounded-lg bg-sky-50 text-sky-700">Cambio Prov: ${n.cambioProv || 0}</span>
        </div>
        ${n.detalles?.length ? `
          <details class="text-xs text-slate-600 pt-1">
            <summary class="cursor-pointer font-bold text-slate-800">Ver muestra de cambios (${n.detalles.length})</summary>
            <ul class="mt-2 space-y-1 font-mono-ve text-[11px] bg-slate-50 p-2.5 rounded-xl border border-slate-200 max-h-40 overflow-y-auto">
              ${n.detalles.map((d) => `<li>${d}</li>`).join("")}
            </ul>
          </details>
        ` : ""}
      </div>
    `).join("");
  }

  root.querySelector("#btnFiltrarNov").addEventListener("click", renderHistorial);
}
