# eNodeB 状态机与多线程架构

入门级部分我们逐层读了 PHY/MAC/RLC/PDCP 的编解码。这一章换一个视角：把 `LTE_fdd_enodeb` 当作一个普通的并发服务器进程来解剖——它有哪些线程、线程之间怎么通信、控制面（RRC/EMM）的状态机挂在哪个对象上。读完这一章，给你任意一条信令（比如 Attach Request），你应该能自己把它在代码里从比特流一直追到 HSS 再追回来。

本章是全书的枢纽：前面各章讲的"每一层干什么"，在这里被一条消息队列总线串成了"整个进程怎么转"。

## 进程启动：main 里发生了什么

`LTE_fdd_enodeb/src/LTE_fdd_enb_main.cc` 的 `main()` 只有不到 25 行有效代码（`LTE_fdd_enb_main.cc:61-83`）：

```cpp
LTE_fdd_enb_interface *interface = LTE_fdd_enb_interface::get_instance();
LTE_fdd_enb_cnfg_db   *cnfg_db   = LTE_fdd_enb_cnfg_db::get_instance();
LTE_fdd_enb_hss       *hss       = LTE_fdd_enb_hss::get_instance();

interface->set_ctrl_port(LTE_FDD_ENB_DEFAULT_CTRL_PORT);
interface->start_ports();

// Read configuration
hss->read_user_file();
cnfg_db->read_cnfg_file();
```

逐行看（`LTE_fdd_enb_main.cc:63-72`）：

1. 三个 `get_instance()` 拿出全进程最早存在的三个 Singleton：`interface`（对外控制/调试接口）、`cnfg_db`（配置数据库）、`hss`（本地用户数据库）。注意此刻**协议栈一层都还没起来**。
2. `start_ports()` 打开两个 TCP server socket：控制端口和调试端口（`LTE_fdd_enb_interface.cc:234-277`）。你之后 `telnet localhost 30000` 敲的 `start`、`write bandwidth 10` 这些命令，都是进到这个 socket 里的。
3. `hss->read_user_file()`（`LTE_fdd_enb_hss.cc:506`）读用户文件（IMSI/IMEI/K 三元组），`cnfg_db->read_cnfg_file()`（`LTE_fdd_enb_cnfg_db.cc:959`）读配置文件。
4. 最后 `main` 进入 `while(!interface->get_shutdown()) sleep(1);` 的空转循环（`LTE_fdd_enb_main.cc:77-80`）。主线程从此只是个看门人，真正的戏都在别的线程里。

真正的协议栈启动发生在你在控制端口敲下 `start` 命令之后。控制消息由 `handle_ctrl_msg()`（`LTE_fdd_enb_interface.cc:690`）分发到 `handle_start()`（`LTE_fdd_enb_interface.cc:971`），它干了三件大事：

**第一件：创建 13 条消息队列**（`LTE_fdd_enb_interface.cc:992-1004`）。每一对相邻模块之间一条单向队列，名字直白得像管道名：

```cpp
phy_to_mac_comm   = new LTE_fdd_enb_msgq("phy_to_mac");
mac_to_phy_comm   = new LTE_fdd_enb_msgq("mac_to_phy");
mac_to_rlc_comm   = new LTE_fdd_enb_msgq("mac_to_rlc");
mac_to_timer_comm = new LTE_fdd_enb_msgq("mac_to_timer");
rlc_to_mac_comm   = new LTE_fdd_enb_msgq("rlc_to_mac");
rlc_to_pdcp_comm  = new LTE_fdd_enb_msgq("rlc_to_pdcp");
pdcp_to_rlc_comm  = new LTE_fdd_enb_msgq("pdcp_to_rlc");
pdcp_to_rrc_comm  = new LTE_fdd_enb_msgq("pdcp_to_rrc");
rrc_to_pdcp_comm  = new LTE_fdd_enb_msgq("rrc_to_pdcp");
rrc_to_mme_comm   = new LTE_fdd_enb_msgq("rrc_to_mme");
mme_to_rrc_comm   = new LTE_fdd_enb_msgq("mme_to_rrc");
pdcp_to_gw_comm   = new LTE_fdd_enb_msgq("pdcp_to_gw");
gw_to_pdcp_comm   = new LTE_fdd_enb_msgq("gw_to_pdcp");
```

**第二件：构造三个非 Singleton 的模块**——`pdcp`、`mme`、`gw`（`LTE_fdd_enb_interface.cc:1007-1009`），然后 `cnfg_db->construct_sys_info(pdcp, mme)` 把 SIB1/SIB2/... 全部组出来（`LTE_fdd_enb_cnfg_db.cc:426`），并在末尾回调每一层的 `update_sys_info()` 把系统信息推下去（`LTE_fdd_enb_cnfg_db.cc:944-949`）。

