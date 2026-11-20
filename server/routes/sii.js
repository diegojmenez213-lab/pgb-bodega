const express = require("express");
const { getDb } = require("../firebaseAdmin");
const { limpiarRut } = require("../cryptoVault");
const { requireAuth, resolveTenantRut } = require("../authMiddleware");
const {
  calcularTotalesDte,
  obtenerCredencialesSii,
  parsearRespuestaXmlSii,
  emitirDteUniversal
} = require("../siiEngine");

function createSiiRouter() {
  const router = express.Router();

  // Calcular totales DTE (Neto, Exento, IVA 19%, Total)
  router.post("/calcular", requireAuth, (req, res) => {
    try {
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      const descuentoGlobal = Number(req.body?.descuentoGlobal || 0);
      const totales = calcularTotalesDte(items, descuentoGlobal);
      return res.json({ ok: true, totales });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Consultar estado y configuración del motor SII de la empresa
  router.get("/estado", requireAuth, async (req, res) => {
    try {
      const rutEmpresa = resolveTenantRut(req);
      if (!rutEmpresa) {
        return res.status(400).json({ ok: false, error: "RUT de empresa no identificado." });
      }
      const cfg = await obtenerCredencialesSii(rutEmpresa);
      const camposConfigurados = Object.keys(cfg.secretos || {});
      return res.json({
        ok: true,
        rutEmpresa,
        proveedor: cfg.proveedor,
        ambiente: cfg.ambiente,
        conectado: camposConfigurados.length > 0 || cfg.proveedor === "simulador",
        camposConfigurados,
        metadatos: cfg.metadatos || {}
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Emitir DTE universal (Factura 33, Boleta 39, Nota de Crédito 61, Guía 52, etc.)
  router.post("/emitir", requireAuth, async (req, res) => {
    try {
      const rutEmpresa = resolveTenantRut(req);
      if (!rutEmpresa) {
        return res.status(400).json({ ok: false, error: "RUT de empresa no identificado." });
      }
      const dte = await emitirDteUniversal(rutEmpresa, req.body || {});
      return res.json({ ok: true, dte });
    } catch (err) {
      console.error("[sii/emitir]", err);
      return res.status(500).json({ ok: false, error: "Error al emitir DTE: " + err.message });
    }
  });

  // Listar últimos DTEs emitidos de la empresa
  router.get("/documentos", requireAuth, async (req, res) => {
    try {
      const db = getDb();
      const rutEmpresa = resolveTenantRut(req);
      if (!rutEmpresa) {
        return res.status(400).json({ ok: false, error: "RUT de empresa no identificado." });
      }
      const limite = Math.min(100, Math.max(1, Number(req.query?.limite || 30)));
      const snap = await db
        .collection("saas_empresas")
        .doc(limpiarRut(rutEmpresa))
        .collection("dtes_emitidos")
        .orderBy("creadoTs", "desc")
        .limit(limite)
        .get();

      const documentos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      return res.json({ ok: true, rutEmpresa, documentos });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Parsear respuesta XML del SII o proveedor DTE
  router.post("/parsear-xml", requireAuth, (req, res) => {
    try {
      const xml = req.body?.xml || "";
      if (!String(xml).trim()) {
        return res.status(400).json({ ok: false, error: "Debes enviar el contenido XML." });
      }
      const resultado = parsearRespuestaXmlSii(xml);
      return res.json({ ok: resultado.parsedOk, ...resultado });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createSiiRouter };
