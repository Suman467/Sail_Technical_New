export type ReportCaseOutcome = "passed" | "failed" | "skipped" | "not-executed";

/** Distinguishes an intentional skip from a scenario Playwright never ran after setup failed. */
export function classifyCaseOutcome(
  status: string,
  expectedStatus: string,
  hasSkipReason: boolean,
  skipReason = "",
): ReportCaseOutcome {
  if (status === "passed") return "passed";
  if (status !== "skipped") return "failed";
  if (/^NOT EXECUTED\b/i.test(skipReason.trim())) return "not-executed";
  return expectedStatus === "skipped" || hasSkipReason ? "skipped" : "not-executed";
}

/** Names the business stage without exposing locators, stack traces, or framework syntax. */
export function failureStage(title: string, phase: string): string {
  if (phase === "suite-setup" || phase === "test-setup") return "common setup or navigation";
  if (phase === "teardown") return "after-test restoration";
  if (/log ?in|authenticat/i.test(title)) return "login";
  if (/navigate|open .*page|select vessel|tree.*load/i.test(title)) return "navigation";
  if (/search|locate|select component|reopen|open edit/i.test(title)) return "record selection or reopening";
  if (/enter|fill|change|set |clear|select maker|editability/i.test(title)) return "data entry or field interaction";
  if (/validation|reject|message|feedback/i.test(title) && !/save/i.test(title)) return "validation before Save";
  if (/refresh|persist|retained|verify saved|after reopening/i.test(title)) return "refresh or persistence verification";
  if (/generate (?:a )?work order|generate wo|work order was created/i.test(title)) return "Generate Work Order";
  if (/save|submit|create/i.test(title)) return "Save operation";
  if (/cleanup/i.test(title)) return "cleanup";
  if (/delete/i.test(title)) return "Delete operation";
  return "scenario execution";
}

/** Reports an unfinished action without implying that its expected result passed. */
export function unfinishedStepActual(timeoutMilliseconds?: number): string {
  if (timeoutMilliseconds !== undefined) {
    const seconds = Math.round(timeoutMilliseconds / 1000);
    return `This step was still running when the scenario reached its time limit (${seconds} seconds); no result was observed for it.`;
  }
  return "This step did not finish before the test ended; no result was observed for it.";
}

/** Adds action and expectation context to an observed business failure. */
export function businessFailureActual(title: string, expected: string, observed: string): string {
  const cleanObserved = observed.trim().replace(/\s+/g, " ");
  if (/^The automation attempted\b/i.test(cleanObserved)) return cleanObserved;
  const action = title.replace(/[.:]+$/, "").trim();
  return `The automation attempted to ${action.charAt(0).toLowerCase()}${action.slice(1)}, but ${cleanObserved.charAt(0).toLowerCase()}${cleanObserved.slice(1)} The expected result was: ${expected}`;
}

const EMBEDDED_IMAGE = /(\s)(src|href)="(data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+)"/gi;
// Decodes a screenshot only when its row is shown; a link gets a blob URL on first click,
// because browsers refuse to open data: URLs in a new tab.
const EMBEDDED_IMAGE_LOADER = "(()=>{const store=document.getElementById('report-images');let pool;const uri=id=>(pool??=JSON.parse(store.textContent))[Number(id)];"
  + "const load=img=>{if(!img.getAttribute('src'))img.src=uri(img.dataset.image)};const images=document.querySelectorAll('img[data-image]');"
  + "if('IntersectionObserver' in window){const io=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){io.unobserve(entry.target);load(entry.target)}}),{rootMargin:'600px 0px'});images.forEach(img=>io.observe(img))}else images.forEach(load);"
  + "window.addEventListener('beforeprint',()=>images.forEach(load));"
  + "document.addEventListener('click',event=>{const link=event.target.closest&&event.target.closest('a[data-image-link]');if(!link||link.dataset.ready)return;const [meta,data]=uri(link.dataset.imageLink).split(',');"
  + "const bytes=Uint8Array.from(atob(data),char=>char.charCodeAt(0));link.href=URL.createObjectURL(new Blob([bytes],{type:meta.slice(5,meta.indexOf(';'))}));link.dataset.ready='1'},true)})();";

/**
 * Stores every embedded screenshot once and decodes it only when its row is
 * displayed. Reports keep all evidence in the single HTML file, but a collapsed
 * test case no longer forces the browser to parse and decode its screenshots,
 * and a thumbnail and its full-size link share one copy.
 */
export function deferEmbeddedImages(html: string): string {
  const ids = new Map<string, number>();
  const pool: string[] = [];
  const body = html.replace(EMBEDDED_IMAGE, (_match, space: string, attribute: string, uri: string) => {
    let id = ids.get(uri);
    if (id === undefined) {
      id = pool.length;
      ids.set(uri, id);
      pool.push(uri);
    }
    return attribute.toLowerCase() === "src" ? `${space}data-image="${id}" decoding="async"` : `${space}href="#" data-image-link="${id}"`;
  });
  if (!pool.length) return html;
  // Base64 data URIs contain no "<", so the JSON cannot close the script element.
  const store = `<script type="application/json" id="report-images">${JSON.stringify(pool)}</script><script>${EMBEDDED_IMAGE_LOADER}</script>`;
  const end = body.lastIndexOf("</body>");
  return end < 0 ? body + store : body.slice(0, end) + store + body.slice(end);
}

export type OverallExecutionStatus = "PASSED" | "FAILED" | "INCOMPLETE" | "SKIPPED";

/**
 * Overall status of a report: FAILED only when a test case genuinely failed;
 * INCOMPLETE when nothing failed but a required case was NOT EXECUTED; SKIPPED
 * when every case was intentionally skipped. Intentionally skipped or deferred
 * cases alongside passing ones never make a run FAILED.
 */
export function overallExecutionStatus(counts: { failed: number; notExecuted: number; skipped: number; total: number }): OverallExecutionStatus {
  if (counts.failed) return "FAILED";
  if (counts.notExecuted) return "INCOMPLETE";
  return counts.total > 0 && counts.skipped === counts.total ? "SKIPPED" : "PASSED";
}
