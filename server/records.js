const { AppError } = require('./errors');
const store = require('./store');
const water = require('./water');
const reservoirs = require('./reservoirs');

// 水位记录
function listLevels(data, query) {
  const q = query || {};
  let rows = data.levels.slice();
  if (q.reservoirId) rows = rows.filter((l) => l.reservoirId === q.reservoirId);
  if (q.from) rows = rows.filter((l) => l.date >= q.from);
  if (q.to) rows = rows.filter((l) => l.date <= q.to);
  return rows
    .map((l) => {
      const reservoir = data.reservoirs.find((r) => r.id === l.reservoirId);
      const check = reservoir ? water.levelCheck(reservoir, l.level, l.date, data.settings) : null;
      const inflow = data.inflows
        .filter((x) => x.reservoirId === l.reservoirId && x.date === l.date)
        .reduce((s, x) => s + Number(x.flow), 0);
      const warning = reservoir ? water.warningOf(reservoir, l.level, inflow, data.settings) : null;
      return Object.assign({}, l, {
        reservoirName: reservoir ? reservoir.name : '',
        limit: check ? check.limit : null,
        over: check ? check.over : null,
        exceeded: check ? check.exceeded : false,
        floodSeason: check ? check.floodSeason : false,
        inflow,
        warning: warning ? warning.level : '',
      });
    })
    .sort((a, b) => (a.date === b.date ? (a.reservoirId < b.reservoirId ? -1 : 1) : a.date < b.date ? 1 : -1));
}

function saveLevel(data, payload) {
  const reservoir = reservoirs.find(data, payload.reservoirId);
  const date = String(payload.date || '').trim();
  const level = Number(payload.level);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError(400, 'VALIDATION_FAILED', '日期要按 年-月-日 填', { date: '日期格式不对' });
  if (!Number.isFinite(level)) throw new AppError(400, 'VALIDATION_FAILED', '水位要填数字', { level: '水位不对' });
  const existing = data.levels.find((l) => l.reservoirId === reservoir.id && l.date === date && l.time === String(payload.time || '08:00'));
  if (existing) {
    existing.level = level;
    existing.remark = String(payload.remark || '');
    return { updated: true, id: existing.id };
  }
  const record = {
    id: store.nextId('lev', data.levels),
    reservoirId: reservoir.id,
    date,
    time: String(payload.time || '08:00'),
    level,
    source: String(payload.source || '实测'),
    recorder: String(payload.recorder || '').trim(),
    remark: String(payload.remark || ''),
  };
  data.levels.push(record);
  return { updated: false, id: record.id };
}

function removeLevel(data, id) {
  const found = data.levels.find((l) => l.id === id);
  if (!found) throw new AppError(404, 'LEVEL_NOT_FOUND', '这条水位记录不存在');
  data.levels = data.levels.filter((l) => l.id !== id);
  return { removed: id };
}

// 入库与出库流量记录
function listFlows(data, kind, query) {
  const q = query || {};
  const source = kind === 'inflow' ? data.inflows : data.releases;
  let rows = source.slice();
  if (q.reservoirId) rows = rows.filter((r) => r.reservoirId === q.reservoirId);
  if (q.from) rows = rows.filter((r) => r.date >= q.from);
  if (q.to) rows = rows.filter((r) => r.date <= q.to);
  return rows
    .map((r) => {
      const reservoir = data.reservoirs.find((x) => x.id === r.reservoirId);
      return Object.assign({}, r, {
        reservoirName: reservoir ? reservoir.name : '',
        volumeWan: store.round((Number(r.flow) * 86400) / 10000, 3),
      });
    })
    .sort((a, b) => (a.date === b.date ? (a.reservoirId < b.reservoirId ? -1 : 1) : a.date < b.date ? 1 : -1));
}

function saveFlow(data, kind, payload) {
  const reservoir = reservoirs.find(data, payload.reservoirId);
  const date = String(payload.date || '').trim();
  const flow = Number(payload.flow);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError(400, 'VALIDATION_FAILED', '日期要按 年-月-日 填', { date: '日期格式不对' });
  if (!Number.isFinite(flow) || flow < 0) throw new AppError(400, 'VALIDATION_FAILED', '流量要填非负数字', { flow: '流量不对' });
  const list = kind === 'inflow' ? data.inflows : data.releases;
  const record = {
    id: store.nextId(kind === 'inflow' ? 'in' : 'out', list),
    reservoirId: reservoir.id,
    date,
    flow,
    type: kind === 'inflow' ? String(payload.type || '实测') : String(payload.type || '发电'),
    operator: String(payload.operator || '').trim(),
    remark: String(payload.remark || ''),
  };
  list.push(record);
  return record;
}

