# 第6章 物理层与 SDR 应用

前面几章我们一直在"协议"的世界里打转：RRC、NAS、状态机。这一章往下走一层，到物理层（PHY）。但先说清楚本章的定位：**PHY 本身浅讲，代码地图要讲全**。读完你不一定能手推 OFDM 公式，但你应该知道——想改某个功能时，去哪个文件、哪个函数。

你会熟悉的那种感觉：PHY 对协议栈就像网卡驱动对 TCP/IP 栈。你不需要懂 88E1512 的寄存器才能写 socket 程序，但当你要排查链路问题时，知道 `ethtool` 的每个数字从哪个寄存器来，就完全不一样了。

本章路线：先给一套最小物理层概念，再跟 `LTE_fdd_dl_scan` 走一遍小区搜索，然后把 `liblte_phy.h` 的函数地图铺开，最后看四个 SDR 应用程序怎么配合、以及 `octave/` 下那个"教学版"接收机。

## 6.1 物理层最小知识集

### 帧、子帧、时隙

LTE FDD 的时间结构是严格分层的，这组常量在 `liblte/hdr/liblte_phy.h:138-140` 就能找到：

- 1 个无线帧（frame）= 10 ms = 10 个子帧（`LIBLTE_PHY_N_SUBFR_PER_FRAME = 10`，`liblte/hdr/liblte_phy.h:140`）
- 1 个子帧（subframe）= 1 ms = 2 个时隙（slot，`liblte/hdr/liblte_phy.h:139`）
- 1 个时隙 = 7 个 OFDM 符号（常规 CP）
- 系统帧号 SFN 范围 0~1023（`liblte/hdr/liblte_phy.h:138`），这就是 MIB 里 SFN 要除以 4 编码的原因，后面会讲

采样率是带宽的 1.92/30.72 倍频关系，头文件里每个带宽一档常量。以 20 MHz（30.72 MS/s）为例（`liblte/hdr/liblte_phy.h:142-147`）：每个 OFDM 符号 2048 点 FFT，第一个符号 CP 长 160 采样、其余 144，一个时隙 15360 采样，一帧 307200 采样。你做离线分析时"一帧多少字节"就是这么算出来的。

### OFDM 一句话

OFDM 就是把宽带信道切成一堆 15 kHz 的窄子载波并行发，每个子载波上调一个 QAM 符号；发端做 IFFT、收端做 FFT。你熟悉的"傅里叶变换把时域变频域"在这里就是字面意义：IFFT 的输出直接就是 SDR 要发的 IQ 采样。`liblte/hdr/liblte_phy.h:100-104` 列了各带宽对应的 FFT 点数（128/256/512/1024/2048）。

### RE 与 RB

- RE（Resource Element）= 1 个子载波 × 1 个 OFDM 符号，是最小资源格子。
- RB（Resource Block）= 12 个子载波 × 1 个时隙（`LIBLTE_PHY_N_SC_RB_DL_NORMAL_CP = 12`，`liblte/hdr/liblte_phy.h:126`），是调度的最小单位。

带宽和 RB 数的对应是固定的：`liblte/hdr/liblte_phy.h:107-112`，1.4 MHz=6 RB，一直到 20 MHz=100 RB。把它想成一张 Excel 表：列是时间（OFDM 符号），行是频率（子载波），每个单元格是一个 RE，各种信道就是往这张表的不同区域里填数据。

### 信道地图

往这张时频表里填数据的"写入者"一览（下行为主）：

