import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { generate } from './commands/generate.js'
import { migrate } from './commands/migrate.js'
import { pull } from './commands/pull.js'
import { push } from './commands/push.js'
import { loadConfig } from './config.js'
import { DiffRefusedError } from './differ.js'
import type { RenameCandidate } from './differ.js'

const HELP = `drizzle-spanner-kit <command> [options]

Commands:
  generate   Diff the schema against the latest snapshot and write a migration
  migrate    Apply pending migrations to the database
  pull       Introspect the database into schema files and a baseline snapshot
  push       Diff the schema against the live database and apply after confirmation

Options:
  --config <path>       Config file (default ./drizzle-spanner.config.ts)
  --name <name>         Migration name for generate (default "migration")
  --schema-file <path>  Output schema module for pull (default <out>/schema.ts)
  --no-interactive      Never prompt; ambiguous renames refuse unless --accept-drops
  --accept-drops        With --no-interactive: treat ambiguous renames as drop+create
  --yes                 push: apply the printed plan without prompting
  --help                Show this help
`

async function promptRename(candidate: RenameCandidate): Promise<string | null> {
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const scope =
      candidate.kind === 'table'
        ? `Table "${candidate.dropped}"`
        : `Column "${candidate.dropped}" of "${candidate.table}"`
    console.log(`${scope} is gone from the schema. Was it renamed?`)
    candidate.created.forEach((name, index) =>
      console.log(`  ${index + 1}) renamed to ${name}`)
    )
    console.log('  0) no, it was dropped')
    const answer = await readline.question('> ')
    const choice = Number(answer.trim())
    if (Number.isInteger(choice) && choice >= 1 && choice <= candidate.created.length) {
      return candidate.created[choice - 1]!
    }
    return null
  } finally {
    readline.close()
  }
}

function printPlan(statements: string[]): void {
  console.log('The following DDL will be applied:\n')
  for (const statement of statements) console.log(`${statement};\n`)
}

/** `--yes`: still print the plan (spec: push always prints it) before applying. */
async function acceptPlan(statements: string[]): Promise<boolean> {
  printPlan(statements)
  return true
}

async function confirmPlan(statements: string[]): Promise<boolean> {
  printPlan(statements)
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await readline.question('Apply these statements? [y/N] ')
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    readline.close()
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      name: { type: 'string' },
      'schema-file': { type: 'string' },
      'no-interactive': { type: 'boolean' },
      'accept-drops': { type: 'boolean' },
      yes: { type: 'boolean' },
      help: { type: 'boolean' }
    }
  })
  const command = positionals[0]
  if (values.help || !command) {
    console.log(HELP)
    return command ? 0 : 1
  }
  const config = await loadConfig(values.config ?? './drizzle-spanner.config.ts')
  const interactive = process.stdin.isTTY === true && values['no-interactive'] !== true

  try {
    switch (command) {
      case 'generate': {
        const result = await generate(config, {
          name: values.name,
          resolveRename: interactive ? promptRename : undefined,
          acceptDrops: values['accept-drops']
        })
        console.log(
          result.folder
            ? `Wrote ${result.folder} (${result.statements.length} statements)`
            : 'No schema changes.'
        )
        return 0
      }
      case 'migrate': {
        const result = await migrate(config)
        console.log(
          result.applied.length > 0
            ? `Applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`
            : 'Nothing to apply.'
        )
        return 0
      }
      case 'pull': {
        const result = await pull(config, { schemaFile: values['schema-file'] })
        console.log(
          `Wrote ${result.schemaFile} (${result.tables} tables) and ${result.folder}`
        )
        return 0
      }
      case 'push': {
        const confirm = values.yes ? acceptPlan : interactive ? confirmPlan : undefined
        const result = await push(config, {
          confirm,
          resolveRename: interactive ? promptRename : undefined,
          acceptDrops: values['accept-drops']
        })
        if (result.statements.length === 0) {
          console.log('No schema changes.')
        } else if (result.applied) {
          console.log(`Applied ${result.statements.length} statements.`)
        } else {
          if (!confirm) printPlan(result.statements)
          console.log('Not applied. Re-run with --yes or confirm interactively.')
        }
        return 0
      }
      default:
        console.error(`Unknown command: ${command}\n\n${HELP}`)
        return 1
    }
  } catch (error) {
    if (error instanceof DiffRefusedError) {
      console.error(error.message)
      return 1
    }
    throw error
  }
}