function removeFlow(data, kind, id) {
  const list = kind === 'inflow' ? data.inflows : data.releases;
  const found = list.find((r) => r.id === id);
  if (!found) throw new AppError(404, 'FLOW_NOT_FOUND', '这条记录不存在');
  if (kind === 'inflow') data.inflows = data.inflows.filter((r) => r.id !== id);
  else data.releases = data.releases.filter((r) => r.id !== id);
  return { removed: id };
}

// 调度指令
const ORDER_STATUS = ['已下达', '执行中', '已完成', '已撤销'];

// 闭环阶段：下达 → 执行 → 完成（或撤销）
const STAGE_ACTIONS = {
  start: { from: '已下达', to: '执行中' },
  complete: { from: '执行中', to: '已完成' },
  revoke: { from: ['已下达', '执行中'], to: '已撤销' },
};

// 偏差超出允许范围时的原因分类
const DEVIATION_REASONS = ['上游来水偏大', '上游来水偏小', '设备故障', '机组检修', '闸门操作误差', '下游需水调整', '雨情变化', '记录缺失待核', '其他'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 时段内每一天（含首尾）
function windowDates(start, end) {
  const days = store.daysBetween(start, end);
  if (!DATE_RE.test(start) || days < 0) return [];
  const out = [];
  for (let i = 0; i <= days; i += 1) {
    const t = new Date(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1, Number(start.slice(8, 10))) + i * 86400000);
    const d = new Date(t);
    out.push(d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'));
  }
  return out;
}

function decorateOrder(data, order) {
  const reservoir = data.reservoirs.find((r) => r.id === order.reservoirId);
  const tolerance = Number(data.settings.flowDeviationTolerance || 0);
  const releases = data.releases
    .filter((r) => r.reservoirId === order.reservoirId && r.date >= order.windowStart && r.date <= order.windowEnd)
    .sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? -1 : 1));

  // 同一天可能有多条（手工出库 + 执行登记），先按天取日均值再汇总
  const byDate = {};
  releases.forEach((r) => {
    if (!byDate[r.date]) byDate[r.date] = [];
    byDate[r.date].push(Number(r.flow));
  });
  const dates = Object.keys(byDate).sort();
  const dailyMeans = dates.map((d) => byDate[d].reduce((s, v) => s + v, 0) / byDate[d].length);
  const actualMean = dailyMeans.length ? store.round(dailyMeans.reduce((s, v) => s + v, 0) / dailyMeans.length, 2) : null;
  const deviation = actualMean === null ? null : store.round(actualMean - Number(order.targetFlow), 2);
  const withinTolerance = deviation === null ? null : Math.abs(deviation) <= tolerance;

  const expectedDates = windowDates(order.windowStart, order.windowEnd);
  const missingDates = expectedDates.filter((d) => !byDate[d]);

  const releaseRows = releases.map((r) => ({
    id: r.id,
    date: r.date,
    flow: Number(r.flow),
    type: r.type,
    operator: r.operator || '',
    source: r.orderId === order.id ? '执行登记' : '出库记录',
    linked: r.orderId === order.id,
    volumeWan: store.round((Number(r.flow) * 86400) / 10000, 3),
  }));

  return Object.assign({}, order, {
    reservoirName: reservoir ? reservoir.name : '',
    actualMean,
    deviation,
    deviationTolerance: tolerance,
    deviationLower: store.round(Number(order.targetFlow) - tolerance, 2),
    deviationUpper: store.round(Number(order.targetFlow) + tolerance, 2),
    withinTolerance,
    deviationReason: order.deviationReason || '',
    deviationNote: order.deviationNote || '',
    releaseCount: releases.length,
    expectedDays: expectedDates.length,
    recordedDays: dates.length,
    missingDates,
    releases: releaseRows,
    executionAt: order.executionAt || '',
    executor: order.executor || '',
    completionAt: order.completionAt || '',
    acceptor: order.acceptor || '',
    revokedAt: order.revokedAt || '',
    revoker: order.revoker || '',
  });
}

function listOrders(data, query) {
  const q = query || {};
  let rows = data.orders.slice();
  if (q.reservoirId) rows = rows.filter((o) => o.reservoirId === q.reservoirId);
  if (q.status) rows = rows.filter((o) => o.status === q.status);
  const decorated = rows.map((o) => decorateOrder(data, o));
  if (q.outOfRange === '1') {
    return decorated.filter((o) => o.withinTolerance === false && o.status !== '已撤销').sort((a, b) => (a.code < b.code ? -1 : 1));
  }
  return decorated.sort((a, b) => (a.code < b.code ? -1 : 1));
}

