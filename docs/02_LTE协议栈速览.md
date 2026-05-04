# 02 LTE 协议栈速览

> 这一篇不讲源码，先把 LTE 系统拆开告诉你"谁是谁、谁调用谁"。看完之后再回到代码，你会知道每个 `LTE_fdd_enb_*.cc` 是栈里的哪一层。

---

## 1. 系统级三大角色

```
+----------+        Uu         +-----------+      S1       +-------------+   SGi   +---------+
|    UE    |  <--无线空中接口->|  eNodeB   | <----------> |     EPC     | <-----> | 互联网  |
| (手机)   |                  |  (基站)   |              | MME/SGW/PGW |         |          |
+----------+                  +-----------+              +-------------+         +---------+
                                                              |
                                                              | S6a
                                                              v
                                                          +---------+
                                                          |   HSS   |
                                                          | (鉴权库)|
                                                          +---------+
```

- **UE (User Equipment)**：手机/物联网模组，里面装着 USIM 卡。
- **eNodeB**：基站。负责所有"无线"的活儿——发射 IQ、调度资源、加密 PDCP、跑 RRC。
- **EPC (Evolved Packet Core)**：核心网。
  - **MME**：控制面"大脑"，处理鉴权、附着、移动性。
  - **S-GW / P-GW**：用户面"水管"，UE 的 IP 包从这里转出去。
  - **HSS**：用户库，存所有合法用户的 IMSI / K / 算法选择。
- **接口名字**：`Uu` = UE↔eNodeB；`S1` = eNodeB↔EPC；`SGi` = P-GW↔互联网；`S6a` = MME↔HSS。

> **OpenLTE 的简化版**：MME / S-GW / P-GW / HSS 全部塞进同一个 `LTE_fdd_enodeb` 进程里，跨进程接口（S1-MME / S1-U / S6a）全部省掉，直接函数调用 + 内存消息队列。

## 2. 控制面 vs 用户面

LTE 的协议栈在 UE 和 eNodeB 之间是**两套**——控制面（Control Plane）和用户面（User Plane）。

```
                       UE                                eNodeB                    MME
   控制面（信令）   +-------+                          +-------+                +-------+
                   | NAS   | <----------------------> |       | <===========> | NAS   |
                   +-------+                          | RRC   |     S1-MME    +-------+
                   | RRC   | <---- Uu 上的 SRB ----->  +-------+   (S1AP)
                   +-------+                          | PDCP  |
                   | PDCP  |                          | RLC   |
                   | RLC   |                          | MAC   |
                   | MAC   |                          | PHY   |
                   | PHY   |                          +-------+
                   +-------+

   用户面（IP）    +-------+                          +-------+                S1-U / S5
                   | IP    |                          | GTP-U | <===========> S-GW / P-GW
                   +-------+                          +-------+
                   | PDCP  |                          | PDCP  |
                   | RLC   |                          | RLC   |
                   | MAC   |                          | MAC   |
                   | PHY   |                          | PHY   |
                   +-------+                          +-------+
```

两条道在 PDCP/RLC/MAC/PHY 是共用的（用 **逻辑信道** 区分），但**顶层不一样**：
- **控制面顶层是 NAS** —— UE 直接和 MME 对话（中间 eNodeB 只是无脑透传 NAS）。
- **用户面顶层就是普通 IP 包**。

**类比**：像是一台同时跑控制信令（SSH）和数据流量（HTTP）的设备——下面的 TCP/IP 栈共用，但应用层完全不同。

## 3. 协议栈每一层在做什么

### 3.1 PHY（物理层）—— `liblte_phy.cc` / `LTE_fdd_enb_phy.cc`

**职责**：把比特变成无线波形，再把无线波形变成比特。

输入/输出：
- 上行（UE → eNB）：RF 采样 → IQ 数据 → 解调/解码 → MAC PDU
- 下行（eNB → UE）：MAC PDU → 编码/调制 → IQ 数据 → 发射

子模块：OFDM（下行多址）、SC-FDMA（上行多址）、参考信号、Turbo 编码、CRC、QPSK/16QAM/64QAM 调制 …

