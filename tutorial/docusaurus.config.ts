import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const ORG = 'iaminawe';
const REPO = 'openclaw-to-claude-tutorial';

const config: Config = {
  title: 'Replacing OpenClaw with Claude',
  tagline: 'A migration playbook for Slack-bridge + Paperclip + launchd on macOS',
  favicon: 'img/favicon.ico',

  future: {
    v4: true,
  },

  url: `https://${ORG}.github.io`,
  baseUrl: `/${REPO}/`,

  organizationName: ORG,
  projectName: REPO,
  trailingSlash: false,

  onBrokenLinks: 'warn',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          routeBasePath: '/',
          editUrl: `https://github.com/${ORG}/${REPO}/tree/main/`,
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/social-card.jpg',
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'OpenClaw → Claude',
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'tutorialSidebar',
          position: 'left',
          label: 'Tutorial',
        },
        {
          href: `https://github.com/${ORG}/${REPO}`,
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Tutorial',
          items: [
            {label: 'Overview', to: '/00-overview'},
            {label: 'Architecture', to: '/01-architecture'},
            {label: 'Modernization Plan', to: '/08-modernization'},
          ],
        },
        {
          title: 'External',
          items: [
            {label: 'Claude Code', href: 'https://code.claude.com'},
            {label: 'Claude Agent SDK', href: 'https://github.com/anthropics/claude-agent-sdk-typescript'},
            {label: 'Paperclip', href: 'https://paperclip.ai'},
          ],
        },
        {
          title: 'Source',
          items: [
            {
              label: 'Repository',
              href: `https://github.com/${ORG}/${REPO}`,
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Clawd contributors. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json', 'typescript', 'xml-doc'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
