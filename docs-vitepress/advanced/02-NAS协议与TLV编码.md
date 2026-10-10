# NAS 协议与 TLV 编码：liblte_mme 全线精读

RRC 那一套 ASN.1 PER 如果你已经啃下来了，NAS 会让你松一口气：没有比特级的对齐折磨，没有扩展位和长度子集，就是一套**字节对齐的 TLV 编码**。如果你写过 protobuf 的 wire format 解析，或者手工拆过 TCP 选项字段，NAS 的消息体对你来说就是"显式带 tag 的二进制结构体"。

本章把 `liblte/hdr/liblte_mme.h` 和 `liblte/src/liblte_mme.cc` 通读一遍，目标有两个：

- 给你一条 NAS 抓包字节流，你能手工解出来；
- 你要给 OpenLTE 加一个新的 IE 或新消息时，知道该改哪几处。

NAS 的规范是 3GPP 24.301，TLV 编码的通用规则在 24.007。源码里每个函数头上都有 `Document Reference` 注释标明对应的规范小节，读代码时可以顺手对照。

## NAS = EMM + ESM

NAS（Non-Access Stratum）是 UE 和 MME 之间的控制面协议，eNodeB 对它**只转发、不解释**（但 OpenLTE 把 eNodeB 和 MME 做在了一起，所以我们能在 `LTE_fdd_enodeb` 里直接看到 MME 侧的处理）。NAS 内部分两块：

- **EMM（EPS Mobility Management）**：移动性管理——附着、分离、鉴权、安全模式、跟踪区更新；
- **ESM（EPS Session Management）**：会话管理——PDN 连接、默认/专用承载的激活与释放。

类比一下：EMM 相当于"户籍科"（你是谁、你在哪），ESM 相当于"业务科"（给你办哪条数据通道）。两类消息共用一套帧格式，靠第一个字节的 **Protocol Discriminator（PD）** 区分，定义在 `liblte/hdr/liblte_mme.h:2611`：

```c
#define LIBLTE_MME_PD_EPS_SESSION_MANAGEMENT    0x2   // ESM
#define LIBLTE_MME_PD_EPS_MOBILITY_MANAGEMENT   0x7   // EMM
```

整个 `liblte_mme.cc` 有 12412 行，但结构极其规整：前半部分（`liblte/src/liblte_mme.cc:97` 起）是每个 IE 的 `pack/unpack` 函数对，后半部分（`liblte/src/liblte_mme.cc:5681` 起）是每条消息的 `pack/unpack` 函数对。消息的 pack/unpack 就是把若干 IE 的 pack/unpack 按顺序串起来——和你在应用层写 `serialize()` 时挨个字段写流是同一个套路。

## 帧头：第一个字节干两件事

NAS 帧的第一个字节同时装两个字段：

```
  7 6 5 4 | 3 2 1 0
+---------+---------+
|   SHT   |   PD    |
+---------+---------+
 高 4 位     低 4 位
```

低 4 位是上面说的 PD；高 4 位是 **Security Header Type（SHT）**，定义在 `liblte/hdr/liblte_mme.h:2613` 起：

| SHT 值 | 宏（`LIBLTE_MME_SECURITY_HDR_TYPE_*`） | 含义 |
|---|---|---|
| `0x0` | `PLAIN_NAS` | 明文 NAS，无保护 |
| `0x1` | `INTEGRITY` | 仅完整性保护 |
| `0x2` | `INTEGRITY_AND_CIPHERED` | 完整性 + 加密 |
| `0x3` | `INTEGRITY_WITH_NEW_EPS_SECURITY_CONTEXT` | 仅完整性，且启用新安全上下文 |
| `0x4` | `INTEGRITY_AND_CIPHERED_WITH_NEW_EPS_SECURITY_CONTEXT` | 完整性 + 加密，且启用新安全上下文 |
| `0xC` | `SERVICE_REQUEST` | Service Request 专用紧凑格式 |

实际抓包里你基本只会见到 `0`（鉴权前的 Attach Request、Authentication Request/Response）、`3`（Security Mode Command）、`2`（安全建立之后的一切）。

再往下是 Message Type 字节，一长串 `LIBLTE_MME_MSG_TYPE_*` 宏（`liblte/hdr/liblte_mme.h:2619` 起），常用的：

