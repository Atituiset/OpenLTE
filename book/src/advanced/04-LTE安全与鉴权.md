# 第 4 章 LTE 安全与鉴权：Milenage、密钥层级与 EEA/EIA

安全是 LTE 协议栈里"工程味"最重的一部分：它不像物理层那样全是数学，也不像 RRC 那样全是状态机，而是一条从 USIM 卡到 PDCP 层的、环环相扣的密钥派发流水线。你熟悉 HTTPS 的话，可以把整章读成"LTE 版的 TLS"：PSK 预共享（K）、握手换 nonce（RAND）、双向校验（RES/XRES）、派生会话密钥（KASME 及子孙）、然后进入加密传输（EEA/EIA）。区别只在于 LTE 的这套东西被拆进了 USIM、HSS、MME、eNodeB 四个实体，而且每一环都有 3GPP 规范编号背书。

本章按数据流向组织：先看密钥全景，再精读 Milenage 的每一个函数，然后跟着 eNodeB 代码走一遍真实鉴权流程，最后盘点 OpenLTE 的简化与攻击面。涉及的规范主要是 33.401（EPS 安全架构与 KDF）、35.206（Milenage 算法）、33.102（AKA 与 SQN 管理）、24.301（NAS 安全）、36.323/36.331（AS 侧安全）。

## 4.1 密钥全景：USIM 里只有 K 和 OP

先建立一个关键认知：**整套 LTE 密钥体系里，真正的"秘密"只有两个**——烧在 USIM 卡里的 128 bit 根密钥 K，和运营商常量 OP。其余所有密钥（CK、IK、KASME、KNASenc、KeNB、KRRCenc……）全部是运行时派生出来的。USIM 和 HSS 各存一份 K 和 OP，K 永远不离开这两个地方；网络上跑的全是派生密钥。

这和你熟悉的 TLS PSK 模式几乎同构：预共享密钥不出手，握手里只交换随机数，双方各自算出相同的会话密钥。LTE 只是把这个"各自算"的链条拉长了：

```
                        ┌───────────────┐
                        │   K, OP       │   USIM 与 HSS 各存一份（16 字节）
                        └───────┬───────┘
                                │ Milenage f2/f3/f4/f5（35.206）
                                ▼
                        ┌───────────────┐
                        │   CK, IK      │   各 16 字节，由 (K, RAND) 算出
                        └───────┬───────┘
                                │ KDF = HMAC-SHA256，输入含 SQN⊕AK 和 PLMN id（33.401 Annex A）
                                ▼
                        ┌───────────────┐
                        │    KASME      │   NAS 层根密钥（MME 与 UE 共有）
                        └───────┬───────┘
                                │ KDF
              ┌─────────────────┼──────────────────┐
              ▼                 ▼                  ▼
       ┌────────────┐   ┌────────────┐      ┌────────────┐
       │  KNASenc   │   │  KNASint   │      │    KeNB    │ 交给 eNodeB
       └────────────┘   └────────────┘      └─────┬──────┘
        NAS 加密          NAS 完整性                │ KDF
                                                  ▼
                              ┌───────────────────┼───────────────────┐
                              ▼                   ▼                   ▼
                       ┌────────────┐      ┌────────────┐      ┌────────────┐
                       │  KRRCenc   │      │  KRRCint   │      │   KUPenc   │
                       └────────────┘      └────────────┘      └────────────┘
                        RRC 加密（PDCP）    RRC 完整性（PDCP）    用户面加密（PDCP）
```

树中每一层的派生函数在 OpenLTE 里都有直接的对应物，全部集中在 `liblte/src/liblte_security.cc`：

| 派生 | 函数 | 位置 |
|---|---|---|
| KASME ← CK‖IK, SQN⊕AK, SN-id | `liblte_security_generate_k_asme` | `liblte/src/liblte_security.cc:213` |
| KNASenc/KNASint ← KASME | `liblte_security_generate_k_nas` | `liblte/src/liblte_security.cc:310` |
| KeNB ← KASME, NAS COUNT | `liblte_security_generate_k_enb` | `liblte/src/liblte_security.cc:275` |
| KRRCenc/KRRCint ← KeNB | `liblte_security_generate_k_rrc` | `liblte/src/liblte_security.cc:360` |
| KUPenc/KUPint ← KeNB | `liblte_security_generate_k_up` | `liblte/src/liblte_security.cc:411` |

