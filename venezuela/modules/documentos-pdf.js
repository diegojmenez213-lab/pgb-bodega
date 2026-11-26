// venezuela/modules/documentos-pdf.js
// Plantilla limpia estilo Tecnoshop (Nota de Entrega / Cotización) + Ticket 80mm

function esc(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtMoney(n, prefix = "$") {
  const val = Number(n || 0);
  return `${prefix}${val.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function bloqueTotalesMonedas(totalUsd, monedas = ["USD", "BS"], tasas = {}) {
  const bcv = Number(tasas.bcvActiva || tasas.bcvHoy || 0);
  const eur = Number(tasas.eur || 0);
  const usdt = Number(tasas.usdt || 0);

  const filas = [];
  if (monedas.includes("USD")) {
    filas.push(`<div class="tot-row main"><span>TOTAL USD</span><span>${fmtMoney(totalUsd, "$")}</span></div>`);
  }
  if (monedas.includes("BS") && bcv > 0) {
    filas.push(`<div class="tot-row"><span>TOTAL Bs. (BCV ${bcv.toFixed(2)})</span><span>${fmtMoney(totalUsd * bcv, "Bs. ")}</span></div>`);
  }
  if (monedas.includes("USDT")) {
    const valUsdt = (bcv > 0 && usdt > 0) ? (totalUsd * bcv) / usdt : totalUsd;
    filas.push(`<div class="tot-row"><span>REF. USDT</span><span>${fmtMoney(valUsdt, "USDT ")}</span></div>`);
  }
  if (monedas.includes("EUR") && bcv > 0 && eur > 0) {
    const valEur = (totalUsd * bcv) / eur;
    filas.push(`<div class="tot-row"><span>REF. EUR</span><span>${fmtMoney(valEur, "€ ")}</span></div>`);
  }
  return filas.join("");
}

/**
 * Abre ventana lista para imprimir o guardar como PDF (Carta / A4)
 */
export function imprimirDocumentoCarta({ tipo = "NOTA DE ENTREGA", folio = "00001", empresa = {}, cliente = {}, items = [], totalUsd = 0, monedas = ["USD", "BS"], tasas = {}, pagos = [], observaciones = "", fecha = "" }) {
  const fechaTxt = fecha || new Date().toLocaleDateString("es-VE");
  const logoHtml = empresa.logoBase64 || empresa.logoUrl
    ? `<img src="${empresa.logoBase64 || empresa.logoUrl}" class="logo" alt="Logo" />`
    : `<div class="logo-box">${esc((empresa.nombre || "VE").slice(0, 2).toUpperCase())}</div>`;

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<title>${esc(tipo)} #${esc(folio)}</title>
<style>
  * { box-sizing: border-box; font-family: 'Segoe UI', Arial, sans-serif; }
  body { margin: 0; padding: 24px; color: #0f172a; background: #fff; }
  .doc { max-width: 820px; margin: 0 auto; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding-bottom: 14px; border-bottom: 2px solid #0f172a; }
  .brand { display: flex; gap: 12px; align-items: center; }
  .logo { max-height: 64px; max-width: 160px; object-fit: contain; }
  .logo-box { width: 52px; height: 52px; border-radius: 10px; background: #0f172a; color: #fff; font-weight: 800; font-size: 20px; display: flex; align-items: center; justify-content: center; }
  .emp-name { font-size: 16px; font-weight: 800; text-transform: uppercase; }
  .emp-meta { font-size: 11px; color: #475569; line-height: 1.4; margin-top: 2px; }
  .folio-box { border: 2px solid #dc2626; border-radius: 10px; padding: 8px 14px; text-align: center; min-width: 175px; }
  .folio-tipo { font-size: 11px; font-weight: 800; color: #dc2626; letter-spacing: 0.06em; text-transform: uppercase; }
  .folio-num { font-size: 18px; font-weight: 800; color: #0f172a; margin-top: 2px; }
  .folio-fecha { font-size: 11px; color: #475569; margin-top: 2px; }
  .cli-box { margin-top: 14px; padding: 10px 14px; border: 1px solid #cbd5e1; border-radius: 10px; background: #f8fafc; font-size: 12px; display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  table { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 12px; }
  th { background: #0f172a; color: #fff; text-align: left; padding: 8px 10px; font-size: 11px; text-transform: uppercase; }
  td { padding: 8px 10px; border-bottom: 1px solid #e2e8f0; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .foot { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; margin-top: 16px; }
  .obs { flex: 1; font-size: 11px; color: #475569; }
  .tot-box { width: 290px; border: 1px solid #cbd5e1; border-radius: 10px; padding: 10px 12px; background: #f8fafc; }
  .tot-row { display: flex; justify-content: space-between; font-size: 12px; font-weight: 700; padding: 4px 0; }
  .tot-row.main { font-size: 15px; font-weight: 800; border-bottom: 1px solid #cbd5e1; padding-bottom: 6px; margin-bottom: 4px; }
  .sign { margin-top: 38px; display: flex; justify-content: space-between; gap: 40px; font-size: 11px; color: #64748b; }
  .sign div { flex: 1; border-top: 1px solid #94a3b8; padding-top: 6px; text-align: center; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
  <div class="doc">
    <div class="head">
      <div class="brand">
        ${logoHtml}
        <div>
          <div class="emp-name">${esc(empresa.nombre || "")}</div>
          <div class="emp-meta">
            ${empresa.rif ? `RIF: ${esc(empresa.rif)}<br/>` : ""}
            ${empresa.direccion ? `${esc(empresa.direccion)}<br/>` : ""}
            ${empresa.telefonos ? `Telf: ${esc(empresa.telefonos)}` : ""}
            ${empresa.correo ? ` • ${esc(empresa.correo)}` : ""}
          </div>
        </div>
      </div>
      <div class="folio-box">
        <div class="folio-tipo">${esc(tipo)}</div>
        <div class="folio-num">N° ${esc(folio)}</div>
        <div class="folio-fecha">Fecha: ${esc(fechaTxt)}</div>
      </div>
    </div>

    <div class="cli-box">
      <div><strong>Cliente:</strong> ${esc(cliente.nombre || "Consumidor Final")}</div>
      <div><strong>Cédula / RIF:</strong> ${esc(cliente.documento || "---")}</div>
      ${cliente.telefono ? `<div><strong>Teléfono:</strong> ${esc(cliente.telefono)}</div>` : ""}
      ${cliente.direccion ? `<div><strong>Dirección:</strong> ${esc(cliente.direccion)}</div>` : ""}
    </div>

    <table>
      <thead>
        <tr>
          <th style="width:16%">Código</th>
          <th>Descripción</th>
          <th class="num" style="width:10%">Cant.</th>
          <th class="num" style="width:16%">P. Unit ($)</th>
          <th class="num" style="width:16%">Total ($)</th>
        </tr>
      </thead>
      <tbody>
        ${items.map((it) => `
          <tr>
            <td><strong>${esc(it.codigo)}</strong></td>
            <td>${esc(it.descripcion)}${it.origen === "planta" ? " <small>(Planta)</small>" : ""}</td>
            <td class="num">${it.cantidad}</td>
            <td class="num">${fmtMoney(it.precioUsd, "$")}</td>
            <td class="num"><strong>${fmtMoney(it.cantidad * it.precioUsd, "$")}</strong></td>
          </tr>
        `).join("")}
      </tbody>
    </table>

    <div class="foot">
      <div class="obs">
        ${pagos.length ? `<div><strong>Formas de Pago:</strong><br/>${pagos.map((p) => `• ${esc(p.metodo)}: ${fmtMoney(p.montoUsd, "$")}`).join("<br/>")}</div>` : ""}
        ${observaciones ? `<div style="margin-top:8px;"><strong>Observaciones:</strong> ${esc(observaciones)}</div>` : ""}
      </div>
      <div class="tot-box">
        ${bloqueTotalesMonedas(totalUsd, monedas, tasas)}
      </div>
    </div>

    <div class="sign">
      <div>Entregado por</div>
      <div>Recibido conforme (Firma y Cédula)</div>
    </div>
  </div>
  <script>window.onload = () => { window.print(); };</script>
</body>
</html>`;

  const win = window.open("", "_blank");
  if (!win) return alert("Permite las ventanas emergentes para imprimir el documento.");
  win.document.open();
  win.document.write(html);
  win.document.close();
}

/**
 * Ticket térmico 80mm
 */
export function imprimirTicket80mm({ tipo = "NOTA DE ENTREGA", folio = "00001", empresa = {}, cliente = {}, items = [], totalUsd = 0, monedas = ["USD", "BS"], tasas = {}, fecha = "" }) {
  const fechaTxt = fecha || new Date().toLocaleString("es-VE");
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<title>Ticket ${esc(folio)}</title>
<style>
  @page { margin: 0; size: 80mm auto; }
  body { width: 76mm; margin: 0 auto; padding: 6px; font-family: 'Courier New', monospace; font-size: 11px; color: #000; }
  .c { text-align: center; }
  .b { font-weight: 700; }
  .hr { border-top: 1px dashed #000; margin: 6px 0; }
  .row { display: flex; justify-content: space-between; gap: 6px; }
  .tot-row { display: flex; justify-content: space-between; font-weight: 700; margin-top: 2px; }
</style>
</head>
<body>
  <div class="c b">${esc(empresa.nombre || "")}</div>
  ${empresa.rif ? `<div class="c">RIF: ${esc(empresa.rif)}</div>` : ""}
  ${empresa.telefonos ? `<div class="c">${esc(empresa.telefonos)}</div>` : ""}
  <div class="hr"></div>
  <div class="c b">${esc(tipo)} N° ${esc(folio)}</div>
  <div class="c">${esc(fechaTxt)}</div>
  <div class="hr"></div>
  <div>Cliente: ${esc(cliente.nombre || "Consumidor Final")}</div>
  <div>Doc: ${esc(cliente.documento || "---")}</div>
  <div class="hr"></div>
  ${items.map((it) => `
    <div>
      <div class="b">${esc(it.codigo)} - ${esc(it.descripcion).slice(0, 32)}</div>
      <div class="row"><span>${it.cantidad} x $${Number(it.precioUsd).toFixed(2)}</span><span>$${(it.cantidad * it.precioUsd).toFixed(2)}</span></div>
    </div>
  `).join("")}
  <div class="hr"></div>
  ${bloqueTotalesMonedas(totalUsd, monedas, tasas)}
  <div class="hr"></div>
  <div class="c">¡Gracias por su compra!</div>
  <script>window.onload = () => { window.print(); };</script>
</body>
</html>`;

  const win = window.open("", "_blank", "width=340,height=600");
  if (!win) return alert("Permite las ventanas emergentes para imprimir el ticket.");
  win.document.open();
  win.document.write(html);
  win.document.close();
}
