/* global document, HTMLElement */

import { expect, type Locator, type Page } from '@playwright/test';
import { config } from '../utils/config';
import { routes } from '../utils/routes';
import { BasePage } from './BasePage';
import { ComponentFormPage } from './ComponentFormPage';

export type ComponentTreeRow = {
  code: string;
  name: string;
  depth: number;
  rawText: string;
};

export type ComponentDetailField = {
  section: string;
  label: string;
};

export type ComponentJobRow = {
  jobCode: string;
  jobTitle: string;
  frequency: string;
  lastDoneDate: string;
  lastDoneHour: string;
};

export type ComponentSpareRow = {
  partCode: string;
  partName: string;
  componentName: string;
  partNumber: string;
  rob: string;
};

/**
 * Models the Components list page in the Technical module.
 */
export class ComponentsPage extends BasePage {
  protected readonly path = routes.componentPage;
  protected readonly pageName = 'Components';
  protected readonly pageLoadedIndicator: Locator;

  private readonly vesselDropdown: Locator;
  private readonly componentCountLabel: Locator;
  private readonly componentRows: Locator;
  private readonly expandAllButton: Locator;
  private selectedComponentCode = '';
  private readonly componentsWithExpandedJobs = new Set<string>();
  private readonly componentsWithExpandedSpares = new Set<string>();
  private readonly jobsByComponent = new Map<string, ComponentJobRow[]>();
  private readonly sparesByComponent = new Map<string, ComponentSpareRow[]>();

  /**
   * What this does: Creates the Components page object and collects the key selectors used on that screen.
   * When it's used: When a test needs to work with the components list.
   * @param page - The Playwright page instance for the Components screen.
   * @returns Nothing
   */
  public constructor(page: Page) {
    super(page);

    this.pageLoadedIndicator = page.getByRole('heading', {
      name: 'Components',
      exact: true,
    });

    this.vesselDropdown = page.getByRole('combobox').first();

    this.componentCountLabel = page.getByText('COMPONENTS', {
      exact: true,
    });
    this.expandAllButton = page.getByRole('button', { name: 'Expand', exact: true });

    /*
     * All component rows use the same row structure.
     *
     * Example:
     * 1 Ship General
     * 2 Hull
     * 3 Equipment for Cargo
     *
     * We intentionally do not use the styling class of the
     * component name span because that class can be shared
     * by other elements.
     */
    this.componentRows = page.locator(
      'div.flex.items-center.px-3.py-2.cursor-pointer',
    );
  }

  /**
   * What this does: Reads the visible count shown for the current component list.
   * When it's used: To compare the page count against the actual row count in assertions.
   * @returns The count shown on the screen, or the row count if the label is not readable.
   */
  public async displayedCount(): Promise<number> {
    const countText = await this.componentCountLabel
      .locator('..')
      .innerText();

    return Number(
      countText.match(/\d+/)?.[0] ?? (await this.rowCount()),
    );
  }

  /**
   * What this does: Counts how many component rows are currently visible in the list.
   * When it's used: When comparing the list total to the header count.
   * @returns The number of rows currently rendered.
   */
  public async rowCount(): Promise<number> {
    return this.componentRows.count();
  }

  /**
   * Expands the complete Components hierarchy and keeps the
   * component selection behavior used by the application.
   *
   * Each component is clicked only once when it is discovered.
   * A component with a right-chevron is expanded by clicking its
   * component text. The same click also keeps the component selected,
   * so the existing details panel behavior is preserved.
   *
   * The DOM is re-read after every click because expanding a parent
   * inserts its children and changes the rendered row list.
   */
  public async expandAll(): Promise<void> {
    await expect(this.expandAllButton).toBeVisible();
    await this.expandAllButton.click();
    await expect(this.componentRows.first()).toBeVisible();

    let previousSignature = '';
    let stableRounds = 0;
    const maxDepthRounds = 20;
    for (let round = 0; round < maxDepthRounds; round += 1) {
      const currentSignature = (await this.componentRows.allInnerTexts()).join('\n');
      stableRounds = currentSignature === previousSignature ? stableRounds + 1 : 0;
      if (stableRounds >= 2) {
        return;
      }
      previousSignature = currentSignature;

      await this.componentRows.evaluateAll((rows) => {
        for (const row of rows as HTMLElement[]) {
          if (row.querySelector('svg.lucide-chevron-right')) {
            row.querySelector<HTMLElement>('button')?.click();
          }
        }
      });
      await this.page.waitForTimeout(250);
    }

    throw new Error(
      `Component hierarchy expansion did not settle after ${maxDepthRounds} depth rounds.`,
    );
  }

