const fs = require('fs');

const idxPath = 'index.js';
let content = fs.readFileSync(idxPath, 'utf8');

content = content.replace(/const transModel = genAI\.getGenerativeModel\(\{ model: '([^']+)' \}\);[\s\S]*?const result = await transModel\.generateContent\(([^)]+)\);/,
    "const result = await geminiGenerate('$1', $2);");

content = content.replace(/const carnetCheckModel = genAI\.getGenerativeModel\(\{ model: '([^']+)' \}\);\s*const carnetCheckResult = await carnetCheckModel\.generateContent\(\[/,
    "const carnetCheckResult = await geminiGenerate('$1', [");

content = content.replace(/const checkModel = genAI\.getGenerativeModel\(\{ model: '([^']+)' \}\);\s*const checkResult = await checkModel\.generateContent\(\[/,
    "const checkResult = await geminiGenerate('$1', [");

content = content.replace(/const qrModel = genAI\.getGenerativeModel\(\{ model: '([^']+)' \}\);\s*const qrResult = await qrModel\.generateContent\(([^)]+)\);/,
    "const qrResult = await geminiGenerate('$1', $2);");

content = content.replace(/const memoryModel = genAI\.getGenerativeModel\(\{ model: '([^']+)' \}\);\s*const memoryResult = await memoryModel\.generateContent\(([^)]+)\);/,
    "const memoryResult = await geminiGenerate('$1', $2);");

content = content.replace(/const resumeModel = genAI\.getGenerativeModel\(\{ model: '([^']+)' \}\);([\s\S]*?)const resumeResult = await resumeModel\.generateContent\(([^)]+)\);/,
    "$2\n              const resumeResult = await geminiGenerate('$1', $3);");

fs.writeFileSync(idxPath, content, 'utf8');
console.log('Update Complete.');
