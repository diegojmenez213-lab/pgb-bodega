// venezuela/core/router.js
let moduloActual = null;
let cleanupActual = null;

export const RUTAS_VE = {
  catalogo: { titulo: "Catálogo & Stock", archivo: "../modules/catalogo.js" },
  "caja-pos": { titulo: "Caja / Notas de Entrega", archivo: "../modules/caja-pos.js" },
  cotizaciones: { titulo: "Cotizaciones (72h)", archivo: "../modules/cotizaciones.js" },
  "inventario-planta": { titulo: "Planta & Novedades", archivo: "../modules/inventario-planta.js" },
  "conteo-bodega": { titulo: "Conteo Digital Almacén", archivo: "../modules/conteo-bodega.js" },
  clientes: { titulo: "Clientes Inteligentes", archivo: "../modules/clientes.js" },
  analitica: { titulo: "Analítica & Ganancias", archivo: "../modules/analitica.js" },
  "pedido-sugerido": { titulo: "Pedido Sugerido", archivo: "../modules/pedido-sugerido.js" }
};

export async function cargarModulo(nombre, contenedor, contexto) {
  const ruta = RUTAS_VE[nombre];
  if (!ruta || !contenedor) return;

  if (typeof cleanupActual === "function") {
    try { cleanupActual(); } catch {}
    cleanupActual = null;
  }

  moduloActual = nombre;
  marcarNavegacionActiva(nombre);

  const tituloEl = document.getElementById("ve-modulo-titulo");
  if (tituloEl) tituloEl.textContent = ruta.titulo;

  contenedor.innerHTML = `
    <div class="flex items-center justify-center py-16 text-slate-400 text-xs font-semibold gap-2">
      <span class="w-4 h-4 border-2 border-slate-300 border-t-slate-900 rounded-full animate-spin"></span>
      Cargando ${ruta.titulo}...
    </div>
  `;

  try {
    const mod = await import(`${ruta.archivo}?v=1`);
    if (typeof mod.mount === "function") {
      cleanupActual = await mod.mount(contenedor, contexto);
    } else {
      throw new Error("El módulo no exporta la función mount()");
    }
  } catch (err) {
    contenedor.innerHTML = `
      <div class="bg-white border border-slate-200 rounded-2xl p-8 max-w-xl mx-auto text-
