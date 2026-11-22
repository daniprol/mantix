import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { describe, expect, it } from 'vitest'

import { probeReport } from '../src/DevReport.ts'

describe('mantix dev', () => {
  it('prints one iteration as a waterfall, with errors in words', () => {
    const text = stripVTControlCharacters(
      probeReport('checkout.ts', {
        scenario: 'checkout',
        trace: {
          scenario: 'checkout',
          vu: 1,
          iteration: 1,
          lateMs: 0,
          duration: 100,
          outcome: 'failed',
          spans: [
            { endpoint: 'GET /a', start: 0, duration: 50, status: 200 },
            {
              endpoint: 'GET /cart/:id',
              start: 50,
              duration: 50,
              status: 200,
              error: 'SchemaMismatch',
            },
          ],
        },
        errors: [
          {
            endpoint: 'GET /cart/:id',
            kind: 'SchemaMismatch',
            message: '$.price: Expected number',
            diff: {
              path: '$.price',
              expected: 'Expected number',
              received: '"19.99"',
              receivedType: 'string',
            },
          },
        ],
      }),
    )
    expect(text).toContain('checkout.ts · checkout · 2 requests in 100 ms ✗')
    expect(text).toContain(`GET /a         200     50 ms  ▕${'█'.repeat(16)}`)
    expect(text).toContain(
      '✗ SchemaMismatch GET /cart/:id: $.price: Expected number · received "19.99"',
    )
  })

  // The resolve hook must run in a plain Node process, not inside Vitest's
  // own module loader, so this test starts one.
  it('reloads the test file and the files it imports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mantix-dev-'))
    const helper = join(dir, 'helper.ts')
    const main = join(dir, 'main.ts')
    writeFileSync(main, "export { value } from './helper.ts'\n")
    const script = join(dir, 'check.ts')
    writeFileSync(
      script,
      `
import { writeFileSync } from 'node:fs'
import { enableFreshImports, freshUrl } from ${JSON.stringify(join(import.meta.dirname, '../src/FreshImport.ts'))}
enableFreshImports(${JSON.stringify(dir)})
writeFileSync(${JSON.stringify(helper)}, 'export const value = 1\\n')
const a = await import(freshUrl(${JSON.stringify(main)}, 1))
writeFileSync(${JSON.stringify(helper)}, 'export const value = 2\\n')
const b = await import(freshUrl(${JSON.stringify(main)}, 2))
console.log(a.value, b.value)
`,
    )
    const output = execFileSync(process.execPath, [script], {
      encoding: 'utf8',
    })
    expect(output.trim()).toBe('1 2')
  })
})
