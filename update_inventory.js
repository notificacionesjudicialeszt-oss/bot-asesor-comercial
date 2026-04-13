require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Inicializar Gemini
const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
if (GEMINI_KEYS.length === 0) {
  console.error('❌ ERROR: No se encontró GEMINI_API_KEYS en el archivo .env');
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(GEMINI_KEYS[0]);

const IMAGE_PATH = path.join(__dirname, 'imagenes', 'oferta actual', 'inventario y precios', 'tabla excel.png');
const CATALOG_PATH = path.join(__dirname, 'catalogo_contexto.json');

// Función auxiliar para convertir la imagen local a la estructura que requiere Gemini
function fileToGenerativePart(filePath, mimeType) {
  return {
    inlineData: {
      data: Buffer.from(fs.readFileSync(filePath)).toString("base64"),
      mimeType
    },
  };
}

async function updateInventory() {
  console.log('🖼️ Iniciando actualización de inventario desde imagen...');

  if (!fs.existsSync(IMAGE_PATH)) {
    console.error(`❌ ERROR: No se encontró la imagen en la ruta: ${IMAGE_PATH}`);
    return;
  }

  try {
    const backupPath = path.join(__dirname, `catalogo_contexto_backup_${Date.now()}.json`);
    if (fs.existsSync(CATALOG_PATH)) {
      console.log('💾 Creando backup del catálogo actual...');
      fs.copyFileSync(CATALOG_PATH, backupPath);
    }

    const imagePart = fileToGenerativePart(IMAGE_PATH, "image/png");

    console.log('🧠 Enviando imagen a Gemini Vision AI. Por favor espera, esto puede tomar unos segundos...');

    // Usamos el modelo Pro para máxima precisión con tablas de precios
    const model = genAI.getGenerativeModel({ model: "gemini-3.1-pro-preview" });

    const prompt = `
Eres un asistente experto en extracción de datos de inventario.
A continuación te presento una imagen ("tabla excel") que es el listado base de precios de la tienda Zona Traumática.

Tu trabajo es leer DETENIDAMENTE la imagen y extraer el catálogo de productos disponible en formato JSON estricto.

Reglas CRÍTICAS de extracción MATEMÁTICA:
1. Agrupa los productos por Marca (ej. "RETAY", "EKOL", "BLOW"). Si encuentras cajas de munición, agrúpalas bajo la marca "MUNICIÓN".
2. LOS PRECIOS EN LA IMAGEN SON PRECIOS BASE MAYORISTAS. TÚ DEBES CALCULAR Y ESCRIBIR EL PRECIO FINAL DE VENTA usando exactamente estas fórmulas matemáticas:
   - Para ARMAS (Pistolas/Revólveres/Fusiles):
     * Precio Plan Plus = Precio Base de la imagen + 300.000 pesos.
     * Precio Plan Pro = Precio Base de la imagen + 400.000 pesos.
   - Para MUNICIÓN (cajas de balas traumáticas):
     * Precio Plan Plus (Afiliado) = Precio Base de la imagen + 20.000 pesos.
     * Precio Plan Pro (Afiliado) = Precio Base de la imagen + 20.000 pesos.
     * Precio Público = Precio Base de la imagen + 60.000 pesos.
     
3. Por cada producto extraído de la foto, genera esta estructura:
   - "titulo": El nombre completo (ej. "RETAY S2022" o "Caja Munición Traumática X")
   - "descripcion": Una descripción corta del producto.
   - "color": Los colores disponibles mencionados (o "N/A" para munición).
   - "precio_plus": El precio final calculado para Plan Plus formateado con signo de dólar y puntos.
   - "precio_pro": El precio final calculado para Plan Pro formateado con separación de miles. ¡RECUERDA QUE PARA MUNICIÓN ESTE PRECIO TAMBIÉN LLEVA EL DESCUENTO DE AFILIADO (+20k)!
   - "precio": Un texto unificado resumen como "$1.150.000 (Plan Plus) / $1.250.000 (Plan Pro)" o para munición "$130.000 (Afiliados Club) / $170.000 (Público General)".
   - "disponible": true
   - "marca": La marca general (ej. "EKOL" o "MUNICIÓN")
   - "modelo": El modelo específico (ej. "Firat Magnum" o "Caja 50 unds")
   - "url": Un string genérico como "https://zonatraumatica.club/tienda/"

4. Preserva EXACTAMENTE la estructura de este esquema JSON base:
{
  "metadata": {
    "fuente": "Generado automáticamente desde imagen tabla excel",
    "fecha_generacion": "YYYY-MM-DD",
    "total_productos": 10,
    "categorias": 3,
    "nota_precios": "Precios finales al cliente (Base + 300k/400k armas, Base + 20k/60k municion)"
  },
  "categorias": {
     "MARCA_1": [ { ...producto1 }, { ...producto2 } ],
     "MUNICIÓN": [ { ...municion1 } ]
  }
}

5. Además de todo lo que extraigas de la imagen, debes SIEMPRE anexar esta categoría adicional de servicios al final de tu JSON (cópiala textual):
"SERVICIOS": [
  {
    "titulo": "Afiliación Club Zona Traumática",
    "descripcion": "Membresía al Club ZT. Incluye: carnet de miembro activo al Plan Plus.",
    "precio": "$150.000 (anual)",
    "precio_anual": "$150.000",
    "disponible": true,
    "categoria": "Servicio / Membresía"
  },
  {
    "titulo": "Asesor Legal IA — Zona Traumática",
    "descripcion": "Acceso por 6 meses al Asesor Legal IA. Responde en segundos sobre artículos jurídicos.",
    "precio": "$50.000 (6 meses)",
    "precio_semestral": "$50.000",
    "disponible": true,
    "categoria": "Servicio / IA Legal"
  }
]

6. Tu respuesta debe ser EXCLUSIVAMENTE el JSON. No incluyas marcadores de Markdown (como \`\`\`json) ni texto introductorio, solo el objeto JSON crudo, que la llave "metadata" sea la primera y termine con el cierre general de las llaves. ¡Sigue instrucciones, nada de markdown, texto puro válido JSON!
`;

    const result = await model.generateContent([prompt, imagePart]);
    let responseText = result.response.text();

    // Limpieza por si Gemini insiste en meter backticks
    responseText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();

    // Validar que sea un JSON válido
    let parsedJson;
    try {
      parsedJson = JSON.parse(responseText);
    } catch (parseError) {
      console.error('❌ ERROR CRÍTICO: Gemini devolvió un JSON inválido. Revisa la salida:');
      console.log(responseText);
      return;
    }

    // Guardar el nuevo catálogo
    fs.writeFileSync(CATALOG_PATH, JSON.stringify(parsedJson, null, 2), 'utf8');

    console.log(`✅ ¡ÉXITO! Inventario actualizado correctamente.`);
    console.log(`📊 Productos encontrados: ${parsedJson.metadata?.total_productos || 'N/A'}`);
    console.log(`📁 El nuevo catálogo se ha guardado en ${CATALOG_PATH}`);

  } catch (error) {
    console.error('❌ Error durante la actualización:', error);
  }
}

// Ejecutar
updateInventory();
