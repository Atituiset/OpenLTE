# 05 eNodeB 状态机与调用流

> 第 03、04 篇讲了"消息怎么编码"。这一篇讲"消息怎么串起来"——把附着流程从 UE 开机到 IP 通的全过程画出来，并指出 OpenLTE 源码里每一步对应在哪。
>
> **核心抓手**：`LTE_fdd_enb_rb.h`（状态枚举）+ `LTE_fdd_enb_rrc.cc`（RRC 状态机）+ `LTE_fdd_enb_mme.cc`（EMM 状态机）。

---

## 1. 两个状态机的"户口本"

OpenLTE 把 RRC 和 EMM 两个状态机绑在 **每个 UE 的 Radio Bearer 对象** 上。打开 `LTE_fdd_enodeb/hdr/LTE_fdd_enb_rb.h`：

### 1.1 RRC 状态机（`rb.h:152-158`）

```c
typedef enum {
    LTE_FDD_ENB_RRC_STATE_IDLE = 0,
    LTE_FDD_ENB_RRC_STATE_SRB1_SETUP,
    LTE_FDD_ENB_RRC_STATE_WAIT_FOR_CON_SETUP_COMPLETE,
    LTE_FDD_ENB_RRC_STATE_RRC_CONNECTED,
    LTE_FDD_ENB_RRC_STATE_WAIT_FOR_CON_REEST_COMPLETE,
    LTE_FDD_ENB_RRC_STATE_N_ITEMS,
} LTE_FDD_ENB_RRC_STATE_ENUM;
```

含义：
| 状态 | 物理含义 |
|---|---|
| `IDLE` | UE 还没建立 RRC 连接（或刚被释放） |
| `SRB1_SETUP` | eNodeB 已为 UE 配置好 SRB1，等待发出 RRCConnectionSetup |
| `WAIT_FOR_CON_SETUP_COMPLETE` | RRCConnectionSetup 已发，等 UE 回 SetupComplete |
| `RRC_CONNECTED` | RRC 连接已建好，可以收发 NAS / DRB |
| `WAIT_FOR_CON_REEST_COMPLETE` | 重建（reestablishment）流程的等待状态 |

**类比**：和 TCP 状态机像极了——`IDLE` ≈ `LISTEN` / `CLOSED`；`SRB1_SETUP` + `WAIT_FOR_CON_SETUP_COMPLETE` ≈ `SYN_RCVD`；`RRC_CONNECTED` ≈ `ESTABLISHED`。

### 1.2 EMM 状态机（`rb.h:111-126`）

```c
typedef enum {
    LTE_FDD_ENB_MME_STATE_IDLE = 0,
    LTE_FDD_ENB_MME_STATE_ID_REQUEST_IMSI,
    LTE_FDD_ENB_MME_STATE_REJECT,
    LTE_FDD_ENB_MME_STATE_AUTHENTICATE,
    LTE_FDD_ENB_MME_STATE_AUTH_REJECTED,
    LTE_FDD_ENB_MME_STATE_ENABLE_SECURITY,
    LTE_FDD_ENB_MME_STATE_RELEASE,
    LTE_FDD_ENB_MME_STATE_RRC_SECURITY,
    LTE_FDD_ENB_MME_STATE_ESM_INFO_TRANSFER,
    LTE_FDD_ENB_MME_STATE_ATTACH_ACCEPT,
    LTE_FDD_ENB_MME_STATE_ATTACHED,
    LTE_FDD_ENB_MME_STATE_SETUP_DRB,
    LTE_FDD_ENB_MME_STATE_SEND_DETACH_ACCEPT,
    LTE_FDD_ENB_MME_STATE_N_ITEMS,
} LTE_FDD_ENB_MME_STATE_ENUM;
```

含义：
| 状态 | 物理含义 |
|---|---|
| `IDLE` | 还没收到 Attach Request（或刚 detach） |
| `ID_REQUEST_IMSI` | 等 UE 回 Identity Response 给出 IMSI（如果 Attach 时给的是 GUTI 而 MME 不认得） |
| `AUTHENTICATE` | 已发 Authentication Request，等 Authentication Response |
| `ENABLE_SECURITY` | 鉴权通过，准备发 NAS Security Mode Command |
| `RRC_SECURITY` | NAS 安全建好，准备发 RRC Security Mode Command |
| `ESM_INFO_TRANSFER` | 协商 APN / 协议配置（如果 UE 要求） |
| `ATTACH_ACCEPT` | 准备发 Attach Accept |
| `SETUP_DRB` | 等 RRCConnectionReconfigurationComplete + 在 PDCP/RLC/MAC 上把 DRB 拉起来 |
| `ATTACHED` | 附着完成，UE 可以上网 |

