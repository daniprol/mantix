#!/usr/bin/env node
import { Effect } from 'effect'
import { Command } from 'effect/cli'

/**
 * The `mantix` command line.
 *
 * `NodeRuntime.runMain` runs the program as the main fiber. On Ctrl-C it
 * interrupts that fiber instead of killing the process, so every Scope
 * closes in order: requests are cancelled, teardown runs, and the summary
 * is still printed. Exit codes come from the errors (see CliExit).
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node'

import { mantix } from './Cli.ts'
import { MANTIX_VERSION } from './Version.ts'

mantix.pipe(
  Command.run({ version: MANTIX_VERSION }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)
