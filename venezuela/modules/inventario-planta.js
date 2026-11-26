// venezuela/modules/inventario-planta.js
import {
  db,
  getTenantRefs,
  doc,
  getDocs,
  updateDoc,
  runTransaction,
  increment,
  serverTimestamp
} from "../core/db.js";
import { abrirDocumentoPDF } from "./documentos-pdf.js";

const METODOS_PAGO = [
  "Efectivo USD",
  "Pago Móvil Bs.",
  "Transferencia Bs.",
  "Zelle",
  "Binance USDT",
  "Punto de Venta Bs.",
  "Efectivo Bs."
];

function formatearEntradaMoneda(inputEl) {
  const digitos = String(inputEl.value || "").replace(/\D/g, "");
  const centavos = parseInt(digitos || "0", 10);
  const valor = Number((centavos / 100).toFixed(2));
  const texto = valor.toFixed(2);
  inputEl.value = texto;
  requestAnimationFrame(() => {
    try {
      inputEl.setSelectionRange(texto.length, texto.length);
    } catch {}
  });
  return valor;
}

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);

  root.innerHTML = `
    <div class="space-y-4 max-w-6xl mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Ventas Realizadas / Notas de Entrega</h1>
          <p class="text-xs text-slate-500">Consulta notas emitidas, genera PDF o edita notas del día en curso (antes del cierre).</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <input id="busqNotas" type="text" placeholder="Buscar folio, cliente o RIF..." class="bg-white border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold" />
          <button id="btnRecargarNotas" type="button" class="px-3 py-2 rounded-xl bg-slate-950 text-white text-xs font-extrabold cursor-pointer">
            ↻ Actualizar
          </button>
        </div>
      </div>

      <!-- Modal / Panel de Edición para notas del día en curso -->
      <div id="panelEditarNota" class="hidden ve-card border-2 border-sky-400 bg-sky-50/40 p-4 space-y-3">
        <div class="flex items-center justify-between gap-2 border-b border-sky-200 pb-2">
          <div>
            <div class="text-[10px] font-extrabold uppercase tracking-wider text-sky-900">Edición en Jornada Activa</div>
            <h2 id="titEditarNota" class="text-sm font-extrabold text-slate-950">Editando Nota #---</h2>
          </div>
          <button id="btnCerrarEditarNota" type="button" class="px-2.5 py-1 rounded-lg bg-white border border-slate-300 text-xs font-extrabold cursor-pointer">
            ✕ Cancelar
          </button>
        </div>

        <div id="listaItemsEditar" class="space-y-2 max-h-72 overflow-y-auto"></div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2 border-t border-sky-200">
          <div>
            <label class="text-[10px] font-extrabold text-slate-600 block">Condición</label>
            <select id="editCondicion" class="w-full bg-white border border-slate-300 rounded-xl px-2.5 py-1.5 text-xs font-bold">
              <option value="contado">Contado</option>
              <option value="credito">Crédito</option>
            </select>
          </div>
          <div>
            <label class="text-[10px] font-extrabold text-slate-600 block">Días Crédito</label>
            <input id="editDiasCredito" type="number" min="1" max="365" value="15" class="w-full bg-white border border-slate-300 rounded-xl px-2.5 py-1.5 text-xs font-mono-ve font-bold" />
          </div>
          <div class="text-right">
            <div class="text-[10px] font-extrabold text-slate-500">NUEVO TOTAL USD</div>
            <div id="editTotalUsd" class="text-base font-mono-ve font-extrabold text-slate-950">$0.00</div>
          </div>
        </div>

        <div class="space-y-1.5 pt-2 border-t border-sky-200">
          <div class="flex items-center justify-between">
            <span class="text-[11px] font-extrabold text-slate-700">Pagos / Abonos</span>
            <button id="btnAddPagoEdit" type="button" class="text-[11px] font-extrabold text-sky-900 hover:underline cursor-pointer">+ Agregar pago</button>
          </div>
          <div id="editPagosLista" class="space-y-1.5"></div>
        </div>

        <div class="flex justify-end gap-2 pt-2">
          <button id="btnGuardarEdicionNota" type="button" class="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold cursor-pointer">
            ✓ Guardar Cambios en la Nota
          </button>
        </div>
      </div>

      <div id="listaNotas" class="space-y-2.5">
        <div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">Cargando notas...</div>
      </div>
    </div>
  `;

  let notas = [];
  let notaEnEdicion = null;
  let itemsEdicion = [];
  let pagosEdicion = [];
  let guardandoEdicion = false;

  const hoyIso = new Date().toISOString().slice(0, 10);
  const jornadaActivaId = state.empresa?.jornadaActivaId || hoyIso;

  function esEditableHoy(n) {
    if (!n || n.anulada || n.cierreId) return false;
    const mismaFecha = (n.fechaIso || "") === hoyIso;
    const mismaJornada = n.jornadaId && n.jornadaId === jornadaActivaId;
    return Boolean(mismaFecha || mismaJornada);
  }

  function calcularTotalEdicion() {
    const tot = Number(
      itemsEdicion.reduce((acc, it) => acc + Number(it.cantidad || 0) * Number(it.precioUsd || 0), 0).toFixed(2)
    );
    root.querySelector("#editTotalUsd").textContent = `$${tot.toFixed(2)}`;
    return tot;
  }

  function renderItemsEdicion() {
    const cont = root.querySelector("#listaItemsEditar");
    if (!itemsEdicion.length) {
      cont.innerHTML = `<div class="text-xs text-rose-700 font-bold py-3 text-center">La nota debe tener al menos 1 ítem.</div>`;
      calcularTotalEdicion();
      return;
    }

    cont.innerHTML = itemsEdicion.map((it, idx) => `
      <div class="p-2.5 rounded-xl bg-white border border-slate-200 flex flex-wrap items-center justify-between gap-2" data-eidx="${idx}">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="font-mono-ve text-xs font-extrabold text-slate-900">${it.codigo || it.id}</span>
            <span class="text-[9px] font-extrabold px-1.5 py-0.5 rounded-full ${
              it.origen === "planta" ? "bg-sky-100 text-sky-900" : "bg-emerald-100 text-emerald-800"
            }">${(it.origen || "almacen").toUpperCase()}</span>
          </div>
          <div class="text-[11px] font-semibold text-slate-600 truncate">${it.descripcion || ""}</div>
        </div>
        <div class="flex items-center gap-1.5">
          <label class="text-[10px] font-bold text-slate-500">Cant:</label>
          <input type="number" min="1" value="${it.cantidad}" class="inp-ecant w-16 bg-slate-50 border border-slate-300 rounded-lg px-1.5 py-1 text-xs font-mono-ve font-extrabold text-center" />
          <label class="text-[10px] font-bold text-slate-500">$/u:</label>
          <input type="text" inputmode="numeric" value="${Number(it.precioUsd || 0).toFixed(2)}" class="inp-eprec w-20 bg-slate-50 border border-slate-300 rounded-lg px-1.5 py-1 text-xs font-mono-ve font-bold text-right" />
          <button type="button" class="btn-erm-item text-xs font-bold text-rose-600 px-1.5 cursor-pointer">✕</button>
        </div>
      </div>
    `).join("");
    calcularTotalEdicion();
  }

  function renderPagosEdicion() {
    const cont = root.querySelector("#editPagosLista");
    cont.innerHTML = pagosEdicion.map((p, idx) => `
      <div class="flex items-center gap-1.5" data-epidx="${idx}">
        <select class="sel-emet flex-1 min-w-0 bg-white border border-slate-300 rounded-lg px-2 py-1.5 text-xs font-bold">
          ${METODOS_PAGO.map((m) => `<option value="${m}" ${p.metodo === m ? "selected" : ""}>${m}</option>`).join("")}
        </select>
        <input type="text" value="${p.referencia || ""}" placeholder="Ref." class="inp-epref w-16 bg-white border border-slate-300 rounded-lg px-1.5 py-1.5 text-[11px] font-mono-ve font-bold" />
        <input type="text" inputmode="numeric" value="${Number(p.montoUsd || 0).toFixed(2)}" class="inp-epmonto w-24 bg-white border border-slate-300 rounded-lg px-2 py-1.5 text-xs font-mono-ve font-bold text-right" />
        ${pagosEdicion.length > 1 ? `<button type="button" class="btn-erm-pago text-xs font-bold text-rose-600 px-1 cursor-pointer">✕</button>` : ""}
      </div>
    `).join("");
  }

  function abrirEdicionNota(n) {
    if (!esEditableHoy(n)) {
      return alert("Solo se pueden editar notas del día en curso que no estén anuladas ni cerradas.");
    }
    notaEnEdicion = n;
    itemsEdicion = (n.items || []).map((it) => ({ ...it }));
    pagosEdicion = (n.pagos && n.pagos.length)
      ? n.pagos.map((p) => ({ ...p }))
      : [{ metodo: "Efectivo USD", montoUsd: 0, referencia: "" }];

    root.querySelector("#titEditarNota").textContent = `Editando Nota #${n.folio || n.id} (${n.cliente?.nombre || "Consumidor Final"})`;
    root.querySelector("#editCondicion").value = n.esCredito ? "credito" : "contado";
    root.querySelector("#editDiasCredito").value = Number(n.diasCredito || 15);
    root.querySelector("#panelEditarNota").classList.remove("hidden");
    renderItemsEdicion();
    renderPagosEdicion();
    root.querySelector("#panelEditarNota").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function cerrarEdicionNota() {
    notaEnEdicion = null;
    itemsEdicion = [];
    pagosEdicion = [];
    root.querySelector("#panelEditarNota").classList.add("hidden");
  }

  root.querySelector("#btnCerrarEditarNota").addEventListener("click", cerrarEdicionNota);

  root.querySelector("#listaItemsEditar").addEventListener("input", (e) => {
    const row = e.target.closest("[data-eidx]");
    if (!row) return;
    const idx = Number(row.dataset.eidx);
    if (e.target.classList.contains("inp-ecant")) {
      itemsEdicion[idx].cantidad = Math.max(1, parseInt(e.target.value, 10) || 1);
    } else if (e.target.classList.contains("inp-eprec")) {
      itemsEdicion[idx].precioUsd = formatearEntradaMoneda(e.target);
    }
    calcularTotalEdicion();
  });

  root.querySelector("#listaItemsEditar").addEventListener("click", (e) => {
    if (!e.target.closest(".btn-erm-item")) return;
    const row = e.target.closest("[data-eidx]");
    if (!row) return;
    itemsEdicion.splice(Number(row.dataset.eidx), 1);
    renderItemsEdicion();
  });

  root.querySelector("#editPagosLista").addEventListener("change", (e) => {
    const row = e.target.closest("[data-epidx]");
    if (!row) return;
    const idx = Number(row.dataset.epidx);
    if (e.target.classList.contains("sel-emet")) pagosEdicion[idx].metodo = e.target.value;
  });

  root.querySelector("#editPagosLista").addEventListener("input", (e) => {
    const row = e.target.closest("[data-epidx]");
    if (!row) return;
    const idx = Number(row.dataset.epidx);
    if (e.target.classList.contains("inp-epmonto")) {
      pagosEdicion[idx].montoUsd = formatearEntradaMoneda(e.target);
    } else if (e.target.classList.contains("inp-epref")) {
      pagosEdicion[idx].referencia = e.target.value.trim();
    }
  });

  root.querySelector("#editPagosLista").addEventListener("click", (e) => {
    if (!e.target.closest(".btn-erm-pago")) return;
    const row = e.target.closest("[data-epidx]");
    if (!row) return;
    pagosEdicion.splice(Number(row.dataset.epidx), 1);
    renderPagosEdicion();
  });

  root.querySelector("#btnAddPagoEdit").addEventListener("click", () => {
    if (pagosEdicion.length >= 4) return alert("Máximo 4 formas de pago.");
    pagosEdicion.push({ metodo: "Pago Móvil Bs.", montoUsd: 0, referencia: "" });
    renderPagosEdicion();
  });

  root.querySelector("#btnGuardarEdicionNota").addEventListener("click", async () => {
    if (guardandoEdicion || !notaEnEdicion) return;
    if (!itemsEdicion.length) return alert("Agrega al menos un producto a la nota.");
    if (!esEditableHoy(notaEnEdicion)) {
      return alert("Esta nota ya no pertenece a la jornada activa o ya está cerrada.");
    }

    const totalUsd = calcularTotalEdicion();
    const esCre = root.querySelector("#editCondicion").value === "credito";
    const diasCre = Math.max(1, parseInt(root.querySelector("#editDiasCredito").value, 10) || 15);
    const tasa = Number(notaEnEdicion.tasaBcvUsada || state.tasas?.bcvHoy || 0);

    const pagosLimpios = pagosEdicion
      .filter((p) => Number(p.montoUsd) > 0)
      .map((p) => ({
        metodo: p.metodo,
        montoUsd: Number(Number(p.montoUsd).toFixed(2)),
        montoBs: tasa ? Number((Number(p.montoUsd) * tasa).toFixed(2)) : 0,
        referencia: String(p.referencia || "").trim()
      }));

    const pagadoHoy = Number(pagosLimpios.reduce((acc, p) => acc + p.montoUsd, 0).toFixed(2));
    const descFavor = Number(notaEnEdicion.saldoFavorAplicadoUsd || 0);
    const objetivoHoy = Math.max(0, Number((totalUsd - descFavor).toFixed(2)));
    const restante = Math.max(0, Number((objetivoHoy - pagadoHoy).toFixed(2)));

    if (!esCre && restante > 0.01) {
      return alert(`Faltan $${restante.toFixed(2)} por cubrir o cambia la condición a Crédito.`);
    }

    guardandoEdicion = true;
    const btn = root.querySelector("#btnGuardarEdicionNota");
    btn.disabled = true;
    btn.textContent = "Guardando...";

    try {
      const notaRef = doc(refs.notasEntrega(), notaEnEdicion.id);
      const anteriores = notaEnEdicion.items || [];

      await runTransaction(db, async (tx) => {
        const snap = await tx.get(notaRef);
        if (!snap.exists()) throw new Error("La nota no existe.");
        const actualData = snap.data();
        if (actualData.anulada || actualData.cierreId) {
          throw new Error("La nota ya fue anulada o cerrada.");
        }

        // 1. Revertir efecto anterior en catálogo
        for (const oldIt of anteriores) {
          const idProd = oldIt.prodId || oldIt.id;
          if (!idProd) continue;
          const cantOld = Number(oldIt.cantidad || 0);
          if (cantOld <= 0) continue;
          if (oldIt.origen === "almacen") {
            tx.set(doc(refs.catalogo(), idProd), { stockAlmacen: increment(cantOld) }, { merge: true });
          } else {
            tx.set(doc(refs.catalogo(), idProd), { pedidosPlantaCount: increment(-cantOld) }, { merge: true });
          }
        }

        // 2. Aplicar nuevo efecto en catálogo
        for (const newIt of itemsEdicion) {
          const idProd = newIt.prodId || newIt.id;
          if (!idProd) continue;
          const cantNew = Number(newIt.cantidad || 0);
          if (cantNew <= 0) continue;
          if (newIt.origen === "almacen") {
            tx.set(doc(refs.catalogo(), idProd), { stockAlmacen: increment(-cantNew) }, { merge: true });
          } else {
            tx.set(doc(refs.catalogo(), idProd), { pedidosPlantaCount: increment(cantNew) }, { merge: true });
          }
        }

        const costoTotalUsd = Number(
          itemsEdicion.reduce((acc, it) => acc + Number(it.cantidad || 0) * Number(it.costoUsd || 0), 0).toFixed(2)
        );
        const utilidadUsd = Number((totalUsd - costoTotalUsd).toFixed(2));
        const saldoPendienteUsd = esCre ? restante : 0;

        tx.update(notaRef, {
          items: itemsEdicion,
          pagos: pagosLimpios,
          totalUsd,
          costoTotalUsd,
          utilidadUsd,
          esCredito: esCre && saldoPendienteUsd > 0.01,
          diasCredito: esCre ? diasCre : 0,
          saldoPendienteUsd,
          editadaEn: serverTimestamp(),
          editadaPor: state.sesion.usuario || "Administrador"
        });
      });

      cerrarEdicionNota();
      await cargarNotas();
      if (typeof window.NEXUS_VE_REFRESH_ALERTAS === "function") {
        await window.NEXUS_VE_REFRESH_ALERTAS();
      }
      alert("✓ Nota actualizada correctamente.");
    } catch (err) {
      alert("No se pudo editar la nota: " + err.message);
    } finally {
      guardandoEdicion = false;
      btn.disabled = false;
      btn.textContent = "✓ Guardar Cambios en la Nota";
    }
  });

  function renderLista() {
    const q = root.querySelector("#busqNotas").value.trim().toLowerCase();
    const cont = root.querySelector("#listaNotas");

    const filtradas = notas.filter((n) => {
      if (!q) return true;
      return `${n.folio || ""} ${n.cliente?.nombre || ""} ${n.cliente?.documento || ""}`.toLowerCase().includes(q);
    });

    if (!filtradas.length) {
      cont.innerHTML = `<div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">No hay notas de entrega registradas.</div>`;
      return;
    }

    cont.innerHTML = filtradas.map((n) => {
      const editable = esEditableHoy(n);
      const fechaTxt = n.fechaIso || (n.creadoTs ? new Date(n.creadoTs).toISOString().slice(0, 10) : "---");
      return `
        <div class="ve-card p-3.5 space-y-2 ${n.anulada ? "opacity-60" : ""}" data-nid="${n.id}">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-mono-ve text-xs font-extrabold text-slate-950">#${n.folio || n.id}</span>
                <span class="text-[10px] font-bold text-slate-500">${fechaTxt}</span>
                ${n.anulada ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-rose-100 text-rose-800">ANULADA</span>` : ""}
                ${n.cierreId ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-slate-200 text-slate-700">CERRADA</span>` : ""}
                ${n.esCredito && Number(n.saldoPendienteUsd || 0) > 0.01
                  ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-amber-100 text-amber-900">Pendiente: $${Number(n.saldoPendienteUsd).toFixed(2)}</span>`
                  : ""}
              </div>
              <div class="text-xs font-extrabold text-slate-800 mt-0.5">${n.cliente?.nombre || "Consumidor Final"} (${n.cliente?.documento || "---"})</div>
            </div>

            <div class="flex items-center gap-2">
              <div class="text-right mr-1">
                <div class="font-mono-ve text-sm font-extrabold text-slate-950">$${Number(n.totalUsd || 0).toFixed(2)}</div>
                <div class="font-mono-ve text-[10px] text-slate-500">${(n.items || []).length} ítem(s)</div>
              </div>
              ${editable ? `
                <button type="button" class="btn-editar-nota px-3 py-1.5 rounded-xl bg-sky-700 hover:bg-sky-800 text-white text-xs font-extrabold cursor-pointer">
                  ✎ Editar
                </button>
              ` : ""}
              <button type="button" class="btn-pdf-nota px-3 py-1.5 rounded-xl bg-slate-950 hover:bg-slate-800 text-white text-xs font-extrabold cursor-pointer">
                PDF
              </button>
              ${!n.anulada && !n.cierreId ? `
                <button type="button" class="btn-anular-nota px-2.5 py-1.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-bold cursor-pointer">
                  Anular
                </button>
              ` : ""}
            </div>
          </div>
        </div>
      `;
    }).join("");
  }

  root.querySelector("#listaNotas").addEventListener("click", async (e) => {
    const card = e.target.closest("[data-nid]");
    if (!card) return;
    const nota = notas.find((x) => x.id === card.dataset.nid);
    if (!nota) return;

    if (e.target.closest(".btn-editar-nota")) {
      abrirEdicionNota(nota);
    } else if (e.target.closest(".btn-pdf-nota")) {
      abrirDocumentoPDF("nota", nota, state);
    } else if (e.target.closest(".btn-anular-nota")) {
      if (!confirm(`¿Anular la Nota #${nota.folio || nota.id}? Se devolverá el stock de Almacén.`)) return;
      await runTransaction(db, async (tx) => {
        const nRef = doc(refs.notasEntrega(), nota.id);
        const snap = await tx.get(nRef);
        if (!snap.exists() || snap.data().anulada) return;
        for (const it of snap.data().items || []) {
          const idProd = it.prodId || it.id;
          const cant = Number(it.cantidad || 0);
          if (idProd && cant > 0 && it.origen === "almacen") {
            tx.set(doc(refs.catalogo(), idProd), { stockAlmacen: increment(cant) }, { merge: true });
          }
        }
        tx.update(nRef, { anulada: true, saldoPendienteUsd: 0, anuladaEn: serverTimestamp() });
      });
      await cargarNotas();
      if (typeof window.NEXUS_VE_REFRESH_ALERTAS === "function") {
        await window.NEXUS_VE_REFRESH_ALERTAS();
      }
    }
  });

  async function cargarNotas() {
    const snap = await getDocs(refs.notasEntrega());
    notas = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => Number(b.creadoTs || 0) - Number(a.creadoTs || 0));
    renderLista();
  }

  root.querySelector("#busqNotas").addEventListener("input", renderLista);
  root.querySelector("#btnRecargarNotas").addEventListener("click", cargarNotas);

  await cargarNotas();
}
