# 第5章 MAC / RLC / PDCP：L2 三层在 OpenLTE 里的实现

前面几章把 RRC、NAS 这些"信令内容"讲清楚了。这一章往下走一层：一条消息编码成比特流之后，并不是直接扔给 PHY 的，它要先穿过 L2 的三个子层——PDCP、RLC、MAC，每层给它"戴一顶帽子"（加上自己的头）。读完本章，你应该能回答一个具体问题：**一条 RRC 消息从 `LTE_fdd_enb_rrc.cc` 出来，到交给 PHY 之前，字节流到底长什么样，每一层分别加上了什么。**

先建立一个整体印象：OpenLTE 把"协议格式"和"协议行为"拆成了两半。

- `liblte/src/liblte_mac.cc`、`liblte_rlc.cc`、`liblte_pdcp.cc` 是纯函数式的 **pack/unpack 库**：给它一个结构体，它帮你按 3GPP 规范把比特摆好；反过来把字节流解析回结构体。这里没有任何状态。
- `LTE_fdd_enodeb/src/LTE_fdd_enb_mac.cc`、`LTE_fdd_enb_rlc.cc`、`LTE_fdd_enb_pdcp.cc` 是 eNodeB 侧的 **运行时层**：维护序号、窗口、重传 buffer、调度队列这些状态，通过消息队列（`LTE_fdd_enb_msgq`）互相驱动。

你可以把 liblte 想成"编解码器"，把 enodeb 那一组文件想成"状态机 + 流水线"。

## L2 总览：SDU/PDU 与串起三层的 rb 对象

先统一词汇。每一层从上层拿到的数据叫 **SDU**（Service Data Unit），加工后交给下层的叫 **PDU**（Protocol Data Unit）。本层的 PDU 就是下一层的 SDU，仅此而已。三层各自的职责一句话：

- **PDCP**（36.323）：给控制面消息做完整性保护（MAC-I）、维护 COUNT 序号；用户面本应有头压缩（ROHC）和加密。
- **RLC**（36.322）：分段/级联与重组，AM 模式下提供 ARQ 重传，保证按序、不丢。
- **MAC**（36.321）：把多条逻辑信道的数据复用进一个传输块（TB），做调度，HARQ 也挂在它头上。

eNodeB 这边三层之间不是函数直接调用，而是"队列 + 消息通知"的异步流水线。承载这条流水线的核心对象是 `LTE_fdd_enb_rb`（radio bearer），定义在 `LTE_fdd_enodeb/hdr/LTE_fdd_enb_rb.h:195`。一个 rb 实例对应一条无线承载（SRB0/SRB1/SRB2/DRB1/DRB2，枚举见 `LTE_fdd_enodeb/hdr/LTE_fdd_enb_rb.h:85`），它内部为每一层都准备了一对 FIFO 队列，例如下行方向的 `pdcp_sdu_queue` → `rlc_sdu_queue` → `mac_sdu_queue`（声明见 `LTE_fdd_enb_rb.h:337-373`）。

数据流动的固定套路是：

1. 上层把数据 `queue_*` 进 rb 的队列；
2. 通过 msgq 给下层发一个 `*_SDU_READY` 通知；
3. 下层的 handler 被回调，从 rb 队列里 `get_next_*` 取出数据，加工后再 `queue_*` 给更下层，并发新的通知。

rb 构造函数 `LTE_fdd_enodeb/src/LTE_fdd_enb_rb.cc:94-178` 是全章最值得记住的一段代码，因为它直接回答了"每条承载用什么配置"：

