# ASN.1 PER 与 RRC 编解码

> 这是全书最重的一章。入门级第三章你已经知道"RRC 消息在空口上是按比特紧凑编码的"；本章我们直接打开 `liblte_rrc.cc` 这个一万三千行的文件，把它的编码原理、骨架结构和三条代表性消息全部拆开。读完你应该能做到两件事：拿一支笔在纸上把一条 MIB 或 RRCConnectionRequest 逐比特拆出来；改代码给某条 RRC 消息加一个字段而不破坏整条消息。

## 1. uPER 规则速成：把它当成"超紧凑的 protobuf"

36.331 用 ASN.1 描述 RRC 消息的结构，但空口上传的是 **PER（Packed Encoding Rules）** 编码后的比特流，OpenLTE 处理的是其中的 **unaligned 变种（uPER）**——字段之间**不向字节边界对齐**，一个 3 比特字段紧跟着一个 5 比特字段，正好填满一字节，零浪费。

你熟悉的 protobuf 是 `(tag, type, length, value)` 的字节流：每个字段都要自报家门。uPER 的思路完全相反——**schema（ASN.1 定义）双方都有，凡是能从 schema 推断的信息全部不传输**：

| protobuf 里要传的东西 | uPER 里怎么办 |
|---|---|
| tag（字段编号） | 不传。字段顺序由 ASN.1 定义固定，按顺序读 |
| length（字段长度） | 多数不传。有界整数 `INTEGER (a..b)` 直接用 ⌈log2(b−a+1)⌉ 比特 |
| 字段类型 | 不传。双方都知道 |
| oneof 选了哪一支 | 传一个 ⌈log2(分支数)⌉ 比特的 **choice 选择子** |
| optional 字段在不在 | 传 1 比特的**存在标志**（preamble 位图） |

额外的三条规则，后面代码里会反复出现：

- **extension bit（扩展位）**：ASN.1 类型带 `...`（可扩展标记）时，PER 先写 1 个比特表示"本条消息是否使用了扩展形态"。OpenLTE 永远写 0，即只用 Release 8/9 的基础形态。
- **optional bitmap（可选位图）**：一个 SEQUENCE 里有 N 个 OPTIONAL/DEFAULT 字段，就在正文字段之前先连续写 N 个比特，每个比特是一个字段的"在不在"。
- **有界整数直接用最短比特数**：比如 `ENUMERATED {n6, n15, n25, n50, n75, n100, spare2, spare1}` 共 8 个值，3 比特搞定，没有填充。

一句话记忆：**uPER = 双方共享 schema 的前提下，按定义顺序往一根比特流里塞值，能省的全省**。代价是解码方必须严格按同一顺序读——错一位，后面全错位。这也是为什么本章后面要反复强调"pack 和 unpack 必须逐行对称"。

OpenLTE 没有用 `asn1c` 这类代码生成器，整个 PER 编解码是**手工写的 C 代码**。对读代码的人这是好事：所有规则都摊在你面前，没有生成器的黑盒。

## 2. 比特工具层：整个 codec 的"加法器"

### 2.1 容器：一个字节存一个比特

RRC 消息的容器定义在 `liblte/hdr/liblte_common.h:68-71`：

```c
typedef struct{
    uint32 N_bits;
    uint8  msg[LIBLTE_MAX_MSG_SIZE];   // LIBLTE_MAX_MSG_SIZE = 5512，见 liblte_common.h:54
}LIBLTE_BIT_MSG_STRUCT;
```

注意一个反直觉的设计：**`msg` 数组里一个字节只存一个比特**（值是 0 或 1）。也就是说一条 24 比特的 MIB 在内存里占 24 个字节。这浪费内存，但换来极大的编码便利：第 i 个比特就是 `msg[i]`，不用做位运算定位。与之对照，NAS 层用的 `LIBLTE_BYTE_MSG_STRUCT`（`liblte/hdr/liblte_common.h:73-76`）才是"一字节就是一字节"的字节容器。**在 OpenLTE 里看到 `BIT_MSG` 就是空口/RRC，看到 `BYTE_MSG` 就是 NAS**——这个习惯能让你在读代码时立刻定位自己在协议栈的哪一层。

