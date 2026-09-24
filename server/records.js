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

// 偏差超出允许范围时的原因分类（完成验收时选）
const DEVIATION_REASONS = ['上游来水变化', '设备故障/检修', '电网调峰', '下游用水需求变化', '雨情与预报偏差', '操作执行偏差', '其他'];

// 编号：ZL- 加四位，取当前最大编号加一（删过指令也不能重号）
function nextOrderCode(orders) {
  let max = 0;
  for (const o of orders || []) {
    const matched = String(o.code || '').match(/(\d+)\s*$/);
    if (matched) max = Math.max(max, Number(matched[1]));
  }
  return 'ZL-' + String(max + 1).padStart(4, '0');
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

// 时段内逐天日期（含两端）
function datesBetween(from, to) {
  const dates = [];
  if (!validDate(from) || !validDate(to) || to < from) return dates;
  const a = from.split('-').map(Number);
  const b = to.split('-').map(Number);
  const cursor = new Date(Date.UTC(a[0], a[1] - 1, a[2]));
  const end = new Date(Date.UTC(b[0], b[1] - 1, b[2]));
  while (cursor.getTime() <= end.getTime()) {
    dates.push(
      cursor.getUTCFullYear() +
        '-' +
        String(cursor.getUTCMonth() + 1).padStart(2, '0') +
        '-' +
        String(cursor.getUTCDate()).padStart(2, '0')
    );
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

// 把一条指令与时段内的出库记录对上，算出执行情况
function decorateOrder(data, order) {
  const reservoir = data.reservoirs.find((r) => r.id === order.reservoirId);
  const tolerance = Number(data.settings.orderFlowTolerance) || 0;

  const releases = data.releases
    .filter((r) => r.reservoirId === order.reservoirId && r.date >= order.windowStart && r.date <= order.windowEnd)
    .sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? -1 : 1));

  const releaseCount = releases.length;
  const actualMean = releaseCount ? store.round(releases.reduce((s, r) => s + Number(r.flow), 0) / releaseCount, 2) : null;
  const deviation = actualMean === null ? null : store.round(actualMean - Number(order.targetFlow), 2);
  const deviationAbs = deviation === null ? null : store.round(Math.abs(deviation), 2);

  // 应执行天数、已报天数、缺报日期
  const windowDates = datesBetween(order.windowStart, order.windowEnd);
  const reportedDates = {};
  releases.forEach((r) => { reportedDates[r.date] = true; });
  const missingDates = windowDates.filter((d) => !reportedDates[d]);

  // 执行中自报的实际下泄流量，与出库记录逐日对账
  const execFlows = (order.executionFlows || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const releaseByDate = {};
  releases.forEach((r) => {
    if (!releaseByDate[r.date]) releaseByDate[r.date] = { total: 0, count: 0 };
    releaseByDate[r.date].total += Number(r.flow);
    releaseByDate[r.date].count += 1;
  });
  const execByDate = {};
  execFlows.forEach((x) => { execByDate[x.date] = Number(x.flow); });
  const reconciliation = windowDates.map((date) => {
    const rel = releaseByDate[date];
    const releaseFlow = rel ? store.round(rel.total / rel.count, 2) : null; // 同一天多条取均值
    const registeredFlow = execByDate[date] !== undefined ? execByDate[date] : null;
    let status = '一致';
    if (releaseFlow === null && registeredFlow === null) status = '两边都没登记';
    else if (releaseFlow === null) status = '只在执行登记里有，出库记录缺';
    else if (registeredFlow === null) status = '出库记录有，执行未登记';
    else if (Math.abs(releaseFlow - registeredFlow) > 0.01) status = '两边流量不一致';
    return {
      date,
      releaseFlow,
      registeredFlow,
      diff: releaseFlow !== null && registeredFlow !== null ? store.round(registeredFlow - releaseFlow, 2) : null,
      status,
    };
  });
  const mismatchRows = reconciliation.filter((x) => x.status !== '一致');
  const executionMean = execFlows.length ? store.round(execFlows.reduce((s, x) => s + Number(x.flow), 0) / execFlows.length, 2) : null;
  const executionDeviation = executionMean === null ? null : store.round(executionMean - Number(order.targetFlow), 2);

  const canceled = order.status === '已撤销';
  const deviationWithinRange = deviation === null || canceled ? null : deviationAbs <= tolerance;
  const deviationExceeded = deviationWithinRange === false;
  const missingReport = missingDates.length > 0;

  const timeline = [
    { key: 'issued', label: '下达', at: order.issuedAt || '', person: order.issuer || '', remark: order.reason || '', done: true },
    { key: 'started', label: '开始执行', at: order.startedAt || '', person: order.starter || '', remark: '', done: !!order.startedAt },
    { key: 'completed', label: '完成验收', at: order.completedAt || '', person: order.acceptor || '', remark: order.completeRemark || '', done: !!order.completedAt },
  ];
  if (canceled) timeline.push({ key: 'canceled', label: '撤销', at: order.canceledAt || '', person: order.canceler || '', remark: order.cancelReason || '', done: true });

  return Object.assign({}, order, {
    reservoirName: reservoir ? reservoir.name : '',
    timeline,
    executionFlows: execFlows,
    executionFlowCount: execFlows.length,
    executionMean,
    executionDeviation,
    reconciliation,
    reconciliationMismatchCount: mismatchRows.length,
    releasesInWindow: releases.map((r) => ({ id: r.id, date: r.date, flow: Number(r.flow), type: r.type, operator: r.operator || '', remark: r.remark || '' })),
    releaseCount,
    windowDays: windowDates.length,
    reportedDays: Object.keys(reportedDates).length,
    missingDates,
    missingReport,
    actualMean,
    deviation,
    deviationAbs,
    tolerance,
    toleranceText: '±' + tolerance + ' m³/s',
    deviationWithinRange,
    deviationExceeded,
    level: reservoir ? water.levelCheck(reservoir, order.targetFlow, order.issuedAt, data.settings) : null,
  });
}

function listOrders(data, query) {
  const q = query || {};
  let rows = data.orders.slice();
  if (q.reservoirId) rows = rows.filter((o) => o.reservoirId === q.reservoirId);
  if (q.status) rows = rows.filter((o) => o.status === q.status);
  if (q.deviation === 'exceeded') rows = rows.filter((o) => decorateOrder(data, o).deviationExceeded);
  return rows.map((o) => decorateOrder(data, o)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function findOrder(data, id) {
  const found = data.orders.find((o) => o.id === id);
  if (!found) throw new AppError(404, 'ORDER_NOT_FOUND', '这条调度指令不存在');
  return found;
}

function createOrder(data, payload) {
  const reservoir = reservoirs.find(data, payload.reservoirId);
  const errors = {};
  const targetFlow = Number(payload.targetFlow);
  if (!Number.isFinite(targetFlow) || targetFlow <= 0) errors.targetFlow = '目标下泄流量要填正数';
  const windowStart = String(payload.windowStart || '').trim();
  const windowEnd = String(payload.windowEnd || '').trim();
  if (!validDate(windowStart)) errors.windowStart = '起始日期格式不对';
  if (!validDate(windowEnd)) errors.windowEnd = '结束日期格式不对';
  if (validDate(windowStart) && validDate(windowEnd) && windowEnd < windowStart) errors.windowEnd = '结束日期不能早于起始日期';
  const issuedAt = String(payload.issuedAt || '').trim();
  if (issuedAt && !validDate(issuedAt)) errors.issuedAt = '下达日期格式不对';
  const issuer = String(payload.issuer || '').trim();
  if (!issuer) errors.issuer = '下达人要登记';
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '指令没通过校验，请按提示补齐', errors);
  }
  const order = {
    id: store.nextId('ord', data.orders),
    code: nextOrderCode(data.orders),
    reservoirId: reservoir.id,
    issuedAt: issuedAt || store.todayIso(),
    targetFlow,
    windowStart,
    windowEnd,
    status: '已下达',
    reason: String(payload.reason || '').trim(),
    issuer,
    remark: String(payload.remark || ''),
    attachments: [],
    // 全过程登记：下达之后，执行、完成逐段补
    startedAt: '',
    starter: '',
    completedAt: '',
    acceptor: '',
    completeRemark: '',
    canceledAt: '',
    canceler: '',
    cancelReason: '',
    executionFlows: [],
    deviationReasons: [],
    deviationNote: '',
  };
  data.orders.push(order);
  return decorateOrder(data, order);
}

// 修改指令内容：状态不允许直接改，必须走 开始执行/完成验收/撤销 的逐段登记
function updateOrder(data, id, payload) {
  const order = findOrder(data, id);
  if (payload.status !== undefined && payload.status !== order.status) {
    throw new AppError(409, 'ORDER_STATUS_LOCKED', '状态不能直接改，请用「开始执行 / 完成验收 / 撤销」逐段登记', { status: '请走阶段登记' });
  }
  if (order.status === '已撤销') throw new AppError(409, 'ORDER_CANCELED', '已撤销的指令不能再改');

  const errors = {};
  const targetFlow = payload.targetFlow !== undefined ? Number(payload.targetFlow) : Number(order.targetFlow);
  if (!Number.isFinite(targetFlow) || targetFlow <= 0) errors.targetFlow = '目标下泄流量要填正数';
  const windowStart = payload.windowStart !== undefined ? String(payload.windowStart) : order.windowStart;
  const windowEnd = payload.windowEnd !== undefined ? String(payload.windowEnd) : order.windowEnd;
  const issuedAt = payload.issuedAt !== undefined ? String(payload.issuedAt) : order.issuedAt;
  if (!validDate(windowStart)) errors.windowStart = '起始日期格式不对';
  if (!validDate(windowEnd)) errors.windowEnd = '结束日期格式不对';
  if (validDate(windowStart) && validDate(windowEnd) && windowEnd < windowStart) errors.windowEnd = '结束日期不能早于起始日期';
  if (issuedAt && !validDate(issuedAt)) errors.issuedAt = '下达日期格式不对';
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '指令没通过校验，请按提示补齐', errors);
  }

  Object.assign(order, {
    targetFlow,
    windowStart,
    windowEnd,
    issuedAt,
    reason: payload.reason !== undefined ? String(payload.reason).trim() : order.reason,
    issuer: payload.issuer !== undefined ? String(payload.issuer).trim() : order.issuer,
    remark: payload.remark !== undefined ? String(payload.remark) : order.remark,
  });

  // 偏差原因分类与说明：完成验收后也允许补录、修正
  if (payload.deviationReasons !== undefined) order.deviationReasons = normalizeReasons(payload.deviationReasons);
  if (payload.deviationNote !== undefined) order.deviationNote = String(payload.deviationNote || '');

  return decorateOrder(data, order);
}

