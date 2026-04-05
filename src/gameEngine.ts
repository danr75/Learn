/**
 * Game logic: base effects → combination rules → controls → clamp → failure check.
 */

export type RiskKey =
  | "quality"
  | "bias"
  | "privacy"
  | "automation"
  | "hallucination";

export type CardType = "data" | "model" | "control";

export type GameRisks = Record<RiskKey, number>;

export type GameSelection = {
  selected_data: string[];
  selected_models: string[];
  selected_controls: string[];
};

export type CardDefinition = {
  id: string;
  type: CardType;
  title: string;
  description: string;
  /** Short teaching note shown in the instruction bar after this card is placed. */
  learningBlurb: string;
  effects: Partial<Record<RiskKey, number>>;
  tags?: { label: string; variant: "q" | "p" | "a" | "f" }[];
};

export type CombinationRule = {
  id: string;
  /** All of these card ids must be present (in data, model, or control lists). */
  if: string[];
  /** None of these card ids may be present anywhere in the build. */
  not?: string[];
  /** At least one model must be selected. */
  requiresAnyModel?: boolean;
  then: Partial<Record<RiskKey, number>>;
};

const RISK_KEYS: RiskKey[] = [
  "quality",
  "bias",
  "privacy",
  "automation",
  "hallucination",
];

const ZERO: GameRisks = {
  quality: 0,
  bias: 0,
  privacy: 0,
  automation: 0,
  hallucination: 0,
};

export const CARD_DEFINITIONS: CardDefinition[] = [
  {
    id: "historical_data",
    type: "data",
    title: "Historical Data",
    description: "Rich signal; watch representational bias.",
    learningBlurb:
      "Historical emails teach real customer language and intent. They boost quality but can encode old biases—watch the Bias meter and add controls later if needed.",
    effects: { quality: 2, bias: 2 },
    tags: [
      { label: "Q+2", variant: "q" },
      { label: "B+2", variant: "p" },
    ],
  },
  {
    id: "synthetic_data",
    type: "data",
    title: "Synthetic Labels",
    description: "Faster iteration; watch for distribution shift.",
    learningBlurb:
      "Synthetic labels let you train when real data is scarce. They can drift from production traffic, so quality may need follow-up tuning or human checks.",
    effects: { quality: 1 },
    tags: [{ label: "Q+1", variant: "q" }],
  },
  {
    id: "pii_data",
    type: "data",
    title: "PII-Redacted Feed",
    description: "Stronger privacy posture; may cap recall.",
    learningBlurb:
      "Redacting personal details before modeling protects privacy. The tradeoff is less raw signal, which can slightly cap how well the model recalls rare cases.",
    effects: { privacy: 2 },
    tags: [{ label: "P+2", variant: "p" }],
  },
  {
    id: "llm_classifier",
    type: "model",
    title: "LLM Classifier",
    description: "Flexible routing; monitor automation and hallucination.",
    learningBlurb:
      "LLMs handle varied wording but automate decisions aggressively. Expect higher automation and hallucination risk unless you add strong controls and review.",
    effects: { automation: 2, hallucination: 1 },
    tags: [
      { label: "A+2", variant: "a" },
      { label: "H+1", variant: "f" },
    ],
  },
  {
    id: "entity_recognition",
    type: "model",
    title: "Fine-tuned NER",
    description: "Structured entities; pairing with PII feeds needs care.",
    learningBlurb:
      "NER models extract names, dates, and entities from text. They are structured and efficient, but combined with people-related data they need careful privacy handling.",
    effects: { automation: 1, privacy: 1 },
    tags: [{ label: "A+1", variant: "a" }],
  },
  {
    id: "human_review",
    type: "control",
    title: "Human Review",
    description: "Manual oversight on edge cases.",
    learningBlurb:
      "Human review slows throughput but is the clearest brake on blind automation. Use it when mistakes would be costly or when regulation expects oversight.",
    effects: { automation: -2 },
  },
  {
    id: "bias_testing",
    type: "control",
    title: "Confidence Thresholds",
    description: "Route uncertain items for review.",
    learningBlurb:
      "Sending low-confidence predictions for review reduces both bias and unchecked automation. It is a lightweight way to avoid acting when the model is unsure.",
    effects: { bias: -2, automation: -1 },
  },
  {
    id: "anonymisation",
    type: "control",
    title: "Audit Trail",
    description: "Immutable logs for compliance.",
    learningBlurb:
      "Audit trails and stronger anonymisation improve accountability and privacy. Heavy redaction can trim usable detail, so balance compliance against quality needs.",
    effects: { privacy: -3, quality: -1 },
  },
];

