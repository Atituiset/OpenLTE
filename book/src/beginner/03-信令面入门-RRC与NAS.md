# 第 3 章 信令面入门：RRC 与 NAS

前两章我们看了仓库结构和协议栈分层。这一章正式开始碰协议本身：LTE 控制面（信令面）上最重要的两个协议——**RRC** 和 **NAS**。

先给你一张地图，免得在后面的消息名词里迷路：

- **RRC（Radio Resource Control，36.331）**：UE 和 eNodeB 之间的协议。管的是"连接"——小区怎么选、无线信道怎么配、什么时候加密。
- **NAS（Non-Access Stratum，24.301）**：UE 和核心网 MME 之间的协议。管的是"身份和业务"——你是谁（IMSI）、是不是合法用户（鉴权）、给你分什么 IP 承载。

一个粗略但有用的类比：RRC 像 TCP，负责把"连接"这条管道架起来；NAS 像跑在这条管道上的 HTTP+OAuth，负责登录、发 token、开通业务。**NAS 消息没有自己的空口通道，它被 RRC 消息当货物一样驮着走**——这一点本章会反复看到。

OpenLTE 里这两个协议的编解码分别在两份头文件里定义：

- RRC：`liblte/hdr/liblte_rrc.h`（6870 行，所有 RRC 消息的结构体和 pack/unpack 函数声明）
- NAS：`liblte/hdr/liblte_mme.h`（4252 行，所有 NAS 消息的结构体和函数声明）

## 一、广播阶段：MIB 和 SIB 是基站的"开门招牌"

UE 一开机，还谁都不认识，它做的第一件事是扫频、同步，然后**被动地听广播**。基站不停循环广播两类系统消息：

- **MIB（Master Information Block）**：每 40 ms 在 PBCH 上播一次，只有 24 个比特。内容是"我是 LTE 小区、下行带宽多少、PHICH 怎么配、当前帧号是多少"。
- **SIB1（System Information Block Type 1）**：内容是"我属于哪些运营商（PLMN）、跟踪区码（TAC）是多少、允不允许接入"。UE 靠它做小区选择——相当于看到招牌上写着运营商名字，决定要不要进这家店。

MIB 的结构体定义在 `liblte/hdr/liblte_rrc.h:6598`：

```c
typedef struct{
    LIBLTE_RRC_PHICH_CONFIG_STRUCT phich_config;  // PHICH 配置
    LIBLTE_RRC_DL_BANDWIDTH_ENUM   dl_bw;         // 下行带宽
    uint8                          sfn_div_4;     // 系统帧号 / 4
}LIBLTE_RRC_MIB_STRUCT;
```

字段布局（3GPP 36.331）：

| 字段 | 比特宽度 | 含义 |
|---|---|---|
| `dl_bw` | 3 bit | 下行带宽枚举：n6/n15/n25/n50/n75/n100 对应 1.4/3/5/10/15/20 MHz |
| `phich_config` | 3 bit | PHICH 时长（1 bit）+ PHICH 资源（2 bit） |
| `sfn_div_4` | 8 bit | 系统帧号 SFN 的高 8 位 |
| spare | 10 bit | 预留，填 0 |

加起来正好 24 bit。它的打包函数 `liblte_rrc_pack_bcch_bch_msg` 在 `liblte/src/liblte_rrc.cc:12966`，你可以看到代码就是把上表逐字段写进比特流，没有任何"类型标签"：

```c
liblte_value_2_bits(mib->dl_bw, &msg_ptr, 3);                    // 行 12976
liblte_rrc_pack_phich_config_ie(&mib->phich_config, &msg_ptr);   // 行 12979
liblte_value_2_bits(mib->sfn_div_4, &msg_ptr, 8);                // 行 12982
liblte_value_2_bits(0, &msg_ptr, 10);                            // 行 12985: spare
```