### 2.2 value_2_bits / bits_2_value：MSB-first 怎么落进数组

整个 `liblte_rrc.cc` 一万三千行，本质上就是反复调用这两个函数。先纠正一个容易找错的地方：它们**不在** `liblte_interface.cc`（那个文件只有 205 行，装的是 EARFCN 与频率互转的查表函数），而是在 `liblte/src/liblte_common.cc:62-93`：

```c
// liblte/src/liblte_common.cc:62-73
void liblte_value_2_bits(uint32   value,
                         uint8  **bits,
                         uint32   N_bits)
{
    uint32 i;
    for(i=0; i<N_bits; i++)
        (*bits)[i] = (value >> (N_bits-i-1)) & 0x1;   // ①
    *bits += N_bits;                                   // ②
}

// liblte/src/liblte_common.cc:80-93
uint32 liblte_bits_2_value(uint8  **bits,
                           uint32   N_bits)
{
    uint32 value = 0, i;
    for(i=0; i<N_bits; i++)
        value |= (*bits)[i] << (N_bits-i-1);           // ③
    *bits += N_bits;
    return(value);
}
```

逐行拆这三个关键点：

- **① MSB-first**：`value >> (N_bits-i-1)` 先取最高位。`value=0b101, N_bits=3` 写出来是 `[1,0,1]`，最高有效位在数组低下标处。uPER 规范就是 MSB-first 的，这里严丝合缝。
- **② 游标前进**：参数是 `uint8 **bits`——指针的指针。函数写完 N 个比特后把调用者的指针**向前推 N 格**，下一次调用天然接着写。你可以把它理解成 `fwrite` 内部维护的文件偏移：pack 函数从头到尾不需要自己算偏移量。
- **③ 镜像操作**：unpack 侧用同样的 MSB-first 顺序把比特拼回整数，同样推进游标。

理解了这两个函数，你就拿到了整个 RRC codec 的钥匙：后面所有的 pack 函数都是"按 schema 顺序，对结构体每个字段调一次 `value_2_bits`（或调用更小的 IE pack 函数）"，unpack 完全镜像。

还有一个全局变量要认识：`liblte/src/liblte_rrc.cc:94` 的 `LIBLTE_BIT_MSG_STRUCT global_msg;`。信道级 pack 函数先把具体消息 pack 进这个全局缓冲区，再 `memcpy` 拼到外层比特流——后面第 4 节会看到它怎么用。

## 3. 实战一：MIB——24 比特逐字段手工拆解

MIB（Master Information Block）是 eNodeB 每 40 ms 在 PBCH 上广播一次的最小消息，总共 **24 比特**，是 PER 编码的"Hello World"。

### 3.1 结构体

`liblte/hdr/liblte_rrc.h:6598-6602`：

```c
typedef struct{
    LIBLTE_RRC_PHICH_CONFIG_STRUCT phich_config;
    LIBLTE_RRC_DL_BANDWIDTH_ENUM   dl_bw;
    uint8                          sfn_div_4;
}LIBLTE_RRC_MIB_STRUCT;
```

带宽枚举在 `liblte/hdr/liblte_rrc.h:6583-6593`：`LIBLTE_RRC_DL_BANDWIDTH_6/15/25/50/75/100` 分别对应 1.4/3/5/10/15/20 MHz（数字是 RB 数），外加两个 spare，共 8 个值 → 3 比特。PHICH 配置结构体在 `liblte/hdr/liblte_rrc.h:2589-2592`，两个字段：`dur`（1 比特，Normal=0/Extended=1）和 `res`（2 比特，1/6、1/2、1、2 倍四选一）。

### 3.2 pack 代码逐行讲

`liblte/src/liblte_rrc.cc:12966-12994` 的 `liblte_rrc_pack_bcch_bch_msg`：

