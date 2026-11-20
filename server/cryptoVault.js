const crypto = require("crypto");

const RUT_PGB = "769497226";

function limpiarRut(r) {
  return String(r || "").replace(/[^0-9kK]/g, "").toUpperCase().slice(0, 9);
}

function formatearRut(r) {
  const c = limpiarRut(r);
  if (c.length < 2) return c;
  const cuerpo = c.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${cuerpo}-${c.slice(-1)}`;
}

function validarRutChileno(rut) {
  const limpio = limpiarRut(rut);
  if (limpio.length < 7 || limpio.length > 9) return false;
  const cuerpo = limpio.slice(0, -1);
  const dv = limpio.slice(-1);
  if (!/^\d+$/.test(cuerpo)) return false;
  let suma = 0;
  let multiplo = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += parseInt(cuerpo.charAt(i), 10) * multiplo;
    multiplo = multiplo < 7 ? multiplo + 1 : 2;
  }
  const dvEsperado = 11 - (suma % 11);
  const dvCalc = dvEsperado === 11 ? "0" : dvEsperado === 10 ? "K" : String(dvEsperado);
  return dv === dvCalc;
}

function sha256Hex(texto) {
  return crypto.createHash("sha256").update(String(texto || "").trim(), "utf8").digest("hex");
}

function safeEqualText(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function getMasterKey() {
  const secret = String(process.env.NEXUS_MASTER_KEY || "").trim();
  if (!secret || secret.length < 16) {
    throw new Error("NEXUS_MASTER_KEY no configurada o demasiado corta en Vercel.");
  }
  return secret;
}

function deriveAesKey(masterKey) {
  return crypto.createHash("sha256").update(masterKey || getMasterKey(), "utf8").digest();
}

function encryptSecret(plainText, masterKey) {
  const text = String(plainText ?? "");
  if (!text) return "";
  const key = deriveAesKey(masterKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1:${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptSecret(payload, masterKey) {
  const str = String(payload || "");
  if (!str) return "";
  if (!str.startsWith("v1:")) return str;
  const parts = str.split(":");
  if (parts.length !== 4) throw new Error("Formato de secreto cifrado inválido.");
  const key = deriveAesKey(masterKey);
  const iv = Buffer.from(parts[1], "hex");
  const authTag = Buffer.from(parts[2], "hex");
  const encrypted = Buffer.from(parts[3], "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

function encryptObjectFields(obj, masterKey) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    const str = String(v).trim();
    if (!str) continue;
    out[k] = encryptSecret(str, masterKey);
  }
  return out;
}

function decryptObjectFields(obj, masterKey) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (typeof v === "string" && v.startsWith("v1:")) {
      out[k] = decryptSecret(v, masterKey);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function fechaIsoChile(ts = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(ts));
}

function horaChile(ts = Date.now()) {
  return new Intl.DateTimeFormat("es-CL", {
    timeZone: "America/Santiago",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(ts));
}

module.exports = {
  RUT_PGB,
  limpiarRut,
  formatearRut,
  validarRutChileno,
  sha256Hex,
  safeEqualText,
  getMasterKey,
  encryptSecret,
  decryptSecret,
  encryptObjectFields,
  decryptObjectFields,
  fechaIsoChile,
  horaChile
};
