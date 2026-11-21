// Syntax themes for Expressive Code, matched to the site's paper and ink.
//
// Deliberately quiet: most code is ink, keywords are slate, strings are a
// muted green, numbers carry the amber accent, comments recede. Colours are
// hex because Expressive Code checks contrast on them; each one was taken
// from an OKLCH value with the same hue as the site tokens.
import { ExpressiveCodeTheme } from '@astrojs/starlight/expressive-code'

/** Build a small VS Code style theme from a handful of roles. */
const make = (name, type, c) =>
  new ExpressiveCodeTheme({
    name,
    type,
    colors: {
      'editor.background': c.bg,
      'editor.foreground': c.ink,
      'editor.selectionBackground': c.selection,
    },
    tokenColors: [
      { settings: { foreground: c.ink } },
      {
        scope: ['comment', 'punctuation.definition.comment'],
        settings: { foreground: c.faint, fontStyle: 'italic' },
      },
      {
        scope: [
          'keyword',
          'storage',
          'storage.type',
          'keyword.operator.new',
          'keyword.control',
          'variable.language',
        ],
        settings: { foreground: c.keyword },
      },
      {
        scope: ['string', 'string.template', 'punctuation.definition.string'],
        settings: { foreground: c.string },
      },
      {
        scope: [
          'constant.numeric',
          'constant.language',
          'support.constant',
          'constant.other',
        ],
        settings: { foreground: c.number },
      },
      {
        scope: [
          'entity.name.function',
          'support.function',
          'meta.function-call',
        ],
        settings: { foreground: c.ink },
      },
      {
        scope: [
          'meta.object-literal.key',
          'variable.other.property',
          'support.type.property-name',
          'variable.other.object.property',
        ],
        settings: { foreground: c.muted },
      },
      {
        scope: ['entity.name.type', 'support.type', 'support.class'],
        settings: { foreground: c.keyword },
      },
      {
        scope: ['punctuation', 'meta.brace', 'keyword.operator'],
        settings: { foreground: c.muted },
      },
      // Shell sessions: commands in ink, flags muted.
      {
        scope: ['entity.name.command', 'support.function.builtin.shell'],
        settings: { foreground: c.ink },
      },
      {
        scope: ['constant.other.option', 'variable.parameter'],
        settings: { foreground: c.muted },
      },
      {
        scope: ['markup.deleted'],
        settings: { foreground: c.danger },
      },
    ],
  })

export const mantixLight = make('mantix-light', 'light', {
  bg: '#f7f5f1',
  ink: '#1e1a16',
  muted: '#59544f',
  faint: '#837f7b',
  keyword: '#496684',
  string: '#526c43',
  number: '#9d5300',
  danger: '#c9302d',
  selection: '#eadfcf',
})

export const mantixDark = make('mantix-dark', 'dark', {
  bg: '#181613',
  ink: '#ebe7e2',
  muted: '#adaaa5',
  faint: '#7d7a75',
  keyword: '#92b1d3',
  string: '#a9c192',
  number: '#f2af48',
  danger: '#ed756e',
  selection: '#3a332a',
})
