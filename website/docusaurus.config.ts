import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'WorldlineBox',
  tagline: '本地优先的数字资产管理器',
  url: 'https://whoiswennie.github.io',
  baseUrl: '/WorldlineBox/',
  organizationName: 'whoiswennie',
  projectName: 'WorldlineBox',

  i18n: {
    defaultLocale: 'zh-CN',
    locales: ['zh-CN', 'en'],
    localeConfigs: {
      'zh-CN': { label: '简体中文', htmlLang: 'zh-CN' },
      en: { label: 'English', htmlLang: 'en' },
    },
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          routeBasePath: 'docs',
          editUrl: 'https://github.com/whoiswennie/WorldlineBox/edit/dev/website',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  markdown: {
    mermaid: true,
  },

  themes: ['@docusaurus/theme-mermaid'],

  themeConfig: {
    image: 'assets/ui/WorldlineBox-Preview.png',
    navbar: {
      title: 'WorldlineBox',
      logo: {
        alt: 'WorldlineBox Logo',
        src: 'assets/ui/WorldlineBox-Logo.png',
        height: 32,
      },
      items: [
        { to: '/docs/intro', label: '文档', position: 'left' },
        { type: 'localeDropdown', position: 'right' },
        {
          href: 'https://github.com/whoiswennie/WorldlineBox',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: '文档',
          items: [
            { label: '使用手册', to: '/docs/intro' },
            { label: '开发者文档', to: '/docs/developer/intro' },
            { label: '扩展作者手册', to: '/docs/manual/intro' },
          ],
        },
        {
          title: '项目',
          items: [
            { label: 'GitHub', href: 'https://github.com/whoiswennie/WorldlineBox' },
            { label: '产品简报', to: '/docs/product-brief' },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} WorldlineBox contributors. MIT License.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