**第三件：按自顶向下再到底层的顺序 start 各层**（`LTE_fdd_enb_interface.cc:1015-1028`）：`gw` → `phy` → `mac` → `timer_mgr` → `rlc` → `pdcp` → `rrc` → `mme` → `radio`。每个 `start()` 做的事高度同构，以 RRC 为例（`LTE_fdd_enb_rrc.cc:141-163`）：保存队列指针，然后对两条输入队列各调一次 `attach_rx()`——**每调一次 `attach_rx` 就 `pthread_create` 出一条接收线程**（`LTE_fdd_enb_msgq.cc:121-135`）。所以这个进程的并发模型是：**一条消息队列 = 一条专属消费线程**，模块本身几乎不持有线程（例外是 GW 的 socket 收包线程 `LTE_fdd_enb_gw.cc:184` 和 Radio 的采样线程 `LTE_fdd_enb_radio.cc:1161`）。

模块关系全景图（箭头是消息队列的方向）：

```
                 控制/调试 TCP 端口
                        │
                 ┌──────┴───────┐          ┌──────────┐
                 │  interface   │─────────▶│ cnfg_db  │ (SIB 组包/参数)
                 └──────┬───────┘          └──────────┘
                        │ start                     ┌──────────┐
 ┌────────┐   gw_to_pdcp│                           │   HSS    │ (IMSI/K 数据库)
 │  GW    │◀════════════╪═══════════╗               └─────▲────┘
 │ (IP 出口)│           │           ║        直接查询        │
 └────────┘   pdcp_to_gw│           ║               ┌──────┴───────┐
                        ▼           ║               │     MME      │ EMM 状态机
 ┌─────────────────────────────────╪──────┐        │  (NAS/attach) │
 │ PHY ⇄ MAC ⇄ RLC ⇄ PDCP ⇄ RRC   ║      │        └──────▲───────┘
 └─────────────────────────────────╪──────┘   rrc_to_mme / mme_to_rrc
                        │           ╚═══════════════════════╝
                  mac_to_timer
                        ▼
                  ┌──────────┐
                  │timer_mgr │ (T3xx/t-poll/不活动定时器)
                  └──────────┘
```

你要建立的直觉是：**interface 是总线装配车间，各层是流水线上的工位，msgq 是传送带**。这个模型你其实早就见过——它就是把"分层网络协议栈"硬套在"生产者-消费者线程模型"上。

## 消息队列：msgq 封装与消息类型

### 一条队列的实现

`LTE_fdd_enb_msgq`（`LTE_fdd_enodeb/hdr/LTE_fdd_enb_msgq.h:400-433`）的实现朴素得出乎意料：一个 `boost::circular_buffer`（容量 100，`LTE_fdd_enb_msgq.cc:95`）加两个 POSIX 信号量。发送侧（`LTE_fdd_enb_msgq.cc:140-158`）：

```cpp
msg.type       = type;
msg.dest_layer = dest_layer;
if(msg_content != NULL)
{
    memcpy(&msg.msg, msg_content, msg_content_size);
}

sem_wait(&sync_sem);
circ_buf->push_back(msg);
sem_post(&sync_sem);
sem_post(&msg_sem);
```

- `sync_sem` 保护环形缓冲区的互斥访问；
- `msg_sem` 是"有消息了"的事件信号——接收线程在 `receive_thread()` 里 `sem_wait(&msgq->msg_sem)` 阻塞等待（`LTE_fdd_enb_msgq.cc:207`），被唤醒后清空缓冲区，逐条回调 `msgq->callback(msg)`（`LTE_fdd_enb_msgq.cc:211-226`）。

两个值得注意的细节：

- **收到 `LTE_FDD_ENB_MESSAGE_TYPE_KILL` 就退出线程循环**（`LTE_fdd_enb_msgq.cc:220-222`）。停机时 `handle_stop()` 给全部 13 条队列各发一条 KILL（`LTE_fdd_enb_interface.cc:1085-1136`），这是整个进程的"安全停机"机制。
- 接收线程会把自己的 CPU 亲和性设置为"避开最后一个核"（`LTE_fdd_enb_msgq.cc:199-202`），注释写明最后一个核留给 PHY/Radio——实时信号处理要独占一个核，这是 SDR 系统的常见手法。

### 消息信封：type + dest_layer + union

所有消息共用同一个信封结构（`LTE_fdd_enb_msgq.h:372-376`）：