一个值得记住的实现细节：这些 KDF 的输出都是 32 字节（HMAC-SHA256 的完整输出），而真正当 AES-128 密钥用时只取**后 16 字节**——你在后面会看到调用处写 `&key_256[16]`（如 `liblte/src/liblte_mme.cc:5723`）。所以 HSS 侧存的 `k_asme[32]`、`k_enb[32]`（`LTE_fdd_enodeb/hdr/LTE_fdd_enb_hss.h:76-77`）都是 32 字节数组。

## 4.2 Milenage 精读：f1–f5 与 OP 的作用

### 4.2.1 输入、输出与 OP 的角色

Milenage（35.206）不是一个算法，而是一组以 AES-128 为核心构件的函数族 f1–f5、f1*、f5*。输入输出一览：

| 函数 | 输入 | 输出 | 用途 |
|---|---|---|---|
| f1 | K, RAND, SQN, AMF | MAC-A（8 字节） | 网络侧自证：让 USIM 验证 AUTN 合法 |
| f1* | K, RAND, SQN, AMF | MAC-S（8 字节） | 重同步时校验 AUTS |
| f2 | K, RAND | RES（8 字节） | UE 应答："我证明我有 K" |
| f3 | K, RAND | CK（16 字节） | 派生 KASME 的原料 |
| f4 | K, RAND | IK（16 字节） | 派生 KASME 的原料 |
| f5 | K, RAND | AK（6 字节） | 匿名密钥，异或掩盖 SQN 防窃听关联 |
| f5* | K, RAND | AK（6 字节） | 重同步路径上解 AUTS 里的 SQN |

几个公共输入的含义：

| 字段 | 宽度 | 含义 | 规范 |
|---|---|---|---|
| K | 128 bit | USIM/HSS 共享根密钥 | 35.206 |
| OP | 128 bit | 运营商常量（Operator Variant） | 35.206 |
| RAND | 128 bit | 网络侧随机挑战 | 33.102 |
| SQN | 48 bit | 序列号，防重放 | 33.102 |
| AMF | 16 bit | 鉴权管理字段 | 33.102 |

**OP 是干什么的？** 这是新人最容易卡住的点。Milenage 本身只有 K 是秘密，但运营商希望"即使别人拿到我的算法实现和 K 的泄露样本，也不能直接拿去攻击别家网络"。做法是在所有函数里混入一个运营商自定义的 128 bit 常量 OP，更准确地说，先算一次 OPc = AES_K(OP) ⊕ OP，之后所有运算用 OPc 而不是直接用 OP。这样：

- 不同运营商的 f1–f5 输出空间被 OP 隔离开，互不相通；
- **手机丢了不用换 K 的"换"，换的是 OP 维度**——更实际的说法是：运营商可以在不换算法的前提下通过 OP 定制自己的安全域；对烧卡实验来说，USIM 里写的 OP 必须和 HSS 侧代码里的 OP 一致，否则 MAC 校验永远失败。

本仓库的 OP 硬编码在 `liblte/src/liblte_security.cc:63-64`：

```c
static const uint8 OP[16] = {0x11,0x11,0x11,0x11,0x11,0x11,0x11,0x11,
0x11,0x11,0x11,0x11,0x11,0x11,0x11,0x11};
```

即全 `0x11`。README 里说明了这个 fork 把上游默认值（`63bfa50e…`，见 `README.md:405-407`）改成了这个值（`README.md:416-423`），所以你自己烧卡时必须用 `--set-op` 写入同一个 OP，两边对得上才能鉴权成功。

### 4.2.2 AES（Rijndael）是怎么被复用的

`liblte_security.cc` 没有依赖外部库来实现 Milenage 的 AES，而是自带了一份教科书式的 Rijndael 参考实现，和 35.206 附录里的伪代码逐行对应：