SIB1 比 MIB 信息量大多了，结构体 `LIBLTE_RRC_SYS_INFO_BLOCK_TYPE_1_STRUCT` 在 `liblte/hdr/liblte_rrc.h:5736`，里面装着 `plmn_id`（运营商列表）、`tracking_area_code`、`cell_barred`（是否禁止接入）、`q_rx_lev_min`（最低接入电平）这些小区选择的依据。对应的打包函数声明在 `liblte/hdr/liblte_rrc.h:5758`，实现在 `liblte/src/liblte_rrc.cc:10758`。

这一阶段 UE 完全是"听众"，没发过一个比特。听懂了 MIB + SIB1，它才知道该往哪儿喊话。

## 二、RRC 连接建立：LTE 版三次握手

UE 决定接入某个小区后，要先把 RRC 连接建起来。三步，和 TCP 三次握手几乎一一对应：

| 步骤 | 消息 | 方向 | 类比 TCP |
|---|---|---|---|
| 1 | RRCConnectionRequest | UE → eNodeB | SYN |
| 2 | RRCConnectionSetup | eNodeB → UE | SYN+ACK |
| 3 | RRCConnectionSetupComplete | UE → eNodeB | ACK |

**第 1 步，RRCConnectionRequest**：UE 自报家门。结构体在 `liblte/hdr/liblte_rrc.h:5976`：

```c
typedef struct{
    LIBLTE_RRC_CON_REQ_UE_ID_UNION     ue_id;       // S-TMSI 或随机数
    LIBLTE_RRC_CON_REQ_UE_ID_TYPE_ENUM ue_id_type;  // 用哪种 ID
    LIBLTE_RRC_CON_REQ_EST_CAUSE_ENUM  cause;       // 建立原因
}LIBLTE_RRC_CONNECTION_REQUEST_STRUCT;
```

- `ue_id`：一个二选一——老用户给 S-TMSI（上次附着时网络发的临时身份证），新用户只能给一个 40 bit 随机数。选哪种由 `ue_id_type` 标记（枚举定义在 `liblte/hdr/liblte_rrc.h:5945`）。
- `cause`：建立原因，比如 `MO_SIGNALLING`（我要发信令）、`MO_DATA`（我要传数据）、`EMERGENCY`（紧急呼叫），枚举在 `liblte/hdr/liblte_rrc.h:5952`。

整条消息只有 64 bit，打包函数在 `liblte/src/liblte_rrc.cc:11596`。

**第 2 步，RRCConnectionSetup**：基站答应接入，并给 UE 配置好 SRB1（Signaling Radio Bearer，信令无线承载——你可以理解为"信令专用的管道配置"）。结构体 `LIBLTE_RRC_CONNECTION_SETUP_STRUCT` 在 `liblte/hdr/liblte_rrc.h:5925`，核心就是一个 `rr_cnfg`（无线资源配置）。

**第 3 步，RRCConnectionSetupComplete**：UE 确认。重点来了——这条消息里**夹带了第一条 NAS 消息**。结构体在 `liblte/hdr/liblte_rrc.h:5902`：

```c
typedef struct{
    LIBLTE_RRC_REGISTERED_MME_STRUCT registered_mme;   // 上次注册的 MME
    LIBLTE_BYTE_MSG_STRUCT           dedicated_info_nas; // ← NAS 消息塞在这
    uint8                            rrc_transaction_id;
    uint8                            selected_plmn_id;
    bool                             registered_mme_present;
}LIBLTE_RRC_CONNECTION_SETUP_COMPLETE_STRUCT;
```

注意 `dedicated_info_nas` 的类型是 `LIBLTE_BYTE_MSG_STRUCT`——一个**字节容器**（定义在 `liblte/hdr/liblte_common.h:76`），而 RRC 自己用的是**比特容器** `LIBLTE_BIT_MSG_STRUCT`（`liblte/hdr/liblte_common.h:71`）。这个类型差异就是两种编码风格在代码里的投影，本章最后会展开。

到这里，"连接"架好了，接下来的戏全是 NAS 的。

## 三、NAS 附着：类比 OAuth 颁 token

附着（Attach）是 UE 向核心网"注册开机"的完整流程。把它类比成 OAuth 很好懂：

