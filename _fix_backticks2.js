const fs = require('fs');
let p = fs.readFileSync('panel.js', 'utf8');

const startIdx = p.indexOf('<script>');
const endIdx = p.indexOf('</script>');

if (startIdx > -1 && endIdx > -1) {
    let before = p.substring(0, startIdx + 8);
    let scriptBody = p.substring(startIdx + 8, endIdx);
    let after = p.substring(endIdx);

    // Remove existing fake escapes
    scriptBody = scriptBody.replace(/\\\\`/g, '\`');

    // Escape all backticks properly for a Node template literal
    scriptBody = scriptBody.replace(/`/g, '\\\\`');

    // Fix the onclick quotes bug using simple string replacement:
    // We want: onclick="devolverUno(\\' + p.phone + \\')"
    // In the node string it needs to be escaped: onclick="devolverUno(\\' + p.phone + \\')"
    // Since it evaluates into: onclick="devolverUno('' + p.phone + '')" currently

    scriptBody = scriptBody.replace(/'onclick="devolverUno\('' \+ p\.phone \+ ''\)">/g, "'onclick=\\"devolverUno(\\\\'" + " + p.phone + " + "\\\\') \\">");
    scriptBody = scriptBody.replace(/'onclick="desIgnorar\('' \+ c\.phone \+ ''\)">/g, "'onclick=\\"desIgnorar(\\\\'" + " + c.phone + " + "\\\\') \\">");

    p = before + scriptBody + after;
    fs.writeFileSync('panel.js', p, 'utf8');
    console.log('Fixed escaping in panel.js');
} else {
    console.log('Error: <script> not found');
}