- S 盒 `S[256]`：`liblte/src/liblte_security.cc:66`；GF(2^8) 乘 2 查表 `X_TIME[256]`：同文件 83 行。
- `rijndael_key_schedule`（1057 行）：把 16 字节 K 展开成 11 组轮密钥，存进 `ROUND_KEY_STRUCT`（51-53 行）。
- `rijndael_encrypt`（1098 行）：标准 10 轮——第 0 轮只做 `key_add`，第 1–9 轮做 `byte_sub`/`shift_row`/`mix_column`/`key_add`，第 10 轮去掉 `mix_column`（1113-1125 行）。你熟悉 AES 结构的话，这就是一份没有查表优化、没有抗侧信道防护的"教学版" AES。
- `compute_OPc`（1037-1048 行）：`op_c = AES_K(OP) ⊕ OP`，每次调用 f1/f2345 都现场重算（真实 USIM 会把它预计算固化）。

注意这里的 AES 和 EIA2 用的 AES 不是同一份代码：EIA2 走的是 PolarSSL（`liblte/src/liblte_security.cc:38-39` 的 include，以及 490-491 行的 `aes_setkey_enc`/`aes_crypt_ecb`）。一个文件里两套 AES 并存，读代码时别搞混。

### 4.2.3 f1：MAC-A 的生成

`liblte_security_milenage_f1`（`liblte/src/liblte_security.cc:697`）的流程是两次 AES 的"加掩码链"：

```c
        // Compute temp
        for(i=0; i<16; i++)
        {
            rijndael_input[i] = rand[i] ^ op_c[i];          // 727 行：RAND ⊕ OPc
        }
        rijndael_encrypt(rijndael_input, &round_keys, temp); // 729 行：TEMP = AES_K(RAND⊕OPc)
        ...
        for(i=0; i<16; i++)
        {
            rijndael_input[(i+8) % 16] = in1[i] ^ op_c[i];   // 746 行：SQN‖AMF 块旋转 8 字节再 ⊕OPc
        }
        for(i=0; i<16; i++)
        {
            rijndael_input[i] ^= temp[i];                    // 750 行：再 ⊕ TEMP
        }
        rijndael_encrypt(rijndael_input, &round_keys, out1);
        for(i=0; i<16; i++)
        {
            out1[i] ^= op_c[i];                              // 755 行：输出再 ⊕ OPc
        }
```

逐行说：先把 RAND 与 OPc 异或后过一遍 AES 得到 TEMP；然后把 `in1`（SQN 出现两次、AMF 出现两次，共 16 字节，见 731-741 行的构造）旋转 8 字节、异或 OPc、再异或 TEMP，过第二遍 AES，输出再异或一次 OPc。最终取 OUT1 的前 8 字节就是 MAC-A（759-762 行）。这一大串异或/旋转常量全部来自 35.206，属于"照规范抄"型代码——读它不是为了学设计，而是为了在排查鉴权失败时能逐字节对账。

### 4.2.4 f2345：一次 AES 摊出四个输出

`liblte_security_milenage_f2345`（863 行）把 f2/f3/f4/f5 合并在一个函数里，因为它们共享同一个 TEMP = AES_K(RAND⊕OPc)（892-896 行），之后只是旋转量和常数不同：

| 输出 | 代码位置 | 旋转量 | 末尾异或常数 | 取值 |
|---|---|---|---|---|
| RES / AK | 899-920 行 | 0 | 1（903 行） | RES = out[8..15]，AK = out[0..5] |
| CK | 923-938 行 | 12（`(i+12)%16`，925 行） | 2（927 行） | 全 16 字节 |
| IK | 941-956 行 | 8（943 行） | 4（945 行） | 全 16 字节 |

注意 f2 和 f5 共享同一块输出：RES 取后半、AK 取前 6 字节。f1*（780 行）与 f1 结构相同但 MAC-S 取 OUT1 的**后** 8 字节（844 行）；f5*（973 行）旋转量 4、常数 8（1005-1007 行）。这些"旋转量 + 异或常数"组合就是 35.206 里区分各函数的全部秘密。

