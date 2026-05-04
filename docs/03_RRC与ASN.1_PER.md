# 03 RRC 与 ASN.1 PER

> 本章是整套文档的**第一个重点**。读完之后，你应该可以**逐比特地**手写解码一条 MIB，并能在 `liblte_rrc.cc` 这一万三千行的文件里随便挑一条 RRC 消息，把它的字段、长度、可选位、扩展位逐一对上。
>
> 文中所有"liblte_rrc.cc:NNNN"都是真实的行号，方便你打开编辑器跳过去。

---

## 1. 为什么要懂 PER

3GPP 36.331 把 RRC 消息用 **ASN.1** 描述，但实际在空中传的是 **PER（Packed Encoding Rules）的 unaligned 变种（uPER）**。

为什么不用 protobuf 或 JSON？因为**空中接口比特就是钱**。每多一个比特意味着 100 万部手机里每天上百亿次浪费的功率与频谱。所以 ASN.1 PER 把所有"可推断的信息"全部省掉：
- 字段顺序固定 → 不用写 tag
- 字段长度固定或可推断 → 不用写 length
- 字段值范围 [a, b] 已知 → 用 ⌈log2(b−a+1)⌉ 比特就够
- 可选字段先写一个 1 bit "是否存在"标志位
- 比特流不向字节对齐 → 一个 3-bit 字段紧跟一个 5-bit 字段就是 8 bit 一字节，零浪费

**类比 protobuf**：protobuf 是 (tag, type, length, value) 的字节流；uPER 是"按 schema 顺序往一个比特流里塞，能省的都省"。两者都靠 schema，但 uPER 极致到比特级。

OpenLTE 没有用 `asn1c` 之类的代码生成器，**是手工写的 PER**。这对你学习反而是好事——所有逻辑都摊在你眼前的 C 代码里。

## 2. 整个 PER 的"加法器"：两个比特函数

打开 `liblte/src/liblte_common.cc:62-93`：

```c
void liblte_value_2_bits(uint32 value, uint8 **bits, uint32 N_bits) {
    uint32 i;
    for(i=0; i<N_bits; i++)
        (*bits)[i] = (value >> (N_bits-i-1)) & 0x1;
    *bits += N_bits;
}

uint32 liblte_bits_2_value(uint8 **bits, uint32 N_bits) {
    uint32 value = 0, i;
    for(i=0; i<N_bits; i++)
        value |= (*bits)[i] << (N_bits-i-1);
    *bits += N_bits;
    return value;
}
```

注意三件事：
1. **`uint8 **bits`** —— 指针的指针。函数会**前进游标 N_bits**，下次调用就接着写。
2. **`(*bits)[i]`** 是 0 或 1 —— 比特数组里**一个字节存一个比特**（不是按位压缩）。这种存法浪费内存，但写代码极其方便：直接 [i] 索引。
3. **MSB-first** —— 高位先写。`value=0b101, N_bits=3` 写出来是 `[1,0,1]`。

> 这正是 PER 的"加法器"。整个 `liblte_rrc.cc` 1.3 万行，本质上就是反复调用这两个函数，把 RRC 消息一比特一比特地拼/拆。

数据容器在 `liblte/hdr/liblte_common.h`：
```c
typedef struct {
    uint32 N_bits;
    uint8  msg[LIBLTE_MAX_MSG_SIZE];   // 一个字节存一个比特
} LIBLTE_BIT_MSG_STRUCT;
```

而到了 NAS（24.301），用的是字节级容器：
```c
typedef struct {
    uint32 N_bytes;
    uint8  msg[LIBLTE_MAX_MSG_SIZE];   // 一个字节就是一个字节
} LIBLTE_BYTE_MSG_STRUCT;
```

**关键差异：RRC 用 BIT 容器（要按比特操作），NAS 用 BYTE 容器（按字节操作）。** 这一区别贯穿整个项目——一看到 BIT 你就知道是空口/RRC，看到 BYTE 就知道是 NAS。

## 3. 入门最小例子：MIB 的 24 比特

MIB（Master Information Block）是基站每 40 ms 在 PBCH 上广播一次的"我是谁、带宽多少、PHICH 怎么配"。它**只有 24 个比特**，是 PER 编码的最简实例。

打开 `liblte/src/liblte_rrc.cc:12966`（函数 `liblte_rrc_pack_master_information_block_msg`）：

```c
liblte_value_2_bits(mib->dl_bw, &msg_ptr, 3);             // DL Bandwidth (3 bits)
liblte_rrc_pack_phich_config_ie(&mib->phich_config, &msg_ptr); // 3 bits
liblte_value_2_bits(mib->sfn_div_4, &msg_ptr, 8);         // SFN/4 (8 bits)
liblte_value_2_bits(0, &msg_ptr, 10);                     // Spare (10 bits)
```

总共 3 + 3 + 8 + 10 = 24 bit。

