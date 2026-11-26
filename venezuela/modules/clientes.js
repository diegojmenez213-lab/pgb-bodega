// venezuela/modules/clientes.js
import {
  getTenantRefs,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  normalizarIdVE,
  serverTimestamp
} from "../core/db.js";

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);
  const fMayor = Number(state.empresa?.precios?.factorMayor) || 2.0;
  const fDetal = Number(state.empresa?.precios?.factorDetal) || 2.5;

  root.innerHTML = `
    <div class="space-y-4 max-w-5xl mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Clientes y Tarifas</h1>
          <p class="text-xs text-slate-500">Asigna multiplicadores discretos por cliente para Caja y Cotizaciones.</p>
        </div>
        <button id="btnNuevoCliente" class="px-3.5 py-2 rounded-xl bg-slate-950 hover:bg-slate-800 text-white text-xs font-extrabold cursor-pointer">
          + Nuevo Cliente
        </button>
      </div>

      <!-- Formulario crear/editar -->
      <form id="formCliente" class="ve-card space-y-3 hidden">
        <div class="flex items-center justify-between">
          <div id="tituloFormCli" class="text-xs font-extrabold uppercase tracking-wider text-slate-500">Nuevo Cliente</div>
          <button type="button" id="btnCancelarCli" class="text-xs font-bold text-slate-500 cursor-pointer">Cerrar ✕</button>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label class="text-[11px] font-bold text-slate-600 block mb-1">Cédula o RIF *</label>
            <input id="cliDoc" type="text" placeholder="Ej: V-20504570 o J-50343856-8" class="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold uppercase" required />
          </div>
          <div>
            <label class="text-[11px] font-bold text-slate-600 block mb-1">Nombre / Razón Social *</label>
            <input id="cliNombre" type="text" placeholder="Nombre del cliente o taller" class="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold" required />
          </div>
          <div>
            <label class="text-[11px] font-bold text-slate-600 block mb-1">Teléfono / WhatsApp</label>
            <input id="cliTel" type="text" placeholder="0414-0000000" class="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-semibold" />
          </div>
          <div>
            <label class="text-[11px] font-bold text-slate-600 block mb-1">Dirección</label>
            <input id="cliDir" type="text" placeholder="Ciudad / Zona" class="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-semibold" />
          </div>
          <div>
            <label class="text-[11px] font-bold text-slate-600 block mb-1">Tarifa Asignada</label>
            <select id="cliTarifa" class="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold">
              <option value="detal">Detal (×${fDetal})</option>
              <option value="mayor">Mayor (×${fMayor})</option>
              <option value="especial">Especial (Factor personalizado)</option>
            </select>
          </div>
          <div id="wrapFactorEsp" class="hidden">
            <label class="text-[11px] font-bold text-slate-600 block mb-1">Factor Discreto (× sobre costo)</label>
            <input id="cliFactor" type="number" step="0.05" min="1" value="${fMayor}" class="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold" />
          </div>
        </div>

        <div class="flex justify-end gap-2 pt-1">
          <button type="submit" id="btnGuardarCli" class="px-4 py-2.5 rounded-xl bg-slate-950 text-white text-xs font-extrabold cursor-pointer">
            Guardar Cliente
          </button>
        </div>
      </form>

      <!-- Buscador -->
      <div class="ve-card p-3">
        <input id="busqCli" type="text" placeholder="Buscar cliente por Cédula/RIF, nombre o teléfono..." class="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold outline-none focus:border-slate-900" />
      </div>

      <!-- Lista -->
      <div id="listaClientes" class="space-y-2">
        <div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">Cargando clientes...</div>
      </div>
    </div>
  `;

  let clientes = [];
  let editId = null;

  const form = root.querySelector("#formCliente");
  const tarifaEl = root.querySelector("#cliTarifa");
  const wrapEsp = root.querySelector("#wrapFactorEsp");
  const listaEl = root.querySelector("#listaClientes");
  const busqEl = root.querySelector("#busqCli");

  tarifaEl.addEventListener("change", () => {
    wrapEsp.classList.toggle("hidden", tarifaEl.value !== "especial");
  });

  function abrirForm(cli = null) {
    editId = cli ? cli.id : null;
    root.querySelector("#tituloFormCli").textContent = cli ? `Editar Cliente (${cli.id})` : "Nuevo Cliente";
    root.querySelector("#cliDoc").value = cli ? cli.id : "";
    root.querySelector("#cliDoc").disabled = !!cli;
    root.querySelector("#cliNombre").value = cli?.nombre || "";
    root.querySelector("#cliTel").value = cli?.telefono || "";
    root.querySelector("#cliDir").value = cli?.direccion || "";
    tarifaEl.value = cli?.tarifa || "detal";
    root.querySelector("#cliFactor").value = cli?.factorPersonalizado || fMayor;
    wrapEsp.classList.toggle("hidden", tarifaEl.value !== "especial");
    form.classList.remove("hidden");
  }

  root.querySelector("#btnNuevoCliente").addEventListener("click", () => abrirForm(null));
  root.querySelector("#btnCancelarCli").addEventListener("click", () => form.classList.add("hidden"));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const docId = editId || normalizarIdVE(root.querySelector("#cliDoc").value);
    const nombre = root.querySelector("#cliNombre").value.trim();
    if (!docId || !nombre) return alert("Completa Cédula/RIF y Nombre.");

    const tarifa = tarifaEl.value;
    const factorPersonalizado = tarifa === "especial"
      ? Math.max(1, Number(root.querySelector("#cliFactor").value) || fMayor)
      : (tarifa === "mayor" ? fMayor : fDetal);

    const btn = root.querySelector("#btnGuardarCli");
    btn.disabled = true;
    btn.textContent = "Guardando...";

    try {
      await setDoc(doc(refs.clientes(), docId), {
        documento: docId,
        nombre,
        telefono: root.querySelector("#cliTel").value.trim(),
        direccion: root.querySelector("#cliDir").value.trim(),
        tarifa,
        factorPersonalizado,
        actualizadoEn: serverTimestamp()
      }, { merge: true });

      form.classList.add("hidden");
      await cargarClientes();
    } catch (err) {
      alert("Error guardando cliente: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Guardar Cliente";
    }
  });

  function render() {
    const q = busqEl.value.trim().toLowerCase();
    const filtrados = clientes.filter((c) => {
      if (!q) return true;
      return `${c.id} ${c.nombre || ""} ${c.telefono || ""}`.toLowerCase().includes(q);
    });

    if (!filtrados.length) {
      listaEl.innerHTML = `<div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">No hay clientes registrados.</div>`;
      return;
    }

    listaEl.innerHTML = filtrados.map((c) => `
      <div class="ve-card p-3.5 flex flex-wrap items-center justify-between gap-2" data-id="${c.id}">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-mono-ve text-xs font-extrabold text-slate-900">${c.id}</span>
            <span class="text-xs font-extrabold text-slate-800">${c.nombre || ""}</span>
            <span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full ${
              c.tarifa === "especial" ? "bg-amber-100 text-amber-800" : c.tarifa === "mayor" ? "bg-sky-100 text-sky-800" : "bg-slate-100 text-slate-600"
            }">
              ${c.tarifa === "especial" ? `Especial (×${c.factorPersonalizado})` : c.tarifa === "mayor" ? "Mayor" : "Detal"}
            </span>
          </div>
          <div class="text-[11px] text-slate-500 mt-0.5">
            ${c.telefono || "Sin teléfono"}${c.direccion ? ` • ${c.direccion}` : ""}
          </div>
        </div>
        <div class="flex items-center gap-1.5">
          <button type="button" class="btn-edit px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-xs font-bold cursor-pointer">Editar</button>
          <button type="button" class="btn-del px-2.5 py-1.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-bold cursor-pointer">✕</button>
        </div>
      </div>
    `).join("");
  }

  listaEl.addEventListener("click", async (e) => {
    const card = e.target.closest("[data-id]");
    if (!card) return;
    const id = card.dataset.id;
    const cli = clientes.find((c) => c.id === id);

    if (e.target.closest(".btn-edit") && cli) {
      abrirForm(cli);
    } else if (e.target.closest(".btn-del")) {
      if (!confirm(`¿Eliminar cliente ${cli?.nombre || id}?`)) return;
      await deleteDoc(doc(refs.clientes(), id));
      await cargarClientes();
    }
  });

  async function cargarClientes() {
    const snap = await getDocs(refs.clientes());
    clientes = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));
    render();
  }

  busqEl.addEventListener("input", render);
  await cargarClientes();
}