```c
// DL Bandwidth
liblte_value_2_bits(mib->dl_bw, &msg_ptr, 3);              // ① 3 bit

// PHICH Config
liblte_rrc_pack_phich_config_ie(&mib->phich_config, &msg_ptr); // ② 1+2=3 bit

// SFN/4
liblte_value_2_bits(mib->sfn_div_4, &msg_ptr, 8);          // ③ 8 bit

// Spare
liblte_value_2_bits(0, &msg_ptr, 10);                      // ④ 10 bit

msg->N_bits = msg_ptr - msg->msg;                          // ⑤ 收尾
```

- **①** 带宽枚举直接落 3 比特。这正是"有界整数最短比特数"规则：8 个枚举值，3 比特，没有别的开销。
- **②** PHICH 是个小 SEQUENCE，复用 IE 级 pack 函数 `liblte_rrc_pack_phich_config_ie`（`liblte/src/liblte_rrc.cc:6470-6485`），内部就两行：`dur` 写 1 比特、`res` 写 2 比特。注意 IE 函数的签名是 `uint8 **ie_ptr`——游标照样被推进。
- **③** `sfn_div_4` 是系统帧号 SFN 的**高 8 位**（SFN 共 10 位，低 2 位由 PBCH 的 40 ms 周期隐式给出，这是物理层的事，RRC 只管这 8 位）。
- **④** 规范里 MIB 固定 24 比特，前面只用了 14 比特，剩下 10 比特是 spare，写 0。
- **⑤** `msg_ptr - msg->msg` 得到用过的总比特数填回 `N_bits`。3+3+8+10 = 24，恒等。

unpack（`liblte/src/liblte_rrc.cc:12995-13017`）是完全镜像：`bits_2_value(&msg_ptr, 3)` 读带宽、调 `liblte_rrc_unpack_phich_config_ie`（`liblte/src/liblte_rrc.cc:6486-6501`）读 PHICH、再读 8 比特 SFN。**注意 unpack 根本不读那 10 个 spare 比特**——反正恒为 0，游标推不推到底无所谓，调用方只看前 14 比特。

### 3.3 字段布局表与纸上练习

对照 36.331 的 `MasterInformationBlock` 定义，24 比特布局如下：

| 字段 | 比特数 | 含义 | 代码位置 |
|---|---|---|---|
| `dl-Bandwidth` | 3 | 下行带宽枚举（n6..n100） | `liblte_rrc.cc:12976` |
| `phich-Config.duration` | 1 | PHICH 时长 | `liblte_rrc.cc:6478` |
| `phich-Config.resource` | 2 | PHICH 资源组倍数 | `liblte_rrc.cc:6479` |
| `systemFrameNumber` | 8 | SFN 高 8 位 | `liblte_rrc.cc:12982` |
| `spare` | 10 | 保留，恒 0 | `liblte_rrc.cc:12985` |

**纸上练习**：带宽 5 MHz（n25 → 枚举值 2 = `010`）、PHICH normal + 1/6（`0`、`00`）、SFN = 512（÷4 = 128 = `10000000`）。拼出来就是 `010 0 00 10000000 0000000000`，24 比特，收工。把这条比特流喂给 unpack，应当原样还原。这就是 PER 的本质：没有 tag、没有 length，schema 顺序 + 固定宽度就是全部。

## 4. 实战二：BCCH-DL-SCH——SIB1 与 systemInformation 的 choice

### 4.1 信道级容器是一个 CHOICE

MIB 之上，广播消息走 BCCH-DL-SCH 信道，容器是 `LIBLTE_RRC_BCCH_DLSCH_MSG_STRUCT`——它在 `liblte/hdr/liblte_rrc.h:6621` 直接 typedef 成 `LIBLTE_RRC_SYS_INFO_MSG_STRUCT`，即一个 SIB 数组（`sibs[]` + `N_sibs`，见 `liblte/hdr/liblte_rrc.h:5811-5818`）。

ASN.1 里 `BCCH-DL-SCH-Message` 的 message 是个二选一 CHOICE：`systemInformationBlockType1` 或 `systemInformation`。看 pack 的分发逻辑，`liblte/src/liblte_rrc.cc:13028-13074`：

