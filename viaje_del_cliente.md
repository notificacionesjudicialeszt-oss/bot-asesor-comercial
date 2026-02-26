# 🗺️ El Viaje del Cliente — Lógica de Negocio de Zona Traumática

Este documento explica las **rutas comerciales** por las que pasa un cliente desde que envía su primer "Hola" hasta que se convierte en un afiliado activo o recibe su pedido. 

Aquí no hablamos de código, sino de los estados del cliente, qué busca y dónde queda su información (especialmente la plata/comprobantes).

---

## 👥 1. Los 5 Perfiles de un Cliente

Cuando alguien escribe al WhatsApp, el sistema lo clasifica en uno de estos estados:

1. **Nuevo Prospecto (`new`):** Está vitrineando. Pregunta si son legales las traumáticas, pide catálogo o pregunta por el Club. El Bot IA lo atiende 100% resolviendo dudas e intentando perfilarlo.
2. **Lead Caliente (`hot` / `assigned`):** Dijo palabras mágicas ("quiero comprar", "pásame la cuenta", "hablar con asesor"). El Bot lo manda al Panel del CRM para que un humano retome la venta y cierre el trato.
3. **Esperando Despacho (`despacho_pendiente`):** El cliente ya pagó un arma, munición o accesorios. Está esperando que le envíen el número de guía (tracking).
4. **Esperando Carnet (`carnet_pendiente`):** El cliente pagó su afiliación (Club Plus/Pro). Está en proceso de enviar sus datos (cédula, serial del arma, foto) para que le generen el carnet QR.
5. **Post-Venta / Cliente Activo (`postventa`):** Ya recibió su carnet o producto. Si este cliente escribe por garantía, renovación, o un cambio de arma en su carnet, el bot lo manda a "Prioridad Post-Venta" para un humano.

---

## 💰 2. ¿Qué pasa cuando el cliente PAGA? (La ruta del Comprobante)

La gestión del dinero es el punto más crítico. Así funciona:

1. **Cliente envía la captura:** El cliente manda la foto de la transferencia (Nequi, Bancolombia, Bold).
2. **El Bot lo ataja:** El bot detecta que es una imagen de pago, NO le dice "pago confirmado" (por seguridad anti-fraude), sino que le responde: *"¡Recibido! Le pasamos el comprobante al equipo para verificarlo"*.
3. **¿Dónde queda guardado?** La foto y los datos del pago se guardan en la tabla segura `comprobantes` de la base de datos central.
4. **Aparece en tu Panel:** Ese pago aparece inmediatamente en tu **Panel Administrativo**, en la pestaña 💰 **Por Verificar**.
5. **Tú decides (El Humano):** 
   - Entras al Panel, revisas la imagen y tu cuenta bancaria real.
   - Si la plata entró, le das al botón **Confirmar**.
   - Si es falso, le das a **Rechazar**.
6. **Reacción del Sistema:** Al hacer clic en "Confirmar", el panel automáticamente le avisa por WhatsApp al cliente que su pago fue exitoso y lo pasa a la siguiente etapa (Pedir datos de envío o datos de carnet).

---

## 🛣️ 3. Las Tres Rutas de Venta Posibles

### RUTA A: Compra de Arma (Solo Producto)
*   **Interés:** El cliente quiere, por ejemplo, una Ekol Firat Magnum.
*   **Cierre:** Hace el pago y envía comprobante.
*   **Panel:** Confirmas el pago en la pestaña "Por Verificar".
*   **Acción:** Reúnes sus datos de dirección y le envías por transportadora. El cliente recibe el arma, munición, factura y el bono temporal del Club.

### RUTA B: Afiliación al Club ZT (Plus o Pro)
*   **Interés:** El cliente ya tiene arma (o la está comprando) y quiere blindaje legal.
*   **Cierre:** Paga los $100.000 (Plus) o $150.000 (Pro) y envía el comprobante.
*   **Panel:** Confirmas el pago. El sistema lo etiqueta internamente como `is_club_plus` o `is_club_pro`.
*   **Acción:** Inicia el trámite del carnet. Debes pedirle por chat su foto, cédula y serial del arma para emitirle el documento con código QR. Automáticamente accede al Bot Asesor IA como bono por 6 meses.

### RUTA C: Compra del Bot "Asesor Legal IA" (Promo temporal)
*   **Interés:** Solo quiere el abogado en el bolsillo por $50.000 (no le alcanza para el club o aún no está convencido).
*   **Cierre:** Paga los $50.000 y envía comprobante.
*   **Panel:** Confirmas el comprobante (aparece etiquetado tipo: `bot_asesor`).
*   **Acción:** Le notificas que dentro de 24 horas el sistema estará enlazado a su número para que pueda consultar la ley en cualquier momento.

---

## 🛠️ 4. ¿Cuándo entra a actuar un ASESOR HUMANO (Panel)?

El panel está diseñado para que el bot haga el 80% del trabajo pesado (responder dudas, pelear objeciones legales, convencer, dar precios). El equipo humano en el panel SOLO interviene cuando ocurren los momentos clave del 20%:

1. **Recaudar y Validar:** Verificar comprobantes de pago recibidos.
2. **Generar Confianza Final:** Si un lead caliente dice "quiero pagar pero tengo dudas", un humano entra al chat y remata la venta.
3. **Trámites Operativos:** Armar las cajas (despachos) y diseñar los carnets.
4. **Apagar Incendios Post-Venta:** Si un cliente activo escribe molesto o pidiendo una renovación, el panel te alerta saltándose al bot.
