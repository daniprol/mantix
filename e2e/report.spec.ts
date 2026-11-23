/**
 * The shareable report, end to end: `mantix run --report` writes one HTML
 * file, and a browser opens it straight from disk (file://), with no
 * server, the way someone opens a CI artifact or an attachment.
 *
 * The demo target comes from playwright.config.ts; `mantix ui` is not
 * used here.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { expect, test } from '@playwright/test'

const root = resolve(import.meta.dirname, '..')

/** Run examples/quick.ts for 3 s and write its report. */
const writeReport = (...flags: Array<string>): string => {
  const file = join(mkdtempSync(join(tmpdir(), 'mantix-report-')), 'run.html')
  try {
    execFileSync(
      'node',
      [
        'packages/server/src/bin.ts',
        'run',
        'examples/quick.ts',
        '--duration',
        '3s',
        '--quiet',
        '--no-history',
        '--report',
        file,
        ...flags,
      ],
      { cwd: root, stdio: 'pipe' },
    )
  } catch {
    // Exit code 99 (a threshold failed) still writes the report.
  }
  return pathToFileURL(file).href
}

test('a report opens from disk and moves between its pages', async ({
  page,
}) => {
  const errors: Array<string> = []
  page.on('pageerror', error => errors.push(error.message))

  await page.goto(writeReport())

  // The run's page, without anything that needs the server.
  await expect(page.getByRole('banner').getByRole('status')).toContainText(
    'Finished',
  )
  await expect(page.getByRole('region', { name: 'Endpoints' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Sections' })).toHaveCount(
    0,
  )
  await expect(page.getByRole('button', { name: 'Run again' })).toHaveCount(0)

  // An endpoint: its page lives after the "#".
  await page
    .getByRole('region', { name: 'Endpoints' })
    .getByRole('link', { name: /products/ })
    .click()
  await expect(page).toHaveURL(/#\/runs\/\w+\/endpoints\//)
  await expect(page.getByRole('region', { name: 'Percentiles' })).toBeVisible()

  // A reload keeps the page; Back returns to the run.
  await page.reload()
  await expect(page.getByRole('region', { name: 'Percentiles' })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('region', { name: 'Endpoints' })).toBeVisible()

  expect(errors).toEqual([])
})