各字段含义：
| 字段 | 比特数 | 说明 |
|---|---|---|
| `dl_bw` | 3 | 下行带宽枚举：`{n6=0, n15, n25, n50, n75, n100}` 对应 1.4/3/5/10/15/20 MHz |
| `phich_config.dur` | 1 | PHICH 时长 (Normal=0, Extended=1) |
| `phich_config.res` | 2 | PHICH 资源 (1/6, 1/2, 1, 2 倍) |
| `sfn_div_4` | 8 | SFN（System Frame Number）的高 8 位（每 40 ms 广播一次） |
| spare | 10 | 留作扩展 |

PHICH 的 IE pack 在 `liblte_rrc.cc:6470`（函数 `liblte_rrc_pack_phich_config_ie`）：
```c
liblte_value_2_bits(phich_config->dur, ie_ptr, 1);
liblte_value_2_bits(phich_config->res, ie_ptr, 2);
```

**如果让你纸上拆 MIB**：把 24 bit 排开，前 3 bit 是带宽，下 1 bit 是 PHICH 时长，下 2 bit 是 PHICH 资源，下 8 bit 是 SFN/4，最后 10 bit 是 0。**完毕。**

> 这就是 PER 的精髓：**没有 tag，没有 length，全靠 schema 顺序 + 固定比特宽度**。

## 4. 第二个例子：RRCConnectionRequest

UE 申请 RRC 连接的第一条消息，看 `liblte_rrc.cc:11596`：

```c
LIBLTE_ERROR_ENUM liblte_rrc_pack_rrc_connection_request_msg(...)
{
    uint8 *msg_ptr = msg->msg;
    uint8 ext = false;

    liblte_value_2_bits(ext, &msg_ptr, 1);            // ① 扩展位

    if(!ext) {
        liblte_value_2_bits(con_req->ue_id_type, &msg_ptr, 1); // ② UE ID 类型 0/1

        if(LIBLTE_RRC_CON_REQ_UE_ID_TYPE_S_TMSI == con_req->ue_id_type) {
            liblte_rrc_pack_s_tmsi_ie(&con_req->ue_id, &msg_ptr); // ③a S-TMSI 40 bit
        } else {
            // ③b 随机值 40 bit
            liblte_value_2_bits((uint32)(con_req->ue_id.random >> 32), &msg_ptr, 8);
            liblte_value_2_bits((uint32)(con_req->ue_id.random),       &msg_ptr, 32);
        }

        liblte_value_2_bits(con_req->cause, &msg_ptr, 3); // ④ 建立原因
        liblte_value_2_bits(0,              &msg_ptr, 1); // ⑤ Spare
    }
    ...
}
```

这个 64 bit 消息把 PER 的几个关键技巧都用到了：
- **① 扩展位**：所有可扩展的 ASN.1 类型，PER 都先写一个 1-bit "我用不用扩展形态"。RRCConnectionRequest 不用扩展，所以写 0。
- **② CHOICE 选择子**：UE ID 是个二选一的 CHOICE → 1 bit 标记选哪一支。
- **③ 分支**：根据 ② 决定走哪一支编码（S-TMSI 或纯随机数）。
- **④ ENUMERATED**：建立原因有 8 种 → 3 bit。
- **⑤ Spare**：填到字节边界。

**类比 protobuf 的 oneof**：UE ID 这个 CHOICE 就像 oneof，但 protobuf 用 tag 区分；PER 用一个 1 bit 索引区分（更省）。

## 5. 第三个例子：SIB1（带可选字段）

SIB1（System Information Block Type 1）告诉 UE "本小区属于哪些 PLMN、TAC 是多少、有没有禁止接入"。pack 在 `liblte_rrc.cc:10758`，比 MIB 复杂，是窥探 PER **可选字段** 的好例子。

PER 处理可选字段的核心做法：**先在消息开头连续写若干 1 bit 标志位，每一位代表"后面某个可选 IE 在不在"**。如果不在，后面就直接跳过那个字段；如果在，按顺序写出来。

类比：相当于在消息开头放一个**位图**（bitmap）。

> 这就是为什么 RRC 必须按 BIT 处理：可选位是单比特，不能按字节对齐。

打开看：`liblte_rrc.cc:10758` 起的 `liblte_rrc_pack_sys_info_block_type_1_msg`。你会看到一上来就是若干 `liblte_value_2_bits(... 1)` 的"是否存在"标志，然后才是各个 IE 的内容。

## 6. RRC 消息分类：BCCH / PCCH / CCCH / DCCH

LTE RRC 消息按"承载它的逻辑信道"分类：