| 值 | 消息 | 值 | 消息 |
|---|---|---|---|
| `0x41` | Attach Request | `0x5D` | Security Mode Command |
| `0x42` | Attach Accept | `0x5E` | Security Mode Complete |
| `0x48` | Tracking Area Update Request | `0xC1` | Activate Default EPS Bearer Context Request |
| `0x52` | Authentication Request | `0xD0` | PDN Connectivity Request |
| `0x53` | Authentication Response | | |

全仓库唯一的消息头解析入口是 `liblte_mme_parse_msg_header`（`liblte/src/liblte_mme.cc:5632`），它把上面三种情况的分支写得很清楚：

```c
// Security Header Type
sec_hdr_type = (msg->msg[0] & 0xF0) >> 4;
// Protocol Discriminator
*pd = msg->msg[0] & 0x0F;
if(LIBLTE_MME_SECURITY_HDR_TYPE_SERVICE_REQUEST == sec_hdr_type) {
    *msg_type = LIBLTE_MME_SECURITY_HDR_TYPE_SERVICE_REQUEST;
}else{
    if(LIBLTE_MME_PD_EPS_SESSION_MANAGEMENT == *pd) {
        *msg_type = msg->msg[2];            // ESM：第 3 字节才是类型
    }else{
        if(LIBLTE_MME_SECURITY_HDR_TYPE_PLAIN_NAS == sec_hdr_type) {
            *msg_type = msg->msg[1];        // 明文 EMM：第 2 字节
        }else{
            *pd = msg->msg[6] & 0x0F;       // 受保护：跳过 6 字节外壳
            *msg_type = msg->msg[7];        // （ESM 则再 +1）
        }
    }
}
```

注意 `msg_type` 的位置随消息形态漂移：明文 EMM 在字节 1，受保护 EMM 在字节 7，ESM 还要再加 1。这正是下一节要讲的"三种形态"。

## 三种消息形态

### 形态一：plain NAS

SHT = 0，整帧就是 `[SHT|PD] [MsgType] [IE...]`。鉴权完成之前的消息（Attach Request、Authentication Request/Response、Identity Request/Response）都是明文。

### 形态二：security protected NAS

SHT ≠ 0 时，在真正的 NAS 消息外面套一个 6 字节的外壳：

```
+----------+----------------+--------+---------------------------+
| SHT | PD |  MAC (4 字节)  | Seq(1) | 内层完整 plain NAS 消息   |
+----------+----------------+--------+---------------------------+
   1 字节        4 字节        1 字节
```

MAC 是完整性校验值（33.401 定义的 EIA 算法，OpenLTE 用的是 EIA2 = AES-CMAC），Seq 是 NAS 序列号（COUNT 的低 8 位）。注意**内层是一条完整的 plain NAS**——它有自己的 `[SHT=0|PD] [MsgType]` 头。

封包侧的统一实现是 `liblte_mme_pack_security_protected_nas_msg`（`liblte/src/liblte_mme.cc:5681`）：

```c
if(LIBLTE_MME_SECURITY_HDR_TYPE_PLAIN_NAS != sec_hdr_type)
{
    *msg_ptr = (sec_hdr_type << 4) | (LIBLTE_MME_PD_EPS_MOBILITY_MANAGEMENT);
    msg_ptr++;
    msg_ptr += 4;               // 给 MAC 留 4 字节，稍后回填
    *msg_ptr = count & 0xFF;    // 序列号
    msg_ptr++;
}
// 原样拷贝内层 NAS 消息 ...
// 最后算 MAC，覆盖从 Seq 字节（msg[5]）开始的全部内容
liblte_security_128_eia2(&key_256[16], count, 0, direction,
                         &sec_msg->msg[5], sec_msg->N_bytes-5,
                         &sec_msg->msg[1]);   // MAC 写回字节 1..4
```

解包侧没有这个函数对应的 unwrap——每个消息的 unpack 自己处理外壳，套路完全一样，以 `liblte_mme_unpack_attach_request_msg` 为例（`liblte/src/liblte_mme.cc:6427`）：

```c
sec_hdr_type = (msg->msg[0] & 0xF0) >> 4;
if(LIBLTE_MME_SECURITY_HDR_TYPE_PLAIN_NAS == sec_hdr_type)
{
    msg_ptr++;        // 明文：跳 1 字节
}else{
    msg_ptr += 7;     // 受保护：跳 1 + 4(MAC) + 1(Seq) + 内层头 1 字节
}
msg_ptr++;            // 跳过内层 Message Type
```