| 信道/信号 | 方向 | 一句话作用 | 在表里哪个位置 |
|---|---|---|---|
| PSS | DL | 粗同步 + 扇区号 N_id_2（0/1/2） | 子帧 0、5 中央 6 RB |
| SSS | DL | 帧同步 + 组号 N_id_1（0~167） | 子帧 0、5 中央 6 RB，PSS 前一个符号 |
| PBCH | DL | 广播 MIB（24 bit） | 子帧 0 中央 6 RB，跨 4 帧重复 |
| PCFICH | DL | 告诉 UE 本子帧 PDCCH 占几个符号（CFI） | 每个子帧第 1 个符号的 4 个 REG |
| PHICH | DL | 上行 HARQ 的 ACK/NACK | 第 1 个符号若干 REG |
| PDCCH | DL | 调度信令（DCI）：哪个 RNTI 用哪些 RB | 每个子帧前 1~3 个符号 |
| PDSCH | DL | 真正的下行数据（SIB、寻呼、用户数据） | 除掉控制区后的大部分 RE |
| PRACH | UL | 随机接入前导 | 上行预留资源 |
| PUCCH | UL | 上行控制（ACK/NACK、CQI、SR） | 上行带宽两端 |
| PUSCH | UL | 上行数据 | 上行大部分 RE |

记住优先级最高的三个就够了：PBCH 给 MIB，PDCCH 做调度，PDSCH 搬数据。规范出处是 3GPP TS 36.211（物理信道与调制）和 36.212（编码复用）。

## 6.2 小区搜索：PSS → SSS → PBCH

UE 开机后两眼一抹黑：不知道基站在哪个频点、不知道帧边界在哪、不知道自己听到的是哪个小区。小区搜索就是解决这三个问题，OpenLTE 里它的完整实现是 `LTE_fdd_dl_scan` 的状态机。

状态枚举在 `LTE_fdd_dl_scan/hdr/LTE_fdd_dl_scan_state_machine.h:65-72`，一共 6 个状态：

```cpp
typedef enum{
    LTE_FDD_DL_SCAN_STATE_MACHINE_STATE_COARSE_TIMING_SEARCH = 0,
    LTE_FDD_DL_SCAN_STATE_MACHINE_STATE_PSS_AND_FINE_TIMING_SEARCH,
    LTE_FDD_DL_SCAN_STATE_MACHINE_STATE_SSS_SEARCH,
    LTE_FDD_DL_SCAN_STATE_MACHINE_STATE_BCH_DECODE,
    LTE_FDD_DL_SCAN_STATE_MACHINE_STATE_PDSCH_DECODE_SIB1,
    LTE_FDD_DL_SCAN_STATE_MACHINE_STATE_PDSCH_DECODE_SI_GENERIC,
}LTE_FDD_DL_SCAN_STATE_MACHINE_STATE_ENUM;
```

整个状态机跑在一个 GNU Radio `sync_block` 的 `work()` 里（`LTE_fdd_dl_scan/src/LTE_fdd_dl_scan_state_machine.cc:202`）：采样先攒进一个大环形 buffer（`SAMP_BUF_SIZE = 307200*20`，即 20 帧的余量，`LTE_fdd_dl_scan_state_machine.cc:54`），攒够了就按当前状态处理一段。下面按状态走一遍。

### 第一步：粗定时 + 粗频偏

`LTE_fdd_dl_scan_state_machine.cc:264-292`：调 `liblte_phy_dl_find_coarse_timing_and_freq_offset`。它的原理是 OFDM 符号的循环前缀（CP）是符号尾部的一段复制——用你熟悉的词，这相当于用"消息头里嵌了一段和尾部相同的 sync word"来做自相关。相关峰的位置给出符号边界，相关值的相角给出载波频偏（CFO）。找不到峰就重试，`MAX_ATTEMPTS = 5` 次失败就换频点（`LTE_fdd_dl_scan_state_machine.cc:53`）。注意这里可能找到多个峰（多小区/多径），存在 `timing_struct` 里用 `corr_peak_idx` 逐个试。

### 第二步：PSS，精定时 + 扇区号

`LTE_fdd_dl_scan_state_machine.cc:294-312`：调 `liblte_phy_find_pss_and_fine_timing`。PSS 是 3 条已知序列（Zadoff-Chu 序列，3 个根），把接收符号和 3 条本地序列分别相关，哪条峰最高就给出 `N_id_2 ∈ {0,1,2}`，峰位置给出符号级精定时。成功后如果残余频偏还大于 100 Hz，再做一次频偏校正（`LTE_fdd_dl_scan_state_machine.cc:304-308`），然后进 SSS 搜索。