```c
// Extension indicator
liblte_value_2_bits(ext, &msg_ptr, 1);              // ① 扩展位，恒 0

if(LIBLTE_RRC_SYS_INFO_BLOCK_TYPE_1 == bcch_dlsch_msg->sibs[0].sib_type)
{
    // SIB1 Choice
    liblte_value_2_bits(1, &msg_ptr, 1);            // ② choice 选择子：SIB1 分支
    err = liblte_rrc_pack_sys_info_block_type_1_msg(... &global_msg);  // ③
    ...
    memcpy(msg_ptr, global_msg.msg, global_msg.N_bits);                // ④
    msg->N_bits = global_msg.N_bits + 2;
}else{
    // SIB1 Choice
    liblte_value_2_bits(0, &msg_ptr, 1);            // choice 选择子：SI 分支
    err = liblte_rrc_pack_sys_info_msg(bcch_dlsch_msg, &global_msg);
    ...
}
```

- **①** 扩展位：BCCH-DL-SCH-Message 的 ASN.1 定义带 `...`，所以先写 1 比特，恒 0。
- **②** choice 选择子：两个分支 → 1 比特。这里有个容易看晕的细节：**SIB1 分支写 1，SI 分支写 0**。原因是 ASN.1 里这个 CHOICE 的第二个分支（`systemInformation`）是扩展组外的常规分支但 SIB1 排在 choice 的扩展区之后……不必纠结，你只要记住**代码里用 `sibs[0].sib_type` 判分支、比特值与 36.331 的 CHOICE 索引一致**即可。这也是手工 PER 的典型坑：选择子比特值必须和规范的分支顺序严格对应。
- **③** 具体消息先 pack 进全局缓冲 `global_msg`。
- **④** 再 `memcpy` 拼到外层，总比特数 = 内层比特数 + 2（扩展位 + 选择子各 1 比特）。前面还有边界检查：`global_msg.N_bits <= LIBLTE_MAX_MSG_SIZE - 2`，防止溢出。

unpack（`liblte/src/liblte_rrc.cc:13075-13114`）镜像：先读 2 个比特判分支，然后把**剩余比特**整个拷进 `global_msg` 交给对应的 unpack 函数。SIB1 的 unpack 还会通过 `N_bits_used` 出参告诉外层"我用了多少比特"（`liblte/src/liblte_rrc.cc:13098-13101`），方便外层推进游标——这是处理"消息嵌套消息"时的通用手法。

### 4.2 SIB1：optional bitmap 的完整示范

SIB1 的 pack 在 `liblte/src/liblte_rrc.cc:10758-10848`，它比 MIB 复杂得多，是学习 **optional bitmap** 的最佳样本。开头三行就是位图：

```c
// liblte/src/liblte_rrc.cc:10773-10776
// Optional indicators
liblte_value_2_bits(sib1->p_max_present, &msg_ptr, 1);   // p-Max 在不在
liblte_value_2_bits(sib1->tdd,           &msg_ptr, 1);   // tdd-Config 在不在
liblte_value_2_bits(non_crit_ext_opt,    &msg_ptr, 1);   // nonCriticalExtension 在不在
```

三个 OPTIONAL 字段 → 消息开头先连续写 3 个比特。后面的正文按序展开，遇到可选字段就查对应的标志位决定写不写：

```c
// liblte/src/liblte_rrc.cc:10804-10808
// P Max
if(true == sib1->p_max_present)
{
    liblte_rrc_pack_p_max_ie(sib1->p_max, &msg_ptr);
}
```

除了可选位图，SIB1 还演示了另外两种 PER 惯用法，都在 `liblte/src/liblte_rrc.cc:10778-10836`：

- **嵌套的可选位图**：`cellAccessRelatedInfo` 这个子 SEQUENCE 内部又有自己的可选字段 `csg-Identity`，所以正文里先写 `csg_id_opt` 这 1 比特（`:10779`），后面再按标志决定写不写 `csg_id`（`:10791-10794`）。可选位图是可以随 SEQUENCE 嵌套出现的。
- **长度字段偏移编码**：`N_plmn_ids - 1` 写 3 比特（`:10780`）。ASN.1 定义 `plmn-IdentityList` 是 `SEQUENCE (SIZE(1..6))`，6 个取值 → 3 比特，且 PER 对有界 SIZE 编码的是 `(实际值 − 下界)`。unpack 侧 `liblte_bits_2_value(&msg_ptr, 3) + 1`（`:10874`）加回来。**pack 减 1、unpack 加 1，是全书出现频率最高的一对模式**（`freq_band_indicator` 的 `:10811` 减 1 / `:10914` 加 1，`N_sched_info` 的 `:10814` / `:10917`，都是同一个套路）。