function normalizeReasons(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,，、]/);
  const out = [];
  for (const item of list) {
    const text = String(item || '').trim();
    if (text && DEVIATION_REASONS.includes(text) && !out.includes(text)) out.push(text);
  }
  return out;
}

// 阶段一：开始执行（已下达 → 执行中）
function startOrder(data, id, payload) {
  const order = findOrder(data, id);
  if (order.status !== '已下达') throw new AppError(409, 'ORDER_STAGE_INVALID', '只有「已下达」的指令才能登记开始执行，当前状态：' + order.status);
  const p = payload || {};
  const startedAt = String(p.startedAt || '').trim() || store.todayIso();
  const starter = String(p.starter || '').trim();
  const errors = {};
  if (!validDate(startedAt)) errors.startedAt = '执行日期格式不对';
  if (startedAt < order.issuedAt) errors.startedAt = '开始执行不能早于下达日期';
  if (!starter) errors.starter = '执行人（开始执行登记人）要填';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '开始执行登记没通过校验', errors);
  order.startedAt = startedAt;
  order.starter = starter;
  order.status = '执行中';
  return decorateOrder(data, order);
}

// 阶段二：执行中逐次登记实际下泄流量（同指令同日期覆盖）
function addExecutionFlow(data, id, payload) {
  const order = findOrder(data, id);
  if (order.status !== '执行中') throw new AppError(409, 'ORDER_STAGE_INVALID', '只有「执行中」的指令才能登记实际下泄流量，当前状态：' + order.status);
  const p = payload || {};
  const date = String(p.date || '').trim();
  const flow = Number(p.flow);
  const errors = {};
  if (!validDate(date)) errors.date = '日期要按 年-月-日 填';
  if (validDate(date) && (date < order.windowStart || date > order.windowEnd)) errors.date = '登记日期要在指令时段 ' + order.windowStart + ' 至 ' + order.windowEnd + ' 内';
  if (!Number.isFinite(flow) || flow < 0) errors.flow = '实际下泄流量要填非负数字';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '执行流量没通过校验', errors);
  order.executionFlows = order.executionFlows || [];
  const existing = order.executionFlows.find((x) => x.date === date);
  if (existing) {
    existing.flow = flow;
    existing.operator = String(p.operator || '').trim();
    existing.remark = String(p.remark || '');
    existing.updatedAt = store.todayIso();
  } else {
    order.executionFlows.push({
      id: store.nextId('exf', order.executionFlows),
      date,
      flow,
      operator: String(p.operator || '').trim(),
      remark: String(p.remark || ''),
      recordedAt: store.todayIso(),
      updatedAt: '',
    });
  }
  order.executionFlows.sort((a, b) => (a.date < b.date ? -1 : 1));
  return decorateOrder(data, order);
}

