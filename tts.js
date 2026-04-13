// ============================================
// tts.js — Text-to-Speech con Gemini 2.5 Flash TTS
// ============================================
// Genera notas de voz a partir de texto para enviar por WhatsApp.
// Usa Gemini 2.5 Flash TTS (mismas API keys de Gemini).
// El modelo 3.1 Pro genera la respuesta (texto), el 2.5 Flash TTS solo la lee.
// Uso estratégico: bienvenidas, follow-ups, campañas y cuando el cliente pide audio.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { genAI: getGenAI, SAFETY_SETTINGS, rotateGeminiKey } = require('./gemini');

// Inyección de dependencias
let client = null;
let MessageMedia = null;

function init(whatsappClient, msgMedia) {
  client = whatsappClient;
  MessageMedia = msgMedia;
}

// Configuración de voz
const TTS_CONFIG = {
  // Modelo TTS de Gemini
  model: 'gemini-2.5-flash-preview-tts',
  // Voces disponibles (todas suenan naturales):
  // Kore (mujer, enérgica), Aoede (mujer, cálida/conversacional)
  // Puck (hombre, alegre), Charon (hombre, suave), Fenrir (hombre, enérgico)
  voiceName: 'Kore',
  // Directorio local para archivos de audio (no usar os.tmpdir() porque Windows lo limpia)
  tmpDir: path.join(__dirname, 'tmp_audio'),
};

// Crear directorio temporal si no existe
if (!fs.existsSync(TTS_CONFIG.tmpDir)) {
  fs.mkdirSync(TTS_CONFIG.tmpDir, { recursive: true });
}

/**
 * Convierte audio PCM crudo a formato WAV (agrega header RIFF/WAVE).
 * Gemini TTS devuelve audio L16 (16-bit PCM) sin encabezado — WhatsApp lo necesita en WAV.
 * @param {Buffer} pcmData - Buffer con datos PCM crudos (16-bit, mono)
 * @param {number} sampleRate - Frecuencia de muestreo (ej: 24000)
 * @returns {Buffer} Buffer con archivo WAV completo
 */
function pcmToWav(pcmData, sampleRate = 24000) {
  const numChannels = 1;      // Mono
  const bitsPerSample = 16;   // 16-bit
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const headerSize = 44;

  const wav = Buffer.alloc(headerSize + dataSize);

  // RIFF header
  wav.write('RIFF', 0);                              // ChunkID
  wav.writeUInt32LE(36 + dataSize, 4);                // ChunkSize
  wav.write('WAVE', 8);                               // Format

  // fmt sub-chunk
  wav.write('fmt ', 12);                              // Subchunk1ID
  wav.writeUInt32LE(16, 16);                          // Subchunk1Size (PCM = 16)
  wav.writeUInt16LE(1, 20);                           // AudioFormat (PCM = 1)
  wav.writeUInt16LE(numChannels, 22);                 // NumChannels
  wav.writeUInt32LE(sampleRate, 24);                  // SampleRate
  wav.writeUInt32LE(byteRate, 28);                    // ByteRate
  wav.writeUInt16LE(blockAlign, 32);                  // BlockAlign
  wav.writeUInt16LE(bitsPerSample, 34);               // BitsPerSample

  // data sub-chunk
  wav.write('data', 36);                              // Subchunk2ID
  wav.writeUInt32LE(dataSize, 40);                    // Subchunk2Size

  // Copiar datos PCM
  pcmData.copy(wav, headerSize);

  return wav;
}

/**
 * Genera un archivo de audio (WAV) desde texto usando Gemini 2.5 Flash TTS.
 * @param {string} text - Texto a convertir en audio
 * @param {string} [id] - ID opcional para cachear el archivo
 * @returns {Promise<{filePath: string, buffer: Buffer}>} Path y buffer del audio
 */
