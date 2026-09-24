# 水库调度与汛限水位管理台

水库调度班用来管水位与库容、算水量平衡、盯汛限与预警、登记调度指令的小台子。

## 运行

```
npm install
npm start
```

默认端口 5208（`PORT` 可以覆盖），数据存在 `data/db.json`，页面在 `/`。

## 页面

- **概览**：水库数、今日各库水位与限水位、超限记录数、指令按状态、偏差超限的指令数、预警等级。
- **水库**：水库台账（水位口径、曲线点数、库容对不上时的提示）、水位-库容曲线的维护与查询。
- **水位与流量**：水位记录、入库流量、出库流量的登记与查询。
- **调度指令**：指令的下达、逐段登记（开始执行、执行中登记实际下泄流量、完成验收、撤销）、修改、复制、删除与附件；全过程（下达时刻/下达人、执行时刻/执行人、完成时刻/验收人、撤销时刻/撤销人）与出库对账（平均下泄流量、偏差、允许范围、缺记日期）可查；偏差超出允许范围的指令单列并登记原因分类。
- **水量平衡**：按水库与时段算入库/出库/损失/蓄变与残差，给出是否平衡。

## 口径（这一版按下列规则实现，页面上的说明与数字都要与本段一致）

1. **库容与水位**：库容在曲线的相邻两点之间线性插值；由库容反查水位也必须按**同一分段曲线反解**，两个方向要对得上（不能拿首末两点整体线性近似）。
2. **水量平衡**：入库水量 − 出库水量 − 损失 = 蓄变。流量（m³/s）换算成水量时按每天 **86400 秒**，再除以 10000 换成万 m³；损失 = 时段天数 × 每天损失（`lossPerDayWan`）。残差绝对值不超过 `balanceToleranceWan`（默认 0.5 万 m³）才算平衡。
3. **汛期**：按**日期**判断（`floodSeasonStart` 到 `floodSeasonEnd`，含两端）。汛限水位只在汛期适用，非汛期用正常蓄水位；汛期开始日之前的日子不能按汛期口径算。
4. **预警等级**：水位达到汛限/警戒要提级；**入库流量**达到 `inflowAttentionFlow`、`inflowSeriousFlow` 也要提级（两个输入都要看，不能只看水位）。
5. **指令编号**：`ZL-` 加四位，**取当前最大编号加一**；删掉指令之后新增不能重号。
6. **复制指令**：附件与说明是**各自的副本**，改一条不影响另一条。
7. **指令闭环**：状态只能按 **已下达 → 执行中 → 已完成** 推进（已下达/执行中可撤销）；开始执行要登记执行时刻与执行人，完成要登记完成时刻与验收人。执行中登记的实际下泄流量写入**出库记录**（同库同日覆盖，并带 `orderId`），第一次登记自动把指令转入执行中。
8. **出库对账**：按指令时段（`windowStart` 至 `windowEnd`，含首尾）汇总出库记录，同一天多条先取日均值，再对各日取算术平均得到**平均下泄流量**；偏差 = 平均下泄流量 − 目标流量；`|偏差| ≤ flowDeviationTolerance`（默认 ±5 m³/s，在设置里维护）算在允许范围内。时段内缺记的日期要列出来，缺记未补齐或偏差超限未选原因分类时不能验收。已撤销的指令不进偏差超限清单。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/health | 健康检查 |
| GET | /api/summary | 概览 |
| GET / PATCH | /api/settings | 全局设置（汛期起止、损失、容差、流量门槛、指令流量允许偏差 flowDeviationTolerance 等） |
| GET / POST | /api/reservoirs | 水库清单 / 新增 |
| GET / PATCH / DELETE | /api/reservoirs/:id | 水库详情（含曲线、水位、流量、指令）/ 修改 / 删除 |
| PUT | /api/reservoirs/:id/curve | 保存水位-库容曲线（校验水位与库容递增） |
| GET / POST | /api/levels | 水位记录清单（支持 reservoirId、from、to）/ 新增（同库同日同时刻覆盖） |
| DELETE | /api/levels/:id | 删除一条水位记录 |
| GET / POST | /api/flows?kind=inflow\|release | 入库或出库流量清单 / 新增 |
| DELETE | /api/flows/:kind/:id | 删除一条流量记录 |
| GET / POST | /api/orders | 调度指令清单（支持 reservoirId、status、outOfRange=1）/ 下达（状态固定为已下达） |
| GET / PATCH / DELETE | /api/orders/:id | 指令详情（含全过程登记、逐日出库对账、平均/偏差/允许范围/缺记）/ 修改（状态跳转同样受闭环规则约束）/ 删除 |
| POST | /api/orders/:id/stages/:action | 阶段登记：action=start（开始执行，要 executionAt/executor）/ complete（完成验收，要 completionAt/acceptor，偏差超限时还要 deviationReason）/ revoke（撤销，要 revokedAt/revoker） |
| POST | /api/orders/:id/executions | 执行中登记实际下泄流量（date/flow/operator/type/remark），写入出库记录，同库同日覆盖；第一次登记自动转入执行中 |
| PATCH | /api/orders/:id/deviation | 登记偏差原因分类（deviationReason 取固定分类，deviationNote 说明） |
| POST | /api/orders/:id/copy | 复制指令（编号取持久序列的下一个，删除后新增不重号） |
| POST | /api/orders/:id/attachments | 给指令加附件说明 |
| GET | /api/balance?reservoirId=&from=&to= | 时段水量平衡 |
| GET | /api/curve/query?reservoirId=&level=\|capacity= | 由水位查库容、由库容反查水位 |

出错的返回统一是 `{"error":{"code":"...","message":"...","details":{...}}}`，`details` 里会点名是哪个字段没过。
