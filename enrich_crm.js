#!/usr/bin/env node
/**
 * 🧹 AGENTE DE ENRIQUECIMIENTO CRM
 * 
 * Lee TODA la conversación + memoria + documentos de cada cliente
 * y usa Gemini para extraer datos estructurados reales.
 * 
 * Actualiza: nombre, cédula, ciudad, dirección, profesión,
 *            modelo_arma, serial_arma, club_plan, club_vigente_hasta,
 *            has_bought_gun, is_club_plus, is_club_pro, has_ai_bot, status
 * 
 * USO:
 *   node enrich_crm.js              → Procesa TODOS los clientes
 *   node enrich_crm.js --dry-run    → Solo muestra qué cambiaría, sin escribir
 *   node enrich_crm.js --phone 573001234567  → Procesa un solo cliente
 *   node enrich_crm.js --min-msgs 5  → Solo clientes con >= 5 mensajes
 */

require('dotenv').config();
const db = require('./db');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

// Gemini setup
const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
if (!GEMINI_KEYS.length) { console.error('❌ No Gemini API keys found in .env'); process.exit(1); }

let keyIndex = 0;
let genAI = new GoogleGenerativeAI(GEMINI_KEYS[0]);

const SAFETY = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

async function callGemini(prompt, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', safetySettings: SAFETY });
            const result = await model.generateContent(prompt);
            return result.response.text().trim();
        } catch (err) {
            if (err.message?.includes('429') && GEMINI_KEYS.length > 1) {
                keyIndex = (keyIndex + 1) % GEMINI_KEYS.length;
                genAI = new GoogleGenerativeAI(GEMINI_KEYS[keyIndex]);
                console.log(`  🔄 Rotando API key a #${keyIndex + 1}`);
                continue;
            }
            if (attempt === retries) throw err;
            await sleep(2000);
        }
    }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Parse args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const phoneArg = args.indexOf('--phone') >= 0 ? args[args.indexOf('--phone') + 1] : null;
const minMsgsArg = args.indexOf('--min-msgs') >= 0 ? parseInt(args[args.indexOf('--min-msgs') + 1]) : 3;

const EXTRACTION_PROMPT = `Eres un asistente de CRM. Analiza la siguiente conversación de WhatsApp entre un asesor comercial de Zona Traumática (venta de armas traumáticas, club de respaldo legal) y un cliente.

CONTEXTO DEL NEGOCIO:
- Zona Traumática vende armas traumáticas para defensa personal (legal en Colombia)
- Ofrecen el Club ZT con dos planes: "Plan Plus" ($100.000/año) y "Plan Pro" ($150.000/año)
- El Club incluye: respaldo jurídico, carnet digital, capacitaciones
- También ofrecen un "Bot Asesor Legal IA" como producto independiente ($50.000/año)
- Marcas de armas: Ekol, Zoraki, Blow, Retay, Bruni, Kuzey, etc.

Tu tarea: EXTRAER datos reales del cliente mencionados en la conversación.

REGLAS ESTRICTAS:
1. Solo extrae datos que estén EXPLÍCITAMENTE mencionados en la conversación
2. Si un dato NO aparece, pon null (NO inventes)
3. Para "nombre": busca el nombre real completo, no apodos ni nombres de empresa
4. Para "cedula": solo si se mencionó un número de cédula (ej: "1234567890", "CC 1234567890")
5. Para "ciudad": solo si el cliente mencionó dónde vive
6. Para "serial_arma": busca números de serial mencionados (ej: "serial T1234-567")
7. Para "modelo_arma": busca modelo específico (ej: "Ekol Firat Compact", "Zoraki 914")
8. Para "club_plan": solo si COMPRÓ/PAGÓ un plan. Valores: "Plan Plus" o "Plan Pro" o null
9. Para "has_bought_gun": true SOLO si se confirmó que COMPRÓ un arma (no solo preguntó)
10. Para "is_club_plus"/"is_club_pro": true solo si tiene membresía ACTIVA confirmada
11. Para "has_ai_bot": true solo si compró el Bot Asesor Legal IA
12. Para "status": deduce el estado real:
    - "new" → solo preguntas iniciales, aún no compra
    - "hot" → mostró interés real, pidió precios, pidió datos de pago
    - "warm" → interactuó pero no ha mostrado intención de compra clara  
    - "completed" → ya compró algo (arma, club, o ambos)
13. Para "direccion": solo si dio dirección de envío
14. Para "profesion": solo si mencionó su profesión

Responde SOLO con JSON válido, sin explicaciones ni markdown:
{"nombre": "string o null", "cedula": "string o null", "ciudad": "string o null", "direccion": "string o null", "profesion": "string o null", "modelo_arma": "string o null", "serial_arma": "string o null", "club_plan": "Plan Plus o Plan Pro o null", "has_bought_gun": true/false/null, "is_club_plus": true/false/null, "is_club_pro": true/false/null, "has_ai_bot": true/false/null, "status": "new/hot/warm/completed o null"}`;

