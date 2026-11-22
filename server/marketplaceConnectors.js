const crypto = require("crypto");

/**
 * Convierte montos brutos (IVA incluido, estándar en marketplaces de Chile)
 * a desglose tributario exacto para SII sin descuadres de $1.
 */
function desglosarBrutoChile(montoBruto) {
  const total = Math.max(0, Math.round(Number(montoBruto) || 0));
  const neto = Math.round(total / 1.19);
  const iva = total - neto;
  return { mntNeto: neto, iva, mntTotal: total };
}

function normalizarRutBasico(rut) {
  return String(rut || "")
    .replace(/\./g, "")
    .replace(/\s+/g, "")
    .toUpperCase()
    .trim();
}

/**
 * Normaliza los ítems de cualquier marketplace a formato SII (precio neto unitario)
 */
function normalizarItemsMarketplace(rawItems = []) {
  return rawItems.map((it) => {
    const cantidad = Math.max(1, Number(it.cantidad || 1));
    const precioUnitarioBruto = Math.max(0, Math.round(Number(it.precioUnitarioBruto || 0)));
    const precioUnitarioNeto = Math.round(precioUnitarioBruto / 1.19);
    return {
      sku: String(it.sku || "").trim(),
      nombre: String(it.nombre || "Producto Marketplace").trim().slice(0, 80),
      cantidad,
      precioUnitarioBruto,
      precioUnitario: precioUnitarioNeto, // usado por siiEngine.js
      totalBruto: precioUnitarioBruto * cantidad
    };
  });
}

/* ============================================================================
   1. CONECTOR REAL: MERCADO LIBRE CHILE (OAuth2 + Refresh Token + Billing Info)
   Credenciales esperadas en bóveda:
   - clientId, clientSecret, refreshToken (y/o accessToken), sellerId
   ============================================================================ */
async function refrescarTokenMeli(secretos = {}) {
  let accessToken = secretos.accessToken || "";
  let refreshToken = secretos.refreshToken || "";
  let tokenActualizado = false;

  if (secretos.clientId && secretos.clientSecret && refreshToken) {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: String(secretos.clientId),
      client_secret: String(secretos.clientSecret),
      refresh_token: String(refreshToken)
    });

    const resp = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });

    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.access_token) {
      accessToken = data.access_token;
      if (data.refresh_token) refreshToken = data.refresh_token;
      tokenActualizado = true;
    } else if (!accessToken) {
      throw new Error(`Mercado Libre OAuth falló: ${data.message || data.error || resp.status}`);
    }
  }

  if (!accessToken) {
    throw new Error("Falta accessToken o refreshToken válido para Mercado Libre.");
  }

  return { accessToken, refreshToken, tokenActualizado };
}

async function obtenerBillingInfoMeli(orderId, accessToken) {
  try {
    const resp = await fetch(`https://api.mercadolibre.com/orders/${orderId}/billing_info`, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "x-version": "2"
      }
    });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    return data?.billing_info || data || null;
  } catch {
    return null;
  }
}