  /**
   * Reads all component tree rows from the rendered UI,
   * including their visual nesting depth.
   *
   * No application API is called.
   */
  public async readExpandedTreeRows(): Promise<ComponentTreeRow[]> {
    const rowsByCode = new Map<
      string,
      {
        code: string;
        name: string;
        left: number;
        rawText: string;
      }
    >();

    /*
     * The caller is responsible for expanding the hierarchy.
     * Do not call expandAll() here because the scenario already
     * expands the tree before reading it. Calling it again creates
     * a second full traversal of the hierarchy.
     */
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const snapshot = await this.page.evaluate(() => {
        const selector =
          'div.flex.items-center.px-3.py-2.cursor-pointer';

        const elements = Array.from(
          document.querySelectorAll<HTMLElement>(selector),
        );

        const rows = elements
          .map((element) => {
            const rawText = element.innerText
              .replace(/\s+/g, ' ')
              .trim();

            const match = rawText.match(/^(\d+(?:\.\d+)*)\s+(.+)$/);

            return match
              ? {
                  code: match[1],
                  name: match[2].trim(),
                  left: Math.round(
                    (element.querySelector('button') ?? element)
                      .getBoundingClientRect().left,
                  ),
                  rawText,
                }
              : null;
          })
          .filter(
            (
              row,
            ): row is {
              code: string;
              name: string;
              left: number;
              rawText: string;
            } => Boolean(row),
          );

        /*
         * Find the scrollable parent containing the component tree.
         */
        let scroller: HTMLElement | null =
          elements[0]?.parentElement ?? null;

        while (scroller && scroller !== document.body) {
          if (
            scroller.scrollHeight >
            scroller.clientHeight + 1
          ) {
            break;
          }

          scroller = scroller.parentElement;
        }

        if (!scroller || scroller === document.body) {
          scroller = null;
        }

        return {
          rows,
          scrollTop: scroller?.scrollTop ?? 0,
          clientHeight: scroller?.clientHeight ?? 0,
          scrollHeight: scroller?.scrollHeight ?? 0,
          hasScroller: Boolean(scroller),
        };
      });

      /*
       * Store every row by component code.
       */
      for (const row of snapshot.rows) {
        rowsByCode.set(row.code, row);
      }

      /*
       * Stop when we have reached the bottom of the tree.
       */
      if (
        !snapshot.hasScroller ||
        snapshot.scrollTop + snapshot.clientHeight >=
          snapshot.scrollHeight - 2
      ) {
        break;
      }

      /*
       * Scroll down to collect additional rows.
       */
      await this.page.evaluate(() => {
        const first = document.querySelector<HTMLElement>(
          'div.flex.items-center.px-3.py-2.cursor-pointer',
        );

        if (!first) {
          return;
        }

        let scroller: HTMLElement | null =
          first.parentElement;

        while (scroller && scroller !== document.body) {
          if (
            scroller.scrollHeight >
            scroller.clientHeight + 1
          ) {
            break;
          }

          scroller = scroller.parentElement;
        }

        if (scroller && scroller !== document.body) {
          scroller.scrollTop = Math.min(
            scroller.scrollTop +
              Math.max(scroller.clientHeight * 0.8, 1),
            scroller.scrollHeight,
          );
        }
      });

      await this.page.waitForTimeout(100);
    }

    /*
     * Return the tree to the top.
     */
    await this.page.evaluate(() => {
      const first = document.querySelector<HTMLElement>(
        'div.flex.items-center.px-3.py-2.cursor-pointer',
      );

      if (!first) {
        return;
      }

      let scroller: HTMLElement | null =
        first.parentElement;

      while (scroller && scroller !== document.body) {
        if (
          scroller.scrollHeight >
          scroller.clientHeight + 1
        ) {
          break;
        }

        scroller = scroller.parentElement;
      }

      if (scroller && scroller !== document.body) {
        scroller.scrollTop = 0;
      }
    });

