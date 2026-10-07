/* global document, HTMLElement */

import { expect, type Locator, type Page } from '@playwright/test';

import { config } from '../utils/config';
import { routes } from '../utils/routes';
import { BasePage } from './BasePage';

export type RunningHoursUiRow = {
  componentName: string;
  componentCode: string;
  componentCategory: string;
  runningHours: string;
  inheritedRh: string;
};

/**
 * Models the Running Hours overview screen in the Technical > PMS module.
 * The page reads the rendered grid only; it does not call application APIs.
 */
export class RunningHoursPage extends BasePage {
  protected readonly path = routes.runningHours;
  protected readonly pageName = 'Running Hours';
  protected readonly pageLoadedIndicator: Locator;

  private readonly vesselDropdown: Locator;
  private readonly overviewTab: Locator;
  private readonly runningHoursTable: Locator;
  private readonly overviewDataRows: Locator;

  public constructor(page: Page) {
    super(page);

    this.pageLoadedIndicator = page.getByRole('heading', {
      name: 'Running Hours',
      exact: true,
    });

    this.vesselDropdown = page.getByRole('combobox').first();

    this.overviewTab = page
      .getByRole('tab', { name: 'Overview', exact: true })
      .or(page.getByRole('button', { name: 'Overview', exact: true }));

    // The application renders a role="grid", not a <table>.
    this.runningHoursTable = page.getByRole('grid').first();
    this.overviewDataRows = this.runningHoursTable.locator(
      '[role="row"]:has([role="cell"], [role="gridcell"], td)',
    );
  }

  /**
   * Selects the vessel and waits until the Running Hours screen is ready again.
   */
  public async selectVessel(name = config.vesselName): Promise<void> {
    await expect(
      this.pageLoadedIndicator,
      'The Running Hours page should be ready before selecting a vessel',
    ).toBeVisible();

    await this.vesselDropdown.click();

    await this.page.getByRole('option', {
      name,
      exact: true,
    }).click();

    await expect(this.vesselDropdown).toHaveText(name);

    await expect(
      this.overviewTab,
      'The Running Hours Overview tab should remain available after vessel selection',
    ).toBeVisible();
  }