function findOrder(data, id) {
  const found = data.orders.find((o) => o.id === id);
  if (!found) throw new AppError(404, 'ORDER_NOT_FOUND', '这条调度指令不存在');
  return found;
}

// 指令编号：取持久化序列的下一个，删掉指令后新增也不重号
function nextOrderCodeNum(data) {
  const next = Number(data.orderCodeSeq || 0) + 1;
  data.orderCodeSeq = next;
  return next;
}

function lifecycleFields(payload) {  return {
    executionAt: String(payload.executionAt || '').trim(),
    executor: String(payload.executor || '').trim(),
    completionAt: String(payload.completionAt || '').trim(),
    acceptor: String(payload.acceptor || '').trim(),
    revokedAt: String(payload.revokedAt || '').trim(),
    revoker: String(payload.revoker || '').trim(),
  };
}

function createOrder(data, payload) {
  const reservoir = reservoirs.find(data, payload.reservoirId);
  const errors = {};
  const targetFlow = Number(payload.targetFlow);
  if (!Number.isFinite(targetFlow) || targetFlow <= 0) errors.targetFlow = '目标下泄流量要填正数';
  const windowStart = String(payload.windowStart || '').trim();
  const windowEnd = String(payload.windowEnd || '').trim();
  if (!DATE_RE.test(windowStart)) errors.windowStart = '起始日期格式不对';
  if (!DATE_RE.test(windowEnd)) errors.windowEnd = '结束日期格式不对';
  if (windowStart && windowEnd && windowEnd < windowStart) errors.windowEnd = '结束日期不能早于起始日期';
  const issuer = String(payload.issuer || '').trim();
  if (!issuer) errors.issuer = '下达人要填';
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '指令没通过校验，请按提示补齐', errors);
  }
  const codeNum = nextOrderCodeNum(data);
  const order = {
    id: store.nextId('ord', data.orders),
    code: 'ZL-' + String(codeNum).padStart(4, '0'),
    reservoirId: reservoir.id,
    issuedAt: DATE_RE.test(String(payload.issuedAt || '')) ? String(payload.issuedAt).trim() : store.todayIso(),
    targetFlow,
    windowStart,
    windowEnd,
    status: '已下达',
    reason: String(payload.reason || '').trim(),
    issuer,
    remark: String(payload.remark || ''),
    attachments: [],
    executionAt: '',
    executor: '',
    completionAt: '',
    acceptor: '',
    revokedAt: '',
    revoker: '',
    deviationReason: '',
    deviationNote: '',
  };
  data.orders.push(order);
  return decorateOrder(data, order);
}

function validateWindow(payload) {
  const errors = {};
  if (!DATE_RE.test(String(payload.windowStart || ''))) errors.windowStart = '起始日期格式不对';
  if (!DATE_RE.test(String(payload.windowEnd || ''))) errors.windowEnd = '结束日期格式不对';
  if (!errors.windowStart && !errors.windowEnd && payload.windowEnd < payload.windowStart) errors.windowEnd = '结束日期不能早于起始日期';
  return errors;
}

function updateOrder(data, id, payload) {
  const order = findOrder(data, id);

  // 状态改走闭环阶段接口的同一套规则
  if (payload.status !== undefined && payload.status !== order.status) {
    const actionMap = { 执行中: 'start', 已完成: 'complete', 已撤销: 'revoke', 已下达: null };
    const action = actionMap[payload.status];
    if (!action) throw new AppError(400, 'INVALID_STATUS', '撤销或完成后的指令不能改回' + payload.status);
    recordStage(data, order, action, payload, true);
  }

  const next = {
    targetFlow: payload.targetFlow !== undefined ? Number(payload.targetFlow) : order.targetFlow,
    windowStart: payload.windowStart !== undefined ? String(payload.windowStart) : order.windowStart,
    windowEnd: payload.windowEnd !== undefined ? String(payload.windowEnd) : order.windowEnd,
    issuedAt: payload.issuedAt !== undefined ? String(payload.issuedAt) : order.issuedAt,
  };
  const errors = {};
  if (!Number.isFinite(next.targetFlow) || next.targetFlow <= 0) errors.targetFlow = '目标下泄流量要填正数';
  if (!DATE_RE.test(next.issuedAt)) errors.issuedAt = '下达日期格式不对';
  Object.assign(errors, validateWindow(next));
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '指令没通过校验，请按提示补齐', errors);
  }
  Object.assign(order, next, {
    reason: payload.reason !== undefined ? String(payload.reason).trim() : order.reason,
    issuer: payload.issuer !== undefined ? String(payload.issuer).trim() : order.issuer,
    remark: payload.remark !== undefined ? String(payload.remark) : order.remark,
  });
  if (payload.deviationReason !== undefined) order.deviationReason = String(payload.deviationReason || '').trim();
  if (payload.deviationNote !== undefined) order.deviationNote = String(payload.deviationNote || '');
  if (payload.executionAt !== undefined) order.executionAt = String(payload.executionAt || '').trim();
  if (payload.executor !== undefined) order.executor = String(payload.executor || '').trim();
  if (payload.completionAt !== undefined) order.completionAt = String(payload.completionAt || '').trim();
  if (payload.acceptor !== undefined) order.acceptor = String(payload.acceptor || '').trim();
  return decorateOrder(data, order);
}