function removeExecutionFlow(data, id, flowId) {
  const order = findOrder(data, id);
  const before = (order.executionFlows || []).length;
  order.executionFlows = (order.executionFlows || []).filter((x) => x.id !== flowId);
  if (order.executionFlows.length === before) throw new AppError(404, 'EXECUTION_FLOW_NOT_FOUND', '这条执行流量登记不存在');
  return decorateOrder(data, order);
}

// 阶段三：完成验收（执行中 → 已完成）；偏差超出允许范围必须给原因分类
function completeOrder(data, id, payload) {
  const order = findOrder(data, id);
  if (order.status !== '执行中') throw new AppError(409, 'ORDER_STAGE_INVALID', '只有「执行中」的指令才能完成验收，当前状态：' + order.status);
  const p = payload || {};
  const completedAt = String(p.completedAt || '').trim() || store.todayIso();
  const acceptor = String(p.acceptor || '').trim();
  const errors = {};
  if (!validDate(completedAt)) errors.completedAt = '完成日期格式不对';
  if (validDate(completedAt) && order.startedAt && completedAt < order.startedAt) errors.completedAt = '完成日期不能早于开始执行日期';
  if (!acceptor) errors.acceptor = '验收人要填';

  const reasons = p.deviationReasons !== undefined ? normalizeReasons(p.deviationReasons) : (order.deviationReasons || []);
  const decorated = decorateOrder(data, order);
  if (decorated.releaseCount === 0) {
    errors.releaseCount = '时段 ' + order.windowStart + ' 至 ' + order.windowEnd + ' 内还没有出库流量记录，没法与出库记录对账，先到「水位与流量」登记出库流量';
  }
  if (decorated.deviationExceeded && !reasons.length) {
    errors.deviationReasons = '偏差超出允许范围（' + decorated.toleranceText + '），完成验收前必须选原因分类';
  }
  for (const item of Array.isArray(p.deviationReasons) ? p.deviationReasons : []) {
    if (item && !DEVIATION_REASONS.includes(String(item))) errors.deviationReasons = '原因分类只能选：' + DEVIATION_REASONS.join('、');
  }
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '完成验收没通过校验', errors);

  order.completedAt = completedAt;
  order.acceptor = acceptor;
  order.completeRemark = String(p.completeRemark || '').trim();
  order.deviationReasons = reasons;
  order.deviationNote = p.deviationNote !== undefined ? String(p.deviationNote || '') : order.deviationNote;
  order.status = '已完成';
  return decorateOrder(data, order);
}