    const rows = [...rowsByCode.values()];

    /*
     * Calculate hierarchy depth from the horizontal position.
     */
    const levels = [
      ...new Set(rows.map((row) => row.left)),
    ].sort((a, b) => a - b);

    return rows.map((row) => ({
      code: row.code,
      name: row.name,
      depth: Math.max(0, levels.indexOf(row.left)),
      rawText: row.rawText,
    }));
  }

  /**
   * What this does: Selects a vessel from the dropdown and waits for the component list to refresh.
   * When it's used: Before filtering the component table for a specific vessel.
   * @param name - The vessel name to select.
   * @returns Nothing
   */
  public async selectVessel(
    name = config.vesselName,
  ): Promise<void> {
    await expect(
      this.pageLoadedIndicator,
      'The Components page should be ready before selecting a vessel',
    ).toBeVisible();

    await this.vesselDropdown.click();

    await Promise.all([
      this.page.waitForResponse(
        (response) =>
          response
            .url()
            .includes('/technical/api/components') &&
          response.request().method() === 'GET' &&
          response.status() === 200,
      ),

      this.page
        .getByRole('option', {
          name,
          exact: true,
        })
        .click(),
    ]);
  }

  /**
   * What this does: Returns the first visible component row from the list.
   * When it's used: For quick checks on the list content.
   * @returns The first component row locator.
   */
  public firstRow(): Locator {
    return this.componentRows.first();
  }

  public async selectComponentByCode(code: string): Promise<void> {
    const codePattern = new RegExp(
      `^${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`,
    );
    const row = await this.findRenderedComponentRow(codePattern, code);
    await expect(row, `Component ${code} should be present in the expanded tree`).toHaveCount(1);
    await row.scrollIntoViewIfNeeded();
    // The row initiates selection. The leading control then commits/renders
    // imported nodes (including leaves whose button has no visible chevron).
    // Restore an expanded parent if that control temporarily collapses it.
    await row.click();
    const selectionButton = row.locator('button').first();
    await selectionButton.click();
    const collapsedChevron = row.locator('svg.lucide-chevron-right');
    if (await collapsedChevron.isVisible().catch(() => false)) {
      await selectionButton.click();
    }
    await expect(
      this.page.getByText('Select a component to view details', { exact: true }),
    ).toBeHidden();
    await this.waitForSelectedComponent(code);
    this.selectedComponentCode = code.trim().toLowerCase();
  }

  private async findRenderedComponentRow(codePattern: RegExp, code: string): Promise<Locator> {
    await this.setComponentTreeScrollTop(0);
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const row = this.componentRows.filter({ hasText: codePattern }).first();
      if (await row.count()) return row;

      const before = (await this.componentRows.allInnerTexts()).join('\n');
      const moved = await this.page.evaluate(() => {
        const first = document.querySelector<HTMLElement>('div.flex.items-center.px-3.py-2.cursor-pointer');
        let scroller = first?.parentElement ?? null;
        while (scroller && scroller !== document.body && scroller.scrollHeight <= scroller.clientHeight + 1) scroller = scroller.parentElement;
        if (!scroller || scroller === document.body) return false;
        const previous = scroller.scrollTop;
        scroller.scrollTop = Math.min(previous + Math.max(scroller.clientHeight * 0.8, 1), scroller.scrollHeight);
        return scroller.scrollTop > previous;
      });
      if (!moved) break;
      await expect.poll(
        () => this.componentRows.allInnerTexts().then((texts) => texts.join('\n')),
        { message: `Component tree should render the next rows while searching for exact code ${code}`, timeout: 2_000 },
      ).not.toBe(before);
    }
    return this.componentRows.filter({ hasText: codePattern }).first();
  }

  private async setComponentTreeScrollTop(scrollTop: number): Promise<void> {
    await this.page.evaluate((target) => {
      const first = document.querySelector<HTMLElement>('div.flex.items-center.px-3.py-2.cursor-pointer');
      let scroller = first?.parentElement ?? null;
      while (scroller && scroller !== document.body && scroller.scrollHeight <= scroller.clientHeight + 1) scroller = scroller.parentElement;
      if (scroller && scroller !== document.body) scroller.scrollTop = target;
    }, scrollTop);
  }

  public async waitForSelectedComponent(code: string): Promise<void> {
    const escapedCode = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const selectedHeading = this.page
      .getByRole('heading', {
        level: 3,
        name: new RegExp(`^${escapedCode}(?:\\s|$)`),
      })
      .filter({ visible: true });
    await expect(
      selectedHeading.last(),
      `The selected Component details should update to code ${code}`,
    ).toBeVisible({ timeout: 30_000 });
  }

  public async readSelectedComponentDetailsText(): Promise<string> {
    return (await this.page.locator('body').innerText())
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  public async readSelectedComponentDetail(
    field: ComponentDetailField,
  ): Promise<string> {
    const sectionHeading = this.page.getByText(field.section, {
      exact: true,
    }).filter({ visible: true }).last();
    // The primary details panel is reliably identified by its visible field
    // labels. Its decorative section heading is not always rendered, so it
    // must not block validation of an otherwise loaded selected Component.
    if (field.section !== 'A. Component Information') {
      await expect(sectionHeading, `${field.section} should be visible for the selected Component`).toBeVisible({ timeout: 5_000 });
    }

    if (field.section === 'C. Running Hours & Condition Monitoring') {
      const grid = sectionHeading.locator('xpath=following::*[@role="grid"][1]');
      await expect(grid).toBeVisible();
      const headers = await grid.getByRole('columnheader').allInnerTexts();
      const columnIndex = headers.findIndex((header) => header.trim() === field.label);
      if (columnIndex < 0) {
        throw new Error(`${field.label} is not present in ${field.section}.`);
      }
      return (await grid.getByRole('gridcell').nth(columnIndex).innerText()).trim();
    }

    const label = this.page.getByText(field.label, { exact: true }).filter({ visible: true }).last();
    await expect(label, `${field.label} should be exposed in ${field.section}`).toBeVisible({ timeout: 5_000 });

    const fieldContainer = label.locator('..');
    const toggle = fieldContainer.locator(
      '[role="switch"], input[type="checkbox"]',
    ).first();
    if (await toggle.count()) {
      const checked = await toggle.getAttribute('aria-checked')
        ?? await toggle.getAttribute('data-state')
        ?? String(await toggle.isChecked().catch(() => false));
      return /^(?:true|checked|on)$/i.test(checked) ? 'Yes' : 'No';
    }

    const lines = (await fieldContainer.innerText())
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.filter((line) => line !== field.label).join(' ').trim();
  }

  public async readJobByCode(jobCode: string): Promise<ComponentJobRow | null> {
    const cachedJobs = this.jobsByComponent.get(this.selectedComponentCode);
    if (cachedJobs) {
      return cachedJobs.find((job) => job.jobCode.toLowerCase() === jobCode.trim().toLowerCase()) ?? null;
    }

    const sectionHeading = this.page.getByText('D. Jobs', { exact: true });
    await expect(sectionHeading, 'The selected Component should expose D. Jobs').toBeVisible();
    await sectionHeading.scrollIntoViewIfNeeded();

    const table = sectionHeading.locator('xpath=following::*[@role="grid" or self::table][1]');
    if (!(await table.isVisible()) && await sectionHeading.isEnabled()) {
      await sectionHeading.click();
    }
    await expect(table, 'The D. Jobs table should be visible').toBeVisible();
    await table.scrollIntoViewIfNeeded();
    let jobsTable = table;
    const expandedDialog = this.page.getByRole('dialog').filter({ hasText: 'Job Code' }).last();
    if (!this.componentsWithExpandedJobs.has(this.selectedComponentCode)) {
      const showAll = sectionHeading.locator(
        'xpath=following::button[contains(normalize-space(.), "Show All (") and contains(translate(normalize-space(.), "JOBS", "jobs"), "jobs)")][1]',
      );
      if (await showAll.count()) {
        await showAll.scrollIntoViewIfNeeded();
      }
      if (await showAll.isVisible()) {
        const rowsBefore = await table.locator('[role="row"], tbody tr').count();
        await showAll.click();
        await expect.poll(
          async () => await expandedDialog.isVisible()
            || await table.locator('[role="row"], tbody tr').count() > rowsBefore,
          'The D. Jobs table should finish updating after Show All is selected',
        ).toBe(true);
        if (await expandedDialog.isVisible()) {
          jobsTable = expandedDialog.locator('[role="grid"], table').filter({ hasText: 'Job Code' }).first();
          await expect(jobsTable, 'The expanded D. Jobs table should be visible').toBeVisible();
        }
        this.componentsWithExpandedJobs.add(this.selectedComponentCode);
      }
    }
    const headers = (await jobsTable.locator('[role="columnheader"], thead th').allInnerTexts()).map((value) => value.trim());
    const rows = jobsTable.locator('[role="row"], tbody tr');
    const jobs: ComponentJobRow[] = [];
    for (let index = 0; index < await rows.count(); index += 1) {
      const row = rows.nth(index);
      const cells = row.locator('[role="gridcell"], td');
      if (!await cells.count()) continue;
      const values = (await cells.allInnerTexts()).map((value) => value.trim());
      const valueFor = (names: string[]) => {
        const column = headers.findIndex((header) => names.some((name) => header.toLowerCase() === name.toLowerCase()));
        return column >= 0 ? values[column] ?? '' : '';
      };
      const rowJobCode = valueFor(['Job Code']);
      if (!rowJobCode) continue;
      jobs.push({
        jobCode: rowJobCode,
        jobTitle: valueFor(['Job Title', 'WO Title']),
        frequency: valueFor(['Frequency']),
        lastDoneDate: valueFor(['Last Done Date']),
        lastDoneHour: valueFor(['Last Done Hour']),
      });
    }
    this.jobsByComponent.set(this.selectedComponentCode, jobs);
    if (await expandedDialog.isVisible()) {
      const closeButton = expandedDialog.getByRole('button', { name: /close/i }).first();
      if (await closeButton.count()) await closeButton.click();
      else await this.page.keyboard.press('Escape');
    }
    return jobs.find((job) => job.jobCode.toLowerCase() === jobCode.trim().toLowerCase()) ?? null;
  }

  public async readSpareByPartCode(partCode: string): Promise<ComponentSpareRow | null> {
    const cached = this.sparesByComponent.get(this.selectedComponentCode);
    if (cached) return cached.find((spare) => spare.partCode.toLowerCase() === partCode.trim().toLowerCase()) ?? null;
    const heading = this.page.getByText('F. Spares', { exact: true });
    await expect(heading, 'The selected Component should expose F. Spares').toBeVisible();
    await heading.scrollIntoViewIfNeeded();
    let table = heading.locator('xpath=following::*[@role="grid" or self::table][1]');
    if (!(await table.isVisible())) await heading.click();
    await expect(table, 'The F. Spares table should be visible').toBeVisible();
    await table.scrollIntoViewIfNeeded();
    const dialog = this.page.getByRole('dialog').filter({ hasText: 'Part Code' }).last();
    if (!this.componentsWithExpandedSpares.has(this.selectedComponentCode)) {
      const showAll = this.page.getByRole('button', {
        name: /^Show All \(\d+\s+spares?\)$/i,
      }).last();
      if (await showAll.count()) {
        await showAll.scrollIntoViewIfNeeded();
      }
      if (await showAll.isVisible()) {
        const rowsBefore = await table.locator('[role="row"], tbody tr').count();
        await showAll.click();
        await expect.poll(
          async () => await dialog.isVisible()
            || await table.locator('[role="row"], tbody tr').count() > rowsBefore,
          'The F. Spares table should finish updating after Show All is selected',
        ).toBe(true);
        this.componentsWithExpandedSpares.add(this.selectedComponentCode);
      }
    }
    if (await dialog.isVisible()) {
      table = dialog.locator('[role="grid"], table').filter({ hasText: 'Part Code' }).first();
      await expect(table, 'The expanded F. Spares table should be visible').toBeVisible();
    }
    const headers = (await table.locator('[role="columnheader"], thead th').allInnerTexts()).map((value) => value.trim().toLowerCase());
    const sparesByPartCode = new Map<string, ComponentSpareRow>();
    const readVisibleRows = async () => {
      const rows = table.locator('[role="row"], tbody tr');
      for (let index = 0; index < await rows.count(); index += 1) {
        const values = (await rows.nth(index).locator('[role="gridcell"], td').allInnerTexts()).map((value) => value.trim());
        if (!values.length) continue;
        const valueFor = (patterns: RegExp[]) => {
          const column = headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
          return column >= 0 ? values[column] ?? '' : '';
        };
        const rowPartCode = valueFor([/^part code$/i]);
        if (!rowPartCode) continue;
        sparesByPartCode.set(rowPartCode.toLowerCase(), {
          partCode: rowPartCode,
          partName: valueFor([/^part name$/i]),
          componentName: valueFor([/^component(?: name)?$/i]),
          partNumber: valueFor([/^part number$/i]),
          rob: valueFor([/^rob$/i, /total rob/i]),
        });
      }
    };

    const paginationStatus = this.page.getByText(/^Page \d+ of \d+$/).last();
    const visitedPages = new Set<string>();
    while (true) {
      await readVisibleRows();
      if (!(await paginationStatus.isVisible())) break;
      const currentPage = (await paginationStatus.innerText()).trim();
      if (visitedPages.has(currentPage)) {
        throw new Error(`F. Spares pagination did not advance from ${currentPage}.`);
      }
      visitedPages.add(currentPage);
      const nextPage = paginationStatus.locator('..').getByRole('button').last();
      if (!(await nextPage.isEnabled())) break;
      await nextPage.click();
      await expect(paginationStatus, 'The F. Spares table should load the next page').not.toHaveText(currentPage);
    }
    const spares = [...sparesByPartCode.values()];
    this.sparesByComponent.set(this.selectedComponentCode, spares);
    if (await dialog.isVisible()) {
      const close = dialog.getByRole('button', { name: /close/i }).first();
      if (await close.count()) await close.click(); else await this.page.keyboard.press('Escape');
    }
    return spares.find((spare) => spare.partCode.toLowerCase() === partCode.trim().toLowerCase()) ?? null;
  }

  /**
   * What this does: Opens the add-component form so a new item can be created.
   * When it's used: In tests that create a component.
   * @returns The component form page object.
   */
  public async openComponentForAdd(): Promise<ComponentFormPage> {
    await this.page
      .getByRole('button', {
        name: 'Add Component',
        exact: true,
      })
      .click();

    return new ComponentFormPage(this.page);
  }

  /**
   * What this does: Finds the row for a component code by filtering the list and returning the matching locator.
   * When it's used: When a test needs to edit or verify a specific component.
   * @param code - The component code to search for.
   * @returns The matching row locator for the component.
   */
  public async findRowByCode(
    code: string,
  ): Promise<Locator> {
    /*
     * Expand the tree using the same generic logic used
     * by the Components validation.
     */
    await this.expandAll();

    await this.page
      .getByPlaceholder(
        'Search by Name, SFI Code, Fleet Equipment Code, Maker, or Se...',
      )
      .fill(code);

    await expect
      .poll(
        () =>
          this.page.getByText(code, {
            exact: true,
          }).count(),
        `Component ${code} should appear in the refreshed list`,
      )
      .toBeGreaterThan(0);

    return this.page
      .getByText(code, {
        exact: true,
      })
      .last();
  }

  /**
   * What this does: Opens the edit form for a selected component row.
   * When it's used: After finding a component in the list and choosing to update it.
   * @param row - The component row to open.
   * @returns The component form page object ready for editing.
   */
  public async openRowForEdit(
    row: Locator,
  ): Promise<ComponentFormPage> {
    await row.click();

    await expect(
      this.page.getByRole('button', {
        name: 'Edit Component',
        exact: true,
      }),
    ).toBeVisible();

    await this.page
      .getByRole('button', {
        name: 'Edit Component',
        exact: true,
      })
      .click();

    return new ComponentFormPage(this.page);
  }
}
