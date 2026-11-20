const { getAuth } = require("./firebaseAdmin");
const { limpiarRut, sha256Hex, safeEqualText } = require("./cryptoVault");

async function requireAuth(req, res, next) {
  try {
    const header = String(req.headers.authorization || "");
    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ ok: false, error: "Token de autenticación requerido." });
    }
    const idToken = header.slice(7).trim();
    const decoded = await getAuth().verifyIdToken(idToken);
    req.user = {
      uid: decoded.uid,
      rol: decoded.rol || "empresa",
      superAdmin: Boolean(decoded.superAdmin),
      rutEmpresa: limpiarRut(decoded.rutEmpresa || "")
    };
    return next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: "Sesión expirada o inválida. Vuelve a iniciar sesión." });
  }
}

function requireSuperAdmin(req, res, next) {
  if (!req.user || !req.user.superAdmin) {
    return res.status(403).json({ ok: false, error: "Acceso restringido a Consola Maestra." });
  }
  return next();
}

function requireCronSecret(req, res, next) {
  const expected = String(process.env.NEXUS_CRON_SECRET || "").trim();
  const provided = String(
    req.headers["x-nexus-cron-secret"] ||
    (String(req.headers.authorization || "").startsWith("Bearer ")
      ? String(req.headers.authorization).slice(7).trim()
      : "") ||
    req.query?.secret ||
    ""
  ).trim();

  if (!expected || !provided || !safeEqualText(provided, expected)) {
    return res.status(401).json({ ok: false, error: "Cron no autorizado." });
  }
  return next();
}

function resolveTenantRut(req) {
  if (req.user?.superAdmin) {
    const requested = limpiarRut(req.body?.rutEmpresa || req.query?.rutEmpresa || req.params?.rutEmpresa || "");
    if (requested) return requested;
  }
  return limpiarRut(req.user?.rutEmpresa || "");
}

async function verificarPinSupervisorServer(db, rutEmpresa, pinIngresado) {
  const limpio = String(pinIngresado || "").trim();
  if (!limpio) return false;
  const snap = await db.collection("saas_empresas").doc(rutEmpresa).get();
  if (!snap.exists) return false;
  const emp = snap.data() || {};
  if (emp.pinSupervisorHash) {
    return safeEqualText(sha256Hex(limpio), emp.pinSupervisorHash);
  }
  const fallback = String(emp.pinSupervisor || "1234").trim();
  return safeEqualText(limpio, fallback);
}

module.exports = {
  requireAuth,
  requireSuperAdmin,
  requireCronSecret,
  resolveTenantRut,
  verificarPinSupervisorServer
};