源码里 `set_mme_state(...)` / `set_rrc_state(...)` 是状态切换的入口（`rb.h:218-235`）。每次切都伴随一段日志，在 `LTE_fdd_enb_mme.cc` 和 `LTE_fdd_enb_rrc.cc` 里大量出现。

## 2. 一张图看完整 Attach 流程

下面这张时序图把 03/04 篇的消息和上面两个状态机串到一起。**这是本系列文档最重要的一张图**——把这张图能复述出来，意味着你已经把 OpenLTE 看懂了 70%。

```
UE                                  eNodeB                      MME              HSS
                                    (LTE_fdd_enodeb 进程内)
 │                                   │                           │                │
 │── PRACH (随机接入) ──────────────>│                           │                │
 │<── RAR (随机接入响应) ────────────│                           │                │
 │                                   │                                            │
 │── RRCConnectionRequest (UL-CCCH)─>│  RRC: IDLE                                 │
 │                                   │  → liblte_rrc_unpack_rrc_connection_request
 │                                   │  → set_rrc_state(SRB1_SETUP)               │
 │<── RRCConnectionSetup (DL-CCCH)──│  → set_rrc_state(WAIT_FOR_CON_SETUP_COMPLETE)
 │                                   │                                            │
 │── RRCConnectionSetupComplete +    │                                            │
 │   {NAS: AttachRequest +           │                                            │
 │    PDNConnectivityRequest} ──────>│  → set_rrc_state(RRC_CONNECTED)            │
 │                                   │  → 把 NAS 转给 mme.cc                       │
 │                                   │                          MME: IDLE        │
 │                                   │                          → handle Attach  │
 │                                   │                          → 查 IMSI ── HSS ─>│
 │                                   │                          <── 鉴权向量 ─────│
 │                                   │                          → set_mme_state(AUTHENTICATE)
 │<── DLInfoTransfer{AuthRequest} ──│<── AuthRequest                              │
 │                                   │                                            │
 │── ULInfoTransfer{AuthResponse} ──>│── AuthResponse → MME 校验 RES               │
 │                                   │                          → set_mme_state(ENABLE_SECURITY)
 │<── DLInfoTransfer{SecModeCmd} ───│<── NAS SecurityModeCommand                  │
 │                                   │                                            │
 │── ULInfoTransfer{SecModeComp} ──>│── NAS SecurityModeComplete                  │
 │                                   │                          → set_mme_state(RRC_SECURITY)
 │                                   │                                            │
 │<── DCCH: SecurityModeCommand ────│  (RRC 层的安全启用)                         │
 │── DCCH: SecurityModeComplete ───>│                                            │
 │                                   │                                            │
 │   (如果需要)                      │                          → set_mme_state(ESM_INFO_TRANSFER)
 │<── DLInfoTransfer{ESMInfoReq} ───│<── ESM Information Request                  │
 │── ULInfoTransfer{ESMInfoResp} ──>│── ESM Information Response                  │
 │                                   │                          → set_mme_state(ATTACH_ACCEPT)
 │                                   │                                            │
 │<── RRCConnectionReconfiguration  │  (内含 NAS AttachAccept + DRB 配置)          │
 │── RRCConnectionReconfigComplete ─>│  → set_mme_state(SETUP_DRB)                │
 │                                   │  → set_mme_state(ATTACHED)                 │
 │── ULInfoTransfer{AttachComplete}─>│  (NAS 完成确认)                              │
 │                                   │                                            │
 │  ============= UE 已就绪，可以收发 IP =============                              │
 │                                   │                                            │
 │── User-plane IP 包 (PDCP/RLC/MAC/PHY) ──> LTE_fdd_enb_gw.cc → Linux TUN → 互联网│
```

> 把这张图与 §1 两个状态机对照看，能精准定位每一行代码在干什么。

## 3. 消息分发的代码入口（重点速读）

### 3.1 RRC 上行消息分发：`LTE_fdd_enb_rrc.cc`

`LTE_fdd_enb_rrc.cc:574` 起的 switch 处理上行 CCCH（公共信道）消息：
```c
case LIBLTE_RRC_UL_CCCH_MSG_TYPE_RRC_CON_REQ:        // 行 574
    // 收到 RRCConnectionRequest，准备 SRB1，发 RRCConnectionSetup
case LIBLTE_RRC_UL_CCCH_MSG_TYPE_RRC_CON_REEST_REQ:  // 行 598
    // 重建场景
```

