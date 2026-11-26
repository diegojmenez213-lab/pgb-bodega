// venezuela/core/db.js
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  doc,
  collection,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Pega aquí tu configuración actual de Firebase (la misma de tu proyecto NEXUS)
const firebaseConfig = {
  apiKey: "TU_API_KEY",
  authDomain: "TU_AUTH_DOMAIN",
  projectId: "TU_PROJECT_ID",
  storageBucket: "TU_STORAGE_BUCKET",
  messagingSenderId: "TU_SENDER_ID",
  appId: "TU_APP_ID"
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
export const db = getFirestore(app);

/**
 * Normaliza Cédula o RIF venezolano a ID limpio para Firestore.
 * Ej: "j-50343856-8" -> "J-50343856-8" | "20504570" -> "V-20504570"
 */
export function normalizarIdVE(raw = "") {
  const limpio = String(raw).trim().toUpperCase().replace(/\s+/g, "");
  if (/^[VEJGP]-\d+/.test(limpio)) return limpio;
  if (/^[VEJGP]\d+/.test(limpio)) return `${limpio[0]}-${limpio.slice(1)}`;
  if (/^\d{6,9}$/.test(limpio)) return `V-${limpio}`;
  return limpio;
}

/**
 * Retorna referencias estrictamente aisladas bajo empresas/{tenantId}/...
 */
export function getTenantRefs(tenantId) {
  const id = normalizarIdVE(tenantId);
  if (!id) throw new Error("Tenant ID inválido");

  const empresaRef = doc(db, "empresas", id);
  return {
    id,
    empresaRef,
    catalogo: () => collection(db, "empresas", id, "catalogo"),
    clientes: () => collection(db, "empresas", id, "clientes"),
    cotizaciones: () => collection(db, "empresas", id, "cotizaciones"),
    notasEntrega: () => collection(db, "empresas", id, "notas_entrega"),
    historialNovedades: () => collection(db, "empresas", id, "historial_novedades"),
    conteos: () => collection(db, "empresas", id, "conteos"),
    proveedores: () => collection(db, "empresas", id, "proveedores"),
    tasasGlobales: () => doc(db, "sistema_ve", "tasas_live")
  };
}

export async function obtenerConfigEmpresa(tenantId) {
  const { empresaRef } = getTenantRefs(tenantId);
  const snap = await getDoc(empresaRef);
  if (!snap.exists()) return null;
  const data = snap.data();
  if (data.pais !== "VE") return null; // Bloqueo de seguridad: no permite abrir empresas de Chile aquí
  return { id: snap.id, ...data };
}

export { doc, collection, getDoc, setDoc, updateDoc, serverTimestamp };
