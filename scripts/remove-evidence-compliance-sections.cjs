const fs = require('node:fs');
const path = require('node:path');

const reportsRoot = path.resolve(__dirname, '..', 'reports');
const section = /<section class="evidence-compliance">[\s\S]*?<\/section>/g;

function htmlFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? htmlFiles(target) : entry.name.toLowerCase().endsWith('.html') ? [target] : [];
  });
}

let changed = 0;
for (const file of htmlFiles(reportsRoot)) {
  const original = fs.readFileSync(file, 'utf8');
  const updated = original.replace(section, '');
  if (updated === original) continue;
  fs.writeFileSync(file, updated, 'utf8');
  changed += 1;
}

console.log(`Removed Evidence Compliance sections from ${changed} existing HTML report(s).`);
