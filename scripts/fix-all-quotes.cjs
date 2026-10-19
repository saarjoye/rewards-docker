const fs = require('fs');

let s = fs.readFileSync('src/web/public/app.js', 'utf8');

// 将所有字符串拼接里的 class= 属性都转义
s = s.split('class="').join('class=\\"');
s = s.split('title="').join('title=\\"');
s = s.split('style="').join('style=\\"');
s = s.split('onclick="').join('onclick=\\"');

// 修复双重转义
s = s.split('\\\\"').join('\\"');

fs.writeFileSync('src/web/public/app.js', s, 'utf8');

try {
  new Function(s);
  console.log('src/web/public/app.js syntax is 100% VALID!');
} catch (e) {
  console.error('Remaining error:', e.message);
}
