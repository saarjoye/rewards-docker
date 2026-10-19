const fs = require('fs');

let lines = fs.readFileSync('src/web/public/app.js', 'utf8').split('\n');

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('.map((a) =>') && lines[i].includes('option')) {
    if (lines[i].includes('escapeHtml(a.user) + ")<')) {
      lines[i] = '        .map((a) => `<option value="${a.id}">${escapeHtml(a.name || a.user)} (${escapeHtml(a.user)})</option>`)';
    } else {
      lines[i] = '        .map((a) => `<option value="${a.id}">${escapeHtml(a.name || a.user)}</option>`)';
    }
  }
}

fs.writeFileSync('src/web/public/app.js', lines.join('\n'), 'utf8');
console.log('Lines replaced cleanly');
