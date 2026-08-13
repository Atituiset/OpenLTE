# 第 2 章 LTE 网络与协议栈入门

上一章你已经把仓库跑起来（或至少知道它由哪些可执行程序组成）。这一章不谈具体编码细节，只做一件事：**给你一套坐标系**。读完之后，你在仓库里随便点开一个 `.cc` 文件，都应该能回答两个问题——"这是协议栈里的哪一层？""它扮演 LTE 网络里的哪个角色？"

LTE 的协议文档浩如烟海，但它的分层思想你其实早就见过：它和 TCP/IP 一样是"每层只干一件事、对上提供统一接口"的老套路。下面我们先看网络里有谁，再看栈怎么分层，最后把两者钉到这个仓库的文件上。

## 2.1 网络角色：UE、eNodeB、EPC

一个 LTE 网络系统里有三大类角色：

```
+--------+     Uu(无线)     +---------+      S1       +-----------------+
|   UE   | <-------------> | eNodeB  | <-----------> |      EPC        |
| (手机) |                  | (基站)  |               | MME/S-GW/P-GW   |
+--------+                  +---------+               +-----------------+
                                                             | S6a
                                                             v
                                                          +-----+
                                                          | HSS |
                                                          +-----+
```

- **UE（User Equipment）**：用户设备，就是手机或物联网模组，里面插着 USIM 卡。你熟悉的"客户端"。
- **eNodeB（evolved NodeB）**：基站。所有跟"无线"沾边的事都归它：发射/接收无线电波形、每毫秒调度空口资源、加解密、维护无线连接状态。你熟悉的"接入点 + 网卡驱动 + 部分协议栈"的合体。
- **EPC（Evolved Packet Core）**：核心网，基站背后的机房。内部分工：
  - **MME（Mobility Management Entity）**：控制面的大脑。管鉴权、附着（Attach）、移动性。它不碰用户数据。
  - **S-GW（Serving Gateway）/ P-GW（PDN Gateway）**：用户面的水管。UE 的 IP 包从 S-GW 流到 P-GW，再从 P-GW 出公网。P-GW 就是那个给 UE 分 IP 地址的"路由器出口"。
  - **HSS（Home Subscriber Server）**：用户数据库。存着每个合法用户的 IMSI、根密钥 K、算法选择。鉴权向量（RAND/AUTN/XRES/KASME）由它算出。
- 接口名先混个脸熟：**Uu** = UE↔eNodeB 的空中接口；**S1** = eNodeB↔EPC；**S6a** = MME↔HSS。

### OpenLTE 的"全家桶"简化

真实网络里 MME、S-GW、P-GW、HSS 是不同机房里的不同设备，之间跑 S1AP、GTP-U、Diameter 这些协议。OpenLTE 做实验用，**把 eNodeB 和整个 EPC 塞进了同一个进程 `LTE_fdd_enodeb`**。跨网元的接口全部省掉，换成进程内的函数调用和消息队列。

证据就在进程入口和装配代码里：

```cpp
// LTE_fdd_enodeb/src/LTE_fdd_enb_main.cc:63-68
LTE_fdd_enb_interface *interface = LTE_fdd_enb_interface::get_instance();
...
interface->start_ports();
```

```cpp
// LTE_fdd_enodeb/src/LTE_fdd_enb_interface.cc:1007-1009
pdcp = new LTE_fdd_enb_pdcp();
mme  = new LTE_fdd_enb_mme();
gw   = new LTE_fdd_enb_gw();
```

`main` 只是拉起一个 `LTE_fdd_enb_interface` 单例，真正的装配在 interface 里：PDCP、MME、GW 都是同一个进程里的对象。各网元对应的源文件：

| 真实网络角色 | OpenLTE 里的实现 | 说明 |
|---|---|---|
| eNodeB 各层 | `LTE_fdd_enb_phy/mac/rlc/pdcp/rrc.cc` | 无线协议栈本体 |
| MME | `LTE_fdd_enodeb/hdr/LTE_fdd_enb_mme.h:77`（类 `LTE_fdd_enb_mme`） | 附着、鉴权、承载建立的信令状态机 |
| HSS | `LTE_fdd_enodeb/hdr/LTE_fdd_enb_hss.h:93`（类 `LTE_fdd_enb_hss`） | 存用户 IMSI/K，`generate_security_data`（同文件 :108）算鉴权向量 |
| S-GW + P-GW | `LTE_fdd_enodeb/hdr/LTE_fdd_enb_gw.h:64`（类 `LTE_fdd_enb_gw`） | 通过 Linux TUN 设备（`tun_fd`，同文件 :95）收发 UE 的 IP 包 |

看懂这张表，你就不会疑惑"为什么基站的代码里有个 MME"——在这个仓库里，"基站进程"其实是"整个 LTE 网络 minus 手机"。