```cpp
// LTE_fdd_enb_rb.cc:102-135（节选）
if(LTE_FDD_ENB_RB_SRB0 == rb)
{
    pdcp_config = LTE_FDD_ENB_PDCP_CONFIG_N_A;
    rlc_config  = LTE_FDD_ENB_RLC_CONFIG_TM;    // SRB0：透传
    mac_config  = LTE_FDD_ENB_MAC_CONFIG_TM;
}else if(LTE_FDD_ENB_RB_SRB1 == rb){
    pdcp_config = LTE_FDD_ENB_PDCP_CONFIG_N_A;
    rlc_config  = LTE_FDD_ENB_RLC_CONFIG_AM;    // SRB1：确认模式
    ...
}else if(LTE_FDD_ENB_RB_DRB1 == rb){
    pdcp_config = LTE_FDD_ENB_PDCP_CONFIG_LONG_SN;
    rlc_config  = LTE_FDD_ENB_RLC_CONFIG_AM;    // DRB 也用 AM
```

对照规范（36.331）：SRB0 走 CCCH，RLC 必须是 TM；SRB1/SRB2 走 DCCH，RLC 用 AM——代码和规范是一致的。值得注意的是 **UM（非确认模式）在 eNodeB 侧是死代码**：`LTE_fdd_enb_rlc.cc` 里有完整的 `handle_um_pdu`/`handle_um_sdu`（`LTE_fdd_enb_rlc.cc:330`、`:667`），但全仓库没有任何地方把某个 rb 的 `rlc_config` 设成 `LTE_FDD_ENB_RLC_CONFIG_UM`（构造函数里只有 TM 和 AM 两种赋值，见 `LTE_fdd_enb_rb.cc:109-133`）。liblte 里的 UMD pack/unpack 因此只有库层面的意义。

## MAC：subheader 结构与"够用就行"的调度

### MAC PDU 的头：一串 subheader

MAC PDU 的结构是"一串 subheader + 对应的 payload（SDU 或控制单元 CE）"。每个 subheader 第一个字节的布局（36.321）：

| 字段 | 比特宽 | 含义 |
|---|---|---|
| R | 1 | 保留位，置 0 |
| R | 1 | 保留位，置 0 |
| E | 1 | Extension：1 = 后面还有 subheader，0 = 这是最后一个 |
| LCID | 5 | 逻辑信道号或 CE 类型 |
| F | 1 | （仅需要长度字段时）L 字段是 7 还是 15 比特 |
| L | 7/15 | （非最后一个 subheader 时）对应 payload 的字节数 |

LCID 的取值表定义在 `liblte/hdr/liblte_mac.h:320-343`，常用的几个：DL-SCH 上 `0x00`=CCCH、`0x01..0x0A`=DCCH（也就是 SRB1/SRB2/DRB）、`0x1C`=UE Contention Resolution Identity CE、`0x1D`=TA Command CE、`0x1F`=Padding；UL-SCH 上 `0x1D/0x1E`=Short/Long BSR。

打包逻辑在 `liblte_mac_pack_mac_pdu`（`liblte/src/liblte_mac.cc:666`）。写 subheader 的核心循环：

```cpp
// liblte/src/liblte_mac.cc:679-689
for(i=0; i<pdu->N_subheaders; i++)
{
    liblte_value_2_bits(0, &msg_ptr, 1); // R
    liblte_value_2_bits(0, &msg_ptr, 1); // R
    if(i != pdu->N_subheaders-1)
        liblte_value_2_bits(1, &msg_ptr, 1); // E：后面还有
    else
        liblte_value_2_bits(0, &msg_ptr, 1); // E：最后一个
    liblte_value_2_bits(pdu->subheader[i].lcid, &msg_ptr, 5);
```

随后按 LCID 判断要不要写 F/L 字段（固定长度的 CE 和最后一个 subheader 不写 L，见 `liblte_mac.cc:690-709`）。解包侧 `liblte_mac_unpack_mac_pdu`（`liblte/src/liblte_mac.cc:859`）则是靠 E 比特驱动一个 `while(e_bit)` 循环把 subheader 链读完（`liblte_mac.cc:874-878`），最后一个 SDU 的长度用"剩余比特数"倒推（`liblte_mac.cc:979-981`）。控制单元（BSR、TA Command、Power Headroom 等）各自的 pack/unpack 都在同一个文件里，比如 TA Command 是 2 个 R 比特 + 6 比特 TA 值（`liblte_mac.cc:338-348`）。