```cpp
typedef struct{
    LTE_FDD_ENB_MESSAGE_TYPE_ENUM type;
    LTE_FDD_ENB_DEST_LAYER_ENUM   dest_layer;
    LTE_FDD_ENB_MESSAGE_UNION     msg;
}LTE_FDD_ENB_MESSAGE_STRUCT;
```

`dest_layer` 是目的层（PHY/MAC/RLC/PDCP/RRC/MME/GW/TIMER_MGR/ANY，枚举在 `LTE_fdd_enb_msgq.h:150-161`）。每个模块的入口函数第一件事就是检查 `dest_layer`：是自己的就处理，不是自己的就**原样转发给下一个模块**——比如 RRC 的 `handle_pdcp_msg()` 里，dest 不是 RRC 的消息直接 `msgq_to_mme->send(msg)` 转发（`LTE_fdd_enb_rrc.cc:196-199`）。这就是为什么 NAS 消息能"穿过"RRC 到达 MME 而不被 RRC 拆开。

消息类型全集（`LTE_fdd_enb_msgq.h:80-129`），按流向整理：

| 消息类型 | 流向 | 载荷里有什么 |
|---|---|---|
| `KILL` | 任意 | 空；停机信号 |
| `PHY_SCHEDULE` | MAC→PHY | 本 TTI 的 DL/UL 调度结果（PDCCH 分配） |
| `READY_TO_SEND` | PHY→MAC | 当前 TTI，触发 MAC 做调度 |
| `PRACH_DECODE` | PHY→MAC | 检到的 preamble + 定时提前量 |
| `PUCCH_DECODE` | PHY→MAC | ACK/NACK 或 SR |
| `PUSCH_DECODE` | PHY→MAC | 上行比特流 + RNTI |
| `MAC_SDU_READY` | RLC→MAC | （user, rb）指针对 |
| `RLC_PDU_READY` | MAC→RLC | （user, rb）指针对 |
| `TIMER_TICK` | MAC→TIMER_MGR | 1ms 滴答 |
| `RLC_SDU_READY` | PDCP→RLC | （user, rb）指针对 |
| `PDCP_PDU_READY` | RLC→PDCP | （user, rb）指针对 |
| `PDCP_SDU_READY` | RRC→PDCP | （user, rb）指针对 |
| `RRC_PDU_READY` | PDCP→RRC | （user, rb）指针对 |
| `RRC_NAS_MSG_READY` | MME→RRC | （user, rb）；下行 NAS 已入队 |
| `RRC_CMD_READY` | MME→RRC | （user, rb, cmd）；cmd 枚举见下 |
| `MME_NAS_MSG_READY` | RRC→MME | （user, rb）；上行 NAS 已入队 |
| `MME_RRC_CMD_RESP` | RRC→MME | （user, rb, cmd_resp） |
| `PDCP_DATA_SDU_READY` | GW→PDCP | 用户面下行 IP 包 |
| `GW_DATA_READY` | PDCP→GW | 用户面上行 IP 包 |

注意一个贯穿始终的设计惯例：**MAC 以上的 `*_READY` 系列消息本身不带数据，只带 `(user, rb)` 两个指针**（PHY→MAC 的解码消息例外，比特流直接装在消息里）。数据在哪？在 `rb` 对象内部的队列里——发送方先 `rb->queue_rrc_pdu(...)` 把数据塞进 rb，再发消息"通知"对端来取；接收方 `rb->get_next_rrc_pdu(&pdu)` 取出。你熟悉的"队列里传 buffer"在这里变成了"队列里传句柄，buffer 挂在句柄上"。好处是消息定长、memcpy 一次搞定；代价是 user/rb 对象被所有线程共享，靠 rb 内部的信号量保护。

`RRC_CMD_READY` 里的命令枚举（`LTE_fdd_enb_msgq.h:279-285`）是 MME 指挥 RRC 的四条指令：`RELEASE`（释放连接）、`SECURITY`（起 RRC 安全）、`SETUP_DEF_DRB`（建默认承载）、`SETUP_DED_DRB`（建专用承载）。

## RRC 状态机

### 状态枚举

OpenLTE 的 RRC 状态**不是全局的，而是挂在每个 UE 的每条 Radio Bearer（rb）对象上**。枚举定义在 `LTE_fdd_enodeb/hdr/LTE_fdd_enb_rb.h:152-158`：

