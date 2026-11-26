// venezuela/modules/configuracion-logos.js
import { getTenantRefs, setDoc, serverTimestamp } from "../core/db.js";

const TEMAS_PRO = [
  {
    id: "ejecutivo-oscuro",
    nombre: "Ejecutivo Oscuro",
    descripcion: "Contraste sobrio en pizarra profundo con acento esmeralda.",
    primario: "#0f172a",
    acento: "#059669",
    fondo: "#f8fafc",
    borde: "#cbd5e1"
  },
  {
    id: "azul-industrial",
    nombre: "Azul Industrial",
    descripcion: "Tono marino corporativo limpio para operación y despacho.",
    primario: "#0c4a6e",
    acento: "#0284c7",
    fondo: "#f0f9ff",
    borde: "#bae6fd"
  },
  {
    id: "bosque-gerencial",
    nombre: "Bosque Gerencial",
    descripcion: "Verde oscuro profesional con acabados neutros suaves.",
    primario: "#14532d",
    acento: "#16a34a",
    fondo: "#f7fee7",
    borde: "#bbf7d0"
  },
  {
    id: "carbon-ambar",
    nombre: "Carbón & Ámbar",
    descripcion: "Estilo técnico de alto contraste con detalle cálido.",
    primario: "#18181b",
    acento: "#d97706",
    fondo: "#fafafa",
    borde: "#e4e4e7"
  }
];

function aplicarTemaVisual(temaId) {
  const tema = TEMAS_PRO.find((t) => t.id === temaId) || TEMAS_PRO[0];
  const rootEl = document.documentElement;
  rootEl.style.setProperty("--ve-primario", tema.primario);
  rootEl.style.setProperty("--ve-acento", tema.acento);
  rootEl.style.setProperty("--ve-fondo", tema.fondo);
  rootEl.style.setProperty("--ve-borde", tema.borde);

  // Refuerza botones primarios y barra lateral activa de forma inmediata
  document.querySelectorAll(".ve-nav-btn.active").forEach((btn) => {
    btn.style.backgroundColor = tema.primario;
    btn.style.color = "#ffffff";
  });
}