SIB1 完整字段布局（对照 36.331 的 `SystemInformationBlockType1`）：

| 字段 | 比特数 | 说明 |
|---|---|---|
| optional bitmap | 3 | p-Max / tdd-Config / nonCriticalExtension 的存在标志 |
| `cellAccessRelatedInfo.csg` 标志 | 1 | csg-Identity 存在标志 |
| PLMN 列表长度 | 3 | `(N−1)`，SIZE(1..6) |
| 每个 PLMN | 可变 | PLMN identity IE + 1 比特 reservedForOperatorUse |
| `trackingAreaCode` | 16 | TAC |
| `cellIdentity` | 28 | 小区 ID |
| `cellBarred` / `intraFreqReselection` / `csg-Indication` | 1+1+1 | 三个布尔 |
| `q-RxLevMin` 及可选 offset | 可变 | 小区选择门限 |
| `freqBandIndicator` | 6 | `(band−1)`，INTEGER (1..64) |
| `schedulingInfoList` | 可变 | 长度 5 比特 + 每项 periodicity 3 比特 + SIB 映射 |
| `si-WindowLength` | 3 | SI 窗口 |
| `systemInfoValueTag` | 5 | 值标签，UE 用它判断 SIB 是否更新 |

unpack 侧（`liblte/src/liblte_rrc.cc:10849-10957`）请你自己打开对照——它和 pack 逐行同构，连注释都一样，这正是手工 codec 的理想形态。注意 `:10945-10948` 的 `nonCriticalExtension` 分支是个 `FIXME`：OpenLTE 不处理非关键扩展。这在真实网络里通常无碍，但你要知道**它没实现**，别指望靠它解 R10+ 的新字段。

## 5. 实战三：RRCConnectionRequest / RRCConnectionSetup

### 5.1 UL-CCCH 分发器

UE 发起的 RRCConnectionRequest 走上行 CCCH。信道容器 `LIBLTE_RRC_UL_CCCH_MSG_STRUCT`（`liblte/hdr/liblte_rrc.h:6787-6790`）是"`msg_type` 枚举 + 消息 union"，union 里只有两种消息（`liblte/hdr/liblte_rrc.h:6783-6786`）。pack 分发器在 `liblte/src/liblte_rrc.cc:13426-13462`：

```c
liblte_value_2_bits(ext, &msg_ptr, 1);                 // 扩展位
liblte_value_2_bits(ul_ccch_msg->msg_type, &msg_ptr, 1); // 2 个分支 → 1 比特选择子

if(LIBLTE_RRC_UL_CCCH_MSG_TYPE_RRC_CON_REEST_REQ == ul_ccch_msg->msg_type)
    err = liblte_rrc_pack_rrc_connection_reestablishment_request_msg(... &global_msg);
else  // RRC_CON_REQ
    err = liblte_rrc_pack_rrc_connection_request_msg(... &global_msg);

memcpy(msg_ptr, global_msg.msg, global_msg.N_bits);    // 拼上外层
msg->N_bits = global_msg.N_bits + 2;
```

和第 4 节 BCCH 的骨架一模一样：**扩展位 → choice 选择子 → 内层消息进 global_msg → memcpy 拼装**。这个五件套骨架在 `pack_dl_ccch_msg`（`:13185`）、`pack_dl_dcch_msg`（`:13275`）、`pack_ul_dcch_msg`（`:13504`）里原样重复，唯一变化是选择子的比特数——取决于各自信道 CHOICE 的分支数：

| 信道容器 | 分支数 | 选择子比特 | pack 入口 |
|---|---|---|---|
| UL-CCCH | 2 | 1 | `liblte_rrc.cc:13426` |
| DL-CCCH | 4 | 2 | `liblte_rrc.cc:13185` |
| UL-DCCH | 16 | 4 | `liblte_rrc.cc:13504` |
| DL-DCCH | 12 | 4 | `liblte_rrc.cc:13275` |