### eNodeB 侧的 MAC：复用、调度、HARQ

下行方向，MAC 收到 RLC 的 SDU 后的入口是 `LTE_fdd_enb_mac::handle_sdu_ready`（`LTE_fdd_enodeb/src/LTE_fdd_enb_mac.cc:679`）。它做的事非常直白：

1. 填好 PHY 分配参数（QPSK、tx_mode、NDI 翻转等，`:699-717`）；
2. 组 `LIBLTE_MAC_PDU_STRUCT`：如果该 rb 需要发竞争解决 ID，就塞两个 subheader（一个 UE Con Res ID CE + 一个 SDU），否则只有一个 SDU subheader，LCID 直接用 rb 编号（`:720-733`）；
3. 把整个 PDU 挂进 `dl_sched_queue`，目标 TTI 是"当前 + 4"（`:736-739`）——这就是 LTE FDD 里下行调度提前 4ms 的惯例。

真正的调度器是 `scheduler()`（`LTE_fdd_enb_mac.cc:1150`），每个子帧被 `handle_ready_to_send`（`:376`）触发一次，依次处理 RAR 队列、下行队列、上行队列。下行部分（`:1325-1467`）的流程是：取队首 PDU → `liblte_mac_pack_mac_pdu` 打出比特流（`:1342`）→ 按可用 PRB 查 TBS/MCS（`:1344`）→ **如果 TBS 比实际比特数大，插 Padding subheader 后重新打包**（`:1361-1388`）→ 写进子帧结构并给 PHY。

上行调度 `sched_ul`（`:1087`）同样朴素：收到 BSR 或 SR 后按请求的比特数查 TBS/MCS/N_prb（`:1111`），把 grant 排进队列。

这里要**如实说**：OpenLTE 没有逻辑信道优先级（LCP）算法。36.321 里的优先级、PBR、prioritisedBitRate 这些概念在代码里完全没有出现——`handle_sdu_ready` 来一个 SDU 就组一个 PDU 排队，FIFO 出队，调度资源检查只有"PRB 够不够、CCE 够不够"（`:1401-1402`）。MCS 也不是链路自适应的：DL 每用户每子帧上限写死 325 字节、UL 写死 50 字节，注释里直接标着 FIXME（`LTE_fdd_enodeb/src/LTE_fdd_enb_user.cc:743-752`）。HARQ 有一个简化实现：收到 PUCCH 上的 NACK 后，`handle_pucch_ack_nack`（`LTE_fdd_enb_mac.cc:511`）把存起来的 PDU 原样重新排进调度队列（重传次数有上限 `LTE_FDD_ENB_MAX_HARQ_RETX`，`:541`），没有增量冗余，rv_idx 恒为 0（`:703`）。

## RLC：三种模式与头格式逐个看

### 三种模式的区别

| 模式 | 头 | 序号 | 重传 | 典型用途 |
|---|---|---|---|---|
| TM（Transparent） | 无 | 无 | 无 | SRB0/CCCH、广播 |
| UM（Unacknowledged） | UMD 头 | 5 或 10 bit SN | 无 | 时延敏感、可容忍丢包的业务 |
| AM（Acknowledged） | AMD 头 | 10 bit SN | ARQ（STATUS PDU） | SRB1/2、默认 DRB |

OpenLTE 实际使用：SRB0=TM，SRB1/SRB2/DRB=AM（`LTE_fdd_enb_rb.cc:109-133`），UM 未启用。

### UMD PDU 头（36.322）

UMD 头第一字节（5 bit SN 时）：

