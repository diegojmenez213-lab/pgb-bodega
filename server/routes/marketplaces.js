const express = require("express");
const { getDb } = require("../firebaseAdmin");
const { decryptObjectFields, limpiarRut, fechaIsoChile } = require("../cryptoVault");
const {
  requireAuth,
  requireCronSecret,
  resolveTenantRut
} = require("../authMiddleware");

const CANALES_VALIDOS = new Set(["meli", "falabella", "lider"]);

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
    return { conectado: false, secretos: {}, metadatos: {} };
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

async function sincronizarCanalEmpresa(rutEmpresa, canal, modo = "manual") {
  const db = getDb();
  const limpio = limpiarRut(rutEmpresa);
  const cfg = await obtenerCredencialesCanal(limpio, canal);
  const ahora = Date.now();

  const logEntry = {
    rutEmpresa: limpio,
    canal,
    modo,
    conectado: cfg.conectado,
    estado: cfg.conectado ? "SINCRONIZADO" : "SIN_CREDENCIALES",
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
    .set({
      marketplacesSync: {
        [canal]: logEntry
      }
    }, { merge: true });

  return logEntry;
}

function createMarketplacesRouter() {
  const router = express.Router();

  // Estado de canales (Mercado Libre, Falabella, Lider) de la empresa
  router.get("/estado", requireAuth, async (req, res) => {
    try {
      const rutEmpresa = resolveTenantRut(req);
      if (!rutEmpresa) {
        return res.status(400).json({ ok: false, error: "RUT de empresa no identificado." });
      }

      const estados = {};
      for (const canal of CANALES_VALIDOS) {
        const cfg = await obtenerCredencialesCanal(rutEmpresa, canal);
        estados[canal] = {
          conectado: cfg.conectado,
          ambiente: cfg.ambiente || "produccion",
          camposConfigurados: Object.keys(cfg.secretos || {}),
          metadatos: cfg.metadatos || {}
        };
      }

      return res.json({ ok: true, rutEmpresa, canales: estados });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Sincronizar un canal o todos los canales de la empresa
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

      const resultados = {};
      for (const canal of canalesObjetivo) {
        resultados[canal] = await sincronizarCanalEmpresa(rutEmpresa, canal, "manual");
      }

      return res.json({ ok: true, rutEmpresa, resultados });
    } catch (err) {
      console.error("[marketplaces/sincronizar]", err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Endpoint protegido por NEXUS_CRON_SECRET para tareas programadas multi-empresa
  router.post("/cron/sync", requireCronSecret, async (req, res) => {
    try {
      const db = getDb();
      const snapEmpresas = await db.collection("saas_empresas").limit(250).get();
      let empresasProcesadas = 0;

      for (const doc of snapEmpresas.docs) {
        const rut = limpiarRut(doc.id);
        if (!rut) continue;
        for (const canal of CANALES_VALIDOS) {
          const cfg = await obtenerCredencialesCanal(rut, canal);
          if (cfg.conectado) {
            await sincronizarCanalEmpresa(rut, canal, "cron");
          }
        }
        empresasProcesadas += 1;
      }

      return res.json({
        ok: true,
        empresasProcesadas,
        ejecutadoEn: fechaIsoChile(Date.now()),
        timestamp: Date.now()
      });
    } catch (err) {
      console.error("[marketplaces/cron/sync]", err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createMarketplacesRouter };