async function fetchOrdenesMeli(secretos = {}, metadatos = {}, limite = 20) {
  const tokenInfo = await refrescarTokenMeli(secretos);
  const accessToken = tokenInfo.accessToken;

  let sellerId = secretos.sellerId || metadatos.sellerId || "";
  if (!sellerId) {
    const meResp = await fetch("https://api.mercadolibre.com/users/me", {
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
    const meData = await meResp.json().catch(() => ({}));
    if (!meResp.ok || !meData.id) {
      throw new Error(`No se pudo obtener sellerId de Mercado Libre: ${meData.message || meResp.status}`);
    }
    sellerId = String(meData.id);
  }

  const limitSafe = Math.min(50, Math.max(1, Number(limite) || 20));
  const url = `https://api.mercadolibre.com/orders/search?seller=${encodeURIComponent(sellerId)}&order.status=paid&sort=date_desc&limit=${limitSafe}`;

  const resp = await fetch(url, {
    headers: { "Authorization": `Bearer ${accessToken}` }
  });
  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(`Mercado Libre orders/search error (${resp.status}): ${data.message || "Sin detalle"}`);
  }

  const results = Array.isArray(data.results) ? data.results : [];
  const ordenes = [];

  for (const ord of results) {
    const orderId = String(ord.id);
    const billing = await obtenerBillingInfoMeli(orderId, accessToken);

    const additional = Array.isArray(billing?.additional_info) ? billing.additional_info : [];
    const getAdd = (type) => additional.find((a) => a.type === type)?.value || "";

    const docType = String(billing?.doc_type || "").toUpperCase();
    const docNumber = normalizarRutBasico(billing?.doc_number || getAdd("DOC_NUMBER") || "");
    const businessName = getAdd("BUSINESS_NAME") || "";
    const firstName = getAdd("FIRST_NAME") || ord.buyer?.first_name || "";
    const lastName = getAdd("LAST_NAME") || ord.buyer?.last_name || "";
    const giro = getAdd("TAXPAYER_TYPE_ID") || getAdd("BUSINESS_ACTIVITY") || "";
    const direccion = [getAdd("STREET_NAME"), getAdd("STREET_NUMBER")].filter(Boolean).join(" ").trim();
    const comuna = getAdd("CITY_NAME") || getAdd("NEIGHBORHOOD") || "";

    // Regla Chile: si el comprador ingresó datos de empresa / factura -> Factura 33; si no -> Boleta 39
    const quiereFactura = Boolean(
      businessName ||
      String(getAdd("IS_TAXPAYER")).toLowerCase() === "true" ||
      (docType === "RUT" && Number(docNumber.split("-")[0]) >= 50000000)
    );

    const itemsRaw = (Array.isArray(ord.order_items) ? ord.order_items : []).map((oi) => ({
      sku: oi.item?.seller_sku || oi.item?.id || "",
      nombre: oi.item?.title || "Producto Mercado Libre",
      cantidad: Number(oi.quantity || 1),
      precioUnitarioBruto: Number(oi.unit_price || 0)
    }));

    const items = normalizarItemsMarketplace(itemsRaw);
    const montoTotalBruto = Math.round(Number(ord.total_amount || 0)) ||
      items.reduce((acc, it) => acc + it.totalBruto, 0);

    ordenes.push({
      canal: "meli",
      orderId,
      packId: ord.pack_id ? String(ord.pack_id) : null,
      fechaCreacion: ord.date_created || new Date().toISOString(),
      estadoCanal: ord.status || "paid",
      tipoDteSugerido: quiereFactura ? 33 : 39,
      receptor: {
        rut: docNumber || "66666666-6",
        razonSocial: (businessName || `${firstName} ${lastName}`.trim() || ord.buyer?.nickname || "Consumidor Final").slice(0, 100),
        giro: giro || (quiereFactura ? "Comercio" : "Particular"),
        direccion: direccion || "Santiago",
        comuna: comuna || "Santiago"
      },
      items,
      ...desglosarBrutoChile(montoTotalBruto),
      moneda: ord.currency_id || "CLP"
    });
  }

  return {
    ordenes,
    credencialesActualizadas: tokenInfo.tokenActualizado
      ? { accessToken: tokenInfo.accessToken, refreshToken: tokenInfo.refreshToken, sellerId }
      : null
  };
}

/* ============================================================================
   2. CONECTOR REAL: FALABELLA SELLER CENTER CHILE (HMAC-SHA256)
   Credenciales esperadas en bóveda:
   - userId (correo cuenta Seller Center), apiKey
   - opcional en metadatos: baseUrl (default https://sellercenter-api.falabella.com/)
   ============================================================================ */
function rfc3986Encode(str) {
  return encodeURIComponent(String(str)).replace(/[!'()*]/g, (c) =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

async function callFalabellaApi(secretos, metadatos, action, extraParams = {}) {
  const userId = secretos.userId || secretos.email || "";
  const apiKey = secretos.apiKey || "";
  if (!userId || !apiKey) {
    throw new Error("Faltan userId (email Seller Center) o apiKey para Falabella.");
  }

  const baseUrl = String(metadatos.baseUrl || secretos.baseUrl || "https://sellercenter-api.falabella.com/").replace(/\/?$/, "/");
  const params = {
    Action: action,
    Format: "JSON",
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    UserID: userId,
    Version: "1.0",
    ...extraParams
  };

  const sortedKeys = Object.keys(params).sort();
  const canonicalQuery = sortedKeys
    .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(params[k])}`)
    .join("&");

  const signature = crypto
    .createHmac("sha256", apiKey)
    .update(canonicalQuery)
    .digest("hex");

  const url = `${baseUrl}?${canonicalQuery}&Signature=${signature}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: { "Accept": "application/json" }
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.ErrorResponse) {
    const msg = data?.ErrorResponse?.Head?.ErrorMessage || `HTTP ${resp.status}`;
    throw new Error(`Falabella ${action} falló: ${msg}`);
  }
  return data?.SuccessResponse?.Body || {};
}

async function fetchOrdenesFalabella(secretos = {}, metadatos = {}, limite = 20) {
  const statusFiltro = metadatos.statusFiltro || "pending";
  const body = await callFalabellaApi(secretos, metadatos, "GetOrders", {
    Status: statusFiltro,
    Limit: String(Math.min(50, Math.max(1, Number(limite) || 20))),
    SortBy: "created_at",
    SortDirection: "DESC"
  });

  const rawOrders = body?.Orders?.Order;
  const orderList = Array.isArray(rawOrders) ? rawOrders : rawOrders ? [rawOrders] : [];
  const ordenes = [];

  for (const ord of orderList) {
    const orderId = String(ord.OrderId || ord.OrderNumber);
    let itemsRaw = [];

    try {
      const itemsBody = await callFalabellaApi(secretos, metadatos, "GetOrderItems", {
        OrderId: orderId
      });
      const rawItems = itemsBody?.OrderItems?.OrderItem;
      const itemList = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
      itemsRaw = itemList.map((it) => ({
        sku: it.Sku || it.ShopSku || "",
        nombre: it.Name || "Producto Falabella",
        cantidad: 1, // Falabella devuelve 1 fila por unidad
        precioUnitarioBruto: Number(it.PaidPrice || it.ItemPrice || 0)
      }));
    } catch {
      itemsRaw = [{
        sku: "",
        nombre: `Pedido Falabella #${ord.OrderNumber || orderId}`,
        cantidad: Number(ord.ItemsCount || 1),
        precioUnitarioBruto: Number(ord.Price || 0)
      }];
    }

    const items = normalizarItemsMarketplace(itemsRaw);
    const montoTotalBruto = Math.round(Number(ord.Price || 0)) ||
      items.reduce((acc, it) => acc + it.totalBruto, 0);

    const billing = ord.AddressBilling || {};
    const rutCliente = normalizarRutBasico(
      ord.NationalRegistrationNumber || billing.TaxIdentificationNumber || ""
    );
    const quiereFactura = Boolean(
      String(ord.InvoiceRequired || "").toLowerCase() === "true" ||
      (rutCliente && Number(rutCliente.split("-")[0]) >= 50000000)
    );

    const nombreCompleto = `${ord.CustomerFirstName || billing.FirstName || ""} ${ord.CustomerLastName || billing.LastName || ""}`.trim();

    ordenes.push({
      canal: "falabella",
      orderId,
      orderNumber: String(ord.OrderNumber || orderId),
      fechaCreacion: ord.CreatedAt || new Date().toISOString(),
      estadoCanal: Array.isArray(ord.Statuses?.Status) ? ord.Statuses.Status[0] : (ord.Statuses?.Status || statusFiltro),
      tipoDteSugerido: quiereFactura ? 33 : 39,
      receptor: {
        rut: rutCliente || "66666666-6",
        razonSocial: (nombreCompleto || "Consumidor Final Falabella").slice(0, 100),
        giro: quiereFactura ? "Comercio" : "Particular",
        direccion: [billing.Address1, billing.Address2].filter(Boolean).join(" ").trim() || "Santiago",
        comuna: billing.City || "Santiago"
      },
      items,
      ...desglosarBrutoChile(montoTotalBruto),
      moneda: "CLP"
    });
  }

  return { ordenes, credencialesActualizadas: null };
}

/* ============================================================================
   3. CONECTOR REAL: LIDER / WALMART CHILE MARKETPLACE (OAuth2 Client Credentials)
   Credenciales esperadas en bóveda:
   - clientId, clientSecret
   - opcional en metadatos: baseUrl (default https://marketplace.walmartapis.com),
     tokenUrl, channelType
   ============================================================================ */
async function obtenerTokenLider(secretos = {}, metadatos = {}) {
  const clientId = secretos.clientId || "";
  const clientSecret = secretos.clientSecret || "";
  if (!clientId || !clientSecret) {
    throw new Error("Faltan clientId o clientSecret para Lider (Walmart Marketplace).");
  }

  const baseUrl = String(metadatos.baseUrl || secretos.baseUrl || "https://marketplace.walmartapis.com").replace(/\/+$/, "");
  const tokenUrl = metadatos.tokenUrl || `${baseUrl}/v3/token`;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "WM_SVC.NAME": "Walmart Marketplace",
      "WM_QOS.CORRELATION_ID": crypto.randomUUID()
    },
    body: "grant_type=client_credentials"
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    throw new Error(`Lider OAuth falló (${resp.status}): ${data.error_description || data.message || "Sin detalle"}`);
  }

  return { accessToken: data.access_token, baseUrl };
}