| 状态 | 含义 | 类比 |
|---|---|---|
| `IDLE` | 尚无 RRC 连接 | TCP 的 CLOSED/LISTEN |
| `SRB1_SETUP` | 已收到 ConnectionRequest，SRB1 建好了 | SYN_RCVD 的前半拍 |
| `WAIT_FOR_CON_SETUP_COMPLETE` | 已发 RRCConnectionSetup，等 UE 回 Complete | SYN_RCVD |
| `RRC_CONNECTED` | RRC 连接建立 | ESTABLISHED |
| `WAIT_FOR_CON_REEST_COMPLETE` | 重建流程中，等 ReestablishmentComplete | 类似 TCP 的重连恢复 |

配套的还有"过程"枚举 `LTE_FDD_ENB_RRC_PROC_ENUM`（`LTE_fdd_enb_rb.h:142-146`）：`IDLE` / `RRC_CON_REQ` / `RRC_CON_REEST_REQ`。"过程 + 状态"两维合起来才是完整的状态机位置——这和你写 Web 服务器时"连接状态 + 当前在处理哪个请求"是同一个套路。

### 两条入口状态机：ccch_sm 与 dcch_sm

RRC 收到 PDU 后按承载分流（`LTE_fdd_enb_rrc.cc:259-267`）：SRB0 走 `ccch_sm()`，SRB1/SRB2 走 `dcch_sm()`。

**`ccch_sm()`（`LTE_fdd_enb_rrc.cc:434-510`）** 处理连接建立。核心迁移在 `LTE_fdd_enb_rrc.cc:448-457`：

```cpp
case LTE_FDD_ENB_RRC_PROC_RRC_CON_REQ:
    switch(loc_rb->get_rrc_state())
    {
    case LTE_FDD_ENB_RRC_STATE_IDLE:
        loc_user->setup_srb1(&srb1);
        if(NULL != srb1)
        {
            loc_rb->set_rrc_state(LTE_FDD_ENB_RRC_STATE_SRB1_SETUP);
            send_rrc_con_setup(loc_user, loc_rb);
            srb1->set_rrc_procedure(LTE_FDD_ENB_RRC_PROC_RRC_CON_REQ);
            srb1->set_rrc_state(LTE_FDD_ENB_RRC_STATE_WAIT_FOR_CON_SETUP_COMPLETE);
```

即：SRB0 上收到 RRCConnectionRequest 且当前 IDLE → 建 SRB1 → SRB0 转 `SRB1_SETUP` → 发 RRCConnectionSetup（`send_rrc_con_setup()`，`LTE_fdd_enb_rrc.cc:1010`，消息字段按 36.331 组包，还会顺便给 UE 配 SR 的 PUCCH 资源，`LTE_fdd_enb_rrc.cc:1043-1045`）→ 新的 SRB1 转入 `WAIT_FOR_CON_SETUP_COMPLETE`。注意状态是**记录在 SRB0 和 SRB1 两条 rb 上**的，接力棒从 SRB0 交到 SRB1。重建请求走对称的另一支（`LTE_fdd_enb_rrc.cc:476-486`），失败则发 ReestablishmentReject。

**`dcch_sm()`（`LTE_fdd_enb_rrc.cc:511-546`）** 处理已建立连接后的消息。它只在 `WAIT_FOR_CON_SETUP_COMPLETE` / `WAIT_FOR_CON_REEST_COMPLETE` / `RRC_CONNECTED` 三个状态下受理消息（`LTE_fdd_enb_rrc.cc:521-526`），然后转给 `parse_ul_dcch_message()`。

真正的状态推进在 **`parse_ul_dcch_message()`（`LTE_fdd_enb_rrc.cc:631-724`）**，关键的三个分支：

- 收到 RRCConnectionSetupComplete：`rb->set_rrc_state(LTE_FDD_ENB_RRC_STATE_RRC_CONNECTED)`（`LTE_fdd_enb_rrc.cc:657`），同时把消息里捎带的 NAS（就是 Attach Request）`queue_mme_nas_msg()` 入队，并发 `MME_NAS_MSG_READY` 给 MME（`LTE_fdd_enb_rrc.cc:660-668`）。**RRC 层到此为止，接力棒交给 MME。**
- 收到 ULInformationTransfer（后续所有上行 NAS 的载体）：同样入队 + 通知 MME（`LTE_fdd_enb_rrc.cc:670-682`）。**RRC 对 NAS 永远只当搬运工，从不拆包**——这就是 36.331 里 dedicatedInfoNAS 字段的"透传"语义。
- 收到 SecurityModeComplete：发 `MME_RRC_CMD_RESP` 告知 MME"你要的 RRC 安全建好了"（`LTE_fdd_enb_rrc.cc:693-701`）。