`LTE_fdd_enb_rrc.cc:653-705` 处理上行 DCCH（专用信道）消息：
```c
case LIBLTE_RRC_UL_DCCH_MSG_TYPE_RRC_CON_REEST_COMPLETE:    // 行 653
case LIBLTE_RRC_UL_DCCH_MSG_TYPE_RRC_CON_SETUP_COMPLETE:    // 行 656  → 把内嵌 NAS 转给 mme
case LIBLTE_RRC_UL_DCCH_MSG_TYPE_UL_INFO_TRANSFER:          // 行 670  → 把内嵌 NAS 转给 mme
case LIBLTE_RRC_UL_DCCH_MSG_TYPE_SECURITY_MODE_COMPLETE:    // 行 693
case LIBLTE_RRC_UL_DCCH_MSG_TYPE_RRC_CON_RECONFIG_COMPLETE: // 行 703
case LIBLTE_RRC_UL_DCCH_MSG_TYPE_UE_CAPABILITY_INFO:        // 行 705
```

> **抓手**：要看"基站收到某条 RRC 上行消息会发生什么"，去 `LTE_fdd_enb_rrc.cc` 搜对应的 `LIBLTE_RRC_UL_*_MSG_TYPE_*`。

### 3.2 NAS 消息分发：`LTE_fdd_enb_mme.cc`

`LTE_fdd_enb_mme.cc:201-356` 是一长串 NAS 消息类型 switch（EMM + ESM 都在这）：
```c
case LIBLTE_MME_MSG_TYPE_ATTACH_REQUEST:                    // 行 204
case LIBLTE_MME_MSG_TYPE_AUTHENTICATION_RESPONSE:           // 行 210
case LIBLTE_MME_MSG_TYPE_AUTHENTICATION_FAILURE:            // 行 207
case LIBLTE_MME_MSG_TYPE_SECURITY_MODE_COMPLETE:            // 行 240
case LIBLTE_MME_MSG_TYPE_ATTACH_COMPLETE:                   // 行 201
case LIBLTE_MME_MSG_TYPE_DETACH_REQUEST:                    // 行 213
case LIBLTE_MME_MSG_TYPE_IDENTITY_RESPONSE:                 // 行 237
case LIBLTE_MME_MSG_TYPE_UPLINK_NAS_TRANSPORT:              // 行 263
// 以及一系列 ESM 消息
case LIBLTE_MME_MSG_TYPE_ACTIVATE_DEFAULT_EPS_BEARER_CONTEXT_ACCEPT: // 行 291
case LIBLTE_MME_MSG_TYPE_PDN_CONNECTIVITY_REQUEST:                    // 行 343
case LIBLTE_MME_MSG_TYPE_ESM_INFORMATION_RESPONSE:                    // 行 326
```

**类比**：这就像 Web 服务器的 routing table——按 URL（这里是 `msg_type`）分发到不同的 handler。

### 3.3 EMM 状态机驱动：`LTE_fdd_enb_mme.cc`

文件 1190 行起，有一个**按当前 MME 状态做的 switch**——某些消息会触发"当前状态决定下一步行为"的二级判断：
```c
switch (mme_state) {
    case LTE_FDD_ENB_MME_STATE_ID_REQUEST_IMSI: ...  // 行 1191
    case LTE_FDD_ENB_MME_STATE_AUTHENTICATE:    ...  // 行 1198
    case LTE_FDD_ENB_MME_STATE_ENABLE_SECURITY: ...  // 行 1204
    case LTE_FDD_ENB_MME_STATE_RRC_SECURITY:    ...  // 行 1210
    case LTE_FDD_ENB_MME_STATE_ESM_INFO_TRANSFER:    // 行 1213
    case LTE_FDD_ENB_MME_STATE_ATTACH_ACCEPT:   ...  // 行 1216
    case LTE_FDD_ENB_MME_STATE_ATTACHED:        ...  // 行 1219
    case LTE_FDD_ENB_MME_STATE_RELEASE:         ...  // 行 1239
    case LTE_FDD_ENB_MME_STATE_SETUP_DRB:       ...  // 行 1245
    case LTE_FDD_ENB_MME_STATE_SEND_DETACH_ACCEPT:   // 行 1265
}
```

> **抓手**：要看"MME 处于状态 X 时该做什么动作"，搜 `case LTE_FDD_ENB_MME_STATE_X`。

## 4. 子系统之间的"快递服务"——消息队列

OpenLTE 不用直接函数调用做子系统间通信，而是用**进程内消息队列**：

```
PHY  ──> phy_to_mac_msgq  ──> MAC
MAC  ──> mac_to_rlc_msgq  ──> RLC
RLC  ──> rlc_to_pdcp_msgq ──> PDCP
PDCP ──> pdcp_to_rrc_msgq ──> RRC
RRC  ──> rrc_to_mme_msgq  ──> MME（NAS）
                          \── rrc_to_pdcp_msgq（下行配置）
MME  ──> mme_to_rrc_msgq  ──> RRC
```

封装在 `LTE_fdd_enodeb/src/LTE_fdd_enb_msgq.cc`。每个子系统的构造里都把 `msgq` 接进来，子系统的"主循环"就是一个**等队列消息 → 解 → 处理**的死循环。

