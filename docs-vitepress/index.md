---
layout: home

hero:
  name: OpenLTE
  text: 源码精读：从入门到进阶
  tagline: 以 OpenLTE（C++ 实现的 3GPP LTE 协议栈）源码为教材——从比特流编码（ASN.1 PER / NAS TLV）到状态机、从 USIM 鉴权到 SDR 收发的完整链路
  actions:
    - theme: brand
      text: 开始阅读
      link: /beginner/01-项目总览与构建运行
    - theme: alt
      text: 源码阅读指南
      link: /beginner/05-源码阅读指南

features:
  - title: 入门级
    details: 不假设任何无线通信背景。LTE 网络与协议栈整体认知、构建运行与抓包实验，以及一套"怎么读这套代码"的方法论。
    link: /beginner/01-项目总览与构建运行
  - title: 进阶级
    details: 逐模块深入源码：ASN.1 uPER 与 RRC 编解码、NAS TLV 编码、eNodeB 状态机与多线程架构、Milenage/KASME 安全体系、MAC/RLC/PDCP 实现、物理层与 SDR 应用。
    link: /advanced/01-ASN1-PER与RRC编解码
---
