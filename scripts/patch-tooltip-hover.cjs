const fs = require('fs');

let css = fs.readFileSync('src/web/public/style.css', 'utf8');

// 彻底清除 .bar-col.active .chart-tooltip-capsule { opacity: 1; }
css = css.replace(/\.bar-col\.active\s*\.chart-tooltip-capsule\s*\{[^}]*\}/g, '');

// 重构 .chart-tooltip-capsule：绝对不常驻，仅在 :hover 时浮现
const cleanTooltipCss = `
/* 积分柱气泡：彻底杜绝常驻，仅在鼠标悬停 (:hover) 时浮现展示各账号明细 */
.chart-tooltip-capsule {
  position: absolute;
  bottom: calc(100% + 10px);
  left: 50%;
  transform: translateX(-50%) translateY(4px);
  background: #0f172a;
  color: #ffffff;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 11px;
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4);
  opacity: 0 !important;
  visibility: hidden !important;
  pointer-events: none;
  transition: opacity 0.2s ease, transform 0.2s ease, visibility 0.2s ease;
  z-index: 200;
  min-width: 130px;
  display: flex;
  flex-direction: column;
}

.chart-tooltip-capsule::after {
  content: "";
  position: absolute;
  bottom: -5px;
  left: 50%;
  transform: translateX(-50%);
  border-width: 5px 5px 0;
  border-style: solid;
  border-color: #0f172a transparent transparent;
}

/* 仅在鼠标悬停时激活展示 */
.bar-col:hover .chart-tooltip-capsule {
  opacity: 1 !important;
  visibility: visible !important;
  pointer-events: auto;
  transform: translateX(-50%) translateY(0);
}
`;

css += cleanTooltipCss;
fs.writeFileSync('src/web/public/style.css', css, 'utf8');
console.log('Tooltip CSS updated: strictly non-permanent, hover only');