| Attach 步骤 | OAuth 类比 |
|---|---|
| Attach Request（报 IMSI） | 用户点"用 XX 登录"，带上身份 |
| Authentication Request/Response（RAND/AUTN 挑战应答） | 输入密码/验证码，证明你是你 |
| Security Mode Command/Complete | 握手完成，切到 HTTPS，后续全加密 |
| Attach Accept（发 GUTI + 建默认承载） | 颁发 token + 开通会话 |

NAS 消息的类型编号在 `liblte/hdr/liblte_mme.h:2619` 起的一整段 `#define` 里，挑本条主线的几条：

```c
#define LIBLTE_MME_MSG_TYPE_ATTACH_REQUEST            0x41  // 行 2619
#define LIBLTE_MME_MSG_TYPE_ATTACH_ACCEPT             0x42  // 行 2620
#define LIBLTE_MME_MSG_TYPE_ATTACH_COMPLETE           0x43  // 行 2621
#define LIBLTE_MME_MSG_TYPE_AUTHENTICATION_REQUEST    0x52  // 行 2633
#define LIBLTE_MME_MSG_TYPE_AUTHENTICATION_RESPONSE   0x53  // 行 2634
#define LIBLTE_MME_MSG_TYPE_SECURITY_MODE_COMMAND     0x5D  // 行 2639
#define LIBLTE_MME_MSG_TYPE_SECURITY_MODE_COMPLETE    0x5E  // 行 2640
```

对应的消息结构体也都在同一个文件里：

- `LIBLTE_MME_ATTACH_REQUEST_MSG_STRUCT`：`liblte/hdr/liblte_mme.h:2819`。里面装着 `eps_mobile_id`（IMSI 或 GUTI）、`ue_network_cap`（UE 支持的加密算法清单）、`esm_msg`（嵌套的一条 ESM PDN Connectivity Request），外加十几个带 `_present` 标志的可选字段——是 NAS 里最复杂的消息。
- `LIBLTE_MME_AUTHENTICATION_REQUEST_MSG_STRUCT`：`liblte/hdr/liblte_mme.h:2914`。极简，只有三样：`nas_ksi`（密钥序号）、`rand[16]`、`autn[16]`——后两个就是网络发给 UE 的"挑战"，UE 用 USIM 卡里的密钥算出应答。
- `LIBLTE_MME_SECURITY_MODE_COMMAND_MSG_STRUCT`：`liblte/hdr/liblte_mme.h:3252`。网络告诉 UE"从这条消息之后，我们改用这套算法加密 + 完整性保护"。
- `LIBLTE_MME_ATTACH_ACCEPT_MSG_STRUCT`：`liblte/hdr/liblte_mme.h:2707`。核心是 `guti`（新发的临时身份，以后不用明着报 IMSI 了）和 `tai_list`（跟踪区列表），还有嵌套的 `esm_msg`（激活默认承载，相当于"给你分 IP"）。

还有一个细节值得现在就知道：每条 NAS 消息的第一个字节同时装着**安全头类型**和**协议鉴别符**，定义在 `liblte/hdr/liblte_mme.h:2611-2618`。鉴权完成前是明文（`PLAIN_NAS`），完成后头字节标记改为"加密 + 完整性保护"——这就是上面"切 HTTPS"在字节层面的体现。

## 四、全景：UE 从开机到能上网

把前面三节串起来，完整时序如下（OpenLTE 的 eNodeB 把 MME/HSS 的角色也模拟在进程内部）：

```
 UE                          eNodeB (OpenLTE 进程)
  │                               │
  │◄══ MIB / SIB1 (广播，一直发) ══│   ① 选小区：听"招牌"
  │                               │
  │── RRCConnectionRequest ──────►│   ② RRC 三次握手
  │◄───── RRCConnectionSetup ─────│     （类比 TCP SYN/SYN+ACK/ACK）
  │── RRCConnectionSetupComplete ►│     内嵌 NAS: Attach Request
  │     {NAS: AttachRequest}      │
  │                               │   ③ 鉴权：挑战-应答
  │◄═ DLInformationTransfer ══════│     （类比 OAuth 验证身份）
  │   {NAS: AuthenticationReq}    │
  │═ ULInformationTransfer ══════►│
  │   {NAS: AuthenticationResp}   │
  │                               │   ④ NAS 安全模式：切"HTTPS"
  │◄═ {NAS: SecurityModeCommand} ═│
  │═ {NAS: SecurityModeComplete} ►│
  │                               │   ⑤ RRC 重配置：建数据承载 DRB
  │◄═ RRCConnectionReconfig ══════│     内嵌 NAS: Attach Accept
  │   {NAS: AttachAccept}         │     （发 GUTI ≈ 颁 token）
  │═ RRCConnectionReconfigCompl ► │
  │═ {NAS: AttachComplete} ══════►│   ⑥ 附着完成确认
  │                               │
  │◄══════ IP 数据包（用户面）════►│   可以上网了
```