function leerPngComoBase64(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve("");
    if (file.type !== "image/png" && !file.name.toLowerCase().endsWith(".png")) {
      return reject(new Error("Selecciona un archivo en formato PNG."));
    }
    if (file.size > 900 * 1024) {
      return reject(new Error("El PNG supera los 900 KB; usa un PNG más liviano."));
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("No se pudo leer el archivo PNG."));
    reader.readAsDataURL(file);
  });
}

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);

  let temaSeleccionado = state.empresa?.temaColor || "ejecutivo-oscuro";
  let logoPlataforma =
    state.empresa?.logoPlataformaBase64 || state.empresa?.logoBase64 || state.empresa?.logoUrl || "";
  let logoDocumento =
    state.empresa?.logoDocumentoBase64 || state.empresa?.logoBase64 || state.empresa?.logoUrl || "";

  aplicarTemaVisual(temaSeleccionado);

  root.innerHTML = `
    <div class="space-y-5 max-w-5xl mx-auto">
      <div>
        <h1 class="text-lg font-extrabold text-slate-900">Configuración y Personalización</h1>
        <p class="text-xs text-slate-500">
          Elige el tema de color profesional de la plataforma y sube por separado los logos PNG para el sistema y para los documentos PDF.
        </p>
      </div>

      <!-- 1. Temas profesionales de la plataforma -->
      <div class="ve-card space-y-3">
        <div class="flex items-center justify-between gap-2">
          <div>
            <h2 class="text-xs font-extrabold uppercase tracking-wider text-slate-500">
              Tema de Color de la Plataforma
            </h2>
            <p class="text-[11px] text-slate-500">Toca una paleta para previsualizarla al instante y luego guarda los cambios.</p>
          </div>
          <span id="badgeTemaActivo" class="text-[11px] font-extrabold px-2.5 py-1 rounded-full bg-slate-100 text-slate-800"></span>
        </div>

        <div id="gridTemas" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
          ${TEMAS_PRO.map((t) => `
            <button
              type="button"
              data-tema="${t.id}"
              class="tema-card p-3 rounded-2xl border-2 text-left transition cursor-pointer bg-white border-slate-200 hover:border-slate-400 space-y-2"
            >
              <div class="flex items-center gap-1.5">
                <span class="w-5 h-5 rounded-full border border-black/10" style="background:${t.primario}"></span>
                <span class="w-5 h-5 rounded-full border border-black/10" style="background:${t.acento}"></span>
                <span class="w-5 h-5 rounded-full border border-slate-300" style="background:${t.fondo}"></span>
              </div>
              <div class="text-xs font-extrabold text-slate-900">${t.nombre}</div>
              <p class="text-[11px] text-slate-500 leading-snug">${t.descripcion}</p>
            </button>
          `).join("")}
        </div>
      </div>

      <!-- 2. Logos PNG independientes: Plataforma vs Documento PDF -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="ve-card space-y-3">
          <div class="text-xs font-extrabold uppercase tracking-wider text-slate-500">
            Logo de la Plataforma (Encabezado / Menú)
          </div>
          <div id="boxPrevPlat" class="h-28 rounded-xl bg-slate-50 border border-dashed border-slate-300 flex items-center justify-center p-3">
            ${
              logoPlataforma
                ? `<img id="prevLogoPlat" src="${logoPlataforma}" alt="Logo Plataforma" class="max-h-20 max-w-full object-contain" />`
                : `<span id="prevLogoPlat" class="text-xs font-bold text-slate-400">Sin PNG de plataforma</span>`
            }
          </div>
          <input id="inpPngPlat" type="file" accept="image/png,.png" class="hidden" />
          <button id="btnSubirPngPlat" type="button" class="w-full py-2.5 rounded-xl bg-slate-950 hover:bg-slate-800 text-white text-xs font-extrabold cursor-pointer">
            ↑ Subir PNG Logo Plataforma
          </button>
        </div>

        <div class="ve-card space-y-3">
          <div class="text-xs font-extrabold uppercase tracking-wider text-slate-500">
            Logo Nota de Entrega / Cotización (PDF)
          </div>
          <div id="boxPrevDoc" class="h-28 rounded-xl bg-slate-50 border border-dashed border-slate-300 flex items-center justify-center p-3">
            ${
              logoDocumento
                ? `<img id="prevLogoDoc" src="${logoDocumento}" alt="Logo Documento" class="max-h-20 max-w-full object-contain" />`
                : `<span id="prevLogoDoc" class="text-xs font-bold text-slate-400">Sin PNG para notas/cotizaciones</span>`
            }
          </div>
          <input id="inpPngDoc" type="file" accept="image/png,.png" class="hidden" />
          <button id="btnSubirPngDoc" type="button" class="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold cursor-pointer">
            ↑ Subir PNG Logo Nota de Entrega / Cotización
          </button>
        </div>
      </div>

      <div class="flex justify-end">
        <button id="btnGuardarPersonalizacion" type="button" class="px-6 py-3 rounded-xl bg-slate-950 hover:bg-slate-800 text-white text-xs font-extrabold cursor-pointer">
          Guardar Tema y Logos
        </button>
      </div>
    </div>
  `;

  function marcarTemaUI() {
    const actual = TEMAS_PRO.find((t) => t.id === temaSeleccionado) || TEMAS_PRO[0];
    root.querySelector("#badgeTemaActivo").textContent = `Tema: ${actual.nombre}`;
    root.querySelectorAll(".tema-card").forEach((card) => {
      const esSel = card.dataset.tema === temaSeleccionado;
      card.className = esSel
        ? "tema-card p-3 rounded-2xl border-2 text-left transition cursor-pointer bg-slate-50 border-slate-950 ring-2 ring-slate-950/10 space-y-2"
        : "tema-card p-3 rounded-2xl border-2 text-left transition cursor-pointer bg-white border-slate-200 hover:border-slate-400 space-y-2";
    });
  }

  marcarTemaUI();

  root.querySelectorAll(".tema-card").forEach((card) => {
    card.addEventListener("click", () => {
      temaSeleccionado = card.dataset.tema;
      marcarTemaUI();
      aplicarTemaVisual(temaSeleccionado);
    });
  });

  const inpPlat = root.querySelector("#inpPngPlat");
  const inpDoc = root.querySelector("#inpPngDoc");

  function actualizarCajaLogo(boxSelector, imgId, dataUrl, altTxt, vacioTxt) {
    const box = root.querySelector(boxSelector);
    box.innerHTML = dataUrl
      ? `<img id="${imgId}" src="${dataUrl}" alt="${altTxt}" class="max-h-20 max-w-full object-contain" />`
      : `<span id="${imgId}" class="text-xs font-bold text-slate-400">${vacioTxt}</span>`;
  }

  root.querySelector("#btnSubirPngPlat").addEventListener("click", () => inpPlat.click());
  root.querySelector("#btnSubirPngDoc").addEventListener("click", () => inpDoc.click());

  inpPlat.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      logoPlataforma = await leerPngComoBase64(file);
      actualizarCajaLogo("#boxPrevPlat", "prevLogoPlat", logoPlataforma, "Logo Plataforma", "Sin PNG de plataforma");
    } catch (err) {
      alert(err.message);
    }
  });

  inpDoc.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      logoDocumento = await leerPngComoBase64(file);
      actualizarCajaLogo("#boxPrevDoc", "prevLogoDoc", logoDocumento, "Logo Documento", "Sin PNG para notas/cotizaciones");
    } catch (err) {
      alert(err.message);
    }
  });

  root.querySelector("#btnGuardarPersonalizacion").addEventListener("click", async () => {
    const btn = root.querySelector("#btnGuardarPersonalizacion");
    btn.disabled = true;
    btn.textContent = "Guardando...";

    try {
      await setDoc(
        refs.empresaRef,
        {
          temaColor: temaSeleccionado,
          logoPlataformaBase64: logoPlataforma,
          logoDocumentoBase64: logoDocumento,
          actualizadoEn: serverTimestamp()
        },
        { merge: true }
      );

      if (state.empresa) {
        state.empresa.temaColor = temaSeleccionado;
        state.empresa.logoPlataformaBase64 = logoPlataforma;
        state.empresa.logoDocumentoBase64 = logoDocumento;
      }

      aplicarTemaVisual(temaSeleccionado);

      const sidebarLogo = document.querySelector(".ve-brand-logo");
      const sidebarBadge = document.getElementById("brandLogoWrap");
      if (logoPlataforma) {
        if (sidebarLogo) {
          sidebarLogo.src = logoPlataforma;
        } else if (sidebarBadge) {
          sidebarBadge.outerHTML = `<img src="${logoPlataforma}" alt="Logo Plataforma" class="ve-brand-logo" />`;
        }
      }

      alert("Personalización guardada: tema de plataforma y ambos logos PNG actualizados.");
    } catch (err) {
      alert("Error guardando configuración: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Guardar Tema y Logos";
    }
  });
}