下行方向，MME 通过两类消息驱动 RRC（`handle_mme_msg()`，`LTE_fdd_enb_rrc.cc:201-227`）：

- `RRC_NAS_MSG_READY` → `handle_nas_msg()`（`LTE_fdd_enb_rrc.cc:294`）→ `send_dl_info_transfer()`（`LTE_fdd_enb_rrc.cc:729`）：把 NAS 包进 DLInformationTransfer，经 `PDCP_SDU_READY` 发给 PDCP。
- `RRC_CMD_READY` → `handle_cmd()`（`LTE_fdd_enb_rrc.cc:322`）：`RELEASE` 发 RRCConnectionRelease（`LTE_fdd_enb_rrc.cc:977`）；`SECURITY` 发 UECapabilityEnquiry + SecurityModeCommand（`LTE_fdd_enb_rrc.cc:343-346`）；`SETUP_DEF_DRB` 建 SRB2+DRB1 后发 RRCConnectionReconfiguration，并把 MME 已入队的 NAS（Attach Accept）捎带进去（`LTE_fdd_enb_rrc.cc:347-370`）。

## EMM 状态机与 MME 模块

MME 模块（`LTE_fdd_enodeb/src/LTE_fdd_enb_mme.cc`）是这个进程里的"迷你核心网"：EMM 状态机、鉴权、IP 分配都在这。它的 EMM 状态同样挂在 rb 上，枚举在 `LTE_fdd_enb_rb.h:112-125`：

| 状态 | 含义 |
|---|---|
| `IDLE` | 初始态 |
| `ID_REQUEST_IMSI` | UE 报的 GUTI 本地不认识，发 Identity Request 要 IMSI |
| `REJECT` | 拒绝（IMSI 不在 HSS / 安全能力不匹配） |
| `AUTHENTICATE` | 发 Authentication Request |
| `AUTH_REJECTED` | 鉴权失败，发 Authentication Reject |
| `ENABLE_SECURITY` | 鉴权通过，发 NAS Security Mode Command |
| `RRC_SECURITY` | NAS 安全完成，命令 RRC 起 AS 安全 |
| `RELEASE` | 命令 RRC 释放连接 |
| `ESM_INFO_TRANSFER` | 可选：向 UE 要 APN/PCO |
| `ATTACH_ACCEPT` | 发 Attach Accept（内含默认承载激活） |
| `SETUP_DRB` | Service Request 流程里建承载 |
| `ATTACHED` | 附着完成 |
| `SEND_DETACH_ACCEPT` | Detach 流程 |

MME 的消息入口是 `handle_nas_msg()`（`LTE_fdd_enb_mme.cc:180`）：先 `liblte_mme_parse_msg_header()` 取出 NAS 消息类型（`LTE_fdd_enb_mme.cc:198`），按类型分派给 `parse_attach_request` / `parse_authentication_response` / `parse_security_mode_complete` 等一大堆 parse 函数（`LTE_fdd_enb_mme.cc:199-365`）；parse 函数只负责**改状态**（`set_mme_state(...)`），随后统一按"过程"调对应的状态机函数 `attach_sm()` / `service_req_sm()` / `detach_sm()`（`LTE_fdd_enb_mme.cc:374-383`）执行**动作**（发消息）。这个"parse 改状态、sm 执行动作"的两段式结构非常清晰，值得学。

`attach_sm()`（`LTE_fdd_enb_mme.cc:1183-1233`）就是一张纯粹的"状态 → 发送函数"映射表：

```cpp
case LTE_FDD_ENB_MME_STATE_AUTHENTICATE:
    send_authentication_request(user, rb);
    break;
...
case LTE_FDD_ENB_MME_STATE_RRC_SECURITY:
    send_rrc_command(user, rb, LTE_FDD_ENB_RRC_CMD_SECURITY);
    break;
case LTE_FDD_ENB_MME_STATE_ATTACH_ACCEPT:
    send_attach_accept(user, rb);
    break;
```

### Attach Request 的处理链

以 IMSI 方式 attach 为例，`parse_attach_request()`（`LTE_fdd_enb_mme.cc:489-657`）依次做：