**07 篇会浅讲，本系列不深入。** 你只需要知道："物理层是一个把字节流和无线波形互相转换的 codec，对上提供 MAC PDU 接口。"

### 3.2 MAC（媒体访问控制层）—— `liblte_mac.cc` / `LTE_fdd_enb_mac.cc`

**职责**：调度（哪个 UE 在哪个时频资源上发）、HARQ、MAC PDU 复用/解复用、随机接入流程。

类比：一个**链路层调度器**。决定"这一毫秒空中资源给谁用"。

LTE 的最小调度单位叫 **TTI（Transmission Time Interval）= 1 ms**。所以系统是不能停的——每 1ms 必须做出调度决定。

### 3.3 RLC（无线链路控制层）—— `liblte_rlc.cc` / `LTE_fdd_enb_rlc.cc`

**职责**：分段/重组、ARQ 重传。

三种工作模式：
- **TM（Transparent）**：透传，不分段、不确认。用于广播信道（BCCH）。
- **UM（Unacknowledged）**：分段+重组，不确认。用于实时业务（VoIP）。
- **AM（Acknowledged）**：分段+重组+确认+重传。用于信令和大多数数据。

类比：UM ≈ UDP；AM ≈ TCP；TM ≈ 直连。

### 3.4 PDCP（分组数据汇聚协议层）—— `LTE_fdd_enb_pdcp.cc`

**职责**：
1. **加密**（用 EEA0/1/2 算法）
2. **完整性保护**（用 EIA0/1/2 算法，仅信令）
3. **头压缩**（ROHC，OpenLTE 没实现）
4. **顺序交付与重复检测**

类比：**这一层就是 LTE 的"TLS 层"**。所有从这层往上去的内容都是明文（NAS / IP），所有从这层往下去的内容都已经加密。

### 3.5 RRC（无线资源控制层）—— `liblte_rrc.cc` / `LTE_fdd_enb_rrc.cc`

**职责**：管理 UE 与 eNodeB 之间的"无线连接"。
- 广播系统信息（MIB / SIB1 / SIB2 …）
- 寻呼（Paging）
- RRC 连接建立 / 重配置 / 释放
- 配置下层（PDCP/RLC/MAC/PHY）的参数（密钥、承载、定时器、调度策略 …）
- 测量报告 / 切换

**RRC 状态机**只有两个状态：
- `RRC_IDLE`：UE 没和任何 eNodeB 建立专用资源；只能广播听 SIB、被寻呼。
- `RRC_CONNECTED`：UE 与一个 eNodeB 有专用资源；NAS 才能跑。

OpenLTE 进一步细分（见 05 篇），但概念上还是这两个。

类比：RRC = "一台 PC 和路由器之间的 PPPoE 状态机"。

### 3.6 NAS（非接入层）—— `liblte_mme.cc` / `LTE_fdd_enb_mme.cc`

**职责**：UE ↔ MME 的**端到端**信令。eNodeB 不解析 NAS，只透传。

NAS 内部分两部分：
- **EMM (EPS Mobility Management)** —— 24.301 §5：附着 / 分离 / 鉴权 / 安全模式 / 跟踪区更新 / 寻呼响应 …
- **ESM (EPS Session Management)** —— 24.301 §6：默认承载激活 / 专用承载激活 / 承载修改 / 承载释放 …

类比：EMM = "上线 / 鉴权 / 移动跟踪"；ESM = "PDN 拉一条 IP 通道"。

## 4. 信令面"3 层握手"——一句话理解附着流程

UE 开机插卡到能上网，经历这一长串：

```
[ 物理层同步 ]                 PSS/SSS/PBCH（找小区）
[ 读 SIB    ]                 SIB1/SIB2（学小区参数）
[ Random Access ]             MAC 层 PRACH / RAR
[ RRC Connection 建立 ]       RRC: ConReq → ConSetup → ConSetupComplete
[ Attach Request (NAS) ]      把 NAS 消息塞在 RRC Setup Complete 里送上来
[ Authentication ]            NAS: AuthRequest → AuthResponse
[ Security Mode (NAS) ]       NAS: SecModeCmd → SecModeComplete
[ Security Mode (RRC) ]       RRC: SecCmd → SecComplete
[ ESM Information Transfer ]  NAS: 协商 APN / 协议配置
[ Attach Accept + DRB 建立 ]  RRC: ConReconfig → ConReconfigComplete
[ Attach Complete ]           NAS: 完成
                              => 默认承载就绪，UE 可以上网
```

