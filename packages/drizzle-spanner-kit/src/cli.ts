#!/usr/bin/env node
import { main } from './cli-main.js'

void main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
