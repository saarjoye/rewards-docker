const fs = require('fs');

let content = fs.readFileSync('src/web/public/app.js', 'utf8');

// 在 bar-col 内部，bar-pillar 之上插入柱顶积分总数 <span class="bar-top-val">
const oldBarReturn = `      return (
        '<div class="bar-col ' + (d.active ? 'active' : '') + '">' +
          '<div class="bar-pillar" style="height: ' + heightPct + '%;">' +`;

const newBarReturn = `      return (
        '<div class="bar-col ' + (d.active ? 'active' : '') + '">' +
          '<span class="bar-top-val">' + d.val + '</span>' +
          '<div class="bar-pillar" style="height: ' + heightPct + '%;">' +`;

content = content.replace(oldBarReturn, newBarReturn);
fs.writeFileSync('src/web/public/app.js', content, 'utf8');
console.log('app.js updated with bar-top-val above each column');