### 4.2.5 KDF：HMAC-SHA256 套一层模板

过了 Milenage 拿到 CK/IK 之后，再往下的密钥派生全部换成 33.401 Annex A 定义的 KDF，本质是 HMAC-SHA256。以 `liblte_security_generate_k_asme`（213 行）为例，核心是构造一个 14 字节的输入串 S：

```c
        s[0] = 0x10; // FC                                        // 233 行：区分算法用途
        s[1] = (((mcc/10) % 10) << 4) | ((mcc/100) % 10);         // 234 行起：P0 = PLMN id（MCC/MNC）
        ...
        s[4] = 0x00; s[5] = 0x03;                                 // 243-244 行：L0 = P0 长度
        for(i=0; i<6; i++)
        {
            s[6+i] = sqn[i] ^ ak[i]; // P1                        // 247 行：SQN⊕AK
        }
        s[12] = 0x00; s[13] = 0x06;                               // 249-250 行：L1 = P1 长度
        ...
        sha2_hmac(key, 32, s, 14, k_asme, 0);                     // 260 行：key = CK‖IK
```

S 的通用模板是 `FC ‖ P0 ‖ L0 ‖ P1 ‖ L1 …`，FC（Function Code）区分派生的是哪种密钥。对比着看整份文件你会发现所有 KDF 都是同一个模子：

| 函数 | FC | P0 | P1 |
|---|---|---|---|
| k_asme（213 行） | 0x10 | SN-id（MCC/MNC） | SQN⊕AK |
| k_enb（275 行） | 0x11 | UL NAS COUNT | — |
| k_nas（310 行） | 0x15 | 算法类型（0x01=enc / 0x02=int） | 算法 ID |
| k_rrc（360 行） | 0x15 | 算法类型（0x03/0x04） | 算法 ID |
| k_up（411 行） | 0x15 | 算法类型（0x05/0x06） | 算法 ID |

把算法 ID 混进 KDF 输入是 33.401 的明确要求：同一根密钥在不同算法下派生出不同的子密钥，防止"算法降级时密钥可复用"这类攻击。

## 4.3 鉴权流程实战：跟着 eNodeB 代码走一遍

OpenLTE 没有独立的核心网，HSS 和 MME 都是 eNodeB 进程里的一个单例类。下面按时间顺序走一遍 attach 时的 EPS AKA。

**第 0 步：用户入库。** K 存在 HSS 的用户表里。`LTE_fdd_enb_hss::add_user`（`LTE_fdd_enodeb/src/LTE_fdd_enb_hss.cc:126`）接收 15 位 IMSI、15 位 IMEI 和 32 个十六进制字符的 K，转成 16 字节存进 `stored_data.k`（141 行），并把 SQN 相关计数清零（143-145 行）。数据结构就是 `LTE_fdd_enodeb/hdr/LTE_fdd_enb_hss.h:66-87`：`stored_data` 里只有 K，`generated_data` 里是每次鉴权现算的 auth_vec、SQN、KASME、KeNB 等。用户表还可以落盘到 `/tmp/LTE_fdd_enodeb.user_db`（`LTE_fdd_enodeb/src/LTE_fdd_enb_hss.cc:536`）——注意这是**明文存根密钥**的调试便利，不是安全设计。

**第 1 步：Attach Request 触发鉴权。** MME 收到 Attach Request（`parse_attach_request`，`LTE_fdd_enodeb/src/LTE_fdd_enb_mme.cc:489`），先存下 UE 的 EEA/EIA 能力位图（538-542 行），查 HSS 确认 IMSI 在白名单里，然后检查 UE 必须支持 EEA0 和 EIA2（616 行），通过就把状态机拨到 `LTE_FDD_ENB_MME_STATE_AUTHENTICATE`（618 行）。

**第 2 步：生成鉴权向量。** 状态机走到 `send_authentication_request`（1472 行），第一件事是调 `hss->generate_security_data`（1483 行）。这个函数（`LTE_fdd_enodeb/src/LTE_fdd_enb_hss.cc:290`）就是整个 AKA 的"厨房"：