// 撤销：已下达或执行中可撤销，留撤销时刻、撤销人、原因
function cancelOrder(data, id, payload) {
  const order = findOrder(data, id);
  if (order.status === '已完成') throw new AppError(409, 'ORDER_STAGE_INVALID', '已完成验收的指令不能撤销');
  if (order.status === '已撤销') throw new AppError(409, 'ORDER_STAGE_INVALID', '这条指令已经撤销过了');
  const p = payload || {};
  const canceledAt = String(p.canceledAt || '').trim() || store.todayIso();
  const canceler = String(p.canceler || '').trim();
  const cancelReason = String(p.cancelReason || '').trim();
  const errors = {};
  if (!validDate(canceledAt)) errors.canceledAt = '撤销日期格式不对';
  if (!canceler) errors.canceler = '撤销人要填';
  if (!cancelReason) errors.cancelReason = '撤销原因要填';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '撤销登记没通过校验', errors);
  order.canceledAt = canceledAt;
  order.canceler = canceler;
  order.cancelReason = cancelReason;
  order.status = '已撤销';
  return decorateOrder(data, order);
}

// 复制一条指令（附件与说明是各自的副本，全过程不复制，新指令从「已下达」开始）
function copyOrder(data, id, payload) {
  const source = findOrder(data, id);
  const order = {
    id: store.nextId('ord', data.orders),
    code: nextOrderCode(data.orders),
    reservoirId: source.reservoirId,
    issuedAt: validDate((payload || {}).issuedAt) ? String(payload.issuedAt) : store.todayIso(),
    targetFlow: Number(source.targetFlow),
    windowStart: validDate((payload || {}).windowStart) ? String(payload.windowStart) : String(source.windowStart),
    windowEnd: validDate((payload || {}).windowEnd) ? String(payload.windowEnd) : String(source.windowEnd),
    status: '已下达',
    reason: String((payload && payload.reason) || source.reason),
    issuer: String((payload && payload.issuer) || source.issuer),
    remark: String((payload && payload.remark) || source.remark),
    attachments: (source.attachments || []).map((a) => Object.assign({}, a)),
    startedAt: '',
    starter: '',
    completedAt: '',
    acceptor: '',
    completeRemark: '',
    canceledAt: '',
    canceler: '',
    cancelReason: '',
    executionFlows: [],
    deviationReasons: [],
    deviationNote: '',
  };
  data.orders.push(order);
  return decorateOrder(data, order);
}

function removeOrder(data, id) {
  const order = findOrder(data, id);
  if (order.status === '执行中') throw new AppError(409, 'ORDER_RUNNING', '执行中的指令不能删除，请先完成验收或撤销');
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
  copyOrder,
  removeOrder,
  addAttachment,
  startOrder,
  addExecutionFlow,
  removeExecutionFlow,
  completeOrder,
  cancelOrder,
  decorateOrder,
  ORDER_STATUS,
  DEVIATION_REASONS,
};