"明文跳 1、加密跳 7"这个写法在全文出现了几十次，你读到第三次就会背了。

### 形态三：Service Request 特例

Service Request 为了省字节，不用通用格式。SHT = `0xC`，整帧只有 4 字节，见 `liblte_mme_pack_service_request_msg`（`liblte/src/liblte_mme.cc:8487`）：

```c
*msg_ptr = (LIBLTE_MME_SECURITY_HDR_TYPE_SERVICE_REQUEST << 4)
         | (LIBLTE_MME_PD_EPS_MOBILITY_MANAGEMENT);   // 字节 0：0xC7
liblte_mme_pack_ksi_and_sequence_number_ie(&service_req->ksi_and_seq_num, &msg_ptr); // 字节 1
liblte_mme_pack_short_mac_ie(service_req->short_mac, &msg_ptr);                      // 字节 2-3
```

字节 1 是 KSI（高 3 位）+ 序列号（低 5 位），见 `liblte_mme_pack_ksi_and_sequence_number_ie`（`liblte/src/liblte_mme.cc:2636`）；后 2 字节是 Short MAC。它没有 Message Type 字节——`parse_msg_header` 里那个 `*msg_type = SHT` 的特判（`liblte/src/liblte_mme.cc:5649`）就是为这种情况准备的。

## TLV/IEI 编码规则

从消息体开始，内容就是一串 **IE（Information Element）**。每个 IE 有四种格式（24.007）：

| 格式 | 布局 | 长度 | 有无 IEI |
|---|---|---|---|
| V | 值 | 固定 | 无 |
| LV | 长度 + 值 | 可变 | 无 |
| TV | IEI + 值 | 固定 | 有（1 字节） |
| TLV | IEI + 长度 + 值 | 可变 | 有（1 字节） |

外加一个特殊形态 **Type-1（half octet）**：IEI 和值各 4 位挤在一个字节里。帧头那个 `[SHT|PD]` 字节本身就是 Type-1 的写法。

对照 protobuf 理解：TLV ≈ protobuf 的 `(tag, length, value)`；V/LV ≈ 定长 packed 字段；Type-1 没有对应物。

关键规则是**强制 IE 与可选 IE 的分工**：

- **Mandatory IE**：必须出现、按 schema 定义的顺序排列、**不带 IEI**——靠位置识别，所以是 V 或 LV；
- **Optional IE**：可出可不出、**必须带 IEI**——靠 IEI 识别，所以是 TV 或 TLV。

这就是为什么 NAS 敢字节对齐：所有定位信息（IEI、长度）本身就占整字节。RRC 的 PER 追求空口上的极致压缩，连 IEI 这几个字节都舍不得花，才退到比特对齐；NAS 消息量小、频率低，用可读性和可扩展性换几个字节完全值得。你熟悉的对比就是：RRC 像 Cap'n Proto（零拷贝、无 tag、靠 schema），NAS 像 protobuf（带 tag、可自描述解析）。

IEI 的具体取值是消息相关的常量。以 Attach Request 为例，它的可选 IEI 定义在 `liblte/hdr/liblte_mme.h:2804` 起：

| IEI | 宏 | 格式 |
|---|---|---|
| `0x19` | `P_TMSI_SIGNATURE_IEI` | TV |
| `0x50` | `ADDITIONAL_GUTI_IEI` | TLV |
| `0x52` | `LAST_VISITED_REGISTERED_TAI_IEI` | TV |
| `0x5C` | `DRX_PARAMETER_IEI` | TV |
| `0x31` | `MS_NETWORK_CAPABILITY_IEI` | TLV |
| `0x9`（半字节） | `TMSI_STATUS_IEI` | Type-1 |
| `0xE`（半字节） | `GUTI_TYPE_IEI` | Type-1 |

Type-1 的 IEI 只占高 4 位，所以解码端的判断写法不一样（见下节代码里的 `<< 4` 再比高半字节）。

## 实战一：Attach Request 逐字节拆解

Attach Request（24.301 定义，消息类型 `0x41`）是 NAS 里最复杂的消息，几乎用尽了所有 IE 套路。它的 unpack 在 `liblte/src/liblte_mme.cc:6416`，骨架如下（删掉重复分支）：

