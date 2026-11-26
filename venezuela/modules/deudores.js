// venezuela/modules/deudores.js
import {
  db,
  getTenantRefs,
  doc,
  getDocs,
  setDoc,
  writeBatch,
  normalizarIdVE,
  serverTimestamp
} from "../core/db.js";

const DIAS_30_MS = 30 * 24 * 60 * 60 * 1000;

export async function mount(root, state) {
  const refs = getTenantRefs(state.sesion.tenantId);

  root.innerHTML = `
    <div class="space-y-4 max-w-5xl mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 class="text-lg font-extrabold text-slate-900">Deudores Activos</h1>
          <p class="text-xs text-slate-500">Ordenados de la deuda más vieja a la más reciente. Alerta automática a los +30 días.</p>
        </div>
        <div class="text-right">
          <div class="text-[10px] font-extrabold text-slate-400">CARTERA POR COBRAR</div>
          <div id="totalCarteraUsd" class="text-lg font-extrabold font-mono-ve text-rose-700">$0.00</div>
        </div>
      </div>

      <!-- Aviso si hay deudores que no están en el catálogo de clientes -->
      <div id="alertaFueraCatalogo" class="hidden ve-card border-amber-300 bg-amber-50/70 space-y-2">
        <div class="text-xs font-extrabold text-amber-900">
          ⚠️ Hay deudores cuya cédula/RIF no está en el Catálogo de Clientes (o fue borrada)
        </div>
        <div id="listaFueraCatalogo" class="space-y-1.5"></div>
      </div>

      <!-- Lista de deudores -->
      <div id="listaDeudores" class="space-y-3">
        <div class="ve-card text-center py-10 text-xs text-slate-500 font-bold">Cargando deudores...</div>
      </div>
    </div>
  `;

  let deudoresAgrupados = [];
  let clientesMap = new Map();
  let todasNotas = [];

  function calcularAntiguedadDias(ts) {
    if (!ts) return 0;
    return Math.max(0, Math.floor((Date.now() - Number(ts)) / 86400000));
  }

  function render() {
    const totalCartera = deudoresAgrupados.reduce((acc, d) => acc + d.totalDeudaUsd, 0);
    root.querySelector("#totalCarteraUsd").textContent = `$${totalCartera.toFixed(2)}`;

    // Deudores fuera de catálogo de clientes
    const fuera = deudoresAgrupados.filter((d) => !d.enCatalogo);
    const boxFuera = root.querySelector("#alertaFueraCatalogo");
    const listFuera = root.querySelector("#listaFueraCatalogo");

    if (fuera.length) {
      boxFuera.classList.remove("hidden");
      listFuera.innerHTML = fuera.map((d) => `
        <div class="flex flex-wrap items-center justify-between gap-2 bg-white p-2.5 rounded-xl border border-amber-200 text-xs" data-doc="${d.documento}">
          <div>
            <span class="font-mono-ve font-extrabold text-slate-900">${d.documento}</span>
            <span class="font-bold text-slate-700 ml-1.5">${d.nombre}</span>
            <span class="text-rose-700 font-extrabold ml-1.5">(Debe $${d.totalDeudaUsd.toFixed(2)})</span>
          </div>
          <button type="button" class="btn-renombrar-deudor px-3 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-extrabold cursor-pointer">
            Cambiar / Confirmar Nombre
          </button>
        </div>
      `).join("");
    } else {
      boxFuera.classList.add("hidden");
    }

    const cont = root.querySelector("#listaDeudores");
    if (!deudoresAgrupados.length) {
      cont.innerHTML = `
        <div class="ve-card text-center py-10 space-y-1">
          <div class="text-sm font-extrabold text-emerald-700">¡Sin deudas pendientes!</div>
          <p class="text-xs text-slate-500">Todos los créditos han sido cancelados.</p>
        </div>
      `;
      return;
    }

    // Ordenados del MÁS VIEJO (menor creadoTs / mayor antigüedad) al más reciente
    cont.innerHTML = deudoresAgrupados.map((d) => {
      const dias = calcularAntiguedadDias(d.masViejaTs);
      const vencido30 = dias >= 30;

      return `
        <div class="ve-card space-y-3 ${vencido30 ? "border-rose-300 bg-rose-50/20" : ""}" data-doc="${d.documento}">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-sm font-extrabold text-slate-950">${d.nombre}</span>
                <span class="font-mono-ve text-xs font-bold text-slate-500">${d.documento}</span>
                <span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full ${
                  vencido30 ? "bg-rose-600 text-white" : "bg-amber-100 text-amber-800"
                }">
                  ${dias} días pendiente${vencido30 ? " • +30D VENCIDO" : ""}
                </span>
                ${!d.enCatalogo ? `
                  <span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-slate-200 text-slate-700">
                    No está en Clientes
                  </span>
                ` : ""}
              </div>
              <div class="text-[11px] text-slate-500 mt-1">
                ${d.notas.length} ${d.notas.length === 1 ? "nota pendiente" : "notas pendientes"} • Nota más antigua: <strong>${d.masViejaFecha}</strong>
              </div>
            </div>

            <div class="text-right">
              <div class="text-[10px] font-extrabold uppercase text-slate-400">Deuda Total</div>
              <div class="text-lg font-extrabold font-mono-ve text-rose-700">$${d.totalDeudaUsd.toFixed(2)}</div>
            </div>
          </div>

          <!-- Detalle de notas pendientes de este deudor -->
          <div class="space-y-1.5 border-t border-slate-200 pt-2.5">
            ${d.notas.map((n) => {
              const saldo = Number(n.saldoPendienteUsd ?? n.totalUsd ?? 0);
              const diasNota = calcularAntiguedadDias(n.creadoTs);
              return `
                <div class="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs" data-folio="${n.id}">
                  <div>
                    <span class="font-mono-ve font-extrabold text-slate-900">Nota #${n.folio || n.id}</span>
                    <span class="text-slate-500 ml-1.5">(${n.fechaIso || "---"} • ${diasNota}d)</span>
                    ${n.diasCredito ? `<span class="text-[10px] font-bold text-slate-400 ml-1">Plazo: ${n.diasCredito}d</span>` : ""}
                  </div>
                  <div class="flex items-center gap-2">
                    <span class="font-mono-ve font-extrabold text-rose-700">$${saldo.toFixed(2)}</span>
                    <button type="button" class="btn-abonar px-2.5 py-1 rounded-lg bg-slate-950 hover:bg-slate-800 text-white text-[11px] font-extrabold cursor-pointer">
                      Abonar
                    </button>
                    <button type="button" class="btn-saldar px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-extrabold cursor-pointer">
                      Saldar Todo
                    </button>
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        </div>
      `;
    }).join("");
  }

  async function cambiarNombreDeudor(docId, nombreActual) {
    const nuevoNombre = prompt(
      `Este deudor (${docId}) no figura actualmente en el Catálogo de Clientes.\n¿Deseas cambiar o confirmar su nombre en sus deudas?`,
      nombreActual || ""
    );
    if (!nuevoNombre || !nuevoNombre.trim()) return;
    const limpio = nuevoNombre.trim();

    const notasAfectadas = todasNotas.filter(
      (n) => normalizarIdVE(n.cliente?.documento || "") === docId && Number(n.saldoPendienteUsd ?? (n.esCredito ? n.totalUsd : 0) ?? 0) > 0.01
    );
    if (!notasAfectadas.length) return;

    const batch = writeBatch(db);
    for (const n of notasAfectadas) {
      batch.set(doc(refs.notasEntrega(), n.id), {
        cliente: { ...(n.cliente || {}), documento: docId, nombre: limpio }
      }, { merge: true });
    }
    await batch.commit();
    await cargarDatos();
  }

  async function registrarAbono(folioId, montoAbono) {
    const nota = todasNotas.find((n) => n.id === folioId);
    if (!nota) return;
    const saldoActual = Number(nota.saldoPendienteUsd ?? nota.totalUsd ?? 0);
    const abono = Math.min(saldoActual, Math.max(0, Number(montoAbono) || 0));
    if (abono <= 0) return;

    const nuevoSaldo = Number((saldoActual - abono).toFixed(2));
    const historialAbonos = Array.isArray(nota.abonos) ? nota.abonos : [];
    historialAbonos.push({
      montoUsd: abono,
      fechaIso: new Date().toISOString().slice(0, 10),
      creadoTs: Date.now()
    });

    await setDoc(doc(refs.notasEntrega(), folioId), {
      saldoPendienteUsd: nuevoSaldo,
      esCredito: nuevoSaldo > 0.01,
      abonos: historialAbonos,
      actualizadoEn: serverTimestamp()
    }, { merge: true });

    await cargarDatos();
    if (typeof window.NEXUS_VE_REFRESH_ALERTAS === "function") {
      await window.NEXUS_VE_REFRESH_ALERTAS();
    }
  }

  root.addEventListener("click", async (e) => {
    const btnRenombrar = e.target.closest(".btn-renombrar-deudor");
    if (btnRenombrar) {
      const docId = btnRenombrar.closest("[data-doc]").dataset.doc;
      const deudor = deudoresAgrupados.find((x) => x.documento === docId);
      await cambiarNombreDeudor(docId, deudor?.nombre || "");
      return;
    }

    const rowNota = e.target.closest("[data-folio]");
    if (!rowNota) return;
    const folioId = rowNota.dataset.folio;
    const nota = todasNotas.find((n) => n.id === folioId);
    if (!nota) return;
    const saldoActual = Number(nota.saldoPendienteUsd ?? nota.totalUsd ?? 0);

    if (e.target.closest(".btn-saldar")) {
      if (!confirm(`¿Marcar como pagada en su totalidad la Nota #${nota.folio || folioId} ($${saldoActual.toFixed(2)})?`)) return;
      await registrarAbono(folioId, saldoActual);
    } else if (e.target.closest(".btn-abonar")) {
      const resp = prompt(`Saldo actual de Nota #${nota.folio || folioId}: $${saldoActual.toFixed(2)}\n¿Cuánto abona hoy en USD?`, saldoActual.toFixed(2));
      if (resp === null) return;
      const monto = parseFloat(resp);
      if (isNaN(monto) || monto <= 0) return alert("Monto inválido.");
      if (monto > saldoActual + 0.009) return alert("El abono no puede superar el saldo pendiente.");
      await registrarAbono(folioId, monto);
    }
  });

  async function cargarDatos() {
    const [snapNotas, snapCli] = await Promise.all([getDocs(refs.notasEntrega()), getDocs(refs.clientes())]);
    todasNotas = snapNotas.docs.map((d) => ({ id: d.id, ...d.data() }));
    clientesMap.clear();
    snapCli.forEach((d) => clientesMap.set(normalizarIdVE(d.id), d.data()));

    const mapaDeudores = new Map();

    for (const n of todasNotas) {
      const saldo = Number(n.saldoPendienteUsd ?? (n.esCredito ? n.totalUsd : 0) ?? 0);
      if (saldo <= 0.01) continue;

      const docCli = normalizarIdVE(n.cliente?.documento || "V-00000000");
      const cliCatalogo = clientesMap.get(docCli);
      const nombreVisible = cliCatalogo?.nombre || n.cliente?.nombre || "Consumidor Final";
      const ts = Number(n.creadoTs || 0);

      if (!mapaDeudores.has(docCli)) {
        mapaDeudores.set(docCli, {
          documento: docCli,
          nombre: nombreVisible,
          enCatalogo: !!cliCatalogo,
          totalDeudaUsd: 0,
          masViejaTs: ts || Date.now(),
          masViejaFecha: n.fechaIso || "---",
          notas: []
        });
      }

      const grupo = mapaDeudores.get(docCli);
      grupo.totalDeudaUsd = Number((grupo.totalDeudaUsd + saldo).toFixed(2));
      grupo.notas.push(n);

      if (ts && ts < grupo.masViejaTs) {
        grupo.masViejaTs = ts;
        grupo.masViejaFecha = n.fechaIso || "---";
      }
    }

    // Ordenar notas internas y grupos del MÁS VIEJO al más reciente
    deudoresAgrupados = Array.from(mapaDeudores.values())
      .map((g) => ({
        ...g,
        notas: g.notas.sort((a, b) => (a.creadoTs || 0) - (b.creadoTs || 0))
      }))
      .sort((a, b) => (a.masViejaTs || 0) - (b.masViejaTs || 0));

    render();
  }

  await cargarDatos();
}
