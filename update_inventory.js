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

const IMAGE_PATH = path.join(__dirname, 'imagenes', 'oferta actual', 'inventario y precios pistolas.png');
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
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });

    const prompt = `
Eres un asistente experto en extracción de datos de inventario.
A continuación te presento una imagen que es el afiche oficial de precios y disponibilidad de armas traumáticas de la tienda Zona Traumática.

Tu trabajo es leer DETENIDAMENTE la imagen y extraer el catálogo de productos disponible en formato JSON estricto.

Reglas CRÍTICAS de extracción:
1. Agrupa los productos por Marca (ej. "RETAY", "EKOL", "BLOW").
2. Por cada producto, debes identificar y extraer:
   - "titulo": El nombre completo (ej. "RETAY S2022")
   - "descripcion": Una descripción corta del producto extraída o inferida.
   - "color": Los colores disponibles mencionados en la imagen (ej. "Negro / Fume / Cromado")
   - "precio_plus": El precio exacto asignado al "Plan Plus" formateado (ej. "$1.150.000")
   - "precio_pro": El precio exacto asignado al "Plan Pro" formateado (ej. "$1.250.000"). Si no lo tiene, usa null.
   - "precio": Un texto unificado como "$1.150.000 (Plan Plus) / $1.250.000 (Plan Pro)"
   - "disponible": true (ya que están en la imagen actual)
   - "marca": La marca general (ej. "EKOL")
   - "modelo": El modelo específico (ej. "Firat Magnum")
   - "url": Un string o una URL base como "https://zonatraumatica.club/tienda/"

3. Preserva EXACTAMENTE la estructura de este esquema JSON:
{
  "metadata": {
    "fuente": "Generado autom\u00e1ticamente desde imagen",
    "fecha_generacion": "YYYY-MM-DD",
    "total_productos": 10,
    "categorias": 3,
    "nota_precios": "Precios extraidos de afiche oficial"
  },
  "categorias": {
     "MARCA_1": [ { ...producto1 }, { ...producto2 } ],
     "MARCA_2": [ ... ]
  }
}

4. Además de las armas extraídas de la imagen, debes SIEMPRE incluir esta categoría adicional al final del JSON llamada "SERVICIOS" de forma hardcodeada:
"SERVICIOS": [
  {
    "titulo": "Afiliación Club Zona Traumática",
    "descripcion": "Membresía al Club ZT — la comunidad de portadores legales más grande de Colombia. Incluye: carnet de miembro activo, Plan de Respaldo Jurídico Plus por 1 año, acceso a capacitaciones y red de portadores.",
    "precio": "$150.000 (anual)",
    "precio_anual": "$150.000",
    "disponible": true,
    "categoria": "Servicio / Membresía"
  },
  {
    "titulo": "Asesor Legal IA — Zona Traumática",
    "descripcion": "Acceso por 6 meses al Asesor Legal IA. Responde en 10 segundos, citas legales de sentencias reales para defensa inmediata.",
    "precio": "$50.000 (6 meses)",
    "precio_semestral": "$50.000",
    "disponible": true,
    "categoria": "Servicio / IA Legal"
  }
]

5. Tu respuesta debe ser EXCLUSIVAMENTE el JSON. No incluyas marcadores de Markdown (como \`\`\`json) ni texto explicativo, solo el objeto JSON crudo para que pueda ser parseado directamente.
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