整段流程的代码版会在 05 篇详细讲，配上 OpenLTE 状态机的状态名。

## 5. 一些容易混的术语区分

| 术语 | 含义 |
|---|---|
| **Bearer**（承载） | "一条带 QoS 的虚拟通道"。Default Bearer = 默认承载（附着时建一条）；Dedicated Bearer = 专用承载（语音/特殊业务时再建一条）。 |
| **SRB / DRB** | Signaling Radio Bearer / Data Radio Bearer。Uu 上空中接口的逻辑信道。SRB0/1/2 跑信令，DRB1/2/... 跑用户数据。 |
| **EARFCN** | 频点编号。LTE 的"几兆赫兹"用一个整数代号表示。OpenLTE 默认用 6300（Band 20）。 |
| **PCI** | Physical Cell ID，0~503。同一个频点上不同小区靠它区分。 |
| **EARFCN vs ARFCN** | EARFCN 是 LTE 的；GSM 用 ARFCN，UMTS 用 UARFCN。 |
| **GUTI / S-TMSI** | 临时标识。GUTI 全网唯一，S-TMSI = MME 内 + UE 临时编号。比 IMSI 更隐私。 |
| **K_eNB / KASME** | 密钥层级里的两个关键节点。KASME 是 NAS 的根密钥，K_eNB 是 RRC/PDCP 加密用的根密钥。06 篇详讲。 |

## 6. OpenLTE 是怎么把这些层映射到代码的

| 协议层 | 协议库（编解码） | 子系统（流程/状态） |
|---|---|---|
| PHY | `liblte/src/liblte_phy.cc` | `LTE_fdd_enb_phy.cc` |
| MAC | `liblte/src/liblte_mac.cc` | `LTE_fdd_enb_mac.cc` |
| RLC | `liblte/src/liblte_rlc.cc` | `LTE_fdd_enb_rlc.cc` |
| PDCP | （无独立 .cc，加密/完整性在 `liblte_security.cc`） | `LTE_fdd_enb_pdcp.cc` |
| RRC | `liblte/src/liblte_rrc.cc` ★ | `LTE_fdd_enb_rrc.cc` ★ |
| NAS | `liblte/src/liblte_mme.cc` ★ | `LTE_fdd_enb_mme.cc` ★ |
| 安全 | `liblte/src/liblte_security.cc` | `LTE_fdd_enb_hss.cc`（鉴权向量计算） |
| 用户面 IP | — | `LTE_fdd_enb_gw.cc`（TUN 网关）+ `LTE_fdd_enb_user_mgr.cc` |

带 ★ 的是接下来三篇（03/04/05）的主战场。

## 7. 一张"读哪里看哪里"的速查表

如果你想搞清楚某件事，去看哪个文件：

- "我想知道 SIB1 里有什么字段" → `liblte/hdr/liblte_rrc.h` 找 `LIBLTE_RRC_SYS_INFO_BLOCK_TYPE_1_STRUCT`
- "我想知道 Attach Request 解出来是什么样" → `liblte/hdr/liblte_mme.h` 找 `LIBLTE_MME_ATTACH_REQUEST_MSG_STRUCT`
- "我想知道 eNodeB 收到 RRCConnectionRequest 之后干什么" → `LTE_fdd_enodeb/src/LTE_fdd_enb_rrc.cc`
- "我想知道 eNodeB 收到 Attach Request 之后干什么" → `LTE_fdd_enodeb/src/LTE_fdd_enb_mme.cc`
- "Milenage f1 是怎么算的" → `liblte/src/liblte_security.cc`，搜 `milenage_f1`
- "OpenLTE 是怎么把 IP 包扔进 Linux 的" → `LTE_fdd_enodeb/src/LTE_fdd_enb_gw.cc`

下一篇：`03_RRC与ASN.1_PER.md` —— 第一个重点章。从 1 个比特操作函数走到完整的 MIB / SIB1 / RRCConnectionRequest 编码。
