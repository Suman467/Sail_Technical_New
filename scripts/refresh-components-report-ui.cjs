const fs = require('node:fs');
const path = require('node:path');

const files = [
  path.resolve('reports/validation/components/components-edit-and-persistence.html'),
  path.resolve('reports/audit/components/components-edit-and-persistence.html'),
];

for (const file of files) {
  let html = fs.readFileSync(file, 'utf8');
  const statuses = [...html.matchAll(/class="test-case" data-status="([^"]+)"/g)].map((match) => match[1]);
  const count = (status) => statuses.filter((value) => value === status).length;
  html = html.replace(/(<details class="test-case" data-status="[^"]+") open>/g, '$1>');
  html = html.replace(/<div class="filters">[\s\S]*?<\/div><h2>TEST CASE RESULTS<\/h2>/,
    `<div class="toolbar"><div class="filters"><button class="active" onclick="show('all',this)">All (${statuses.length})</button><button onclick="show('passed',this)">Passed (${count('passed')})</button><button onclick="show('failed',this)">Failed (${count('failed')})</button><button onclick="show('skipped',this)">Skipped (${count('skipped')})</button><button onclick="show('not-executed',this)">Not Executed (${count('not-executed')})</button></div><div class="expand-controls"><button onclick="toggleAll(true)">Expand All</button><button onclick="toggleAll(false)">Collapse All</button></div></div><p id="empty-state" hidden>No test cases match this filter.</p><h2>TEST CASE RESULTS</h2>`);
  html = html.replace(/<p><button onclick="show\('all'\)">All<\/button>[\s\S]*?<\/p>/,
    `<div class="toolbar"><div class="filters"><button class="active" onclick="show('all',this)">All (${statuses.length})</button><button onclick="show('passed',this)">Passed (${count('passed')})</button><button onclick="show('failed',this)">Failed (${count('failed')})</button><button onclick="show('skipped',this)">Skipped (${count('skipped')})</button><button onclick="show('not-executed',this)">Not Executed (${count('not-executed')})</button></div><div class="expand-controls"><button onclick="toggleAll(true)">Expand All</button><button onclick="toggleAll(false)">Collapse All</button></div></div><p id="empty-state" hidden>No test cases match this filter.</p>`);
  html = html.replace(/<script>function show\(status\)[\s\S]*?<\/script>/,
    `<script>function show(status,button){let visible=0;document.querySelectorAll('.test-case[data-status]').forEach(card=>{card.hidden=status!=='all'&&card.dataset.status!==status;if(!card.hidden)visible++});document.querySelectorAll('.filters button').forEach(item=>item.classList.remove('active'));if(button)button.classList.add('active');document.getElementById('empty-state').hidden=visible>0}function toggleAll(open){document.querySelectorAll('.test-case:not([hidden])').forEach(card=>card.open=open)}</script>`);
  html = html.replace('</style></head>', `.toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin:18px 0}.expand-controls{display:flex;gap:8px}.filters button.active{background:#175cd3;color:#fff;border-color:#175cd3}#empty-state{padding:24px;text-align:center;background:#fff;border:1px dashed #98a2b3;border-radius:10px}.test-case .case-header::after{content:'›';font-size:24px;line-height:1}.test-case[open] .case-header::after{transform:rotate(90deg)}.evidence-panel figure{display:inline-block;width:min(320px,100%);vertical-align:top}.evidence-panel img{width:100%;height:180px;object-fit:cover;border-radius:8px}.result-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}@media(max-width:700px){.result-grid{grid-template-columns:1fr}}</style></head>`);
  fs.writeFileSync(file, html, 'utf8');
}
