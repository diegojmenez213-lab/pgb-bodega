// venezuela/modules/configuracion-logos.js
import { getTenantRefs, setDoc, serverTimestamp } from "../core/db.js";

const TEMA_PREDETERMINADO = "ejecutivo-oscuro";

const TEMAS_PRO = [
  {
    id: "ejecutivo-oscuro",
    nombre: "Ejecutivo Oscuro",
    descripcion: "Contraste sobrio en pizarra profundo con acento esmeralda.",
    primario: "#0f172a",
    primarioSuave: "#1e293b",
    acento: "#059669",
    fondo: "#f8fafc",
    superficie: "#ffffff",
    borde: "#cbd5e1"
  },
  {
    id: "azul-industrial",
    nombre: "Azul Industrial",
    descripcion: "Tono marino corporativo limpio para operación y despacho.",
    primario: "#0c4a6e",
    primarioSuave: "#0369a1",
    acento: "#0284c7",
    fondo: "#f0f9ff",
    superficie: "#ffffff",
    borde: "#bae6fd"
  },
  {
    id: "bosque-gerencial",
    nombre: "Bosque Gerencial",
    descripcion: "Verde oscuro profesional con acabados neutros suaves.",
    primario: "#14532d",
    primarioSuave: "#166534",
    acento: "#16a34a",
    fondo: "#f7fee7",
    superficie: "#ffffff",
    borde: "#bbf7d0"
  },
  {
    id: "carbon-ambar",
    nombre: "Carbón & Ámbar",
    descripcion: "Estilo técnico de alto contraste con detalle cálido.",
    primario: "#18181b",
    primarioSuave: "#27272a",
    acento: "#d97706",
    fondo: "#fafafa",
    superficie: "#ffffff",
    borde: "#e4e4e7"
  }
];

function aplicarTemaVisual(temaId, state = null) {
  const tema = TEMAS_PRO.find((t) => t.id === temaId) || TEMAS_PRO[0];
  if (state?.empresa) {
    state.empresa.temaColor = tema.id;
  }

  const rootEl = document.documentElement;
  rootEl.style.setProperty("--ve-primario", tema.primario);
  rootEl.style.setProperty("--ve-acento", tema.acento);
  rootEl.style.setProperty("--ve-fondo", tema.fondo);
  rootEl.style.setProperty("--ve-borde", tema.borde);

  let styleTag = document.getElementById("veTemaDinamico");
  if (!styleTag) {
    styleTag = document.createElement("style");
    styleTag.id = "veTemaDinamico";
    document.head.appendChild(styleTag);
  }

  styleTag.textContent = `
    body, .ve-shell, .ve-main-wrap, .ve-content {
      background-color: ${tema.fondo} !important;
    }
    .ve-topbar, .ve-sidebar, .ve-bottom-nav, .ve-card {
      background-color: ${tema.superficie} !important;
      border-color: ${tema.borde} !important;
    }
    .ve-rate-pill.active-bcv {
      background-color: ${tema.primario} !important;
      border-color: ${tema.primario} !important;
      color: #ffffff !important;
    }
    .ve-nav-btn.active {
      background-color: ${tema.primario} !important;
      color: #ffffff !important;
    }
    .ve-mob-btn.active {
      color: ${tema.primario} !important;
      font-weight: 800 !important;
    }
    .bg-slate-950 {
      background-color: ${tema.primario} !important;
    }
    .hover\\:bg-slate-800:hover {
      background-color: ${tema.primarioSuave} !important;
    }
    .bg-emerald-600 {
      background-color: ${tema.acento} !important;
    }
    .text-emerald-700, .text-emerald-800 {
      color: ${tema.acento} !important;
    }
  `;
}

