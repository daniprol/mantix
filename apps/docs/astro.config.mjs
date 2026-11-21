import { defineConfig } from 'astro/config'

// The Mantix documentation site: Astro Starlight with a custom theme.
//
// The theme lives in three places, all small:
// - src/styles/theme.css   design tokens (OKLCH paper and ink) mapped onto
//                          Starlight's --sl-* custom properties
// - src/code-themes.mjs    Expressive Code syntax themes that match them
// - src/components/        four component overrides (listed below)
import starlight from '@astrojs/starlight'

import { mantixDark, mantixLight } from './src/code-themes.mjs'

export default defineConfig({
  integrations: [
    starlight({
      title: 'Mantix',
      description:
        'Load tests that tell the truth, written in the TypeScript you already have.',
      favicon: '/favicon.svg',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/daniprol/mantix',
        },
      ],
      customCss: [
        '@fontsource-variable/geist',
        '@fontsource-variable/geist-mono',
        './src/styles/theme.css',
        './src/styles/landing.css',
      ],
      components: {
        // Wordmark with the live dot and a "pre-release" tag.
        SiteTitle: './src/components/SiteTitle.astro',
        // A three-way segmented switch instead of a <select>.
        ThemeSelect: './src/components/ThemeSelect.astro',
        // Left-aligned splash hero with a mono eyebrow line.
        Hero: './src/components/Hero.astro',
        // A quieter pagination row: hairline above, no boxes.
        Pagination: './src/components/Pagination.astro',
      },
      expressiveCode: {
        themes: [mantixDark, mantixLight],
        // Follow Starlight's data-theme attribute, not just the OS setting.
        themeCssSelector: theme =>
          `[data-theme='${theme.name === 'mantix-dark' ? 'dark' : 'light'}']`,
        useStarlightDarkModeSwitch: false,
        styleOverrides: {
          borderRadius: '0',
          borderColor: 'var(--mx-hairline)',
          borderWidth: '1px',
          codeBackground: 'var(--mx-code-bg)',
          codeFontFamily: 'var(--__sl-font-mono)',
          codeFontSize: '0.8125rem',
          codeLineHeight: '1.7',
          codePaddingBlock: '1rem',
          codePaddingInline: '1.25rem',
          uiFontFamily: 'var(--__sl-font)',
          focusBorder: 'var(--mx-accent)',
          scrollbarThumbColor: 'var(--mx-hairline-strong)',
          scrollbarThumbHoverColor: 'var(--mx-ink-3)',
          textMarkers: {
            // `del` marks failed lines in terminal samples: red, as everywhere.
            delBackground: 'var(--mx-danger-wash)',
            delBorderColor: 'var(--mx-danger)',
            delIndicatorColor: 'var(--mx-danger)',
            delIndicatorContent: "''",
            markBackground: 'var(--mx-accent-wash)',
            markBorderColor: 'var(--mx-accent)',
          },
          frames: {
            shadowColor: 'transparent',
            editorBackground: 'var(--mx-code-bg)',
            editorTabBarBackground: 'var(--mx-paper)',
            editorActiveTabBackground: 'var(--mx-code-bg)',
            editorActiveTabForeground: 'var(--mx-ink)',
            editorActiveTabIndicatorTopColor: 'var(--mx-accent)',
            editorActiveTabIndicatorBottomColor: 'transparent',
            editorTabBarBorderBottomColor: 'var(--mx-hairline)',
            editorTabBorderRadius: '0',
            terminalBackground: 'var(--mx-code-bg)',
            terminalTitlebarBackground: 'var(--mx-paper)',
            terminalTitlebarForeground: 'var(--mx-ink-3)',
            terminalTitlebarBorderBottomColor: 'var(--mx-hairline)',
            terminalTitlebarDotsForeground: 'var(--mx-hairline-strong)',
            terminalTitlebarDotsOpacity: '1',
            inlineButtonBackground: 'var(--mx-ink)',
            inlineButtonForeground: 'var(--mx-ink)',
            inlineButtonBorder: 'var(--mx-hairline-strong)',
            tooltipSuccessBackground: 'var(--mx-ink)',
            tooltipSuccessForeground: 'var(--mx-paper)',
          },
        },
      },
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'What is Mantix?', slug: 'start/introduction' },
            { label: 'Quick start', slug: 'start/quick-start' },
            { label: 'Reading the dashboard', slug: 'start/dashboard' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Writing tests', slug: 'guides/writing-tests' },
            { label: 'Validating responses', slug: 'guides/validation' },
            {
              label: 'Setup, mixes and stages',
              slug: 'guides/setup-and-mixes',
            },
            { label: 'Thresholds', slug: 'guides/thresholds' },
            { label: 'Effect scenarios', slug: 'guides/effect' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'Load models', slug: 'concepts/load-models' },
            { label: 'Reading results honestly', slug: 'concepts/results' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'CLI', slug: 'reference/cli' },
            { label: 'Scenario API', slug: 'reference/api' },
          ],
        },
      ],
    }),
  ],
})
