const express = require("express");
const { admin, getDb, getAuth } = require("../firebaseAdmin");
const {
  RUT_PGB,
  limpiarRut,
  formatearRut,
  sha256Hex,
  safeEqualText,
  encryptObjectFields,
  fechaIsoChile
} = require("../cryptoVault");
const {
  signNexusSessionToken,
  requireAuth,
  requireSuperAdmin,
  resolveTenantRut,
  verificarPinSupervisorServer
} = require("../authMiddleware");

const SERVICIOS_VALIDOS = new Set(["sii", "meli", "falabella", "lider"]);
const PROVEEDORES_SII_VALIDOS = new Set([
  "openfactura",
  "simplefactura",
  "libredte",
  "sii_directo",
  "simulador"
]);

function createAuthRouter() {
  const router = express.Router();

  // 1. LOGIN DE EMPRESA -> ENTREGA SESSION TOKEN FIRMADO (+ CUSTOM TOKEN OPCIONAL)
  router.post("/login-empresa", async (req, res) => {
    try {
      const db = getDb();
      const auth = getAuth();
      const rutLimpio = limpiarRut(req.body?.rut || "");
      const claveIngresada = String(req.body?.clave || "").trim();

      if (rutLimpio.length < 7) {
        return res.status(400).json({ ok: false, error: "Ingresa un RUT empresarial válido." });
      }

      const empRef = db.collection("saas_empresas").doc(rutLimpio);
      const snap = await empRef.get();

      if (!snap.exists) {
        if (rutLimpio === RUT_PGB) {
          const claims = { rol: "empresa", superAdmin: false, rutEmpresa: RUT_PGB, esPgb: true };
          const sessionToken = signNexusSessionToken({ uid: `emp_${RUT_PGB}`, ...claims });
          let customToken = "";
          try { customToken = await auth.createCustomToken(`emp_${RUT_PGB}`, claims); } catch (_) {}
          return res.json({
            ok: true,
            sessionToken,
            customToken,
            rutEmpresa: RUT_PGB,
            esPgb: true,
            empresa: { nombre: "PGB DISTRIBUTION CHILE SPA", rut: formatearRut(RUT_PGB) }
          });
        }
        return res.status(404).json({ ok: false, error: "Este RUT no está registrado en NEXUS ERP." });
      }

      const data = snap.data() || {};
      if (data.activa === false) {
        return res.status(403).json({ ok: false, error: "El acceso para esta empresa se encuentra pausado." });
      }

      const hashGuardado = String(data.claveAccesoHash || "").trim();
      const clavePlanaLegacy = String(data.claveAcceso || data.pin || "").trim();

      if (hashGuardado) {
        if (!claveIngresada || !safeEqualText(sha256Hex(claveIngresada), hashGuardado)) {
          return res.status(401).json({ ok: false, error: "Clave de acceso incorrecta." });
        }
      } else if (clavePlanaLegacy) {
        if (!safeEqualText(claveIngresada, clavePlanaLegacy)) {
          return res.status(401).json({ ok: false, error: "Clave de acceso incorrecta." });
        }
        await empRef.update({
          claveAccesoHash: sha256Hex(clavePlanaLegacy),
          claveAcceso: admin.firestore.FieldValue.delete(),
          pin: admin.firestore.FieldValue.delete()
        }).catch(() => {});
      }

      const claims = {
        rol: "empresa",
        superAdmin: false,
        rutEmpresa: rutLimpio,
        esPgb: rutLimpio === RUT_PGB
      };
      const sessionToken = signNexusSessionToken({ uid: `emp_${rutLimpio}`, ...claims });
      let customToken = "";
      try { customToken = await auth.createCustomToken(`emp_${rutLimpio}`, claims); } catch (_) {}

      return res.json({
        ok: true,
        sessionToken,
        customToken,
        rutEmpresa: rutLimpio,
        esPgb: rutLimpio === RUT_PGB,
        empresa: {
          nombre: data.nombre || rutLimpio,
          rut: data.rut || formatearRut(rutLimpio)
        }
      });
    } catch (err) {
      console.error("[login-empresa]", err);
      return res.status(500).json({ ok: false, error: "Error al validar acceso: " + err.message });
    }
  });

  // 2. LOGIN SUPER ADMIN -> ENTREGA SESSION TOKEN CON superAdmin: true
  router.post("/login-super-admin", async (req, res) => {
    try {
      const db = getDb();
      const auth = getAuth();
      const pinIngresado = String(req.body?.pin || req.body?.clave || "").trim();
      if (!pinIngresado) {
        return res.status(400).json({ ok: false, error: "Ingresa el PIN Maestro." });
      }

      const cfgRef = db.collection("saas_config").doc("master_admin");
      const snap = await cfgRef.get();
      const hashIngresado = sha256Hex(pinIngresado);
      const hashInicial = sha256Hex("2026");

      let valido = false;
      if (snap.exists && snap.data()?.pinMaestroHash) {
        valido = safeEqualText(hashIngresado, snap.data().pinMaestroHash);
      } else if (safeEqualText(hashIngresado, hashInicial)) {
        valido = true;
        await cfgRef.set({ pinMaestroHash: hashInicial, actualizadoTs: Date.now() }, { merge: true });
      }

      if (!valido) {
        return res.status(401).json({ ok: false, error: "PIN Maestro incorrecto." });
      }

      const claims = { rol: "super_admin", superAdmin: true, rutEmpresa: "" };
      const sessionToken = signNexusSessionToken({ uid: "nexus_super_admin", ...claims });
      let customToken = "";
      try { customToken = await auth.createCustomToken("nexus_super_admin", claims); } catch (_) {}

      return res.json({ ok: true, sessionToken, customToken, rol: "superAdmin" });
    } catch (err) {
      console.error("[login-super-admin]", err);
      return res.status(500).json({ ok: false, error: "Error Consola Maestra: " + err.message });
    }
  });

  // 3. SUPER ADMIN: ASIGNAR O QUITAR CLAVE DE EMPRESA (CIFRADA SHA-256)
  router.post("/empresa-clave", requireAuth, requireSuperAdmin, async (req, res) => {
    try {
      const db = getDb();
      const rutLimpio = limpiarRut(req.body?.rutEmpresa || "");
      const nuevaClave = String(req.body?.claveAcceso || "").trim();
      if (rutLimpio.length < 7) {
        return res.status(400).json({ ok: false, error: "RUT de empresa inválido." });
      }

      const empRef = db.collection("saas_empresas").doc(rutLimpio);
      if (nuevaClave) {
        await empRef.set({
          claveAccesoHash: sha256Hex(nuevaClave),
          claveAcceso: admin.firestore.FieldValue.delete(),
          pin: admin.firestore.FieldValue.delete()
        }, { merge: true });
      } else {
        await empRef.set({
          claveAccesoHash: admin.firestore.FieldValue.delete(),
          claveAcceso: admin.firestore.FieldValue.delete(),
          pin: admin.firestore.FieldValue.delete()
        }, { merge: true });
      }

      return res.json({ ok: true, tieneClave: Boolean(nuevaClave) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 4. GUARDAR CREDENCIALES EN BÓVEDA CIFRADA (SII / MELI / FALABELLA / LIDER)
  router.post("/guardar-credenciales", requireAuth, async (req, res) => {
    try {
      const db = getDb();
      const rutEmpresa = resolveTenantRut(req);
      if (!rutEmpresa) {
        return res.status(400).json({ ok: false, error: "RUT de empresa no identificado." });
      }

      const servicio = String(req.body?.servicio || "").trim().toLowerCase();
      if (!SERVICIOS_VALIDOS.has(servicio)) {
        return res.status(400).json({ ok: false, error: "Servicio inválido. Usa: sii, meli, falabella o lider." });
      }

      if (!req.user.superAdmin) {
        const pinOk = await verificarPinSupervisorServer(db, rutEmpresa, req.body?.pinSupervisor);
        if (!pinOk) {
          return res.status(403).json({ ok: false, error: "Clave de Supervisor incorrecta." });
        }
      }

      const proveedor = String(req.body?.proveedor || servicio).trim().toLowerCase();
      if (servicio === "sii" && !PROVEEDORES_SII_VALIDOS.has(proveedor)) {
        return res.status(400).json({
          ok: false,
          error: "Proveedor SII inválido. Usa: openfactura, simplefactura, libredte, sii_directo o simulador."
        });
      }

      const ambiente = String(req.body?.ambiente || "certificacion").trim().toLowerCase() === "produccion"
        ? "produccion"
        : "certificacion";

      const secretosEntrantes = req.body?.credenciales && typeof req.body.credenciales === "object"
        ? req.body.credenciales
        : {};
      const metadatosPublicos = req.body?.metadatos && typeof req.body.metadatos === "object"
        ? req.body.metadatos
        : {};

      const cifradosNuevos = encryptObjectFields(secretosEntrantes);
      const empRef = db.collection("saas_empresas").doc(rutEmpresa);
      const privRef = empRef.collection("credenciales_privadas").doc(servicio);
      const privSnap = await privRef.get();
      const existentes = privSnap.exists ? (privSnap.data()?.secretos || {}) : {};
      const secretosCombinados = { ...existentes, ...cifradosNuevos };

      const ahora = Date.now();
      await privRef.set({
        servicio,
        proveedor,
        ambiente,
        secretos: secretosCombinados,
        metadatos: metadatosPublicos,
        actualizadoTs: ahora,
        actualizadoFecha: fechaIsoChile(ahora)
      }, { merge: true });

      const tieneSecretos = Object.keys(secretosCombinados).length > 0 || proveedor === "simulador";

      await empRef.set({
        integraciones: {
          [servicio]: {
            conectado: tieneSecretos,
            proveedor,
            ambiente,
            camposGuardados: Object.keys(secretosCombinados),
            metadatos: metadatosPublicos,
            actualizadoTs: ahora
          }
        }
      }, { merge: true });

      return res.json({
        ok: true,
        servicio,
        estado: {
          conectado: tieneSecretos,
          proveedor,
          ambiente,
          camposGuardados: Object.keys(secretosCombinados)
        }
      });
    } catch (err) {
      console.error("[guardar-credenciales]", err);
      return res.status(500).json({ ok: false, error: "Error guardando credenciales: " + err.message });
    }
  });

  // 5. CONSULTAR ESTADO SEGURO DE INTEGRACIONES (SIN EXPONER SECRETOS)
  router.get("/estado-integraciones", requireAuth, async (req, res) => {
    try {
      const db = getDb();
      const rutEmpresa = resolveTenantRut(req);
      if (!rutEmpresa) {
        return res.status(400).json({ ok: false, error: "RUT no identificado." });
      }
      const snap = await db.collection("saas_empresas").doc(rutEmpresa).get();
      const integraciones = snap.exists ? (snap.data()?.integraciones || {}) : {};
      return res.json({ ok: true, rutEmpresa, integraciones });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createAuthRouter };
