// venezuela/core/tasas-live.js
import { db, doc, getDoc, setDoc, serverTimestamp } from "./db.js";

const STORAGE_KEY = "nexus_ve_tasas_cache";

const state = {
  usdBcvHoy: 0,
  usdBcvProximo: 0,
  eurBcv: 0,
  usdt: 0,
  modoBcv: "hoy", // "hoy" | "proximo"
  actualizadoEn: null,
  esManual: false
};

export function getTasasState() {
  const bcvActiva =
    state.modoBcv === "proximo" && state.usdBcvProximo > 0
      ? state.usdBcvProximo
      : state.usdBcvHoy;

  return {
    ...state,
    bcvActiva,
    hayTasaProxima: state.usdBcvProximo > 0 && state.usdBcvProximo !== state.usdBcvHoy
  };
}

export function setModoBcv(modo) {
  state.modoBcv = modo === "proximo" && state.usdBcvProximo > 0 ? "proximo" : "hoy";
  guardarCacheLocal();
  emitirCambio();
}

export function convertirDesdeUSD(montoUsd) {
  const t = getTasasState();
  const usd = Number(montoUsd) || 0;
  return {
    usd,
    bsBcv: t.bcvActiva ? usd * t.bcvActiva : 0,
    bsUsdt: t.usdt ? usd * t.usdt : 0,
    eur: t.eurBcv && t.bcvActiva ? (usd * t.bcvActiva) / t.eurBcv : 0
  };
}

function guardarCacheLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

function cargarCacheLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) Object.assign(state, JSON.parse(raw));
  } catch {}
}

function emitirCambio() {
  window.dispatchEvent(new CustomEvent("nexus:tasas-actualizadas", { detail: getTasasState() }));
}

export async function guardarTasasManuales({ usdBcvHoy, usdBcvProximo, eurBcv, usdt }) {
  state.usdBcvHoy = Number(usdBcvHoy) || state.usdBcvHoy;
  state.usdBcvProximo = Number(usdBcvProximo) || 0;
  state.eurBcv = Number(eurBcv) || state.eurBcv;
  state.usdt = Number(usdt) || state.usdt;
  state.esManual = true;
  state.actualizadoEn = new Date().toISOString();

  guardarCacheLocal();
  emitirCambio();

  try {
    await setDoc(
      doc(db, "sistema_ve", "tasas_live"),
      {
        usdBcvHoy: state.usdBcvHoy,
        usdBcvProximo: state.usdBcvProximo,
        eurBcv: state.eurBcv,
        usdt: state.usdt,
        esManual: true,
        actualizadoEn: serverTimestamp()
      },
      { merge: true }
    );
  } catch (e) {
    console.warn("No se pudo guardar tasa manual en Firestore:", e.message);
  }
}

export async function sincronizarTasasLive() {
  cargarCacheLocal();

  // 1. Leer respaldo/override en Firestore
  try {
    const snap = await getDoc(doc(db, "sistema_ve", "tasas_live"));
    if (snap.exists()) {
      const d = snap.data();
      if (d.usdBcvProximo) state.usdBcvProximo = Number(d.usdBcvProximo);
      if (d.esManual && d.usdBcvHoy) {
        state.usdBcvHoy = Number(d.usdBcvHoy);
        state.eurBcv = Number(d.eurBcv || state.eurBcv);
        state.usdt = Number(d.usdt || state.usdt);
      }
    }
  } catch {}

  // 2. Consultar endpoint continuo en Vercel
  try {
    const resp = await fetch("/api/ve-tasas");
    const data = await resp.json();
    if (data?.ok && data.tasas) {
      if (data.tasas.usdBcvHoy > 0) state.usdBcvHoy = data.tasas.usdBcvHoy;
      if (data.tasas.eurBcv > 0) state.eurBcv = data.tasas.eurBcv;
      if (data.tasas.usdt > 0) state.usdt = data.tasas.usdt;
      if (data.tasas.usdBcvProximo > 0) state.usdBcvProximo = data.tasas.usdBcvProximo;
      state.actualizadoEn = data.tasas.actualizadoEn;
      state.esManual = false;
      guardarCacheLocal();
    }
  } catch (e) {
    console.warn("Usando caché local de tasas:", e.message);
  }

  emitirCambio();
  return getTasasState();
}

export function iniciarMonitorTasas() {
  sincronizarTasasLive();
  // Revisa cada 10 minutos automáticamente
  return setInterval(sincronizarTasasLive, 10 * 60 * 1000);
}

export function obtenerHoraCaracas() {
  return new Intl.DateTimeFormat("es-VE", {
    timeZone: "America/Caracas",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  }).format(new Date());
}