### 第三步：SSS，帧同步 + PCI

`LTE_fdd_dl_scan_state_machine.cc:326-373`：调 `liblte_phy_find_sss`，168 条候选序列相关，解出 `N_id_1` 和帧起始位置 `frame_start_idx`。然后拼出物理小区 ID：

```cpp
chan_data.N_id_cell = 3*N_id_1 + N_id_2;   // LTE_fdd_dl_scan_state_machine.cc:336
```

PCI = 3×N_id_1 + N_id_2，范围 0~503，这就是你在各种网优工具里看到的"PCI"。SSS 在子帧 0 和子帧 5 的内容不同，所以解出 SSS 的同时也知道了 10 ms 帧边界在哪。如果这个 PCI 之前解过了，就 `corr_peak_idx++` 回去试下一个相关峰（`LTE_fdd_dl_scan_state_machine.cc:338-350`）——这就是单频点多小区的来源。

### 第四步：PBCH，解 MIB

`LTE_fdd_dl_scan_state_machine.cc:374-413` 的调用链值得贴出来看，因为它是整条接收流水线的缩影：

```cpp
if(LIBLTE_SUCCESS == liblte_phy_get_dl_subframe_and_ce(phy_struct, ..., 0,    // 取子帧0并做信道估计
                                                       chan_data.N_id_cell, 4, &subframe) &&
   LIBLTE_SUCCESS == liblte_phy_bch_channel_decode(phy_struct, &subframe,     // PBCH 信道译码
                                                   chan_data.N_id_cell, &N_ant,
                                                   rrc_msg.msg, &rrc_msg.N_bits, &sfn_offset) &&
   LIBLTE_SUCCESS == liblte_rrc_unpack_bcch_bch_msg(&rrc_msg, &mib))          // RRC 层解 MIB
```

三个函数、三个层次：PHY 采样→符号（`get_dl_subframe_and_ce`，内含 FFT 和基于 CRS 的信道估计）、符号→比特（`bch_channel_decode`，解扰/解调/解速率匹配/Viterbi/CRC）、比特→结构体（`liblte_rrc_unpack_bcch_bch_msg`，这就是第 3 章讲的 RRC 编解码）。注意天线数 `N_ant` 不是配置出来的，是解 PBCH 时试出来的——PBCH 的 CRC 掩码携带天线数，下面 Octave 部分会看到细节。

MIB 一共 24 bit，布局如下（3GPP TS 36.331；解包实现见 `octave/lte_bcch_bch_msg_unpack.m:42-45`）：

| 字段 | 比特数 | 含义 |
|---|---|---|
| dl-Bandwidth | 3 | 下行带宽（6 档 RB 数） |
| phich-Config.duration | 1 | PHICH 时长 normal/extended |
| phich-Config.resource | 2 | PHICH 组数因子（1/6、1/2、1、2） |
| systemFrameNumber | 8 | SFN 的高 8 位（低 2 位靠 PBCH 40 ms 周期内的位置推出） |
| spare | 10 | 保留 |

解出 MIB 后状态机做两件关键的事：把 SFN 拼完整 `sfn = (mib.sfn_div_4 << 2) + sfn_offset`（`LTE_fdd_dl_scan_state_machine.cc:414`），以及按 MIB 里的带宽调 `liblte_phy_update_n_rb_dl` 重配 PHY（`LTE_fdd_dl_scan_state_machine.cc:424`）——此前一直按最小带宽 1.4 MHz 盲收，因为同步信号和 PBCH 永远在中央 6 RB，不需要先知道带宽。这是个很漂亮的协议设计，值得你停下来想一想为什么。

### 第五步：PDCCH+PDSCH，解 SIB1 和其它 SIB