async function fetchOrdenesLider(secretos = {}, metadatos = {}, limite = 20) {
  const { accessToken, baseUrl } = await obtenerTokenLider(secretos, metadatos);
  const limitSafe = Math.min(50, Math.max(1, Number(limite) || 20));
  const status = metadatos.statusFiltro || "Acknowledged";

  const url = `${baseUrl}/v3/orders?limit=${limitSafe}&status=${encodeURIComponent(status)}`;
  const headers = {
    "WM_SEC.ACCESS_TOKEN": accessToken,
    "WM_SVC.NAME": "Walmart Marketplace",
    "WM_QOS.CORRELATION_ID": crypto.randomUUID(),
    "Accept": "application/json"
  };
  if (metadatos.channelType || secretos.channelType) {
    headers["WM_CONSUMER.CHANNEL.TYPE"] = metadatos.channelType || secretos.channelType;
  }

  const resp = await fetch(url, { method: "GET", headers });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Lider GET /v3/orders falló (${resp.status}): ${data.message || "Sin detalle"}`);
  }

  const rawList = data?.list?.elements?.order || data?.orders || [];
  const orderList = Array.isArray(rawList) ? rawList : [];
  const ordenes = [];

  for (const ord of orderList) {
    const orderId = String(ord.purchaseOrderId || ord.customerOrderId);
    const lines = ord?.orderLines?.orderLine || [];
    const lineList = Array.isArray(lines) ? lines : [];

    const itemsRaw = lineList.map((ln) => {
      const charge = (ln.charges?.charge || []).find((c) => c.chargeType === "PRODUCT") || ln.charges?.charge?.[0] || {};
      const cant = Number(ln.orderLineQuantity?.amount || 1);
      const totalLinea = Number(charge.chargeAmount?.amount || 0) + Number(charge.tax?.taxAmount?.amount || 0);
      return {
        sku: ln.item?.sku || "",
        nombre: ln.item?.productName || "Producto Lider",
        cantidad: cant,
        precioUnitarioBruto: cant > 0 ? Math.round(totalLinea / cant) : totalLinea
      };
    });

    const items = normalizarItemsMarketplace(itemsRaw);
    const montoTotalBruto = items.reduce((acc, it) => acc + it.totalBruto, 0);

    const shipping = ord.shippingInfo?.postalAddress || {};
    const rutCliente = normalizarRutBasico(ord.billingInfo?.taxId || ord.customerTaxId || "");
    const quiereFactura = Boolean(rutCliente && Number(rutCliente.split("-")[0]) >= 50000000);

    ordenes.push({
      canal: "lider",
      orderId,
      customerOrderId: String(ord.customerOrderId || orderId),
      fechaCreacion: ord.orderDate ? new Date(ord.orderDate).toISOString() : new Date().toISOString(),
      estadoCanal: status,
      tipoDteSugerido: quiereFactura ? 33 : 39,
      receptor: {
        rut: rutCliente || "66666666-6",
        razonSocial: (shipping.name || ord.customerName || "Consumidor Final Lider").slice(0, 100),
        giro: quiereFactura ? "Comercio" : "Particular",
        direccion: [shipping.address1, shipping.address2].filter(Boolean).join(" ").trim() || "Santiago",
        comuna: shipping.city || "Santiago"
      },
      items,
      ...desglosarBrutoChile(montoTotalBruto),
      moneda: "CLP"
    });
  }

  return { ordenes, credencialesActualizadas: null };
}

async function fetchOrdenesPorCanal(canal, secretos, metadatos, limite = 20) {
  switch (canal) {
    case "meli":
      return fetchOrdenesMeli(secretos, metadatos, limite);
    case "falabella":
      return fetchOrdenesFalabella(secretos, metadatos, limite);
    case "lider":
      return fetchOrdenesLider(secretos, metadatos, limite);
    default:
      throw new Error(`Canal no soportado: ${canal}`);
  }
}

module.exports = {
  desglosarBrutoChile,
  fetchOrdenesPorCanal,
  fetchOrdenesMeli,
  fetchOrdenesFalabella,
  fetchOrdenesLider
};
