# 04 NAS 与 TLV

> 本章是整套文档的**第二个重点**。RRC 是空口的"租房合同"，NAS 是 UE 与 MME 之间的"户籍登记 + 业务办理"。
>
> RRC 用 ASN.1 PER 比特对齐；NAS 用一种自定义的 TLV/IEI 格式，**字节对齐**。如果你做过 protobuf wire format，这一章会非常熟悉。

---

## 1. NAS = EMM + ESM

NAS（Non-Access Stratum）规范是 3GPP 24.301。NAS 内部分两块：

- **EMM (EPS Mobility Management)** —— 移动性管理：附着、分离、鉴权、安全模式、寻呼、跟踪区更新。
- **ESM (EPS Session Management)** —— 会话管理：默认承载激活、专用承载激活、承载修改、承载释放。

两个面用同一个 NAS 帧格式，但**第一字节高 4 位的 Protocol Discriminator 不同**：
- EMM = `0x7`
- ESM = `0x2`

定义在 `liblte/hdr/liblte_mme.h:2611-2612`：
```c
#define LIBLTE_MME_PD_EPS_SESSION_MANAGEMENT     0x2
#define LIBLTE_MME_PD_EPS_MOBILITY_MANAGEMENT    0x7
```

**类比**：HTTP 的 Method 行 + Content-Type 头共同决定怎么解析 body；NAS 的 PD + Message Type 共同决定。

## 2. NAS 帧的开头：第一个字节做了两件事

NAS 帧开头第一个字节同时承载两个字段——**高 4 位 = 安全头类型，低 4 位 = 协议鉴别符**。

```
 7 6 5 4 | 3 2 1 0
+-------+-------+
|  SHT  |   PD  |
+-------+-------+
```

安全头类型（SHT）的取值（`liblte_mme.h:2613-2618`）：
```c
#define LIBLTE_MME_SECURITY_HDR_TYPE_PLAIN_NAS                                            0x0
#define LIBLTE_MME_SECURITY_HDR_TYPE_INTEGRITY                                            0x1
#define LIBLTE_MME_SECURITY_HDR_TYPE_INTEGRITY_AND_CIPHERED                               0x2
#define LIBLTE_MME_SECURITY_HDR_TYPE_INTEGRITY_WITH_NEW_EPS_SECURITY_CONTEXT              0x3
#define LIBLTE_MME_SECURITY_HDR_TYPE_INTEGRITY_AND_CIPHERED_WITH_NEW_EPS_SECURITY_CONTEXT 0x4
#define LIBLTE_MME_SECURITY_HDR_TYPE_SERVICE_REQUEST                                      0xC
```

含义：
- `0` = **明文 NAS**（鉴权前必须明文，Attach Request、Authentication Request、Authentication Response 都是这个）。
- `1` = 仅完整性保护（Security Mode Command 这种"开关切换"的消息）。
- `2` = 加密 + 完整性保护（鉴权之后的所有 NAS 消息）。
- `3/4` = 同 1/2，但伴随 NEW EPS security context（密钥换了）。
- `C` = Service Request 专用紧凑格式（不细讲）。

**协议鉴别符（PD）**：见 §1。

如果 SHT ≠ 0，接下来的 6 字节是**完整性 MAC + 序列号**：
```
+----+----+--------+--------+--------+--------+----+
|SHT*PD| MAC(4 byte)        |  NAS Seq Num(1)  |  原始 NAS 帧从这里开始 →
+----+----+--------+--------+--------+--------+----+
```

代码里这点很明显，看 `liblte/src/liblte_mme.cc:6800-6806`：
```c
sec_hdr_type = (msg->msg[0] & 0xF0) >> 4;
if(LIBLTE_MME_SECURITY_HDR_TYPE_PLAIN_NAS == sec_hdr_type)
    msg_ptr++;          // 明文：跳 1 字节(SHT/PD)
else
    msg_ptr += 7;       // 受保护：跳 7 字节(SHT/PD + MAC + Seq)
```

这种"明文跳 1，加密跳 7"的写法在 NAS unpack 函数里到处都是。**类比**：很像在解析 IPv4 header 时根据某个标志位跳过 options 字段。

## 3. 第二个字节：Message Type

