#!/usr/bin/env node

// A deterministic Codex app-server fixture for the cross-repository CATL demo.
// It intentionally reads the real claw-quant-data Research Pack while replacing
// the non-deterministic model, so the test validates orchestration and evidence
// flow without depending on model availability or consuming model quota.

import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-cli 0.145.0\n");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  process.stdout.write("Logged in using ChatGPT\n");
  process.exit(0);
}
if (args[0] !== "app-server") process.exit(2);

const sessionId = "55555555-5555-4555-8555-555555555555";
let developerInstructions = "";
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const number = (value) => Number(value ?? 0);
const percent = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
const billions = (value) => `${(number(value) / 1e8).toFixed(2)} 亿元`;

function sorted(rows) {
  return [...(rows ?? [])].sort((left, right) =>
    String(left.trade_date ?? left.end_date).localeCompare(String(right.trade_date ?? right.end_date)),
  );
}

function returnFor(rows, periods, value = (row) => number(row.close)) {
  const values = sorted(rows);
  if (values.length <= periods) return 0;
  const start = value(values.at(-(periods + 1)));
  const end = value(values.at(-1));
  return start ? ((end / start) - 1) * 100 : 0;
}

function rsi14(rows) {
  const values = sorted(rows).map((row) => number(row.close)).slice(-15);
  if (values.length < 15) return 0;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  if (!losses) return 100;
  return 100 - (100 / (1 + gains / losses));
}

function metrics(pack) {
  const data = pack.data;
  const daily = sorted(data.market.daily);
  const adjustmentFactors = new Map((data.market.adjustment_factors ?? []).map((row) => [row.trade_date, number(row.adj_factor)]));
  const adjustedDaily = daily.filter((row) => adjustmentFactors.has(row.trade_date));
  const adjustedClose = (row) => number(row.close) * number(adjustmentFactors.get(row.trade_date));
  const basic = sorted(data.market.daily_basic);
  const benchmark = sorted(data.market.benchmark_daily);
  const margin = sorted(data.market.margin);
  const indicators = data.fundamentals.indicators ?? [];
  const income = data.fundamentals.income ?? [];
  const cashFlow = data.fundamentals.cash_flow ?? [];
  const pledge = data.ownership_and_events.pledge ?? [];
  const latest = daily.at(-1);
  const latestBasic = basic.at(-1);
  const latestIndicator = indicators[0] ?? {};
  const latestIncome = income[0] ?? {};
  const priorIncome = income.find((row) => row.end_date === "2025-06-30") ?? {};
  const latestCashFlow = cashFlow[0] ?? {};
  const marginNow = number(margin.at(-1)?.rzye);
  const marginBefore = number(margin.at(-21)?.rzye || margin.at(0)?.rzye);
  return {
    date: latest.trade_date,
    close: number(latest.close),
    daily,
    return5: returnFor(adjustedDaily, 5, adjustedClose),
    return20: returnFor(adjustedDaily, 20, adjustedClose),
    return60: returnFor(adjustedDaily, 60, adjustedClose),
    benchmark20: returnFor(benchmark, 20),
    benchmark60: returnFor(benchmark, 60),
    ma20: daily.slice(-20).reduce((sum, row) => sum + number(row.close), 0) / Math.min(20, daily.length),
    ma60: daily.slice(-60).reduce((sum, row) => sum + number(row.close), 0) / Math.min(60, daily.length),
    low60: Math.min(...daily.slice(-60).map((row) => number(row.low))),
    high60: Math.max(...daily.slice(-60).map((row) => number(row.high))),
    rsi: rsi14(daily),
    peTtm: number(latestBasic.pe_ttm),
    pb: number(latestBasic.pb),
    dividendYield: number(latestBasic.dv_ttm),
    marketCapTrillion: number(latestBasic.total_mv) / 1e8,
    revenue: number(latestIncome.revenue),
    revenueGrowth: number(priorIncome.revenue) ? (number(latestIncome.revenue) / number(priorIncome.revenue) - 1) * 100 : 0,
    profit: number(latestIncome.n_income_attr_p),
    profitGrowth: number(priorIncome.n_income_attr_p) ? (number(latestIncome.n_income_attr_p) / number(priorIncome.n_income_attr_p) - 1) * 100 : 0,
    roe: number(latestIndicator.roe),
    grossMargin: number(latestIndicator.grossprofit_margin),
    netMargin: number(latestIndicator.netprofit_margin),
    debtToAssets: number(latestIndicator.debt_to_assets),
    operatingCashFlow: number(latestCashFlow.n_cashflow_act),
    freeCashFlow: number(latestCashFlow.free_cashflow ?? latestIndicator.fcff),
    marginChange: marginBefore ? (marginNow / marginBefore - 1) * 100 : 0,
    pledgeRatio: number(pledge[0]?.pledge_ratio),
    gaps: (pack.meta.gaps ?? []).map((item) => item.dataset),
  };
}