```c
// 1. 帧头：SHT/PD（跳 1 或 7 字节，见上节）
sec_hdr_type = (msg->msg[0] & 0xF0) >> 4;              // :6427
// 2. 跳过 Message Type
msg_ptr++;                                             // :6436
// 3. 强制 IE ①：EPS Attach Type（低 4 位）+ NAS KSI（高 4 位），共 1 字节
liblte_mme_unpack_eps_attach_type_ie(&msg_ptr, 0, &attach_req->eps_attach_type); // :6439
liblte_mme_unpack_nas_key_set_id_ie(&msg_ptr, 4, &attach_req->nas_ksi);          // :6440
msg_ptr++;
// 4. 强制 IE ②：EPS Mobile Identity（LV）
liblte_mme_unpack_eps_mobile_id_ie(&msg_ptr, &attach_req->eps_mobile_id);        // :6444
// 5. 强制 IE ③：UE Network Capability（LV）
liblte_mme_unpack_ue_network_capability_ie(&msg_ptr, &attach_req->ue_network_cap); // :6447
// 6. 强制 IE ④：ESM Message Container（LV，内嵌一条 ESM 消息）
liblte_mme_unpack_esm_message_container_ie(&msg_ptr, &attach_req->esm_msg);      // :6450
// 7. 之后全是可选 IE：看一眼当前字节是不是认识的 IEI
if(LIBLTE_MME_P_TMSI_SIGNATURE_IEI == *msg_ptr) { ... }                  // :6453
if((LIBLTE_MME_TMSI_STATUS_IEI << 4) == (*msg_ptr & 0xF0)) { ... }       // :6513 Type-1
...
```

逐字段的字节布局：

| 偏移 | 字段 | 宽度 | 说明 |
|---|---|---|---|
| 0 | SHT \| PD | 1 字节 | 明文时固定 `0x07` |
| 1 | Message Type | 1 字节 | `0x41` |
| 2 | NAS KSI \| EPS Attach Type | 1 字节 | 高 4 位 = KSI（TSC 标志 + 3 位密钥序号），低 4 位 = attach 类型 |
| 3 | EPS Mobile ID 长度 | 1 字节 | LV 的 L |
| 4.. | EPS Mobile ID | 8 或 11 字节 | IMSI/IMEI 或 GUTI，见下 |
| .. | UE Network Capability | LV | 第 1 字节长度，之后是 EEA/EIA 算法位图 |
| .. | ESM Message Container | LV（2 字节长度） | 内嵌一条 PDN Connectivity Request |
| .. | 可选 IE 区 | TV/TLV/Type-1 | 按 IEI 逐个识别 |

几个值得停留的细节。

**第 2 字节是"一个半字节一个字段"的典型。** `liblte_mme_unpack_eps_attach_type_ie`（`liblte/src/liblte_mme.cc:2063`）就是一行 `(**ie_ptr >> bit_offset) & 0x07`；`liblte_mme_unpack_nas_key_set_id_ie`（`liblte/src/liblte_mme.cc:2781`）用 `bit_offset = 4` 取高半字节，其中 bit 7 是 TSC 标志、bit 6..4 是密钥序号。两个字段共享一个字节，谁也不越界——这是 NAS 里"字节对齐但不浪费半字节"的常见手法。

**EPS Mobile Identity 有三个分支**（IMSI / IMEI / GUTI），unpack 在 `liblte/src/liblte_mme.cc:2155`。先读长度字节，再看值域第一个字节的低 3 位（`type_of_id`）决定怎么解：

```c
length   = **ie_ptr;  *ie_ptr += 1;                 // LV 的 L
eps_mobile_id->type_of_id = **ie_ptr & 0x07;        // 低 3 位 = 身份类型
if(LIBLTE_MME_EPS_MOBILE_ID_TYPE_GUTI == eps_mobile_id->type_of_id)
{
    // GUTI：MCC(2 字节 nibble) + MNC(1~2 字节) + MME Group ID(2)
    //       + MME Code(1) + M-TMSI(4)
    eps_mobile_id->guti.mcc  = (**ie_ptr & 0x0F)*100;          // :2174
    eps_mobile_id->guti.mcc += ((**ie_ptr >> 4) & 0x0F)*10;
    ...
}else{
    // IMSI/IMEI：bit 3 是奇偶标志，之后每字节塞两个 BCD 数字
    id[0]    = **ie_ptr >> 4;                                 // :2213
    for(i=0; i<7; i++) {
        id[i*2+1]  = **ie_ptr & 0x0F;
        id[i*2+2]  = **ie_ptr >> 4;
        ...
    }
}
```