## 2.2 控制面 vs 用户面

LTE 的空中接口同时跑两套流量，一句话区分：

> **控制面是"管连接本身的信令"（谁上线、密钥是什么、给多少资源）；用户面是"真正要传的 IP 数据"。**

类比一台跑着 SSH 和 HTTP 的服务器：底下的网卡和 IP 栈是共用的，但上面一个是管理通道、一个是业务流量。LTE 也一样——两套流量在 PDCP/RLC/MAC/PHY 四层共用同一条管道（靠逻辑信道区分），**只有顶层不同**：

- 控制面顶层是 **NAS**，UE 直接和 MME 对话，eNodeB 对 NAS 消息不解码、只透传（相当于帮 UE 和 MME 之间转发信封，不拆信）。
- 用户面顶层就是普通的 IP 包。

## 2.3 协议栈分层：从波形到信令

这一节是全章的主干。LTE 空口协议栈从下到上是 **PHY → MAC → RLC → PDCP → RRC**，RRC 之上再"搭"一层端到端的 NAS。每层先说人话，再给代码锚点。

```
上行接收方向 ↑                      下行发送方向 ↓
NAS (MME)      ← RRC 透传 →        liblte_mme.cc
RRC            连接管理/系统广播      liblte_rrc.cc
PDCP           加密/完整性/头压缩     LTE_fdd_enb_pdcp.cc
RLC            分段/重组/ARQ         liblte_rlc.cc
MAC            调度/HARQ/复用        liblte_mac.cc
PHY            波形 ⇄ 比特           liblte_phy.cc
```

仓库的结构很工整：**`liblte/` 是协议编解码库**（纯 C 函数，pack/unpack，相当于"序列化层"），**`LTE_fdd_enodeb/` 是各层子系统**（C++ 类，带线程、消息队列和状态机，相当于"业务逻辑层"）。每层都成对出现，下面按此格式逐层介绍。

### PHY（物理层）：波形 ⇄ 比特的 codec

- **接收什么 / 产出什么**：下行把 MAC 层给的传输块编码、调制成 IQ 采样送 SDR；上行把 SDR 采到的波形解调成字节流还给 MAC。
- **上下层**：上接 MAC，下接射频前端（SDR）。
- **类比**：网卡的 PHY 芯片 + DSP 固件——上层只见以太网帧，这里上层只见 MAC PDU。
- **代码**：编解码库 `liblte/src/liblte_phy.cc`（约 1.4 万行，Turbo 编解码、OFDM、同步全在这里），入口如 `liblte_phy_init`（`liblte/hdr/liblte_phy.h:606`）、PDSCH 信道编码 `liblte_phy_pdsch_channel_encode`（`liblte/hdr/liblte_phy.h:888`）；子系统是类 `LTE_fdd_enb_phy`（`LTE_fdd_enodeb/hdr/LTE_fdd_enb_phy.h:76`），按 1 ms 一拍的 TTI 节拍驱动这些 codec。
- 本章和本书都不深入 PHY，你只要记住"它是字节流与波形之间的转换器"。

### MAC（媒体访问控制层）：每 1 ms 一拍的调度器

- **职责**：调度（这 1 ms 的空口资源分给哪个 UE）、HARQ 混合自动重传、把多条逻辑信道的数据复用进一个 MAC PDU、随机接入（PRACH/RAR）。
- **类比**：一个硬实时的链路层调度器 + 组包器。TTI = 1 ms 是它的死线，每毫秒必须出调度决定。
- **代码**：PDU 组包/解包入口 `liblte_mac_pack_mac_pdu` / `liblte_mac_unpack_mac_pdu`（`liblte/hdr/liblte_mac.h:374,376`），随机接入响应 `liblte_mac_pack_random_access_response_pdu`（`liblte/hdr/liblte_mac.h:455`）；子系统是类 `LTE_fdd_enb_mac`（`LTE_fdd_enodeb/hdr/LTE_fdd_enb_mac.h:102`）。

### RLC（无线链路控制层）：分段与重传

- **职责**：把上层的大 SDU 切成 MAC 调度允许的 PDU 大小（分段/重组），AM 模式下负责确认与重传（ARQ）。
- **三种模式**，类比直接拉满：
  - **TM（Transparent）**：透传 ≈ 直连，用于广播（MIB/SIB 走它）。
  - **UM（Unacknowledged）**：分段重组但不确认 ≈ UDP。
  - **AM（Acknowledged）**：分段重组 + 确认重传 ≈ TCP，信令和大多数数据走它。
- **代码**：`liblte_rlc_pack_amd_pdu`（`liblte/hdr/liblte_rlc.h:308`）、`liblte_rlc_unpack_umd_pdu`（`liblte/hdr/liblte_rlc.h:278`）；子系统是类 `LTE_fdd_enb_rlc`（`LTE_fdd_enodeb/hdr/LTE_fdd_enb_rlc.h:69`）。