export const CARD_BY_ID: Record<string, CardDefinition> = Object.fromEntries(
  CARD_DEFINITIONS.map((c) => [c.id, c]),
);

/** Short risk lines for the Risks column (max seven words each). */
const CARD_RISK_LINES: Record<string, readonly string[]> = {
  historical_data: [
    "Past customer language may encode demographic bias.",
  ],
  synthetic_data: ["Synthetic labels may drift from production traffic."],
  pii_data: ["Redaction may limit rare-case detection quality."],
  llm_classifier: [
    "LLM routing automates decisions with thin grounding.",
    "Model may mislabel plausible-sounding nonsense emails.",
  ],
  entity_recognition: [
    "NER on people-related text raises re-identification risk.",
  ],
  human_review: ["Human queues add latency and staffing cost."],
  bias_testing: ["Low-confidence routing inflates manual review volume."],
  anonymisation: ["Strong logs and redaction trim usable signal."],
};

const RULE_RISK_LINES: Record<string, readonly string[]> = {
  historical_plus_llm: ["Legacy inbox plus LLM amplifies encoded bias."],
  pii_plus_ner: ["Entity extraction plus PII heightens exposure risk."],
  llm_without_human: ["Automated LLM lacks mandatory human oversight."],
  synthetic_with_any_model: ["Synthetic training may miss real inbox nuance."],
};

/**
 * Ordered bullet lines describing risks and tradeoffs from the current build.
 */
