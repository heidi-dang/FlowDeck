import { customizationCollector } from "../collectors/customization-collector";
import { foundationCollector } from "../collectors/foundation-collector";
import { sessionCollector } from "../collectors/session-collector";
import { analyzeTaskUnderstanding } from "../analyzers/task-understanding";
import { analyzeControlledExecution } from "../analyzers/controlled-execution";
import { analyzeChangeValidation } from "../analyzers/change-validation";
import { analyzeReliableDelivery } from "../analyzers/reliable-delivery";
import { analyzeLearningCapture } from "../analyzers/learning-capture";
import { saveRun, loadRun } from "../persistence/run-store";
import { saveReport, loadReport } from "../persistence/report-store";
import { saveFindingIndex, loadFindingIndex } from "../persistence/finding-store";
import { saveIgnoredFinding, loadIgnoredFindings } from "../persistence/ignored-finding-store";
import { saveRepairSession, loadRepairSession } from "../persistence/repair-session-store";
import { readSessionRecords } from "../opencode/session-reader";
import { analyzeSessions } from "../opencode/session-analyzer";
import { createRepairSession } from "../opencode/repair-session";
import { buildRepairPrompt } from "../opencode/repair-prompt";
import { executeValidation } from "../opencode/validation-executor";

export const registry = {
  collectors: {
    customization: customizationCollector,
    foundations: foundationCollector,
    sessions: sessionCollector,
  },
  analyzers: {
    taskUnderstanding: analyzeTaskUnderstanding,
    controlledExecution: analyzeControlledExecution,
    changeValidation: analyzeChangeValidation,
    reliableDelivery: analyzeReliableDelivery,
    learningCapture: analyzeLearningCapture,
  },
  stores: {
    run: { save: saveRun, load: loadRun },
    report: { save: saveReport, load: loadReport },
    finding: { save: saveFindingIndex, load: loadFindingIndex },
    ignoredFinding: { save: saveIgnoredFinding, load: loadIgnoredFindings },
    repairSession: { save: saveRepairSession, load: loadRepairSession },
  },
  opencode: {
    readSessionRecords,
    analyzeSessions,
    createRepairSession,
    buildRepairPrompt,
    executeValidation,
  },
};