function reportFor(prompt, pack) {
  const m = metrics(pack);
  const isPlanning = prompt.includes("制定清晰、可执行的协作计划");
  const isReview = prompt.includes("给出可直接交付的最终结论");
  if (isPlanning) {
    return {
      file: "01-research-plan.md",
      text: `# 宁德时代研究计划\n\n数据截至 ${m.date}。并行拆分为市场与估值、基本面、风险与事件三个工作流；所有数值以 claw-quant-data Research Pack 为第一数据源，公告和新闻缺口必须使用官方来源补充并声明。`,
    };
  }
  // Review prompts contain every contributor role in their context, so the
  // step-kind check must win over role-name checks.
  if (isReview) {
    return {
      file: "05-catl-research-report.md",
      text: `# 宁德时代（300750.SZ）近期研究报告\n\n> 数据截至 ${m.date}。本报告用于 Hibro 研究流程演示，不构成个性化投资建议。\n\n## 核心判断\n\n宁德时代的中期基本面保持强劲，但短期价格趋势仍弱。2026 年上半年营收和归母净利润同比增长 ${m.revenueGrowth.toFixed(2)}%/${m.profitGrowth.toFixed(2)}%，经营现金流和自由现金流分别为 ${billions(m.operatingCashFlow)}/${billions(m.freeCashFlow)}；与此同时，股价近 20 日下跌 ${Math.abs(m.return20).toFixed(2)}%，位于 MA20 ${m.ma20.toFixed(2)} 元和 MA60 ${m.ma60.toFixed(2)} 元下方。\n\n## 可执行观察框架\n\n1. 未持仓：不因 RSI14=${m.rsi.toFixed(2)} 单独抄底；等待重新站上 MA20 且相对创业板指止跌，或出现基本面上修后再分批评估。\n2. 已持仓：按个人风险预算管理仓位，重点观察 ${m.low60.toFixed(2)} 元附近的 60 日低点；跌破后若不能快速收回，应重新评估而不是机械补仓。\n3. 继续跟踪：季度收入/利润增速、自由现金流、储能份额、融资余额与官方公告。\n\n## 数据边界\n\n行情、估值、资金、融资、财务、质押和关键词新闻来自 claw-quant-data；交易所/公司公告正文仍需外部官方渠道补齐。`,
    };
  }
  if (prompt.includes("市场与技术分析师")) {
    return {
      file: "02-market-and-valuation.md",
      text: `# 市场、技术与估值\n\n- ${m.date} 收盘 ${m.close.toFixed(2)} 元，前复权 5/20/60 个交易日收益分别为 ${percent(m.return5)}、${percent(m.return20)}、${percent(m.return60)}。\n- 创业板指同期 20/60 日为 ${percent(m.benchmark20)}、${percent(m.benchmark60)}。\n- MA20/MA60（原始收盘价）为 ${m.ma20.toFixed(2)}/${m.ma60.toFixed(2)} 元，RSI14 为 ${m.rsi.toFixed(2)}，60 日区间 ${m.low60.toFixed(2)}—${m.high60.toFixed(2)} 元。\n- PE(TTM) ${m.peTtm.toFixed(2)} 倍、PB ${m.pb.toFixed(2)} 倍、股息率 ${m.dividendYield.toFixed(2)}%、总市值约 ${m.marketCapTrillion.toFixed(2)} 万亿元。\n\n结论：短线趋势偏弱且已超卖，不能仅凭 RSI 抄底；估值与基本面需要结合确认信号。`,
    };
  }
  if (prompt.includes("基本面分析师")) {
    return {
      file: "03-fundamentals.md",
      text: `# 基本面与现金流\n\n- 2026 年上半年营收 ${billions(m.revenue)}，同比 ${percent(m.revenueGrowth)}；归母净利润 ${billions(m.profit)}，同比 ${percent(m.profitGrowth)}。\n- ROE ${m.roe.toFixed(2)}%，毛利率 ${m.grossMargin.toFixed(2)}%，净利率 ${m.netMargin.toFixed(2)}%。\n- 经营现金流 ${billions(m.operatingCashFlow)}，自由现金流 ${billions(m.freeCashFlow)}，资产负债率 ${m.debtToAssets.toFixed(2)}%。\n\n结论：增长与现金流仍强，是中期逻辑的主要支撑；高资产负债率需要结合产业链资本开支持续跟踪。`,
    };
  }
  if (prompt.includes("风险与事件分析师")) {
    return {
      file: "04-risks-and-events.md",
      text: `# 风险与事件\n\n- 近 20 个交易日股价 ${percent(m.return20)}，融资余额同期约 ${percent(m.marginChange)}，杠杆资金逆势增加。\n- 最新股权质押比例 ${m.pledgeRatio.toFixed(2)}%，目前不构成主要压力。\n- Research Pack 本次无数据的数据集：${m.gaps.join("、") || "无"}。\n- claw-quant-data 可按公司名称/代码检索媒体新闻，但没有交易所/公司公告正文接口；重大合同和监管披露必须用公司官网、深交所或巨潮资讯补齐。\n\n结论：最大矛盾是强基本面与弱价格趋势并存，风险控制应优先于方向判断。`,
    };
  }
  return { file: "team-note.md", text: "# 研究记录\n\n已读取 claw-quant-data Research Pack。" };
}