  /**
   * Reads every rendered Running Hours row from the UI.
   * If the grid uses an internal scroll container, the method scrolls it
   * and collects each unique component code before returning to the top.
   */
  public async readOverviewRows(
    options: { allowEmpty?: boolean } = {},
  ): Promise<RunningHoursUiRow[]> {
    // The footer is authoritative, even if the empty grid still says loading.
    // Restart the quiet period whenever the count changes or disappears.
    const componentCount = this.page.getByText(/^Showing\s+[\d,]+\s+components?$/);
    let currentCount = -1;
    let unchangedSince = Date.now();

    await expect.poll(async () => {
      if (!await componentCount.isVisible()) {
        currentCount = -1;
        unchangedSince = Date.now();
        return false;
      }
      const text = await componentCount.innerText();
       const match = /^Showing\s+([\d,]+)\s+components?$/.exec(text.trim());
      const count = match ? Number(match[1].replace(/,/g, '')) : -1;
      if (count !== currentCount || count < 0) {
        currentCount = count;
        unchangedSince = Date.now();
      }
      return currentCount >= 0 && Date.now() - unchangedSince >= 2_000;
    }, {
      message: 'The Running Hours footer component count should settle',
      timeout: 15_000,
      intervals: [100, 250, 500],
    }).toBe(true);

    if (currentCount === 0) {
      expect(
        options.allowEmpty,
        'Running Hours is empty; pass allowEmpty only when the scenario validates whether zero rows are expected.',
      ).toBe(true);
      return [];
    }

    await expect(this.runningHoursTable).toBeVisible();
    await expect(this.overviewDataRows.first(),
      'A non-zero component count should render Running Hours rows',
    ).toBeVisible();

    const rowsByCode = new Map<string, RunningHoursUiRow>();

    const readSnapshot = async () =>
      this.page.evaluate(() => {
        const grid = document.querySelector<HTMLElement>(
          '[role="grid"]',
        );

        if (!grid) {
          return {
            rows: [] as RunningHoursUiRow[],
            scrollTop: 0,
            clientHeight: 0,
            scrollHeight: 0,
            hasScroller: false,
          };
        }

        const headerCells = Array.from(
          grid.querySelectorAll<HTMLElement>(
            '[role="columnheader"]',
          ),
        );

        const headers = headerCells.map((cell) =>
          cell.innerText.trim().toLowerCase(),
        );

        const indexOf = (
          pattern: RegExp,
          startAt = 0,
        ): number =>
          headers.findIndex(
            (header, index) =>
              index >= startAt && pattern.test(header),
          );

        const nameIndex = indexOf(/component\s*name/);

        const componentPlaceholderIndexes = headers
          .map((header, index) => ({ header, index }))
          .filter(
            ({ header, index }) =>
              index > nameIndex &&
              /component\s*(?:code|category|c\s*\.{2,}|\.{2,}|c…)/.test(
                header,
              ),
          )
          .map(({ index }) => index);

        const codeIndex =
          indexOf(/component\s*code/, nameIndex + 1) >= 0
            ? indexOf(/component\s*code/, nameIndex + 1)
            : componentPlaceholderIndexes[0];

        const categoryIndex =
          indexOf(/component\s*category/, nameIndex + 1) >= 0
            ? indexOf(/component\s*category/, nameIndex + 1)
            : componentPlaceholderIndexes.find(
                (index) => index !== codeIndex,
              );

        const runningHoursIndex = indexOf(/running\s*hours/);
        const inheritedIndex = indexOf(/inherited\s*rh/);

        const resolvedCodeIndex = codeIndex ?? 1;
        const resolvedCategoryIndex = categoryIndex ?? 2;

        const rowElements = Array.from(
          grid.querySelectorAll<HTMLElement>('[role="row"]'),
        ).filter(
          (row) =>
            !row.querySelector('[role="columnheader"]'),
        );

        const rows = rowElements
          .map((row) => {
            const cells = Array.from(
              row.querySelectorAll<HTMLElement>(
                '[role="cell"], [role="gridcell"], td',
              ),
            ).map((cell) => cell.innerText.trim());

            return {
              componentName:
                cells[nameIndex >= 0 ? nameIndex : 0] ?? '',
              componentCode:
                cells[resolvedCodeIndex] ?? '',
              componentCategory:
                cells[resolvedCategoryIndex] ?? '',
              runningHours:
                cells[
                  runningHoursIndex >= 0
                    ? runningHoursIndex
                    : 3
                ] ?? '',
              inheritedRh:
                cells[
                  inheritedIndex >= 0
                    ? inheritedIndex
                    : 6
                ] ?? '',
            };
          })
          .filter(
            (row) =>
              row.componentCode ||
              row.componentName,
          );

        // The application can render a virtualized grid. The grid itself
        // may be the scroll container, so check it before its ancestors.
        let scroller: HTMLElement | null = grid;

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

    for (let attempt = 0; attempt < 120; attempt += 1) {
      const snapshot = await readSnapshot();

      for (const row of snapshot.rows) {
        const code = row.componentCode.trim();

        if (code) {
          rowsByCode.set(code, row);
        }
      }

      if (
        !snapshot.hasScroller ||
        snapshot.scrollTop + snapshot.clientHeight >=
          snapshot.scrollHeight - 2
      ) {
        break;
      }

      const previousScrollTop = snapshot.scrollTop;

      await this.page.evaluate(() => {
        const grid = document.querySelector<HTMLElement>(
          '[role="grid"]',
        );

        if (!grid) {
          return;
        }

        let scroller: HTMLElement | null = grid;

        while (scroller && scroller !== document.body) {
          if (
            scroller.scrollHeight >
            scroller.clientHeight + 1
          ) {
            break;
          }

          scroller = scroller.parentElement;
        }

        if (
          scroller &&
          scroller !== document.body
        ) {
          scroller.scrollTop = Math.min(
            scroller.scrollTop +
              Math.max(scroller.clientHeight * 0.8, 1),
            scroller.scrollHeight,
          );
        }
      });

      await this.page.waitForTimeout(150);

      const afterScroll = await readSnapshot();

      if (
        afterScroll.scrollTop <= previousScrollTop &&
        afterScroll.rows.every(
          (row) =>
            !row.componentCode ||
            rowsByCode.has(row.componentCode.trim()),
        )
      ) {
        break;
      }
    }

    await this.page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>(
        '[role="grid"]',
      );

      if (!grid) {
        return;
      }

      let scroller: HTMLElement | null = grid;

      while (scroller && scroller !== document.body) {
        if (
          scroller.scrollHeight >
          scroller.clientHeight + 1
        ) {
          break;
        }

        scroller = scroller.parentElement;
      }

      if (
        scroller &&
        scroller !== document.body
      ) {
        scroller.scrollTop = 0;
      }
    });

    return [...rowsByCode.values()];
  }}