function sincronizarLogoBarraLateral(logoPlataforma, nombreEmpresa = "VE") {
  const sidebarLogo = document.querySelector(".ve-brand-logo");
  const sidebarBadge = document.getElementById("brandLogoWrap");

  if (logoPlataforma) {
    if (sidebarLogo) {
      sidebarLogo.src = logoPlataforma;
    } else if (sidebarBadge) {
      sidebarBadge.outerHTML = `<img src="${logoPlataforma}" alt="Logo Plataforma" class="ve-brand-logo" />`;
    }
  } else if (sidebarLogo) {
    const iniciales = String(nombreEmpresa || "VE").slice(0, 2).toUpperCase();
    sidebarLogo.outerHTML = `<div id="brandLogoWrap" class="ve-brand-badge">${iniciales}</div>`;
  }
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

  let temaSeleccionado = state.empresa?.temaColor || TEMA_PREDETERMINADO;
  let logoPlataforma =
    state.empresa?.logoPlataformaBase64 || state.empresa?.logoBase64 || state.empresa?.logoUrl || "";
  let logoDocumento = state.empresa?.logoDocumentoBase64 || "";

  aplicarTemaVisual(temaSeleccionado, state);

  root.innerHTML = `
    <div class="space-y-5 max-w-5xl mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Configuración y Personalización</h1>
          <p class="text-xs text-slate-500">
            Ajusta el tema de color, sube o quita tus logos PNG y define el respaldo automático para documentos PDF.
          </p>
        </div>
        <button id="btnRestablecerTema" type="button" class="px-3.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-extrabold cursor-pointer">
          ↺ Restablecer Tema Predeterminado
        </button>
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
          <div class="flex items-center justify-between gap-2">
            <div class="text-xs font-extrabold uppercase tracking-wider text-slate-500">
              Logo de la Plataforma
            </div>
            <button id="btnQuitarLogoPlat" type="button" class="text-[11px] font-extrabold text-rose-600 hover:underline cursor-pointer">
              Quitar logo
            </button>
          </div>
          <div id="boxPrevPlat" class="h-28 rounded-xl bg-slate-50 border border-dashed border-slate-300 flex items-center justify-center p-3"></div>
          <input id="inpPngPlat" type="file" accept="image/png,.png" class="hidden" />
          <button id="btnSubirPngPlat" type="button" class="w-full py-2.5 rounded-xl bg-slate-950 hover:bg-slate-800 text-white text-xs font-extrabold cursor-pointer">
            ↑ Subir PNG Logo Plataforma
          </button>
        </div>

        <div class="ve-card space-y-3">
          <div class="flex items-center justify-between gap-2">
            <div class="text-xs font-extrabold uppercase tracking-wider text-slate-500">
              Logo Nota de Entrega / Cotización
            </div>
            <button id="btnQuitarLogoDoc" type="button" class="text-[11px] font-extrabold text-rose-600 hover:underline cursor-pointer">
              Quitar logo
            </button>
          </div>
          <div id="boxPrevDoc" class="h-28 rounded-xl bg-slate-50 border border-dashed border-slate-300 flex items-center justify-center p-3"></div>
          <p id="notaRespaldoDoc" class="text-[11px] text-slate-500"></p>
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

  function renderVistasLogos() {
    const boxPlat = root.querySelector("#boxPrevPlat");
    boxPlat.innerHTML = logoPlataforma
      ? `<img id="prevLogoPlat" src="${logoPlataforma}" alt="Logo Plataforma" class="max-h-20 max-w-full object-contain" />`
      : `<span id="prevLogoPlat" class="text-xs font-bold text-slate-400">Sin PNG de plataforma</span>`;

    const logoEfectivoDoc = logoDocumento || logoPlataforma;
    const boxDoc = root.querySelector("#boxPrevDoc");
    boxDoc.innerHTML = logoEfectivoDoc
      ? `<img id="prevLogoDoc" src="${logoEfectivoDoc}" alt="Logo Documento" class="max-h-20 max-w-full object-contain" />`
      : `<span id="prevLogoDoc" class="text-xs font-bold text-slate-400">Sin PNG configurado</span>`;

    const notaDoc = root.querySelector("#notaRespaldoDoc");
    if (logoDocumento) {
      notaDoc.textContent = "Usando PNG propio para Notas de Entrega y Cotizaciones.";
    } else if (logoPlataforma) {
      notaDoc.textContent = "Sin PNG propio de documento: se mostrará automáticamente el logo de la plataforma para no dejarlo vacío.";
    } else {
      notaDoc.textContent = "Si cargas el logo de la plataforma y dejas este vacío, se usará el de la plataforma automáticamente.";
    }
  }

  marcarTemaUI();
  renderVistasLogos();

  root.querySelectorAll(".tema-card").forEach((card) => {
    card.addEventListener("click", () => {
      temaSeleccionado = card.dataset.tema;
      marcarTemaUI();
      aplicarTemaVisual(temaSeleccionado, state);
    });
  });

  root.querySelector("#btnRestablecerTema").addEventListener("click", () => {
    temaSeleccionado = TEMA_PREDETERMINADO;
    marcarTemaUI();
    aplicarTemaVisual(temaSeleccionado, state);
  });

  root.querySelector("#btnQuitarLogoPlat").addEventListener("click", () => {
    logoPlataforma = "";
    renderVistasLogos();
  });

  root.querySelector("#btnQuitarLogoDoc").addEventListener("click", () => {
    logoDocumento = "";
    renderVistasLogos();
  });

  const inpPlat = root.querySelector("#inpPngPlat");
  const inpDoc = root.querySelector("#inpPngDoc");

  root.querySelector("#btnSubirPngPlat").addEventListener("click", () => inpPlat.click());
  root.querySelector("#btnSubirPngDoc").addEventListener("click", () => inpDoc.click());

  inpPlat.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      logoPlataforma = await leerPngComoBase64(file);
      renderVistasLogos();
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
      renderVistasLogos();
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
          logoBase64: logoPlataforma,
          actualizadoEn: serverTimestamp()
        },
        { merge: true }
      );

      if (state.empresa) {
        state.empresa.temaColor = temaSeleccionado;
        state.empresa.logoPlataformaBase64 = logoPlataforma;
        state.empresa.logoDocumentoBase64 = logoDocumento;
        state.empresa.logoBase64 = logoPlataforma;
      }

      aplicarTemaVisual(temaSeleccionado, state);
      sincronizarLogoBarraLateral(logoPlataforma, state.empresa?.nombre || state.sesion?.nombreEmpresa);
      renderVistasLogos();

      alert("Personalización guardada correctamente.");
    } catch (err) {
      alert("Error guardando configuración: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Guardar Tema y Logos";
    }
  });
}
