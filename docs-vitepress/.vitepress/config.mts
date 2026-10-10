import { defineConfig } from 'vitepress'

const base = '/OpenLTE/'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  lang: 'zh-CN',
  title: 'OpenLTE 源码精读',
  titleTemplate: '从入门到进阶',
  description:
    '以 OpenLTE 源码为教材的 LTE 无线通信系统学习笔记：从 LTE 网络与协议栈入门、信令面 RRC/NAS，到 ASN.1 PER 编解码、eNodeB 状态机、LTE 安全鉴权与物理层 SDR 应用。',

  base,
  lastUpdated: true,
  cleanUrls: true,
  srcExclude: ['README.md'],

  markdown: {
    // shiki 3.x 不再内置 cuda 语法, 用 cpp 高亮兜底
    languageAlias: { cuda: 'cpp', octave: 'matlab' },
  },

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
    ['meta', { name: 'theme-color', content: '#2e7d5b', media: '(prefers-color-scheme: light)' }],
    ['meta', { name: 'theme-color', content: '#18191c', media: '(prefers-color-scheme: dark)' }],
    ['meta', { property: 'og:title', content: 'OpenLTE 源码精读：从入门到进阶' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          '以 OpenLTE 源码为教材的 LTE 无线通信系统学习笔记：LTE 协议栈入门、RRC/NAS 信令、ASN.1 PER 编解码、eNodeB 状态机与 SDR 应用。',
      },
    ],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { name: 'twitter:card', content: 'summary' }],
    // 学习笔记悬浮组件（localStorage），VitePress SPA 路由切换由 theme/index.ts 通知其重挂载
    ['script', { src: `${base}notes.js` }],
  ],

  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    logo: '/favicon.svg',

    nav: [
      { text: '首页', link: '/' },
      { text: '项目总览', link: '/beginner/01-项目总览与构建运行' },
      { text: '动手实验', link: '/beginner/04-动手实验指南' },
      { text: '源码阅读指南', link: '/beginner/05-源码阅读指南' },
    ],

    sidebar: [
      {
        text: '入门级',
        collapsed: false,
        items: [
          { text: '项目总览与构建运行', link: '/beginner/01-项目总览与构建运行' },
          { text: 'LTE 网络与协议栈入门', link: '/beginner/02-LTE网络与协议栈入门' },
          { text: '信令面入门：RRC 与 NAS', link: '/beginner/03-信令面入门-RRC与NAS' },
          { text: '动手实验指南', link: '/beginner/04-动手实验指南' },
          { text: '源码阅读指南', link: '/beginner/05-源码阅读指南' },
        ],
      },
      {
        text: '进阶级',
        collapsed: false,
        items: [
          { text: 'ASN.1 PER 与 RRC 编解码', link: '/advanced/01-ASN1-PER与RRC编解码' },
          { text: 'NAS 协议与 TLV 编码', link: '/advanced/02-NAS协议与TLV编码' },
          { text: 'eNodeB 状态机与多线程架构', link: '/advanced/03-eNodeB状态机与多线程架构' },
          { text: 'LTE 安全与鉴权', link: '/advanced/04-LTE安全与鉴权' },
          { text: 'MAC / RLC / PDCP 实现解析', link: '/advanced/05-MAC-RLC-PDCP实现' },
          { text: '物理层与 SDR 应用', link: '/advanced/06-物理层与SDR应用' },
          { text: '支撑组件与内部库', link: '/advanced/07-支撑组件与内部库' },
        ],
      },
    ],

    outline: {
      level: [2, 3],
      label: '本页大纲',
    },

    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            noResultsText: '无法找到相关结果',
            resetButtonTitle: '清除查询条件',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
          },
        },
      },
    },

    editLink: {
      pattern: 'https://github.com/Atituiset/OpenLTE/edit/master/docs-vitepress/:path',
      text: '在 GitHub 上编辑此页',
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/Atituiset/OpenLTE' }],

    docFooter: { prev: '上一页', next: '下一页' },

    lastUpdated: {
      text: '最后更新于',
      formatOptions: { dateStyle: 'short', timeStyle: 'short' },
    },

    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '菜单',
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    skipToContentLabel: '跳转到内容',

    footer: {
      message: '基于 GPL 许可发布（OpenLTE）',
      copyright: 'Copyright © 2026 OpenLTE 源码精读',
    },
  },
})
