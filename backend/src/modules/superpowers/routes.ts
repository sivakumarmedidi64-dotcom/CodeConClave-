/**
 * CodeConClave — Superpowers: HTTP routes (/api/v1/superpowers).
 *
 * Each sub-resource mirrors the service:
 *   /proof       Proof-of-Run + Proof Badge + Why-Button
 *   /echo        Echo Memory (lesson store)
 *   /warden      policy graph + change checking
 *   /specs       Spec Linter (continuous truth checks)
 *   /checkpoints Checkpoint Time Machine
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import {
  registerClaim,
  attachEvidence,
  listClaims,
  taskBadge,
  whyTrace,
} from './proof.js';
import { EvidenceKind, ClaimVerdict } from './proof.js';
import {
  recordEchoLesson,
  listEchoLessons,
  retrieveEchoLessons,
  markEchoLessonApplied,
} from './echo.js';
import { EchoSource } from './echo.js';
import {
  createWardenPolicy,
  listWardenPolicies,
  updateWardenPolicy,
  getWardenPolicy,
  deleteWardenPolicy,
  checkChangeAgainstPolicies,
} from './warden.js';
import {
  upsertSpecEntry,
  listSpecEntries,
  runSpecChecks,
} from './specs.js';
import { SpecKind } from './specs.js';
import {
  createCheckpoint,
  getCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
  forkCheckpoint,
} from './checkpoints.js';
import {
  appendAgentEvent,
  streamAgentEvents,
  commentOnDiff,
  AgentEventKind,
} from './live.js';
import {
  createFixTicket,
  listFixTickets,
  getFixTicket,
  startReproduction,
  proposeFix,
  resolveFix,
  supersedeFix,
  FixStatus,
  FixSource,
} from './fixes.js';
import {
  generateIntentDraft,
  getIntentDraft,
  listIntentDrafts,
  applyIntentDraft,
  dismissIntentDraft,
} from './intent.js';
import {
  runFreshEyesReview,
  getFreshEyesReview,
  listFreshEyesReviews,
  linkProofClaim,
  closeFreshEyesReview,
} from './freshEyes.js';
import {
  createReplaySession,
  listReplaySessions,
  getReplaySession,
  archiveReplaySession,
  forkReplaySession,
} from './replay.js';
import {
  upsertRiskScore,
  listRiskScores,
  getRiskScore,
  removeRiskScore,
} from './oracle.js';
import {
  runAnomalyScan,
  getAnomalyScan,
  listAnomalyScans,
  closeAnomalyScan,
} from './anomalyHunter.js';
import {
  generateStandup,
  getStandupReport,
  listStandupReports,
  publishStandupReport,
} from './standup.js';
import {
  computeHealthSignal,
  getHealthSignal,
} from './healthSignal.js';
import {
  listPerformanceFindings,
  recordPerformanceFinding,
  resolvePerformanceFinding,
} from './turbo.js';
import {
  getDecisionHistory,
  recordDecision,
  searchDecisions,
  findDecisionById,
} from './chronos.js';
import {
  reapDecisions,
  reviewUnlessSupplanted,
  suppressDecision,
} from './decisionReaper.js';
import {
  listPatterns,
  learnPattern,
  applyPattern,
  certifyPattern,
} from './patternProphet.js';
import {
  listWhyLinks,
  createWhyLink,
  detachWhyLink,
} from './whyWiki.js';
import {
  recordFlakeInvestigation,
  listFlakeInvestigations,
  resolveFlakeInvestigation,
  categorizeFlake,
} from './determinismHammer.js';
import {
  evaluatePackage,
  listPackages,
  getPackage,
} from './supplyChain.js';
import {
  recordPiiFinding,
  listPiiFindings,
  remediatePiiFinding,
  scanForPII,
} from './dataGuardian.js';
import {
  recordSecretIncident,
  buildExposureTimeline,
  listSecretIncidents,
  rotateSecret,
} from './secretAutopsy.js';
import {
  detectPromptInjection,
  listInjectionEvents,
  neutralizeInjection,
  scanForInjections,
} from './promptArmor.js';
import {
  archivePostmortem,
  listPostmortems,
  retrieveRelatedPostmortems,
} from './archivist.js';
import {
  registerTerm,
  listTerms,
  logTermScan,
  listViolations,
  resolveViolation,
  unifyTerm,
} from './ontology.js';
import {
  askCodebase,
  listAnswers,
} from './voiceOfCodebase.js';
import {
  recordOrigin,
  dig,
  reconstructByCommit,
  listDigs,
} from './archaeology.js';
import {
  recordSkillSignal,
  whoKnows,
  routeReview,
  listSkillSignals,
  developerTopSkills,
} from './taxonomy.js';
import { OntologySourceType } from './ontology.js';
import { SkillSource } from './taxonomy.js';
import {
  runRedCellScan,
  listFindings,
  confirmFinding,
  clearFinding,
  rankFindings,
} from './redCell.js';
import { RedCellCategory, RedCellSeverity, FindingStatus, RED_CELL_CATEGORIES, RED_CELL_SEVERITIES, FINDING_STATUSES } from './redCell.js';
import {
  runCoverageScan,
  listCoverageScans,
  getCoverageScan,
  analyzeTestQuality,
} from './coverageSentinel.js';
import {
  upsertDependency,
  runUpgrade,
  listDependencies,
  listUpgrades,
  dependencyHealth,
} from './diplomat.js';
import {
  publishContract,
  verifyImplementation,
  checkConsumer,
  listContracts,
  listChecks,
  findContractById,
} from './contractWarden.js';
import {
  assessDependency,
  getInsight,
  listInsights,
  dependencySociety,
  RISK_LEVELS,
} from './cartographer.js';
import {
  runAdversarialReview,
  getAdversarialRun,
  listAdversarialRuns,
  generateEdgeAttackPlan,
  AdversarialVerdict,
} from './adversarial.js';
import {
  runMutationSweep,
  getMutationSweep,
  listMutationSweeps,
  mutateSnippet,
  mutationReport,
  MutationOutcome,
} from './mutationGrade.js';
import {
  runShadowComparison,
  getShadowRun,
  listShadowRuns,
  compareResponses,
  normalizeBody,
  ShadowProbe,
  ShadowVerdict,
} from './shadow.js';
import {
  auditPermissions,
  getPrivilegeFlag,
  shrinkPrivilege,
  listPrivilegeFlags,
  privilegeReport,
  GrantInput,
  PrivilegeScope,
  PrivilegeSeverity,
  PrivilegeStatus,
} from './shrinker.js';
import {
  registerSandboxPolicy,
  enforceSandbox,
  listSandboxPolicies,
  listSandboxActions,
  sandboxReport,
  SandboxActionKind,
  SandboxDecision,
} from './sandboxIsolation.js';
import {
  scanBusFactor,
  getBusFactorAlarm,
  clearBusFactorAlarm,
  listBusFactorAlarms,
  busFactorReport,
  BusFactorSeverity,
  BusFactorStatus,
} from './busFactor.js';
import {
  routeCodeReview,
  getReviewAssignment,
  listReviewAssignments,
  reviewRouteReport,
} from './reviewRouter.js';
import {
  schedulePairing,
  getPairingSchedule,
  acceptPairing,
  completePairing,
  listPairingSchedules,
  pairingReport,
  TaskComplexity,
  PairingStatus,
} from './pairingScheduler.js';
import {
  generateOnboardingRoadmap,
  getOnboardingRoadmap,
  listOnboardingRoadmaps,
  onboardingRoadmapReport,
  OnboardingSeniority,
} from './onboardingRoadmap.js';
import {
  proposeDecision,
  getAsyncDecision,
  castDecisionVote,
  resolveDecision,
  closeDecision,
  listAsyncDecisions,
  asyncDecisionReport,
  DecisionStatus,
} from './asyncDecision.js';
import {
  exportKnowledge,
  getKnowledgeExport,
  listKnowledgeExports,
  knowledgeExportReport,
  KnowledgeScope,
} from './knowledgeHandoff.js';
import {
  balanceReviews,
  getReviewLoadPlan,
  listReviewLoadPlans,
  reviewLoadReport,
} from './reviewLoad.js';
import {
  generatePerformanceDigest,
  getPerformanceDigest,
  listPerformanceDigests,
  performanceDigestReport,
} from './performanceData.js';
import {
  attributeCosts,
  getCostAttribution,
  listCostAttributions,
  costReport,
} from './budgetTransparency.js';
import {
  computeEquity,
  getEquityScore,
  listEquityScores,
  equityReport,
} from './equityMetrics.js';
import {
  executeAutopilot,
  getAutopilotRun,
  listAutopilotRuns,
  autopilotReport,
} from './autopilotPrime.js';
import {
  startPhoenixCycle,
  applyPhoenixFix,
  confirmPhoenixSuite,
  openPhoenixPr,
  getPhoenixCycle,
  listPhoenixCycles,
  phoenixReport,
} from './phoenixProtocol.js';
import {
  scanCiForHealing,
  getCiHealScan,
  listCiHealScans,
  cishealReport,
} from './selfHealingCi.js';
import {
  planLaunchRelease,
  deployLaunchRelease,
  flagMetricsTank,
  getLaunchRelease,
  listLaunchReleases,
  launchReport,
} from './launchCaptain.js';
import {
  runAutopsy,
  resolveAutopsy,
  getAutopsyIncident,
  listAutopsyIncidents,
  autopsyReport,
} from './autopsy.js';
import { launchSwarm, getSwarmBatch, listSwarmBatches } from './swarm.js';
import { runTriaging, getZeroInboxDigest, listZeroInboxDigests, inboxReport } from './zeroInbox.js';
import { runNightShift, getNightShiftRun, listNightShiftRuns, nightShiftReport } from './nightShift.js';
import { planRelease, freezeFeatures, cherryPickCommit, laneHotfix, approveHotfixLane, drillRollback, getReleaseRun, listReleaseRuns, releaseReport } from './releaseCommander.js';
import { planDrill, runDrill, getDrillRun, listDrillRuns, drillReport } from './firewallDrill.js';
import { recordManualAction, acceptSuggestion, dismissSuggestion, listSuggestions, listManualActions, getDivergenceSession, learnedPatterns, divergenceReport } from './autoDivergence.js';
import { runWhatIf, getMirrorRun, listMirrorRuns, mirrorWorldReport } from './mirrorWorld.js';
import { conveneTribunal, getHearing, listHearings, listLessons as listTribunalLessons, tribunalReport } from './tribunal.js';
import { analyzeSymptom, resolveTrace, getCausalChain, listCausalChains, rootCauseReport } from './rootCauseOracle.js';
import { writeGhost, benchmarkGhost, shipGhost, getGhostWrite, listGhostWrites, ghostWriterReport } from './ghostWriter.js';
import { reconstructHistory, getSnapshot, listSnapshots, timeTravelReport } from './timeTraveler.js';
import { holdCourt, getCourtCase, listCourtCases, codeCourtReport } from './codeCourt.js';
import { diagnoseStall, resolveStall, getStallBreakout, listStallBreakouts, silenceBreakerReport } from './silenceBreaker.js';
import { exportBrain, packageExport, getInstitutionalExport, listInstitutionalExports, institutionalReport } from './institutionalTransfer.js';
import { compressContext, getCompression, listCompressions, contextCompressorReport } from './contextCompressor.js';
import { runConceptScan, unifyConcept, resolveConceptGap, getConceptScan, listConceptScans, conceptGapReport } from './conceptGapDetector.js';
import { draftNegotiation, resolveNegotiation, getNegotiationDraft, listNegotiationDrafts, negotiatorReport } from './negotiator.js';
import { exportMemoryGraph, queryExport, getMemoryExport, listMemoryExports, memoryPortabilityReport } from './memoryPortability.js';
import { openTimeline, addRegression, getRegressionTimeline, listRegressionTimelines, regressionReport } from './regressionTimeline.js';
import { seedLesson, diffuseLesson, retrieveLesson, getLesson, listLessons, knowledgeReport } from './knowledgeDiffusion.js';
import { recordFusionSample, getFusionSample, listFusionSamples, fusionReport, fusionTrend } from './fusionScoring.js';
import { startDuckSession, foundIt, getDuckSession, listDuckSessions, duckReport } from './rubberDuck.js';
import { translateCode, getCodeTranslation, listCodeTranslations, codeTranslatorReport } from './codeTranslator.js';
import { forgeFocusSession, silenceFocus, breachFocus, digestFocus, getFocusSession, listFocusSessions, focusReport } from './focusForge.js';
import { registerFragment, proposeAbstraction, getCloneFragment, listCloneFragments, cloneKillerReport } from './cloneKiller.js';
import { translateErrorText, getErrorTranslation, listErrorTranslations, errorTranslatorReport } from './errorTranslator.js';
import { mirrorHint, acknowledgeHint, getPairHint, listPairHints, pairMirrorReport } from './pairMirror.js';
import { extractMeeting, getMeetingExtraction, listMeetingExtractions, meetingToCodeReport } from './meetingToCode.js';
import { guardDeepWork, holdQuestion, surfaceGuard, getFocusGuard, listFocusGuards, focusGuardReport } from './focusGuard.js';
import { dictateTask, startVoiceTask, getVoiceTask, listVoiceTasks, voiceTaskReport } from './voiceToTask.js';
import { xrayRequirement, getXray, listXrays, requirementXrayReport } from './requirementXray.js';
import { openPrScope, checkScope, settleScope, getScopeSession, listScopeSessions, scopeBouncerReport } from './scopeBouncer.js';
import { forgeStoryRun, getStory, listStories, userStoryForgeReport } from './userStoryForge.js';
import { reportImpact, getImpactReading, listImpactReadings, radarReport } from './impactRadar.js';
import { reportChurnEvent, draftChurnFix, getChurnEvent, listChurnEvents, churnReport } from './churnDetective.js';
import { startOnboardingSim, completeSim, getOnboardingSim, listOnboardingSims, onboardingSimReport } from './onboardingSimulator.js';
import { startProdRun, advanceProdStage, getProdRun, listProdRuns, prodRunReport } from './zeroToProd.js';
import { writePolicy, activatePolicy, suspendPolicy, getPolicy, listPolicies, policyCopilotReport } from './policyCopilot.js';
import { startChallenge, buildChallengeTrack, defendDecisions, getChallenge, listChallenges, challengeReport } from './challengeMode.js';
import { createCodebaseLink, answerPublicQuestion, expireShare, getShare, listShares, codebaseShareReport } from './askCodebaseLive.js';
import { estimateCost, getCostEstimate, listCostEstimates, costBadgeReport } from './costBadge.js';
import { takeThermometerReading, getThermometerReading, listReadings, thermometerReport } from './costThermometer.js';
import { diffState, reconcileDrift, fileDriftFix, getDriftReport, listDriftReports, driftReportSummary } from './driftPolice.js';
import { forecastExhaustion, getCapacityForecast, listCapacityForecasts, capacityReport } from './capacityOracle.js';
import { cloneEnvironment, getEnvironmentClone, listEnvironmentClones, environmentCloneReport } from './environmentCloner.js';
import { startRunbook, executeStep, resolveRunbook, getRunbook, listRunbooks, runbookReport } from './runbookRunner.js';
import { scheduleRestoreCheck, verifyRestore, getBackupCheck, listBackupChecks, backupRealityReport } from './backupRealityCheck.js';
import { recordServiceCall, getNetworkMap, blastRadius, listNetworkEdges, getNetworkEdge, networkXrayReport } from './networkXRay.js';
import { createInfraPlan, validatePlan, applyPlan, getInfraPlan, listInfraPlans, infraArchitectReport } from './infraArchitect.js';
import { logRegression, markFixWorked, getRegressionEntry, getRegressionsForModule, listRegressionEntries, regressionRadarReport } from './regressionRadar.js';
import { triggerIncident, draftPostmortem, proposeFix as proposeIncidentFix, getIncidentOrchRun, listIncidentOrchRuns, incidentOrchReport } from './incidentOrchestrator.js';
import { createNetworkPolicy, auditNetworkCall, getNetworkPolicy, listNetworkPolicies, networkPolicyReport } from './networkPolicyEnforcer.js';
import { planBridge as planFrameworkBridge, applyStep as applyFrameworkStep, verifyBridge as verifyFrameworkBridge, getFrameworkBridge, listFrameworkBridges, frameworkBridgeReport } from './frameworkBridge.js';
import { planFerry, verifyFerryRun, getLanguageFerry, listLanguageFerries, languageFerryReport } from './languageFerry.js';
import { planCut, extractService, getMonolithSurgeon, listMonolithSurgeries, monolithSurgeonReport } from './monolithSurgeon.js';
import { planCycle, startDualWrite, verifyBackfill, contract as contractDbCycle, getDbBrainSurgery, listDbBrainSurgeries, dbBrainSurgeonReport } from './dbBrainSurgeon.js';
import { planConversion, verifyConversion, getTestConversion, listTestConversions, testConverterReport } from './testConverter.js';
import { createLegacyWrapper, getLegacyWrapper, listLegacyWrappers, legacyWrapperReport } from './legacyWrapper.js';
import { planBridge as planDependencyBridge, verifyBridge as verifyDependencyBridge, getDependencyBridge, listDependencyBridges, dependencyBridgeReport } from './dependencyBridge.js';
import { planMigration, reportMigration, getPerformanceMigration, listPerformanceMigrations, performanceMigrationReport } from './performanceMigration.js';
import { createSchemaMigration, startExpansion, completeStep, rollbackMigration, getSchemaMigration, listSchemaMigrations, schemaMigrationReport } from './schemaMigrationWizard.js';
import { createApiBridge, deprecateVersion, getApiBridge, listApiBridges, apiBridgeReport } from './apiVersionBridge.js';
import { scheduleDataMigration, sampleMigration, runMigration, verifyMigration, getDataMigration, listDataMigrations, dataMigrationReport } from './dataMigrationOrchestrator.js';
import { startConfigMigration, advanceTrafficSplit, completeConfigMigration, getConfigMigration, listConfigMigrations, configMigrationReport } from './configurationMigration.js';
import { flagDesignViolation, fixViolation, ignoreViolation, getDesignReport, listDesignReports, designPoliceReport } from './designPolice.js';
import { startStateMatrixRun, completeStateMatrixRun, getStateMatrixRun, listStateMatrixRuns, stateMatrixReport } from './respawnStateMatrix.js';
import { submitPixelDiff, getPixelDiff, listPixelDiffs, pixelDiffReport } from './pixelDiffJudge.js';
import { auditMotion, getMotionAudit, listMotionAudits, motionDoctorReport } from './motionDoctor.js';
import { startA11yRun, fileA11yIssue, getA11yRun, listA11yRuns, a11yReport } from './a11yAutopilot.js';
import { startLocalizationScan, getLocalizationScan, listLocalizationScans, localizationForgeReport } from './localizationForge.js';
import { createGraveyardEntry, removeComponent, getGraveyardEntry, listGraveyardEntries, componentGraveyardReport } from './componentGraveyard.js';
import { generateResponsive, getResponsiveGeneration, listResponsiveGenerations, responsiveForgeReport } from './responsiveForge.js';
import { defineInteraction, getInteractionSpec, listInteractionSpecs, interactionDefinerReport } from './interactionDefiner.js';
import { generateForm, getFormBuild, listFormBuilds, formBuilderReport } from './formBuilder.js';
import { flagViolation as flagThemeViolation, fixViolation as fixThemeViolation, getThemeViolation, listThemeViolations, themeEnforcerReport } from './themeEnforcer.js';
import { createCatalogueEntry, parseCatalogueEntry, publishCatalogueEntry, getCatalogueEntry, listCatalogueEntries, componentCatalogueReport } from './componentCatalogue.js';
import { createQueryPlan as createWhispererPlan, explainQuery, rewriteQuery, getQueryWhisperer, listQueryWhisperers, queryWhispererReport } from './queryWhisperer.js';
import { createDataDoctorScan, runDataDoctorScan, flagDataIssue, getDataDoctorScan, listDataDoctorScans, dataDoctorReport } from './dataDoctor.js';
import { createSchemaSnapshot, captureSchemaSnapshot, restoreSchemaPoint, getSchemaTimeMachine, listSchemaTimeMachineSnapshots, schemaTimeMachineReport } from './schemaTimeMachine.js';
import { createPipelineWatcherRun, detectPipelineAnomaly, flagSlaViolation, getPipelineWatcherRun, listPipelineWatcherRuns, pipelineWatcherReport } from './pipelineWatcher.js';
import { createFeatureStore, draftRetrain, getFeatureStore, listFeatureStores, featureStoreReport } from './featureStoreAutopilot.js';
import { createDenormSuggestion, applyDenormSuggestion, getDenormSuggestion, listDenormSuggestions, denormSuggestionReport } from './denormalizationSuggester.js';
import { createRelationshipMap, verifyRelationshipMap, getRelationshipMap, listRelationshipMaps, relationshipMapReport } from './relationshipMapper.js';
import { createAnomalyScan, alertAnomaly, getAnomalyScan as getDetectorScan, listAnomalyScans as listDetectorScans, anomalyScanReport } from './anomalyDetector.js';
import { createComplianceReport, resolveComplianceReport, getComplianceReport, listComplianceReports, complianceReport } from './complianceChecker.js';
import { createQueryPlan as createOptimizerPlan, optimizeQuery, proveEquivalence, getQueryPlan, listQueryPlans, queryOptimizerReport } from './queryOptimizer.js';
import { createContract as createCTCContract, flagBreach, getContract, listContracts as listCrossTeamContracts, crossTeamContractReport } from './crossTeamContract.js';
import { createOrgHealthReport, computeOrgHealth, getOrgHealthReport, listOrgHealthReports, orgHealthReport } from './orgHealth.js';
import { createRetentionSignal, flagRetentionSignal, getRetentionSignal, listRetentionSignals, retentionPredictorReport } from './retentionPredictor.js';
import { createHiringEvaluation, scoreHiringEvaluation, getHiringEvaluation, listHiringEvaluations, hiringAssistantReport } from './hiringAssistant.js';
import { openLane, measureLane, getLane, listLanes, speculativeEngineeringReport } from './speculativeEngineering.js';
import { recordLesson as recordToolchainLesson, adoptLesson, getLesson as getToolchainLesson, listLessons as listToolchainLessons, selfEvolvingReport } from './selfEvolvingToolchain.js';
import { createSimulation, runSimulation, getRun as getSimRun, listRuns as listSimRuns, orgSimulatorReport } from './orgSimulator.js';
import { createPhysicsRun, simulatePhysics, getRun as getPhysicsRun, listRuns as listPhysicsRuns, codebasePhysicsReport } from './codebasePhysics.js';
import { createDebtItem, scheduleFix, getItem, listItems, techDebtPricingReport } from './techDebtPricing.js';
import { createAmbientSession, answerAmbient, getAmbientSession, listAmbientSessions, ambientSessionReport } from './ambientCoding.js';
import { createIntentBid, selectBid, getIntentBid, listIntentBids, intentMarketplaceReport } from './intentMarketplace.js';
import { createPostHumanHandoff, continueHandoff, getPostHumanHandoff, listPostHumanHandoffs, postHumanHandoffReport } from './postHumanHandoff.js';
import { createSelfPlayRun, reportIssue as reportSelfPlayIssue, getSelfPlayRun, listSelfPlayRuns, selfPlayReport } from './selfPlayAdversarial.js';
import { generateNutritionLabel, getNutritionLabel, listNutritionLabels, nutritionLabelReport } from './nutritionLabel.js';
import { createReproRun, confirmReproduction, getReproRun, listReproRuns, universalReproReport } from './universalReproduction.js';
import { proposeRefactor, queueRefactor, getRefactorProposal, listRefactorProposals, refactorMarketReport } from './refactorMarket.js';
import { fileDogfoodTask, getDogfoodTask, listDogfoodTasks, dogfoodModeReport } from './dogfoodMode.js';
import { createDemoLink, expireDemoLink, getDemoLink, listDemoLinks, demoLinkReport } from './demoLink.js';

const str = (v: unknown): string | undefined => (v === undefined ? undefined : String(v));
const num = (v: unknown): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const kindOf = <T extends readonly string[]>(arr: T, v: string | undefined): T[number] | undefined => {
  if (v && (arr as readonly string[]).includes(v)) return v as T[number];
  return undefined;
};

export const superpowerRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  // ------------------------------------------------------------- PROOF-OF-RUN
  router.get(
    '/proof',
    asyncRoute(async (req, res) => {
      const opts = {
        projectId: str(req.query.projectId) || undefined,
        taskId: str(req.query.taskId) || undefined,
        verdict: kindOf(ClaimVerdict, str(req.query.verdict) ?? undefined),
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      };
      res.json(jsonResult({ claims: await listClaims(req.ctx.user!.id, opts) }));
    }),
  );

  // PROOF BADGE (#70)
  router.get(
    '/proof/badges/task/:taskId',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ badge: await taskBadge(req.ctx.user!.id, req.params.taskId!) }));
    }),
  );

  // WHY-BUTTON (#71)
  router.get(
    '/proof/:id/why',
    asyncRoute(async (req, res) => {
      res.json(jsonResult(await whyTrace(req.ctx.user!.id, req.params.id!)));
    }),
  );

  router.post(
    '/proof',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const claim = str(body.claim);
      if (!claim) throw AppError.badRequest('claim_required', 'claim is required');
      const claimRow = await registerClaim(req.ctx.user!.id, {
        claim,
        subject: str(body.subject),
        projectId: str(body.projectId) || null,
        taskId: str(body.taskId) || null,
        evidenceKind: kindOf(EvidenceKind, str(body.evidenceKind) ?? undefined) ?? 'NONE',
        evidenceRef: str(body.evidenceRef) || null,
        whyTrace: Array.isArray(body.whyTrace) ? body.whyTrace.map(String) : undefined,
      });
      res.status(201).json(jsonResult({ claim: claimRow }));
    }),
  );

  router.post(
    '/proof/:id/evidence',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      if (!body.evidenceKind) throw AppError.badRequest('evidence_kind_required', 'evidenceKind is required');
      if (!body.evidenceRef) throw AppError.badRequest('evidence_ref_required', 'evidenceRef is required');
      res.json(jsonResult({ claim: await attachEvidence(req.ctx.user!.id, req.params.id!, {
        evidenceKind: kindOf(EvidenceKind, str(body.evidenceKind) ?? undefined) ?? 'NONE',
        evidenceRef: str(body.evidenceRef) ?? '',
        whyTrace: Array.isArray(body.whyTrace) ? body.whyTrace.map(String) : undefined,
      }) }));
    }),
  );

  // ------------------------------------------------------------- ECHO MEMORY
  router.get(
    '/echo',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ lessons: await listEchoLessons(req.ctx.user!.id, {
        moduleScope: str(req.query.moduleScope) || undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }) }));
    }),
  );

  router.post(
    '/echo',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      if (!body.lesson || typeof body.lesson !== 'string' || !body.lesson.trim()) {
        throw AppError.badRequest('lesson_required', 'lesson is required');
      }
      res.status(201).json(jsonResult({ lesson: await recordEchoLesson(req.ctx.user!.id, {
        moduleScope: str(body.moduleScope),
        label: str(body.label) ?? '',
        lesson: body.lesson,
        source: kindOf(EchoSource, str(body.source) ?? undefined) ?? 'CORRECTION',
        projectId: str(body.projectId) || null,
      }) }));
    }),
  );

  router.get(
    '/echo/retrieve',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ lessons: await retrieveEchoLessons(
        req.ctx.user!.id,
        str(req.query.moduleScope) || undefined,
        req.query.limit ? Number(req.query.limit) : undefined,
      ) }));
    }),
  );

  router.post(
    '/echo/:id/apply',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ lesson: await markEchoLessonApplied(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  // ---------------------------------------------------------------- WARDEN
  router.get(
    '/warden',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ policies: await listWardenPolicies(req.ctx.user!.id, {
        projectId: str(req.query.projectId) || undefined,
      }) }));
    }),
  );

  router.post(
    '/warden',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const name = str(body.name);
      if (!name) throw AppError.badRequest('policy_name_required', 'name is required');
      res.status(201).json(jsonResult({ policy: await createWardenPolicy(req.ctx.user!.id, {
        name,
        description: str(body.description),
        projectId: str(body.projectId) || null,
        forbiddenImports: Array.isArray(body.forbiddenImports) ? body.forbiddenImports.map(String) : undefined,
        requiredImports: Array.isArray(body.requiredImports) ? body.requiredImports.map(String) : undefined,
        enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
      }) }));
    }),
  );

  router.post(
    '/warden/check',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      if (typeof body.diff !== 'string') throw AppError.badRequest('diff_required', 'diff is required');
      const result = await checkChangeAgainstPolicies(req.ctx.user!.id, body.diff, {
        projectId: str(body.projectId) || undefined,
      });
      res.status(result.passed ? 200 : 422).json(jsonResult(result));
    }),
  );

  router.get(
    '/warden/:id',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ policy: await getWardenPolicy(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.patch(
    '/warden/:id',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      res.json(jsonResult({ policy: await updateWardenPolicy(req.ctx.user!.id, req.params.id!, {
        description: body.description === undefined ? undefined : str(body.description),
        forbiddenImports: body.forbiddenImports === undefined ? undefined : body.forbiddenImports.map(String),
        requiredImports: body.requiredImports === undefined ? undefined : body.requiredImports.map(String),
        enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
      }) }));
    }),
  );

  router.delete(
    '/warden/:id',
    asyncRoute(async (req, res) => {
      await deleteWardenPolicy(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ deleted: true }));
    }),
  );

  // ------------------------------------------------------------- SPEC LINTER
  router.get(
    '/specs',
    asyncRoute(async (req, res) => {
      const kind = str(req.query.kind);
      res.json(jsonResult({ entries: await listSpecEntries(req.ctx.user!.id, {
        kind: kindOf(SpecKind, kind),
        projectId: str(req.query.projectId) || undefined,
      }) }));
    }),
  );

  router.post(
    '/specs',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const name = str(body.name);
      if (!name) throw AppError.badRequest('spec_name_required', 'name is required');
      res.status(201).json(jsonResult({ entry: await upsertSpecEntry(req.ctx.user!.id, {
        kind: kindOf(SpecKind, str(body.kind) ?? undefined) ?? 'ENDPOINT',
        name,
        expectation: str(body.expectation),
        projectId: str(body.projectId) || null,
      }) }));
    }),
  );

  router.post(
    '/specs/check',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const report = await runSpecChecks(req.ctx.user!.id, {}, { projectId: str(body.projectId) || undefined });
      res.json(jsonResult(report));
    }),
  );

  // --------------------------------------------------------- CHECKPOINT TIME MACHINE
  router.get(
    '/checkpoints',
    asyncRoute(async (req, res) => {
      const taskId = str(req.query.taskId);
      if (!taskId) throw AppError.badRequest('task_id_required', 'taskId is required');
      res.json(jsonResult({ checkpoints: await listCheckpoints(req.ctx.user!.id, taskId) }));
    }),
  );

  router.post(
    '/checkpoints',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const taskId = str(body.taskId);
      if (!taskId) throw AppError.badRequest('task_id_required', 'taskId is required');
      res.status(201).json(jsonResult({ checkpoint: await createCheckpoint(req.ctx.user!.id, {
        taskId,
        projectId: str(body.projectId) || null,
        label: str(body.label),
        manifest: body.manifest && typeof body.manifest === 'object' ? body.manifest : undefined,
      }) }));
    }),
  );

  router.get(
    '/checkpoints/:id',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ checkpoint: await getCheckpoint(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.post(
    '/checkpoints/:id/restore',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ checkpoint: await restoreCheckpoint(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.post(
    '/checkpoints/:id/fork',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      res.status(201).json(jsonResult({ checkpoint: await forkCheckpoint(req.ctx.user!.id, req.params.id!, {
        taskId: str(body.taskId),
        label: str(body.label),
      }) }));
    }),
  );

  // ------------------------------------------------------ LIVE DIFF WATCH (#67)
  // Coworker runtime pushes edits as they happen; the editor subscribes with
  // Server-Sent Events and gets each file_changed/comment/checkpoint live.
  router.post(
    '/live/events',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const taskId = str(body.taskId);
      if (!taskId) throw AppError.badRequest('task_id_required', 'taskId is required');
      const kind = kindOf(Object.values(AgentEventKind), str(body.kind) ?? undefined);
      if (!kind) throw AppError.badRequest('event_kind_required', `kind must be one of ${Object.values(AgentEventKind).join(', ')}`);
      const event = await appendAgentEvent(req.ctx.user!.id, {
        taskId,
        runId: str(body.runId),
        kind,
        path: str(body.path) || null,
        patch: str(body.patch) ?? null,
        payload: body.payload && typeof body.payload === 'object' ? body.payload : {},
        projectId: str(body.projectId) || null,
      });
      res.status(201).json(jsonResult({ event }));
    }),
  );

  router.get(
    '/live/diffs/:taskId',
    asyncRoute(async (req, res) => {
      const after = req.query.after ? Number(req.query.after) : undefined;
      res.json(jsonResult({ events: await streamAgentEvents(req.ctx.user!.id, req.params.taskId!, {
        afterSeq: after && Number.isFinite(after) ? after : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }) }));
    }),
  );

  // SSE live stream: poll the append-only log; keep the stream open only while
  // activity continues. Last-Event-ID -> resend from that cursor.
  router.get(
    '/live/stream/:taskId',
    asyncRoute(async (req, res) => {
      const userId = req.ctx.user!.id;
      const taskId = req.params.taskId!;
      const lastId = Number(req.header('Last-Event-ID') ?? req.header('last-event-id') ?? 0) || 0;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      let closed = false;
      let idleMs = 0;
      let cursor = lastId;
      const startedAt = Date.now();
      const close = () => { closed = true; res.end(); };
      req.on('close', close);
      res.write(`event: subscribe\ndata: ${JSON.stringify({ taskId, from: cursor })}\n\n`);
      const send = (event: unknown) => {
        if (closed || res.destroyed) return;
        res.write(`id: ${cursor}\nevent: diff\ndata: ${JSON.stringify(event)}\n\n`);
      };
      while (!closed) {
        if (Date.now() - startedAt > 1_800_000) { // hard 30-min cap, honest close
          if (!closed) { res.write(`event: idle\ndata: {"reason":"max_duration"}\n\n`); close(); }
          break;
        }
        const batch = await streamAgentEvents(userId, taskId, { afterSeq: cursor, limit: 50 });
        if (batch.length > 0) {
          idleMs = 0;
          for (const row of batch) {
            cursor = row.seq;
            send(row);
          }
        } else {
          idleMs += 1500;
          if (idleMs > 30_000) { // 30s of silence = task idle, close honestly
            if (!closed) { res.write(`event: idle\ndata: {"reason":"no_activity"}\n\n`); close(); }
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 1500));
        if (closed) break;
      }
    }),
  );

  // Comment on the live diff mid-task -> the coworker adjusts instead of after.
  router.post(
    '/live/comments',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const taskId = str(body.taskId);
      if (!taskId) throw AppError.badRequest('task_id_required', 'taskId is required');
      if (!str(body.path)) throw AppError.badRequest('path_required', 'path is required');
      if (!str(body.comment)) throw AppError.badRequest('comment_required', 'comment is required');
      const event = await commentOnDiff(req.ctx.user!.id, {
        taskId,
        runId: str(body.runId),
        path: str(body.path)!,
        comment: str(body.comment)!,
        projectId: str(body.projectId) || null,
      });
      res.status(201).json(jsonResult({ event }));
    }),
  );

  // --------------------------------------------------------- AUTO-FIX INBOX (#69)
  // Every CI failure / Sentry error / broken preview / failed deploy -> ticket
  // with an Auto-Fix flow: reproduce -> fix with proof -> PR.
  router.get(
    '/fixes',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ tickets: await listFixTickets(req.ctx.user!.id, {
        status: kindOf(Object.values(FixStatus), str(req.query.status) ?? undefined),
        source: kindOf(Object.values(FixSource), str(req.query.source) ?? undefined),
      }) }));
    }),
  );

  router.post(
    '/fixes',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const issue = str(body.issue);
      if (!issue) throw AppError.badRequest('issue_required', 'issue is required');
      const source = kindOf(Object.values(FixSource), str(body.source) ?? undefined) ?? 'manual';
      res.status(201).json(jsonResult({ ticket: await createFixTicket(req.ctx.user!.id, {
        source,
        issue,
        ref: str(body.ref),
        title: str(body.title),
        errorSnippet: str(body.errorSnippet),
        projectId: str(body.projectId) || null,
      }) }));
    }),
  );

  router.get(
    '/fixes/:id',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ ticket: await getFixTicket(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  // Auto-Fix clicked -> coworker reproduces in a sandbox.
  router.post(
    '/fixes/:id/start',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ ticket: await startReproduction(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  // Coworker fixed it with proof -> attach proof claim + PR url.
  router.post(
    '/fixes/:id/propose',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      res.json(jsonResult({ ticket: await proposeFix(req.ctx.user!.id, req.params.id!, {
        proofClaimId: str(body.proofClaimId),
        prUrl: str(body.prUrl),
        title: str(body.title),
      }) }));
    }),
  );

  router.post(
    '/fixes/:id/resolve',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      res.json(jsonResult({ ticket: await resolveFix(req.ctx.user!.id, req.params.id!, str(body.prUrl)) }));
    }),
  );

  router.post(
    '/fixes/:id/supersede',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ ticket: await supersedeFix(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  // --------------------------------------------------- INTENTION COMPLETION (#59)
  // Comment describing intent -> implementation + tests + docs appear and the
  // comment is deleted (comment_marker) because code speaks.
  router.post(
    '/intent',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      if (!str(body.file)) throw AppError.badRequest('file_required', 'file is required');
      if (!str(body.intent)) throw AppError.badRequest('intent_required', 'intent is required');
      res.status(201).json(jsonResult({ draft: await generateIntentDraft(req.ctx.user!.id, {
        file: str(body.file)!,
        intent: str(body.intent)!,
        language: str(body.language),
        projectId: str(body.projectId) || null,
      }) }));
    }),
  );

  router.get(
    '/intent',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ drafts: await listIntentDrafts(req.ctx.user!.id, {
        status: kindOf(['DRAFT', 'APPLIED', 'DISMISSED'] as const, str(req.query.status) ?? undefined),
      }) }));
    }),
  );

  router.get(
    '/intent/:id',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ draft: await getIntentDraft(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.post(
    '/intent/:id/apply',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ draft: await applyIntentDraft(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.post(
    '/intent/:id/dismiss',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ draft: await dismissIntentDraft(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  // -------------------------------------------------------- FRESH-EYES REVIEW (#11)
  // Zero-context outside review: deterministic blind-spot analyzers flag the
  // things context-rich agents normalized. Pairs an inside perspective (the
  // caller's context note) with the cold outside view.
  router.get(
    '/fresh-eyes',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ reviews: await listFreshEyesReviews(req.ctx.user!.id, {
        status: kindOf(['OPEN', 'RESOLVED', 'DISMISSED'] as const, str(req.query.status) ?? undefined),
        verdict: kindOf(['CLEAN', 'FLAGGED'] as const, str(req.query.verdict) ?? undefined),
      }) }));
    }),
  );

  router.post(
    '/fresh-eyes',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      if (!str(body.code)) throw AppError.badRequest('code_required', 'code is required');
      res.status(201).json(jsonResult({ review: await runFreshEyesReview(req.ctx.user!.id, {
        file: str(body.file),
        code: str(body.code)!,
        taskId: str(body.taskId),
        projectId: str(body.projectId) || null,
        contextNote: str(body.contextNote),
      }) }));
    }),
  );

  router.get(
    '/fresh-eyes/:id',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ review: await getFreshEyesReview(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.post(
    '/fresh-eyes/:id/proof',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      if (!str(body.proofClaimId)) throw AppError.badRequest('proof_claim_id_required', 'proofClaimId is required');
      res.json(jsonResult({ review: await linkProofClaim(req.ctx.user!.id, req.params.id!, str(body.proofClaimId)!) }));
    }),
  );

  router.post(
    '/fresh-eyes/:id/resolve',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ review: await closeFreshEyesReview(req.ctx.user!.id, req.params.id!, 'RESOLVED') }));
    }),
  );

  router.post(
    '/fresh-eyes/:id/dismiss',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ review: await closeFreshEyesReview(req.ctx.user!.id, req.params.id!, 'DISMISSED') }));
    }),
  );

  // -------------------------------------------------------- COWORK REPLAY (#163)
  // Every agent session is a replayable, forkable timeline. Sessions pin a task
  // at its current event seq; forking copies the event log into a new task so a
  // teammate continues from the exact trace.
  router.get(
    '/replay/sessions',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ replays: await listReplaySessions(req.ctx.user!.id) }));
    }),
  );

  router.post(
    '/replay/sessions',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      if (!str(body.taskId)) throw AppError.badRequest('task_id_required', 'taskId is required');
      res.status(201).json(jsonResult({ replay: await createReplaySession(req.ctx.user!.id, {
        taskId: str(body.taskId)!,
        note: str(body.note),
        projectId: str(body.projectId) || null,
      }) }));
    }),
  );

  router.get(
    '/replay/sessions/:id',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ replay: await getReplaySession(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.post(
    '/replay/sessions/:id/fork',
    asyncRoute(async (req, res) => {
      res.status(201).json(jsonResult({ replay: await forkReplaySession(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.post(
    '/replay/sessions/:id/archive',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      res.json(jsonResult({ replay: await archiveReplaySession(req.ctx.user!.id, req.params.id!, str(body.note)) }));
    }),
  );

  // -------------------------------------------------------- ORACLE (#14)
  // Live, ranked risk per file/function/module: complexity x churn x past
  // failures. Recomputing a target updates its entry (no noise accumulation).
  router.get(
    '/risk',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ risks: await listRiskScores(req.ctx.user!.id, {
        band: kindOf(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const, str(req.query.band) ?? undefined),
      }) }));
    }),
  );

  router.post(
    '/risk',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      if (!str(body.targetPath) || str(body.targetType) == null) {
        throw AppError.badRequest('risk_input_required', 'targetPath and targetType are required');
      }
      res.status(201).json(jsonResult({ risk: await upsertRiskScore(req.ctx.user!.id, {
        targetType: kindOf(['FILE', 'FUNCTION', 'MODULE'] as const, str(body.targetType)) ?? 'FILE',
        targetPath: str(body.targetPath)!,
        complexityScore: Number(body.complexityScore) || 0,
        churnScore: Number(body.churnScore) || 0,
        failureLinks: Number(body.failureLinks) || 0,
        reasons: Array.isArray(body.reasons) ? body.reasons.map((r: unknown) => String(r)) : [],
        projectId: str(body.projectId) || null,
      }) }));
    }),
  );

  router.get(
    '/risk/:id',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ risk: await getRiskScore(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.delete(
    '/risk/:id',
    asyncRoute(async (req, res) => {
      res.json(jsonResult(await removeRiskScore(req.ctx.user!.id, req.params.id!)));
    }),
  );

  // -------------------------------------------------------- ANOMALY HUNTER (#46)
  // Diffs what the code does against what it says it does. Deterministic name /
  // comment / test-description checks, closable like Fresh-Eyes.
  router.get(
    '/anomalies',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ scans: await listAnomalyScans(req.ctx.user!.id, {
        status: kindOf(['OPEN', 'RESOLVED', 'DISMISSED'] as const, str(req.query.status) ?? undefined),
        verdict: kindOf(['CLEAN', 'FLAGGED'] as const, str(req.query.verdict) ?? undefined),
      }) }));
    }),
  );

  router.post(
    '/anomalies',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      if (!str(body.code)) throw AppError.badRequest('code_required', 'code is required');
      res.status(201).json(jsonResult({ scan: await runAnomalyScan(req.ctx.user!.id, {
        targetType: kindOf(['CODE', 'TEST', 'DOC'] as const, str(body.targetType)) ?? 'CODE',
        code: str(body.code)!,
        targetPath: str(body.targetPath),
        projectId: str(body.projectId) || null,
      }) }));
    }),
  );

  router.get(
    '/anomalies/:id',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ scan: await getAnomalyScan(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.post(
    '/anomalies/:id/resolve',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ scan: await closeAnomalyScan(req.ctx.user!.id, req.params.id!, 'RESOLVED') }));
    }),
  );

  router.post(
    '/anomalies/:id/dismiss',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ scan: await closeAnomalyScan(req.ctx.user!.id, req.params.id!, 'DISMISSED') }));
    }),
  );

  // -------------------------------------------------------- STANDUP FROM REALITY (#136)
  // Daily digest built from actual artifacts (events, fix tickets, scans,
  // risks, replays) — never self-reported. One report per day per user.
  router.get(
    '/standup',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ reports: await listStandupReports(req.ctx.user!.id, {
        status: kindOf(['DRAFT', 'PUBLISHED'] as const, str(req.query.status) ?? undefined),
        date: str(req.query.date) ?? undefined,
      }) }));
    }),
  );

  router.post(
    '/standup/generate',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      res.status(201).json(jsonResult({ report: await generateStandup(req.ctx.user!.id, {
        date: str(body.date) ?? undefined,
        projectId: str(body.projectId) || null,
      }) }));
    }),
  );

  router.post(
    '/standup/:id/publish',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ report: await publishStandupReport(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.get(
    '/standup/:id',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ report: await getStandupReport(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  // -------------------------------------------------------- ENGINEERING SIXTH SENSE (#155)
  // One GREEN/YELLOW/RED indicator aggregated from the intelligence tables.
  router.get(
    '/health-signal',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ signal: await getHealthSignal(req.ctx.user!.id, { scope: str(req.query.scope) ?? undefined }) }));
    }),
  );

  router.post(
    '/health-signal/refresh',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      res.json(jsonResult({ signal: await computeHealthSignal(req.ctx.user!.id, {
        scope: str(body.scope) ?? undefined,
        projectId: str(body.projectId) || null,
      }) }));
    }),
  );

  // ---------------------------------------------------------------- TURBO (#16)
  // Performance findings with before/after proof attached.
  router.get(
    '/perf-findings',
    asyncRoute(async (req, res) => {
      const status = str(req.query.status) as 'OPEN' | 'FIXED' | undefined;
      res.json(jsonResult({ findings: await listPerformanceFindings(req.ctx.user!.id, status ? { status } : {}) }));
    }),
  );

  router.post(
    '/perf-findings',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      res.json(jsonResult({ finding: await recordPerformanceFinding(req.ctx.user!.id, {
        target: str(body.target) ?? '',
        title: str(body.title) ?? '',
        diagnosis: str(body.diagnosis) ?? undefined,
        benchmarkBefore: num(body.benchmarkBefore) ?? 0,
        benchmarkAfter: num(body.benchmarkAfter) ?? 0,
        projectId: str(body.projectId) || null,
      }) }));
    }),
  );

  router.post(
    '/perf-findings/:id/fix',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ finding: await resolvePerformanceFinding(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  // ----------------------------------------------------------------- CHRONOS (#17)
  // "Why does this codebase work this way?" — answered from decision records.
  router.get(
    '/decisions',
    asyncRoute(async (req, res) => {
      const area = str(req.query.area) ?? undefined;
      const status = str(req.query.status) as 'ACTIVE' | 'RECONSIDERING' | 'SUPERSEDED' | undefined;
      res.json(jsonResult({ decisions: await getDecisionHistory(req.ctx.user!.id, area, status) }));
    }),
  );

  router.get(
    '/decisions/search',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ decisions: await searchDecisions(req.ctx.user!.id, str(req.query.q) ?? '') }));
    }),
  );

  router.post(
    '/decisions',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const assumptions = Array.isArray(body.assumptions) ? body.assumptions.map(String) : undefined;
      res.json(jsonResult({ decision: await recordDecision(req.ctx.user!.id, {
        area: str(body.area) ?? '',
        subject: str(body.subject) ?? '',
        decision: str(body.decision) ?? '',
        reasoning: str(body.reasoning) ?? '',
        author: str(body.author) ?? '',
        assumptions,
        projectId: str(body.projectId) || null,
      }) }));
    }),
  );

  router.get(
    '/decisions/:id',
    asyncRoute(async (req, res) => {
      const decision = await findDecisionById(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ decision }));
    }),
  );

  // ------------------------------------------------------- DECISION REAPER (#25)
  router.get(
    '/decisions/reap',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ reaped: await reapDecisions(req.ctx.user!.id) }));
    }),
  );

  router.post(
    '/decisions/:id/reconsider',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      res.json(jsonResult({ decision: await reviewUnlessSupplanted(req.ctx.user!.id, req.params.id!, str(body.note) ?? undefined) }));
    }),
  );

  router.post(
    '/decisions/:id/suppress',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ decision: await suppressDecision(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  // ------------------------------------------------------ PATTERN PROPHET (#24)
  router.get(
    '/patterns',
    asyncRoute(async (req, res) => {
      const triggerType = str(req.query.triggerType) as 'SCHEMA_CHANGE' | 'ENDPOINT_ADD' | 'NEW_MODULE' | 'DEPENDENCY_UPGRADE' | undefined;
      const status = str(req.query.status) as 'ENABLED' | 'DISABLED' | undefined;
      res.json(jsonResult({ patterns: await listPatterns(req.ctx.user!.id, { triggerType, status }) }));
    }),
  );

  router.post(
    '/patterns/learn',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const steps = Array.isArray(body.steps) ? body.steps.map(String) : [];
      res.json(jsonResult({ pattern: await learnPattern(req.ctx.user!.id, {
        triggerType: str(body.triggerType) as 'SCHEMA_CHANGE' | 'ENDPOINT_ADD' | 'NEW_MODULE' | 'DEPENDENCY_UPGRADE',
        trigger: str(body.trigger) ?? '',
        steps,
        projectId: str(body.projectId) || null,
      }) }));
    }),
  );

  router.post(
    '/patterns/apply',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      res.json(jsonResult(await applyPattern(req.ctx.user!.id, str(body.patternId) ?? '', { trigger: str(body.trigger) ?? '' })));
    }),
  );

  router.post(
    '/patterns/:id/accept',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ pattern: await certifyPattern(req.ctx.user!.id, req.params.id!, true) }));
    }),
  );

  router.post(
    '/patterns/:id/decline',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ pattern: await certifyPattern(req.ctx.user!.id, req.params.id!, false) }));
    }),
  );

  // --------------------------------------------------------------- WHY-WIKI (#28)
  router.get(
    '/why',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ links: await listWhyLinks(req.ctx.user!.id, str(req.query.filePath) ?? undefined) }));
    }),
  );

  router.post(
    '/why',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const line = num(body.line);
      res.json(jsonResult({ link: await createWhyLink(req.ctx.user!.id, {
        filePath: str(body.filePath) ?? '',
        line: line != null ? line : null,
        reason: str(body.reason) ?? '',
        sourceType: str(body.sourceType) ?? '',
        sourceRef: str(body.sourceRef) ?? null,
        projectId: str(body.projectId) || null,
      }) }));
    }),
  );

  router.post(
    '/why/:id/detach',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ link: await detachWhyLink(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  // ------------------------------------------------- DETERMINISM HAMMER (#38)
  router.get(
    '/flake-investigations',
    asyncRoute(async (req, res) => {
      const status = str(req.query.status) as 'OPEN' | 'FIXED' | undefined;
      const category = str(req.query.category) as 'TIME_DEPENDENCE' | 'RANDOM_SEED' | 'ORDER_DEPENDENCE' | 'NETWORK_RELIANCE' | 'UNKNOWN' | undefined;
      res.json(jsonResult({ flakes: await listFlakeInvestigations(req.ctx.user!.id, { status, category }) }));
    }),
  );

  router.post(
    '/flake-investigations',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      res.json(jsonResult({ flake: await recordFlakeInvestigation(req.ctx.user!.id, {
        target: str(body.target) ?? '',
        source: str(body.source) ?? undefined,
        category: str(body.category) as 'TIME_DEPENDENCE' | 'RANDOM_SEED' | 'ORDER_DEPENDENCE' | 'NETWORK_RELIANCE' | 'UNKNOWN' | undefined,
        evidence: str(body.evidence) ?? undefined,
        rootCause: str(body.rootCause) ?? undefined,
        fix: str(body.fix) ?? undefined,
        projectId: str(body.projectId) || null,
      }) }));
    }),
  );

  router.post(
    '/flake-investigations/classify',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      res.json(jsonResult({ classification: categorizeFlake(str(body.source) ?? '') }));
    }),
  );

  router.post(
    '/flake-investigations/:id/fix',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ flake: await resolveFlakeInvestigation(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  // ------------------------------------------------- SUPPLY-CHAIN SENTINEL (#40)
  router.get(
    '/packages',
    asyncRoute(async (req, res) => {
      const verdict = str(req.query.verdict) as 'APPROVE' | 'SANDBOX' | 'BLOCK' | undefined;
      res.json(jsonResult({ packages: await listPackages(req.ctx.user!.id, verdict ? { verdict } : {}) }));
    }),
  );

  router.post(
    '/packages/evaluate',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      res.json(jsonResult({ package: await evaluatePackage(req.ctx.user!.id, {
        name: str(body.name) ?? '',
        publishedDaysAgo: num(body.publishedDaysAgo) ?? 0,
        lastCommitDaysAgo: num(body.lastCommitDaysAgo) ?? 0,
        maintainerCount: num(body.maintainerCount) ?? 0,
        hasInstallScript: Boolean(body.hasInstallScript),
        authorUnknown: Boolean(body.authorUnknown),
        projectId: str(body.projectId) || null,
      }) }));
    }),
  );

  router.get(
    '/packages/:id',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ package: await getPackage(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  // ------------------------------------------------------- DATA GUARDIAN (#42)
  router.get(
    '/pii-scan',
    asyncRoute(async (req, res) => {
      const status = str(req.query.status) as 'TRACKED' | 'REMEDIATED' | undefined;
      const locationType = str(req.query.locationType) as 'STORAGE' | 'LOG_SINK' | 'API_RESPONSE' | 'DATABASE' | undefined;
      res.json(jsonResult({ findings: await listPiiFindings(req.ctx.user!.id, { status, locationType }) }));
    }),
  );

  router.post(
    '/pii-scan',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      res.json(jsonResult({ finding: await recordPiiFinding(req.ctx.user!.id, {
        targetPath: str(body.targetPath) ?? '',
        locationType: str(body.locationType) as 'STORAGE' | 'LOG_SINK' | 'API_RESPONSE' | 'DATABASE',
        contentSample: str(body.contentSample) ?? undefined,
        piiTypes: Array.isArray(body.piiTypes) ? body.piiTypes.map(String) : undefined,
        projectId: str(body.projectId) || null,
      }) }));
    }),
  );

  router.post(
    '/pii-scan/detect',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      res.json(jsonResult({ hits: scanForPII(str(body.content) ?? '') }));
    }),
  );

  router.post(
    '/pii-scan/:id/remediate',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ finding: await remediatePiiFinding(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  // ------------------------------------------------------- SECRET AUTOPSY (#43)
  router.get(
    '/secret-incidents',
    asyncRoute(async (req, res) => {
      const status = str(req.query.status) as 'OPEN' | 'RESOLVED' | undefined;
      const rotation = str(req.query.rotation) as 'PENDING' | 'ROTATED' | undefined;
      res.json(jsonResult({ incidents: await listSecretIncidents(req.ctx.user!.id, { status, rotation }) }));
    }),
  );

  router.post(
    '/secret-incidents',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      res.json(jsonResult({ incident: await recordSecretIncident(req.ctx.user!.id, {
        secretName: str(body.secretName) ?? '',
        detectionSource: str(body.detectionSource) as 'COMMIT' | 'LOG' | 'TICKET' | 'ENV' | 'SCREENSHOT',
        firstSeen: str(body.firstSeen) ?? undefined,
        systemsAffected: Array.isArray(body.systemsAffected) ? body.systemsAffected.map(String) : undefined,
        exposureNotes: str(body.exposureNotes) ?? undefined,
        projectId: str(body.projectId) || null,
      }) }));
    }),
  );

  router.get(
    '/secret-incidents/:id/timeline',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ timeline: await buildExposureTimeline(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.post(
    '/secret-incidents/:id/rotate',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ incident: await rotateSecret(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  // -------------------------------------------------------- PROMPT ARMOR (#45)
  router.get(
    '/injection-events',
    asyncRoute(async (req, res) => {
      const surface = str(req.query.surface) as 'ISSUE' | 'WEBPAGE' | 'DEPENDENCY' | 'PDF' | 'LOG' | 'COMMENT' | undefined;
      const status = str(req.query.status) as 'OPEN' | 'NEUTRALIZED' | 'IGNORED' | undefined;
      res.json(jsonResult({ events: await listInjectionEvents(req.ctx.user!.id, { surface, status }) }));
    }),
  );

  router.post(
    '/injection-scan',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const content = str(body.content) ?? '';
      if (str(body.dryRun)) {
        res.json(jsonResult({ hits: scanForInjections(content) }));
        return;
      }
      res.json(jsonResult({ event: await detectPromptInjection(req.ctx.user!.id, {
        surface: str(body.surface) as 'ISSUE' | 'WEBPAGE' | 'DEPENDENCY' | 'PDF' | 'LOG' | 'COMMENT',
        content,
        projectId: str(body.projectId) || null,
      }) }));
    }),
  );

  router.post(
    '/injection-events/:id/neutralize',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ event: await neutralizeInjection(req.ctx.user!.id, req.params.id!, false) }));
    }),
  );

  // ---- MEMORY & LEARNING (Tranche G) ------------------------------------

  // BLAMELESS ARCHIVIST (#48)
  router.get('/postmortems', requireAuth, asyncRoute(async (req, res) => {
    const { term } = req.query as { term?: string };
    res.json(jsonResult({ postmortems: await listPostmortems(req.ctx.user!.id, { term }) }));
  }));
  router.post('/postmortems', requireAuth, asyncRoute(async (req, res) => {
    const postmortem = await archivePostmortem(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ postmortem }));
  }));
  router.post('/postmortems/related', requireAuth, asyncRoute(async (req, res) => {
    const { query, limit } = req.body as { query?: string; limit?: number };
    res.json(jsonResult({ results: await retrieveRelatedPostmortems(req.ctx.user!.id, { query: query ?? '', limit }) }));
  }));

  // ONTOLOGY ENGINE (#50)
  router.get('/ontology/terms', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ terms: await listTerms(req.ctx.user!.id) }));
  }));
  router.post('/ontology/terms', requireAuth, asyncRoute(async (req, res) => {
    const term = await registerTerm(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ term }));
  }));
  router.post('/ontology/scan', requireAuth, asyncRoute(async (req, res) => {
    const observations = (req.body?.observations ?? []) as Array<{ name?: string; sourceType?: string; location?: string }>;
    const scan = await logTermScan(
      req.ctx.user!.id,
      observations.map((o) => ({ name: o.name ?? '', sourceType: (o.sourceType ?? 'CODE') as OntologySourceType, location: o.location ?? '' })),
    );
    res.json(jsonResult(scan));
  }));
  router.get('/ontology/violations', requireAuth, asyncRoute(async (req, res) => {
    const { status } = req.query as { status?: string };
    res.json(jsonResult({ violations: await listViolations(req.ctx.user!.id, kindOf(['OPEN', 'APPROVED', 'REJECTED'], status) ? { status: status as 'OPEN' | 'APPROVED' | 'REJECTED' } : {}) }));
  }));
  router.post('/ontology/violations/:id/resolve', requireAuth, asyncRoute(async (req, res) => {
    const accepted = req.body?.accepted === true;
    const violation = await resolveViolation(req.ctx.user!.id, req.params.id!, accepted);
    res.json(jsonResult({ violation }));
  }));
  router.post('/ontology/unify', requireAuth, asyncRoute(async (req, res) => {
    const { oldName, canonicalName } = req.body as { oldName?: string; canonicalName?: string };
    res.json(jsonResult(await unifyTerm(req.ctx.user!.id, { oldName: oldName ?? '', canonicalName: canonicalName ?? '' })));
  }));

  // VOICE-OF-CODEBASE (#52)
  router.get('/codebase/answers', requireAuth, asyncRoute(async (req, res) => {
    const { limit } = req.query as { limit?: string };
    res.json(jsonResult({ answers: await listAnswers(req.ctx.user!.id, { limit: num(limit) }) }));
  }));
  router.post('/codebase/ask', requireAuth, asyncRoute(async (req, res) => {
    const { question } = req.body as { question?: string };
    res.status(201).json(jsonResult({ answer: await askCodebase(req.ctx.user!.id, question ?? '') }));
  }));

  // COMMIT ARCHAEOLOGIST (#56)
  router.get('/archaeology', requireAuth, asyncRoute(async (req, res) => {
    const { term } = req.query as { term?: string };
    res.json(jsonResult({ insights: await listDigs(req.ctx.user!.id, { term }) }));
  }));
  router.post('/archaeology/origins', requireAuth, asyncRoute(async (req, res) => {
    const insight = await recordOrigin(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ insight }));
  }));
  router.get('/archaeology/dig', requireAuth, asyncRoute(async (req, res) => {
    const { filePath, functionName } = req.query as { filePath?: string; functionName?: string };
    res.json(jsonResult({ insight: await dig(req.ctx.user!.id, filePath ?? '', functionName ?? '') }));
  }));
  router.get('/archaeology/commit/:commit', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ insights: await reconstructByCommit(req.ctx.user!.id, req.params.commit!) }));
  }));

  // SKILL TAXONOMY (#58)
  router.get('/skills', requireAuth, asyncRoute(async (req, res) => {
    const { developer, skill } = req.query as { developer?: string; skill?: string };
    res.json(jsonResult({ signals: await listSkillSignals(req.ctx.user!.id, { developer, skill }) }));
  }));
  router.post('/skills/signals', requireAuth, asyncRoute(async (req, res) => {
    const signal = await recordSkillSignal(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ signal }));
  }));
  router.get('/skills/who-knows', requireAuth, asyncRoute(async (req, res) => {
    const { skill } = req.query as { skill?: string };
    res.json(jsonResult(await whoKnows(req.ctx.user!.id, skill ?? '')));
  }));
  router.post('/skills/route-review', requireAuth, asyncRoute(async (req, res) => {
    const { skill, domain } = req.body as { skill?: string; domain?: string };
    res.json(jsonResult(await routeReview(req.ctx.user!.id, { skill: skill ?? '', domain })));
  }));
  router.get('/skills/:developer/top', requireAuth, asyncRoute(async (req, res) => {
    const { limit } = req.query as { limit?: string };
    res.json(jsonResult({ skills: await developerTopSkills(req.ctx.user!.id, req.params.developer!, num(limit)) }));
  }));

  // ---- GOVERNANCE & QUALITY (Tranche H) ----------------------------------

  // RED CELL (#30)
  router.post('/red-cell/scan', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const scope = (body.scope ?? []) as Array<{ path?: string; content?: string }>;
    const report = await runRedCellScan(req.ctx.user!.id, {
      projectId: body.projectId ? String(body.projectId) : null,
      scope: scope.map((s) => ({ path: s.path ?? '', content: s.content ?? '' })),
    });
    res.status(201).json(jsonResult(report));
  }));
  router.get('/red-cell/findings', requireAuth, asyncRoute(async (req, res) => {
    const { category, severity, status, confirmed } = req.query as Record<string, string | undefined>;
    res.json(jsonResult({
      findings: await listFindings(req.ctx.user!.id, {
        category: kindOf(RED_CELL_CATEGORIES, category),
        severity: kindOf(RED_CELL_SEVERITIES, severity),
        status: kindOf(FINDING_STATUSES, status),
        confirmed: confirmed === 'true' ? true : confirmed === 'false' ? false : undefined,
      }),
    }));
  }));
  router.post('/red-cell/findings/:id/confirm', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ finding: await confirmFinding(req.ctx.user!.id, req.params.id!) }));
  }));
  router.post('/red-cell/findings/:id/clear', requireAuth, asyncRoute(async (req, res) => {
    const { note } = req.body as { note?: string };
    res.json(jsonResult({ finding: await clearFinding(req.ctx.user!.id, req.params.id!, note) }));
  }));
  router.get('/red-cell/rankings', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult(await rankFindings(req.ctx.user!.id)));
  }));

  // COVERAGE SENTINEL (#31)
  router.post('/coverage/scans', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const report = (body.report ?? []) as Array<{ file?: string; location?: string; function_name?: string; uncovered_branches?: number; total_branches?: number }>;
    const candidates = (body.candidateTests ?? []) as Array<{ function_name?: string | null; body?: string }>;
    const scan = await runCoverageScan(req.ctx.user!.id, {
      projectId: body.projectId ? String(body.projectId) : null,
      report: report.map((r) => ({
        file: r.file ?? '',
        location: r.location ?? '',
        function_name: r.function_name ?? '',
        uncovered_branches: Number(r.uncovered_branches ?? 0),
        total_branches: r.total_branches !== undefined ? Number(r.total_branches) : undefined,
      })),
      candidateTests: candidates.map((c) => ({ function_name: c.function_name ?? null, body: c.body ?? '' })),
    });
    res.status(201).json(jsonResult(scan));
  }));
  router.get('/coverage/scans', requireAuth, asyncRoute(async (req, res) => {
    const { status } = req.query as { status?: string };
    res.json(jsonResult({ scans: await listCoverageScans(req.ctx.user!.id, { status }) }));
  }));
  router.get('/coverage/scans/verify-test-quality', requireAuth, asyncRoute(async (req, res) => {
    const { body, function_name } = req.query as Record<string, string | undefined>;
    res.json(jsonResult(analyzeTestQuality(body ?? '', function_name ?? null)));
  }));
  router.get('/coverage/scans/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ scan: await getCoverageScan(req.ctx.user!.id, req.params.id!) }));
  }));

  // DIPLOMAT (#32)
  router.get('/dependencies', requireAuth, asyncRoute(async (req, res) => {
    const { freshness } = req.query as { freshness?: string };
    res.json(jsonResult({ dependencies: await listDependencies(req.ctx.user!.id, { freshness }) }));
  }));
  router.post('/dependencies', requireAuth, asyncRoute(async (req, res) => {
    const dependency = await upsertDependency(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ dependency }));
  }));
  router.post('/dependencies/upgrade', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult(await runUpgrade(req.ctx.user!.id, req.body ?? {})));
  }));
  router.get('/dependencies/upgrades', requireAuth, asyncRoute(async (req, res) => {
    const { status } = req.query as { status?: string };
    res.json(jsonResult({ upgrades: await listUpgrades(req.ctx.user!.id, { status }) }));
  }));
  router.get('/dependencies/health', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult(await dependencyHealth(req.ctx.user!.id)));
  }));

  // CONTRACT WARDEN (#37)
  router.get('/contracts', requireAuth, asyncRoute(async (req, res) => {
    const { name } = req.query as { name?: string };
    res.json(jsonResult({ contracts: await listContracts(req.ctx.user!.id, { name }) }));
  }));
  router.post('/contracts', requireAuth, asyncRoute(async (req, res) => {
    const contract = await publishContract(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ contract }));
  }));
  router.get('/contracts/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ contract: await findContractById(req.ctx.user!.id, req.params.id!) }));
  }));
  router.post('/contracts/:id/verify', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    res.json(jsonResult({ check: await verifyImplementation(req.ctx.user!.id, { contractId: req.params.id!, implementation: body.implementation ?? [] }) }));
  }));
  router.post('/contracts/:id/consumer-check', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    res.json(jsonResult(await checkConsumer(req.ctx.user!.id, { contractId: req.params.id!, consumer: body.consumer ?? [] })));
  }));
  router.get('/contracts/:id/checks', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ checks: await listChecks(req.ctx.user!.id, { contractId: req.params.id! }) }));
  }));

  // DEPENDENCY CARTOGRAPHER (#47)
  router.get('/dependency-insights', requireAuth, asyncRoute(async (req, res) => {
    const { riskLevel } = req.query as { riskLevel?: string };
    res.json(jsonResult({ insights: await listInsights(req.ctx.user!.id, { riskLevel: kindOf(RISK_LEVELS, riskLevel) }) }));
  }));
  router.post('/dependency-insights', requireAuth, asyncRoute(async (req, res) => {
    const insight = await assessDependency(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ insight }));
  }));
  router.get('/dependency-insights/:packageName', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ insight: await getInsight(req.ctx.user!.id, req.params.packageName!) }));
  }));
  router.get('/dependency-society', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult(await dependencySociety(req.ctx.user!.id)));
  }));

  // ADVERSARIAL SUITE (#35)
  router.post('/adversarial/reviews', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const review = await runAdversarialReview(req.ctx.user!.id, {
      projectId: body.projectId ?? null,
      changeRef: str(body.changeRef) ?? 'pr',
      scope: body.scope ?? [],
    });
    res.status(review.verdict === 'BLOCKED' ? 422 : 201).json(jsonResult({ review }));
  }));
  router.get('/adversarial/reviews', requireAuth, asyncRoute(async (req, res) => {
    const { verdict, changeRef } = req.query as { verdict?: string; changeRef?: string };
    res.json(jsonResult({ reviews: await listAdversarialRuns(req.ctx.user!.id, { verdict: kindOf<readonly AdversarialVerdict[]>(['PASS', 'BLOCKED'], verdict), changeRef }) }));
  }));
  router.get('/adversarial/reviews/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ review: await getAdversarialRun(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/adversarial/attack-plan', requireAuth, asyncRoute(async (_req, res) => {
    res.json(jsonResult({ attackPlan: generateEdgeAttackPlan() }));
  }));

  // MUTATION-GRADE TESTS (#36)
  router.post('/mutation/sweeps', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const sweep = await runMutationSweep(req.ctx.user!.id, {
      projectId: body.projectId ?? null,
      cases: (body.cases ?? []).map((c: Record<string, unknown>) => ({
        file: String(c.file),
        function_name: String(c.function_name),
        test_body: String(c.test_body),
        mutated_outcome: kindOf<readonly MutationOutcome[]>(['PASS', 'FAIL'], String(c.mutated_outcome)) ?? 'PASS',
      })),
    });
    res.status(sweep.verdict === 'SHIP' ? 201 : 422).json(jsonResult({ sweep }));
  }));
  router.get('/mutation/sweeps', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ sweeps: await listMutationSweeps(req.ctx.user!.id) }));
  }));
  router.get('/mutation/sweeps/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ sweep: await getMutationSweep(req.ctx.user!.id, req.params.id!) }));
  }));
  router.post('/mutation/mutate', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult(await mutateSnippet(req.body ?? {})));
  }));
  router.get('/mutation/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await mutationReport(req.ctx.user!.id) }));
  }));

  // SHADOW EXECUTION (#39)
  router.post('/shadow/runs', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const run = await runShadowComparison(req.ctx.user!.id, {
      projectId: body.projectId ?? null,
      releaseRef: str(body.releaseRef) ?? 'release',
      thresholdMs: num(body.thresholdMs),
      mirror: (body.mirror ?? []).map((m: Record<string, unknown>) => ({
        requestKey: String(m.requestKey),
        control: m.control as ShadowProbe,
        candidate: m.candidate as ShadowProbe,
      })),
    });
    res.status(run.verdict === 'BLOCKED' ? 422 : 201).json(jsonResult({ run }));
  }));
  router.get('/shadow/runs', requireAuth, asyncRoute(async (req, res) => {
    const { verdict, releaseRef } = req.query as { verdict?: string; releaseRef?: string };
    res.json(jsonResult({ runs: await listShadowRuns(req.ctx.user!.id, { verdict: kindOf<readonly ShadowVerdict[]>(['PASS', 'BLOCKED'], verdict), releaseRef }) }));
  }));
  router.get('/shadow/runs/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await getShadowRun(req.ctx.user!.id, req.params.id!) }));
  }));
  router.post('/shadow/compare', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    res.json(jsonResult(compareResponses(body.control as ShadowProbe, body.candidate as ShadowProbe, num(body.thresholdMs))));
  }));

  // PRIVILEGE SHRINKER (#41)
  router.post('/privileges/audit', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const result = await auditPermissions(req.ctx.user!.id, {
      projectId: body.projectId ?? null,
      grants: (body.grants ?? []).map((g: Record<string, unknown>) => ({
        principal: String(g.principal),
        resource: String(g.resource),
        action: String(g.action),
        scope: (kindOf<readonly PrivilegeScope[]>(['read', 'write', 'admin', 'ALL'], String(g.scope)) ?? 'read') as PrivilegeScope,
      })),
    });
    res.status(result.flagged > 0 ? 422 : 201).json(jsonResult(result));
  }));
  router.get('/privileges/flags', requireAuth, asyncRoute(async (req, res) => {
    const { severity, status } = req.query as { severity?: string; status?: string };
    res.json(jsonResult({ flags: await listPrivilegeFlags(req.ctx.user!.id, {
      severity: kindOf<readonly PrivilegeSeverity[]>(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'], severity),
      status: kindOf<readonly PrivilegeStatus[]>(['OPEN', 'SHRUNK'], status),
    }) }));
  }));
  router.get('/privileges/flags/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ flag: await getPrivilegeFlag(req.ctx.user!.id, req.params.id!) }));
  }));
  router.post('/privileges/flags/:id/shrink', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ flag: await shrinkPrivilege(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/privileges/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await privilegeReport(req.ctx.user!.id) }));
  }));

  // AGENT SANDBOX ISOLATION (#44)
  router.post('/sandbox/policies', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const policy = await registerSandboxPolicy(req.ctx.user!.id, {
      agentName: String(body.agentName),
      egressAllowlist: body.egressAllowlist ?? [],
      fsJailRoot: String(body.fsJailRoot),
      credentialsVault: body.credentialsVault,
      syscallLogging: body.syscallLogging,
    });
    res.status(201).json(jsonResult({ policy }));
  }));
  router.get('/sandbox/policies', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ policies: await listSandboxPolicies(req.ctx.user!.id) }));
  }));
  router.post('/sandbox/enforce', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const enforcement = await enforceSandbox(req.ctx.user!.id, {
      policyId: body.policyId ?? null,
      agentName: body.agentName ?? null,
      runRef: String(body.runRef),
      kind: kindOf<readonly SandboxActionKind[]>(['NETWORK_CALL', 'FILE_ACCESS', 'CREDENTIAL_READ', 'SYS_CALL'], String(body.kind)) as SandboxActionKind,
      target: String(body.target),
    });
    res.status(enforcement.decision === 'BLOCKED' ? 403 : 200).json(jsonResult({ enforcement }));
  }));
  router.get('/sandbox/actions', requireAuth, asyncRoute(async (req, res) => {
    const { runRef } = req.query as { runRef?: string };
    res.json(jsonResult({ actions: await listSandboxActions(req.ctx.user!.id, { runRef }) }));
  }));
  router.get('/sandbox/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await sandboxReport(req.ctx.user!.id) }));
  }));

  // BUS-FACTOR ALARM (#133)
  router.post('/bus-factor/scan', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const result = await scanBusFactor(req.ctx.user!.id, {
      projectId: body.projectId ?? null,
      modules: body.modules ?? [],
    });
    res.status(result.flagged > 0 ? 422 : 201).json(jsonResult(result));
  }));
  router.get('/bus-factor/alarms', requireAuth, asyncRoute(async (req, res) => {
    const { severity, status } = req.query as { severity?: string; status?: string };
    res.json(jsonResult({ alarms: await listBusFactorAlarms(req.ctx.user!.id, {
      severity: kindOf<readonly BusFactorSeverity[]>(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'], severity),
      status: kindOf<readonly BusFactorStatus[]>(['OPEN', 'CLEARED'], status),
    }) }));
  }));
  router.get('/bus-factor/alarms/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ alarm: await getBusFactorAlarm(req.ctx.user!.id, req.params.id!) }));
  }));
  router.post('/bus-factor/alarms/:id/clear', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ alarm: await clearBusFactorAlarm(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/bus-factor/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await busFactorReport(req.ctx.user!.id) }));
  }));

  // REVIEW ROUTER (#134)
  router.post('/reviews/route', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const assignment = await routeCodeReview(req.ctx.user!.id, {
      projectId: body.projectId ?? null,
      module: String(body.module),
      expertise: body.expertise ?? [],
      availability: body.availability ?? [],
      loads: body.loads ?? [],
    });
    res.status(201).json(jsonResult({ assignment }));
  }));
  router.get('/reviews/assignments', requireAuth, asyncRoute(async (req, res) => {
    const { module } = req.query as { module?: string };
    res.json(jsonResult({ assignments: await listReviewAssignments(req.ctx.user!.id, { module }) }));
  }));
  router.get('/reviews/assignments/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ assignment: await getReviewAssignment(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/reviews/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await reviewRouteReport(req.ctx.user!.id) }));
  }));

  // PAIRING SCHEDULER (#139)
  router.post('/pairings/schedule', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const pairing = await schedulePairing(req.ctx.user!.id, {
      projectId: body.projectId ?? null,
      task: String(body.task),
      complexity: kindOf<readonly TaskComplexity[]>(['SIMPLE', 'MODERATE', 'COMPLEX', 'CRITICAL'], String(body.complexity)) as TaskComplexity,
      team: body.team ?? [],
    });
    res.status(201).json(jsonResult({ pairing }));
  }));
  router.get('/pairings', requireAuth, asyncRoute(async (req, res) => {
    const { status } = req.query as { status?: string };
    res.json(jsonResult({ pairings: await listPairingSchedules(req.ctx.user!.id, {
      status: kindOf<readonly PairingStatus[]>(['SCHEDULED', 'ACCEPTED', 'COMPLETED'], status),
    }) }));
  }));
  router.get('/pairings/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await pairingReport(req.ctx.user!.id) }));
  }));
  router.get('/pairings/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ pairing: await getPairingSchedule(req.ctx.user!.id, req.params.id!) }));
  }));
  router.post('/pairings/:id/accept', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ pairing: await acceptPairing(req.ctx.user!.id, req.params.id!) }));
  }));
  router.post('/pairings/:id/complete', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ pairing: await completePairing(req.ctx.user!.id, req.params.id!) }));
  }));

  // ONBOARDING ROADMAP (#140)
  router.post('/onboarding/roadmaps', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const roadmap = await generateOnboardingRoadmap(req.ctx.user!.id, {
      projectId: body.projectId ?? null,
      role: String(body.role),
      team: String(body.team),
      seniority: kindOf<readonly OnboardingSeniority[]>(['JUNIOR', 'MID', 'SENIOR'], String(body.seniority ?? 'JUNIOR')) as OnboardingSeniority,
      days: body.days === undefined ? undefined : Number(body.days),
    });
    res.status(201).json(jsonResult({ roadmap }));
  }));
  router.get('/onboarding/roadmaps', requireAuth, asyncRoute(async (req, res) => {
    const { role } = req.query as { role?: string };
    res.json(jsonResult({ roadmaps: await listOnboardingRoadmaps(req.ctx.user!.id, { role }) }));
  }));
  router.get('/onboarding/roadmaps/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ roadmap: await getOnboardingRoadmap(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/onboarding/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await onboardingRoadmapReport(req.ctx.user!.id) }));
  }));

  // ASYNC DECISION PLATFORM (#142)
  router.post('/decisions', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const decision = await proposeDecision(req.ctx.user!.id, {
      projectId: body.projectId ?? null,
      title: String(body.title),
      description: String(body.description),
      options: body.options ?? [],
      evidence: body.evidence ?? [],
      voters: body.voters ?? [],
    });
    res.status(201).json(jsonResult({ decision }));
  }));
  router.get('/decisions', requireAuth, asyncRoute(async (req, res) => {
    const { status } = req.query as { status?: string };
    res.json(jsonResult({ decisions: await listAsyncDecisions(req.ctx.user!.id, {
      status: kindOf<readonly DecisionStatus[]>(['OPEN', 'DECIDED', 'CLOSED'], status),
    }) }));
  }));
  router.get('/decisions/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await asyncDecisionReport(req.ctx.user!.id) }));
  }));
  router.get('/decisions/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ decision: await getAsyncDecision(req.ctx.user!.id, req.params.id!) }));
  }));
  router.post('/decisions/:id/votes', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const outcome = await castDecisionVote(req.ctx.user!.id, req.params.id!, {
      voter: String(body.voter),
      option: String(body.option),
      weight: Number(body.weight),
      rationale: body.rationale ? String(body.rationale) : undefined,
      dissent: body.dissent ? String(body.dissent) : undefined,
    });
    res.json(jsonResult({ decision: outcome.decision, resolved: outcome.resolved }));
  }));
  router.post('/decisions/:id/resolve', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult(await resolveDecision(req.ctx.user!.id, req.params.id!)));
  }));
  router.post('/decisions/:id/close', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ decision: await closeDecision(req.ctx.user!.id, req.params.id!) }));
  }));

  // KNOWLEDGE HANDOFF (#135)
  router.post('/knowledge/exports', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const exportDoc = await exportKnowledge(req.ctx.user!.id, {
      person: String(body.person),
      scope: kindOf<readonly KnowledgeScope[]>(['FULL', 'ESSENTIAL'], body.scope) ?? 'FULL',
      modules: body.modules ?? [],
      decisions: body.decisions ?? [],
      corrections: body.corrections ?? [],
    });
    res.status(201).json(jsonResult({ export: exportDoc }));
  }));
  router.get('/knowledge/exports', requireAuth, asyncRoute(async (req, res) => {
    const { person } = req.query as { person?: string };
    res.json(jsonResult({ exports: await listKnowledgeExports(req.ctx.user!.id, { person }) }));
  }));
  router.get('/knowledge/exports/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ export: await getKnowledgeExport(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/knowledge/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await knowledgeExportReport(req.ctx.user!.id) }));
  }));

  // REVIEW LOAD BALANCER (#137)
  router.post('/reviews/load', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const plan = await balanceReviews(req.ctx.user!.id, {
      projectId: body.projectId ?? null,
      items: body.items ?? [],
      reviewers: body.reviewers ?? [],
    });
    res.status(201).json(jsonResult({ plan }));
  }));
  router.get('/reviews/load', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ plans: await listReviewLoadPlans(req.ctx.user!.id) }));
  }));
  router.get('/reviews/load/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ plan: await getReviewLoadPlan(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/reviews/load-report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await reviewLoadReport(req.ctx.user!.id) }));
  }));

  // PERFORMANCE REVIEW DATA (#141)
  router.post('/performance/digests', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const digest = await generatePerformanceDigest(req.ctx.user!.id, {
      person: String(body.person),
      period: String(body.period),
      delivered: body.delivered === undefined ? undefined : Number(body.delivered),
      authored_lines: body.authored_lines === undefined ? undefined : Number(body.authored_lines),
      review_count: body.review_count === undefined ? undefined : Number(body.review_count),
      review_comments: body.review_comments === undefined ? undefined : Number(body.review_comments),
      mentoring: body.mentoring === undefined ? undefined : Number(body.mentoring),
      ops_hours: body.ops_hours === undefined ? undefined : Number(body.ops_hours),
      missed_deadlines: body.missed_deadlines === undefined ? undefined : Number(body.missed_deadlines),
    });
    res.status(201).json(jsonResult({ digest }));
  }));
  router.get('/performance/digests', requireAuth, asyncRoute(async (req, res) => {
    const { person } = req.query as { person?: string };
    res.json(jsonResult({ digests: await listPerformanceDigests(req.ctx.user!.id, { person }) }));
  }));
  router.get('/performance/digests/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ digest: await getPerformanceDigest(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/performance/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await performanceDigestReport(req.ctx.user!.id) }));
  }));

  // BUDGET TRANSPARENCY (#144)
  router.post('/cost/attribute', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const attribution = await attributeCosts(req.ctx.user!.id, {
      team: String(body.team),
      period: String(body.period),
      entries: body.entries ?? [],
    });
    res.status(201).json(jsonResult(attribution));
  }));
  router.get('/cost/attributions', requireAuth, asyncRoute(async (req, res) => {
    const { team } = req.query as { team?: string };
    res.json(jsonResult({ attributions: await listCostAttributions(req.ctx.user!.id, { team }) }));
  }));
  router.get('/cost/attributions/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ attribution: await getCostAttribution(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/cost/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await costReport(req.ctx.user!.id) }));
  }));

  // EQUITY METRICS (#147)
  router.post('/equity/scores', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const outcome = await computeEquity(req.ctx.user!.id, {
      period: String(body.period),
      people: body.people ?? [],
    });
    res.status(201).json(jsonResult(outcome));
  }));
  router.get('/equity/scores', requireAuth, asyncRoute(async (req, res) => {
    const { period } = req.query as { period?: string };
    res.json(jsonResult({ scores: await listEquityScores(req.ctx.user!.id, { period }) }));
  }));
  router.get('/equity/scores/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ score: await getEquityScore(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/equity/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await equityReport(req.ctx.user!.id) }));
  }));

  // AUTOPILOT PRIME (#1)
  router.post('/autopilot/runs', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const run = await executeAutopilot(req.ctx.user!.id, {
      goal: String(body.goal),
      budget: body.budget === undefined ? undefined : Number(body.budget),
      outcomes: body.outcomes ?? {},
    });
    res.status(201).json(jsonResult({ run }));
  }));
  router.get('/autopilot/runs', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ runs: await listAutopilotRuns(req.ctx.user!.id) }));
  }));
  router.get('/autopilot/runs/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await getAutopilotRun(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/autopilot/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await autopilotReport(req.ctx.user!.id) }));
  }));

  // PHOENIX PROTOCOL (#3)
  router.post('/phoenix/cycles', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const cycle = await startPhoenixCycle(req.ctx.user!.id, {
      pipeline: String(body.pipeline),
      commit: String(body.commit),
      failure: String(body.failure),
      env: body.env ?? {},
    });
    res.status(201).json(jsonResult({ cycle }));
  }));
  router.post('/phoenix/cycles/:id/fix', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    res.json(jsonResult({ cycle: await applyPhoenixFix(req.ctx.user!.id, req.params.id!, String(body.fix)) }));
  }));
  router.post('/phoenix/cycles/:id/suite', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    res.json(jsonResult({ cycle: await confirmPhoenixSuite(req.ctx.user!.id, req.params.id!, String(body.suite_result)) }));
  }));
  router.post('/phoenix/cycles/:id/pr', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    res.json(jsonResult({ cycle: await openPhoenixPr(req.ctx.user!.id, req.params.id!, String(body.pr_number)) }));
  }));
  router.get('/phoenix/cycles', requireAuth, asyncRoute(async (req, res) => {
    const { pipeline } = req.query as { pipeline?: string };
    res.json(jsonResult({ cycles: await listPhoenixCycles(req.ctx.user!.id, { pipeline }) }));
  }));
  router.get('/phoenix/cycles/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ cycle: await getPhoenixCycle(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/phoenix/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await phoenixReport(req.ctx.user!.id) }));
  }));

  // SELF-HEALING CI (#8)
  router.post('/ciheal/scans', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const outcome = await scanCiForHealing(req.ctx.user!.id, {
      diff: String(body.diff),
      signatures: body.signatures ?? [],
    });
    res.status(201).json(jsonResult(outcome));
  }));
  router.get('/ciheal/scans', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ scans: await listCiHealScans(req.ctx.user!.id) }));
  }));
  router.get('/ciheal/scans/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ scan: await getCiHealScan(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/ciheal/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await cishealReport(req.ctx.user!.id) }));
  }));

  // LAUNCH CAPTAIN (#4)
  router.post('/launch/releases', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const release = await planLaunchRelease(req.ctx.user!.id, {
      currentVersion: String(body.currentVersion),
      changes: body.changes ?? [],
    });
    res.status(201).json(jsonResult({ release }));
  }));
  router.post('/launch/releases/:id/deploy', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ release: await deployLaunchRelease(req.ctx.user!.id, req.params.id!) }));
  }));
  router.post('/launch/releases/:id/rollback', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    res.json(jsonResult({ release: await flagMetricsTank(req.ctx.user!.id, req.params.id!, String(body.reason)) }));
  }));
  router.get('/launch/releases', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ releases: await listLaunchReleases(req.ctx.user!.id) }));
  }));
  router.get('/launch/releases/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ release: await getLaunchRelease(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/launch/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await launchReport(req.ctx.user!.id) }));
  }));

  // AUTOPSY (#5)
  router.post('/autopsy/incidents', requireAuth, asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const incident = await runAutopsy(req.ctx.user!.id, {
      incident: String(body.incident),
      windowSeconds: body.windowSeconds === undefined ? undefined : Number(body.windowSeconds),
      suspects: body.suspects ?? [],
    });
    res.status(201).json(jsonResult({ incident }));
  }));
  router.post('/autopsy/incidents/:id/resolve', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ incident: await resolveAutopsy(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/autopsy/incidents', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ incidents: await listAutopsyIncidents(req.ctx.user!.id) }));
  }));
  router.get('/autopsy/incidents/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ incident: await getAutopsyIncident(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/autopsy/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await autopsyReport(req.ctx.user!.id) }));
  }));

  // ── Tranche M (Stage 91): THE SWARM (#2) ─────────────────────────────────
  router.post('/swarm/runs', requireAuth, asyncRoute(async (req, res) => {
    const batch = await launchSwarm(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ batch }));
  }));
  router.get('/swarm/runs', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ batches: await listSwarmBatches(req.ctx.user!.id) }));
  }));
  router.get('/swarm/runs/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ batch: await getSwarmBatch(req.ctx.user!.id, req.params.id!) }));
  }));

  // ── Tranche M (Stage 91): ZERO-INBOX MODE (#6) ───────────────────────────
  router.post('/zero-inbox/triage', requireAuth, asyncRoute(async (req, res) => {
    const digest = await runTriaging(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ digest }));
  }));
  router.get('/zero-inbox/digests', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ digests: await listZeroInboxDigests(req.ctx.user!.id) }));
  }));
  router.get('/zero-inbox/digests/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ digest: await getZeroInboxDigest(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/zero-inbox/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await inboxReport(req.ctx.user!.id) }));
  }));

  // ── Tranche M (Stage 91): NIGHT SHIFT (#7) ───────────────────────────────
  router.post('/night-shift/runs', requireAuth, asyncRoute(async (req, res) => {
    const run = await runNightShift(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ run }));
  }));
  router.get('/night-shift/runs', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ runs: await listNightShiftRuns(req.ctx.user!.id) }));
  }));
  router.get('/night-shift/runs/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await getNightShiftRun(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/night-shift/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await nightShiftReport(req.ctx.user!.id) }));
  }));

  // ── Tranche M (Stage 91): RELEASE COMMANDER (#9) ─────────────────────────
  router.post('/release-commander/runs', requireAuth, asyncRoute(async (req, res) => {
    const run = await planRelease(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ run }));
  }));
  router.post('/release-commander/runs/:id/freeze', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await freezeFeatures(req.ctx.user!.id, req.params.id!) }));
  }));
  router.post('/release-commander/runs/:id/cherry-pick', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await cherryPickCommit(req.ctx.user!.id, req.params.id!, req.body?.commit, req.body?.target) }));
  }));
  router.post('/release-commander/runs/:id/hotfix', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await laneHotfix(req.ctx.user!.id, req.params.id!, req.body?.lane) }));
  }));
  router.post('/release-commander/runs/:id/hotfix/:lane/approve', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await approveHotfixLane(req.ctx.user!.id, req.params.id!, req.params.lane!) }));
  }));
  router.post('/release-commander/runs/:id/rollback-drill', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await drillRollback(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/release-commander/runs', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ runs: await listReleaseRuns(req.ctx.user!.id) }));
  }));
  router.get('/release-commander/runs/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await getReleaseRun(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/release-commander/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await releaseReport(req.ctx.user!.id) }));
  }));

  // ── Tranche M (Stage 91): FIREWALL DRILL (#10) ───────────────────────────
  router.post('/firewall-drill/runs', requireAuth, asyncRoute(async (req, res) => {
    const run = await planDrill(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ run }));
  }));
  router.post('/firewall-drill/runs/:id/run', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await runDrill(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/firewall-drill/runs', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ runs: await listDrillRuns(req.ctx.user!.id) }));
  }));
  router.get('/firewall-drill/runs/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await getDrillRun(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/firewall-drill/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await drillReport(req.ctx.user!.id) }));
  }));

  // ── Tranche N (Stage 92): AUTO-DIVERGENCE (#12) ─────────────────────────
  router.post('/divergence/actions', requireAuth, asyncRoute(async (req, res) => {
    const session = await recordManualAction(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ session }));
  }));
  router.get('/divergence/actions', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ actions: await listManualActions(req.ctx.user!.id) }));
  }));
  router.post('/divergence/suggestions/:id/accept', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ session: await acceptSuggestion(req.ctx.user!.id, req.params.id!) }));
  }));
  router.post('/divergence/suggestions/:id/dismiss', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ session: await dismissSuggestion(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/divergence/suggestions', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ suggestions: await listSuggestions(req.ctx.user!.id) }));
  }));
  router.get('/divergence/suggestions/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ session: await getDivergenceSession(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/divergence/patterns', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ patterns: await learnedPatterns(req.ctx.user!.id) }));
  }));
  router.get('/divergence/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await divergenceReport(req.ctx.user!.id) }));
  }));

  // ── Tranche N (Stage 92): MIRROR WORLD (#15) ─────────────────────────────
  router.post('/mirror-world/runs', requireAuth, asyncRoute(async (req, res) => {
    const run = await runWhatIf(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ run }));
  }));
  router.get('/mirror-world/runs', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ runs: await listMirrorRuns(req.ctx.user!.id) }));
  }));
  router.get('/mirror-world/runs/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await getMirrorRun(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/mirror-world/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await mirrorWorldReport(req.ctx.user!.id) }));
  }));

  // ── Tranche N (Stage 92): TRIBUNAL (#18) ─────────────────────────────────
  router.post('/tribunal/hearings', requireAuth, asyncRoute(async (req, res) => {
    const hearing = await conveneTribunal(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ hearing }));
  }));
  router.get('/tribunal/hearings', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ hearings: await listHearings(req.ctx.user!.id) }));
  }));
  router.get('/tribunal/hearings/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ hearing: await getHearing(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/tribunal/lessons', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ lessons: await listTribunalLessons(req.ctx.user!.id) }));
  }));
  router.get('/tribunal/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await tribunalReport(req.ctx.user!.id) }));
  }));

  // ── Tranche O (Stage 93): ROOT CAUSE ORACLE (#19) ────────────────────────
  router.post('/root-cause/traces', requireAuth, asyncRoute(async (req, res) => {
    const trace = await analyzeSymptom(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ trace }));
  }));
  router.post('/root-cause/traces/:id/resolve', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ trace: await resolveTrace(req.ctx.user!.id, req.params.id!, req.body?.resolution) }));
  }));
  router.get('/root-cause/traces', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ traces: await listCausalChains(req.ctx.user!.id) }));
  }));
  router.get('/root-cause/traces/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ trace: await getCausalChain(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/root-cause/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await rootCauseReport(req.ctx.user!.id) }));
  }));

  // ── Tranche O (Stage 93): GHOST WRITER (#20) ─────────────────────────────
  router.post('/ghost-writer/writes', requireAuth, asyncRoute(async (req, res) => {
    const write = await writeGhost(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ write }));
  }));
  router.post('/ghost-writer/writes/:id/benchmark', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ write: await benchmarkGhost(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.post('/ghost-writer/writes/:id/ship', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ write: await shipGhost(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/ghost-writer/writes', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ writes: await listGhostWrites(req.ctx.user!.id) }));
  }));
  router.get('/ghost-writer/writes/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ write: await getGhostWrite(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/ghost-writer/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await ghostWriterReport(req.ctx.user!.id) }));
  }));

  // ── Tranche O (Stage 93): TIME TRAVELER (#21) ────────────────────────────
  router.post('/time-travel/snapshots', requireAuth, asyncRoute(async (req, res) => {
    const snapshot = await reconstructHistory(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ snapshot }));
  }));
  router.get('/time-travel/snapshots', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ snapshots: await listSnapshots(req.ctx.user!.id) }));
  }));
  router.get('/time-travel/snapshots/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ snapshot: await getSnapshot(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/time-travel/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await timeTravelReport(req.ctx.user!.id) }));
  }));

  // ── Tranche O (Stage 93): CODE COURT (#22) ───────────────────────────────
  router.post('/code-court/cases', requireAuth, asyncRoute(async (req, res) => {
    const court = await holdCourt(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ court }));
  }));
  router.get('/code-court/cases', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ cases: await listCourtCases(req.ctx.user!.id) }));
  }));
  router.get('/code-court/cases/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ court: await getCourtCase(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/code-court/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await codeCourtReport(req.ctx.user!.id) }));
  }));

  // ── Tranche O (Stage 93): SILENCE BREAKER (#23) ──────────────────────────
  router.post('/silence-breaker/stalls', requireAuth, asyncRoute(async (req, res) => {
    const stall = await diagnoseStall(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ stall }));
  }));
  router.post('/silence-breaker/stalls/:id/resolve', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ stall: await resolveStall(req.ctx.user!.id, req.params.id!, req.body?.resolution) }));
  }));
  router.get('/silence-breaker/stalls', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ stalls: await listStallBreakouts(req.ctx.user!.id) }));
  }));
  router.get('/silence-breaker/stalls/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ stall: await getStallBreakout(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/silence-breaker/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await silenceBreakerReport(req.ctx.user!.id) }));
  }));

  router.post('/institutional-transfer/exports', requireAuth, asyncRoute(async (req, res) => {
    const exp = await exportBrain(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ transfer: exp }));
  }));
  router.post('/institutional-transfer/exports/:id/package', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ transfer: await packageExport(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/institutional-transfer/exports', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ transfers: await listInstitutionalExports(req.ctx.user!.id) }));
  }));
  router.get('/institutional-transfer/exports/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ transfer: await getInstitutionalExport(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/institutional-transfer/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await institutionalReport(req.ctx.user!.id) }));
  }));

  router.post('/context-compressor/compressions', requireAuth, asyncRoute(async (req, res) => {
    const comp = await compressContext(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ compression: comp }));
  }));
  router.get('/context-compressor/compressions', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ compressions: await listCompressions(req.ctx.user!.id) }));
  }));
  router.get('/context-compressor/compressions/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ compression: await getCompression(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/context-compressor/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await contextCompressorReport(req.ctx.user!.id) }));
  }));

  router.post('/concept-gap/scans', requireAuth, asyncRoute(async (req, res) => {
    const scan = await runConceptScan(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ scan }));
  }));
  router.post('/concept-gap/scans/:id/unify', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ scan: await unifyConcept(req.ctx.user!.id, req.params.id!) }));
  }));
  router.post('/concept-gap/scans/:id/resolve', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ scan: await resolveConceptGap(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/concept-gap/scans', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ scans: await listConceptScans(req.ctx.user!.id) }));
  }));
  router.get('/concept-gap/scans/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ scan: await getConceptScan(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/concept-gap/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await conceptGapReport(req.ctx.user!.id) }));
  }));

  router.post('/negotiator/drafts', requireAuth, asyncRoute(async (req, res) => {
    const draft = await draftNegotiation(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ draft }));
  }));
  router.post('/negotiator/drafts/:id/resolve', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ draft: await resolveNegotiation(req.ctx.user!.id, req.params.id!, req.body?.choice) }));
  }));
  router.get('/negotiator/drafts', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ drafts: await listNegotiationDrafts(req.ctx.user!.id) }));
  }));
  router.get('/negotiator/drafts/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ draft: await getNegotiationDraft(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/negotiator/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await negotiatorReport(req.ctx.user!.id) }));
  }));

  router.post('/memory-export/exports', requireAuth, asyncRoute(async (req, res) => {
    const exp = await exportMemoryGraph(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ memory_export: exp }));
  }));
  router.post('/memory-export/exports/:id/query', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ ...(await queryExport(req.ctx.user!.id, req.params.id!, req.body?.query)) }));
  }));
  router.get('/memory-export/exports', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ memory_exports: await listMemoryExports(req.ctx.user!.id) }));
  }));
  router.get('/memory-export/exports/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ memory_export: await getMemoryExport(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/memory-export/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await memoryPortabilityReport(req.ctx.user!.id) }));
  }));

  router.post('/regression-time-machine/timelines', requireAuth, asyncRoute(async (req, res) => {
    const timeline = await openTimeline(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ timeline }));
  }));
  router.post('/regression-time-machine/timelines/:id/regressions', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ timeline: await addRegression(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/regression-time-machine/timelines', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ timelines: await listRegressionTimelines(req.ctx.user!.id) }));
  }));
  router.get('/regression-time-machine/timelines/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ timeline: await getRegressionTimeline(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/regression-time-machine/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await regressionReport(req.ctx.user!.id) }));
  }));

  router.post('/knowledge-diffusion/lessons', requireAuth, asyncRoute(async (req, res) => {
    const lesson = await seedLesson(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ lesson }));
  }));
  router.post('/knowledge-diffusion/lessons/:id/diffuse', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ lesson: await diffuseLesson(req.ctx.user!.id, req.params.id!) }));
  }));
  router.post('/knowledge-diffusion/retrieve', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult(await retrieveLesson(req.ctx.user!.id, req.body ?? {})));
  }));
  router.get('/knowledge-diffusion/lessons', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ lessons: await listLessons(req.ctx.user!.id) }));
  }));
  router.get('/knowledge-diffusion/lessons/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ lesson: await getLesson(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/knowledge-diffusion/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await knowledgeReport(req.ctx.user!.id) }));
  }));

  router.post('/fusion-score/samples', requireAuth, asyncRoute(async (req, res) => {
    const sample = await recordFusionSample(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ sample }));
  }));
  router.get('/fusion-score/samples', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ samples: await listFusionSamples(req.ctx.user!.id) }));
  }));
  router.get('/fusion-score/samples/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ sample: await getFusionSample(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/fusion-score/trend', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ trend: await fusionTrend(req.ctx.user!.id) }));
  }));
  router.get('/fusion-score/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await fusionReport(req.ctx.user!.id) }));
  }));

  router.post('/rubber-duck/sessions', requireAuth, asyncRoute(async (req, res) => {
    const session = await startDuckSession(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ session }));
  }));
  router.post('/rubber-duck/sessions/:id/found', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ session: await foundIt(req.ctx.user!.id, req.params.id!, req.body?.resolution) }));
  }));
  router.get('/rubber-duck/sessions', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ sessions: await listDuckSessions(req.ctx.user!.id) }));
  }));
  router.get('/rubber-duck/sessions/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ session: await getDuckSession(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/rubber-duck/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await duckReport(req.ctx.user!.id) }));
  }));

  router.post('/code-translator/translations', requireAuth, asyncRoute(async (req, res) => {
    const translation = await translateCode(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ translation }));
  }));
  router.get('/code-translator/translations', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ translations: await listCodeTranslations(req.ctx.user!.id) }));
  }));
  router.get('/code-translator/translations/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ translation: await getCodeTranslation(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/code-translator/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await codeTranslatorReport(req.ctx.user!.id) }));
  }));

  router.post('/focus-forge/sessions', requireAuth, asyncRoute(async (req, res) => {
    const session = await forgeFocusSession(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ session }));
  }));
  router.post('/focus-forge/sessions/:id/silence', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ session: await silenceFocus(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.post('/focus-forge/sessions/:id/breach', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ session: await breachFocus(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.post('/focus-forge/sessions/:id/digest', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ session: await digestFocus(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/focus-forge/sessions', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ sessions: await listFocusSessions(req.ctx.user!.id) }));
  }));
  router.get('/focus-forge/sessions/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ session: await getFocusSession(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/focus-forge/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await focusReport(req.ctx.user!.id) }));
  }));

  router.post('/clone-killer/fragments', requireAuth, asyncRoute(async (req, res) => {
    const fragment = await registerFragment(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ fragment }));
  }));
  router.post('/clone-killer/fragments/:id/abstract', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ fragment: await proposeAbstraction(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/clone-killer/fragments', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ fragments: await listCloneFragments(req.ctx.user!.id) }));
  }));
  router.get('/clone-killer/fragments/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ fragment: await getCloneFragment(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/clone-killer/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await cloneKillerReport(req.ctx.user!.id) }));
  }));

  router.post('/error-translator/translations', requireAuth, asyncRoute(async (req, res) => {
    const translation = await translateErrorText(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ translation }));
  }));
  router.get('/error-translator/translations', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ translations: await listErrorTranslations(req.ctx.user!.id) }));
  }));
  router.get('/error-translator/translations/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ translation: await getErrorTranslation(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/error-translator/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await errorTranslatorReport(req.ctx.user!.id) }));
  }));

  router.post('/pair-mirror/hints', requireAuth, asyncRoute(async (req, res) => {
    const hint = await mirrorHint(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ hint }));
  }));
  router.post('/pair-mirror/hints/:id/ack', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ hint: await acknowledgeHint(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/pair-mirror/hints', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ hints: await listPairHints(req.ctx.user!.id) }));
  }));
  router.get('/pair-mirror/hints/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ hint: await getPairHint(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/pair-mirror/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await pairMirrorReport(req.ctx.user!.id) }));
  }));

  router.post('/meeting-to-code/extractions', requireAuth, asyncRoute(async (req, res) => {
    const extraction = await extractMeeting(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ extraction }));
  }));
  router.get('/meeting-to-code/extractions', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ extractions: await listMeetingExtractions(req.ctx.user!.id) }));
  }));
  router.get('/meeting-to-code/extractions/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ extraction: await getMeetingExtraction(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/meeting-to-code/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await meetingToCodeReport(req.ctx.user!.id) }));
  }));

  router.post('/focus-guard/sessions', requireAuth, asyncRoute(async (req, res) => {
    const session = await guardDeepWork(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ session }));
  }));
  router.post('/focus-guard/sessions/:id/ask', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult(await holdQuestion(req.ctx.user!.id, req.params.id!, req.body ?? {})));
  }));
  router.post('/focus-guard/sessions/:id/surface', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ session: await surfaceGuard(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/focus-guard/sessions', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ sessions: await listFocusGuards(req.ctx.user!.id) }));
  }));
  router.get('/focus-guard/sessions/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ session: await getFocusGuard(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/focus-guard/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await focusGuardReport(req.ctx.user!.id) }));
  }));

  router.post('/voice-to-task/dictations', requireAuth, asyncRoute(async (req, res) => {
    const task = await dictateTask(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ task }));
  }));
  router.post('/voice-to-task/dictations/:id/start', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ task: await startVoiceTask(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/voice-to-task/dictations', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ tasks: await listVoiceTasks(req.ctx.user!.id) }));
  }));
  router.get('/voice-to-task/dictations/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ task: await getVoiceTask(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/voice-to-task/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await voiceTaskReport(req.ctx.user!.id) }));
  }));

  router.post('/requirement-xray/scans', requireAuth, asyncRoute(async (req, res) => {
    const scan = await xrayRequirement(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ scan }));
  }));
  router.get('/requirement-xray/scans', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ scans: await listXrays(req.ctx.user!.id) }));
  }));
  router.get('/requirement-xray/scans/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ scan: await getXray(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/requirement-xray/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await requirementXrayReport(req.ctx.user!.id) }));
  }));

  router.post('/scope-bouncer/sessions', requireAuth, asyncRoute(async (req, res) => {
    const session = await openPrScope(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ session }));
  }));
  router.post('/scope-bouncer/sessions/:id/check', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ session: await checkScope(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.post('/scope-bouncer/sessions/:id/settle', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ session: await settleScope(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/scope-bouncer/sessions', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ sessions: await listScopeSessions(req.ctx.user!.id) }));
  }));
  router.get('/scope-bouncer/sessions/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ session: await getScopeSession(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/scope-bouncer/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await scopeBouncerReport(req.ctx.user!.id) }));
  }));

  router.post('/user-story-forge/stories', requireAuth, asyncRoute(async (req, res) => {
    const story = await forgeStoryRun(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ story }));
  }));
  router.get('/user-story-forge/stories', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ stories: await listStories(req.ctx.user!.id) }));
  }));
  router.get('/user-story-forge/stories/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ story: await getStory(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/user-story-forge/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await userStoryForgeReport(req.ctx.user!.id) }));
  }));

  router.post('/impact-radar/readings', requireAuth, asyncRoute(async (req, res) => {
    const reading = await reportImpact(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ reading }));
  }));
  router.get('/impact-radar/readings', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ readings: await listImpactReadings(req.ctx.user!.id) }));
  }));
  router.get('/impact-radar/readings/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ reading: await getImpactReading(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/impact-radar/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await radarReport(req.ctx.user!.id) }));
  }));

  router.post('/churn-detective/events', requireAuth, asyncRoute(async (req, res) => {
    const event = await reportChurnEvent(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ event }));
  }));
  router.post('/churn-detective/events/:id/draft', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ event: await draftChurnFix(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/churn-detective/events', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ events: await listChurnEvents(req.ctx.user!.id) }));
  }));
  router.get('/churn-detective/events/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ event: await getChurnEvent(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/churn-detective/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await churnReport(req.ctx.user!.id) }));
  }));

  router.post('/onboarding-simulator/sims', requireAuth, asyncRoute(async (req, res) => {
    const sim = await startOnboardingSim(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ sim }));
  }));
  router.post('/onboarding-simulator/sims/:id/complete', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ sim: await completeSim(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/onboarding-simulator/sims', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ sims: await listOnboardingSims(req.ctx.user!.id) }));
  }));
  router.get('/onboarding-simulator/sims/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ sim: await getOnboardingSim(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/onboarding-simulator/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await onboardingSimReport(req.ctx.user!.id) }));
  }));

  router.post('/zero-to-prod/runs', requireAuth, asyncRoute(async (req, res) => {
    const run = await startProdRun(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ run }));
  }));
  router.post('/zero-to-prod/runs/:id/advance', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await advanceProdStage(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/zero-to-prod/runs', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ runs: await listProdRuns(req.ctx.user!.id) }));
  }));
  router.get('/zero-to-prod/runs/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await getProdRun(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/zero-to-prod/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await prodRunReport(req.ctx.user!.id) }));
  }));

  router.post('/policy-copilot/policies', requireAuth, asyncRoute(async (req, res) => {
    const policy = await writePolicy(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ policy }));
  }));
  router.post('/policy-copilot/policies/:id/activate', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ policy: await activatePolicy(req.ctx.user!.id, req.params.id!) }));
  }));
  router.post('/policy-copilot/policies/:id/suspend', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ policy: await suspendPolicy(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/policy-copilot/policies', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ policies: await listPolicies(req.ctx.user!.id) }));
  }));
  router.get('/policy-copilot/policies/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ policy: await getPolicy(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/policy-copilot/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await policyCopilotReport(req.ctx.user!.id) }));
  }));

  router.post('/challenge-mode/challenges', requireAuth, asyncRoute(async (req, res) => {
    const challenge = await startChallenge(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ challenge }));
  }));
  router.post('/challenge-mode/challenges/:id/build', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ challenge: await buildChallengeTrack(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.post('/challenge-mode/challenges/:id/defend', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ challenge: await defendDecisions(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/challenge-mode/challenges', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ challenges: await listChallenges(req.ctx.user!.id) }));
  }));
  router.get('/challenge-mode/challenges/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ challenge: await getChallenge(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/challenge-mode/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await challengeReport(req.ctx.user!.id) }));
  }));

  router.post('/ask-codebase-live/shares', requireAuth, asyncRoute(async (req, res) => {
    const share = await createCodebaseLink(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ share }));
  }));
  router.post('/ask-codebase-live/shares/:id/expire', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ share: await expireShare(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/ask-codebase-live/shares', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ shares: await listShares(req.ctx.user!.id) }));
  }));
  router.get('/ask-codebase-live/shares/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ share: await getShare(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/ask-codebase-live/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await codebaseShareReport(req.ctx.user!.id) }));
  }));
  router.post('/ask-codebase-live/public/:token/answer', asyncRoute(async (req, res) => {
    res.json(jsonResult({ answer: await answerPublicQuestion(req.params.token!, req.body?.question ?? '') }));
  }));

  router.post('/cost-badge/estimates', requireAuth, asyncRoute(async (req, res) => {
    const estimate = await estimateCost(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ estimate }));
  }));
  router.get('/cost-badge/estimates', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ estimates: await listCostEstimates(req.ctx.user!.id) }));
  }));
  router.get('/cost-badge/estimates/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ estimate: await getCostEstimate(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/cost-badge/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await costBadgeReport(req.ctx.user!.id) }));
  }));

  router.post('/cost-thermometer/readings', requireAuth, asyncRoute(async (req, res) => {
    const reading = await takeThermometerReading(req.ctx.user!.id);
    res.status(201).json(jsonResult({ reading }));
  }));
  router.get('/cost-thermometer/readings', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ readings: await listReadings(req.ctx.user!.id) }));
  }));
  router.get('/cost-thermometer/readings/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ reading: await getThermometerReading(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/cost-thermometer/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await thermometerReport(req.ctx.user!.id) }));
  }));

  router.post('/drift-police/diffs', requireAuth, asyncRoute(async (req, res) => {
    const report = await diffState(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ report }));
  }));
  router.post('/drift-police/diffs/:id/reconcile', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await reconcileDrift(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.post('/drift-police/diffs/:id/file-fix', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await fileDriftFix(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/drift-police/diffs', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ reports: await listDriftReports(req.ctx.user!.id) }));
  }));
  router.get('/drift-police/diffs/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await getDriftReport(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/drift-police/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await driftReportSummary(req.ctx.user!.id) }));
  }));

  router.post('/capacity-oracle/forecasts', requireAuth, asyncRoute(async (req, res) => {
    const forecast = await forecastExhaustion(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ forecast }));
  }));
  router.get('/capacity-oracle/forecasts', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ forecasts: await listCapacityForecasts(req.ctx.user!.id) }));
  }));
  router.get('/capacity-oracle/forecasts/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ forecast: await getCapacityForecast(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/capacity-oracle/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await capacityReport(req.ctx.user!.id) }));
  }));

  router.post('/environment-cloner/clones', requireAuth, asyncRoute(async (req, res) => {
    const clone = await cloneEnvironment(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ clone }));
  }));
  router.get('/environment-cloner/clones', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ clones: await listEnvironmentClones(req.ctx.user!.id) }));
  }));
  router.get('/environment-cloner/clones/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ clone: await getEnvironmentClone(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/environment-cloner/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await environmentCloneReport(req.ctx.user!.id) }));
  }));

  router.post('/runbook-runner/runs', requireAuth, asyncRoute(async (req, res) => {
    const run = await startRunbook(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ run }));
  }));
  router.post('/runbook-runner/runs/:id/steps', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await executeStep(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.post('/runbook-runner/runs/:id/resolve', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await resolveRunbook(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/runbook-runner/runs', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ runs: await listRunbooks(req.ctx.user!.id) }));
  }));
  router.get('/runbook-runner/runs/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await getRunbook(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/runbook-runner/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await runbookReport(req.ctx.user!.id) }));
  }));

  router.post('/backup-reality-check/checks', requireAuth, asyncRoute(async (req, res) => {
    const check = await scheduleRestoreCheck(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ check }));
  }));
  router.post('/backup-reality-check/checks/:id/verify', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ check: await verifyRestore(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/backup-reality-check/checks', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ checks: await listBackupChecks(req.ctx.user!.id) }));
  }));
  router.get('/backup-reality-check/checks/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ check: await getBackupCheck(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/backup-reality-check/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await backupRealityReport(req.ctx.user!.id) }));
  }));

  router.post('/network-xray/edges', requireAuth, asyncRoute(async (req, res) => {
    const edge = await recordServiceCall(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ edge }));
  }));
  router.get('/network-xray/edges', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ edges: await listNetworkEdges(req.ctx.user!.id) }));
  }));
  router.get('/network-xray/edges/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ edge: await getNetworkEdge(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/network-xray/map', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ map: await getNetworkMap(req.ctx.user!.id) }));
  }));
  router.get('/network-xray/blast-radius/:node', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ blast: await blastRadius(req.ctx.user!.id, req.params.node!) }));
  }));
  router.get('/network-xray/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await networkXrayReport(req.ctx.user!.id) }));
  }));

  router.post('/infra-architect/plans', requireAuth, asyncRoute(async (req, res) => {
    const plan = await createInfraPlan(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ plan }));
  }));
  router.post('/infra-architect/plans/:id/validate', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ plan: await validatePlan(req.ctx.user!.id, req.params.id!) }));
  }));
  router.post('/infra-architect/plans/:id/apply', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ plan: await applyPlan(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/infra-architect/plans', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ plans: await listInfraPlans(req.ctx.user!.id) }));
  }));
  router.get('/infra-architect/plans/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ plan: await getInfraPlan(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/infra-architect/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await infraArchitectReport(req.ctx.user!.id) }));
  }));

  router.post('/regression-radar/entries', requireAuth, asyncRoute(async (req, res) => {
    const entry = await logRegression(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ entry }));
  }));
  router.post('/regression-radar/entries/:id/fix-worked', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ entry: await markFixWorked(req.ctx.user!.id, req.params.id!, req.body?.fix_description ?? '') }));
  }));
  router.get('/regression-radar/entries', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ entries: await listRegressionEntries(req.ctx.user!.id) }));
  }));
  router.get('/regression-radar/entries/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ entry: await getRegressionEntry(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/regression-radar/modules/:module', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ entries: await getRegressionsForModule(req.ctx.user!.id, req.params.module!) }));
  }));
  router.get('/regression-radar/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await regressionRadarReport(req.ctx.user!.id) }));
  }));

  // ------------------------------------------------- INCIDENT ORCHESTRATOR (#97)
  router.post('/incident-orchestrator/runs', requireAuth, asyncRoute(async (req, res) => {
    const run = await triggerIncident(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ run }));
  }));
  router.post('/incident-orchestrator/runs/:id/postmortem', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await draftPostmortem(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.post('/incident-orchestrator/runs/:id/fix', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await proposeIncidentFix(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/incident-orchestrator/runs', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ runs: await listIncidentOrchRuns(req.ctx.user!.id) }));
  }));
  router.get('/incident-orchestrator/runs/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await getIncidentOrchRun(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/incident-orchestrator/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await incidentOrchReport(req.ctx.user!.id) }));
  }));

  // ------------------------------------------------- NETWORK POLICY ENFORCER (#98)
  router.post('/network-policy/policies', requireAuth, asyncRoute(async (req, res) => {
    const policy = await createNetworkPolicy(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ policy }));
  }));
  router.post('/network-policy/policies/:id/audit', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ policy: await auditNetworkCall(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/network-policy/policies', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ policies: await listNetworkPolicies(req.ctx.user!.id) }));
  }));
  router.get('/network-policy/policies/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ policy: await getNetworkPolicy(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/network-policy/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await networkPolicyReport(req.ctx.user!.id) }));
  }));

  // ----------------------------------------------------- FRAMEWORK BRIDGE (#99)
  router.post('/framework-bridge/bridges', requireAuth, asyncRoute(async (req, res) => {
    const bridge = await planFrameworkBridge(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ bridge }));
  }));
  router.post('/framework-bridge/bridges/:id/apply', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ bridge: await applyFrameworkStep(req.ctx.user!.id, req.params.id!) }));
  }));
  router.post('/framework-bridge/bridges/:id/verify', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ bridge: await verifyFrameworkBridge(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/framework-bridge/bridges', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ bridges: await listFrameworkBridges(req.ctx.user!.id) }));
  }));
  router.get('/framework-bridge/bridges/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ bridge: await getFrameworkBridge(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/framework-bridge/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await frameworkBridgeReport(req.ctx.user!.id) }));
  }));

  // --------------------------------------------------------- LANGUAGE FERRY (#100)
  router.post('/language-ferry/ferries', requireAuth, asyncRoute(async (req, res) => {
    const ferry = await planFerry(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ ferry }));
  }));
  router.post('/language-ferry/ferries/:id/verify', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ ferry: await verifyFerryRun(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/language-ferry/ferries', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ ferries: await listLanguageFerries(req.ctx.user!.id) }));
  }));
  router.get('/language-ferry/ferries/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ ferry: await getLanguageFerry(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/language-ferry/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await languageFerryReport(req.ctx.user!.id) }));
  }));

  // ----------------------------------------------------- MONOLITH SURGEON (#101)
  router.post('/monolith-surgeon/surgeries', requireAuth, asyncRoute(async (req, res) => {
    const surgery = await planCut(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ surgery }));
  }));
  router.post('/monolith-surgeon/surgeries/:id/extract', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ surgery: await extractService(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/monolith-surgeon/surgeries', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ surgeries: await listMonolithSurgeries(req.ctx.user!.id) }));
  }));
  router.get('/monolith-surgeon/surgeries/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ surgery: await getMonolithSurgeon(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/monolith-surgeon/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await monolithSurgeonReport(req.ctx.user!.id) }));
  }));

  // ------------------------------------------------------ DB BRAIN SURGEON (#102)
  router.post('/db-brain-surgeon/cycles', requireAuth, asyncRoute(async (req, res) => {
    const cycle = await planCycle(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ cycle }));
  }));
  router.post('/db-brain-surgeon/cycles/:id/dual-write', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ cycle: await startDualWrite(req.ctx.user!.id, req.params.id!) }));
  }));
  router.post('/db-brain-surgeon/cycles/:id/backfill', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ cycle: await verifyBackfill(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.post('/db-brain-surgeon/cycles/:id/contract', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ cycle: await contractDbCycle(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/db-brain-surgeon/cycles', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ cycles: await listDbBrainSurgeries(req.ctx.user!.id) }));
  }));
  router.get('/db-brain-surgeon/cycles/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ cycle: await getDbBrainSurgery(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/db-brain-surgeon/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await dbBrainSurgeonReport(req.ctx.user!.id) }));
  }));

  // ---------------------------------------------------------- TEST CONVERTER (#103)
  router.post('/test-converter/conversions', requireAuth, asyncRoute(async (req, res) => {
    const conversion = await planConversion(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ conversion }));
  }));
  router.post('/test-converter/conversions/:id/verify', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ conversion: await verifyConversion(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/test-converter/conversions', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ conversions: await listTestConversions(req.ctx.user!.id) }));
  }));
  router.get('/test-converter/conversions/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ conversion: await getTestConversion(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/test-converter/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await testConverterReport(req.ctx.user!.id) }));
  }));

  // ---------------------------------------------------------- LEGACY WRAPPER (#104)
  router.post('/legacy-wrapper/wrappers', requireAuth, asyncRoute(async (req, res) => {
    const wrapper = await createLegacyWrapper(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ wrapper }));
  }));
  router.get('/legacy-wrapper/wrappers', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ wrappers: await listLegacyWrappers(req.ctx.user!.id) }));
  }));
  router.get('/legacy-wrapper/wrappers/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ wrapper: await getLegacyWrapper(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/legacy-wrapper/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await legacyWrapperReport(req.ctx.user!.id) }));
  }));

  // ------------------------------------------------------- DEPENDENCY BRIDGE (#105)
  router.post('/dependency-bridge/bridges', requireAuth, asyncRoute(async (req, res) => {
    const bridge = await planDependencyBridge(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ bridge }));
  }));
  router.post('/dependency-bridge/bridges/:id/verify', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ bridge: await verifyDependencyBridge(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/dependency-bridge/bridges', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ bridges: await listDependencyBridges(req.ctx.user!.id) }));
  }));
  router.get('/dependency-bridge/bridges/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ bridge: await getDependencyBridge(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/dependency-bridge/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await dependencyBridgeReport(req.ctx.user!.id) }));
  }));

  // --------------------------------------------------- PERFORMANCE MIGRATION (#106)
  router.post('/performance-migration/migrations', requireAuth, asyncRoute(async (req, res) => {
    const migration = await planMigration(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ migration }));
  }));
  router.post('/performance-migration/migrations/:id/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ migration: await reportMigration(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/performance-migration/migrations', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ migrations: await listPerformanceMigrations(req.ctx.user!.id) }));
  }));
  router.get('/performance-migration/migrations/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ migration: await getPerformanceMigration(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/performance-migration/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await performanceMigrationReport(req.ctx.user!.id) }));
  }));

  // ------------------------------------------------- SCHEMA MIGRATION WIZARD (#107)
  router.post('/schema-migration-wizard/migrations', requireAuth, asyncRoute(async (req, res) => {
    const migration = await createSchemaMigration(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ migration }));
  }));
  router.post('/schema-migration-wizard/migrations/:id/expand', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ migration: await startExpansion(req.ctx.user!.id, req.params.id!) }));
  }));
  router.post('/schema-migration-wizard/migrations/:id/step', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ migration: await completeStep(req.ctx.user!.id, req.params.id!) }));
  }));
  router.post('/schema-migration-wizard/migrations/:id/rollback', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ migration: await rollbackMigration(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/schema-migration-wizard/migrations', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ migrations: await listSchemaMigrations(req.ctx.user!.id) }));
  }));
  router.get('/schema-migration-wizard/migrations/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ migration: await getSchemaMigration(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/schema-migration-wizard/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await schemaMigrationReport(req.ctx.user!.id) }));
  }));

  // ----------------------------------------------------- API VERSION BRIDGE (#108)
  router.post('/api-version-bridge/bridges', requireAuth, asyncRoute(async (req, res) => {
    const bridge = await createApiBridge(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ bridge }));
  }));
  router.post('/api-version-bridge/bridges/:id/deprecate', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ bridge: await deprecateVersion(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/api-version-bridge/bridges', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ bridges: await listApiBridges(req.ctx.user!.id) }));
  }));
  router.get('/api-version-bridge/bridges/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ bridge: await getApiBridge(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/api-version-bridge/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await apiBridgeReport(req.ctx.user!.id) }));
  }));

  // ---------------------------------------------- DATA MIGRATION ORCHESTRATOR (#109)
  router.post('/data-migration-orchestrator/migrations', requireAuth, asyncRoute(async (req, res) => {
    const migration = await scheduleDataMigration(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ migration }));
  }));
  router.post('/data-migration-orchestrator/migrations/:id/sample', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ migration: await sampleMigration(req.ctx.user!.id, req.params.id!) }));
  }));
  router.post('/data-migration-orchestrator/migrations/:id/run', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ migration: await runMigration(req.ctx.user!.id, req.params.id!, num(req.body?.rowsAffected) ?? 0) }));
  }));
  router.post('/data-migration-orchestrator/migrations/:id/verify', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ migration: await verifyMigration(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/data-migration-orchestrator/migrations', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ migrations: await listDataMigrations(req.ctx.user!.id) }));
  }));
  router.get('/data-migration-orchestrator/migrations/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ migration: await getDataMigration(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/data-migration-orchestrator/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await dataMigrationReport(req.ctx.user!.id) }));
  }));

  // ------------------------------------------------ CONFIGURATION MIGRATION (#110)
  router.post('/configuration-migration/migrations', requireAuth, asyncRoute(async (req, res) => {
    const migration = await startConfigMigration(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ migration }));
  }));
  router.post('/configuration-migration/migrations/:id/traffic', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ migration: await advanceTrafficSplit(req.ctx.user!.id, req.params.id!, num(req.body?.pct) ?? 0) }));
  }));
  router.post('/configuration-migration/migrations/:id/complete', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ migration: await completeConfigMigration(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/configuration-migration/migrations', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ migrations: await listConfigMigrations(req.ctx.user!.id) }));
  }));
  router.get('/configuration-migration/migrations/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ migration: await getConfigMigration(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/configuration-migration/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await configMigrationReport(req.ctx.user!.id) }));
  }));

  // ----------------------------------------------------------- DESIGN POLICE (#111)
  router.post('/design-police/reports', requireAuth, asyncRoute(async (req, res) => {
    const report = await flagDesignViolation(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ report }));
  }));
  router.post('/design-police/reports/:id/fix', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await fixViolation(req.ctx.user!.id, req.params.id!) }));
  }));
  router.post('/design-police/reports/:id/ignore', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await ignoreViolation(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/design-police/reports', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ reports: await listDesignReports(req.ctx.user!.id) }));
  }));
  router.get('/design-police/reports/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await getDesignReport(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/design-police/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await designPoliceReport(req.ctx.user!.id) }));
  }));

  // --------------------------------------------------- RESPAWN STATE MATRIX (#112)
  router.post('/respawn-state-matrix/runs', requireAuth, asyncRoute(async (req, res) => {
    const run = await startStateMatrixRun(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ run }));
  }));
  router.post('/respawn-state-matrix/runs/:id/complete', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await completeStateMatrixRun(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/respawn-state-matrix/runs', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ runs: await listStateMatrixRuns(req.ctx.user!.id) }));
  }));
  router.get('/respawn-state-matrix/runs/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await getStateMatrixRun(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/respawn-state-matrix/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await stateMatrixReport(req.ctx.user!.id) }));
  }));

  // -------------------------------------------------------- PIXEL DIFF JUDGE (#113)
  router.post('/pixel-diff-judge/diffs', requireAuth, asyncRoute(async (req, res) => {
    const diff = await submitPixelDiff(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ diff }));
  }));
  router.get('/pixel-diff-judge/diffs', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ diffs: await listPixelDiffs(req.ctx.user!.id) }));
  }));
  router.get('/pixel-diff-judge/diffs/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ diff: await getPixelDiff(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/pixel-diff-judge/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await pixelDiffReport(req.ctx.user!.id) }));
  }));

  // ------------------------------------------------------------ MOTION DOCTOR (#114)
  router.post('/motion-doctor/audits', requireAuth, asyncRoute(async (req, res) => {
    const audit = await auditMotion(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ audit }));
  }));
  router.get('/motion-doctor/audits', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ audits: await listMotionAudits(req.ctx.user!.id) }));
  }));
  router.get('/motion-doctor/audits/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ audit: await getMotionAudit(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/motion-doctor/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await motionDoctorReport(req.ctx.user!.id) }));
  }));

  // ----------------------------------------------------------- A11Y AUTOPILOT (#115)
  router.post('/a11y-autopilot/runs', requireAuth, asyncRoute(async (req, res) => {
    const run = await startA11yRun(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ run }));
  }));
  router.post('/a11y-autopilot/runs/:id/issues', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await fileA11yIssue(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/a11y-autopilot/runs', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ runs: await listA11yRuns(req.ctx.user!.id) }));
  }));
  router.get('/a11y-autopilot/runs/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await getA11yRun(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/a11y-autopilot/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await a11yReport(req.ctx.user!.id) }));
  }));

  // ---------------------------------------------------------- LOCALIZATION FORGE (#116)
  router.post('/localization-forge/scans', requireAuth, asyncRoute(async (req, res) => {
    const scan = await startLocalizationScan(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ scan }));
  }));
  router.get('/localization-forge/scans', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ scans: await listLocalizationScans(req.ctx.user!.id) }));
  }));
  router.get('/localization-forge/scans/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ scan: await getLocalizationScan(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/localization-forge/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await localizationForgeReport(req.ctx.user!.id) }));
  }));

  // -------------------------------------------------------- COMPONENT GRAVEYARD (#117)
  router.post('/component-graveyard/entries', requireAuth, asyncRoute(async (req, res) => {
    const entry = await createGraveyardEntry(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ entry }));
  }));
  router.post('/component-graveyard/entries/:id/remove', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ entry: await removeComponent(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/component-graveyard/entries', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ entries: await listGraveyardEntries(req.ctx.user!.id) }));
  }));
  router.get('/component-graveyard/entries/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ entry: await getGraveyardEntry(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/component-graveyard/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await componentGraveyardReport(req.ctx.user!.id) }));
  }));

  // ----------------------------------------------------------- RESPONSIVE FORGE (#118)
  router.post('/responsive-forge/generations', requireAuth, asyncRoute(async (req, res) => {
    const generation = await generateResponsive(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ generation }));
  }));
  router.get('/responsive-forge/generations', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ generations: await listResponsiveGenerations(req.ctx.user!.id) }));
  }));
  router.get('/responsive-forge/generations/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ generation: await getResponsiveGeneration(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/responsive-forge/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await responsiveForgeReport(req.ctx.user!.id) }));
  }));

  // ---------------------------------------------------------- INTERACTION DEFINER (#119)
  router.post('/interaction-definer/specs', requireAuth, asyncRoute(async (req, res) => {
    const spec = await defineInteraction(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ spec }));
  }));
  router.get('/interaction-definer/specs', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ specs: await listInteractionSpecs(req.ctx.user!.id) }));
  }));
  router.get('/interaction-definer/specs/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ spec: await getInteractionSpec(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/interaction-definer/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await interactionDefinerReport(req.ctx.user!.id) }));
  }));

  // --------------------------------------------------------------- FORM BUILDER (#120)
  router.post('/form-builder/forms', requireAuth, asyncRoute(async (req, res) => {
    const build = await generateForm(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ build }));
  }));
  router.get('/form-builder/forms', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ builds: await listFormBuilds(req.ctx.user!.id) }));
  }));
  router.get('/form-builder/forms/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ build: await getFormBuild(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/form-builder/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await formBuilderReport(req.ctx.user!.id) }));
  }));

  // ------------------------------------------------------------ THEME ENFORCER (#121)
  router.post('/theme-enforcer/violations', requireAuth, asyncRoute(async (req, res) => {
    const violation = await flagThemeViolation(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ violation }));
  }));
  router.post('/theme-enforcer/violations/:id/fix', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ violation: await fixThemeViolation(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/theme-enforcer/violations', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ violations: await listThemeViolations(req.ctx.user!.id) }));
  }));
  router.get('/theme-enforcer/violations/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ violation: await getThemeViolation(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/theme-enforcer/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await themeEnforcerReport(req.ctx.user!.id) }));
  }));

  // --------------------------------------------------------- COMPONENT CATALOGUE (#122)
  router.post('/component-catalogue/entries', requireAuth, asyncRoute(async (req, res) => {
    const entry = await createCatalogueEntry(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ entry }));
  }));
  router.post('/component-catalogue/entries/:id/parse', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ entry: await parseCatalogueEntry(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.post('/component-catalogue/entries/:id/publish', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ entry: await publishCatalogueEntry(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/component-catalogue/entries', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ entries: await listCatalogueEntries(req.ctx.user!.id) }));
  }));
  router.get('/component-catalogue/entries/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ entry: await getCatalogueEntry(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/component-catalogue/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await componentCatalogueReport(req.ctx.user!.id) }));
  }));

  // ------------------------------------------------------------ QUERY WHISPERER (#123)
  router.post('/query-whisperer/plans', requireAuth, asyncRoute(async (req, res) => {
    const plan = await createWhispererPlan(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ plan }));
  }));
  router.post('/query-whisperer/plans/:id/explain', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ plan: await explainQuery(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.post('/query-whisperer/plans/:id/rewrite', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ plan: await rewriteQuery(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/query-whisperer/plans', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ plans: await listQueryWhisperers(req.ctx.user!.id) }));
  }));
  router.get('/query-whisperer/plans/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ plan: await getQueryWhisperer(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/query-whisperer/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await queryWhispererReport(req.ctx.user!.id) }));
  }));

  // ---------------------------------------------------------------- DATA DOCTOR (#124)
  router.post('/data-doctor/scans', requireAuth, asyncRoute(async (req, res) => {
    const scan = await createDataDoctorScan(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ scan }));
  }));
  router.post('/data-doctor/scans/:id/run', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ scan: await runDataDoctorScan(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.post('/data-doctor/scans/:id/flag', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ scan: await flagDataIssue(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/data-doctor/scans', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ scans: await listDataDoctorScans(req.ctx.user!.id) }));
  }));
  router.get('/data-doctor/scans/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ scan: await getDataDoctorScan(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/data-doctor/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await dataDoctorReport(req.ctx.user!.id) }));
  }));

  // ----------------------------------------------------------- SCHEMA TIME MACHINE (#125)
  router.post('/schema-time-machine/snapshots', requireAuth, asyncRoute(async (req, res) => {
    const snapshot = await createSchemaSnapshot(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ snapshot }));
  }));
  router.post('/schema-time-machine/snapshots/:id/capture', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ snapshot: await captureSchemaSnapshot(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.post('/schema-time-machine/snapshots/:id/restore', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ snapshot: await restoreSchemaPoint(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/schema-time-machine/snapshots', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ snapshots: await listSchemaTimeMachineSnapshots(req.ctx.user!.id) }));
  }));
  router.get('/schema-time-machine/snapshots/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ snapshot: await getSchemaTimeMachine(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/schema-time-machine/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await schemaTimeMachineReport(req.ctx.user!.id) }));
  }));

  // ------------------------------------------------------------ PIPELINE WATCHER (#126)
  router.post('/pipeline-watcher/runs', requireAuth, asyncRoute(async (req, res) => {
    const run = await createPipelineWatcherRun(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ run }));
  }));
  router.post('/pipeline-watcher/runs/:id/anomalies', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await detectPipelineAnomaly(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.post('/pipeline-watcher/runs/:id/sla', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await flagSlaViolation(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/pipeline-watcher/runs', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ runs: await listPipelineWatcherRuns(req.ctx.user!.id) }));
  }));
  router.get('/pipeline-watcher/runs/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await getPipelineWatcherRun(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/pipeline-watcher/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await pipelineWatcherReport(req.ctx.user!.id) }));
  }));

  // ---------------------------------------------------------- FEATURE STORE AUTOPILOT (#127)
  router.post('/feature-store/entries', requireAuth, asyncRoute(async (req, res) => {
    const store = await createFeatureStore(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ store }));
  }));
  router.post('/feature-store/entries/:id/retrain', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ store: await draftRetrain(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/feature-store/entries', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ stores: await listFeatureStores(req.ctx.user!.id) }));
  }));
  router.get('/feature-store/entries/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ store: await getFeatureStore(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/feature-store/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await featureStoreReport(req.ctx.user!.id) }));
  }));

  // ----------------------------------------------------- DENORMALIZATION SUGGESTER (#128)
  router.post('/denormalization-suggester/suggestions', requireAuth, asyncRoute(async (req, res) => {
    const suggestion = await createDenormSuggestion(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ suggestion }));
  }));
  router.post('/denormalization-suggester/suggestions/:id/apply', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ suggestion: await applyDenormSuggestion(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/denormalization-suggester/suggestions', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ suggestions: await listDenormSuggestions(req.ctx.user!.id) }));
  }));
  router.get('/denormalization-suggester/suggestions/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ suggestion: await getDenormSuggestion(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/denormalization-suggester/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await denormSuggestionReport(req.ctx.user!.id) }));
  }));

  // ------------------------------------------------------------ RELATIONSHIP MAPPER (#129)
  router.post('/relationship-mapper/maps', requireAuth, asyncRoute(async (req, res) => {
    const map = await createRelationshipMap(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ map }));
  }));
  router.post('/relationship-mapper/maps/:id/verify', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ map: await verifyRelationshipMap(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/relationship-mapper/maps', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ maps: await listRelationshipMaps(req.ctx.user!.id) }));
  }));
  router.get('/relationship-mapper/maps/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ map: await getRelationshipMap(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/relationship-mapper/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await relationshipMapReport(req.ctx.user!.id) }));
  }));

  // ------------------------------------------------------------ ANOMALY DETECTOR (#130)
  router.post('/anomaly-detector/scans', requireAuth, asyncRoute(async (req, res) => {
    const scan = await createAnomalyScan(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ scan }));
  }));
  router.post('/anomaly-detector/scans/:id/alert', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ scan: await alertAnomaly(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/anomaly-detector/scans', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ scans: await listDetectorScans(req.ctx.user!.id) }));
  }));
  router.get('/anomaly-detector/scans/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ scan: await getDetectorScan(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/anomaly-detector/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await anomalyScanReport(req.ctx.user!.id) }));
  }));

  // ------------------------------------------------------------ COMPLIANCE CHECKER (#131)
  router.post('/compliance-checker/reports', requireAuth, asyncRoute(async (req, res) => {
    const report = await createComplianceReport(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ report }));
  }));
  router.post('/compliance-checker/reports/:id/resolve', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await resolveComplianceReport(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/compliance-checker/reports', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ reports: await listComplianceReports(req.ctx.user!.id) }));
  }));
  router.get('/compliance-checker/reports/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await getComplianceReport(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/compliance-checker/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await complianceReport(req.ctx.user!.id) }));
  }));

  // -------------------------------------------------------------- QUERY OPTIMIZER (#132)
  router.post('/query-optimizer/plans', requireAuth, asyncRoute(async (req, res) => {
    const plan = await createOptimizerPlan(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ plan }));
  }));
  router.post('/query-optimizer/plans/:id/optimize', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ plan: await optimizeQuery(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.post('/query-optimizer/plans/:id/prove', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ plan: await proveEquivalence(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/query-optimizer/plans', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ plans: await listQueryPlans(req.ctx.user!.id) }));
  }));
  router.get('/query-optimizer/plans/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ plan: await getQueryPlan(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/query-optimizer/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await queryOptimizerReport(req.ctx.user!.id) }));
  }));

  // ------------------------------------------------------------ CROSS-TEAM CONTRACT (#138)
  router.post('/cross-team-contract/contracts', requireAuth, asyncRoute(async (req, res) => {
    const contract = await createCTCContract(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ contract }));
  }));
  router.post('/cross-team-contract/contracts/:id/breach', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ contract: await flagBreach(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/cross-team-contract/contracts', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ contracts: await listCrossTeamContracts(req.ctx.user!.id) }));
  }));
  router.get('/cross-team-contract/contracts/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ contract: await getContract(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/cross-team-contract/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await crossTeamContractReport(req.ctx.user!.id) }));
  }));

  // ----------------------------------------------------------------- ORG HEALTH (#143)
  router.post('/org-health/reports', requireAuth, asyncRoute(async (req, res) => {
    const report = await createOrgHealthReport(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ report }));
  }));
  router.post('/org-health/reports/:id/compute', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await computeOrgHealth(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/org-health/reports', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ reports: await listOrgHealthReports(req.ctx.user!.id) }));
  }));
  router.get('/org-health/reports/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await getOrgHealthReport(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/org-health/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await orgHealthReport(req.ctx.user!.id) }));
  }));

  // ------------------------------------------------------------ RETENTION PREDICTOR (#145)
  router.post('/retention-predictor/signals', requireAuth, asyncRoute(async (req, res) => {
    const signal = await createRetentionSignal(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ signal }));
  }));
  router.post('/retention-predictor/signals/:id/flag', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ signal: await flagRetentionSignal(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/retention-predictor/signals', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ signals: await listRetentionSignals(req.ctx.user!.id) }));
  }));
  router.get('/retention-predictor/signals/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ signal: await getRetentionSignal(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/retention-predictor/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await retentionPredictorReport(req.ctx.user!.id) }));
  }));

  // ------------------------------------------------------------- HIRING ASSISTANT (#146)
  router.post('/hiring-assistant/evaluations', requireAuth, asyncRoute(async (req, res) => {
    const evaluation = await createHiringEvaluation(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ evaluation }));
  }));
  router.post('/hiring-assistant/evaluations/:id/score', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ evaluation: await scoreHiringEvaluation(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/hiring-assistant/evaluations', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ evaluations: await listHiringEvaluations(req.ctx.user!.id) }));
  }));
  router.get('/hiring-assistant/evaluations/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ evaluation: await getHiringEvaluation(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/hiring-assistant/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await hiringAssistantReport(req.ctx.user!.id) }));
  }));

  // ------------------------------------------------------- SPECULATIVE ENGINEERING (#148)
  router.post('/speculative-engineering/lanes', requireAuth, asyncRoute(async (req, res) => {
    const lane = await openLane(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ lane }));
  }));
  router.post('/speculative-engineering/lanes/:id/measure', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ lane: await measureLane(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/speculative-engineering/lanes', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ lanes: await listLanes(req.ctx.user!.id) }));
  }));
  router.get('/speculative-engineering/lanes/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ lane: await getLane(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/speculative-engineering/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await speculativeEngineeringReport(req.ctx.user!.id) }));
  }));

  // -------------------------------------------------------- SELF-EVOLVING TOOLCHAIN (#149)
  router.post('/self-evolving-toolchain/lessons', requireAuth, asyncRoute(async (req, res) => {
    const lesson = await recordToolchainLesson(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ lesson }));
  }));
  router.post('/self-evolving-toolchain/lessons/:id/adopt', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ lesson: await adoptLesson(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/self-evolving-toolchain/lessons', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ lessons: await listToolchainLessons(req.ctx.user!.id) }));
  }));
  router.get('/self-evolving-toolchain/lessons/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ lesson: await getToolchainLesson(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/self-evolving-toolchain/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await selfEvolvingReport(req.ctx.user!.id) }));
  }));

  // --------------------------------------------------------------- ORG SIMULATOR (#150)
  router.post('/org-simulator/runs', requireAuth, asyncRoute(async (req, res) => {
    const run = await createSimulation(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ run }));
  }));
  router.post('/org-simulator/runs/:id/run', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await runSimulation(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/org-simulator/runs', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ runs: await listSimRuns(req.ctx.user!.id) }));
  }));
  router.get('/org-simulator/runs/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await getSimRun(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/org-simulator/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await orgSimulatorReport(req.ctx.user!.id) }));
  }));

  // ------------------------------------------------------------- CODEBASE PHYSICS (#151)
  router.post('/codebase-physics/runs', requireAuth, asyncRoute(async (req, res) => {
    const run = await createPhysicsRun(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ run }));
  }));
  router.post('/codebase-physics/runs/:id/simulate', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await simulatePhysics(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/codebase-physics/runs', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ runs: await listPhysicsRuns(req.ctx.user!.id) }));
  }));
  router.get('/codebase-physics/runs/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await getPhysicsRun(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/codebase-physics/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await codebasePhysicsReport(req.ctx.user!.id) }));
  }));

  // ------------------------------------------------------------- TECH DEBT PRICING (#152)
  router.post('/tech-debt-market/items', requireAuth, asyncRoute(async (req, res) => {
    const item = await createDebtItem(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ item }));
  }));
  router.post('/tech-debt-market/items/:id/schedule', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ item: await scheduleFix(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/tech-debt-market/items', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ items: await listItems(req.ctx.user!.id) }));
  }));
  router.get('/tech-debt-market/items/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ item: await getItem(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/tech-debt-market/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await techDebtPricingReport(req.ctx.user!.id) }));
  }));

  // --------------------------------------------------------------- AMBIENT CODING (#153)
  router.post('/ambient-coding/sessions', requireAuth, asyncRoute(async (req, res) => {
    const session = await createAmbientSession(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ session }));
  }));
  router.post('/ambient-coding/sessions/:id/answer', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ session: await answerAmbient(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/ambient-coding/sessions', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ sessions: await listAmbientSessions(req.ctx.user!.id) }));
  }));
  router.get('/ambient-coding/sessions/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ session: await getAmbientSession(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/ambient-coding/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await ambientSessionReport(req.ctx.user!.id) }));
  }));

  // ------------------------------------------------------------- INTENT MARKETPLACE (#154)
  router.post('/intent-marketplace/bids', requireAuth, asyncRoute(async (req, res) => {
    const bid = await createIntentBid(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ bid }));
  }));
  router.post('/intent-marketplace/bids/:id/select', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ bid: await selectBid(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/intent-marketplace/bids', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ bids: await listIntentBids(req.ctx.user!.id) }));
  }));
  router.get('/intent-marketplace/bids/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ bid: await getIntentBid(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/intent-marketplace/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await intentMarketplaceReport(req.ctx.user!.id) }));
  }));

  // ------------------------------------------------------------ POST-HUMAN HANDOFF (#156)
  router.post('/post-human-handoff/handoffs', requireAuth, asyncRoute(async (req, res) => {
    const handoff = await createPostHumanHandoff(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ handoff }));
  }));
  router.post('/post-human-handoff/handoffs/:id/continue', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ handoff: await continueHandoff(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/post-human-handoff/handoffs', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ handoffs: await listPostHumanHandoffs(req.ctx.user!.id) }));
  }));
  router.get('/post-human-handoff/handoffs/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ handoff: await getPostHumanHandoff(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/post-human-handoff/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await postHumanHandoffReport(req.ctx.user!.id) }));
  }));

  // ---------------------------------------------------------- SELF-PLAY ADVERSARIAL (#157)
  router.post('/self-play/runs', requireAuth, asyncRoute(async (req, res) => {
    const run = await createSelfPlayRun(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ run }));
  }));
  router.post('/self-play/runs/:id/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await reportSelfPlayIssue(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/self-play/runs', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ runs: await listSelfPlayRuns(req.ctx.user!.id) }));
  }));
  router.get('/self-play/runs/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await getSelfPlayRun(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/self-play/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await selfPlayReport(req.ctx.user!.id) }));
  }));

  // --------------------------------------------------------------- NUTRITION LABEL (#158)
  router.post('/nutrition-label/labels', requireAuth, asyncRoute(async (req, res) => {
    const label = await generateNutritionLabel(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ label }));
  }));
  router.get('/nutrition-label/labels', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ labels: await listNutritionLabels(req.ctx.user!.id) }));
  }));
  router.get('/nutrition-label/labels/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ label: await getNutritionLabel(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/nutrition-label/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await nutritionLabelReport(req.ctx.user!.id) }));
  }));

  // ------------------------------------------------------- UNIVERSAL REPRODUCTION (#159)
  router.post('/universal-reproduction/runs', requireAuth, asyncRoute(async (req, res) => {
    const run = await createReproRun(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ run }));
  }));
  router.post('/universal-reproduction/runs/:id/confirm', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await confirmReproduction(req.ctx.user!.id, req.params.id!, req.body ?? {}) }));
  }));
  router.get('/universal-reproduction/runs', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ runs: await listReproRuns(req.ctx.user!.id) }));
  }));
  router.get('/universal-reproduction/runs/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ run: await getReproRun(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/universal-reproduction/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await universalReproReport(req.ctx.user!.id) }));
  }));

  // --------------------------------------------------------------- REFACTOR MARKET (#160)
  router.post('/refactor-market/proposals', requireAuth, asyncRoute(async (req, res) => {
    const proposal = await proposeRefactor(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ proposal }));
  }));
  router.post('/refactor-market/proposals/:id/queue', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ proposal: await queueRefactor(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/refactor-market/proposals', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ proposals: await listRefactorProposals(req.ctx.user!.id) }));
  }));
  router.get('/refactor-market/proposals/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ proposal: await getRefactorProposal(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/refactor-market/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await refactorMarketReport(req.ctx.user!.id) }));
  }));

  // ---------------------------------------------------------------- DOGFOOD MODE (#161)
  router.post('/dogfood-mode/tasks', requireAuth, asyncRoute(async (req, res) => {
    const task = await fileDogfoodTask(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ task }));
  }));
  router.get('/dogfood-mode/tasks', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ tasks: await listDogfoodTasks(req.ctx.user!.id) }));
  }));
  router.get('/dogfood-mode/tasks/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ task: await getDogfoodTask(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/dogfood-mode/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await dogfoodModeReport(req.ctx.user!.id) }));
  }));

  // ------------------------------------------------------------------ DEMO LINK (#162)
  router.post('/demo-link/links', requireAuth, asyncRoute(async (req, res) => {
    const link = await createDemoLink(req.ctx.user!.id, req.body ?? {});
    res.status(201).json(jsonResult({ link }));
  }));
  router.post('/demo-link/links/:id/expire', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ link: await expireDemoLink(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/demo-link/links', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ links: await listDemoLinks(req.ctx.user!.id) }));
  }));
  router.get('/demo-link/links/:id', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ link: await getDemoLink(req.ctx.user!.id, req.params.id!) }));
  }));
  router.get('/demo-link/report', requireAuth, asyncRoute(async (req, res) => {
    res.json(jsonResult({ report: await demoLinkReport(req.ctx.user!.id) }));
  }));

  return router;
};