1. 解包 NAS（`liblte_mme_unpack_attach_request_msg`，`LTE_fdd_enb_mme.cc:512`），把内嵌的 ESM 消息（PDN Connectivity Request）也解析掉（`LTE_fdd_enb_mme.cc:515-519`）。
2. 把 rb 的 MME 过程置为 `ATTACH`（`LTE_fdd_enb_mme.cc:532`），存下 UE 的 EEA/EIA 安全能力（`LTE_fdd_enb_mme.cc:538-542`）。
3. **查 HSS**：`hss->is_imsi_allowed(imsi_num)`（`LTE_fdd_enb_mme.cc:614`，实现就是遍历本地用户链表，`LTE_fdd_enb_hss.cc:224-240`）。没有 S6a 接口、没有真实 HSS——就是一个内存数据库，你在控制端口 `add_user` 加进去的三元组就在这。
4. 查到了且 UE 支持 EEA0/EIA2：`set_mme_state(AUTHENTICATE)` 并从 HSS 取出用户身份 `set_id(hss->get_user_id_from_imsi(imsi_num))`（`LTE_fdd_enb_mme.cc:616-619`）；查不到就 `REJECT`（`LTE_fdd_enb_mme.cc:624-627`）。

随后 `attach_sm` 在 `AUTHENTICATE` 态调 `send_authentication_request()`（`LTE_fdd_enb_mme.cc:1472`）：先 `hss->generate_security_data(...)` 用 Milenage f1/f2345 算出 RAND/AUTN/XRES/KASME 一 whole 鉴权向量（`LTE_fdd_enb_mme.cc:1483-1485`，Milenage 实现在 `LTE_fdd_enb_hss.cc:327-332`，算法对应 35.206，鉴权框架见 33.401），打包 Authentication Request 后经 `RRC_NAS_MSG_READY` 发回 RRC（`LTE_fdd_enb_mme.cc:1506-1514`）。

之后的状态迁移链：

- UE 回 Authentication Response → `parse_authentication_response()`（`LTE_fdd_enb_mme.cc:694`）比对 XRES，通过则转 `ENABLE_SECURITY`（`LTE_fdd_enb_mme.cc:742`）→ 发 NAS Security Mode Command。
- UE 回 NAS 层 Security Mode Complete → `parse_security_mode_complete()`（`LTE_fdd_enb_mme.cc:883`）转 `RRC_SECURITY`（`LTE_fdd_enb_mme.cc:935`）→ `attach_sm` 发 `RRC_CMD_SECURITY` 命令 RRC 起 AS 安全。
- UE 回 RRC 层 SecurityMode Complete → RRC 回 `MME_RRC_CMD_RESP` → `handle_rrc_cmd_resp()`（`LTE_fdd_enb_mme.cc:402`）转 `ATTACH_ACCEPT`（或先 `ESM_INFO_TRANSFER`，`LTE_fdd_enb_mme.cc:409-417`）。
- `send_attach_accept()`（`LTE_fdd_enb_mme.cc:1284`）：分配 IP（`get_next_ip_addr()`，`LTE_fdd_enb_mme.cc:1889`）、组 GUTI、把"Activate Default EPS Bearer Context Request"嵌进 Attach Accept（`LTE_fdd_enb_mme.cc:1343-1344`，消息格式见 24.301），入队后经 `RRC_CMD_SETUP_DEF_DRB` 发给 RRC（`LTE_fdd_enb_mme.cc:1394-1398`）——RRC 那边建 SRB2+DRB1 并把这条 NAS 捎进 RRCConnectionReconfiguration。
- UE 回 Attach Complete → `parse_attach_complete()`（`LTE_fdd_enb_mme.cc:447`）转 `ATTACHED`（`LTE_fdd_enb_mme.cc:470`），再补一条 EMM Information。收工。

## 端到端调用流：一次 Attach 的每一跳

下面是从空口比特到 HSS 再回来的完整跳数表，每一跳都给了代码位置。这是你日后追任何信令的"标准追法"：先定位它走的是哪条 msgq，再找两端模块的 handler。

**上行（UE → eNodeB 内部）：**

| 跳 | 位置 | 干了什么 |
|---|---|---|
| 1 | `LTE_fdd_enb_phy.cc:911-925` | PUSCH 信道解码成功，发 `PUSCH_DECODE` 给 MAC |
| 2 | `LTE_fdd_enb_mac.cc:605-664` | `handle_pusch_decode()`：按 RNTI 找 user，解 MAC PDU，按 LCID 分流 CCCH/DCCH SDU |
| 3 | `LTE_fdd_enb_mac.cc:805-813` | SDU 入 rb 队列，发 `RLC_PDU_READY` 给 RLC |
| 4 | `LTE_fdd_enb_rlc.cc:264-312` | `handle_pdu_ready()`：按 TM/UM/AM 配置处理 |
| 5 | `LTE_fdd_enb_rlc.cc:319-328` | PDU 入队，发 `PDCP_PDU_READY` 给 PDCP |
| 6 | `LTE_fdd_enb_pdcp.cc:223-292` | `handle_pdu_ready()`：SRB0 转比特流/SRB1 解 PDCP 头，入队后发 `RRC_PDU_READY` |
| 7 | `LTE_fdd_enb_rrc.cc:243-267` | `handle_pdu_ready()`：SRB0→`ccch_sm`，SRB1/2→`dcch_sm` |
| 8 | `LTE_fdd_enb_rrc.cc:656-668` | SetupComplete 里的 NAS 入队，发 `MME_NAS_MSG_READY` |
| 9 | `LTE_fdd_enb_mme.cc:180-205` | `handle_nas_msg()` → `parse_attach_request()` |
| 10 | `LTE_fdd_enb_mme.cc:614-619` | 查 HSS（`LTE_fdd_enb_hss.cc:224`），转 `AUTHENTICATE` 态 |

