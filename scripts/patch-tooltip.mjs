import fs from 'fs';

let content = fs.readFileSync('src/web/public/style.css', 'utf8');

content = content.replace(
  '  white-space: nowrap;\n  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);\n  opacity: 0;\n  pointer-events: none;\n  transition: opacity 0.2s ease, transform 0.2s ease;\n  z-index: 100;\n  min-width: 120px;',
  '  white-space: normal;\n  display: flex;\n  flex-direction: column;\n  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);\n  opacity: 0;\n  pointer-events: none;\n  transition: opacity 0.2s ease, transform 0.2s ease;\n  z-index: 100;\n  min-width: 140px;'
);

fs.writeFileSync('src/web/public/style.css', content, 'utf8');
console.log('style.css tooltip updated for vertical multi-account list');
