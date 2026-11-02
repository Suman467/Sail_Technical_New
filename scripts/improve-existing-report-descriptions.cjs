const fs = require("node:fs");
const path = require("node:path");

const roots = [path.resolve("reports", "validation"), path.resolve("reports", "audit")];

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : entry.isFile() && entry.name.endsWith(".html") ? [target] : [];
  });
}

function text(value) {
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function html(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function expectedFor(name) {
  const clean = text(name).replace(/[.]+$/, "");
  if (/^log in/i.test(clean)) return "User should successfully log in to the application.";
  if (/^(?:open|navigate to)\b/i.test(clean)) return `${clean} should open successfully.`;
  if (/^(?:verify|validate|confirm|check)\b/i.test(clean)) return `${clean} should match the expected application result.`;
  if (/\b(?:omit|missing|without|empty|required|mandatory)\b/i.test(clean))
    return `The application should enforce the required-field behavior described by "${clean}" and prevent invalid data from being saved.`;
  if (/\bdelete\b/i.test(clean)) return `${clean} should remove only the intended record and confirm that it no longer exists.`;
  return `${clean} should complete and the application should produce the outcome defined by the scenario.`;
}

function simpleFailure(technical) {
  const plain = text(technical);
  const milliseconds = plain.match(/Timeout\s+(\d+)ms/i)?.[1];
  const duration = milliseconds ? `${Number(milliseconds) / 1000} seconds` : "the allowed time";
  if (/locator\.inputValue|inputValue/i.test(plain))
    return `The test could not read the required field within ${duration}. The field was not verified and the remaining business validation was not reached.`;
  if (/TimeoutError|exceeded|timed out/i.test(plain))
    return `The required application element or state was not available within ${duration}. Execution stopped at this step, so the remaining business validation was not reached.`;
  return "Execution stopped before the expected business behavior could be verified.";
}

function updateValidationScenarios(source) {
  return source.replace(
    /<tr data-status="(passed|failed|skipped)">([\s\S]*?)(?=<tr data-status=|<\/tbody><\/table><\/main>)/gi,
    (whole, status, body) => {
      const title = text(body.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1] ?? "the scenario");
      const rows = [...body.matchAll(/<tr><td>([^<]*)<\/td><td>([\s\S]*?)<\/td><td>([\s\S]*?)<\/td><td>([\s\S]*?)<\/td><td[^>]*>(PASS|FAIL|NOT RUN)<\/td><\/tr>/gi)].map((match) => ({
        title: text(match[2]), expected: match[3], actual: match[4], status: match[5].toUpperCase(),
      }));
      const meaningful = rows.filter((row) => !/^(?:log in|login|open (?:the )?(?:dashboard|audit dashboard)|setup or navigation)\b/i.test(row.title));
      const representative = rows.find((row) => row.status === "FAIL") ?? meaningful.at(-1) ?? rows.at(-1);
      const expected = representative?.expected ?? html(expectedFor(title));
      const technicalMatch = body.match(/(?:Technical Reason|Reason):<br>([\s\S]*?)(?=<br><br>Status:|<\/p>)/i);
      const technicalParagraph = body.match(/<p><strong>Technical Reason:<\/strong>\s*([\s\S]*?)<\/p>/i);
      const technical = (technicalMatch?.[1] ?? technicalParagraph?.[1] ?? "").trim();
      let actual;
      if (status.toLowerCase() === "passed") actual = representative?.actual ?? "The scenario completed and its expected application behavior was verified.";
      else if (status.toLowerCase() === "skipped") actual = "The scenario was skipped before its business behavior could be verified.";
      else if (!rows.length || /scenario (?:ended before|failed during setup)/i.test(text(representative?.actual ?? ""))) actual = html(simpleFailure(technical));
      else actual = representative?.actual ?? html(simpleFailure(technical));

      let updated = body
        .replace(/<p><strong>Expected Result:<\/strong>[\s\S]*?<\/p>/i, `<p><strong>Expected Result:</strong> ${expected}</p>`)
        .replace(/<p><strong>Actual Result:<\/strong>[\s\S]*?<\/p>/i, `<p><strong>Actual Result:</strong> ${actual}</p>`);
      if (technical && !/<p><strong>Technical Reason:<\/strong>/i.test(updated)) {
        updated = updated.replace(/(<table class="business-steps">)/i, `<p><strong>Technical Reason:</strong> ${technical}</p>$1`);
      }
      return `<tr data-status="${status}">${updated}`;
    },
  );
}

let changed = 0;
for (const file of roots.flatMap(walk)) {
  const original = fs.readFileSync(file, "utf8");
  let updated = original
    .replace(/The application should satisfy this business check: ([^<]+)\./g, (_match, name) => html(expectedFor(name)))
    .replace(/The application satisfied this business check: ([^<]+)\./g, (_match, name) => `${name.replace(/[.]+$/, "")} completed and the expected application behavior was verified.`)
    .replace(/The application did not satisfy this business check: ([^<]+)\./g, (_match, name) => `The step stopped before the expected application behavior for &quot;${name.replace(/[.]+$/, "")}&quot; could be verified.`);
  updated = updated.replace(
    /The scenario ended before a business step was recorded\./g,
    "The scenario failed during setup or navigation before a business validation step was reached.",
  );
  updated = updated.replace(
    /<p><strong>Expected Result:<\/strong> All recorded business steps for ([\s\S]*?) should meet their expected outcomes\.<\/p>/g,
    (_match, title) => `<p><strong>Expected Result:</strong> ${html(expectedFor(title))}</p>`,
  );
  updated = updated
    .replace(/<p><strong>Actual Result:<\/strong> The scenario completed successfully\.<\/p>/g, '<p><strong>Actual Result:</strong> The scenario completed and its expected application behavior was verified.</p>')
    .replace(/<p><strong>Actual Result:<\/strong> The scenario was skipped\.<\/p>/g, '<p><strong>Actual Result:</strong> The scenario was skipped before its business behavior could be verified.</p>');
  if (file.includes(`${path.sep}validation${path.sep}`)) updated = updateValidationScenarios(updated);
  if (updated !== original) {
    fs.writeFileSync(file, updated);
    changed += 1;
  }
}

process.stdout.write(`Improved descriptions in ${changed} historical report file(s).\n`);
