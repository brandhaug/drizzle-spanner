// Verifies that `npm pack` for each publishable package contains dist/
// plus the standard metadata files and nothing else (spec: package layout —
// the `files` whitelist is `dist`). CI runs this on every PR and release.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const METADATA_FILES = new Set(['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'])

export function findPackViolations(files: Array<string>): Array<string> {
  const violations = files.filter(
    (file) => !file.startsWith('dist/') && !METADATA_FILES.has(file)
  )
  if (!files.some((file) => file.startsWith('dist/'))) {
    violations.push('no dist/ files in the tarball')
  }
  return violations
}

interface PackReport {
  files: Array<{ path: string }>
}

function main(): void {
  const root = join(import.meta.dirname, '..')
  const packageDirs = [root, join(root, 'packages/drizzle-spanner-kit')]
  let failed = false
  for (const dir of packageDirs) {
    const [report = { files: [] }] = JSON.parse(
      execFileSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: dir,
        encoding: 'utf8',
        // npm mixes "npm notice" lines into stderr only; stdout is the JSON.
        stdio: ['ignore', 'pipe', 'ignore']
      })
    ) as Array<PackReport>
    const files = report.files.map((f) => f.path)
    const violations = findPackViolations(files)
    if (violations.length > 0) {
      failed = true
      console.error(`${dir}: unexpected pack contents:`)
      for (const violation of violations) {
        console.error(`  - ${violation}`)
      }
    } else {
      console.log(`${dir}: ${files.length} files, all within the whitelist`)
    }
  }
  if (failed) {
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main()
}