async function textToAudio(text, id = null) {
  const fileName = id || `tts_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const filePath = path.join(TTS_CONFIG.tmpDir, `${fileName}.wav`);

  // Si ya existe el archivo cacheado, retornarlo
  if (id && fs.existsSync(filePath)) {
    console.log(`[TTS] 📦 Cache hit: ${fileName}`);
    return { filePath, buffer: fs.readFileSync(filePath) };
  }

  // Asegurar que el directorio existe (por si fue borrado)
  if (!fs.existsSync(TTS_CONFIG.tmpDir)) {
    fs.mkdirSync(TTS_CONFIG.tmpDir, { recursive: true });
  }

  try {
    const ai = getGenAI();
    const model = ai.getGenerativeModel({
      model: TTS_CONFIG.model,
    });

    // Prompt con instrucciones de estilo para voz natural colombiana
    const ttsPrompt = `Habla con acento colombiano natural, tono cálido y cercano, como una asesora comercial amigable. Lee el siguiente texto:\n\n${text}`;

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: ttsPrompt }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: TTS_CONFIG.voiceName,
            }
          }
        }
      }
    });

    const response = result.response;
    const audioPart = response.candidates?.[0]?.content?.parts?.[0];

    if (!audioPart || !audioPart.inlineData) {
      throw new Error('No se recibió audio en la respuesta de Gemini TTS');
    }

    // El audio viene como PCM crudo (audio/L16;codec=pcm;rate=24000)
    const rawPcm = Buffer.from(audioPart.inlineData.data, 'base64');
    const mimeRaw = audioPart.inlineData.mimeType || '';
    
    // Extraer sample rate del mime type (ej: "audio/L16;codec=pcm;rate=24000")
    const rateMatch = mimeRaw.match(/rate=(\d+)/);
    const sampleRate = rateMatch ? parseInt(rateMatch[1]) : 24000;
    
    // Convertir PCM crudo a WAV con header correcto
    const audioBuffer = pcmToWav(rawPcm, sampleRate);

    // Guardar en disco para cachear
    fs.writeFileSync(filePath, audioBuffer);

    console.log(`[TTS] ✅ Audio generado (Gemini TTS): ${audioBuffer.length} bytes (WAV ${sampleRate}Hz) — "${text.substring(0, 50)}..."`);

    return { filePath, buffer: audioBuffer, mimeType: 'audio/wav' };
  } catch (err) {
    // Si es error de quota, intentar rotar key
    if (err.message && (err.message.includes('429') || err.message.includes('quota'))) {
      console.warn('[TTS] ⚠️ Quota agotada en TTS — rotando key y reintentando...');
      rotateGeminiKey('TTS 429');
      // Un solo reintento
      try {
        const ai = getGenAI();
        const model = ai.getGenerativeModel({ model: TTS_CONFIG.model });
        const ttsPrompt = `Habla con acento colombiano natural, tono cálido y cercano. Lee:\n\n${text}`;
        const result = await model.generateContent({
          contents: [{ role: 'user', parts: [{ text: ttsPrompt }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: TTS_CONFIG.voiceName }
              }
            }
          }
        });
        const retryAudioPart = result.response.candidates?.[0]?.content?.parts?.[0];
        if (retryAudioPart?.inlineData) {
          const retryPcm = Buffer.from(retryAudioPart.inlineData.data, 'base64');
          const retryMime = retryAudioPart.inlineData.mimeType || '';
          const retryRate = (retryMime.match(/rate=(\d+)/) || [])[1] || 24000;
          const retryWav = pcmToWav(retryPcm, parseInt(retryRate));
          fs.writeFileSync(filePath, retryWav);
          return { filePath, buffer: retryWav, mimeType: 'audio/wav' };
        }
      } catch (retryErr) {
        console.error('[TTS] ❌ Retry también falló:', retryErr.message);
      }
    }
    console.error(`[TTS] ❌ Error generando audio:`, err.message);
    throw err;
  }
}

/**
 * Genera una nota de voz y la envía por WhatsApp.
 * Convierte WAV a OGG Opus via FFmpeg (formato requerido por WhatsApp PTT).
 * @param {string} phone - Número del destinatario
 * @param {string} text - Texto a convertir en nota de voz
 * @param {string} [cacheId] - ID para cachear (opcional)
 * @returns {Promise<boolean>} true si se envió exitosamente
 */
async function sendVoiceNote(phone, text, cacheId = null) {
  // === TTS: controlado desde .env (ENABLE_TTS=true/false) ===
  if (process.env.ENABLE_TTS !== 'true') return false;

  try {
    const { filePath: wavPath } = await textToAudio(text, cacheId);

    // Convertir WAV a OGG Opus con FFmpeg (formato que WhatsApp acepta como PTT)
    const oggPath = wavPath.replace('.wav', '.ogg');
    const { execSync } = require('child_process');
    
    try {
      execSync(`ffmpeg -y -i "${wavPath}" -c:a libopus -b:a 48k -ar 48000 -ac 1 "${oggPath}"`, {
        stdio: 'pipe',
        timeout: 30000,
      });
    } catch (ffErr) {
      console.error('[TTS] ❌ FFmpeg falló:', ffErr.stderr?.toString().substring(0, 200));
      throw new Error('FFmpeg conversion failed');
    }

    // Leer el OGG convertido
    const oggBuffer = fs.readFileSync(oggPath);
    const base64Audio = oggBuffer.toString('base64');
    const media = new MessageMedia('audio/ogg; codecs=opus', base64Audio, 'voice.ogg');

    // Obtener chat_id del cliente
    const db = require('./db');
    const chatId = db.getClientChatId(phone);

    // Enviar como nota de voz (PTT = Push to Talk)
    await client.sendMessage(chatId, media, {
      sendAudioAsVoice: true,
    });

    // Limpiar archivos temporales (OGG y WAV)
    try { fs.unlinkSync(oggPath); } catch (e) {}
    try { if (!cacheId) fs.unlinkSync(wavPath); } catch (e) {}

    console.log(`[TTS] 🎤 Nota de voz enviada a ${phone}: "${text.substring(0, 40)}..."`);
    return true;
  } catch (err) {
    console.error(`[TTS] ❌ Error enviando nota de voz a ${phone}:`, err.message);
    return false;
  }
}

/**
 * Limpia archivos de audio temporales antiguos (más de 1 hora).
 */
function cleanupOldAudio() {
  try {
    const files = fs.readdirSync(TTS_CONFIG.tmpDir);
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    let cleaned = 0;

    for (const file of files) {
      const fp = path.join(TTS_CONFIG.tmpDir, file);
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < oneHourAgo) {
        fs.unlinkSync(fp);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[TTS] 🗑️ ${cleaned} archivo(s) temporal(es) limpiado(s)`);
    }
  } catch (err) {
    // Silenciar errores de limpieza
  }
}

// Limpieza automática cada hora
setInterval(cleanupOldAudio, 60 * 60 * 1000);

module.exports = { init, textToAudio, sendVoiceNote, TTS_CONFIG };