这个表值得你记住：⌈log2(分支数)⌉ 就是选择子宽度，它和头文件里各 `MSG_TYPE_ENUM` 的 `N_ITEMS` 一一对应（如 `liblte/hdr/liblte_rrc.h:6673-6679` 的 DL-CCCH 4 项、`6712-6726` 的 DL-DCCH 12 项）。改代码加消息类型时，先算这个数。

### 5.2 RRCConnectionRequest：一条 48 比特的消息

消息体 pack 在 `liblte/src/liblte_rrc.cc:11596-11638`：

```c
// Extension choice
liblte_value_2_bits(ext, &msg_ptr, 1);                 // ①

if(!ext)
{
    // UE Identity Type
    liblte_value_2_bits(con_req->ue_id_type, &msg_ptr, 1);  // ② CHOICE 选择子

    // UE Identity
    if(LIBLTE_RRC_CON_REQ_UE_ID_TYPE_S_TMSI == con_req->ue_id_type)
    {
        liblte_rrc_pack_s_tmsi_ie(...);                 // ③a 8+32 = 40 bit
    }else{ // RANDOM_VALUE
        liblte_value_2_bits((uint32)(con_req->ue_id.random >> 32), &msg_ptr, 8);
        liblte_value_2_bits((uint32)(con_req->ue_id.random),       &msg_ptr, 32);  // ③b 40 bit
    }

    // Establishment Cause
    liblte_value_2_bits(con_req->cause, &msg_ptr, 3);   // ④

    // Spare
    liblte_value_2_bits(0, &msg_ptr, 1);                // ⑤
}
```

- **①** `criticalExtensions` 这个 CHOICE 在 ASN.1 里是可扩展的，OpenLTE 恒写 0 走 `rrcConnectionRequest-r8` 分支。
- **②** `ue-Identity` 是 CHOICE：`s-TMSI` 或 `randomValue`，1 比特选择子。枚举定义在 `liblte/hdr/liblte_rrc.h:5945-5949`。
- **③a/③b** 两条分支恰好都是 40 比特：S-TMSI = MMEC（8 比特，`liblte/src/liblte_rrc.cc:655`）+ M-TMSI（32 比特，`:938`）；randomValue 是 40 比特随机数，因为 `value_2_bits` 只吃 `uint32`，拆成高 8 位 + 低 32 位两次写。**这是手工 codec 的一个实现细节：大于 32 比特的字段要手动分段**，unpack 侧 `:11660-11661` 用移位拼回 `uint64`。
- **④** 建立原因 8 个枚举值（emergency、mo-Data 等，定义在 `liblte/hdr/liblte_rrc.h:5952-5962`）→ 3 比特。
- **⑤** 1 比特 spare 补齐到字节边界：1+1+40+3+1 = 46？不对——这是**消息体**。加上 UL-CCCH 外层的 2 比特（扩展位 + 选择子），总计 1+1+1+40+3+1 = 47……仍然不是 8 的倍数。实际上 36.331 的 RRCConnectionRequest 正文就是 46 比特加外层 2 比特共 48 比特 = 6 字节。自己算一遍：**ext(1) + ue_id_type(1) + id(40) + cause(3) + spare(1) = 46**，外层 UL-CCCH 头 2 比特，合计 48，正好 6 字节——spare 那 1 比特就是为了凑齐这个对齐。这也回答了"spare 为什么是 1 比特而不是别的宽度"。

字段布局表（对照 36.331 的 `RRCConnectionRequest`）：

| 字段 | 比特数 | 含义 |
|---|---|---|
| criticalExtensions 选择 | 1 | 恒 0（r8 分支） |
| ue-Identity 选择子 | 1 | 0=s-TMSI，1=randomValue |
| ue-Identity | 40 | S-TMSI（MMEC 8 + M-TMSI 32）或 40 比特随机值 |
| establishmentCause | 3 | 8 个枚举值 |
| spare | 1 | 字节对齐 |