| 字段 | 比特宽 | 含义 |
|---|---|---|
| FI | 2 | Framing Info：本 PDU 数据区首/尾是否恰好是 SDU 边界 |
| E | 1 | 后面是否还有 E+LI 扩展字段 |
| SN | 5 或 10 | 序号（10 bit 时占两字节） |

FI 的四个取值在 `liblte/hdr/liblte_rlc.h:93-98`：`00`=完整 SDU、`01`=首段、`10`=末段、`11`=中间段。打包代码就是直接的位拼合（`liblte/src/liblte_rlc.cc:157-170`）：

```cpp
// liblte_rlc.cc:157-162（5 bit SN 情形）
*pdu_ptr  = (umd->hdr.fi & 0x03) << 6;   // FI 占最高 2 位
*pdu_ptr |= (LIBLTE_RLC_E_FIELD_HEADER_NOT_EXTENDED & 0x01) << 5;
*pdu_ptr |= umd->hdr.sn & 0x1F;          // SN 低 5 位
pdu_ptr++;
```

如果一个 PDU 里级联了多个 SDU，头里还要追加 E+LI（Length Indicator，11 bit）列表，pack/unpack 里那段按奇偶交替处理 LI 的循环（`liblte_rlc.cc:99-124`、`:214-236`）就是在做这件事。

### AMD PDU 头

AMD 头固定部分两字节（36.322）：

| 字段 | 比特宽 | 含义 |
|---|---|---|
| D/C | 1 | 0=控制 PDU（STATUS），1=数据 PDU |
| RF | 1 | 0=AMD PDU，1=AMD PDU segment（重传时再分段） |
| P | 1 | Poll：请求对端回 STATUS 报告 |
| FI | 2 | 同 UM |
| E | 1 | 是否有 E+LI 扩展 |
| SN | 10 | 序号（跨前两字节） |

打包见 `liblte_rlc.cc:346-354`；如果是 segment（RF=1），还要再补两字节 LSF+SO（segment 在原 PDU 里的字节偏移），见 `liblte_rlc.cc:355-361`。解包侧在 `liblte_rlc.cc:388-407`。

AM 的控制 PDU 是 STATUS PDU：`D/C=0` + 3 bit CPT + 10 bit `ACK_SN`（第一个没收到的 SN）+ 若干 `NACK_SN` 列表，pack 见 `liblte_rlc.cc:503-521`。注意 `SOstart/SOend`（按字节粒度 NACK segment）没有实现，代码里是两个 FIXME（`liblte_rlc.cc:547`、`:615`）。

### eNodeB 侧 RLC 的 ARQ：实现了多少

状态变量都在 rb 对象里：接收侧 VR(R)/VR(MR)/VR(H)，发送侧 VT(A)/VT(MS)/VT(S)（`LTE_fdd_enb_rb.h:358-363`），AM 窗口 512（`liblte/hdr/liblte_rlc.h:51`）。

**发送路径**：`handle_am_sdu`（`LTE_fdd_enb_rlc.cc:763`）拿到 SDU 后按 325 字节上限分段、打 SN（VT(S) 递增）、设 FI；PDU 先存进 `rlc_am_transmission_buffer`（`LTE_fdd_enb_rb.cc:731`）再交给 MAC，同时启动 t-PollRetransmit 定时器（100ms，`LTE_fdd_enb_rb.cc:784-792`）。

**接收路径**：`handle_am_pdu`（`LTE_fdd_enb_rlc.cc:452`）解包后做窗口检查（`VR(R) <= SN < VR(MR)`，`:482-483`），在窗内就进 reception buffer、更新 VR(H)、尝试按 SN 重组 SDU 上交 PDCP，然后**无条件回 STATUS PDU**（`:534-539`——注意 `if(p)` 被注释掉了，这是作者的简化：不等 Poll 位，每个 AMD PDU 都触发状态报告）。