```c
            // Generate MAC, RES, CK, IK, and AK
            liblte_security_milenage_f1((*iter)->stored_data.k, ...     // 327 行：MAC-A
                                        (*iter)->generated_data.mac);
            liblte_security_milenage_f2345((*iter)->stored_data.k, ..., // 332 行：RES/CK/IK/AK
                                           (*iter)->generated_data.auth_vec.res,
                                           (*iter)->generated_data.auth_vec.ck,
                                           (*iter)->generated_data.auth_vec.ik,
                                           (*iter)->generated_data.ak);
            // Construct AUTN
            for(i=0; i<6; i++)
            {
                (*iter)->generated_data.auth_vec.autn[i] = sqn[i] ^ (*iter)->generated_data.ak[i];  // 342 行
            }
```

在它之前，306-314 行按 33.102 的 SEQ‖IND 结构递增 SQN，316-324 行生成 RAND，299 行固定 AMF = `0x8000`。AUTN 的拼装（339-351 行）严格按规范布局：

| AUTN 段 | 字节宽度 | 内容 | 规范 |
|---|---|---|---|
| 字节 0–5 | 6 | SQN ⊕ AK | 33.102 / 24.301 |
| 字节 6–7 | 2 | AMF | 33.102 |
| 字节 8–15 | 8 | MAC-A（f1 输出） | 35.206 |

随后 359-391 行沿着 §4.1 的密钥树一口气派生完整套密钥：KASME → KNASenc/KNASint（算法 ID 写死 EEA0 + EIA2，369-370 行）→ KeNB → KRRCenc/KRRCint → KUPenc/KUPint。也就是说 OpenLTE 在鉴权向量生成时就把全树算完了，真实网络里 KeNB 是 MME 算完通过 S1AP 交给 eNodeB 的——这里 MME 和 eNodeB 同进程，省了这一步。

**第 3 步：下发 Authentication Request。** 回到 `send_authentication_request`，把 AUTN 和 RAND 拷进 NAS 消息（1488-1492 行），KSI 置 0 并标记 native 安全上下文（1493-1494 行），打包下发（1495 行）。RES 和 KASME 留在 HSS 侧等比对。

**第 4 步：校验 RES。** UE 的 Authentication Response 到达后走 `parse_authentication_response`（694 行）：取回 auth_vec（716 行），逐字节比对 RES 与 UE 上行的 RES（720-727 行）。匹配则把 auth_vec 挂到 user 对象上（741 行）并转入 `LTE_FDD_ENB_MME_STATE_ENABLE_SECURITY`（742 行）；不匹配走 `AUTH_REJECTED`（754 行），随后状态机发 Authentication Reject（`attach_sm`，1201-1202 行）。

整个状态机串联在 `attach_sm`（1183 行）里：`AUTHENTICATE`（1199）→ `ENABLE_SECURITY`（1205）→ `RRC_SECURITY`（1211）→ `ATTACH_ACCEPT`（1217），鉴权只是其中一站。

## 4.4 SQN 同步与 resync：代码实现了多少

SQN 存在的意义是防重放：USIM 只接受"比上次新且落在窗口内"的 SQN。但两端计数会跑偏（比如 UE 在别的网络鉴权过），于是 AKA 设计了重同步：UE 回 Authentication Failure（cause = synch failure）并携带 AUTS = (SQN_MS ⊕ AK*) ‖ MAC-S，网络侧用 f5* 解出 UE 的真实 SQN，用 f1* 验证 MAC-S，然后以 UE 的 SQN 为基准重新生成向量。

OpenLTE 实现了这条链路的**一半**。上行处理在 `parse_authentication_failure`（`LTE_fdd_enodeb/src/LTE_fdd_enb_mme.cc:658`）：识别出 synch failure 且带 AUTS 参数后，调 `hss->security_resynch`（680 行）。后者（`LTE_fdd_enodeb/src/LTE_fdd_enb_hss.cc:397`）做的事是：