**UE Network Capability** 是 LV：长度字节之后，第 1 字节是 EEA0..EEA7 的支持位图、第 2 字节是 EIA0..EIA7 位图（`liblte/src/liblte_mme.cc:3692` 和 `:3701` 的 pack 侧是 8 行 `<< 7` 到 `<< 0`，一位一个算法）。eNodeB 侧收到后逐位存起来（`LTE_fdd_enodeb/src/LTE_fdd_enb_mme.cc:540`），后面 Security Mode Command 要选算法时就用这份位图。

## 实战二：Authentication Request/Response

这是最干净的 NAS 消息——全是定长强制 IE，没有任何 IEI 和长度字段。pack 在 `liblte/src/liblte_mme.cc:6753`：

```c
// ① [SHT=0|PD=7]
*msg_ptr = (LIBLTE_MME_SECURITY_HDR_TYPE_PLAIN_NAS << 4) | (LIBLTE_MME_PD_EPS_MOBILITY_MANAGEMENT);
// ② Message Type = 0x52
*msg_ptr = LIBLTE_MME_MSG_TYPE_AUTHENTICATION_REQUEST;
// ③ NAS KSI（低 4 位）+ spare（高 4 位）
*msg_ptr = 0;
liblte_mme_pack_nas_key_set_id_ie(&auth_req->nas_ksi, 0, &msg_ptr);
// ④ RAND：16 字节，V 格式，原样拷贝
liblte_mme_pack_authentication_parameter_rand_ie(auth_req->rand, &msg_ptr);
// ⑤ AUTN：16 字节，V 格式
liblte_mme_pack_authentication_parameter_autn_ie(auth_req->autn, &msg_ptr);
```

字段布局（24.301）：

| 字段 | 字节偏移 | 宽度 | 格式 | 含义 |
|---|---|---|---|---|
| SHT \| PD | 0 | 1 | Type-1 | 明文 EMM（`0x07`） |
| Message Type | 1 | 1 | V | `0x52` |
| spare \| NAS KSI | 2 | 1 | Type-1 | 密钥序号，7 表示"无安全上下文" |
| RAND | 3..18 | 16 | V | 鉴权随机数 |
| AUTN | 19..34 | 16 | V | 鉴权令牌（网络自证 + SQN） |

整帧定长 35 字节。给你一条以 `07 52` 开头、长度 35 的 NAS，闭着眼都知道怎么切。Authentication Response 同样简单，唯一区别是 RES 是 **LV**（长度字节 + 最多 16 字节的响应值），OpenLTE 里定死 8 字节（`liblte/src/liblte_mme.cc:1717`）。

## 实战三：Security Mode Command/Complete 与安全保护的开销

Security Mode Command 是"打开安全开关"的那条消息，它的 pack 在 `liblte/src/liblte_mme.cc:8007`。注意它的函数签名和前面不一样：

```c
LIBLTE_ERROR_ENUM liblte_mme_pack_security_mode_command_msg(
        LIBLTE_MME_SECURITY_MODE_COMMAND_MSG_STRUCT *sec_mode_cmd,
        uint8  sec_hdr_type,   // 外壳类型
        uint8 *key_256,        // 密钥（K_NASenc || K_NASint）
        uint32 count,          // NAS COUNT
        uint8  direction,
        LIBLTE_BYTE_MSG_STRUCT *msg)
```

凡是需要安全保护的消息，pack 函数都带这套参数。消息体本身（24.301）：

| 字段 | 宽度 | 格式 | 含义 |
|---|---|---|---|
| Selected NAS Security Algorithms | 1 字节 | V | 高 4 位加密算法、低 4 位完整性算法 |
| spare \| NAS KSI | 1 字节 | Type-1 | 密钥序号 |
| Replayed UE Security Capabilities | LV | LV | 回显 UE 上报的能力，防降级攻击 |
| IMEISV Request | 1 字节 | Type-1 可选 | 是否索要 IMEISV |
| NONCE_ue / NONCE_mme | TV 可选 | TV | 密钥重推时用 |

body 拼完后，同一个函数尾部直接算 MAC（`liblte/src/liblte_mme.cc:8084`）：