为什么要这么写？两个原因：
1. **解耦**：每层只认消息类型 + 数据结构，不依赖别人内部状态。
2. **方便加调试**：把某个 msgq 的吞吐量录下来，等于天生有了一份"层间调用日志"。

类比：**有点像 Kafka topic**，但全在一个进程内。

## 5. 多线程 + Singleton

每个子系统都是一个 Singleton，并自带一个工作线程：

```cpp
// LTE_fdd_enb_main.cc:63-...
LTE_fdd_enb_interface *interface = LTE_fdd_enb_interface::get_instance();
LTE_fdd_enb_cnfg_db   *cnfg_db   = LTE_fdd_enb_cnfg_db::get_instance();
LTE_fdd_enb_hss       *hss       = LTE_fdd_enb_hss::get_instance();
// ... 所有子系统
```

每个 `LTE_fdd_enb_*` 类内部都有一个 `pthread_mutex_t`，保护内部状态。

线程边界一句话：**PHY 跑在自己线程上、MAC 也是、每个上层子系统也都是**。状态共享靠 msgq + mutex 来 dance。

> **类比**：每个子系统都是一个 actor，靠消息队列 talk to 邻居。

## 6. 关键中转站：UE 对象 = "Radio Bearer 容器"

整个 UE 的所有状态都挂在 `LTE_fdd_enb_user`（`LTE_fdd_enb_user.h/cc`）上，user 里持有一个 `LTE_fdd_enb_rb`（每条 SRB/DRB 一个）。

`LTE_fdd_enb_rb.h:326` 起：
```c
LTE_FDD_ENB_MME_STATE_ENUM mme_state;
LTE_FDD_ENB_RRC_STATE_ENUM rrc_state;
```

也就是说：**两个状态机的当前状态，挂在每个 UE 自己的 Radio Bearer 对象上**——多个 UE 互不干扰，每条 RB 各跑各的。

类比：每个 TCP 连接独立维护自己的状态。

## 7. 寻呼（Paging）：被动唤醒的上行

Paging 是网络主动唤醒 IDLE 状态的 UE 的机制。流程：
```
MME 决定要联系一个 IDLE 的 UE
  → 让 RRC 在 PCCH 上发 RRCPaging（按 UE-ID + DRX 周期 计算到正确的子帧）
  → UE 在自己的 DRX 唤醒时刻看 PCCH
  → 如果命中，UE 发起 RRCConnectionRequest（establishmentCause=mt-Access）
  → 之后流程同 Attach 后段（直接进 RRC_CONNECTED + Service Request 类）
```

OpenLTE 中 Paging 实现比较简单，主要在 `LTE_fdd_enb_mme.cc` / `LTE_fdd_enb_rrc.cc`，配合 `liblte_rrc.cc` 的 `pack_pcch_msg` 系列函数。

## 8. 常见异常与日志在哪看

**调试方法**：
1. 启动 `LTE_fdd_enodeb`。
2. 在另一个终端 `telnet 127.0.0.1 30001` —— 这是日志端口。
3. 日志会按"状态切换、消息收发"分行打印，能直观看到每一步流转。

如果你卡住了，先看：
- `Attach Request` 是否到了？— 没到，问 RRC：`RRCConnectionSetupComplete` 来了吗？
- `Authentication Response` 是否符合预期？— 错了，问 HSS：UE 的 K 是不是配错了？(README 里 `add_user` 那条命令)
- `Security Mode Complete` 是否到？— 没到，可能 UE 不支持你选的算法。
- `RRC Reconfiguration` 之后 UE 一直没动？— 可能 DRB 配置错了（带宽 / RB 数对不上）。

## 9. 如何系统地"散步"一遍代码

按下面顺序读，每一步确认你能在脑子里回放出 §2 的一个片段：

1. `LTE_fdd_enb_main.cc` 看 18 个子系统怎么 init。
2. `LTE_fdd_enb_msgq.h` 看消息队列的 API。
3. `LTE_fdd_enb_rrc.cc:574` 起读 RRC 收到 ConReq 之后的处理。
4. `LTE_fdd_enb_rrc.cc:656` 看 ConSetupComplete 怎么把 NAS 转给 mme。
5. `LTE_fdd_enb_mme.cc:204` 看 ATTACH_REQUEST 处理。
6. 顺着调用链找到 `liblte_security.cc` 里的 Milenage（→ 06 篇）。
7. `LTE_fdd_enb_mme.cc:1198` 看状态 = AUTHENTICATE 时收到 AuthResponse 的逻辑。
8. `LTE_fdd_enb_mme.cc:1216` 看 ATTACH_ACCEPT 状态如何驱动 RRCConnectionReconfiguration。
9. `LTE_fdd_enb_pdcp.cc` 看密钥怎么落到 PDCP（→ 06 篇）。

下一篇：`06_安全与鉴权.md` —— 把鉴权与密钥派生展开讲。
