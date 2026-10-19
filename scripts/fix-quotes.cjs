const fs = require('fs');

let s = fs.readFileSync('src/web/public/app.js', 'utf8');

s = s.split('<div class="tooltip-account-row">').join('<div class=\\"tooltip-account-row\\">');
s = s.split('<span class="acc-name">').join('<span class=\\"acc-name\\">');
s = s.split('<b class="acc-pts">').join('<b class=\\"acc-pts\\">');
s = s.split('<div class="chart-tooltip-capsule">').join('<div class=\\"chart-tooltip-capsule\\">');
s = s.split('<div class="tooltip-title-row">').join('<div class=\\"tooltip-title-row\\">');
s = s.split('<span class="tooltip-dot"></span>').join('<span class=\\"tooltip-dot\\"></span>');
s = s.split('<div class="tooltip-divider"></div>').join('<div class=\\"tooltip-divider\\"></div>');
s = s.split('<div class="tooltip-breakdown-list">').join('<div class=\\"tooltip-breakdown-list\\">');

fs.writeFileSync('src/web/public/app.js', s, 'utf8');
console.log('Quotes fixed cleanly');
