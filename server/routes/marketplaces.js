const express = require("express");
const { getDb } = require("../firebaseAdmin");
const cryptoVault = require("../cryptoVault");
const { decryptObjectFields, limpiarRut, fechaIsoChile } = cryptoVault;
const {
  requireAuth,
  requireCronSecret,
  resolveTenantRut
} = require("../authMiddleware");
const { fetchOrdenesPorCanal } = require("../marketplaceConnectors");
const { emitirDteUniversal } = require("../siiEngine");

const CANALES_VALIDOS = new Set(["meli", "falabella", "lider"]);

function buildOrdenDocId(canal, orderId) {
  const safeId = String(orderId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  return `${canal}_${safeId}`;
}

async function obtenerCredencialesCanal(rutEmpresa, canal) {
  const db = getDb();
  const limpio = limpiarRut(rutEmpresa);
  const snap = await db
    .collection("saas_empresas")
    .doc(limpio)
    .collection("credenciales_privadas")
    .doc(canal)
    .get();

  if (!snap.exists) {
    return { conectado: false, ambiente: "produccion", secretos: {}, metadatos: {} };
  }

  const data = snap.data() || {};
  const secretos = decryptObjectFields(data.secretos || {});
  return {
    conectado: Object.keys(secretos).length > 0,
    ambiente: data.ambiente || "produccion",
    secretos,
    metadatos: data.metadatos || {}
  };
}

async function guardarTokensActualizados(rutEmpresa, canal, nuevosCampos = {}) {
  const encryptFn = cryptoVault.encryptObjectFields || cryptoVault.encryptFields;
  if (!encryptFn || !nuevosCampos || !Object.keys(nuevosCampos).length) return;

  const db = getDb();
  const limpio = limpiarRut(rutEmpresa);
  const ref = db
    .collection("saas_empresas")
    .doc(limpio)
    .collection("credenciales_privadas")
    .doc(canal);

  const snap = await ref.get();
  if (!snap.exists) return;

  const data = snap.data() || {};
  const secretosPrevios = decryptObjectFields(data.secretos || {});
  const secretosActualizados = { ...secretosPrevios, ...nuevosCampos };

  await ref.set({
    secretos: encryptFn(secretosActualizados),
    tokenRotadoTs: Date.now()
  }, { merge: true });
}

/**
 * Emite 1 sola orden con candado transaccional antiduplicados.
 * Si la orden ya fue emitida o está en proceso, bloquea una doble emisión.
 */
async function emitirOrdenControlada(rutEmpresa, docId, overrides = {}) {
  const db = getDb();
  const limpio = limpiarRut(rutEmpresa);
  const ordenRef = db
    .collection("saas_empresas")
    .doc(limpio)
    .collection("ordenes_marketplaces")
    .doc(docId);

  const lockResult = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ordenRef);
    if (!snap.exists) {
      return { estado: "NO_ENCONTRADA" };
    }

    const data = snap.data() || {};
    if (data.estadoFacturacion === "EMITIDO" || data.dteId) {
      return { estado: "YA_EMITIDA", orden: { id: snap.id, ...data } };
    }

    // Evita colisión si otro proceso inició emisión hace menos de 2 minutos
    const enProcesoReciente =
      data.estadoFacturacion === "EMITIENDO" &&
      (Date.now() - Number(data.intentoEmisionTs || 0)) < 120000;

    if (enProcesoReciente) {
      return { estado: "EN_PROCESO", orden: { id: snap.id, ...data } };
    }

    tx.set(ordenRef, {
      estadoFacturacion: "EMITIENDO",
      intentoEmisionTs: Date.now()
    }, { merge: true });

    return { estado: "LISTA", orden: { id: snap.id, ...data } };
  });

  if (lockResult.estado === "NO_ENCONTRADA") {
    throw new Error(`No existe la orden ${docId} en esta empresa.`);
  }
  if (lockResult.estado === "YA_EMITIDA") {
    return { emitidaAhora: false, yaEmitida: true, orden: lockResult.orden };
  }
  if (lockResult.estado === "EN_PROCESO") {
    throw new Error("Esta orden ya se está emitiendo en este momento. Espera unos segundos.");
  }

  const ord = lockResult.orden;
  const receptor = { ...(ord.receptor || {}), ...(overrides.receptor || {}) };
  const tipoDte = Number(overrides.tipoDte || ord.tipoDteSugerido || 39);

  try {
    const dte = await emitirDteUniversal(limpio, {
      tipoDte,
      receptorRut: receptor.rut || "66666666-6",
      receptorRazon: receptor.razonSocial || "Consumidor Final",
      receptorGiro: receptor.giro || "",
      receptorDireccion: receptor.direccion || "",
      receptorComuna: receptor.comuna || "",
      items: Array.isArray(ord.items) ? ord.items : [],
      montoTotal: ord.mntTotal,
      origenCanal: ord.canal,
      origenOrderId: ord.orderId
    });

    const esErrorProveedor = String(dte.estadoSii || "").startsWith("ERROR");
    const ahora = Date.now();

    const updateData = esErrorProveedor
      ? {
          estadoFacturacion: "ERROR_EMISION",
          dteEstadoSii: dte.estadoSii,
          ultimoErrorEmision: dte.error || "El proveedor SII devolvió un error.",
          ultimoIntentoTs: ahora
        }
      : {
          estadoFacturacion: "EMITIDO",
          tipoDteEmitido: dte.tipoDte,
          dteId: dte.id,
          dteFolio: dte.folio,
          dteTrackId: dte.trackId || null,
          dteEstadoSii: dte.estadoSii,
          dteProveedor: dte.proveedorUsado || "simulador",
          dteAmbiente: dte.ambiente || "certificacion",
          ultimoErrorEmision: null,
          emitidoTs: ahora
        };

    await ordenRef.set(updateData, { merge: true });

    return {
      emitidaAhora: !esErrorProveedor,
      yaEmitida: false,
      dte,
      orden: { ...ord, ...updateData }
    };
  } catch (err) {
    await ordenRef.set({
      estadoFacturacion: "ERROR_EMISION",
      ultimoErrorEmision: err.message,
      ultimoIntentoTs: Date.now()
    }, { merge: true });
    throw err;
  }
}