```c
            liblte_security_milenage_f5_star((*iter)->stored_data.k,     // 413 行：算 AK*
                                             (*iter)->generated_data.auth_vec.rand,
                                             (*iter)->generated_data.ak);
            (*iter)->generated_data.sqn_he = 0;
            for(i=0; i<6; i++)
            {
                sqn[i] = auts[i] ^ (*iter)->generated_data.ak[i];        // 419 行：解出 SQN_MS
                ...
            }
```

解出 SQN_MS、拆回 SEQ/IND、把 IND 减一（424-427 行，让下一次递增后恰好接上 UE 的序号）。

要如实指出的是两个缺口：其一，resynch 路径**没有用 f1\* 校验 MAC-S**——`liblte_security_milenage_f1_star` 这个函数在整个仓库里没有任何调用方（可以自己 grep 确认），意味着攻击者理论上可以伪造 AUTS 篡改 HSS 侧的 SQN 计数；其二，resynch 之后状态机没有自动重发 Authentication Request 的分支，`parse_authentication_failure` 走完 `security_resynch` 就结束了，下一次向量何时生成依赖流程再次被触发。属于"能跑通正常场景、异常路径没闭环"的研究代码典型状态。

## 4.5 NAS 安全：Security Mode Command 之后

鉴权通过只说明"双方都算得出 KASME"，NAS 消息真正进入保护态要等 Security Mode Command 握手完成。

**下行：选算法。** `send_security_mode_command`（`LTE_fdd_enodeb/src/LTE_fdd_enb_mme.cc:1646`）把选定算法写死为 EEA0 + EIA2（1654-1655 行），把 UE 之前在 Attach Request 里上报的能力位图原样回放进去（1658-1665 行，这是 24.301 要求的防降级措施——UE 会比对回放的能力和自己发的是否一致），然后用新生成的 KNASint 给整条消息算 MAC，安全头类型为"新安全上下文完整性保护"（1688-1693 行）。KNASenc/KNASint 早在 §4.3 第 2 步就由 `liblte_security_generate_k_nas`（`liblte/src/liblte_security.cc:310`）派生好了，这里只是取用。

**上行：收到 Security Mode Complete。** `parse_security_mode_complete`（883 行）解包、可选地比对 IMEISV（902-922 行），然后把状态拨到 `RRC_SECURITY`（935 行），接下来才轮到 AS 安全。

**MAC 怎么算。** 所有 NAS 安全消息的 MAC 都走同一个函数：`liblte_mme_pack_security_protected_nas_msg`（`liblte/src/liblte_mme.cc:5681`）。受保护的 NAS 消息头部布局（24.301）：

| 字段 | 宽度 | 含义 |
|---|---|---|
| Security header type ‖ PD | 1 字节 | 高 4 bit 安全头类型，低 4 bit 协议鉴别符 |
| MAC | 4 字节 | EIA 输出的截断值 |
| Sequence number | 1 字节 | NAS COUNT 的低 8 bit |
| NAS message | 变长 | 真正的 EMM/ESM 消息 |

打包时先把 MAC 的 4 字节留空、填好序号和消息体，最后调 EIA2 把 MAC 回填（`liblte/src/liblte_mme.cc:5723-5729`）：

```c
            // Calculate MAC
            liblte_security_128_eia2(&key_256[16],        // 后 16 字节作 128-bit 密钥
                                     count,               // NAS COUNT
                                     0,                   // bearer：NAS 固定为 0
                                     direction,
                                     &sec_msg->msg[5],    // 被保护的消息体
                                     sec_msg->N_bytes-5,
                                     &sec_msg->msg[1]);   // MAC 写回头部 1-4 字节
```

EIA2 本身是 AES-CMAC（RFC4493）：先用 AES_K(0) 生成子密钥 L，再左移派生 K1/K2（`liblte/src/liblte_security.cc:490-513`），把 COUNT‖BEARER‖DIRECTION 拼在消息前当 CMAC 输入（516-525 行，其中 521 行 `M[4] = (bearer << 3) | (direction << 2)` 就是那个 1 字节的 bearer/direction 字段），CBC-MAC 式迭代后取前 4 字节作为 MAC-I（559-562 行）。