```c
if(LIBLTE_MME_SECURITY_HDR_TYPE_PLAIN_NAS != sec_hdr_type)
{
    liblte_security_128_eia2(&key_256[16],      // K_NASint
                             count, 0, direction,
                             &msg->msg[5],      // 从 Seq 字节起算
                             msg->N_bytes-5,
                             &msg->msg[1]);     // MAC 回填字节 1..4
}
```

Security Mode Complete（`liblte/src/liblte_mme.cc:8174`）的 body 几乎为空，只有一个可选的 IMEISV（`:8211`）——它就是一条"收到，开关已打开"的回执，重点是它开始**全程带 MAC**。

在 eNodeB/MME 侧，这条消息是这样发出的（`LTE_fdd_enodeb/src/LTE_fdd_enb_mme.cc:1688`）：

```c
liblte_mme_pack_security_mode_command_msg(&sec_mode_cmd,
    LIBLTE_MME_SECURITY_HDR_TYPE_INTEGRITY_WITH_NEW_EPS_SECURITY_CONTEXT,  // SHT=3
    user->get_auth_vec()->k_nas_int,
    user->get_auth_vec()->nas_count_dl,
    LIBLTE_SECURITY_DIRECTION_DOWNLINK, ...);
```

SHT 用 `3`（WITH_NEW_EPS_SECURITY_CONTEXT），因为这条消息本身还没加密、但要求对端从**下一条开始**启用新密钥。之后发的 Attach Accept 就用 SHT=2 了（`LTE_fdd_enodeb/src/LTE_fdd_enb_mme.cc:1372`）。

**一个必须知道的现实**：这个代码库里 NAS 层只实现了"下行方向算 MAC"。全仓库搜 `liblte_security_128_eia2`，所有调用点都在 pack 路径上（`liblte/src/liblte_mme.cc:5723` 等二十余处、`liblte/src/liblte_pdcp.cc:140`）；上行方向的 MAC **校验**、以及 NAS 加密（eea 系列）没有实现——unpack 侧对受保护消息只是跳过 7 字节外壳直接解内层明文。所以 OpenLTE 的安全是"单向演示级"的，别拿它当参考实现去对现网。

## ESM 如何嵌在 EMM 里

Attach 流程里，UE 在 Attach Request 里捎带一条 PDN Connectivity Request，网络在 Attach Accept 里捎带一条 Activate Default EPS Bearer Context Request。承载工具就是 **ESM Message Container** IE，它的编解码在 `liblte/src/liblte_mme.cc:2370`：

```c
esm_msg->N_bytes  = (*ie_ptr)[0] << 8;     // 长度是 2 字节、大端
esm_msg->N_bytes |= (*ie_ptr)[1];
for(i=0; i<esm_msg->N_bytes; i++)
    esm_msg->msg[i] = (*ie_ptr)[2+i];      // 原样拷贝内层 ESM 帧
*ie_ptr += esm_msg->N_bytes + 2;
```

注意两点：一是这个 LV 的长度域是 **2 字节**（多数 LV 是 1 字节，这是例外）；二是容器对内容完全透明——就是一段字节，递归地装了一条完整 ESM 消息。类比 HTTP：EMM 是外层请求的 body，ESM container 相当于 body 里又塞了一段 `Content-Type: application/x-esm` 的完整报文。

ESM 消息的帧头和 EMM 略有不同。看 PDN Connectivity Request 的 pack（`liblte/src/liblte_mme.cc:12099`）：

```c
// 字节 0：高 4 位是 EPS Bearer ID（不是 SHT！），低 4 位是 PD=2
*msg_ptr = (pdn_con_req->eps_bearer_id << 4) | (LIBLTE_MME_PD_EPS_SESSION_MANAGEMENT);
// 字节 1：Procedure Transaction ID（一次流程的事务号）
*msg_ptr = pdn_con_req->proc_transaction_id;
// 字节 2：Message Type = 0xD0
*msg_ptr = LIBLTE_MME_MSG_TYPE_PDN_CONNECTIVITY_REQUEST;
// 字节 3：PDN Type（高 4 位）| Request Type（低 4 位）
```

这就是 `parse_msg_header` 里"PD 是 ESM 时 msg_type 在字节 2"的原因——ESM 多了个事务 ID 字节。

接收端把这两层拆开的代码在 `LTE_fdd_enodeb/src/LTE_fdd_enb_mme.cc:512`：