async function sincronizarCanalEmpresa(rutEmpresa, canal, opciones = {}) {
  const db = getDb();
  const limpio = limpiarRut(rutEmpresa);
  const modo = opciones.modo || "manual";
  const limite = Math.min(50, Math.max(1, Number(opciones.limite || 20)));
  const cfg = await obtenerCredencialesCanal(limpio, canal);
  const ahora = Date.now();

  if (!cfg.conectado) {
    const sinCred = {
      rutEmpresa: limpio,
      canal,
      modo,
      conectado: false,
      estado: "SIN_CREDENCIALES",
      actualizadoTs: ahora,
      actualizadoFecha: fechaIsoChile(ahora)
    };
    await db
      .collection("saas_empresas")
      .doc(limpio)
      .collection("sync_marketplaces")
      .doc(canal)
      .set(sinCred, { merge: true });
    return sinCred;
  }

  // Por seguridad tributaria, SIEMPRE es Modo Borrador salvo que esté activado explícitamente
  const autoEmitirActivo = Boolean(
    opciones.autoEmitir === true ||
    (opciones.autoEmitir !== false && cfg.metadatos?.autoEmitir === true)
  );

  try {
    const { ordenes, credencialesActualizadas } = await fetchOrdenesPorCanal(
      canal,
      cfg.secretos,
      cfg.metadatos,
      limite
    );

    if (credencialesActualizadas) {
      await guardarTokensActualizados(limpio, canal, credencialesActualizadas).catch(() => {});
    }

    const colOrdenes = db
      .collection("saas_empresas")
      .doc(limpio)
      .collection("ordenes_marketplaces");

    let nuevas = 0;
    let actualizadas = 0;
    let yaEmitidas = 0;
    let emitidasAuto = 0;
    const erroresEmision = [];

    for (const orden of ordenes) {
      const docId = buildOrdenDocId(canal, orden.orderId);
      const ref = colOrdenes.doc(docId);
      const prevSnap = await ref.get();
      const prev = prevSnap.exists ? prevSnap.data() : null;

      if (prev && (prev.estadoFacturacion === "EMITIDO" || prev.dteId)) {
        await ref.set({
          estadoCanal: orden.estadoCanal,
          ultimoSyncTs: ahora
        }, { merge: true });
        yaEmitidas += 1;
        continue;
      }

      if (prev) {
        actualizadas += 1;
      } else {
        nuevas += 1;
      }

      await ref.set({
        ...orden,
        docId,
        rutEmpresa: limpio,
        estadoFacturacion: prev?.estadoFacturacion || "BORRADOR",
        primerSyncTs: prev?.primerSyncTs || ahora,
        ultimoSyncTs: ahora
      }, { merge: true });

      if (autoEmitirActivo) {
        try {
          const resEmision = await emitirOrdenControlada(limpio, docId);
          if (resEmision.emitidaAhora) emitidasAuto += 1;
        } catch (errEmit) {
          erroresEmision.push({ orderId: orden.orderId, error: errEmit.message });
        }
      }
    }

    const logEntry = {
      rutEmpresa: limpio,
      canal,
      modo,
      conectado: true,
      modoFacturacion: autoEmitirActivo ? "AUTO_EMISION" : "MODO_BORRADOR",
      estado: erroresEmision.length ? "SINCRONIZADO_CON_ALERTAS" : "SINCRONIZADO",
      totalLeidas: ordenes.length,
      nuevas,
      actualizadas,
      yaEmitidas,
      emitidasAuto,
      erroresEmision: erroresEmision.slice(0, 10),
      ultimoError: null,
      actualizadoTs: ahora,
      actualizadoFecha: fechaIsoChile(ahora)
    };

    await db
      .collection("saas_empresas")
      .doc(limpio)
      .collection("sync_marketplaces")
      .doc(canal)
      .set(logEntry, { merge: true });

    await db
      .collection("saas_empresas")
      .doc(limpio)
      .set({ marketplacesSync: { [canal]: logEntry } }, { merge: true });

    return logEntry;
  } catch (err) {
    const errorEntry = {
      rutEmpresa: limpio,
      canal,
      modo,
      conectado: true,
      estado: "ERROR_CONEXION",
      ultimoError: err.message,
      actualizadoTs: ahora,
      actualizadoFecha: fechaIsoChile(ahora)
    };

    await db
      .collection("saas_empresas")
      .doc(limpio)
      .collection("sync_marketplaces")
      .doc(canal)
      .set(errorEntry, { merge: true });

    return errorEntry;
  }
}

