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

// Buscar dinámicamente la primera imagen en la carpeta de inventario
const INVENTARIO_DIR = path.join(__dirname, 'imagenes', 'oferta actual', 'inventario y precios');
let IMAGE_PATH = '';
if (fs.existsSync(INVENTARIO_DIR)) {
  const files = fs.readdirSync(INVENTARIO_DIR).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));
  if (files.length > 0) {
    IMAGE_PATH = path.join(INVENTARIO_DIR, files[0]);
    console.log(`📸 Imagen encontrada: ${files[0]}`);
  }
}
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
A continuación te presento una imagen que es un PANTALLAZO DE UNA TABLA EXCEL con el inventario y precios BASE (costo) de armas traumáticas y munición de la tienda Zona Traumática.

Tu trabajo es leer DETENIDAMENTE la tabla y extraer TODOS los productos, aplicando los siguientes MARKUPS de precio:

═══════════════════════════════════════════
REGLA DE PRECIOS — ARMAS TRAUMÁTICAS:
═══════════════════════════════════════════
Las armas son filas que tienen columnas MARCA, MODELO, COLOR y PRECIO.
A cada arma debes SUMARLE al precio base de la tabla:
  - Plan Plus = precio_base + $300.000
  - Plan Pro  = precio_base + $400.000
Ejemplo: Si la tabla dice $850.000 → Plan Plus = $1.150.000, Plan Pro = $1.250.000

═══════════════════════════════════════════
REGLA DE PRECIOS — MUNICIÓN:
═══════════════════════════════════════════
La munición se identifica porque su MODELO o descripción dice "MUNICION" o "MUNICIÓN".
Las marcas típicas de munición son: OZKURSAN, RUBBER BALL, KAISER (pero puede haber otras).
La munición NO tiene colores.
A cada munición debes SUMARLE al precio base:
  - Precio público     = precio_base + $60.000
  - Precio afiliado    = precio_base + $30.000
Ejemplo: Si la tabla dice $110.000 → Público = $170.000, Afiliado = $140.000

═══════════════════════════════════════════
ESTRUCTURA JSON DE SALIDA:
═══════════════════════════════════════════
{
  "metadata": {
    "fuente": "Generado automáticamente desde imagen de tabla Excel",
    "fecha_generacion": "YYYY-MM-DD",
    "total_productos": N,
    "categorias": N,
    "nota_precios": "Precios calculados con markup sobre costo base"
  },
  "categorias": {
    "MARCA_1": [
      {
        "titulo": "MARCA MODELO",
        "descripcion": "Pistola traumática MARCA MODELO",
        "color": "Negro / Fume",
        "precio_base": "$850.000",
        "precio_plus": "$1.150.000",
        "precio_pro": "$1.250.000",
        "precio": "$1.150.000 (Plan Plus) / $1.250.000 (Plan Pro)",
        "disponible": true,
        "marca": "MARCA",
        "modelo": "MODELO",
        "tipo": "arma",
        "url": "https://zonatraumatica.club/tienda/"
      }
    ],
    "MUNICION": [
      {
        "titulo": "MARCA - Descripción",
        "descripcion": "Descripción completa de la munición",
        "precio_base": "$110.000",
        "precio_publico": "$170.000",
        "precio_afiliado": "$140.000",
        "precio": "$170.000 (Público) / $140.000 (Afiliado Club ZT)",
        "disponible": true,
        "marca": "OZKURSAN",
        "modelo": "Munición Original Cal. 9mm",
        "tipo": "municion"
      }
    ],
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
  }
}

REGLAS ADICIONALES:
1. Agrupa las ARMAS por su marca (BLOW, EKOL, RETAY, etc.) — cada marca es una categoría.
2. TODA la munición va en UNA SOLA categoría llamada "MUNICION".
3. La categoría "SERVICIOS" SIEMPRE se incluye hardcodeada al final (exactamente como aparece arriba).
4. Usa "disponible": true para todos los productos que aparezcan en la tabla.
5. El campo "tipo" debe ser "arma" o "municion" según corresponda.
6. Tu respuesta debe ser EXCLUSIVAMENTE el JSON. No incluyas marcadores de Markdown (como \`\`\`json) ni texto explicativo, solo el objeto JSON crudo.
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
