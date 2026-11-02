import type { Page } from '@playwright/test';

/**
 * Reads the application's toast / alert notification text, ignoring other page
 * text such as the PMS Assistant panel. Returns '' when no notification appears.
 */
export async function readAppNotification(page: Page, timeout = 8_000): Promise<string> {
  const notifications = page
    .getByRole('region', { name: /notification/i })
    .locator('li, [role="status"], [role="alert"]')
    .or(page.locator('[role="alert"], [data-sonner-toast]'))
    .filter({ visible: true });
  const appeared = await notifications.first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);
  if (!appeared) return '';
  const texts = (await notifications.allInnerTexts())
    .map((text) => text.replace(/\s+/g, ' ').replace(/^Notification\s*/i, '').trim())
    .filter(Boolean);
  return [...new Set(texts)].join(' | ');
}