| 信道 | 方向 | 用途 | 容器结构体 |
|---|---|---|---|
| **BCCH-BCH** | 下行广播 | 只装 MIB | `LIBLTE_RRC_BCCH_BCH_MSG_STRUCT` |
| **BCCH-DLSCH** | 下行广播 | SIB1 / SI（SIB2..SIB13 的容器） | `LIBLTE_RRC_BCCH_DLSCH_MSG_STRUCT` |
| **PCCH** | 下行寻呼 | Paging | `LIBLTE_RRC_PCCH_MSG_STRUCT` |
| **CCCH (UL)** | 上行公共 | RRCConnectionRequest 等 | `LIBLTE_RRC_UL_CCCH_MSG_STRUCT` |
| **CCCH (DL)** | 下行公共 | RRCConnectionSetup 等 | `LIBLTE_RRC_DL_CCCH_MSG_STRUCT` |
| **DCCH (UL)** | 上行专用 | RRCConnectionSetupComplete、Measurement Report、UL NAS Transfer | `LIBLTE_RRC_UL_DCCH_MSG_STRUCT` |
| **DCCH (DL)** | 下行专用 | RRCConnectionReconfiguration、Security Mode Command、DL NAS Transfer | `LIBLTE_RRC_DL_DCCH_MSG_STRUCT` |

每个容器是一个 ASN.1 CHOICE：里面装的是若干个具体消息中的一个。打包时也是先写一个 CHOICE 选择子（n 比特），再写选中的消息。

**类比**：BCCH-BCH 像 UDP 广播；DCCH 像 TCP 长连接。

代码层面的"分发器"在 `liblte_rrc.cc` 末尾的 `liblte_rrc_pack_dl_ccch_msg / pack_ul_dcch_msg / ...` 等函数（搜 `pack_dl_ccch_msg` 即可定位，本仓库为 13447 行附近）。它们读出 CHOICE 索引后调用对应的具体消息 pack 函数。

## 7. NAS 走的是 DL/UL DCCH（重要桥梁）

控制面顶层的 NAS 消息**没有自己的物理通道**——它被 RRC 的 `DL/UL Information Transfer` 消息当成 octet string 透传。

具体说：
- **下行**：MME → eNodeB（OpenLTE 内部）→ PDCP → RLC → MAC → PHY，被包在 `RRC: DLInformationTransfer { dedicatedInfoNAS }` 里。
- **上行**：UE → PHY → MAC → RLC → PDCP → eNodeB → MME，被包在 `RRC: ULInformationTransfer { dedicatedInfoNAS }` 里。

`dedicatedInfoNAS` 是一个 OCTET STRING——**RRC 不解析它**，把字节流直接丢给 NAS 层。这意味着：
- RRC 看到的"NAS 字段"在 PER 比特流里是 8 比特对齐的字节序列（PER 的 OCTET STRING 编码会先做对齐）。
- NAS 拿到字节流后**自己再用字节级 TLV 编解码**——这就是 04 篇的内容。

## 8. RRC 在 OpenLTE 中的运行流程（与 03 篇相关的部分）

仅看与"消息编解码"挂钩的那部分（状态机本身留到 05 篇）：

```
                                    LTE_fdd_enb_rrc.cc
   PDCP/MAC 上来的字节  --->  N_bits 字段填好的 LIBLTE_BIT_MSG_STRUCT
                              ↓
                    liblte_rrc_unpack_xxx_msg() in liblte_rrc.cc
                              ↓
                    具体的结构体 LIBLTE_RRC_xxx_STRUCT
                              ↓
                    RRC 子系统决策（状态切换、配置下层）
                              ↓
                    填充另一个 LIBLTE_RRC_yyy_STRUCT
                              ↓
                    liblte_rrc_pack_yyy_msg() in liblte_rrc.cc
                              ↓
                    LIBLTE_BIT_MSG_STRUCT  --->  下发给 PDCP
```

也就是说：**`liblte_rrc.cc` 是纯函数式 codec；`LTE_fdd_enb_rrc.cc` 是流程驱动者。**

## 9. 自己练手——三步走

1. **手算一条 MIB**：找一个小区配置（比如带宽 5MHz=n25, PHICH normal+1/6, SFN=80），自己写出 24 bit 的 MIB，再去和 `liblte_rrc.cc:12966` 对照。
2. **拆一条 RRCConnectionRequest**：用 Wireshark 抓一条 LTE-RRC（mac-lte-framed）流量，按 §4 的字段顺序逐 bit 拆。
3. **加 print 跟读**：往 `liblte_value_2_bits` 里加一行 `printf`，编译跑 `LTE_fdd_dl_file_scan` 喂测试 IQ，看 SIB1/SIB2 真实地被一比特一比特拼出来。

## 10. 进阶：不在 OpenLTE 中但你应该知道

OpenLTE 的 PER 实现是**简化版**——只覆盖了 36.331 的核心消息。商用网络更复杂的几个特性 OpenLTE 没动：
- **扩展形态（ext + length determinant）**：当 ASN.1 类型加了新字段，PER 通过扩展位 + 长度前缀向后兼容。本仓库基本只 pack `ext=0`。
- **大整数 / 大长度**：PER 对 >65535 的长度有特殊编码，本仓库实际不会遇到。
- **subset constraints**、**parameterized types**：没用上。

如果将来要看商用 RRC 包（包括 R10+ 的 CA、双连接、5G NSA 标志），可能会撞上扩展形态。但 OpenLTE 已经能让你把 R8 R9 的核心吃透。

---

下一篇：`04_NAS与TLV.md` —— 离开 RRC 的比特世界，回到字节对齐的 NAS。