unpack（`:11639-11672`）完全镜像，不再赘述。结构体在 `liblte/hdr/liblte_rrc.h:5976-5980`：`ue_id` 是个 union（S-TMSI 结构体 / `uint64 random`），`ue_id_type` 决定读哪个成员——C 的 union + 判别标签，就是 ASN.1 CHOICE 最自然的落地方式。

### 5.3 RRCConnectionSetup：多层 choice 与 optional 的叠放

下行方向，eNodeB 回 RRCConnectionSetup（走 DL-CCCH，选择子写 2 比特，`:13199`）。消息体 pack 在 `liblte/src/liblte_rrc.cc:11524-11556`：

```c
// RRC Transaction ID
liblte_rrc_pack_rrc_transaction_identifier_ie(con_setup->rrc_transaction_id, &msg_ptr); // ① 2 bit

// Extension choice
liblte_value_2_bits(0, &msg_ptr, 1);                   // ② criticalExtensions 是否走扩展

// C1 choice
liblte_value_2_bits(0, &msg_ptr, 3);                   // ③ c1 这个 CHOICE 的选择子

// Optional indicator
liblte_value_2_bits(0, &msg_ptr, 1);                   // ④ r8 分支内 nonCriticalExtension 位图

// Radio Resource Config Dedicated
liblte_rrc_pack_rr_config_dedicated_ie(&con_setup->rr_cnfg, &msg_ptr);  // ⑤ 正文
```

这条消息把嵌套选择展现得很清楚：

- **①** RRC Transaction Identifier，INTEGER (0..3) → 2 比特（`:897`）。它是 RRC 层的"请求-响应配对序号"，作用类似你熟悉的 RPC request id。
- **②③** `criticalExtensions` 先写 1 比特扩展标志，内部的 `c1` CHOICE 有 8 个分支（rrcConnectionSetup-r8 只是其一）→ 3 比特选择子，恒写 0。注意**选择子宽度跟着分支数走**：UL-CCCH 顶层 2 分支用 1 比特，这里 8 分支用 3 比特。
- **④** r8 分支 SEQUENCE 里唯一的 OPTIONAL 字段是 `nonCriticalExtension`，所以位图只有 1 比特，恒 0。
- **⑤** 正文 `radioResourceConfigDedicated` 是整个无线承载配置（SRB1 的 RLC/MAC/物理层参数），本身又是一个庞大的 IE，pack 在 `:7382` 附近调用同一批工具函数展开——你现在已经能自己读下去了。

到这里你可以把三层壳穿起来：**DL-CCCH 头（ext 1 + 选择子 2）→ RRCConnectionSetup 头（事务 id 2 + ext 1 + c1 选择子 3 + 位图 1）→ RadioResourceConfigDedicated 正文**。每一层都是同一个套路的递归。

## 6. 新增/修改一条 RRC 消息的 checklist

假设你要给某条消息加一个字段，或者新增一条消息类型。按这个顺序做，每步都有明确的落点：

1. **改头文件结构体**：`liblte/hdr/liblte_rrc.h`。找到对应的 `..._STRUCT`（用消息名搜，整个头文件按消息分节，每节有 `Document Reference: 36.331 v10.0.0 Section X.X.X` 注释）。加字段时注意：如果是新枚举值，同步更新旁边的 `..._text[]` 打印表（如 `liblte_rrc_dl_bandwidth_text`，`:6594`），否则调试打印会错位。
2. **改 pack**：`liblte/src/liblte_rrc.cc` 里对应的 `pack_..._msg/ie`。**严格按 36.331 的 ASN.1 字段顺序**插入 `liblte_value_2_bits` 调用；有界整数算好比特数 ⌈log2(b−a+1)⌉；SIZE(m..n) 记得写 `(N−m)`；OPTIONAL 字段先加位图比特、再在正文加 `if(present)` 分支。
3. **改 unpack**：与 pack **逐行镜像**，同一个位置、同样的比特数、`+1/−1` 偏移成对出现。改完把两个函数并排看一遍，行数应当几乎相同。
4. **若新增了消息类型**：更新信道容器的 `MSG_TYPE_ENUM`（加枚举项 + `_text` 表），重新算 choice 选择子宽度（⌈log2(分支数)⌉），同步改信道级 pack/unpack 的 `liblte_value_2_bits(msg_type, ...)` 比特数和 `if/else if` 分发链（参考 `:13199`、`:13242`）。
5. **测试**：写一个 pack→unpack 往返用例：填满结构体 → pack → 检查 `N_bits` 是否符合手算 → unpack 进另一个结构体 → 逐字段 `memcmp`。`liblte/tests/` 与 `liblte/manual_tests/` 下有现成的测试骨架可仿。能过往返，再抓真实空口数据（用 Wireshark 的 LTE-RRC 解析结果做 golden reference）验证字段顺序没搞反。

