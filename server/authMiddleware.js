const crypto = require("crypto");
const { getAuth } = require("./firebaseAdmin");
const { limpiarRut, sha256Hex, safeEqualText } = require("./cryptoVault");

function getSessionSecret() {
  const key = String(process.env.NEXUS_MASTER_KEY || "").trim();
  if (!key) {
    throw new Error("NEXUS_MASTER_KEY no configurada en el servidor.");
  }
  return crypto.createHash("sha256").update(`nexus_session:${key}`).digest();
}

function signNexusSessionToken(payload = {}, ttlMs = 1000 * 60 * 60 * 24) {
  const body = {
    ...payload,
    iat: Date.now(),
    exp: Date.now() + ttlMs
  };
  const encoded = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  const sig = crypto
    .createHmac("sha256", getSessionSecret())
    .update(`nx.${encoded}`)
    .digest("base64url");
  return `nx.${encoded}.${sig}`;
}

function verifyNexusSessionToken(token) {
  if (typeof token !== "string" || !token.startsWith("nx.")) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [, encoded, sig] = parts;
  const expectedSig = crypto
    .createHmac("sha256", getSessionSecret())
    .update(`nx.${encoded}`)
    .digest("base64url");

  if (!safeEqualText(sig, expectedSig)) return null;

  try {
    const data = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!data || Number(data.exp || 0) <= Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

async function requireAuth(req, res, next) {
  try {
    const header = String(req.headers.authorization || "");
    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ ok: false, error: "Token de autenticación requerido." });
    }
    const token = header.slice(7).trim();

    if (token.startsWith("nx.")) {
      const decoded = verifyNexusSessionToken(token);
      if (!decoded) {
        return res.status(401).json({ ok: false, error: "Sesión expirada o inválida. Vuelve a iniciar sesión." });
      }
      req.user = {
        uid: decoded.uid || "nexus_user",
        rol: decoded.rol || "empresa",
        superAdmin: Boolean(decoded.superAdmin),
        rutEmpresa: limpiarRut(decoded.rutEmpresa || "")
      };
      return next();
    }

    const decoded = await getAuth().verifyIdToken(token);
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
    const requested = limpiarRut(
      req.headers["x-tenant-rut"] ||
      req.body?.rutEmpresa ||
      req.query?.rutEmpresa ||
      req.params?.rutEmpresa ||
      ""
    );
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
  signNexusSessionToken,
  verifyNexusSessionToken,
  requireAuth,
  requireSuperAdmin,
  requireCronSecret,
  resolveTenantRut,
  verificarPinSupervisorServer
};