// 阶段登记：开始执行 / 完成验收 / 撤销。target 可以是 id 对应的指令（PATCH 内部调用）
function recordStage(data, target, action, payload, internal) {
  const order = internal ? target : findOrder(data, target);
  const rule = STAGE_ACTIONS[action];
  const body = payload || {};
  if (!rule) throw new AppError(400, 'INVALID_STAGE', '不支持的阶段操作：' + dashAction(action));
  const allowed = Array.isArray(rule.from) ? rule.from : [rule.from];
  if (allowed.indexOf(order.status) < 0) {
    throw new AppError(409, 'INVALID_STAGE', '指令当前是「' + order.status + '」，不能登记为「' + rule.to + '」');
  }
  const errors = {};
  const lf = lifecycleFields(body);
  const today = store.todayIso();

  if (action === 'start') {
    const at = lf.executionAt || today;
    if (!DATE_RE.test(at)) errors.executionAt = '执行时刻（日期）格式不对';
    if (!lf.executor) errors.executor = '开始执行要填执行人';
    if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '请补齐执行登记', errors);
    order.status = '执行中';
    order.executionAt = at;
    order.executor = lf.executor;
  } else if (action === 'complete') {
    const at = lf.completionAt || today;
    if (!DATE_RE.test(at)) errors.completionAt = '完成时刻（日期）格式不对';
    if (!lf.acceptor) errors.acceptor = '完成验收要填验收人';
    const decorated = decorateOrder(data, order);
    if (decorated.releaseCount === 0) errors.release = '时段内还没有出库记录，没法验收，请先登记执行中的下泄流量';
    if (decorated.missingDates.length) errors.missingDates = '时段内还有 ' + decorated.missingDates.length + ' 天没有出库记录（' + decorated.missingDates.slice(0, 5).join('、') + (decorated.missingDates.length > 5 ? ' 等' : '') + '），补齐后再验收';
    if (decorated.withinTolerance === false && !String(body.deviationReason || '').trim()) {
      errors.deviationReason = '平均下泄流量超出允许范围，验收前要选偏差原因分类';
    }
    if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '验收登记没通过', errors);
    order.status = '已完成';
    order.completionAt = at;
    order.acceptor = lf.acceptor;
    if (body.deviationReason !== undefined) order.deviationReason = String(body.deviationReason || '').trim();
    if (body.deviationNote !== undefined) order.deviationNote = String(body.deviationNote || '');
  } else if (action === 'revoke') {
    const at = lf.revokedAt || today;
    if (!DATE_RE.test(at)) errors.revokedAt = '撤销时刻（日期）格式不对';
    if (!lf.revoker) errors.revoker = '撤销要填撤销人';
    if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '请补齐撤销登记', errors);
    order.status = '已撤销';
    order.revokedAt = at;
    order.revoker = lf.revoker;
  }
  return decorateOrder(data, order);
}

function dashAction(action) { return String(action || ''); }

