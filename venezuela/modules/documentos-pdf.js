// venezuela/modules/documentos-pdf.js
import { obtenerFechaLocalIso } from "../core/db.js";

function fmtNum(n) {
  return Number(n || 0).toLocaleString("es-VE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function escaparHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatearFechaVE(fechaInput = "", fallbackTs = 0) {
  const raw = String(fechaInput || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split("-");
    return `${d}/${m}/${y}`;
  }
  if (raw) return raw;
  const iso = obtenerFechaLocalIso(fallbackTs || Date.now());
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function obtenerLogoDocumento(empresa = {}) {
  return (
    empresa.logoDocumentoBase64 ||
    empresa.logoPdfBase64 ||
    empresa.logoBase64 ||
    empresa.logoPlataformaBase64 ||
    empresa.logoUrl ||
    ""
  );
}

function construirFilasTotales(totalUsd, monedas = ["USD", "BS"], tasas = {}) {
  const usd = Number(totalUsd || 0);
  const bcv = Number(tasas.bcvActiva || tasas.bcvHoy || 0);
  const eur = Number(tasas.eur || 0);
  const usdt = Number(tasas.usdt || 0);
  const listaMonedas = Array.isArray(monedas) && monedas.length ? monedas : ["USD", "BS"];
  const filas = [];

  if (listaMonedas.includes("USD")) {
    filas.push(`
      <tr class="tot-row tot-main">
        <td>TOTAL USD</td>
        <td class="num">$${fmtNum(usd)}</td>
      </tr>
    `);
  }
  if (listaMonedas.includes("BS") && bcv > 0) {
    filas.push(`
      <tr class="tot-row">
        <td>TOTAL Bs. (BCV ${bcv.toFixed(2)})</td>
        <td class="num">Bs. ${fmtNum(usd * bcv)}</td>
      </tr>
    `);
  }
  if (listaMonedas.includes("USDT")) {
    const valUsdt = bcv > 0 && usdt > 0 ? (usd * bcv) / usdt : usd;
    filas.push(`
      <tr class="tot-row">
        <td>TOTAL USDT ${usdt > 0 ? `(Ref. ${usdt.toFixed(2)})` : ""}</td>
        <td class="num">${fmtNum(valUsdt)} USDT</td>
      </tr>
    `);
  }
  if (listaMonedas.includes("EUR") && bcv > 0 && eur > 0) {
    filas.push(`
      <tr class="tot-row">
        <td>TOTAL EUR (BCV ${eur.toFixed(2)})</td>
        <td class="num">€ ${fmtNum((usd * bcv) / eur)}</td>
      </tr>
    `);
  }

  return filas.join("");
}

function abrirVentanaImpresion(html, titulo) {
  const win = window.open("", "_blank", "width=900,height=750");
  if (!win) {
    alert("Permite las ventanas emergentes (pop-ups) para generar el PDF.");
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.document.title = titulo;

  const lanzarPrint = () => {
    setTimeout(() => {
      win.focus();
      win.print();
    }, 250);
  };

  const imgs = Array.from(win.document.images || []);
  if (!imgs.length) {
    lanzarPrint();
  } else {
    let cargadas = 0;
    const check = () => {
      cargadas++;
      if (cargadas >= imgs.length) lanzarPrint();
    };
    imgs.forEach((img) => {
      if (img.complete) check();
      else {
        img.onload = check;
        img.onerror = check;
      }
    });
  }
}

export function imprimirDocumentoCarta({
  tipo = "NOTA DE ENTREGA",
  folio = "00001",
  empresa = {},
  cliente = {},
  items = [],
  totalUsd = 0,
  monedas = ["USD", "BS"],
  tasas = {},
  pagos = [],
  fecha = "",
  observaciones = "",
  anulada = false
} = {}) {
  const logo = obtenerLogoDocumento(empresa);
  const fechaTxt = formatearFechaVE(fecha);
  const nombreEmp = escaparHtml(empresa.nombre || "MI EMPRESA");
  const rifEmp = escaparHtml(empresa.rif || "");
  const dirEmp = escaparHtml(empresa.direccion || "");
  const telEmp = escaparHtml(empresa.telefono || "");
  const emailEmp = escaparHtml(empresa.correo || empresa.email || "");

  const nomCli = escaparHtml(cliente.nombre || "Consumidor Final");
  const docCli = escaparHtml(cliente.documento || "V-00000000");

  const filasItems = (items || []).map((it) => {
    const cant = Number(it.cantidad || 1);
    const pUnit = Number(it.precioUsd || 0);
    const sub = cant * pUnit;
    const origenTag = it.origen === "planta" ? ` <span class="tag-origen">(Planta)</span>` : "";
    return `
      <tr>
        <td class="col-cod">${escaparHtml(it.codigo || "")}</td>
        <td class="col-desc">${escaparHtml(it.descripcion || "")}${origenTag}</td>
        <td class="num col-cant">${cant}</td>
        <td class="num col-punit">$${fmtNum(pUnit)}</td>
        <td class="num col-tot">$${fmtNum(sub)}</td>
      </tr>
    `;
  }).join("");

  const pagosHtml = Array.isArray(pagos) && pagos.length
    ? `
      <div class="pagos-box">
        <div class="pagos-title">Formas de Pago Registradas</div>
        ${pagos.map((p) => `
          <div class="pago-line">
            <span>${escaparHtml(p.metodo || "Efectivo USD")}${p.referencia ? ` (Ref: ${escaparHtml(p.referencia)})` : ""}</span>
            <strong>$${fmtNum(p.montoUsd)}</strong>
          </div>
        `).join("")}
      </div>
    `
    : "";

  const html = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8" />
      <title>${escaparHtml(tipo)} #${escaparHtml(folio)}</title>
      <style>
        @page {
          size: letter portrait;
          margin: 12mm 14mm;
        }
        * { box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
          color: #0f172a;
          margin: 0;
          padding: 0;
          font-size: 12px;
          line-height: 1.4;
          background: #ffffff;
        }
        .sheet {
          width: 100%;
          max-width: 780px;
          margin: 0 auto;
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 18px;
          padding-bottom: 14px;
          border-bottom: 2px solid #0f172a;
        }
        .brand-col {
          flex: 1;
          min-width: 0;
        }
        .logo-wrap {
          margin-bottom: 8px;
        }
        .logo-img {
          display: block;
          max-width: 240px;
          max-height: 100px;
          width: auto;
          height: auto;
          object-fit: contain;
        }
        .emp-name {
          font-size: 16px;
          font-weight: 800;
          margin: 0 0 2px 0;
          color: #0f172a;
        }
        .emp-meta {
          font-size: 11px;
          color: #334155;
          margin: 0;
        }
        .doc-col {
          text-align: right;
          flex-shrink: 0;
          min-width: 170px;
        }
        .doc-type {
          font-size: 15px;
          font-weight: 800;
          letter-spacing: 0.4px;
          color: #0f172a;
          text-transform: uppercase;
        }
        .doc-folio {
          font-size: 14px;
          font-weight: 800;
          color: #0f172a;
          margin-top: 3px;
        }
        .doc-fecha {
          font-size: 11px;
          color: #475569;
          margin-top: 4px;
        }
        .badge-anulada {
          display: inline-block;
          margin-top: 6px;
          padding: 2px 8px;
          border-radius: 4px;
          background: #fee2e2;
          color: #b91c1c;
          border: 1px solid #fca5a5;
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.5px;
        }
        .cliente-box {
          margin-top: 12px;
          padding: 9px 12px;
          background: #f8fafc;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          display: flex;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
        }
        .cliente-box div {
          font-size: 12px;
        }
        table.items {
          width: 100%;
          border-collapse: collapse;
          margin-top: 14px;
        }
        table.items th {
          background: #0f172a;
          color: #ffffff;
          font-size: 10.5px;
          text-transform: uppercase;
          letter-spacing: 0.4px;
          padding: 8px 8px;
          text-align: left;
        }
        table.items th.num, table.items td.num {
          text-align: right;
          white-space: nowrap;
        }
        table.items td {
          padding: 8px 8px;
          border-bottom: 1px solid #e2e8f0;
          vertical-align: top;
          font-size: 11.5px;
        }
        .col-cod {
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-weight: 700;
          white-space: nowrap;
          width: 1%;
          padding-right: 12px !important;
        }
        .col-desc {
          word-break: break-word;
        }
        .col-cant { width: 55px; }
        .col-punit { width: 95px; }
        .col-tot { width: 100px; font-weight: 700; }
        .tag-origen {
          font-size: 10px;
          color: #475569;
          font-weight: 600;
        }
        .footer-grid {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 18px;
          margin-top: 16px;
        }
        .obs-col {
          flex: 1;
          font-size: 11px;
          color: #334155;
        }
        .pagos-box {
          margin-top: 8px;
          padding: 8px 10px;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          background: #f8fafc;
        }
        .pagos-title {
          font-size: 10px;
          font-weight: 800;
          text-transform: uppercase;
          color: #475569;
          margin-bottom: 4px;
        }
        .pago-line {
          display: flex;
          justify-content: space-between;
          font-size: 11px;
          padding: 1px 0;
        }
        .totales-col {
          width: 280px;
          flex-shrink: 0;
        }
        table.totales {
          width: 100%;
          border-collapse: collapse;
        }
        table.totales td {
          padding: 6px 8px;
          border-bottom: 1px solid #e2e8f0;
          font-size: 12px;
          font-weight: 700;
        }
        table.totales tr.tot-main td {
          background: #0f172a;
          color: #ffffff;
          font-size: 13px;
          font-weight: 800;
          border-bottom: none;
        }
        @media print {
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      </style>
    </head>
    <body>
      <div class="sheet">
        <div class="header">
          <div class="brand-col">
            ${logo ? `<div class="logo-wrap"><img src="${logo}" alt="Logo" class="logo-img" /></div>` : ""}
            <h1 class="emp-name">${nombreEmp}</h1>
            ${rifEmp ? `<p class="emp-meta"><strong>RIF:</strong> ${rifEmp}</p>` : ""}
            ${dirEmp ? `<p class="emp-meta">${dirEmp}</p>` : ""}
            ${(telEmp || emailEmp) ? `<p class="emp-meta">${telEmp ? `Telf: ${telEmp}` : ""} ${emailEmp ? `• ${emailEmp}` : ""}</p>` : ""}
          </div>
          <div class="doc-col">
            <div class="doc-type">${escaparHtml(tipo)}</div>
            <div class="doc-folio">N° ${escaparHtml(folio)}</div>
            <div class="doc-fecha">Fecha: ${escaparHtml(fechaTxt)}</div>
            ${anulada ? `<div class="badge-anulada">ANULADA</div>` : ""}
          </div>
        </div>

        <div class="cliente-box">
          <div><strong>Cliente:</strong> ${nomCli}</div>
          <div><strong>Cédula / RIF:</strong> ${docCli}</div>
        </div>

        <table class="items">
          <thead>
            <tr>
              <th>Código</th>
              <th>Descripción</th>
              <th class="num">Cant.</th>
              <th class="num">P. Unit ($)</th>
              <th class="num">Total ($)</th>
            </tr>
          </thead>
          <tbody>
            ${filasItems}
          </tbody>
        </table>

        <div class="footer-grid">
          <div class="obs-col">
            ${observaciones ? `<div><strong>Observaciones:</strong> ${escaparHtml(observaciones)}</div>` : ""}
            ${pagosHtml}
          </div>
          <div class="totales-col">
            <table class="totales">
              ${construirFilasTotales(totalUsd, monedas, tasas)}
            </table>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  abrirVentanaImpresion(html, `${tipo} #${folio}`);
}

export function imprimirTicket80mm({
  tipo = "NOTA DE ENTREGA",
  folio = "00001",
  empresa = {},
  cliente = {},
  items = [],
  totalUsd = 0,
  monedas = ["USD", "BS"],
  tasas = {},
  pagos = [],
  fecha = "",
  observaciones = "",
  anulada = false
} = {}) {
  const logo = obtenerLogoDocumento(empresa);
  const fechaTxt = formatearFechaVE(fecha);

  const html = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8" />
      <title>Ticket ${escaparHtml(folio)}</title>
      <style>
        @page { size: 80mm auto; margin: 3mm; }
        body {
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 11px;
          color: #000;
          width: 74mm;
          margin: 0 auto;
        }
        .center { text-align: center; }
        .logo-tkt {
          display: block;
          margin: 0 auto 6px auto;
          max-width: 58mm;
          max-height: 24mm;
          width: auto;
          height: auto;
          object-fit: contain;
        }
        hr { border: none; border-top: 1px dashed #000; margin: 6px 0; }
        .row { display: flex; justify-content: space-between; gap: 6px; }
        .bold { font-weight: 700; }
        .item { margin-bottom: 5px; }
      </style>
    </head>
    <body>
      <div class="center">
        ${logo ? `<img src="${logo}" alt="Logo" class="logo-tkt" />` : ""}
        <div class="bold">${escaparHtml(empresa.nombre || "MI EMPRESA")}</div>
        ${empresa.rif ? `<div>RIF: ${escaparHtml(empresa.rif)}</div>` : ""}
        ${empresa.telefono ? `<div>Telf: ${escaparHtml(empresa.telefono)}</div>` : ""}
      </div>
      <hr />
      <div class="row"><span class="bold">${escaparHtml(tipo)}</span><span class="bold">#${escaparHtml(folio)}</span></div>
      ${anulada ? `<div class="center bold">*** DOCUMENTO ANULADO ***</div>` : ""}
      <div>Fecha: ${escaparHtml(fechaTxt)}</div>
      <div>Cliente: ${escaparHtml(cliente.nombre || "Consumidor Final")}</div>
      <div>Doc: ${escaparHtml(cliente.documento || "V-00000000")}</div>
      <hr />
      ${(items || []).map((it) => `
        <div class="item">
          <div class="bold">${escaparHtml(it.codigo || "")} - ${escaparHtml(it.descripcion || "")}</div>
          <div class="row">
            <span>${it.cantidad} × $${fmtNum(it.precioUsd)}</span>
            <span class="bold">$${fmtNum(Number(it.cantidad || 1) * Number(it.precioUsd || 0))}</span>
          </div>
        </div>
      `).join("")}
      <hr />
      <table style="width:100%; border-collapse:collapse;">
        ${construirFilasTotales(totalUsd, monedas, tasas)}
      </table>
      ${Array.isArray(pagos) && pagos.length ? `
        <hr />
        <div class="bold">PAGOS:</div>
        ${pagos.map((p) => `<div class="row"><span>${escaparHtml(p.metodo)}${p.referencia ? ` (${escaparHtml(p.referencia)})` : ""}</span><span>$${fmtNum(p.montoUsd)}</span></div>`).join("")}
      ` : ""}
      ${observaciones ? `<hr /><div>${escaparHtml(observaciones)}</div>` : ""}
      <hr />
      <div class="center">¡Gracias por su compra!</div>
    </body>
    </html>
  `;

  abrirVentanaImpresion(html, `Ticket #${folio}`);
}

export function abrirDocumentoPDF(tipoDoc, registro = {}, state = {}) {
  const esCotizacion = String(tipoDoc || "").toLowerCase() === "cotizacion";
  const tasasBase = state?.tasas || {};
  const bcvActual =
    state?.modoTasaBCV === "manana" && Number(tasasBase.bcvManana || 0) > 0
      ? Number(tasasBase.bcvManana)
      : Number(tasasBase.bcvHoy || 0);
  const bcvDoc = Number(registro.tasaBcvUsada || 0) > 0 ? Number(registro.tasaBcvUsada) : bcvActual;

  const tasasDoc = {
    ...tasasBase,
    bcvActiva: bcvDoc,
    bcvHoy: bcvDoc
  };

  const fechaDoc = formatearFechaVE(registro.fechaIso || "", registro.creadoTs || 0);
  const obsPartes = [];

  if (registro.anulada) {
    obsPartes.push("DOCUMENTO ANULADO.");
  }

  if (esCotizacion) {
    obsPartes.push("Presupuesto referencial sujeto a disponibilidad de inventario y tasa BCV vigente.");
  } else {
    const descFavor = Number(registro.saldoFavorAplicadoUsd || 0);
    const vuelto = Number(registro.vueltoEntregadoUsd || 0);
    const sobrepago = Number(registro.sobrepagoUsd || 0);
    const saldoPend = Number(registro.saldoPendienteUsd || 0);

    if (descFavor > 0.01) obsPartes.push(`Saldo a favor descontado: -$${descFavor.toFixed(2)}.`);
    if (vuelto > 0.01) obsPartes.push(`Vuelto entregado: $${vuelto.toFixed(2)}.`);
    if (sobrepago > 0.01) obsPartes.push(`Acreditado a saldo a favor: +$${sobrepago.toFixed(2)}.`);

    if (!registro.anulada && (registro.esCredito || saldoPend > 0.01)) {
      const plazo = Number(registro.diasCredito || 15);
      obsPartes.push(`Crédito (${plazo} días) • Saldo pendiente: $${saldoPend.toFixed(2)}.`);
    } else if (!registro.anulada && Array.isArray(registro.abonos) && registro.abonos.length) {
      obsPartes.push("Nota saldada.");
    }
  }

  imprimirDocumentoCarta({
    tipo: esCotizacion ? "COTIZACIÓN" : "NOTA DE ENTREGA",
    folio: registro.folio || registro.id || "00001",
    empresa: state?.empresa || {},
    cliente: registro.cliente || { documento: "V-00000000", nombre: "Consumidor Final" },
    items: registro.items || [],
    totalUsd: Number(registro.totalUsd || 0),
    monedas: Array.isArray(registro.monedas) && registro.monedas.length ? registro.monedas : ["USD", "BS"],
    tasas: tasasDoc,
    pagos: esCotizacion ? [] : (registro.pagos || []),
    fecha: fechaDoc,
    observaciones: obsPartes.join(" "),
    anulada: Boolean(registro.anulada)
  });
}