**重传**：收到 STATUS PDU 后 `rlc_update_transmission_buffer`（`LTE_fdd_enb_rb.cc:743`）把被 ACK 的 PDU 从发送 buffer 删掉、推进 VT(A)；t-PollRetransmit 超时就取 VT(A) 处最老的 PDU 重发并把 P 位置 1（`LTE_fdd_enb_rb.cc:801-812`、`LTE_fdd_enb_rlc.cc:220-259`）。

没实现的部分也要说清楚：AMD PDU segment 的接收被显式拒绝（`LTE_fdd_enb_rlc.cc:471-478`，"Not handling AMD PDU segments"）；t-Reordering、t-StatusProhibit 这两个定时器不存在；VR(MS) 的更新标着 FIXME（`LTE_fdd_enb_rlc.cc:511`）。所以这是一个"能跑通基本 ARQ 闭环"的教学级实现，不是完整的 36.322。

## PDCP：序号、完整性，以及没有实现的加密和 ROHC

### 头格式

控制面 PDCP Data PDU（SRB 用，36.323）的头极简：**1 字节，低 5 位是 SN**，高 3 位保留。PDU 尾部再挂 4 字节 MAC-I。打包在 `liblte/src/liblte_pdcp.cc:89-157`：

```cpp
// liblte_pdcp.cc:106-107
*pdu_ptr = contents->count & 0x1F;   // 头部 = COUNT 的低 5 位（即 PDCP SN）
pdu_ptr++;
```

MAC-I 的计算（`:139-147`）：如果调用方给了密钥，就调 `liblte_security_128_eia2` 算 4 字节认证码；没给密钥就填占位值 0（`LIBLTE_PDCP_CONTROL_MAC_I`，`liblte/hdr/liblte_pdcp.h:70`）。

用户面 Data PDU 头：D/C 位 1 + 12 bit 长 SN（两字节，pack 见 `liblte_pdcp.cc:210-213`）或 7 bit 短 SN（一字节，`:279`）。

### 安全在哪里被调用

eNodeB 侧的发送入口是 `LTE_fdd_enb_pdcp::handle_sdu_ready`（`LTE_fdd_enodeb/src/LTE_fdd_enb_pdcp.cc:325`）。对 SRB1/SRB2：

```cpp
// LTE_fdd_enb_pdcp.cc:390-403
contents.count = sdu_ready->rb->get_pdcp_tx_count();
if(LTE_FDD_ENB_PDCP_CONFIG_SECURITY == sdu_ready->rb->get_pdcp_config())
    liblte_pdcp_pack_control_pdu(&contents, sdu,
        sdu_ready->user->get_auth_vec()->k_rrc_int,   // KRRCint
        LIBLTE_SECURITY_DIRECTION_DOWNLINK,
        sdu_ready->rb->get_rb_id()-1,                 // RB id = SRB id - 1
        &pdu);
else
    liblte_pdcp_pack_control_pdu(&contents, sdu, &pdu);  // 不带密钥，MAC-I 填 0
```

`pdcp_config` 什么时候变成 `SECURITY`？在 RRC 发出 SecurityModeCommand 的那一刻（`LTE_fdd_enodeb/src/LTE_fdd_enb_rrc.cc:1089`）。这就和安全章串起来了：密钥层级推导出 KRRCint 之后，真正使用它的地方就是这里，算法固定为 128-EIA2（SecurityModeCommand 里写死 `EIA2`，见 `LTE_fdd_enb_rrc.cc:1077`）。

两个"如实写"的事实：

- **加密（ciphering）没有实现**。整个 `liblte_security` 库里只有密钥生成、128-EIA2 和 Milenage，没有任何 EEA 函数；RRC 层选的就是空算法 EEA0（`LTE_fdd_enb_rrc.cc:1076`）。所以 OpenLTE 的空口消息只做了完整性保护，没有机密性。
- **ROHC 没有实现**。库里只有"穿插 ROHC 反馈包"控制 PDU 的壳（`liblte_pdcp.cc:327`），没有压缩/解压缩逻辑；头压缩在 enodeb 侧从未被调用。
- 接收侧连 SN 校验和 MAC-I 验证都没做，`handle_pdu_ready` 里一行 FIXME 直接承认（`LTE_fdd_enb_pdcp.cc:245`）。