## 7. 常见坑

都是这份代码里真实存在或极易踩的：

- **比特序**：`value_2_bits` 是 MSB-first（`liblte_common.cc:70`）。如果你想当然按 LSB-first 在纸上拆，所有字段都是反的。抓包对照 Wireshark 时，Wireshark 展示的也是 MSB-first，先拿 MIB 这种 24 比特的小消息对齐手感。
- **"一字节一比特"≠线上字节流**：`LIBLTE_BIT_MSG_STRUCT.msg` 里一个 `uint8` 是一个比特（`liblte_common.h:68-71`）。把它 hex dump 出来和抓包字节流直接比是对不上的——要先 8 个一组拼回字节。别在联调时被这个坑一下午。
- **扩展位遗漏**：凡是 ASN.1 定义带 `...` 的类型，第一层就是 1 比特扩展标志。漏写/漏读 1 比特，后面**所有**字段错位，而且解码往往不报错——只是值全是垃圾。看代码时数清楚每个 `if(!ext)` 包住了什么（如 `:11609`）。
- **choice 选择子宽度算错**：宽度是 ⌈log2(分支数)⌉，不是"写 1 比特意思一下"。DL-DCCH 12 个分支用 4 比特（`:13275` 之后），UL-CCCH 2 个分支用 1 比特（`:13440`）。加分支时忘记加宽选择子，unpack 直接把正文头几个比特当类型读。
- **`−1/+1` 偏移不对称**：SIZE(1..N)、INTEGER(1..64) 这类下界非 0 的类型，pack 减下界、unpack 加下界（如 SIB1 的 `:10811` 与 `:10914`）。只改一边，字段恒差 1。
- **>32 比特字段**：`value_2_bits` 只接受 `uint32`。40 比特的 randomValue 分两段写（`:11620-11621`），64 比特的 IMSI 类字段同理。unpack 记得用 `uint64` 移位拼回（`:11660`），直接赋给 32 位变量就丢高位。
- **可选位图与正文脱节**：位图里标了"在"，正文 `if` 里忘了写（或反之），之后字段整体漂移。改代码时位图行和正文 `if` 行必须一起改——这也是 checklist 第 2、3 步强调"同一位置"的原因。

## 小结

- uPER 的本质：双方共享 schema，字段按固定顺序、最短比特数写入，不传 tag/length；`...` 类型先写 1 比特扩展位，OPTIONAL 字段用前置位图。
- 整个 OpenLTE RRC codec 建立在 `liblte_common.cc:62-93` 的 `liblte_value_2_bits`/`liblte_bits_2_value` 之上：MSB-first、游标自动前进、一字节存一比特。注意它们不在 `liblte_interface.cc`。
- 所有信道级 pack 共享同一骨架：扩展位 → choice 选择子（⌈log2(分支数)⌉ 比特）→ 内层消息 pack 进 `global_msg` → memcpy 拼装。UL/DL-CCCH/DCCH 四个分发器只有选择子宽度不同。
- MIB（24 比特）和 RRCConnectionRequest（正文 46 比特）是最适合纸上练习的两条消息；SIB1 是 optional bitmap 与嵌套位图的完整样本。
- 改消息的口诀：hdr 结构体 → pack → unpack 逐行镜像 → 选择子宽度与 `_text` 表 → pack/unpack 往返测试。
- 最容易出事的三个点：比特序（MSB-first）、扩展位漏 1 比特导致全线错位、`−1/+1` 偏移只改一边。