SIB1 固定在偶数帧的子帧 5，用 SI-RNTI 加扰。状态机先对齐到偶数帧（`LTE_fdd_dl_scan_state_machine.cc:435-439`），然后 `LTE_fdd_dl_scan_state_machine.cc:467-494` 又是一条四段链：取子帧 → `liblte_phy_pdcch_channel_decode`（先解 PCFICH 拿 CFI，再盲检 PDCCH 拿 DCI 调度信息）→ `liblte_phy_pdsch_channel_decode`（按 DCI 指的位置解数据）→ `liblte_rrc_unpack_bcch_dlsch_msg`（出 SIB1）。之后进入 `PDSCH_DECODE_SI_GENERIC` 状态（`LTE_fdd_dl_scan_state_machine.cc:527-645`），逐子帧监听 SI-RNTI，把 SIB2~SIB8 都收一遍，通过 `interface->send_ctrl_sibX_decoded_msg` 上报给控制端口。

整个搜索流程的"失败回退"也很工程化：每一级失败都是回 `COARSE_TIMING_SEARCH` 重试，超过次数就 `channel_not_found` 换下一个频点（`LTE_fdd_dl_scan_state_machine.cc:786-808`）。

## 6.3 liblte_phy.h 函数地图

`liblte/hdr/liblte_phy.h` 共 1364 行，所有 PHY 能力的入口都在这。头文件按"信道"分节，每节按 `// Defines / // Enums / // Structs / // Functions` 四段排版。按功能分组如下：

| 分组 | 入口函数（`liblte/hdr/liblte_phy.h`） | 谁在用 |
|---|---|---|
| 初始化/清理 | `liblte_phy_init`（:606）、`liblte_phy_ul_init`（:613）、`liblte_phy_cleanup`（:638）、`liblte_phy_ul_cleanup`（:639）、`liblte_phy_update_n_rb_dl`（:652） | 全部程序 |
| 同步（收） | `liblte_phy_dl_find_coarse_timing_and_freq_offset`（:1134）、`liblte_phy_find_pss_and_fine_timing`（:1068）、`liblte_phy_find_sss`（:1106） | scan / file_scan |
| 同步信号（发） | `liblte_phy_map_pss`（:1051）、`liblte_phy_map_sss`（:1089）、`liblte_phy_map_crs`（:1034） | enodeb / file_gen |
| 子帧变换 | `liblte_phy_create_dl_subframe`（:1152，符号→IQ 采样）、`liblte_phy_get_dl_subframe_and_ce`（:1170，采样→符号+信道估计）、`liblte_phy_get_ul_subframe`（:1190） | 发端用前者，收端用后两者 |
| PBCH/BCH | `liblte_phy_bch_channel_encode`（:927）、`liblte_phy_bch_channel_decode`（:947） | enodeb 发、scan 收 |
| PDCCH（含 PCFICH/PHICH） | `liblte_phy_pdcch_channel_encode`（:988）、`liblte_phy_pdcch_channel_decode`（:1012）、`liblte_phy_get_n_cce`（:1271） | 同上 |
| PDSCH | `liblte_phy_pdsch_channel_encode`（:888）、`liblte_phy_pdsch_channel_decode`（:906） | 同上 |
| PUSCH | `liblte_phy_pusch_channel_encode`（:704）、`liblte_phy_pusch_channel_decode`（:722） | UE 侧编码（file_gen 不用）/ enodeb 收 |
| PUCCH | `liblte_phy_pucch_format_1_1a_1b_channel_decode`（:775）、`liblte_phy_pucch_map_sr_config_idx`（:830） | enodeb |
| PRACH | `liblte_phy_generate_prach`（:845）、`liblte_phy_detect_prach`（:862） | UE 侧 / enodeb |
| 调度计算 | `liblte_phy_get_tbs_mcs_and_n_prb_for_dl`（:1210）、`liblte_phy_get_tbs_and_n_prb_for_dl`（:1234）、`liblte_phy_get_tbs_mcs_and_n_prb_for_ul`（:1253） | enodeb MAC 调度器 |
| 编码积木 | `liblte_phy_rate_match_turbo`（:1288）、`liblte_phy_rate_unmatch_turbo`（:1311）、`liblte_phy_code_block_segmentation`（:1337）、`liblte_phy_code_block_desegmentation`（:1357） | 被上面的信道函数内部调用 |

