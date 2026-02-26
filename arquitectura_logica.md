# 🧠 Arquitectura Lógica y Flujo de Conversación del Bot — Zona Traumática

Este documento detalla el árbol lógico exacto que sigue el bot de Zona Traumática al recibir un mensaje de un cliente. 

El bot opera como un embudo (funnel) donde el mensaje debe pasar por varios filtros antes de llegar a la IA (Gemini) o antes de ser transferido a un humano.

---

## 🌳 Árbol de Decisión Principal (`index.js`)

```mermaid
graph TD
    A([📩 Mensaje Entrante WhatsApp]) --> B{¿Es del Bot o Sistema?}
    B -- Sí --> Z([Silencioso / Ignorar])
    B -- No --> C{🛑 Filtro Anti-Bot / Anti-Loop}

    C -- "Es Bot (Nequi, Claro, etc)\n o >50 msgs en 5 min" --> Z
    C -- "Usuario Normal" --> D{🔇 Filtros del CRM (Panel)}

    D -- "Ignorado por Admin" --> Z
    D -- "Sospecha de Spam" --> Z
    D -- "Permitido" --> E[[⏳ Debounce (10 segundos)]]

    E -->|Espera que el cliente \n termine de escribir| F{🗂️ Tipo de Mensaje}

    %% ---------------------------
    %% RAMA DE MEDIA (Audios, Imágenes)
    %% ---------------------------
    F -- "Media (Audio, PDF, Imagen)" --> G{📂 Qué tipo de adjunto es?}
    
    %% Imágenes / Comprobantes
    G -- "Imagen" --> H{📸 Escaneo QR}
    H -- "Detecta QR" --> I["Lee QR y responde sobre él"]
    H -- "Sin QR" --> J{💰 ¿Es Comprobante?}
    J -- "Sí" --> K["Guarda en 'Comprobantes Pendientes'\nNotifica a Álvaro\nPone estado: HOT"]
    J -- "No" --> L["Envía imagen a Gemini Vision\npara analizar contexto"]

    %% Audios
    G -- "Audio / Nota de Voz" --> M["Descarga Audio\nLo transcribe Gemini\nResponde como si fuera texto"]
    
    %% PDFs
    G -- "PDF" --> N["Descarga PDF\nGemini lee texto/fotos\nResponde según contenido"]

    %% Videos y Otros
    G -- "Video / Sticker" --> O["Sticker: Ignorado\nVideo: Pide texto"]

    %% ---------------------------
    %% RAMA DE TEXTO / FLUJO NORMAL
    %% ---------------------------
    F -- "Texto Normal" --> P{⚙️ Estado del Bot para este Cliente}
    
    P -- "Bot Pausado (Álvaro en chat)" --> Q(["Guarda mensaje en CRM pero\n NO responde automáticamente"])
    P -- "Bot Activo" --> R["1. Extrae/Actualiza Nombre\n2. Guarda mensaje en CRM\n3. Muestra 'Escribiendo...'"]

    R --> S{🔍 Detección de Intención (Reglas locales)}

    %% Intención 1: Post-Venta
    S -- "Intención Post-Venta\n(Carnet, Envío, Garantía)" --> T{¿Ya confirmó \nque pagó algo?}
    T -- "No" --> U(["Pregunta: '¿Tienes un proceso ya pagado?'"])
    T -- "Sí" --> V((Deriva a Humano\nEstado: POST-VENTA))

    %% Intención 2: Compra Caliente / Exige Humano
    S -- "Intención de Compra Lista\n o Pide un Asesor" --> W{¿Tiene historial\nsuficiente? (>6 msgs)}
    W -- "Sí, o lo exigió" --> X((Deriva a Asesor\nEstado: ASSIGNED))
    W -- "No" --> Y

    %% Intención 3: Conversación Normal (Gemini)
    S -- "Dudas, Precios, Catálogo" --> Y{🤖 Búsqueda Inteligente (RAG)}
    
    Y -- "No es sobre productos" --> AA["Carga System Prompt\n y Ficha del Cliente"]
    Y -- "Pregunta por Productos" --> AB["Busca en catalogo_contexto.json\nExtrae Top 6 mejores coincidencias"]
    
    AA --> AC
    AB --> AC["Entra a Gemini 2.5 Pro"]
    AC --> AD(["💬 El Bot Responde en WhatsApp"])
    
    AD --> AE{🔍 Post-Análisis (Background)}
    AE --> |"El bot menciona 'Plan Plus/Pro'"| AF["Envía imagen promo del Club ZT"]
    AE --> |"El cliente confirma pago"| AG["Actualiza estado a carnet/despacho pendiente"]
    AE --> |Siempre| AH["Gemini Flash analiza la charla\n y actualiza la FICHA DEL CLIENTE"]
```

---

## 📌 Explicación de las Fases Clave

### 1. Filtros de Salubridad (Antes de leer el mensaje)
El bot tiene barreras de hierro antes de gastar recursos de IA:
- **Anti-Bots:** Si llega un mensaje de Nequi, soporte técnico, o un número muy corto, se descarta silenciosamente.
- **Debounce:** Nunca responde instantáneamente. Si escribes un "Hola", el bot espera 10 segundos. Si escribes "quiero un arma", junta todo ("Hola quiero un arma") y procesa una sola vez.

### 2. Visión y Audición Periférica
- **Si mandan un Audio:** Baja el archivo `.ogg`, se lo pasa directamente a Gemini para que lo transcriba y analice. Gemini entiende y responde de vuelta en texto (o audio si estuviera configurado).
- **Si mandan Imagen:** Primero intenta buscar Códigos QR. Si no hay QR, usa una IA secundaria muy rápida (`gemini-flash`) para preguntarle la pantalla: *"¿Esto parece una captura de una transferencia bancaria o Nequi?"*. Si dice que sí, dispara las alarmas para pasarlo al panel como un PAGO. Si dice que no, la procesa normalmente.

### 3. Rutas de Empleados (Handoff o Derivación)
El bot no quiere hacer todo. Su objetivo es madurar clientes.
- Si el bot detecta frases explícitas de post-venta (*"No me llegó la guía"*, *"Cambié de arma y quiero el carnet"*), corta la IA y lo manda al Panel del CRM con una campana roja (Estado: Post-Venta).
- Si el bot detecta que el cliente dice *"Quiero pagar"*, *"Envíame el link"*, corta la IA y se lo manda por Round-Robin a Álvaro u otro empleado (Estado: Hot Lead).

### 4. Inteligencia Artificial y Búsqueda (RAG)
Si el cliente solo está preguntando (ej: *"¿Qué revólver recomendás barato?"*):
1. **Buscador Local:** Un script busca en el `catalogo_contexto.json` palabras clave como "revólver" y "económico". Saca los 3 mejores resultados.
2. **Contexto:** Lee cómo se llama el cliente ("Juan") y todo lo que ha hablado en los últimos 10 mensajes.
3. **Respuesta:** Junta el catálogo, las instrucciones maestras (prompts.js) y la historia, y Gemini genera una respuesta vendedora y humana.
4. **Ficha (Memoria):** Silenciosamente, otro bot analiza lo que se hablaron y actualiza la "Ficha" del CRM (ej: *"Juan, busca algo económico, prefiere revólver"*).