**MAC 怎么验？——如实说：没有验。** 这是 OpenLTE 最重要的简化之一。库里所有 `liblte_mme_unpack_*_msg` 都只解包不校验：安全头被直接跳过（如 `liblte_mme_unpack_attach_accept_msg`，`liblte/src/liblte_mme.cc:5915-5921` 对非明文消息直接 `msg_ptr += 7`），没有任何地方重算 MAC 与消息里的值比对。eNodeB 侧收到上行 NAS 后，`handle_nas_msg` 只是分发消息并把 `nas_count_ul` 加一（`LTE_fdd_enodeb/src/LTE_fdd_enb_mme.cc:368`）。也就是说：下行方向 MAC 算得一丝不苟，上行方向照单全收。读代码时如果你发现"篡改过的 NAS 消息也能过"，这不是 bug 复现了，是根本没实现。

另一个相关细节在 Service Request 路径：`parse_service_request` 会拿 UE 上报的 NAS 序号和本地 `nas_count_ul` 比对，不一致时直接以 UE 的值为准调 `regenerate_enb_security_data` 重派 KeNB 系列密钥（`LTE_fdd_enb_mme.cc:1006-1026`）——因为 MAC 不验，这里只能靠序号对账兜底。

## 4.6 AS 安全：RRC 与 PDCP

NAS 安全搞定后，MME 经 `RRC_SECURITY` 状态让 RRC 层发 AS 侧的 SecurityModeCommand（`LTE_fdd_enodeb/src/LTE_fdd_enb_rrc.cc:1068`）：算法同样写死 EEA0 + EIA2（1076-1077 行），发完后立刻把该 RB 的 PDCP 切到安全配置（1089 行）。UE 回 SecurityModeComplete 后 RRC 通知 MME（693-701 行），attach 流程继续往下走。

AS 安全的执行点是 PDCP 层（36.323 规定加密和完整性都在 PDCP 做，RRC 消息作为 PDCP 的 SDU 被保护）。OpenLTE 里下行 SRB 的完整性在 `LTE_fdd_enodeb/src/LTE_fdd_enb_pdcp.cc:391-398`：PDCP 配置为 SECURITY 时，调 `liblte_pdcp_pack_control_pdu` 并传入用户的 `k_rrc_int`。这个打包函数（`liblte/src/liblte_pdcp.cc:128-148`）在 PDU 尾部留 4 字节，调 `liblte_security_128_eia2` 算 MAC-I 回填——和 NAS 那套是同一个 EIA2，只是 COUNT 换成 PDCP COUNT、bearer 换成 RB id 减一。上行方向与 NAS 同病：`liblte_pdcp_unpack_control_pdu`（`liblte/src/liblte_pdcp.cc:158-186`）直接忽略 MAC-I 字段，不验证。

至于加密：EEA0 等于不加密，而 OpenLTE 全线选的就是 EEA0，所以**整条代码路径里不存在任何真实的加密动作**——KRRCenc、KUPenc 被老老实实派生出来（`LTE_fdd_enodeb/src/LTE_fdd_enb_hss.cc:380-391`），然后就没有然后了。库里 EEA1/EEA2 的枚举值在 `liblte/hdr/liblte_security.h:98-106` 里躺着，但没有对应的实现函数。想在 OpenLTE 上验证"加密后的空口流量"，是验证不了的。

## 4.7 OpenLTE 的安全简化与已知攻击面

把前面散落的简化集中列一下，这也是你拿 OpenLTE 做任何安全实验前必须知道的边界：