### PDCP（分组数据汇聚层）：LTE 的"TLS 层"

- **职责**：加密（EEA 算法）、完整性保护（EIA 算法，仅信令）、头压缩（ROHC，OpenLTE 未实现）、顺序交付。一句话：**从这层往上（RRC/NAS/IP）全是明文，从这层往下全是密文**。
- **代码**：数据 PDU 组包 `liblte_pdcp_pack_data_pdu_with_long_sn`（`liblte/hdr/liblte_pdcp.h:170`）；加解密与完整性算法本体在 `liblte/src/liblte_security.cc`；子系统是类 `LTE_fdd_enb_pdcp`（`LTE_fdd_enodeb/hdr/LTE_fdd_enb_pdcp.h:67`）。注意它的 `start` 签名（同文件 :75）同时挂着 RLC、RRC、GW 六个消息队列——这正是"PDCP 是控制面和用户面交汇点"在代码里的样子。

### RRC（无线资源控制层）：无线连接的大管家

- **职责**：广播系统信息（MIB/SIB）、寻呼、RRC 连接的建立/重配/释放、替上层配置下四层（密钥、承载、定时器）、透传 NAS。
- **类比**：一台 PC 和路由器之间的连接管理状态机。它只有两个大状态：`RRC_IDLE`（没连上，只能听广播）和 `RRC_CONNECTED`（有专用资源，才能跑 NAS 和数据）。
- **代码**：RRC 消息按逻辑信道分类打包，入口函数成对出现：

```cpp
// liblte/hdr/liblte_rrc.h:6604-6607  MIB 走 BCH
LIBLTE_ERROR_ENUM liblte_rrc_pack_bcch_bch_msg(LIBLTE_RRC_MIB_STRUCT *mib,
                                               LIBLTE_BIT_MSG_STRUCT *msg);
LIBLTE_ERROR_ENUM liblte_rrc_unpack_bcch_bch_msg(LIBLTE_BIT_MSG_STRUCT *msg,
                                                 LIBLTE_RRC_MIB_STRUCT *mib);
```

  SIB 走 DL-SCH（`liblte_rrc_pack_bcch_dlsch_msg`，`liblte/hdr/liblte_rrc.h:6623`），专用信令走 DCCH（`liblte_rrc_pack_ul_dcch_msg`，`liblte/hdr/liblte_rrc.h:6865`）。子系统是类 `LTE_fdd_enb_rrc`（`LTE_fdd_enodeb/hdr/LTE_fdd_enb_rrc.h:80`）。
- 看个具体例子感受一下"结构体 ⇄ 比特流"。MIB 的结构体定义只有三个字段：

```cpp
// liblte/hdr/liblte_rrc.h:6598-6602
typedef struct{
    LIBLTE_RRC_PHICH_CONFIG_STRUCT phich_config;  // PHICH 信道配置
    LIBLTE_RRC_DL_BANDWIDTH_ENUM   dl_bw;         // 下行带宽
    uint8                          sfn_div_4;     // 系统帧号 SFN 的高 8 位
}LIBLTE_RRC_MIB_STRUCT;
```

  它在空口上的编码布局（3GPP 36.331，MasterInformationBlock）：

| 字段 | 比特宽度 | 含义 |
|---|---|---|
| dl-Bandwidth | 3 bit | 下行带宽档位（1.4/3/5/10/15/20 MHz） |
| phich-Config | 3 bit | PHICH 时长 1 bit + 资源 2 bit |
| systemFrameNumber | 8 bit | SFN 的高 8 位（低 2 位由 PBCH 发送时刻隐含） |
| spare | 10 bit | 保留 |
| 合计 | 24 bit | 固定在 PBCH 上每 40 ms 重复广播 |

  这就是 LTE 里最小的广播信息：UE 同步后第一件事就是解出这 24 bit，知道自己所在小区的带宽和帧号。后面的章节会带你从 `liblte_rrc_pack_bcch_bch_msg` 一路读到比特。

### NAS（非接入层）：UE 和 MME 的端到端信令

- **职责**：附着/分离、鉴权、安全模式、跟踪区更新、EPS 承载建立。规范是 3GPP 24.301。
- **关键特征**：NAS 的对话双方是 **UE 和 MME**，eNodeB 只是透传——前面说过"不拆信的邮差"。这就是为什么 RRC 消息里会有 `dedicatedInfoNAS` 这种"信封里套信封"的字段。
- **类比**：RRC 是"我和路由器的 PPPoE 会话"，NAS 是"我和运营商认证服务器的 802.1X 对话"。
- **代码**：编解码在 `liblte/src/liblte_mme.cc`，消息头解析入口 `liblte_mme_parse_msg_header`（`liblte/hdr/liblte_mme.h:2675`），Attach Request 的组包/解包 `liblte_mme_pack_attach_request_msg`（`liblte/hdr/liblte_mme.h:2855`）；MME 侧的状态机是类 `LTE_fdd_enb_mme`（`LTE_fdd_enodeb/hdr/LTE_fdd_enb_mme.h:77`），看它的私有方法列表（`parse_attach_request`、`attach_sm`、`send_authentication_request`，同文件 :108-133）就能直接读出附着流程长什么样。