## 端到端走一遍：一条下行 RRC 消息的旅程

以 SRB1 上的一条 DL-DCCH 消息（比如 DLInformationTransfer）为例，跟在代码后面走：

**第 0 步 · RRC 层**（`LTE_fdd_enb_rrc.cc:730-759`）：填好 `dl_dcch_msg` 结构体，`liblte_rrc_pack_dl_dcch_msg` 用 ASN.1 PER 编成比特流（`LIBLTE_BIT_MSG_STRUCT`，**单位是比特，不一定是整字节**），然后 `rb->queue_pdcp_sdu()` + 发 `PDCP_SDU_READY`（`:751`、`:756`）。

**第 1 步 · PDCP**（`LTE_fdd_enb_pdcp.cc:387-429`）：把比特流字节对齐（补零，`liblte_pdcp.cc:110-117`），前面加 1 字节 SN 头，尾部加 4 字节 MAC-I。字节布局：

```
 +--------+-----------------------------+-----------+
 | PDCP头  |  RRC PDU（PER 编码，字节对齐）|  MAC-I    |
 | SN(5b) |                             |  4 字节   |
 +--------+-----------------------------+-----------+
```

这就是交给 RLC 的 SDU（`queue_rlc_sdu`，`LTE_fdd_enb_pdcp.cc:418`）。

**第 2 步 · RLC**（`LTE_fdd_enb_rlc.cc:763-782`）：SRB1 是 AM。若 SDU ≤ 325 字节则不分段，加 2 字节 AMD 头（D/C=1、RF=0、P=1、FI=00、E=0、SN=VT(S)）：

```
 +------------------+-----------------------------+
 | AMD 头 2 字节      | PDCP PDU（= RLC SDU）        |
 | D/C RF P FI E SN   |                             |
 +------------------+-----------------------------+
```

存入发送 buffer、启动 t-PollRetransmit，交给 MAC（`queue_mac_sdu`，`LTE_fdd_enb_rlc.cc:889`）。

**第 3 步 · MAC**（`LTE_fdd_enb_mac.cc:679-766` → `:1342`）：组一个单 subheader 的 MAC PDU，LCID=1（SRB1 对应的 DCCH LCID），因为只有一个 subheader，所以 **E=0 且不写 L 字段**（长度靠"包剩余"倒推）：

```
 +-----------------+-----------------------------+
 | MAC subhdr 1B    | RLC PDU（= MAC SDU）         |
 | R R E=0 LCID=1   |                             |
 +-----------------+-----------------------------+
          （若 TBS 有富余，调度器还会插 Padding subheader，mac.cc:1361-1388）
```

调度器在目标 TTI 把这个比特流写进 `dl_subfr->dl_allocations`（`LTE_fdd_enb_mac.cc:1419-1422`），PHY 按 alloc 里的 TBS/MCS/PRB 发出去。至此，一条 RRC 消息总共被加了三顶帽子：1 字节 PDCP 头 + 4 字节 MAC-I、2 字节 AMD 头、1 字节 MAC subheader——开销共 8 字节。

## 上行接收：反向简走一遍

上行是镜像的"摘帽子"过程，从 PHY 解出 PUSCH 比特流开始：

