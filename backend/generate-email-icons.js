// ═══════════════════════════════════════════════════════
//  generate-email-icons.js — one-off PNG generator for email icons
//
//  Renders every icon in email-icon-paths.js in every colour listed
//  there, as a transparent square PNG named <icon>-<color>.png
//  (e.g. home-white.png). emails.js links to these files.
//
//  Usage (run from the backend folder):
//    npm install --save-dev @resvg/resvg-js
//    node generate-email-icons.js <output-folder>
//
//  Example — write straight into the frontend's public folder:
//    node generate-email-icons.js ../frontend/email-icons
//
//  With no argument it writes to ./email-icons next to this script.
//  Upload/serve the folder so the files are reachable at:
//    https://affordablerentals.site/email-icons/<icon>-<color>.png
//
//  Re-run it only when email-icon-paths.js changes.
//  This script does not load icons.js or emails.js (so no Resend
//  client, no .env needed).
// ═══════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const { EMAIL_ICON_PATHS, EMAIL_ICON_COLORS, EMAIL_ICON_PNG_SIZE } = require('./email-icon-paths');

const outDir = path.resolve(process.argv[2] || path.join(__dirname, 'email-icons'));

// Same look as the app's ICON(): 24x24 viewBox, single stroke, width 2, round caps/joins.
function buildSvg(inner, stroke) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${EMAIL_ICON_PNG_SIZE}" height="${EMAIL_ICON_PNG_SIZE}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

fs.mkdirSync(outDir, { recursive: true });

let count = 0;
for (const [name, inner] of Object.entries(EMAIL_ICON_PATHS)) {
    for (const [colorName, hex] of Object.entries(EMAIL_ICON_COLORS)) {
        const svg = buildSvg(inner, hex);
        const png = new Resvg(svg, { fitTo: { mode: 'width', value: EMAIL_ICON_PNG_SIZE } })
            .render()
            .asPng();
        fs.writeFileSync(path.join(outDir, `${name}-${colorName}.png`), png);
        count++;
    }
}

console.log(`Generated ${count} icons (${Object.keys(EMAIL_ICON_PATHS).length} icons x ${Object.keys(EMAIL_ICON_COLORS).length} colours) in ${outDir}`);