function createMarketplacesRouter() {
  const router = express.Router();

  // 1. Estado de canales (Mercado Libre, Falabella, Lider)
  router.get("/estado", requireAuth, async (req, res) => {
    try {
      const rutEmpresa = resolveTenantRut(req);
      if (!rutEmpresa) {
        return res.status(400).json({ ok: false, error: "RUT de empresa no identificado." });
      }

      const db = getDb();
      const limpio = limpiarRut(rutEmpresa);
      const estados = {};

      for (const canal of CANALES_VALIDOS) {
        const cfg = await obtenerCredencialesCanal(limpio, canal);
        const syncSnap = await db
          .collection("saas_empresas")
          .doc(limpio)
          .collection("sync_marketplaces")
          .doc(canal)
          .get();

        estados[canal] = {
          conectado: cfg.conectado,
          ambiente: cfg.ambiente || "produccion",
          autoEmitir: Boolean(cfg.metadatos?.autoEmitir === true),
          camposConfigurados: Object.keys(cfg.secretos || {}),
          metadatos: cfg.metadatos || {},
          ultimoSync: syncSnap.exists ? syncSnap.data() : null
        };
      }

      return res.json({ ok: true, rutEmpresa: limpio, canales: estados });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 2. Sincronizar pedidos reales (Modo Borrador seguro por defecto)
  router.post("/sincronizar", requireAuth, async (req, res) => {
    try {
      const rutEmpresa = resolveTenantRut(req);
      if (!rutEmpresa) {
        return res.status(400).json({ ok: false, error: "RUT de empresa no identificado." });
      }

      const canalSolicitado = String(req.body?.canal || "todos").trim().toLowerCase();
      const canalesObjetivo = canalSolicitado === "todos"
        ? Array.from(CANALES_VALIDOS)
        : CANALES_VALIDOS.has(canalSolicitado) ? [canalSolicitado] : [];

      if (!canalesObjetivo.length) {
        return res.status(400).json({ ok: false, error: "Canal inválido. Usa: meli, falabella, lider o todos." });
      }

      const limite = Number(req.body?.limite || 20);
      // Solo activa autoEmitir si se envía explícitamente true en la petición
      const autoEmitir = req.body?.autoEmitir === true ? true : false;

      const resultados = {};
      for (const canal of canalesObjetivo) {
        resultados[canal] = await sincronizarCanalEmpresa(rutEmpresa, canal, {
          modo: "manual",
          limite,
          autoEmitir
        });
      }

      return res.json({ ok: true, rutEmpresa, resultados });
    } catch (err) {
      console.error("[marketplaces/sincronizar]", err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 3. Listar pedidos descargados (Borradores, Emitidos y Errores) para revisión previa
  router.get("/ordenes", requireAuth, async (req, res) => {
    try {
      const db = getDb();
      const rutEmpresa = resolveTenantRut(req);
      if (!rutEmpresa) {
        return res.status(400).json({ ok: false, error: "RUT de empresa no identificado." });
      }

      const limpio = limpiarRut(rutEmpresa);
      const canalFiltro = String(req.query?.canal || "").trim().toLowerCase();
      const estadoFiltro = String(req.query?.estado || "").trim().toUpperCase();
      const limite = Math.min(100, Math.max(1, Number(req.query?.limite || 40)));

      const snap = await db
        .collection("saas_empresas")
        .doc(limpio)
        .collection("ordenes_marketplaces")
        .orderBy("ultimoSyncTs", "desc")
        .limit(150)
        .get();

      let ordenes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (canalFiltro && CANALES_VALIDOS.has(canalFiltro)) {
        ordenes = ordenes.filter((o) => o.canal === canalFiltro);
      }
      if (estadoFiltro) {
        ordenes = ordenes.filter((o) => String(o.estadoFacturacion || "").toUpperCase() === estadoFiltro);
      }

      return res.json({
        ok: true,
        rutEmpresa: limpio,
        total: ordenes.length,
        ordenes: ordenes.slice(0, limite)
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 4. Emitir 1 sola orden controlada hacia el SII (con protección antiduplicados)
  router.post("/emitir-orden", requireAuth, async (req, res) => {
    try {
      const rutEmpresa = resolveTenantRut(req);
      if (!rutEmpresa) {
        return res.status(400).json({ ok: false, error: "RUT de empresa no identificado." });
      }

      let docId = String(req.body?.docId || "").trim();
      if (!docId && req.body?.canal && req.body?.orderId) {
        docId = buildOrdenDocId(String(req.body.canal).toLowerCase(), req.body.orderId);
      }

      if (!docId) {
        return res.status(400).json({
          ok: false,
          error: "Debes enviar docId o la pareja (canal, orderId)."
        });
      }

      const resultado = await emitirOrdenControlada(rutEmpresa, docId, {
        tipoDte: req.body?.tipoDte,
        receptor: req.body?.receptor
      });

      return res.json({ ok: true, ...resultado });
    } catch (err) {
      console.error("[marketplaces/emitir-orden]", err);
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  // 5. Cron programado multi-empresa (protegido con NEXUS_CRON_SECRET)
  router.post("/cron/sync", requireCronSecret, async (req, res) => {
    try {
      const db = getDb();
      const snapEmpresas = await db.collection("saas_empresas").limit(250).get();
      let empresasProcesadas = 0;
      const detalle = [];

      for (const doc of snapEmpresas.docs) {
        const rut = limpiarRut(doc.id);
        if (!rut) continue;

        const canalesEmpresa = {};
        for (const canal of CANALES_VALIDOS) {
          const cfg = await obtenerCredencialesCanal(rut, canal);
          if (cfg.conectado) {
            canalesEmpresa[canal] = await sincronizarCanalEmpresa(rut, canal, {
              modo: "cron",
              limite: 25
            });
          }
        }
        if (Object.keys(canalesEmpresa).length) {
          detalle.push({ rut, canales: canalesEmpresa });
        }
        empresasProcesadas += 1;
      }

      return res.json({
        ok: true,
        empresasProcesadas,
        ejecutadoEn: fechaIsoChile(Date.now()),
        timestamp: Date.now(),
        detalle
      });
    } catch (err) {
      console.error("[marketplaces/cron/sync]", err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createMarketplacesRouter };