## 2.4 用 TCP/IP 栈做整体类比

| LTE 空口栈 | 你熟悉的对应物 | 对应理由 |
|---|---|---|
| PHY | 网卡 PHY + DSP | 字节流 ⇄ 物理信号 |
| MAC | 链路层调度器（如 802.11 的 CSMA/调度） | 谁什么时候占用介质、MAC 帧组装 |
| RLC-AM | TCP | 分段、确认、重传 |
| RLC-UM | UDP | 尽力交付 |
| PDCP | TLS record 层 | 加密 + 完整性，上明下密 |
| RRC | PPPoE/连接管理状态机 | 建连、配参、拆连 |
| NAS | 认证协议（802.1X/EAP） | 端到端身份与密钥协商，中间节点透传 |
| SRB/DRB（下节） | 同一 TCP 连接上的不同通道 / 多路复用 | 信令与数据分流 |

这张表不是精确对应（LTE 各层的边界和 IP 栈并不重合），但足以让你在初见代码时有个抓手。

## 2.5 无线电承载：SRB 与 DRB

最后补一个贯穿全栈的概念。RRC 配置下层时，不是一句"给这个 UE 开条通道"，而是建一个个 **Radio Bearer（无线承载）**——每个承载 = 一套 PDCP 配置 + 一套 RLC 配置 + 一条逻辑信道的组合，信令用的叫 SRB，数据用的叫 DRB：

| 承载 | RLC 模式 | 用途 |
|---|---|---|
| SRB0 | TM | CCCH 上的公共信令：RRCConnectionRequest/Setup（建连初期，还没有专用配置） |
| SRB1 | AM | 专用 RRC 信令 + 早期的 NAS 透传 |
| SRB2 | AM | NAS 透传专用（安全激活后才建） |
| DRB1/2 | AM/UM | 用户面 IP 数据 |

OpenLTE 把"承载"直接建模成一个类 `LTE_fdd_enb_rb`（`LTE_fdd_enodeb/hdr/LTE_fdd_enb_rb.h:195`），承载枚举写得很直白：

```cpp
// LTE_fdd_enodeb/hdr/LTE_fdd_enb_rb.h:85-91
typedef enum{
    LTE_FDD_ENB_RB_SRB0 = 0,
    LTE_FDD_ENB_RB_SRB1,
    LTE_FDD_ENB_RB_SRB2,
    LTE_FDD_ENB_RB_DRB1,
    LTE_FDD_ENB_RB_DRB2,
    LTE_FDD_ENB_RB_N_ITEMS,
```

每个 rb 对象内部挂着 PDCP/RLC 的配置和 PDU/SDU 队列（如同文件 :240-248 的 `queue_pdcp_pdu`、`get_next_pdcp_sdu` 等）。后面读 RRC 建连流程时你会反复看到"为某 UE 新建 SRB1 → SRB2 → DRB1"的调用顺序——那就是 36.331 标准流程在代码里的投影。

## 小结

- LTE 网络三大角色：**UE、eNodeB、EPC（MME/S-GW/P-GW/HSS）**；OpenLTE 把 eNodeB 和整个 EPC 塞进 `LTE_fdd_enodeb` 一个进程（`LTE_fdd_enb_interface.cc:1007-1009`），MME、HSS、GW 各有对应类。
- **控制面**管连接（顶层 NAS），**用户面**管数据（顶层 IP），两者在 PDCP/RLC/MAC/PHY 共用管道。
- 空口栈自下而上 **PHY→MAC→RLC→PDCP→RRC+NAS**；仓库里 `liblte/` 是 pack/unpack 编解码库，`LTE_fdd_enodeb/` 是带状态机的层子系统，每层成对出现。
- 用你熟悉的栈类比：PHY≈网卡，MAC≈链路层调度，RLC-AM≈TCP，PDCP≈TLS，RRC≈连接管理状态机，NAS≈EAP 认证。
- **SRB0/1/2 传信令、DRB 传数据**，代码里统一建模为 `LTE_fdd_enb_rb`（`LTE_fdd_enodeb/hdr/LTE_fdd_enb_rb.h:85-91,195`）。

下一章我们从最上层往下钻，看 RRC 消息的 ASN.1 PER 编码——也就是 `liblte_rrc.cc` 里那些把结构体压成比特流的函数到底是怎么写的。
