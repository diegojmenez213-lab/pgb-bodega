// venezuela/core/auth-tenant.js
import { obtenerConfigEmpresa } from "./db.js";

const SESSION_KEY = "nexus_ve_session";

export function guardarSesionVE(payload) {
  const sesion = {
    tenantId: payload.tenantId,
    pais: "VE",
    nombreEmpresa: payload.nombreEmpresa,
    usuario: payload.usuario || "Administrador",
    rol: payload.rol || "dueno", // "dueno" | "vendedor" | "cajero"
    inicio: Date.now()
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(sesion));
  return sesion;
}

export function obtenerSesionVE() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const sesion = JSON.parse(raw);
    if (!sesion?.tenantId || sesion.pais !== "VE") return null;
    return sesion;
  } catch {
    return null;
  }
}

export function cerrarSesionVE() {
  localStorage.removeItem(SESSION_KEY);
  window.location.href = "/index.html";
}

/**
 * Ejecutar al iniciar venezuela/index.html.
 * Valida sesión + existencia activa en Firestore.
 */
export async function verificarAccesoVE() {
  const sesion = obtenerSesionVE();
  if (!sesion) {
    window.location.href = "/index.html";
    return null;
  }

  const empresa = await obtenerConfigEmpresa(sesion.tenantId);
  if (!empresa || empresa.activo === false) {
    cerrarSesionVE();
    return null;
  }

  return { sesion, empresa };
}