1. **MAC**：`handle_pusch_decode`（`LTE_fdd_enb_mac.cc:605`）按 RNTI 找到 user，`liblte_mac_unpack_mac_pdu` 解出 subheader 链（`:639`），按 LCID 分发：CCCH→SRB0（顺带把 SDU 存为竞争解决 ID，`:795-802`）、DCCH→对应的 SRB/DRB、BSR→更新上行 buffer 并触发 `sched_ul`。
2. **RLC**：`handle_pdu_ready`（`LTE_fdd_enb_rlc.cc:264`）按 rb 的 `rlc_config` 分发到 TM/UM/AM 处理；AM 路径即上一节的窗口检查 + 重组 + 回 STATUS（`:452-539`）。
3. **PDCP**：`handle_pdu_ready`（`LTE_fdd_enb_pdcp.cc:223`）按 rb 类型解头：SRB0 直接比特化交 RRC；SRB1/2 用 `liblte_pdcp_unpack_control_pdu` 剥掉 1 字节头和 4 字节 MAC-I（**不验证**，`:245` FIXME）交 RRC；DRB 解长 SN 头后把 IP 包交给 GW（`:293-305`）。

每层依然是"从 rb 队列取、加工、queue 给上层、发 msgq 通知"同一个套路，看一遍下行再看上行几乎不用学新东西。

## 常见坑

- **SN 位宽三家各不相同**：PDCP 控制面 SN 5 bit（`liblte_pdcp.cc:106`）、用户面 7/12 bit；RLC UMD 5/10 bit、AMD 固定 10 bit；PDCP 头上写的是 COUNT 的低几位，COUNT 本身 32 bit 存在 rb 里（`LTE_fdd_enb_rb.cc:152-153`）。看抓包时别把不同层的 SN 混为一谈。
- **FI 字段的语义是"数据区边界 vs SDU 边界"**：FI 高位管"首字节是否是 SDU 开头"，低位管"末字节是否是 SDU 结尾"。分段首段是 `01`、末段是 `10`，初学者很容易记反；而且 `unpack_amd_pdu` 在级联 PDU 拆包后会**改写**每个子 PDU 的 FI（`liblte_rlc.cc:458-489`），调试时看到 FI 变了不要惊讶。
- **MAC subheader 顺序 ≠ payload 顺序的错觉**：subheader 链在 PDU 开头连续排列，payload 依次跟在后面，第 N 个 subheader 对应第 N 个 payload；E 比特只表达"后面还有没有 subheader"。**最后一个 subheader 没有 L 字段**，长度靠包总长倒推（`liblte_mac.cc:979-981`）——自己写解析器时最常见的 off-by-one 就出在这里。
- **比特流 vs 字节流**：RRC 给 PDCP 的是 `LIBLTE_BIT_MSG_STRUCT`（比特粒度），PDCP 往下都是 `LIBLTE_BYTE_MSG_STRUCT`。字节对齐补零发生在 PDCP（`liblte_pdcp.cc:110-117`），抓包时 RRC PDU 末尾那几个 0 比特就是这么来的。
- **AM 窗口与模运算**：SN 10 bit、窗口 512（`liblte_rlc.h:51`），但代码里 SN 回绕处理并不一致（比如 `LTE_fdd_enb_rb.cc:776` 用 `% 1024`，而接收 buffer 的 key 是 `sn*10` 这种自制编码，`:582-592`），改这块代码要格外小心。

## 小结

- OpenLTE 把 L2 拆成"无状态编解码库（liblte）+ 有状态流水线（enodeb）"，两侧通过 rb 对象上的队列和 msgq 通知串起来。
- 承载配置写在 rb 构造函数里：SRB0=TM，SRB1/SRB2/DRB=AM；UM 代码存在但从未启用。
- 一条下行 RRC 消息的完整开销：PDCP 1 字节头 + 4 字节 MAC-I，RLC AMD 2 字节头，MAC 1 字节 subheader。
- MAC 只做了复用/解复用和 FIFO 式调度，没有 LCP、没有链路自适应；HARQ 仅支持定次重传。
- RLC AM 实现了基本的窗口、STATUS 报告和基于 t-PollRetransmit 的重传，但 segment 接收、t-Reordering 等未实现。
- PDCP 只做完整性保护（128-EIA2），加密（EEA）与 ROHC 均未实现，接收侧连 MAC-I 校验都省略了——这是教学代码，不是商用协议栈。