export function getLiveRiskBulletStatements(
  selection: GameSelection,
): string[] {
  const { selected_data, selected_models, selected_controls } = selection;
  const seen = new Set<string>();
  const out: string[] = [];

  function pushUnique(lines: readonly string[]) {
    for (const line of lines) {
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
  }

  for (const id of selected_data) {
    const lines = CARD_RISK_LINES[id];
    if (lines) pushUnique(lines);
  }
  for (const id of selected_models) {
    const lines = CARD_RISK_LINES[id];
    if (lines) pushUnique(lines);
  }

  for (const rule of COMBINATION_RULES) {
    if (
      !ruleApplies(rule, selected_data, selected_models, selected_controls)
    ) {
      continue;
    }
    const lines = RULE_RISK_LINES[rule.id];
    if (lines) pushUnique(lines);
  }

  for (const id of selected_controls) {
    const lines = CARD_RISK_LINES[id];
    if (lines) pushUnique(lines);
  }

  return out;
}

export const COMBINATION_RULES: CombinationRule[] = [
  {
    id: "historical_plus_llm",
    if: ["historical_data", "llm_classifier"],
    then: { bias: 2 },
  },
  {
    id: "pii_plus_ner",
    if: ["pii_data", "entity_recognition"],
    then: { privacy: 3 },
  },
  {
    id: "llm_without_human",
    if: ["llm_classifier"],
    not: ["human_review"],
    then: { automation: 2 },
  },
  {
    id: "synthetic_with_any_model",
    if: ["synthetic_data"],
    requiresAnyModel: true,
    then: { quality: -1 },
  },
];

function cloneRisks(r: GameRisks): GameRisks {
  return { ...r };
}

function applyDelta(
  risks: GameRisks,
  delta: Partial<Record<RiskKey, number>>,
  sourceLabel: string,
  feedback: string[],
) {
  for (const key of RISK_KEYS) {
    const v = delta[key];
    if (v == null || v === 0) continue;
    risks[key] += v;
    const sign = v > 0 ? `+${v}` : `${v}`;
    feedback.push(`${sign} ${key} from ${sourceLabel}`);
  }
}

function ruleApplies(
  rule: CombinationRule,
  selected_data: string[],
  selected_models: string[],
  selected_controls: string[],
): boolean {
  const active = new Set([
    ...selected_data,
    ...selected_models,
    ...selected_controls,
  ]);
  if (!rule.if.every((id) => active.has(id))) return false;
  if (rule.not?.some((id) => active.has(id))) return false;
  if (rule.requiresAnyModel && selected_models.length === 0) return false;
  return true;
}

function clampRisks(risks: GameRisks): GameRisks {
  const out = cloneRisks(risks);
  for (const k of RISK_KEYS) {
    out[k] = Math.max(0, Math.min(5, out[k]));
  }
  return out;
}

export type ComputeResult = {
  risks: GameRisks;
  /** Ordered messages for the last full recalculation. */
  feedback: string[];
  unsafeNoHumanOversight: boolean;
};

/**
 * Full pipeline: reset → data + model base → rules → controls → clamp.
 */
export function computeGameState(selection: GameSelection): ComputeResult {
  const risks = cloneRisks(ZERO);
  const feedback: string[] = [];

  const { selected_data, selected_models, selected_controls } = selection;

  for (const id of selected_data) {
    const def = CARD_BY_ID[id];
    if (def) applyDelta(risks, def.effects, def.title, feedback);
  }

  for (const id of selected_models) {
    const def = CARD_BY_ID[id];
    if (def) applyDelta(risks, def.effects, def.title, feedback);
  }

  for (const rule of COMBINATION_RULES) {
    if (
      !ruleApplies(rule, selected_data, selected_models, selected_controls)
    ) {
      continue;
    }
    const label = `combination (${rule.id.replace(/_/g, " ")})`;
    applyDelta(risks, rule.then, label, feedback);
  }

  for (const id of selected_controls) {
    const def = CARD_BY_ID[id];
    if (def) applyDelta(risks, def.effects, def.title, feedback);
  }

  const clamped = clampRisks(risks);

  const unsafeNoHumanOversight =
    clamped.automation >= 4 && !selected_controls.includes("human_review");

  return {
    risks: clamped,
    feedback,
    unsafeNoHumanOversight,
  };
}

export const STAT_FOOTERS: Record<RiskKey, string> = {
  quality: "Req: 2",
  bias: "Max: 2",
  privacy: "Req: 1",
  automation: "Max: 3",
  hallucination: "Max: 1",
};

export const STAT_LABELS: Record<RiskKey, string> = {
  quality: "QUALITY",
  bias: "BIAS",
  privacy: "PRIVACY",
  automation: "AUTOMATION",
  hallucination: "HALLUCINATION",
};

/** Non-zero effects on each risk, in display order (for card preview UI). */
export function getCardEffectRows(
  effects: Partial<Record<RiskKey, number>>,
): { key: RiskKey; delta: number }[] {
  const rows: { key: RiskKey; delta: number }[] = [];
  for (const k of RISK_KEYS) {
    const v = effects[k];
    if (v != null && v !== 0) rows.push({ key: k, delta: v });
  }
  return rows;
}

/** Win/lose checks vs stat row (Req = minimum, Max = ceiling). */
export function getGameOverReasons(
  risks: GameRisks,
  selection: GameSelection,
  unsafeNoHumanOversight: boolean,
): string[] {
  const hasBuild =
    selection.selected_data.length +
      selection.selected_models.length +
      selection.selected_controls.length >
    0;
  if (!hasBuild) return [];

  const out: string[] = [];
  if (risks.bias > 2) out.push("Bias exceeds maximum (2).");
  if (risks.automation > 3) out.push("Automation exceeds maximum (3).");
  if (risks.hallucination > 1) out.push("Hallucination exceeds maximum (1).");
  if (risks.quality < 2) out.push("Quality below requirement (2).");
  if (risks.privacy < 1) out.push("Privacy below requirement (1).");
  if (unsafeNoHumanOversight) {
    out.push("Unsafe system: Fully automated decision without human oversight.");
  }
  return out;
}