async function enrichClient(phone) {
    const dossier = db.buildClientDossier(phone);
    if (!dossier) return { skipped: true, reason: 'no existe' };

    const { profile, memory, documents, history, stats } = dossier;

    // Skip si tiene muy pocos mensajes
    if (stats.totalMessages < minMsgsArg) {
        return { skipped: true, reason: `solo ${stats.totalMessages} msgs (min: ${minMsgsArg})` };
    }

    // Build conversation text
    const conversationLines = history.map(h => {
        const role = h.role === 'user' ? 'CLIENTE' : h.role === 'assistant' ? 'BOT' : 'ADMIN';
        return `${role}: ${h.message}`;
    });

    // Add context from documents
    const docLines = [];
    if (documents.comprobantes.length > 0) {
        docLines.push('--- COMPROBANTES DE PAGO ---');
        documents.comprobantes.forEach(c => {
            docLines.push(`[${c.estado}] ${c.info || 'sin detalle'} — tipo: ${c.tipo}`);
        });
    }
    if (documents.carnets.length > 0) {
        docLines.push('--- CARNETS ---');
        documents.carnets.forEach(c => {
            docLines.push(`[${c.estado}] Nombre: ${c.nombre || '?'}, CC: ${c.cedula || '?'}, Vigente: ${c.vigente_hasta || '?'}, Arma: ${c.marca_arma || ''} ${c.modelo_arma || ''} Serial: ${c.serial || ''}`);
        });
    }

    const fullContext = [
        `PERFIL ACTUAL EN CRM:`,
        `Nombre: ${profile.name || 'vacío'}`,
        `Teléfono: ${phone}`,
        `Status: ${profile.status}`,
        `Cédula: ${profile.cedula || 'vacío'}`,
        `Ciudad: ${profile.ciudad || 'vacío'}`,
        `Modelo arma: ${profile.modelo_arma || 'vacío'}`,
        `Serial arma: ${profile.serial_arma || 'vacío'}`,
        `Club plan: ${profile.club_plan || 'vacío'}`,
        ``,
        memory ? `MEMORIA DEL BOT:\n${memory}\n` : '',
        docLines.length ? docLines.join('\n') + '\n' : '',
        `--- CONVERSACIÓN (últimos ${history.length} mensajes) ---`,
        ...conversationLines
    ].filter(Boolean).join('\n');

    // Call Gemini
    const prompt = EXTRACTION_PROMPT + '\n\n' + fullContext;
    const responseText = await callGemini(prompt);

    // Parse JSON
    let extracted;
    try {
        const cleaned = responseText.replace(/```json|```/g, '').trim();
        extracted = JSON.parse(cleaned);
    } catch (e) {
        return { error: true, reason: `JSON parse error: ${e.message}`, raw: responseText.substring(0, 200) };
    }

    // Build update — only update fields that are null/empty in current profile and non-null in extraction
    const updates = {};
    let changes = [];

    // String fields: only update if currently empty AND extraction has a value
    const stringFields = ['nombre', 'cedula', 'ciudad', 'direccion', 'profesion', 'modelo_arma', 'serial_arma'];
    for (const field of stringFields) {
        const dbField = field === 'nombre' ? 'name' : field;
        const currentVal = profile[dbField] || '';
        const newVal = extracted[field];
        if (newVal && typeof newVal === 'string' && newVal.toLowerCase() !== 'null') {
            if (!currentVal || currentVal.trim().length < 2) {
                updates[dbField] = newVal;
                changes.push(`${field}: "" → "${newVal}"`);
            }
        }
    }

    // Club plan: only update if currently empty
    if (extracted.club_plan && !profile.club_plan) {
        updates.club_plan = extracted.club_plan;
        changes.push(`club_plan: "" → "${extracted.club_plan}"`);
    }

    // Boolean flags: only set to TRUE (never downgrade)
    const boolFields = { has_bought_gun: 'has_bought_gun', is_club_plus: 'is_club_plus', is_club_pro: 'is_club_pro', has_ai_bot: 'has_ai_bot' };
    for (const [extKey, dbKey] of Object.entries(boolFields)) {
        if (extracted[extKey] === true && !profile[dbKey]) {
            updates[dbKey] = true;
            changes.push(`${dbKey}: 0 → 1`);
        }
    }

    // Status: only upgrade (new → warm → hot → completed), never downgrade
    const STATUS_RANK = { new: 0, warm: 1, hot: 2, assigned: 2, completed: 3 };
    if (extracted.status && STATUS_RANK[extracted.status] !== undefined) {
        const currentRank = STATUS_RANK[profile.status] || 0;
        const newRank = STATUS_RANK[extracted.status];
        if (newRank > currentRank) {
            updates.status = extracted.status;
            changes.push(`status: "${profile.status}" → "${extracted.status}"`);
        }
    }

    return { phone, name: profile.name || phone, changes, updates, extracted, totalMsgs: stats.totalMessages };
}