（更早的随机接入阶段：PHY 检到 preamble 发 `PRACH_DECODE`，`LTE_fdd_enb_phy.cc:840` → MAC `handle_prach_decode()`，`LTE_fdd_enb_mac.cc:472` → `construct_random_access_response()` 里 `user_mgr->add_user()` 创建 user、分配 C-RNTI，`LTE_fdd_enb_mac.cc:1000-1014`。user 对象的生命周期从这里开始。）

**下行（MME → 空口）：**

| 跳 | 位置 | 干了什么 |
|---|---|---|
| 11 | `LTE_fdd_enb_mme.cc:1183-1233` | `attach_sm()` 按状态选发送函数 |
| 12 | `LTE_fdd_enb_mme.cc:1506-1514` | NAS 入 rb 队列，发 `RRC_NAS_MSG_READY`（或 `send_rrc_command()` 发 `RRC_CMD_READY`，`LTE_fdd_enb_mme.cc:1870-1884`） |
| 13 | `LTE_fdd_enb_rrc.cc:294-321` | `handle_nas_msg()` → `send_dl_info_transfer()` 组 DLInformationTransfer |
| 14 | `LTE_fdd_enb_rrc.cc:750-759` | 入队后发 `PDCP_SDU_READY`，此后沿 PDCP→RLC→MAC→PHY 原路下空口 |

**一句话总结追代码套路**：消息类型枚举（`LTE_fdd_enb_msgq.h:80-129`）是地图，`grep MESSAGE_TYPE_XXX` 找到所有发送点，`dest_layer` 告诉你发给谁，接收方的 `handle_*_msg()` 就是下一跳。

## 定时器：timer_mgr 与 T3xx

定时器模块的结构很直白：`LTE_fdd_enb_timer_mgr`（`LTE_fdd_enodeb/src/LTE_fdd_enb_timer_mgr.cc`）内部是 `std::map<uint32, LTE_fdd_enb_timer*>`，`start_timer(毫秒, 回调, &id)` 注册（`LTE_fdd_enb_timer_mgr.cc:149-174`），`stop_timer`/`reset_timer` 配套（`:175-203`）。

驱动节拍来自 MAC：PHY 每 TTI 发 `READY_TO_SEND`，MAC 的 `handle_ready_to_send()` 顺手往 `mac_to_timer` 队列丢一个 `TIMER_TICK`（`LTE_fdd_enb_mac.cc:376-389`）。timer_mgr 收到后 `handle_tick()` 遍历所有定时器加 1ms，超时的逐个 `call_callback()` 并从 map 删除（`LTE_fdd_enb_timer_mgr.cc:236-265`）。**tick 精度就是 1 个 TTI（1ms）**，够用但谈不上精确——这是拿协议节拍当时钟源的典型做法。

一个反直觉的事实要先说清楚：**T300/T310/T311 这些 36.331 的 T3xx 定时器是 UE 侧的**，eNodeB 不跑它们。OpenLTE 里它们只作为 SIB2 的广播参数出现（`LTE_fdd_enb_cnfg_db.cc:672-674`，`t310 = 1000ms`、`t311 = 30000ms`）。eNodeB 侧实际跑的定时器有三个：

- **C-RNTI 预留定时器**：`user_mgr->add_user()` 时启动，5000ms（`LTE_fdd_enb_user_mgr.cc:300`）。RACH 建了 user 但 UE 迟迟不完成连接建立，超时后 `handle_c_rnti_timer_expiry()`（`LTE_fdd_enb_user_mgr.cc:610`）回收 C-RNTI。
- **用户不活动定时器**：`user->start_inactivity_timer()`（`LTE_fdd_enb_user.cc:753`）；每次收到该 UE 的 PUSCH 都 reset（`LTE_fdd_enb_mac.cc:619`）。超时回调 `handle_timer_expiry()`（`LTE_fdd_enb_user.cc:726-742`）直接构造一条 `RRC_CMD_RELEASE` 调 `rrc->handle_cmd()` 释放 RRC 连接——相当于真实网络里的"用户面不活动释放"。
- **RLC t-pollretransmit**：AM 模式轮询重传，100ms（`LTE_fdd_enb_rb.cc:791`），36.322 定义的标准定时器。

