const fs = require('fs');
const path = require('path');

function findBestImage(query) {
    const baseDir = path.join(__dirname, 'imagenes', 'pistolas');
    if (!fs.existsSync(baseDir)) return null;

    const originalTokens = query.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
    const tokens = originalTokens.filter(t => t.length > 2);

    console.log(`Query: "${query}" => Tokens:`, tokens);

    if (tokens.length === 0) return null;

    let bestMatch = null;
    let bestScore = 0;

    try {
        const brands = fs.readdirSync(baseDir);
        for (const brand of brands) {
            const brandDir = path.join(baseDir, brand);
            if (!fs.statSync(brandDir).isDirectory()) continue;

            const files = fs.readdirSync(brandDir);
            for (const file of files) {
                if (!file.endsWith('.png') && !file.endsWith('.jpg') && !file.endsWith('.jpeg')) continue;

                const targetString = `${brand} ${file.replace(/\.[^/.]+$/, "")}`.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
                let score = 0;
                for (const token of tokens) {
                    if (targetString.includes(token)) score += (token === brand.toLowerCase() ? 1 : 2);
                }

                if (score > 0) console.log(`  Target: "${targetString}" | Score: ${score} | File: ${file}`);

                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = path.join(brandDir, file);
                }
            }
        }
    } catch (e) {
        console.error('[BOT] Error:', e.message);
    }

    return bestScore >= 2 ? bestMatch : null;
}

console.log('1. Ekol Firat Magnum =>', findBestImage('Ekol Firat Magnum'));
console.log('---');
console.log('2. URL Slug: pistola-traumatica-ekol-firat-magnum =>', findBestImage('pistola traumatica ekol firat magnum'));