- **OP 硬编码、K 明文落盘**：OP 是编译期常量（`liblte/src/liblte_security.cc:63`），改 OP 要重新编译；用户数据库 `/tmp/LTE_fdd_enodeb.user_db` 明文存 K（`LTE_fdd_enodeb/src/LTE_fdd_enb_hss.cc:536`）。
- **RAND 不随机**：HSS 用 `rand()` 生成 RAND（`LTE_fdd_enodeb/src/LTE_fdd_enb_hss.cc:319`），不是密码学安全的随机源，且未见 `srand` 播种的保障——两次运行可能产生可预测的挑战序列。
- **只算不验**：上行 NAS MAC 不验、上行 PDCP MAC-I 不验（§4.5、§4.6）；resync 不验 MAC-S（§4.4）。
- **EEA0 裸奔**：没有实现任何加密算法，空口全是明文。
- **能力检查形同虚设**：只查 UE 是否支持 EEA0/EIA2（`LTE_fdd_enodeb/src/LTE_fdd_enb_mme.cc:616`），而 EEA0 本身就是"不加密"。

正因为主线这么"裸"，这个仓库（更准确地说，它背后的 fork 生态）衍生出了一批攻击分支。README 的 "Attack implementations" 一节（`README.md:26-37`）列出了 @onkarmumbrekar 实现的攻击，分布在各自的 git 分支里：`akabypass`、`attach_reject`、`dos_tau_reject`、`dos_tau_reject_dualcase`、`malformed_detach`、`numb_attack`、`service_reject_on_tau`、`tau_numb_attack`。注意：**这些分支不在你当前这份代码里**（本地只有 master），需要到对应 fork 的分支上去看。按分支名和这类研究的公开背景，它们大致是：

- `akabypass`：跳过/旁路 AKA 鉴权流程的变种——主线状态机里鉴权是强制一站，这个分支演示绕过它之后 UE 和网络各自还能走到哪里；
- `attach_reject` / `service_reject_on_tau` / `dos_tau_reject(_dualcase)`：利用恶意 eNodeB 在 Attach/TAU/Service Request 阶段回带特定 EMM cause 的 Reject 消息，让 UE 把网络或 USIM 标记为不可用，实现拒绝服务；
- `malformed_detach`：发送畸形 Detach 消息试探 UE 协议栈的健壮性；
- `numb_attack` / `tau_numb_attack`：借 TAU 流程让 UE"失联"（numb）的攻击变体。

把它们当作主线的反面教材来读效果最好：每一个攻击分支能成立，几乎都对应主线里的一个"简化"——不验 MAC、明文、异常路径不闭环。读攻击代码时对照本章的行号问自己"这步要是验了 MAC 还会成功吗"，是消化本章最好的练习。

## 4.8 小结

- LTE 密钥体系里唯一的秘密是 USIM/HSS 共享的 K 和运营商常量 OP；CK/IK→KASME→KNAS/KeNB→KRRC/KUP 全部是运行时经 Milenage 和 HMAC-SHA256 KDF 派生的，代码集中在 `liblte/src/liblte_security.cc`。
- Milenage f1–f5 共享同一个 AES 核心（自带 Rijndael 参考实现，1057/1098 行），各函数的区别只在输入块的旋转量和异或常数；f1 产 MAC-A 供 USIM 验网，f2345 产 RES/CK/IK/AK。
- eNodeB 侧鉴权全流程：HSS `generate_security_data`（`LTE_fdd_enodeb/src/LTE_fdd_enb_hss.cc:290`）算向量并派生全密钥树 → `send_authentication_request`（`LTE_fdd_enodeb/src/LTE_fdd_enb_mme.cc:1472`）下发 RAND/AUTN → `parse_authentication_response`（694 行）比对 RES。
- NAS 完整性用 EIA2（AES-CMAC），打包时统一在 `liblte_mme_pack_security_protected_nas_msg`（`liblte/src/liblte_mme.cc:5681`）算 MAC；AS 侧 SRB 完整性在 PDCP（`liblte/src/liblte_pdcp.cc:140`）。但上行方向 MAC 一律不验，且全线 EEA0 无加密。
- SQN 重同步只实现了一半：f5* 解 SQN 有（`LTE_fdd_enodeb/src/LTE_fdd_enb_hss.cc:397`），f1* 验 MAC-S 无人调用。
- README 列出的 akabypass、attach_reject 等攻击分支不在本仓库 master 上，它们是对"主线安全简化"的活体演示，适合对照本章逐条反查。