NAS 第二个字节是 Message Type，告诉你后面这条 NAS 是哪种消息。`liblte_mme.h` 里有一长串 `LIBLTE_MME_MSG_TYPE_*` 定义：
- `0x41` Attach Request
- `0x42` Attach Accept
- `0x43` Attach Complete
- `0x52` Authentication Request
- `0x53` Authentication Response
- `0x5D` Security Mode Command
- `0x5E` Security Mode Complete
- `0xC1` PDN Connectivity Request
- `0xC2` Activate Default EPS Bearer Context Request
- ...

`LTE_fdd_enb_mme.cc` 收到一条 NAS 后做的第一件事就是 `switch (msg_type)` 分发。

## 4. 主体格式：T-LV / IE / IEI

从第三字节开始就是**消息体**，由若干 IE（Information Element）组成。

每个 IE 有 4 种格式（24.007 §11.2.1）：

| 类型 | 长度 | 说明 |
|---|---|---|
| **V**（Value） | 固定 | 没有 IEI 也没有长度，纯值 |
| **LV**（Length+Value） | 不定 | 1 字节长度，再跟值 |
| **TV**（Type+Value） | 固定 | 1 字节 IEI，再跟固定长度的值 |
| **TLV**（Type+Length+Value） | 不定 | 1 字节 IEI + 1 字节长度 + 值 |

外加一个**奇葩**：**Type-1 (Half octet)**：IEI 只占高 4 位，值占低 4 位。共一字节。NAS 头那一字节 SHT/PD 就是 Type-1 IEI 的写法。

**类比 protobuf**：
- protobuf 的 (tag, type, length, value) ≈ NAS 的 TLV
- protobuf 的 packed varint ≈ NAS 的 LV / V
- protobuf 没有 Type-1 (Half octet) 的对应物

### 4.1 强制 IE 与可选 IE

NAS 消息分两种 IE：
- **Mandatory（强制）**：消息必须出现，**没有 IEI**——按 schema 顺序硬靠位置识别。所以是 V 或 LV。
- **Optional（可选）**：消息可有可无，**必须有 IEI**——靠 IEI 识别。所以是 TV 或 TLV。

> 这就是为什么 NAS 是字节对齐：所有 IEI / 长度 / 值都按字节起。如果某个 IE 内部一定要"位级"，会专门用一字节装"半八位"或位图。

## 5. 端到端例子 1：Authentication Request（最简单）

源码：`liblte/src/liblte_mme.cc:6753-6788`

```c
LIBLTE_ERROR_ENUM liblte_mme_pack_authentication_request_msg(...)
{
    uint8 *msg_ptr = msg->msg;

    // ① 第 1 字节：SHT(0=plain) | PD(7=EMM)
    *msg_ptr = (LIBLTE_MME_SECURITY_HDR_TYPE_PLAIN_NAS << 4)
             | (LIBLTE_MME_PD_EPS_MOBILITY_MANAGEMENT);
    msg_ptr++;

    // ② 第 2 字节：消息类型 = AUTHENTICATION_REQUEST
    *msg_ptr = LIBLTE_MME_MSG_TYPE_AUTHENTICATION_REQUEST;
    msg_ptr++;

    // ③ 第 3 字节：NAS Key Set Identifier (low 4 bit) + Spare half (high 4 bit)
    *msg_ptr = 0;
    liblte_mme_pack_nas_key_set_id_ie(&auth_req->nas_ksi, 0, &msg_ptr);
    msg_ptr++;

    // ④ 第 4-19 字节：RAND (16 byte 固定，V 格式)
    liblte_mme_pack_authentication_parameter_rand_ie(auth_req->rand, &msg_ptr);

    // ⑤ 第 20-35 字节：AUTN (16 byte 固定，V 格式)
    liblte_mme_pack_authentication_parameter_autn_ie(auth_req->autn, &msg_ptr);

    msg->N_bytes = msg_ptr - msg->msg;
}
```

总长度：1 (SHT/PD) + 1 (MsgType) + 1 (KSI/Spare) + 16 (RAND) + 16 (AUTN) = 35 字节。**全是强制 IE，没有任何 IEI/长度**。

字段说明：
| 字段 | 字节数 | 类型 | 作用 |
|---|---|---|---|
| SHT/PD | 1 | T1+T1 | 明文 EMM 标志 |
| Message Type | 1 | V | `0x52` |
| NAS KSI | 1 | T1 + spare | 0..6 = 密钥序号；7 = 没有上下文 |
| RAND | 16 | V | 鉴权随机数（HSS 算的） |
| AUTN | 16 | V | 鉴权令牌（HSS 算的） |

> 这就是最干净的 NAS：固定字段 + 固定长度。**整个解码就是从字节流上一段段切下来。**

