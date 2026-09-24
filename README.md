# 水库调度与汛限水位管理台

水库调度班用来管水位与库容、算水量平衡、盯汛限与预警、登记调度指令的小台子。

## 运行

```
npm install
npm start
```

默认端口 5208（`PORT` 可以覆盖），数据存在 `data/db.json`，页面在 `/`。

## 页面

- **概览**：水库数、今日各库水位与限水位、超限记录数、指令按状态、偏差超限的指令数（含清单）、预警等级。
- **水库**：水库台账（水位口径、曲线点数、库容对不上时的提示）、水位-库容曲线的维护与查询。
- **水位与流量**：水位记录、入库流量、出库流量的登记与查询。
- **调度指令**：指令的下达、逐段登记（开始执行、执行中逐日登记实际下泄流量、完成验收、撤销）、修改、复制、删除与附件的登记；每条指令都能看到从下达到完成的全过程，并与时段内出库记录对账。
- **水量平衡**：按水库与时段算入库/出库/损失/蓄变与残差，给出是否平衡。

## 口径（这一版按下列规则实现，页面上的说明与数字都要与本段一致）

1. **库容与水位**：库容在曲线的相邻两点之间线性插值；由库容反查水位也必须按**同一分段曲线反解**，两个方向要对得上（不能拿首末两点整体线性近似）。
2. **水量平衡**：入库水量 − 出库水量 − 损失 = 蓄变。流量（m³/s）换算成水量时按每天 **86400 秒**，再除以 10000 换成万 m³；损失 = 时段天数 × 每天损失（`lossPerDayWan`）。残差绝对值不超过 `balanceToleranceWan`（默认 0.5 万 m³）才算平衡。
3. **汛期**：按**日期**判断（`floodSeasonStart` 到 `floodSeasonEnd`，含两端）。汛限水位只在汛期适用，非汛期用正常蓄水位；汛期开始日之前的日子不能按汛期口径算。
4. **预警等级**：水位达到汛限/警戒要提级；**入库流量**达到 `inflowAttentionFlow`、`inflowSeriousFlow` 也要提级（两个输入都要看，不能只看水位）。
5. **指令编号**：`ZL-` 加四位，**取当前最大编号加一**；删掉指令之后新增不能重号。
6. **复制指令**：附件与说明是**各自的副本**，改一条不影响另一条；全过程登记不复制，新指令从「已下达」开始。
7. **指令闭环（逐段登记，不能跳段）**：下达（`issuedAt` + `issuer`，状态固定为「已下达」）→ 开始执行（`startedAt` + `starter`，进入「执行中」）→ 执行中逐日登记实际下泄流量（`executionFlows`，同指令同日期覆盖）→ 完成验收（`completedAt` + `acceptor`，进入「已完成」）；撤销单独留痕（`canceledAt` + `canceler` + `cancelReason`）。状态不允许通过修改接口直接改。
8. **执行对账**：按指令时段（`windowStart` 至 `windowEnd`，含两端）汇总「出库流量」记录，平均下泄流量 = 时段内出库记录流量的算术平均；偏差 = 平均下泄流量 − 目标下泄流量；**偏差绝对值不超过设置里的 `orderFlowTolerance`（默认 5 m³/s）才算在允许范围内**，该允许范围直接显示在页面上。时段内没有出库记录不能完成验收；缺登记的日期逐日列出；执行中自报流量与出库记录逐日核对，不一致逐日标出（以出库记录为对账基准）。
9. **偏差超限原因分类**：偏差超出允许范围的指令，完成验收前必须选择原因分类（上游来水变化 / 设备故障检修 / 电网调峰 / 下游用水需求变化 / 雨情与预报偏差 / 操作执行偏差 / 其他，可多选），可补原因说明；已撤销的指令不再参与偏差考核，概览与指令页把超限指令单独列出。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/health | 健康检查 |
| GET | /api/summary | 概览 |
| GET / PATCH | /api/settings | 全局设置（汛期起止、损失、容差、流量门槛等） |
| GET / POST | /api/reservoirs | 水库清单 / 新增 |
| GET / PATCH / DELETE | /api/reservoirs/:id | 水库详情（含曲线、水位、流量、指令）/ 修改 / 删除 |
| PUT | /api/reservoirs/:id/curve | 保存水位-库容曲线（校验水位与库容递增） |
| GET / POST | /api/levels | 水位记录清单（支持 reservoirId、from、to）/ 新增（同库同日同时刻覆盖） |
| DELETE | /api/levels/:id | 删除一条水位记录 |
| GET / POST | /api/flows?kind=inflow\|release | 入库或出库流量清单 / 新增 |
| DELETE | /api/flows/:kind/:id | 删除一条流量记录 |
| GET / POST | /api/orders | 调度指令清单（支持 reservoirId、status、deviation=exceeded）/ 下达（状态固定为「已下达」，必须登记下达人） |
| GET / PATCH / DELETE | /api/orders/:id | 指令详情（含全过程时间线、对账、实际均值、偏差、允许范围判定）/ 修改内容（不能直接改状态）/ 删除 |
| POST | /api/orders/:id/start | 登记开始执行（startedAt、starter），已下达 → 执行中 |
| POST / DELETE | /api/orders/:id/execution-flows[/:flowId] | 执行中逐日登记实际下泄流量（date、flow、operator、remark，同日覆盖）/ 删除一条登记 |
| POST | /api/orders/:id/complete | 完成验收（completedAt、acceptor；偏差超限必须带 deviationReasons），执行中 → 已完成 |
| POST | /api/orders/:id/cancel | 撤销（canceledAt、canceler、cancelReason） |
| POST | /api/orders/:id/copy | 复制指令（只复制内容与附件副本，全过程不复制） |
| POST | /api/orders/:id/attachments | 给指令加附件说明 |
| GET | /api/balance?reservoirId=&from=&to= | 时段水量平衡 |
| GET | /api/curve/query?reservoirId=&level=\|capacity= | 由水位查库容、由库容反查水位 |

出错的返回统一是 `{"error":{"code":"...","message":"...","details":{...}}}`，`details` 里会点名是哪个字段没过。
