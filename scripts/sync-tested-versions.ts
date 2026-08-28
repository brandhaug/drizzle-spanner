// Single source of truth for the tested-versions story:
// .github/tested-versions.json drives the CI matrices (via fromJSON in
// ci.yml) and this script renders the same file into the README table
// between the tested-versions markers. CI runs `--check` so the two can
// never drift; a new drizzle-orm beta is added to the JSON file only.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface TestedVersions {
  'drizzle-orm': Array<string>
  node: Array<string>
  bun: boolean
}

const START_MARKER = '<!-- tested-versions:start -->'
const END_MARKER = '<!-- tested-versions:end -->'

// Columns are padded to the widest cell and the table is wrapped in blank
// lines: that is the shape oxfmt normalises markdown tables to, so `--check`
// here and `oxfmt --check` agree on the same README.
export function renderTestedVersionsTable(versions: TestedVersions): string {
  const runtimes = [
    ...versions.node.map((v) => `Node ${v}`),
    ...(versions.bun ? ['Bun'] : [])
  ].join(', ')
  const rows = [
    ['drizzle-orm', 'Runtimes'],
    ...versions['drizzle-orm'].map((v) => [`\`${v}\``, runtimes])
  ]
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => row[column]!.length))
  )
  const line = (cells: Array<string>) =>
    `| ${cells.map((cell, i) => cell.padEnd(widths[i]!)).join(' | ')} |`
  const [header, ...body] = rows
  return [
    '',
    line(header!),
    line(widths.map((width) => '-'.repeat(width))),
    ...body.map(line),
    ''
  ].join('\n')
}

export function replaceTestedVersions(readme: string, table: string): string {
  const start = readme.indexOf(START_MARKER)
  const end = readme.indexOf(END_MARKER)
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `README is missing the ${START_MARKER} / ${END_MARKER} tested-versions markers`
    )
  }
  return `${readme.slice(0, start + START_MARKER.length)}\n${table}\n${readme.slice(
    end
  )}`
}

function main(check: boolean): void {
  const root = join(import.meta.dirname, '..')
  const versions = JSON.parse(
    readFileSync(join(root, '.github/tested-versions.json'), 'utf8')
  ) as TestedVersions
  const readmePath = join(root, 'README.md')
  const readme = readFileSync(readmePath, 'utf8')
  const updated = replaceTestedVersions(readme, renderTestedVersionsTable(versions))
  if (updated === readme) {
    return
  }
  if (check) {
    console.error(
      'README tested-versions table is out of sync with .github/tested-versions.json.\n' +
        'Run: node scripts/sync-tested-versions.ts'
    )
    process.exit(1)
  }
  writeFileSync(readmePath, updated)
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.includes('--check'))
}