## 6. 端到端例子 2：Attach Request（含可选 IE）

源码：`liblte/src/liblte_mme.cc:6264-6415`，是 NAS 里**最复杂**的消息之一，里面用尽所有 IE 套路。

去掉细节看骨架：

```c
LIBLTE_ERROR_ENUM liblte_mme_pack_attach_request_msg(...)
{
    uint8 *msg_ptr = msg->msg;

    // ── 头 ──
    *msg_ptr++ = (PLAIN_NAS << 4) | PD_EMM;
    *msg_ptr++ = LIBLTE_MME_MSG_TYPE_ATTACH_REQUEST;

    // ── 强制 IE（按顺序）──
    liblte_mme_pack_eps_attach_type_ie(...);            // 1 byte (含 NAS KSI)
    liblte_mme_pack_eps_mobile_id_ie(...);              // LV: 1 长度 + IMSI/GUTI
    liblte_mme_pack_ue_network_capability_ie(...);      // LV
    liblte_mme_pack_esm_message_container_ie(...);      // LV (内嵌一条 ESM PDN Connectivity Request)

    // ── 可选 IE（每个先写 IEI）──
    if (attach_req->old_p_tmsi_signature_present) {
        *msg_ptr++ = LIBLTE_MME_P_TMSI_SIGNATURE_IEI;   // 1 byte IEI
        liblte_mme_pack_p_tmsi_signature_ie(...);        // 3 byte V
    }
    if (attach_req->additional_guti_present) {
        *msg_ptr++ = LIBLTE_MME_ADDITIONAL_GUTI_IEI;
        liblte_mme_pack_eps_mobile_id_ie(...);
    }
    if (attach_req->last_visited_registered_tai_present) { ... }
    if (attach_req->drx_param_present)                  { ... }
    if (attach_req->ms_network_capability_present)      { ... }
    if (attach_req->old_loc_area_id_present)            { ... }
    if (attach_req->tmsi_status_present)                { ... }
    if (attach_req->ms_classmark_2_present)             { ... }
    if (attach_req->ms_classmark_3_present)             { ... }
    if (attach_req->supported_codecs_present)           { ... }
    if (attach_req->additional_update_type_present)     { ... }
    if (attach_req->voice_domain_pref_and_ue_usage_setting_present) { ... }
    if (attach_req->device_properties_present)          { ... }
    if (attach_req->old_guti_type_present)              { ... }
    ...
    msg->N_bytes = msg_ptr - msg->msg;
}
```

观察要点：
- **强制 IE 之间没有任何分隔——靠 schema 顺序定位**。
- **可选 IE 全部带 IEI**（IEI 是某个特定字节常量）；解码端通过判断"接下来这字节是不是某个已知 IEI"决定是否读取。
- 一个 IE 内部还可能再嵌一个 NAS 帧——比如 `esm_message_container` 里塞了一条 ESM 的 PDN Connectivity Request。**类比**：HTTP body 里塞另一段 HTTP。

### 6.1 IEI 怎么解析

可选 IE 的解码端不是按位置识别，而是**按字节循环猜**：
```c
while (msg_ptr < msg_end) {
    uint8 iei = *msg_ptr;
    if (iei == LIBLTE_MME_P_TMSI_SIGNATURE_IEI)        { ... }
    else if (iei == LIBLTE_MME_ADDITIONAL_GUTI_IEI)    { ... }
    else if ((iei >> 4) == 0xB)                        { /* type-1 IEI */ ... }
    else { msg_ptr++; }   // 跳过未知
}
```

**IEI 的取值**有讲究：
- **Type-3 / Type-4 IEI**（TV / TLV）—— 整个字节就是 IEI（如 `0x13`、`0x57` …）
- **Type-1 IEI（Half octet）** —— 只看高 4 位，IEI 在高位，值在低位

为了区分这两类，规范给出了"高 4 位是 0x8~0xF 的字节是 type-1 IEI 的高半字节" 之类的约定。OpenLTE 的解码代码里你会看到 `(iei & 0xF0)` 与 `(iei & 0x0F)` 这类位运算。

## 7. 一些常用 IE 速查

打开 `liblte/hdr/liblte_mme.h` 全文搜 `_IEI` 就能看到所有 IEI 定义。常见的：