所以"超时了往哪发消息"的答案是：**多数情况下不发消息，直接在回调里调目标模块的公开接口**（比如 `rrc->handle_cmd()`）。这是 msgq 规则的一个例外，值得注意——它成立的前提是这些回调都很短，不会阻塞 timer_mgr 的消费线程。

## 设计点评

**优点：**

- **极致的可读性**。一个模块一个类、一条链路一条队列、消息类型一目了然。控制面"parse 改状态 / sm 执行动作"的两段式写法，让状态机代码没有任何藏起来的副作用。作为教学代码，这是它最大的价值。
- **模块间零共享内存（除了 user/rb）**。每层只摸自己的队列指针，崩溃影响面小，gdb 里栈也干净。
- **CPU 亲和性、pcap 落盘（`LTE_fdd_enb_interface.cc:506-563`）这些细节**都是真刀真枪做 SDR 才会想到的。

**缺点：**

- **Singleton 满天飞**。interface、cnfg_db、hss、user_mgr、各协议层全是全局单例，单元测试几乎没法做——你没法"新建一个 RRC 实例喂假消息"。作者自己也意识到了，MME/PDCP/GW 已经改回普通类（`LTE_fdd_enb_mme.h:44` 的修订记录写着 "Moved away from singleton pattern"），但改了一半。
- **user/rb 是隐式共享状态**。消息只传指针，意味着十几条线程并发读写同一批 user 对象，全靠对象内部的信号量自觉保护，死锁和竞态的风险都压在"大家都守规矩"上。
- **队列满即丢**。`boost::circular_buffer` 容量写死 100，满了 `push_back` 静默覆盖最老的消息，没有任何背压或告警。
- **控制面与用户面同优先级**。所有消息挤同一种队列，没有 QoS 区分；RRC 信令不会因为队列前面堆了 100 个用户面消息而加塞。

**和生产级实现的差距：** 以 srsRAN 为例——它有真正的 S1AP 接口接外部核心网（OpenLTE 把 MME/HSS 合进进程里，出不了实验室）、有 SCTP、有完整的多 UE 调度与测量上报、RRC 状态机覆盖切换/重建/寻呼全场景，任务模型上也是按"协议栈线程池 + 精确 TTI 时钟"组织而不是一层一线程。OpenLTE 的定位从来都不是"能商用"，而是"能让你把 LTE 协议栈从头到尾看懂"——从这个目标看，Singleton + msgq 这套朴素架构反而是优点：每一跳都看得见摸得着。

## 小结

- `main()` 只起三个 Singleton 和两个 TCP 端口（`LTE_fdd_enb_main.cc:63-72`）；协议栈由控制端口的 `start` 命令触发 `handle_start()`（`LTE_fdd_enb_interface.cc:971`）装配：13 条 msgq + 8 个模块按序启动。
- 并发模型 = 每条消息队列一条消费线程；消息信封是 `(type, dest_layer, union)`，类型全集在 `LTE_fdd_enb_msgq.h:80-129`；数据不进队列，挂在共享的 `(user, rb)` 对象上。
- RRC 状态机挂在 rb 上（`LTE_fdd_enb_rb.h:152-158`），入口 `ccch_sm`/`dcch_sm`（`LTE_fdd_enb_rrc.cc:434`、`:511`），主线 IDLE → SRB1_SETUP → WAIT_FOR_CON_SETUP_COMPLETE → RRC_CONNECTED。
- EMM 状态机（`LTE_fdd_enb_rb.h:112-125`）在 MME 模块，"parse 改状态、`attach_sm` 执行动作"两段式；HSS 只是本地内存数据库，鉴权用 Milenage（35.206）。
- 追信令的标准方法：在 `LTE_fdd_enb_msgq.h` 查消息类型 → grep 发送点 → 按 `dest_layer` 找接收方的 `handle_*_msg()`。
- 定时器由 MAC 每 TTI 发的 `TIMER_TICK` 驱动；T3xx 是 UE 侧定时器，eNodeB 只在 SIB2 里广播，本地只跑 C-RNTI 预留、不活动释放、t-pollretransmit 三个。
