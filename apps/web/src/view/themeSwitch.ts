/**
 * The theme switch at the foot of the sidebar: System, Light, Dark, as
 * three small icons. Icons are inline SVG, drawn with `currentColor`, so
 * they take the button's text colour in either theme.
 */
import type { Html, HtmlBuilder } from 'foldkit/html'

import { Message } from '../message.ts'
import type { Theme } from '../theme.ts'

/** An icon on a 24-unit grid, drawn as 1.75-wide round strokes. */
const icon = (h: HtmlBuilder<Message>, shapes: ReadonlyArray<Html>): Html =>
  h.svg(
    [
      h.ViewBox('0 0 24 24'),
      h.Width('14'),
      h.Height('14'),
      h.Fill('none'),
      h.Stroke('currentColor'),
      h.StrokeWidth('1.75'),
      h.StrokeLinecap('round'),
      h.StrokeLinejoin('round'),
      h.AriaHidden(true),
    ],
    shapes,
  )

const ICONS: Record<Theme, (h: HtmlBuilder<Message>) => Html> = {
  System: h =>
    icon(h, [
      h.rect([h.X('3'), h.Y('4'), h.Width('18'), h.Height('12'), h.Rx('2')]),
      h.path([h.D('M8 20h8M12 16v4')]),
    ]),
  Light: h =>
    icon(h, [
      h.circle([h.Cx('12'), h.Cy('12'), h.R('4')]),
      h.path([
        h.D(
          'M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41',
        ),
      ]),
    ]),
  Dark: h =>
    icon(h, [
      h.path([h.D('M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z')]),
    ]),
}

const THEMES: ReadonlyArray<Theme> = ['System', 'Light', 'Dark']

export const themeSwitch = (current: Theme, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class('inline-flex self-start rounded-md border border-hairline p-0.5'),
      h.Role('group'),
      h.AriaLabel('Theme'),
    ],
    THEMES.map(theme =>
      h.keyed('button')(
        theme,
        [
          h.Type('button'),
          h.AriaLabel(theme),
          h.Title(theme),
          h.AriaPressed(String(theme === current)),
          h.OnClick(Message.SelectedTheme({ theme })),
          h.Class(
            `grid h-6 w-7 place-items-center rounded-[4px] transition-colors duration-150 ease-out ${
              theme === current
                ? 'bg-wash text-ink'
                : 'text-ink-3 hover:text-ink'
            }`,
          ),
        ],
        [ICONS[theme](h)],
      ),
    ),
  )