| IEI（hex） | IE 名称 | 长度 |
|---|---|---|
| 0x52 | EPS Mobile Identity (GUTI/IMSI/IMEI) | TLV |
| 0x57 | Authentication Parameter RAND | V |
| 0x20 | Authentication Parameter AUTN | LV |
| 0x5C | NAS Security Algorithms | V |
| 0x55 | NAS Message Container | LV |
| 0x73 | EPS Bearer Context Status | LV |

注意：**IEI 不全是固定的**——同一个 IEI 数值在不同消息里可能代表不同东西。所以解码总是绑着"我现在在解哪条消息"的上下文。

## 8. NAS 在 OpenLTE 中的运行流程

`LTE_fdd_enodeb/src/LTE_fdd_enb_mme.cc`（1900 行）是 NAS 的"调度站"。流程：

```
   PDCP（解密 + 完整性校验）  --->  LIBLTE_BYTE_MSG_STRUCT
                                   ↓
                           LTE_fdd_enb_mme::handle_nas_msg()
                                   ↓ switch(msg_type)
                                   ↓
                  LIBLTE_MME_MSG_TYPE_ATTACH_REQUEST
                  LIBLTE_MME_MSG_TYPE_AUTHENTICATION_RESPONSE
                  LIBLTE_MME_MSG_TYPE_SECURITY_MODE_COMPLETE
                  LIBLTE_MME_MSG_TYPE_ESM_INFORMATION_RESPONSE
                  LIBLTE_MME_MSG_TYPE_ATTACH_COMPLETE
                  LIBLTE_MME_MSG_TYPE_DETACH_REQUEST
                  ...
                                   ↓
                       状态机：LTE_FDD_ENB_MME_STATE_*
                                   ↓
                       liblte_mme_pack_xxx_msg() 构造响应
                                   ↓
                          下发给 PDCP（加密 + 完整性）
```

详细的状态切换在 05 篇画。

## 9. RRC PER 与 NAS TLV 的对比表（背下来）

| 维度 | RRC（36.331） | NAS（24.301） |
|---|---|---|
| 编码规则 | ASN.1 PER（uPER） | 自定义 TLV/IEI（参考 24.007） |
| 对齐方式 | 比特对齐 | 字节对齐 |
| 典型容器 | `LIBLTE_BIT_MSG_STRUCT` | `LIBLTE_BYTE_MSG_STRUCT` |
| 字段定位 | 按 schema 比特顺序 | 强制 IE 按字节顺序，可选 IE 按 IEI |
| 可选字段 | 头部 1-bit 位图 | IEI 前缀 |
| 长度信息 | 多数固定 / PER 长度子集 | 字段长度可变时显式给 1 字节 length |
| 扩展机制 | 1-bit 扩展位 + 长度子集 | 新增 IEI |
| 加密层 | PDCP（之后再到空中） | NAS 自己（SHT 字段）+ PDCP 再加一层 |
| 类比 | 极致紧凑序列化（~MessagePack 但无 tag） | protobuf wire format |

## 10. 自己练手

1. **手算 Authentication Request**：用任意 RAND/AUTN（16+16 字节随机）填上，加上 SHT/PD/MsgType/KSI，得到 35 字节序列。再去 `liblte_mme.cc:6753` 验证。
2. **拆 Attach Request**：在 `LTE_fdd_enb_mme.cc` 里加 `printf` 打印每条收到的 NAS 头三字节；让一台"假手机"（或开源 srsUE）附着上来，看实际字节。
3. **写一个 NAS 嗅探器**：写一段 Python，从 Wireshark 导出的 mac-lte-framed pcap 里抽出 NAS 字节流，按本章规则解头三字节，输出 PD/SHT/MsgType。

## 11. 进阶：你可能撞上的坑

- **半字节 IEI 的端序**：高 4 位是 IEI，低 4 位是值。代码里要记得 `>>4` 和 `&0xF` 的对偶。
- **`esm_message_container` 嵌套**：里面是另一条完整 ESM NAS 帧，长度由外层 LV 给出。换句话说，NAS 是可以**递归**的。
- **加密之后没法解析头三字节以外的内容**。但 SHT/PD/MsgType 仍然明文（外面那一字节 SHT 是 1/2/3/4，里面的 NAS body 才是密文）。
- **OpenLTE 的 NAS 不实现 SMS over NAS / EMERGENCY ATTACH**。

下一篇：`05_eNodeB状态机与调用流.md` —— 把 RRC + EMM 两个状态机和上面 03/04 章的消息编解码组合在一起，画出从 UE 开机到 IP 通的完整流程。
