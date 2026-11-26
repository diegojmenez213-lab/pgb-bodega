// api/ve-tasas.js — Endpoint Vercel para tasas en vivo Venezuela (BCV, EUR, USDT)
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=300");

  let bcvHoy = 0;
  let bcvManana = 0;
  let eur = 0;
  let usdt = 0;

  try {
    // 1. Dólar Oficial (BCV) y Paralelo/USDT desde DolarAPI Venezuela
    const respUsd = await fetch("https://ve.dolarapi.com/v1/dolares", {
      headers: { "User-Agent": "NEXUS-ERP-VE/1.0" }
    });
    if (respUsd.ok) {
      const dataUsd = await respUsd.json();
      const oficial = dataUsd.find((d) => d.fuente === "oficial" || /oficial|bcv/i.test(d.nombre || ""));
      const paralelo = dataUsd.find((d) => d.fuente === "paralelo" || /paralelo|usdt/i.test(d.nombre || ""));
      if (oficial?.promedio) bcvHoy = Number(oficial.promedio);
      if (paralelo?.promedio) usdt = Number(paralelo.promedio);
    }
  } catch (e) {
    console.warn("Error consultando USD VE:", e.message);
  }

  try {
    // 2. Euro BCV (con cálculo de respaldo si la API de euros no responde)
    const respEur = await fetch("https://ve.dolarapi.com/v1/euros", {
      headers: { "User-Agent": "NEXUS-ERP-VE/1.0" }
    });
    if (respEur.ok) {
      const dataEur = await respEur.json();
      const eurOficial = dataEur.find((d) => d.fuente === "oficial" || /oficial|bcv/i.test(d.nombre || ""));
      if (eurOficial?.promedio) eur = Number(eurOficial.promedio);
    }
  } catch (e) {
    console.warn("Error consultando EUR VE:", e.message);
  }

  // Respaldo de Euro si no llegó directo
  if (!eur && bcvHoy > 0) {
    eur = Number((bcvHoy * 1.08).toFixed(2));
  }

  return res.status(200).json({
    ok: bcvHoy > 0 || usdt > 0,
    bcvHoy,
    bcvManana,
    eur,
    usdt,
    actualizado: new Date().toISOString()
  });
}
