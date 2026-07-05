
# Panel Web Administrativo — Plan

Alcance enorme. Propongo construir en **4 fases** entregables (cada una probable y funcional) para no romper el sistema actual. Confirma o ajusta antes de empezar.

## Arquitectura general

- **Ruta**: `/panel` (protegida por contraseña `marlonsamir1221`, sesión encriptada vía `useSession` de TanStack — no re-pide hasta cerrar sesión).
- **Stack visual**: iOS-style Glass. Fondo = imagen espacial subida (guardada como asset Lovable). Avatar por defecto = logo Telegram subido con borde azul degradado tipo TikTok Stories.
- **Layout**: Bottom tab bar fija estilo iOS (Inventario · Usuarios · Editor Bot · Configuración). `viewport` con `maximum-scale=1, user-scalable=no` para evitar zoom.
- **Datos**: server functions `createServerFn` con `supabaseAdmin` (panel es admin-only tras gate). Cache invalidada tras cada mutación. Sin realtime — refetch inmediato.
- **Seguridad Keys**: entrega de key usa `SELECT ... FOR UPDATE SKIP LOCKED` en RPC atómica que descuenta saldo + marca key usada + crea order en una sola transacción. Cero riesgo de doble venta.

## Fase 1 — Gate + Shell + Inventario (esta entrega)

1. Migración: RPC `purchase_key_atomic(user_id, price_id)` que hace saldo→key→order atómico. Índices en `product_stock_keys(price_id, used)`.
2. Ruta `/panel/unlock` + server fns `unlockPanel` / `lockPanel` / `requirePanelSession`.
3. Shell `/panel` con tab bar Glass, fondo espacial, safe-areas iOS.
4. **Tab Inventario** con sub-secciones:
   - **Keys**: agregar (producto→duración→textarea multi-línea), importar CSV/pegar masivo, exportar CSV, buscar, filtrar por producto/duración/estado, eliminar múltiple, stock en vivo.
   - **Precios**: editar precio por producto+duración, guardar inmediato, restaurar original (guarda `original_price_usd`), copiar precios entre productos, crear ofertas (precio con `sale_price` + fecha).
   - **Productos**: CRUD, activar/desactivar, reordenar (drag), categorías nuevas.
   - **Métodos de pago**: CRUD sobre `payment_methods`, reordenar, activar/desactivar.
5. Shop handler: reemplazar entrega manual por llamada a `purchase_key_atomic`. Si stock = 0 → enviar a Bot Almacén (ya existe flujo).
6. Bot Admin: remover comandos de inventario/precios/productos/pagos. Mantener SOLO recepción de comprobantes.

## Fase 2 — Usuarios

Tarjetas Glass con avatar (logo Telegram + borde azul story), info completa, buscador ID/nombre/username, filtros por rol/estado/rango, acciones (cambiar rango, bloquear 24h/permanente, desbloquear, editar saldo, crear/eliminar precios personalizados vía `user_price_overrides`). Roles altos destacados con badge dorado.

## Fase 3 — Editor Bot de Compras

Tabla nueva `bot_texts` (key/value) y `bot_buttons` (label/action/order/parent). Shop handler lee textos/botones desde DB con cache 10s. Editor visual con drag para reordenar.

## Fase 4 — Configuración

Nombre sistema, logo, colores (CSS vars persistidas), modo mantenimiento (bandera global que Shop respeta), backup (export JSON de todas las tablas), limpiar caché, log de acciones (`admin_logs` ya existe — vista con filtros).

---

## Técnico

- `src/routes/panel/` (rutas file-based)
- `src/lib/panel/*.functions.ts` (server fns admin)
- `src/lib/panel/gate.server.ts` (sesión encriptada)
- Env nuevo: `PANEL_SESSION_SECRET` (auto-generado)
- Bot handlers: solo cambios quirúrgicos para quitar comandos migrados y usar RPC atómica

---

## Confirmación

¿Empiezo por **Fase 1 completa** (gate + inventario + integración compra atómica + limpieza Bot Admin)? Es la base crítica; el resto se apila encima sin romper nada.

Si quieres priorizar diferente (ej. Usuarios primero, o todo de una sola vez aceptando entrega más lenta y frágil), dímelo antes.
