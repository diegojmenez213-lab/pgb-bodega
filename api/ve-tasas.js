// api/ve-tasas.js
async function obtenerUsdtBinanceP2P() {
  const resp = await fetch("https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0"
    },
    body: JSON.stringify({
      fiat: "VES",
      page: 1,
      rows: 10,
      tradeType: "BUY",
      asset: "USDT",
      countries: [],
      proMerchantAds: false,
      shieldMerchantAds: false,
      publisherType: "merchant",
      payTypes: []
    })
  });

  if (!resp.ok) throw new Error("Error Binance P2P");
  const json = await resp.json();
  const precios = (json?.data || [])
    .map((item) => Number(item?.adv?.price))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (!precios.length) throw new Error("Sin precios en Binance P2P");
  const muestra = precios.length > 3 ? precios.slice(1, 6) : precios;
  const promedio = muestra.reduce((acc, n) => acc + n, 0) / muestra.length;
  return Number(promedio.toFixed(2));
}

export default async function handler(req, res) {
  const force = req.query?.force === "1";

  res.setHeader(
    "Cache-Control",
    force ? "no-store, max-age=0" : "s-maxage=300, stale-while-revalidate=60"
  );

  try {
    const [bcvRes, eurRes, histRes, usdtBinance] = await Promise.allSettled([
      fetch("https://ve.dolarapi.com/v1/dolares/oficial").then((r) => r.json()),
      fetch("https://ve.dolarapi.com/v1/euros/oficial").then((r) => r.json()),
      fetch("https://ve.dolarapi.com/v1/historicos/dolares/oficial").then((r) => r.json()),
      obtenerUsdtBinanceP2P()
    ]);

    const bcvHoy = bcvRes.status === "fulfilled" ? Number(bcvRes.value?.promedio || 0) : 0;
    const eur = eurRes.status === "fulfilled" ? Number(eurRes.value?.promedio || 0) : 0;

    // Si la API ya publicó un registro con fecha futura, se muestra como BCV Mañana
    let bcvManana = 0;
    if (histRes.status === "fulfilled" && Array.isArray(histRes.value) && histRes.value.length) {
      const hoyIso = new Date().toLocaleDateString("en-CA", { timeZone: "America/Caracas" });
      const futuro = histRes.value.find((h) => String(h.fecha || "") > hoyIso && Number(h.promedio) > 0);
      if (futuro) bcvManana = Number(futuro.promedio);
    }

    let usdt = usdtBinance.status === "fulfilled" ? usdtBinance.value : 0;
    if (!usdt) {
      try {
        const par = await fetch("https://ve.dolarapi.com/v1/dolares/paralelo").then((r) => r.json());
        usdt = Number(par?.promedio || 0);
      } catch {}
    }

    return res.status(200).json({
      bcvHoy,
      bcvManana,
      eur,
      usdt,
      fuenteUsdt: usdtBinance.status === "fulfilled" ? "Binance P2P" : "Respaldo",
      actualizado: new Date().toISOString()
    });
  } catch (err) {
    return res.status(500).json({ error: "No se pudieron obtener las tasas", detalle: err.message });
  }
}