"谁在用"这列是有源码依据的。enodeb 侧的典型调用点在 `LTE_fdd_enodeb/src/LTE_fdd_enb_phy.cc`：`liblte_phy_init`（:177）、`map_pss/map_sss/map_crs`（:557-569）、`bch_channel_encode`（:592）、`pdcch_channel_encode`（:736）、`pdsch_channel_encode`（:747）、`create_dl_subframe`（:765）发下行；`detect_prach`（:832）、`get_ul_subframe`（:852）、`pucch_format_1_1a_1b_channel_decode`（:867）、`pusch_channel_decode`（:911）收上行。MAC 调度器在 `LTE_fdd_enodeb/src/LTE_fdd_enb_mac.cc:1223` 等处调 `get_tbs_mcs_and_n_prb_for_dl` 算"这么多比特要几个 RB、什么 MCS"。scan 侧的调用你已经在 6.2 节见过了。

所有状态都塞在一个大结构体 `LIBLTE_PHY_STRUCT`（`liblte/hdr/liblte_phy.h:604` 收尾）里——FFT plan、预生成的参考信号、Viterbi/Turbo 的中间缓冲全在里面（比如 Viterbi 路径度量缓冲在 `liblte/hdr/liblte_phy.h:490-498`）。这是典型的"初始化一次、热路径零分配"写法，PHY 是硬实时代码，1 ms 一个子帧，没工夫 malloc。

## 6.4 四个 SDR 应用程序的分工与联动

仓库根下四个以 `LTE_` 开头的应用目录构成一个闭环：

```
                ┌────────────────────────┐
                │ LTE_fdd_dl_file_gen    │  纯软件生成下行 IQ 文件
                └──────────┬─────────────┘
                           ▼
 SDR 硬件 ──► LTE_file_recorder ──► IQ 文件 ──► LTE_fdd_dl_file_scan（离线解）
    │                                        └ 或 octave/lte_fdd_dl_receive
    └──► LTE_fdd_dl_scan（实时扫，直解直报）
```

### LTE_file_recorder：录 IQ

最简单的 GNU Radio 流图：osmosdr source → file sink（`LTE_file_recorder/src/LTE_file_recorder_flowgraph.cc:168` 建 file_sink，:214 连接）。没有命令行参数，`main` 起来后开一个 TCP 控制端口 25000（`LTE_file_recorder/hdr/LTE_file_recorder_interface.h:47`，`LTE_file_recorder/src/LTE_file_recorder_main.cc:63-67`），用 `telnet 127.0.0.1 25000` 连上后发文本命令。命令解析在 `LTE_file_recorder/src/LTE_file_recorder_interface.cc:199-220`：

```
write earfcn 1930          # 设置频点（EARFCN）
write file_name /tmp/x.bin # 设置输出文件
start                      # 开录
stop                       # 停录
```

参数名常量在 `LTE_file_recorder_interface.cc:46-47`。支持 USRP/HackRF/bladeRF/RTL-SDR，探测逻辑在 `LTE_file_recorder_flowgraph.cc:128-165`，和 dl_scan 几乎一样的套路。录出来的就是交织的 I/Q 字节流（RTL-SDR 是 int8），也就是 `Test captures/LTE_test_file_int8.bin` 这种文件的来源。

### LTE_fdd_dl_scan：实时扫描

带 SDR 的完整接收机。`main` 同样没有命令行参数，起控制端口 20000（`LTE_fdd_dl_scan/hdr/LTE_fdd_dl_scan_interface.h:52`，`LTE_fdd_dl_scan/src/LTE_fdd_dl_scan_main.cc:63-67`）。`telnet` 上去后的命令在 `LTE_fdd_dl_scan/src/LTE_fdd_dl_scan_interface.cc:1429-1450`：

