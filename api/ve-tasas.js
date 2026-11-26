// api/ve-tasas.js
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=300");

  if (req.method === "OPTIONS") return res.status(200).end();

  const fetchJson = async (url, timeoutMs = 6500) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  };

  try {
    const [dolaresRes, eurosRes] = await Promise.allSettled([
      fetchJson("https://ve.dolarapi.com/v1/dolares"),
      fetchJson("https://ve.dolarapi.com/v1/euros")
    ]);

    let usdBcv = 0;
    let usdt = 0;
    let eurBcv = 0;
    let fechaBcv = null;

    if (dolaresRes.status === "fulfilled" && Array.isArray(dolaresRes.value)) {
      const oficial = dolaresRes.value.find((d) => d.fuente === "oficial");
      const paralelo = dolaresRes.value.find((d) => d.fuente === "paralelo");
      if (oficial?.promedio) {
        usdBcv = Number(oficial.promedio);
        fechaBcv = oficial.fechaActualizacion || null;
      }
      if (paralelo?.promedio) {
        usdt = Number(paralelo.promedio);
      }
    }

    if (eurosRes.status === "fulfilled" && Array.isArray(eurosRes.value)) {
      const eurOficial = eurosRes.value.find((e) => e.fuente === "oficial");
      if (eurOficial?.promedio) eurBcv = Number(eurOficial.promedio);
    }

    // Respaldo de cálculo EUR si la fuente no respondió
    if (!eurBcv && usdBcv) eurBcv = Number((usdBcv * 1.08).toFixed(4));

    return res.status(200).json({
      ok: true,
      tasas: {
        usdBcvHoy: usdBcv,
        usdBcvProximo: null, // Se llena automático si se registra tasa próxima o manual
        eurBcv,
        usdt,
        fechaBcv,
        actualizadoEn: new Date().toISOString()
      }
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "No se pudo consultar la API externa; usa modo manual o caché.",
      tasas: null
    });
  }
}