```c
liblte_mme_unpack_attach_request_msg(msg, &attach_req);          // 解外层 EMM
liblte_mme_parse_msg_header(&attach_req.esm_msg, &pd, &msg_type); // 看内层是什么
switch(msg_type)
{
case LIBLTE_MME_MSG_TYPE_PDN_CONNECTIVITY_REQUEST:
    parse_pdn_connectivity_request(&attach_req.esm_msg, (*user), (*rb));
    break;
```

发送端反过来：先把 Activate Default EPS Bearer Context Request pack 进 `attach_accept.esm_msg`（`LTE_fdd_enodeb/src/LTE_fdd_enb_mme.cc:1343`），再 pack 整个 Attach Accept。你要加新的 ESM 携带关系，照这个两段式写法抄就行。

## 常见坑

**1. MCC/MNC 的半字节交换。** PLMN ID 的编码是 BCD + nibble 反序：MCC=460、MNC=00 在线缆上是 `64 F0 00`。看 GUTI 的 pack（`liblte/src/liblte_mme.cc:2103`）：

```c
**ie_ptr = (((eps_mobile_id->guti.mcc/10) % 10) << 4)
         | ((eps_mobile_id->guti.mcc/100) % 10);   // MCC 第 2 位放在高半字节！
...
**ie_ptr = 0xF0 | (eps_mobile_id->guti.mcc % 10);  // MNC 只有 2 位时高 4 位补 F
```

规律：每个字节里"第奇数位数字放低半字节、第偶数位放高半字节"，两位 MNC 要在第三字节高半位填 `0xF`。手工对抓包时 PLMN 解出来数字顺序是反的，十有八九是忘了这个交换。

**2. Type-1 IEI 只占高半字节。** 可选 IE 循环里，整字节 IEI 直接 `== *msg_ptr` 比较；Type-1 必须先 `<< 4` 再和高半字节比（`liblte/src/liblte_mme.cc:6513` 的 TMSI Status、`:6583` 的 GUTI Type）。混用两种写法会要么误匹配要么漏匹配。

**3. 长度域的宽度不统一。** 多数 LV 是 1 字节长度；ESM Message Container 是 2 字节大端（`liblte/src/liblte_mme.cc:2379`）；EPS Mobile ID 的长度字节**不把自己算进去**但把 type_of_id 所在字节算进去。照抄某个 IE 的写法前，先看清楚它的 L 是几字节、算不算自己。

**4. unpack 不做边界检查。** 所有 unpack 都假设输入是合法的——`msg_ptr += 7` 之前不看 `N_bytes` 够不够 7。喂畸形报文进去就是越界读。如果你要给 OpenLTE 加模糊测试或者对接不可信输入，这层校验得自己补。

**5. IEI 不是全局唯一的。** 比如 `0x50` 在 Attach Accept 里是 GUTI（`liblte/hdr/liblte_mme.h:2694`），在 Attach Request 里是 Additional GUTI（`:2805`）。IEI 表永远要绑着"当前在解哪条消息"来看。

**6. 受保护消息里"跳 7"只对 EMM 成立。** 内层若是 ESM，Message Type 还在第 8 字节（`liblte/src/liblte_mme.cc:5668`）。自己写解析器时别把 ESM 的偏移套到 EMM 上。

## 小结

- NAS 一帧 = `[SHT|PD]` 头 + Message Type + IE 序列；PD 区分 EMM（`0x7`）/ESM（`0x2`），SHT 决定外壳形态。
- 三种形态：明文（跳 1 字节）、安全保护（跳 7 字节，含 4 字节 MAC + 1 字节 Seq，内层是完整 plain NAS）、Service Request 特例（4 字节定帧）。
- 消息体是 TLV/IEI 编码：强制 IE 靠位置（V/LV），可选 IE 靠 IEI（TV/TLV/Type-1）；字节对齐是它区别于 RRC PER 的本质特征。
- `liblte_mme.cc` 的结构 = IE 编解码函数 + 消息编解码函数，消息函数就是按 schema 顺序调用 IE 函数；加新 IE 的完整路径是：hdr 里加 struct 和 IEI 宏 → 写 IE 的 pack/unpack → 在消息的 pack/unpack 里挂上调用。
- OpenLTE 的 NAS 安全只做下行 MAC（EIA2），上行 MAC 校验与 NAS 加密未实现，读代码时别把这部分当完整参考。
- 手工解包三大陷阱：PLMN 的 nibble 反序、Type-1 IEI 的半字节比较、各 IE 长度域宽度不一。