```
write band 1                     # 扫哪个 band（整 band 的 EARFCN 列表自动生成，见 :116-123）
write dl_earfcn_list 100,300     # 或者手动指定频点列表
write repeat 1                   # 列表扫完是否循环
write enable_pcap 1              # 解出的消息写 PCAP
start / stop / shutdown
```

flowgraph 层（`LTE_fdd_dl_scan/src/LTE_fdd_dl_scan_flowgraph.cc:121-328`）负责硬件自动探测：依次试 USRP B 系列（主时钟 15.36 MHz）、USRP N、UmTRX、USRP X300、HackRF、bladeRF、RTL-SDR（:138-210 这一大段 if-else），按探测结果选采样率建状态机（:214-240），再按 EARFCN 设中心频率（:297）。之后 `work()` 里跑的就是 6.2 节那台状态机，解出的小区信息通过控制端口回报——`send_ctrl_channel_found_begin_msg` 把频点、PCI、SFN、天线数、带宽打成一行文本发出去（`LTE_fdd_dl_scan_interface.cc:206-228`）。

### LTE_fdd_dl_file_scan：离线扫描

dl_scan 的"文件版"，但架构不同：它是一个 Python 驱动的 GNU Radio 3.7 流图。`LTE_fdd_dl_file_scan/python/LTE_fdd_dl_file_scan.py:36-38` 就三行核心：file_source 读文件，接一个叫 `samp_buf` 的块，跑。用法：

```bash
LTE_fdd_dl_file_scan.py -d int8 "Test captures/LTE_test_file_int8.bin"
```

`-d` 指定采样数据类型（int8 或 gr_complex，`LTE_fdd_dl_file_scan.py:18-19`）。启动后它会在 stdin 打印配置菜单等你输入采样率（`LTE_fdd_dl_file_scan/src/LTE_fdd_dl_fs_samp_buf.cc:1774-1796` 的 `print_config`，默认 fs=30.72MHz，见 :119；可设 1.92/3.84/7.68/15.36/30.72，见 :1832-1852），直接回车用默认值开始扫。

`samp_buf` 这个块本身是 C++ 写的（`LTE_fdd_dl_fs_samp_buf.cc`，1852 行），状态机和 dl_scan 的几乎同构——枚举在 `LTE_fdd_dl_file_scan/hdr/LTE_fdd_dl_fs_samp_buf.h:89-95`，六态一一对应。Python 怎么能调 C++ 块？靠 SWIG：`LTE_fdd_dl_file_scan/src/LTE_fdd_dl_fs.i:11` 一行 `GR_SWIG_BLOCK_MAGIC(LTE_fdd_dl_fs,samp_buf);` 把头文件包成 Python 模块，`src/__init__.py` 再 `from LTE_fdd_dl_fs import *`。这就是 GNU Radio 3.7 时代 C++ 块的标准封装方式。

### LTE_fdd_dl_file_gen：下行信号发生器

镜像结构：Python 流图里 `samp_buf` 块当信源，接 file_sink 写文件（`LTE_fdd_dl_file_gen/python/LTE_fdd_dl_file_gen.py:36-38`），SWIG 接口同样是 `LTE_fdd_dl_file_gen/src/LTE_fdd_dl_fg.i:11`。用法：

```bash
LTE_fdd_dl_file_gen.py -d int8 /tmp/my_lte.bin
```