// 执行中登记实际下泄流量：写入出库记录（同库同一天覆盖），并与指令挂上钩
function registerExecutionFlow(data, id, payload) {
  const order = findOrder(data, id);
  const body = payload || {};
  const errors = {};
  const date = String(body.date || '').trim();
  const flow = Number(body.flow);
  if (!DATE_RE.test(date)) errors.date = '日期要按 年-月-日 填';
  if (!Number.isFinite(flow) || flow < 0) errors.flow = '流量要填非负数字';
  if (date && (date < order.windowStart || date > order.windowEnd)) errors.date = '登记日期要在指令时段 ' + order.windowStart + ' 至 ' + order.windowEnd + ' 内';
  const operator = String(body.operator || '').trim() || order.executor;
  if (!operator) errors.operator = '要填值班/执行人';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '执行登记没通过', errors);

  if (order.status === '已撤销') throw new AppError(409, 'ORDER_REVOKED', '已撤销的指令不能再登记流量');
  if (order.status === '已完成') throw new AppError(409, 'ORDER_COMPLETED', '已完成验收的指令不能再登记流量，如需补录请先联系验收人');
  // 已下达的指令第一次登记流量，自动转入执行中
  if (order.status === '已下达') {
    order.status = '执行中';
    if (!order.executionAt) order.executionAt = date;
    if (!order.executor) order.executor = operator;
  }

  const existing = data.releases.find((r) => r.reservoirId === order.reservoirId && r.date === date);
  if (existing) {
    existing.flow = flow;
    existing.type = String(body.type || '执行登记');
    existing.operator = operator;
    existing.remark = String(body.remark || '');
    existing.orderId = order.id;
    return { __updated: true, releaseId: existing.id, order: decorateOrder(data, order) };
  }
  const record = {
    id: store.nextId('out', data.releases),
    reservoirId: order.reservoirId,
    date,
    flow,
    type: String(body.type || '执行登记'),
    operator,
    remark: String(body.remark || ''),
    orderId: order.id,
  };
  data.releases.push(record);
  return { __updated: false, releaseId: record.id, order: decorateOrder(data, order) };
}

// 登记偏差原因分类（偏差超限清单用，已完成也能补）
function classifyDeviation(data, id, payload) {
  const order = findOrder(data, id);
  const reason = String((payload && payload.deviationReason) || '').trim();
  if (DEVIATION_REASONS.indexOf(reason) < 0) {
    throw new AppError(400, 'VALIDATION_FAILED', '原因分类只能选：' + DEVIATION_REASONS.join('、'), { deviationReason: '请选一个原因分类' });
  }
  order.deviationReason = reason;
  order.deviationNote = String((payload && payload.deviationNote) || '');
  return decorateOrder(data, order);
}

// 复制一条指令（附件与说明各自一份副本）
function copyOrder(data, id, payload) {
  const source = findOrder(data, id);
  const codeNum = nextOrderCodeNum(data);
  const p = payload || {};
  const order = {
    id: store.nextId('ord', data.orders),
    code: 'ZL-' + String(codeNum).padStart(4, '0'),
    reservoirId: source.reservoirId,
    issuedAt: DATE_RE.test(String(p.issuedAt || '')) ? String(p.issuedAt).trim() : store.todayIso(),
    targetFlow: Number(source.targetFlow),
    windowStart: DATE_RE.test(String(p.windowStart || '')) ? String(p.windowStart) : String(source.windowStart),
    windowEnd: DATE_RE.test(String(p.windowEnd || '')) ? String(p.windowEnd) : String(source.windowEnd),
    status: '已下达',
    reason: String(p.reason !== undefined ? p.reason : source.reason),
    issuer: String(p.issuer !== undefined ? p.issuer : source.issuer),
    remark: String(p.remark !== undefined ? p.remark : source.remark),
    attachments: (source.attachments || []).map((a) => ({ name: a.name, note: a.note, at: a.at })),
    executionAt: '',
    executor: '',
    completionAt: '',
    acceptor: '',
    revokedAt: '',
    revoker: '',
    deviationReason: '',
    deviationNote: '',
  };
  if (order.windowEnd < order.windowStart) throw new AppError(400, 'VALIDATION_FAILED', '结束日期不能早于起始日期', { windowEnd: '结束日期不能早于起始日期' });
  data.orders.push(order);
  return decorateOrder(data, order);
}

function removeOrder(data, id) {
  const order = findOrder(data, id);
  if (order.status === '执行中') throw new AppError(409, 'ORDER_RUNNING', '执行中的指令不能删除，请先撤销或完成验收');
  data.orders = data.orders.filter((o) => o.id !== id);
  return { removed: id };
}

function addAttachment(data, id, payload) {
  const order = findOrder(data, id);
  const name = String((payload && payload.name) || '').trim();
  if (!name) throw new AppError(400, 'VALIDATION_FAILED', '附件名称不能为空', { name: '请填附件名称' });
  order.attachments = order.attachments || [];
  order.attachments.push({ name, note: String((payload && payload.note) || '').trim(), at: store.todayIso() });
  return decorateOrder(data, order);
}

module.exports = {
  listLevels,
  saveLevel,
  removeLevel,
  listFlows,
  saveFlow,
  removeFlow,
  listOrders,
  findOrder,
  createOrder,
  updateOrder,
  recordStage,
  registerExecutionFlow,
  classifyDeviation,
  copyOrder,
  removeOrder,
  addAttachment,
  decorateOrder,
  ORDER_STATUS,
  DEVIATION_REASONS,
};
