/**
 * CodeConClave — Production Intelligence (V4D).
 * Barrel exports for all production intelligence modules.
 */
export { analyzeLogs } from './logAnalysis.js';
export type {
  LogAnalysisResult,
  RepeatedError,
  Anomaly as LogAnomaly,
  RelatedFailure,
  SlowQuery as LogSlowQuery,
  SecuritySignal,
  UserImpactPattern,
} from './logAnalysis.js';

export { traceCorrelation } from './errorCorrelation.js';
export type {
  CorrelationChain,
  CorrelationLink,
  UserImpactAssessment,
  TimelineEvent,
  CorrelationSearchOptions,
  CorrelationSearchResult,
} from './errorCorrelation.js';

export { traceRequest, getRequestTrace, getRequestTraceStats } from './requestTracing.js';
export type {
  RequestTrace,
  ServiceHop,
  TaskRelationship,
  TraceError,
  RequestTraceSearchOptions,
  RequestTraceSearchResult,
  RequestTraceStats,
} from './requestTracing.js';

export { generateDbPerformanceReport, getDbPerformanceReport } from './dbPerformance.js';
export type {
  DbPerformanceReport,
  SlowQuery,
  MissingIndex,
  LongTransaction,
  ConnectionPressure,
  LockPattern,
  TableStat,
  Recommendation,
} from './dbPerformance.js';

export {
  runMonitoringAutopilot,
  getMonitoringConfig,
  updateMonitoringConfig,
  getAlertHistory,
  addSuppressionRule,
  getSuppressionRules,
} from './monitoringAutopilot.js';
export type {
  MonitoringAutopilotResult,
  Anomaly,
  AlertCorrelation,
  SuppressedAlert,
  CriticalPathStatus,
  ServiceStatus,
  MonitoringAutopilotConfig,
  CriticalPathConfig,
} from './monitoringAutopilot.js';

export {
  createRunbook,
  createRunbookFromTemplate,
  getRunbook,
  listRunbooks,
  executeRunbook,
  getRunbookExecution,
  listRunbookExecutions,
  createRunbookTemplate,
  getRunbookTemplates,
  getSystemRunbookTemplates,
} from './runbookAutomation.js';
export type {
  Runbook,
  RunbookStep,
  RollbackPlan,
  RollbackStep,
  RunbookExecution,
  RunbookStepResult,
  RunbookTemplate,
  RunbookTrigger,
  RunbookStatus,
  RunbookStepType,
} from './runbookAutomation.js';

export {
  recordCost,
  recordAICost,
  recordTaskCost,
  getCostBreakdown,
  getProviderCosts,
  getCostTrends,
  getTopCostDrivers,
  createBudget,
  getBudgets,
  updateBudget,
  checkBudgetAlerts,
  acknowledgeBudgetAlert,
  getCostAlerts,
} from './costAnalysis.js';
export type {
  CostCategory,
  CostSource,
  CostEntry,
  CostBreakdown,
  CostTrend,
  CostDriver,
  ProviderCost,
  CostAlert,
  Budget,
} from './costAnalysis.js';

export { productionIntelligenceRoutes } from './routes.js';