运行后先在 stdin 配参数——带宽、采样率、band、帧数、天线数、PCI、MCC/MNC、TAC、负载百分比等等（菜单见 `LTE_fdd_dl_file_gen/src/LTE_fdd_dl_fg_samp_buf.cc:761-919`）。C++ 块内部手工填好 MIB/SIB1/SIB2 结构体（默认值在 `LTE_fdd_dl_fg_samp_buf.cc:125-208`），然后逐子帧走完整的发送链：PSS/SSS 映射（:341-345）→ MIB 打包 + BCH 编码（:362-364）→ SIB 打包 → PDCCH 编码（:550）→ PDSCH 编码（:559）→ `liblte_phy_create_dl_subframe` 出 IQ（:569）。

这四个程序合起来就是一个不需要任何硬件的 PHY 教学闭环：file_gen 造信号 → file_scan 解信号 → 对不上就去看 octave 参考实现，或者直接拿 `Test captures/LTE_test_file_int8.bin` 这份真实空口录音。

## 6.5 Octave 接收机：看得见的流水线

`octave/` 目录 60 多个 `.m` 脚本是一个"教学版"LTE 收发机，和 `liblte_phy.cc` 功能对应但可读性好得多——矩阵操作直白，没有性能优化噪音。跑法（仓库自带测试文件，30.72 MS/s int8）：

```octave
fid = fopen("Test captures/LTE_test_file_int8.bin", "r");
iq_vec = fread(fid, inf, "int8");
iq_split_vec = reshape(iq_vec, 2, []);
addpath("octave");
lte_fdd_dl_receive(iq_split_vec(1,:) + i*iq_split_vec(2,:));
```

`octave/lte_fdd_dl_receive.m:37` 是主函数，流水线就是 6.2 节的脚本版：

1. **粗同步**：`find_coarse_time_and_freq_offset`（`lte_fdd_dl_receive.m:57`，内部函数在 :181-265）——CP 自相关，顺带估计分数频偏并校正（:59-61）。
2. **PSS**：`find_pss_and_fine_timing`（:65，实现在 :267-333）——本地生成 3 条 PSS（`octave/lte_generate_pss.m`），逐符号相关找峰，得到 `N_id_2` 和精定时。
3. **SSS**：`find_sss`（:76，实现在 :335-381）——168×2 条候选（子帧 0/5 两种，`octave/lte_generate_sss.m`）相关，得 `N_id_1`，拼 PCI = 3*N_id_1+N_id_2（:93）。
4. **信道估计**：`get_subframe_and_ce`（:98，实现在 :383-601）——对每个子帧做 FFT 变到频域，用 CRS（`octave/lte_generate_crs.m`）做信道估计：CRS 位置的接收值除以本地 CRS 得信道响应，再线性插值填满整个时频格（:450-473）。这是全脚本最长的函数，值得读一遍——"信道估计"听起来玄，说白了就是拿已知导频点除一除、再插值。
5. **PBCH 译码**：`decode_mib`（:99，实现在 :603-664）——解资源映射、解扰（`lte_generate_prs_c` 生成扰码）、按 1/2/4 天线尝试发送分集译码，PBCH 一个编码块跨 4 帧所以再按 mod-4 相位试 4 次（:634-662）。
6. **PDCCH/PDSCH**：`decode_pdcch`（:144，实现在 :666 起）先解 PCFICH 拿 CFI（`lte_cfi_channel_decode`），再避开盘点 PCFICH/PHICH/CRS 占掉的 REG，组 CCE，在公共搜索空间用 SI-RNTI 盲检 DCI 1A/1C；然后 `decode_pdsch`（:158）按 DCI 解数据，最后 `lte_bcch_dlsch_msg_unpack` + `lte_sib1_unpack` 出 SIB1 并打印（:161-170）。

编码链的底层积木也都摆在你面前。以 BCH 为例，`octave/lte_bch_channel_decode.m:30-48` 四步走完 36.212 的 BCH 译码：

```matlab
d_bits = lte_rate_unmatch_conv(bch_bits, 40);            % 解速率匹配，恢复 40 个编码比特
d_bits = reshape(d_bits, 1, []);
c_bits = cmn_viterbi_decode(d_bits, 7, 3, [133, 171, 165]); % Viterbi，约束长度7、码率1/3
a_bits = c_bits(1:24);                                    % 24 bit MIB
p_bits = c_bits(25:40);                                   % 16 bit CRC
calc_p_bits = lte_calc_crc(a_bits, 16);                   % 重算 CRC
```

