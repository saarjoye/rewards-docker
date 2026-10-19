const fs = require('fs');

let s = fs.readFileSync('src/web/public/app.js', 'utf8');

// 将所有 '<option value=""' 修复为 '<option value="' + a.id + '">'
s = s.replace(/<option value="" \+ a\.id \+ "">/g, '<option value="' + "' + a.id + '\"" + '>');
s = s.replace(/<option value="" \+ a\.id \+ "">/g, '<option value="' + "' + a.id + '\"" + '>');

// 更加直接地正则替换该行
s = s.replace(
  /\.map\(\(a\) => "<option value="" \+ a\.id \+ "">" \+ escapeHtml\(a\.name \|\| a\.user\) \+ " \(" \+ escapeHtml\(a\.user\) \+ "\)<\/option>"\)/g,
  '.map((a) => `<option value="${a.id}">${escapeHtml(a.name || a.user)} (${escapeHtml(a.user)})</option>`)'
);

s = s.replace(
  /\.map\(\(a\) => "<option value="" \+ a\.id \+ "">" \+ escapeHtml\(a\.name \|\| a\.user\) \+ "<\/option>"\)/g,
  '.map((a) => `<option value="${a.id}">${escapeHtml(a.name || a.user)}</option>`)'
);

fs.writeFileSync('src/web/public/app.js', s, 'utf8');
console.log('Options replaced with template literals');
