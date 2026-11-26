// venezuela/modules/configuracion-logos.js
import { getTenantRefs, setDoc, serverTimestamp } from "../core/db.js";

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

  let logoPlataforma =
    state.empresa?.logoPlataformaBase64 || state.empresa?.logoBase64 || state.empresa?.logoUrl || "";
  let logoDocumento =
    state.empresa?.logoDocumentoBase64 || state.empresa?.logoBase64 || state.empresa?.logoUrl || "";

  root.innerHTML = `
    <div class="space-y-4 max-w-4xl mx-auto">
      <div>
        <h1 class="text-lg font-extrabold text-slate-900">Logos de la Empresa (PNG)</h1>
        <p class="text-xs text-slate-500">
          Configura por separado el logo del encabezado/barra lateral y el logo que saldrá en Cotizaciones y Notas de Entrega.
        </p>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <!-- Logo Plataforma -->
        <div class="ve-card space-y-3">
          <div class="text-xs font-extrabold uppercase tracking-wider text-slate-500">
            Encabezado / Plataforma
          </div>
          <div class="h-28 rounded-xl bg-slate-50 border border-dashed border-slate-300 flex items-center justify-center p-3">
            ${
              logoPlataforma
                ? `<img id="prevLogoPlat" src="${logoPlataforma}" alt="Logo Plataforma" class="max-h-20 max-w-full object-contain" />`
                : `<span id="prevLogoPlatTxt" class="text-xs font-bold text-slate-400">Sin PNG de plataforma</span>`
            }
          </div>
          <input id="inpPngPlat" type="file" accept="image/png,.png" class="hidden" />
          <button id="btnSubirPngPlat" type="button" class="w-full py-2.5 rounded-xl bg-slate-950 hover:bg-slate-800 text-white text-xs font-extrabold cursor-pointer">
            ↑ Subir PNG Logo Plataforma
          </button>
        </div>

        <!-- Logo Nota de Entrega / Cotización -->
        <div class="ve-card space-y-3">
          <div class="text-xs font-extrabold uppercase tracking-wider text-slate-500">
            Nota de Entrega / Cotización (PDF)
          </div>
          <div class="h-28 rounded-xl bg-slate-50 border border-dashed border-slate-300 flex items-center justify-center p-3">
            ${
              logoDocumento
                ? `<img id="prevLogoDoc" src="${logoDocumento}" alt="Logo Documento" class="max-h-20 max-w-full object-contain" />`
                : `<span id="prevLogoDocTxt" class="text-xs font-bold text-slate-400">Sin PNG para notas/cotizaciones</span>`
            }
          </div>
          <input id="inpPngDoc" type="file" accept="image/png,.png" class="hidden" />
          <button id="btnSubirPngDoc" type="button" class="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold cursor-pointer">
            ↑ Subir PNG Logo Nota de Entrega / Cotización
          </button>
        </div>
      </div>

      <div class="flex justify-end">
        <button id="btnGuardarLogos" type="button" class="px-5 py-2.5 rounded-xl bg-slate-950 hover:bg-slate-800 text-white text-xs font-extrabold cursor-pointer">
          Guardar Ambos Logos
        </button>
      </div>
    </div>
  `;

  const inpPlat = root.querySelector("#inpPngPlat");
  const inpDoc = root.querySelector("#inpPngDoc");

  function refrescarVistaPrevia(contenedorId, dataUrl, altTxt) {
    const box = root.querySelector(contenedorId).parentElement;
    box.innerHTML = dataUrl
      ? `<img id="${contenedorId.slice(1)}" src="${dataUrl}" alt="${altTxt}" class="max-h-20 max-w-full object-contain" />`
      : `<span id="${contenedorId.slice(1)}" class="text-xs font-bold text-slate-400">Sin PNG</span>`;
  }

  root.querySelector("#btnSubirPngPlat").addEventListener("click", () => inpPlat.click());
  root.querySelector("#btnSubirPngDoc").addEventListener("click", () => inpDoc.click());

  inpPlat.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      logoPlataforma = await leerPngComoBase64(file);
      refrescarVistaPrevia("#prevLogoPlat", logoPlataforma, "Logo Plataforma");
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
      refrescarVistaPrevia("#prevLogoDoc", logoDocumento, "Logo Documento");
    } catch (err) {
      alert(err.message);
    }
  });

  root.querySelector("#btnGuardarLogos").addEventListener("click", async () => {
    const btn = root.querySelector("#btnGuardarLogos");
    btn.disabled = true;
    btn.textContent = "Guardando...";

    try {
      await setDoc(
        refs.empresaRef,
        {
          logoPlataformaBase64: logoPlataforma,
          logoDocumentoBase64: logoDocumento,
          actualizadoEn: serverTimestamp()
        },
        { merge: true }
      );

      if (state.empresa) {
        state.empresa.logoPlataformaBase64 = logoPlataforma;
        state.empresa.logoDocumentoBase64 = logoDocumento;
      }

      const sidebarLogo = document.querySelector(".ve-brand-logo");
      const sidebarBadge = document.getElementById("brandLogoWrap");
      if (logoPlataforma) {
        if (sidebarLogo) {
          sidebarLogo.src = logoPlataforma;
        } else if (sidebarBadge) {
          sidebarBadge.outerHTML = `<img src="${logoPlataforma}" alt="Logo Plataforma" class="ve-brand-logo" />`;
        }
      }

      alert("Logos guardados: el de plataforma ya se ve arriba y el de documentos saldrá en PDFs.");
    } catch (err) {
      alert("Error guardando logos: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Guardar Ambos Logos";
    }
  });
}