后面 :46-68 用三种 CRC 掩码（全 0/全 1/0101…）逐一比对，比对上哪种就说明基站是 1/2/4 天线——这就是 6.2 节说的"天线数是试出来的"。Viterbi 本体在 `octave/cmn_viterbi_decode.m`，卷积编码在 `cmn_conv_encode.m`，速率匹配/解匹配在 `lte_rate_match_conv.m` / `lte_rate_unmatch_conv.m`，Turbo 码对应 `lte_turbo_encode.m` / `lte_turbo_decode.m`，CRC 在 `lte_calc_crc.m`。想改哪个环节，直接改脚本重跑就行——这是用 C++ 版本很难获得的迭代速度。

## 6.6 想继续深入 PHY 的话

到这里你手里已经有三张地图：函数地图（6.3）、状态机（6.2）、可执行的参考实现（6.5）。再往下走，建议的顺序：

1. **规范**：3GPP TS 36.211（物理信道与调制，回答"每个 RE 放什么"）和 36.212（复用与信道编码，回答"比特怎么变符号"）。这两本对照 `octave/` 脚本读，几乎每个公式都能在脚本里找到对应行。调度过程看 36.213。
2. **信号处理补课**：你至少需要——复数基带与 IQ 的含义、DFT/FFT、相关与匹配滤波（PSS/SSS 检测就是它）、卷积码与 Viterbi、最小二乘信道估计与插值。顺序上建议先把 `lte_fdd_dl_receive.m` 逐行啃透，遇到不懂的再去查理论，比先读书后看代码快得多。
3. **回到 C 实现**：`liblte/src/liblte_phy.cc`（一万四千行级别）做工程化版本——SSE 优化的 Turbo/Viterbi、fftw 集成。对照 Octave 版本读，重点看同一算法在"正确性优先"和"性能优先"下长相差多少。
4. **动手实验**：用 `LTE_fdd_dl_file_gen` 生成不同 PCI/带宽的信号，用 file_scan 和 Octave 各解一遍；然后试试在 Octave 里给信号加噪声、加频偏，看哪一级先崩——这比任何教科书都能教你"同步为什么难"。

## 小结

- LTE FDD 帧结构：10 ms 帧 = 10 子帧 = 20 时隙，带宽决定 RB 数（6~100），所有时频常量都在 `liblte/hdr/liblte_phy.h` 开头。
- 小区搜索是 PSS（扇区号+定时）→ SSS（组号+帧边界）→ PBCH（MIB）的串行流水线，`LTE_fdd_dl_scan/src/LTE_fdd_dl_scan_state_machine.cc` 的六态状态机就是它的完整实现；PCI = 3×N_id_1 + N_id_2，MIB 只有 24 bit。
- `liblte_phy.h` 按信道分组暴露约 30 个入口函数：scan 只用"同步+下行译码"一小组，enodeb 用收发全套，调度计算函数给 MAC 用。
- 四个 SDR 应用构成闭环：`LTE_file_recorder`（端口 25000）录 IQ、`LTE_fdd_dl_file_scan` 离线解、`LTE_fdd_dl_scan`（端口 20000）实时解、`LTE_fdd_dl_file_gen` 生成信号；后两者是纯 C++ 加 TCP 控制口，中间两者是 Python+SWIG 的 GNU Radio 流图。
- `octave/lte_fdd_dl_receive.m` 是整条接收链的可执行教科书，配 `Test captures/LTE_test_file_int8.bin` 可以直接跑；BCH 译码四步（解速率匹配→Viterbi→CRC→掩码试天线数）是理解 36.212 编码链的最好入口。
- 深入路线：36.211/36.212 + Octave 脚本互相对照，再回 `liblte_phy.cc` 看工程化实现。