async function main() {
    console.log('🧹 AGENTE DE ENRIQUECIMIENTO CRM — Zona Traumática');
    console.log('═'.repeat(55));
    if (DRY_RUN) console.log('⚠️  MODO DRY-RUN: no se escribirá nada en la BD\n');

    let clients;
    if (phoneArg) {
        const c = db.getClient(phoneArg);
        clients = c ? [c] : [];
        if (!clients.length) { console.error(`❌ Cliente ${phoneArg} no encontrado`); process.exit(1); }
    } else {
        clients = db.db.prepare('SELECT phone, name, status, interaction_count FROM clients ORDER BY interaction_count DESC').all();
    }

    console.log(`📊 Clientes a procesar: ${clients.length} (mínimo ${minMsgsArg} mensajes)\n`);

    let processed = 0, enriched = 0, skipped = 0, errors = 0;
    const allChanges = [];

    for (const client of clients) {
        processed++;
        const pct = Math.round((processed / clients.length) * 100);
        process.stdout.write(`[${pct}%] ${processed}/${clients.length} — ${client.name || client.phone}...`);

        try {
            const result = await enrichClient(client.phone);

            if (result.skipped) {
                console.log(` ⏭️  ${result.reason}`);
                skipped++;
                continue;
            }

            if (result.error) {
                console.log(` ❌ ${result.reason}`);
                errors++;
                continue;
            }

            if (result.changes.length === 0) {
                console.log(' ✅ sin cambios necesarios');
                continue;
            }

            // Apply updates
            if (!DRY_RUN) {
                // Use raw SQL to avoid incrementing interaction_count
                const fields = [];
                const values = [];
                for (const [key, val] of Object.entries(result.updates)) {
                    fields.push(`${key} = ?`);
                    values.push(typeof val === 'boolean' ? (val ? 1 : 0) : val);
                }
                if (fields.length > 0) {
                    values.push(client.phone);
                    db.db.prepare(`UPDATE clients SET ${fields.join(', ')} WHERE phone = ?`).run(...values);
                }
            }

            enriched++;
            allChanges.push(result);
            console.log(` 📝 ${result.changes.length} cambios:`);
            result.changes.forEach(c => console.log(`    → ${c}`));

            // Rate limit: wait 1s between Gemini calls
            await sleep(1000);

        } catch (err) {
            console.log(` ❌ Error: ${err.message}`);
            errors++;
            // Wait more on errors (might be rate limit)
            await sleep(3000);
        }
    }

    console.log('\n' + '═'.repeat(55));
    console.log('📊 RESUMEN:');
    console.log(`  Total procesados: ${processed}`);
    console.log(`  Enriquecidos:     ${enriched}`);
    console.log(`  Sin cambios:      ${processed - enriched - skipped - errors}`);
    console.log(`  Saltados:         ${skipped}`);
    console.log(`  Errores:          ${errors}`);
    if (DRY_RUN) console.log('\n⚠️  DRY-RUN: ningún cambio fue escrito en la BD');

    if (allChanges.length > 0) {
        console.log('\n📋 DETALLE DE CAMBIOS:');
        allChanges.forEach(r => {
            console.log(`\n  👤 ${r.name} (${r.phone}) — ${r.totalMsgs} msgs`);
            r.changes.forEach(c => console.log(`    → ${c}`));
        });
    }

    process.exit(0);
}

main().catch(err => { console.error('❌ Error fatal:', err); process.exit(1); });
