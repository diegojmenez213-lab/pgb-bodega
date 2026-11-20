const { XMLParser } = require("fast-xml-parser");
const { getDb } = require("./firebaseAdmin");
const { decryptObjectFields, limpiarRut, fechaIsoChile } = require("./cryptoVault");

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true
});

function calcularTotalesDte(items = [], descuentoGlobal = 0) {
  let netoAfecto = 0;
  let exento = 0;

  for (const item of items) {
    const cant = Number(item.cantidad ?? item.qty ?? 1) || 0;
    const precio = Number(item.precioUnitario ?? item.precio ?? item.price ?? 0) || 0;
    const descItem = Number(item.descuento ?? 0) || 0;
    const subtotal = Math.max(0, cant * precio - descItem);
    if (item.exento === true || Number(item.indExe) === 1) {
      exento += subtotal;
    } else {
      netoAfecto += subtotal;
    }
  }

  const descGlobal = Math.max(0, Number(descuentoGlobal) || 0);
  const netoFinal = Math.max(0, Math.round(netoAfecto - descGlobal));
  const exentoFinal = Math.max(0, Math.round(exento));
  const iva = Math.round(netoFinal * 0.19);
  const total = netoFinal + exentoFinal + iva;

  return {
    mntNeto: netoFinal,
    mntExe: exentoFinal,
    iva,
    mntTotal: total
  };
}

async function obtenerCredencialesSii(rutEmpresa) {
  const db = getDb();
  const limpio = limpiarRut(rutEmpresa);
  const snap = await db
    .collection("saas_empresas")
    .doc(limpio)
    .collection("credenciales_privadas")
    .doc("sii")
    .get();

  if (!snap.exists) {
    return {
      proveedor: "simulador",
      ambiente: "certificacion",
      secretos: {},
      metadatos: {}
    };
  }

  const data = snap.data() || {};
  return {
    proveedor: String(data.proveedor || "simulador").toLowerCase(),
    ambiente: data.ambiente === "produccion" ? "produccion" : "certificacion",
    secretos: decryptObjectFields(data.secretos || {}),
    metadatos: data.metadatos || {}
  };
}

function parsearRespuestaXmlSii(xmlTexto) {
  try {
    const parsed = xmlParser.parse(String(xmlTexto || ""));
    const root = parsed?.SII || parsed?.RESPUESTA_ENVIO_DTE || parsed?.ENVIO_DTE || parsed;
    return {
      parsedOk: true,
      rawKeys: Object.keys(root || {}),
      resumen: root
    };
  } catch (err) {
    return {
      parsedOk: false,
      errorXml: err.message
    };
  }
}

async function emitirDteUniversal(rutEmpresa, payload = {}) {
  const db = getDb();
  const limpio = limpiarRut(rutEmpresa);
  const cfg = await obtenerCredencialesSii(limpio);

  const tipoDte = Number(payload.tipoDte || 33); // 33: Factura Electrónica, 39: Boleta, 61: NC, 52: Guía
  const folioSolicitado = payload.folio ? Number(payload.folio) : null;
  const receptorRut = limpiarRut(payload.receptorRut || payload.rutReceptor || "");
  const receptorRazon = String(payload.receptorRazon || payload.razonSocialReceptor || "Cliente General").trim();
  const items = Array.isArray(payload.items) && payload.items.length
    ? payload.items
    : [{ nombre: payload.descripcion || "Producto / Servicio", cantidad: 1, precioUnitario: Number(payload.montoNeto || payload.montoTotal || 0) }];

  const totales = calcularTotalesDte(items, payload.descuentoGlobal || 0);
  const folioAsignado = folioSolicitado || Math.floor(100000 + Math.random() * 899999);
  const ahora = Date.now();
  const fechaEmision = payload.fechaEmision || fechaIsoChile(ahora);

  let resultadoProveedor = {
    proveedorUsado: cfg.proveedor,
    ambiente: cfg.ambiente,
    estadoSii: "ACEPTADO_SIMULADO",
    trackId: `SIM-${ahora}-${folioAsignado}`,
    xmlPreview: null
  };

  // Hooks listos para proveedores reales (OpenFactura / SimpleFactura / LibreDTE / XML directo)
  if (cfg.proveedor === "openfactura" && cfg.secretos.apiKey) {
    const baseUrl = cfg.ambiente === "produccion"
      ? "https://api.haulmer.com/v2/dte/document"
      : "https://dev-api.haulmer.com/v2/dte/document";
    try {
      const resp = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": cfg.secretos.apiKey
        },
        body: JSON.stringify({
          response: ["XML", "PDF", "FOLIO"],
          dte: {
            Encabezado: {
              IdDoc: { TipoDTE: tipoDte, Folio: folioAsignado, FchEmis: fechaEmision },
              Emisor: { RUTEmisor: limpio },
              Receptor: { RUTRecep: receptorRut, RznSocRecep: receptorRazon },
              Totales: {
                MntNeto: totales.mntNeto,
                MntExe: totales.mntExe,
                IVA: totales.iva,
                MntTotal: totales.mntTotal
              }
            },
            Detalle: items.map((it, idx) => ({
              NroLinDet: idx + 1,
              NmbItem: String(it.nombre || "Item").slice(0, 80),
              QtyItem: Number(it.cantidad ?? it.qty ?? 1),
              PrcItem: Number(it.precioUnitario ?? it.precio ?? 0),
              MontoItem: Math.round((Number(it.cantidad ?? it.qty ?? 1) || 0) * (Number(it.precioUnitario ?? it.precio ?? 0) || 0))
            }))
          }
        })
      });
      const jsonResp = await resp.json().catch(() => ({}));
      resultadoProveedor = {
        proveedorUsado: "openfactura",
        ambiente: cfg.ambiente,
        estadoSii: resp.ok ? "ENVIADO_PROVEEDOR" : "ERROR_PROVEEDOR",
        trackId: jsonResp.TOKEN || jsonResp.trackId || `OF-${ahora}`,
        detalleProveedor: jsonResp
      };
    } catch (err) {
      resultadoProveedor.estadoSii = "ERROR_CONEXION";
      resultadoProveedor.error = err.message;
    }
  } else if (cfg.xmlRaw) {
    resultadoProveedor.xmlParseado = parsearRespuestaXmlSii(cfg.xmlRaw);
  }

  const docData = {
    rutEmpresa: limpio,
    tipoDte,
    folio: folioAsignado,
    fechaEmision,
    receptorRut,
    receptorRazon,
    items,
    ...totales,
    ...resultadoProveedor,
    creadoTs: ahora
  };

  const docRef = await db
    .collection("saas_empresas")
    .doc(limpio)
    .collection("dtes_emitidos")
    .add(docData);

  return {
    id: docRef.id,
    ...docData
  };
}

module.exports = {
  calcularTotalesDte,
  obtenerCredencialesSii,
  parsearRespuestaXmlSii,
  emitirDteUniversal
};