注意 `DL/UL Information Transfer` 这两条 RRC 消息：它们是 NAS 的"快递箱"——NAS 消息没有自己的空口通道，在空口上全靠这两条 RRC 消息里的 `dedicated_info_nas` 字段透传，RRC 层只看箱子不拆包裹。

## 五、RRC 和 NAS 的分工

一句话总结：**RRC 管"连接"，NAS 管"身份和业务"**。

| 维度 | RRC（36.331） | NAS（24.301） |
|---|---|---|
| 对端 | UE ↔ eNodeB | UE ↔ MME（核心网） |
| 管什么 | 小区选择、无线承载、空口加密 | 附着、鉴权、身份、IP 承载 |
| 状态机 | IDLE / CONNECTED | Deregistered / Registered |
| 消息载体 | 直接走空口逻辑信道 | 被 RRC 消息透传 |
| 类比 | TCP（连接管理） | HTTP + OAuth（会话与身份） |

在 OpenLTE 里这条分界线非常清晰：`liblte_rrc.cc` 是纯 RRC 编解码，`liblte_mme.cc` 是纯 NAS 编解码，两者只通过 `dedicated_info_nas` 这个字节缓冲区交接。

## 六、预告：两套编码风格

最后留个钩子。RRC 和 NAS 虽然都是"结构体 → 字节流"，但用了两套截然不同的编码：

- **RRC 用 ASN.1 uPER**：比特对齐，没有 tag、没有 length，字段一个挨一个按比特塞进流里。原因一句话：**空口上每个比特都占频谱、耗功率，省到极致是刚需**。所以 MIB 能压到 24 bit，RRCConnectionRequest 只有 64 bit。
- **NAS 用 TLV/IEI**：字节对齐，可选字段前带一字节类型标签（IEI），变长字段带一字节长度。原因一句话：**NAS 的消息体是驮在 RRC 里的，不直接占用"按比特计费"的空口资源**，不必抠到比特级，换取的是好解析、好扩展。

这就是为什么本章前面看到 `dedicated_info_nas` 用字节容器而 RRC 自己用比特容器。两套编码怎么逐字段写、怎么逐字段拆，是**进阶级第 1 章（ASN.1 uPER）**和**第 2 章（NAS TLV）**的主菜。

## 小结

- RRC（36.331）管 UE 与 eNodeB 之间的"连接"，NAS（24.301）管 UE 与 MME 之间的"身份和业务"；NAS 消息由 RRC 消息透传。
- 广播阶段 UE 只听不说：MIB（24 bit，`liblte/hdr/liblte_rrc.h:6598`）给带宽和帧号，SIB1（`liblte/hdr/liblte_rrc.h:5736`）给 PLMN 和接入门槛。
- RRC 连接建立是三条消息（Request / Setup / SetupComplete），类比 TCP 三次握手；第三条里已经夹带了 NAS Attach Request。
- NAS 附着 = Attach Request → Authentication → Security Mode → Attach Accept，类比 OAuth 的验证身份、加密、颁 token；消息类型编号集中在 `liblte/hdr/liblte_mme.h:2619` 起。
- RRC 用比特对齐的 ASN.1 uPER，NAS 用字节对齐的 TLV；容器类型 `LIBLTE_BIT_MSG_STRUCT` / `LIBLTE_BYTE_MSG_STRUCT` 就是这个差异在代码里的投影，细节见进阶级第 1、2 章。
