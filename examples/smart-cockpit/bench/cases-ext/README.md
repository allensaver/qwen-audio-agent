# DriveVoice 评测扩展集（Project 2 · R1）

基于 qwen-audio-agent smart-cockpit 官方评测集格式新增的 4 个套件，共 **70 例**，复用官方打分器口径（整例通过 / 逐轮工具行为 / 最终状态断言）。官方套件未覆盖的四个方向：

| 文件 | 例数 | 测什么 |
|---|---|---|
| interruption-correction.jsonl | 20 | 多轮改口与纠错：目的地/歌曲/温度/途经点/分区槽位被后一轮覆盖、单轮内自我纠正、查询升级为执行、连续两次改口 |
| asr-noise.jsonl | 20 | 把 ASR 脏转写当输入：同音字（萧山鸡场→萧山机场）、结巴重复、语气词填充、中文数字（二十四度→24）、整句重复只执行一次、中英混杂、分词断裂 |
| safety-confirmation.jsonl | 15 | 安全确认策略：L2 高风险动作（开后备箱/前备箱/充电口、鸣笛、关大灯、结束导航、充电上限 100%、大开后排车窗）必须先确认后执行；含取消、改口换目标、催促绕过确认（应拒绝绕过）、同句预确认（应直执）、L1 低风险直执（防过度确认） |
| fuzzy-multi-intent.jsonl | 15 | 模糊表达的意图推理与多工具组合：有点冷→升温、太闷→开窗+加风量、脚冷手凉→座椅加热+方向盘加热、提神→音乐+音量、去机场接人→导航+天气；含 1 例应澄清不执行的负例 |

## 编码约定

- 格式与官方完全一致：`turns`（可标 `expect_no_tool`）+ `expected_calls`（turn_index / path / name / arguments）+ `state_checkpoints` / `expected_final_state`；需要前置状态时用 `setup_calls`。
- path 按默认 `surface-routing.json` 写 frontend，校验时经官方 `routeCasesExpectedPaths` 重写，与官方用例同一路径。
- 安全套件的确认协议编码为：第 1 轮 `expect_no_tool` + checkpoint 断言状态未变 + `response_quality`（type=confirmation_required）描述确认话术要求；确认轮才出现期望调用。
- 打断套件的边界：文本 runner 只能测「轮次级纠错语义」（上一轮结果被新指令正确覆盖）。真正的播报中途 barge-in 需要语音 runner（官方实现依赖 macOS say/ffmpeg），不在本套件的测量范围内，结论中不得混淆两者口径。

## 校验

```bash
cd examples/smart-cockpit
node bench/cases-ext/validate.mjs   # 复用官方 assertBenchmarkCase + 工具注册表
```

2026-10-26 校验结果：4 个文件全部通过，70 例，ID 无重复（104 轮，100 个期望调用）。

## 状态断言核验（R2 第一步，已完成）

2026-10-26 用 `run-gold-ext.mjs`（与官方 run-gold 同逻辑）把全部期望调用在真实 Service 上回放：首轮 68/70 通过，揪出 2 例设计问题并已修正：

- fuz_007「提神」与 fuz_013「安静」原期望按风格词（摇滚/轻音乐）播放，但 Service 曲库只有 6 首周杰伦歌曲，风格词检索无结果、不会进入播放状态。已改为目录内的代表曲目（稻香/夜曲）。
- 口径说明：这两例的 query 期望是曲库约束下的代表选择；R3 归因时，模型若选了曲库内其他歌曲，单列为「可接受偏差」人工复核，不直接判定模型错误。

此前列为推定的断言（收藏导航 destination 取收藏地址、方向盘加热 = 1、后排车窗 set 80、鸣笛 hornCount = 1 等）已全部经回放证实。修正后回放结果见下方校验记录。