async function finishTurn(prompt) {
  try {
    const endpoint = prompt.match(/https?:\/\/[^\s]+\/research-pack\?[^\s]+/)?.[0];
    if (!endpoint) throw new Error("Research Pack endpoint missing from Project data sources");
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Research Pack HTTP ${response.status}`);
    const pack = await response.json();
    const report = reportFor(prompt, pack);
    const artifactDirectory = developerInstructions.match(/Hibro 产物目录：([^\n]+)/)?.[1]?.trim();
    if (!artifactDirectory) throw new Error("Hibro artifact directory missing");
    mkdirSync(artifactDirectory, { recursive: true });
    writeFileSync(`${artifactDirectory}/${report.file}`, `${report.text}\n`);
    write({ method: "item/completed", params: { item: { id: "item-catl", type: "agentMessage", text: report.text } } });
    write({ method: "turn/completed", params: { turn: { id: "turn-catl", status: "completed" } } });
  } catch (error) {
    write({ method: "turn/completed", params: { turn: { id: "turn-catl", status: "failed", error: { message: error instanceof Error ? error.message : String(error) } } } });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    write({ id: message.id, result: { userAgent: "fake-stock-research-codex" } });
  } else if (message.method === "thread/start") {
    developerInstructions = message.params.developerInstructions ?? "";
    write({ id: message.id, result: { thread: { id: sessionId } } });
  } else if (message.method === "thread/resume") {
    write({ id: message.id, result: { thread: { id: message.params.threadId } } });
  } else if (message.method === "turn/start") {
    const prompt = message.params.input?.[0]?.text ?? "";
    write({ id: message.id, result: { turn: { id: "turn-catl" } } });
    void finishTurn(prompt);
  }
});
