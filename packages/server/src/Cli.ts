/** The root `mantix` command and its subcommands. */
import { Command } from 'effect/cli'

import { dev } from './DevCommand.ts'
import { run } from './RunCommand.ts'
import { ui } from './UiCommand.ts'

export const mantix = Command.make('mantix').pipe(
  Command.withDescription(
    'Load tests that tell the truth, written in TypeScript',
  ),
  Command.withSubcommands([run, ui, dev]),
)
