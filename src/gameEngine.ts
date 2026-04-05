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
    description: "Past customer emails the model learns language from.",
    learningBlurb:
      "Historical emails teach real customer language and intent. They boost quality but can encode old biases—watch the Bias meter and add controls later if needed.",
    effects: { quality: 2, bias: 2 },
  },
  {
    id: "synthetic_data",
    type: "data",
    title: "Synthetic Labels",
    description: "Generated labels when real training examples are still scarce.",
    learningBlurb:
      "Synthetic labels let you train when real data is scarce. They can drift from production traffic, so quality may need follow-up tuning or human checks.",
    effects: { quality: 1 },
  },
  {
    id: "pii_data",
    type: "data",
    title: "PII-Redacted Feed",
    description: "Email text with personal details stripped before modeling.",
    learningBlurb:
      "Redacting personal details before modeling protects privacy. The tradeoff is less raw signal, which can slightly cap how well the model recalls rare cases.",
    effects: { privacy: 2 },
  },
  {
    id: "llm_classifier",
    type: "model",
    title: "LLM Classifier",
    description: "Reads each email and assigns a classification or route.",
    learningBlurb:
      "LLMs handle varied wording but automate decisions aggressively. Expect higher automation and hallucination risk unless you add strong controls and review.",
    effects: { automation: 2, hallucination: 1 },
  },
  {
    id: "entity_recognition",
    type: "model",
    title: "Fine-tuned NER",
    description: "Finds names, dates, and entities inside the message.",
    learningBlurb:
      "NER models extract names, dates, and entities from text. They are structured and efficient, but combined with people-related data they need careful privacy handling.",
    effects: { automation: 1, privacy: 1 },
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

/** Traffic-light style tier for a single metric (no numbers shown in UI). */
export type MetricTraffic = "green" | "amber" | "red";

export type MetricPresentation = {
  traffic: MetricTraffic;
  /** Short state label shown under the bar. */
  label: string;
  /** 0–1 fill for bar animation (not the raw score). */
  barFill: number;
};

export type SystemStateTier = "stable" | "at_risk" | "unstable";

const METRIC_MAX = 5;

/**
 * Presentation for one risk meter: thresholds match getGameOverReasons (Req / Max).
 */
export function getMetricPresentation(
  key: RiskKey,
  value: number,
): MetricPresentation {
  let traffic: MetricTraffic;
  let label: string;
  let barFill: number;

  switch (key) {
    case "quality": {
      if (value < 2) {
        traffic = "red";
        label = "Critical";
      } else if (value === 2) {
        traffic = "amber";
        label = "At Risk";
      } else {
        traffic = "green";
        label = "Stable";
      }
      barFill = Math.min(1, value / METRIC_MAX);
      break;
    }
    case "privacy": {
      if (value < 1) {
        traffic = "red";
        label = "Exposed";
      } else if (value === 1) {
        traffic = "amber";
        label = "At Risk";
      } else {
        traffic = "green";
        label = "Safe";
      }
      barFill = Math.min(1, value / METRIC_MAX);
      break;
    }
    case "bias": {
      if (value > 2) {
        traffic = "red";
        label = "Critical";
      } else if (value === 2) {
        traffic = "amber";
        label = "Rising";
      } else {
        traffic = "green";
        label = "Controlled";
      }
      barFill = Math.min(1, value / METRIC_MAX);
      break;
    }
    case "automation": {
      if (value > 3) {
        traffic = "red";
        label = "Critical";
      } else if (value === 3) {
        traffic = "amber";
        label = "Rising";
      } else {
        traffic = "green";
        label = "Controlled";
      }
      barFill = Math.min(1, value / METRIC_MAX);
      break;
    }
    case "hallucination": {
      if (value > 1) {
        traffic = "red";
        label = "Exposed";
      } else if (value === 1) {
        traffic = "amber";
        label = "At Risk";
      } else {
        traffic = "green";
        label = "Safe";
      }
      barFill = Math.min(1, value / METRIC_MAX);
      break;
    }
  }

  return { traffic, label, barFill };
}

/** Overall headline tier from live metrics (for subheader / header). */
export function getSystemStateTier(
  risks: GameRisks,
  unsafeNoHumanOversight: boolean,
): SystemStateTier {
  if (unsafeNoHumanOversight) return "unstable";
  const keys: RiskKey[] = [
    "quality",
    "bias",
    "privacy",
    "automation",
    "hallucination",
  ];
  let anyRed = false;
  let anyAmber = false;
  for (const k of keys) {
    const t = getMetricPresentation(k, risks[k]).traffic;
    if (t === "red") anyRed = true;
    if (t === "amber") anyAmber = true;
  }
  if (anyRed) return "unstable";
  if (anyAmber) return "at_risk";
  return "stable";
}

export function systemStateHeadline(tier: SystemStateTier): string {
  if (tier === "stable") return "System Stable";
  if (tier === "at_risk") return "System At Risk";
  return "System Unstable — apply controls";
}

/** True when deploy would fail using existing threshold rules. */
export function hasDeployViolations(
  risks: GameRisks,
  selection: GameSelection,
  unsafeNoHumanOversight: boolean,
): boolean {
  return (
    getGameOverReasons(risks, selection, unsafeNoHumanOversight).length > 0
  );
}

export function riskDelta(prev: GameRisks, next: GameRisks): Partial<GameRisks> {
  const out: Partial<GameRisks> = {};
  for (const k of RISK_KEYS) {
    const d = next[k] - prev[k];
    if (d !== 0) out[k] = d;
  }
  return out;
}

/**
 * Single blue-band line after a drop: pro and con for that card only.
 */
const COMPONENT_PRO_CON: Record<string, string> = {
  historical_data:
    "Historical Data — Pro: learns real customer email language for routing. Con: old patterns can embed representational bias.",
  synthetic_data:
    "Synthetic Labels — Pro: iterate before enough live data exists. Con: training can drift from real inbox behaviour.",
  pii_data:
    "PII-redacted feed — Pro: stronger privacy on sensitive content. Con: less raw detail can weaken recall on edge cases.",
  llm_classifier:
    "LLM Classifier — Pro: handles varied wording and many intents. Con: high automation and plausible mislabels.",
  entity_recognition:
    "Fine-tuned NER — Pro: reliable names, dates, and entities. Con: with people-heavy data, re-identification risk rises.",
  human_review:
    "Human Review — Pro: people catch mistakes and grey areas. Con: slower throughput and staffing cost.",
  bias_testing:
    "Confidence Thresholds — Pro: uncertain items go to humans; eases bias and blind automation. Con: larger manual review queues.",
  anonymisation:
    "Audit Trail — Pro: immutable logs for compliance and accountability. Con: heavy redaction can trim usable signal.",
};

export function getComponentProConMessage(
  cardId: string,
  cardTitle: string,
  cardType: CardType,
): string {
  return (
    COMPONENT_PRO_CON[cardId] ??
    (cardType === "control"
      ? `${cardTitle} — Pro: adds a safeguard on the stack. Con: may add latency or operational overhead.`
      : `${cardTitle} — Pro: extends what the system can do. Con: shifts risk on the meters—watch the row above.`)
  );
}

export type EndgameDomain = "quality" | "risk" | "design";

export type EndgameSummary = {
  outcome: "success" | "failure";
  domains: { id: EndgameDomain; blurb: string }[];
  insights: string[];
};

function hasCard(selection: GameSelection, id: string): boolean {
  return (
    selection.selected_data.includes(id) ||
    selection.selected_models.includes(id) ||
    selection.selected_controls.includes(id)
  );
}

/**
 * Qualitative post-game summary (scores stay internal; this is narrative only).
 */
export function buildEndgameSummary(
  success: boolean,
  risks: GameRisks,
  selection: GameSelection,
  unsafeNoHumanOversight: boolean,
  failureReasons: string[],
): EndgameSummary {
  const domains: { id: EndgameDomain; blurb: string }[] = [];

  const q = getMetricPresentation("quality", risks.quality);
  const designParts: string[] = [];
  if (hasCard(selection, "human_review")) {
    designParts.push("human oversight in the loop");
  }
  if (hasCard(selection, "bias_testing")) {
    designParts.push("uncertainty routing");
  }
  if (hasCard(selection, "anonymisation")) {
    designParts.push("strong audit posture");
  }
  domains.push({
    id: "design",
    blurb:
      designParts.length > 0
        ? `Design: ${designParts.join(", ")}.`
        : "Design: lean stack—fewer safeguards mean faster iteration but thinner guardrails.",
  });

  domains.push({
    id: "quality",
    blurb:
      q.traffic === "green"
        ? "Quality: signal looks sufficient for routing decisions."
        : q.traffic === "amber"
          ? "Quality: workable but fragile—easy to slip below a safe bar."
          : "Quality: the stack is starved for signal or being eroded by tradeoffs.",
  });

  const anyRed =
    getSystemStateTier(risks, unsafeNoHumanOversight) === "unstable";
  domains.push({
    id: "risk",
    blurb: success
      ? "Risk: metrics stayed inside safe envelopes for deploy."
      : anyRed
        ? "Risk: one or more dimensions crossed a hard limit."
        : "Risk: policy checks (like oversight rules) blocked deploy.",
  });

  const insights: string[] = [];
  if (success) {
    if (selection.selected_controls.length >= 2) {
      insights.push("You layered multiple controls—good practice for production-grade builds.");
    } else if (selection.selected_controls.length === 1) {
      insights.push("A single control helped, but redundancy often catches what one layer misses.");
    } else {
      insights.push("Deploy succeeded, but an empty control lane is rare in real regulated flows.");
    }
    if (hasCard(selection, "llm_classifier") && hasCard(selection, "human_review")) {
      insights.push("Pairing an LLM with human review is a strong pattern for high-stakes routing.");
    }
  } else {
    if (failureReasons.length > 0) {
      insights.push(
        failureReasons[0].replace(/\(\d+\)\.?$/u, "").trim() + ".",
      );
    }
    if (insights.length < 2 && unsafeNoHumanOversight) {
      insights.push(
        "When automation runs hot, human review is usually the fastest stabiliser.",
      );
    }
    if (insights.length < 2) {
      insights.push(
        "Try a control that directly targets the flashing metric before spending another move.",
      );
    }
  }

  return {
    outcome: success ? "success" : "failure",
    domains,
    insights: insights.slice(0, 2),
  };
}

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
