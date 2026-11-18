# PLANO MAESTRO • NEXUS ERP CHILE (SaaS Multi-Empresa)
**Última actualización:** Martes 17 / Miércoles 18 Noviembre 2026
**Repositorio:** `diegojmenez213-lab/pgb-bodega` (GitHub Pages)
**Base de Datos:** Firebase (`projectId: "pgb-bodegad"`)

---

## 1. ARQUITECTURA DE ARCHIVOS EN GITHUB
1. `index.html`: Esqueleto Maestro en React + Tailwind + Firebase. Contiene:
   - Portal de acceso corporativo limpio (RUT sin puntos/guion + Clave) con sesión persistente en `localStorage` (`nexus_empresa_rut`).
   - Puerta trasera privada de Super Admin en URL `#/comando` (o 5 toques seguidos en el escudo del login) protegida con clave maestra.
   - Panel Super Admin con KPIs en vivo, plantillas por rubro, interruptores individuales de módulos, control de estado (`activo` / `aviso` / `suspendido`), modo de acceso (`General` vs `Por Roles`) y carga de logos exactos en PNG (`logoBase64`).
   - Espacio de trabajo modular para empresas nuevas (ej. Tecnoshop).
2. `pgb-operacion.html`: Operación intacta de PGB Distribution Chile SpA (incluye botón flotante `⇄ Salir` abajo a la izquierda).
3. `pgb-backup.html`: Respaldo de seguridad intocable de la versión original de PGB (3.293 líneas).
4. `PLANO_MAESTRO.md`: Este mapa técnico de continuidad.

---

## 2. ESTRUCTURA EN FIREBASE (`Firestore`)
- **`saas_empresas/{rut}`**: Ficha maestra de cada cliente (`rut`, `razonSocial`, `clave`, `rubro`, `estado`, `modoJerarquia`, `tarifaUF`, `sucursales`, `logoBase64`, `rutaLegacy`, `modulos`).
- **Colecciones operativas actuales de PGB**: Intactas y conectadas directamente desde `pgb-operacion.html`.

---

## 3. EMPRESAS REGISTRADAS EN PRODUCCIÓN
1. **PGB Distribution Chile SpA**
   - **RUT:** `769497226` | **Clave:** `1234` | **Rubro:** `distribuidora` (`6 UF`)
   - **Configuración:** `modoJerarquia: false` (acceso general), `rutaLegacy: "pgb-operacion.html"`.
2. **Tecnoshop Company SpA** *(Cliente objetivo reunión sábado)*
   - **RUT:** `775280425` | **Clave:** `1234` | **Rubro:** `ecommerce` (`4 UF`)
   - **Módulos activos:** E-Commerce 24/7 + Marketplaces, Bandejas de Impresión por Lotes, Conteo Cíclico, Compras XML, Sugerido por Proveedor, Punto de Equilibrio Neto y Auto-CAF.

---

## 4. HOJA DE RUTA Y ESTADO DE AVANCE
- [x] **Martes (Completado):** Respaldo PGB, Esqueleto Maestro (`index.html`), Super Admin (`#/comando`), carga de Logos PNG exactos, aislamiento de PGB y creación de Tecnoshop.
- [ ] **Miércoles (Siguiente):** Construir el **Motor E-Commerce Omnicanal** dentro de `index.html` para Tecnoshop (`775280425`): pedidos en vivo de Mercado Libre, Falabella y Líder, switch *Automático 24/7 vs. Pausa* (timbrado SII < 4s), Escudo Anti-Error de RUT y Bandejas de Impresión por Lotes (Cola Física Líder separada de Cola General).
- [ ] **Jueves:** Agregar **Punto de Equilibrio Vivo** (valores netos), carga de **Compras XML del SII**, **Canje Boleta → Factura (39 a 33)** en 1 toque y simulador **Auto-CAF**.
- [ ] **Viernes:** Pruebas anti-caídas en móvil/PC y guion comercial para la reunión del sábado.
