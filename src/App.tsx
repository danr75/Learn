import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Database,
  Lightbulb,
  Link2,
  Menu,
  Microchip,
  Rocket,
  RotateCcw,
  Settings,
  Shield,
} from "lucide-react";
import {
  CARD_BY_ID,
  CARD_DEFINITIONS,
  type CardDefinition,
  type CardType,
  type GameSelection,
  buildEndgameSummary,
  computeGameState,
  getComponentProConMessage,
  getGameOverReasons,
  getMetricPresentation,
  getStructureFoundationVisual,
  getStructureModelWeightVisual,
  getSystemStateTier,
  hasDeployViolations,
  riskDelta,
  STAT_LABELS,
  type RiskKey,
  type SystemStateTier,
} from "./gameEngine";
import "./App.css";

const CARD_DRAG_MIME = "application/x-legolearn-card";

/** Single line shown in the blue band before the first drop. */
const SCENARIO_ONLY =
  "Build a system to classify customer emails using internal data — drag Data into System first, then a model, then controls.";

type Pillar = "DATA" | "MODEL" | "CONTROL";

type GameCardDef = {
  id: string;
  pillar: Pillar;
  title: string;
  description: string;
  tags?: { label: string; variant: "q" | "p" | "a" | "f" }[];
};

function pillarOf(type: CardType): Pillar {
  if (type === "data") return "DATA";
  if (type === "model") return "MODEL";
  return "CONTROL";
}

function toViewCard(c: CardDefinition): GameCardDef {
  return {
    id: c.id,
    pillar: pillarOf(c.type),
    title: c.title,
    description: c.description,
    tags: c.tags,
  };
}

const DATA_CARDS: GameCardDef[] = CARD_DEFINITIONS.filter(
  (c) => c.type === "data",
).map(toViewCard);

const MODEL_CARDS: GameCardDef[] = CARD_DEFINITIONS.filter(
  (c) => c.type === "model",
).map(toViewCard);

const CONTROL_CARDS: GameCardDef[] = CARD_DEFINITIONS.filter(
  (c) => c.type === "control",
).map(toViewCard);

const RISK_ORDER: RiskKey[] = [
  "quality",
  "bias",
  "privacy",
  "automation",
  "hallucination",
];

const ALL_LANE_CARDS: GameCardDef[] = [
  ...DATA_CARDS,
  ...MODEL_CARDS,
  ...CONTROL_CARDS,
];

function findViewCard(id: string): GameCardDef | undefined {
  return ALL_LANE_CARDS.find((c) => c.id === id);
}

function parseCardDragPayload(e: React.DragEvent): {
  id: string;
  pillar: Pillar;
  fromSystem?: boolean;
} | null {
  try {
    const raw = e.dataTransfer.getData(CARD_DRAG_MIME);
    if (!raw) return null;
    const o = JSON.parse(raw) as {
      id?: string;
      pillar?: Pillar;
      fromSystem?: boolean;
    };
    if (!o.id || !o.pillar) return null;
    if (o.pillar !== "DATA" && o.pillar !== "MODEL" && o.pillar !== "CONTROL") {
      return null;
    }
    return {
      id: o.id,
      pillar: o.pillar,
      fromSystem: o.fromSystem === true,
    };
  } catch {
    return null;
  }
}

function PillarIcon({ pillar }: { pillar: Pillar }) {
  const cls = "game-card__icon";
  if (pillar === "DATA") return <Database className={cls} aria-hidden />;
  if (pillar === "MODEL") return <Microchip className={cls} aria-hidden />;
  return <Shield className={cls} aria-hidden />;
}

function GameCard({
  card,
  selected,
  onSelect,
  draggable = false,
  onDragStart,
  onDragEnd,
}: {
  card: GameCardDef;
  selected: boolean;
  onSelect: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd?: (e: React.DragEvent<HTMLDivElement>) => void;
}) {
  const mod =
    card.pillar === "DATA"
      ? "game-card--data"
      : card.pillar === "MODEL"
        ? "game-card--model"
        : "game-card--control";
  const label = `${card.title}. ${card.description}`;

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`game-card ${mod}${selected ? " game-card--selected" : ""}${draggable ? " game-card--draggable" : " game-card--lane-locked"}`}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      aria-pressed={selected}
      aria-label={label}
    >
      <div className="game-card__row">
        <span className="game-card__pillar">{card.pillar}</span>
        <PillarIcon pillar={card.pillar} />
      </div>
      <h3 className="game-card__title">{card.title}</h3>
      <p className="game-card__desc">{card.description}</p>
      {card.tags && card.tags.length > 0 && (
        <div className="game-card__tags">
          {card.tags.map((t) => (
            <span key={t.label} className={`tag tag--${t.variant}`}>
              {t.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function SystemMiniCard({
  card,
  draggable = false,
  onDragStart,
  onDragEnd,
}: {
  card: GameCardDef;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd?: (e: React.DragEvent<HTMLDivElement>) => void;
}) {
  const mod = draggable ? " system-mini-card--draggable" : "";
  return (
    <div
      className={`system-mini-card${mod}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="system-mini-card__row">
        <span className="system-mini-card__pillar">{card.pillar}</span>
        <PillarIcon pillar={card.pillar} />
      </div>
      <p className="system-mini-card__title">{card.title}</p>
    </div>
  );
}

/** Moves allowed after a threshold breach before the run ends (recovery gameplay). */
const RECOVERY_GRACE_MOVES = 2;

type MetricPulse = Partial<Record<RiskKey, "up" | "down">>;

function StatMetricCard({
  riskKey,
  value,
  pulse,
  live,
}: {
  riskKey: RiskKey;
  value: number;
  pulse: MetricPulse;
  live: boolean;
}) {
  const pulseDir = pulse[riskKey];

  if (!live) {
    return (
      <div
        className="stat-card stat-card--idle"
        data-metric={riskKey}
        aria-label={`${STAT_LABELS[riskKey]} — fills in when you add cards to the system`}
      >
        <span className="stat-label">{STAT_LABELS[riskKey]}</span>
        <div className="stat-bar" aria-hidden>
          <div className="stat-bar__fill stat-bar__fill--idle" style={{ width: "0%" }} />
        </div>
        <span className="stat-state stat-state--slot" aria-hidden />
      </div>
    );
  }

  const p = getMetricPresentation(riskKey, value);
  const mod =
    p.traffic === "green"
      ? "stat-card--ok"
      : p.traffic === "amber"
        ? "stat-card--warn"
        : "stat-card--bad";
  const pulseClass =
    pulseDir === "up"
      ? " stat-card--pulse-up"
      : pulseDir === "down"
        ? " stat-card--pulse-down"
        : "";

  return (
    <div
      className={`stat-card ${mod}${pulseClass}`}
      data-metric={riskKey}
    >
      <span className="stat-label">{STAT_LABELS[riskKey]}</span>
      <div className="stat-bar" aria-hidden>
        <div
          className="stat-bar__fill"
          style={{ width: `${Math.round(p.barFill * 100)}%` }}
        />
      </div>
      <span className={`stat-state stat-state--${p.traffic}`}>{p.label}</span>
    </div>
  );
}

type SelectionSnapshot = {
  selected_data: string[];
  selected_models: string[];
  selected_controls: string[];
  moves: number;
};

export default function App() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [moves, setMoves] = useState(0);
  const [selected_data, setSelected_data] = useState<string[]>([]);
  const [selected_models, setSelected_models] = useState<string[]>([]);
  const [selected_controls, setSelected_controls] = useState<string[]>([]);
  const [dragging, setDragging] = useState<Pillar | null>(null);
  const [dragSource, setDragSource] = useState<"lane" | "system" | null>(null);
  const dragPillarRef = useRef<Pillar | null>(null);
  const [undoStack, setUndoStack] = useState<SelectionSnapshot[]>([]);
  const selectionRef = useRef({
    selected_data,
    selected_models,
    selected_controls,
  });
  const movesRef = useRef(moves);

  const selection = useMemo(
    () => ({ selected_data, selected_models, selected_controls }),
    [selected_data, selected_models, selected_controls],
  );

  const { risks, unsafeNoHumanOversight } = useMemo(
    () => computeGameState(selection),
    [selection],
  );

  const [deployFailureReasons, setDeployFailureReasons] = useState<string[] | null>(
    null,
  );
  const [deploySuccess, setDeploySuccess] = useState(false);
  const [recoveryGraceRemaining, setRecoveryGraceRemaining] = useState<
    number | null
  >(null);
  const [blueMessage, setBlueMessage] = useState("");
  const [structureImpactSeq, setStructureImpactSeq] = useState(0);
  const [structureImpactFlash, setStructureImpactFlash] = useState(false);
  const [metricPulse, setMetricPulse] = useState<MetricPulse>({});
  const pulseClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const gameOver = deployFailureReasons !== null;

  useEffect(() => {
    selectionRef.current = selection;
    movesRef.current = moves;
  }, [selection, moves]);

  useEffect(() => {
    return () => {
      if (pulseClearRef.current) window.clearTimeout(pulseClearRef.current);
    };
  }, []);

  useEffect(() => {
    if (structureImpactSeq === 0) return;
    setStructureImpactFlash(true);
    const t = window.setTimeout(() => setStructureImpactFlash(false), 380);
    return () => window.clearTimeout(t);
  }, [structureImpactSeq]);

  const systemDataId = selected_data[0] ?? null;
  const systemModelId = selected_models[0] ?? null;

  const placedData = useMemo(
    () => (systemDataId ? findViewCard(systemDataId) : undefined),
    [systemDataId],
  );
  const placedModel = useMemo(
    () => (systemModelId ? findViewCard(systemModelId) : undefined),
    [systemModelId],
  );

  /** 0 = need data, 1 = need model, 2 = controls phase */
  const buildStep = !systemDataId ? 0 : !systemModelId ? 1 : 2;

  const hasSystemContent =
    selected_data.length > 0 ||
    selected_models.length > 0 ||
    selected_controls.length > 0;

  const systemTier = useMemo(
    () => getSystemStateTier(risks, unsafeNoHumanOversight),
    [risks, unsafeNoHumanOversight],
  );

  const headlineTier = !hasSystemContent ? ("stable" as const) : systemTier;

  const deployViolationsNow = useMemo(
    () => hasDeployViolations(risks, selection, unsafeNoHumanOversight),
    [risks, selection, unsafeNoHumanOversight],
  );

  const towerBuilt = Boolean(placedData && placedModel);

  const structureVisualTier = useMemo((): SystemStateTier => {
    if (gameOver || deploySuccess || !towerBuilt) return "stable";
    return headlineTier;
  }, [gameOver, deploySuccess, towerBuilt, headlineTier]);

  const foundationVisual = useMemo(
    () => getStructureFoundationVisual(systemDataId ?? undefined),
    [systemDataId],
  );

  const modelWeightVisual = useMemo(
    () => getStructureModelWeightVisual(systemModelId ?? undefined),
    [systemModelId],
  );

  const towerSwingVars = useMemo((): CSSProperties => {
    let tilt = 0;
    let nudge = 0;
    if (towerBuilt && !gameOver && !deploySuccess) {
      if (structureVisualTier === "at_risk") {
        tilt = 2.35;
        nudge = 5;
      } else if (structureVisualTier === "unstable") {
        tilt = 5.1;
        nudge = 10.5;
      }
      if (foundationVisual === "weak") {
        tilt *= 1.18;
        nudge *= 1.12;
      } else if (foundationVisual === "strong") {
        tilt *= 0.74;
        nudge *= 0.76;
      }
      if (modelWeightVisual === "heavy") {
        tilt *= 1.12;
        nudge *= 1.08;
      } else if (modelWeightVisual === "light") {
        tilt *= 0.9;
        nudge *= 0.9;
      }
      const sc = selected_controls.length;
      if (sc > 0) {
        const damp = Math.max(0.2, 1 - sc * 0.26);
        tilt *= damp;
        nudge *= damp;
      }
    }
    return {
      ["--tower-tilt" as string]: `${tilt}deg`,
      ["--tower-nudge" as string]: `${nudge}px`,
    };
  }, [
    towerBuilt,
    gameOver,
    deploySuccess,
    structureVisualTier,
    foundationVisual,
    modelWeightVisual,
    selected_controls.length,
  ]);

  const successSummary = useMemo(
    () =>
      deploySuccess
        ? buildEndgameSummary(
            true,
            risks,
            selection,
            unsafeNoHumanOversight,
            [],
          )
        : null,
    [deploySuccess, risks, selection, unsafeNoHumanOversight],
  );

  const failureSummary = useMemo(() => {
    if (!gameOver || !deployFailureReasons) return null;
    return buildEndgameSummary(
      false,
      risks,
      selection,
      unsafeNoHumanOversight,
      deployFailureReasons,
    );
  }, [
    gameOver,
    deployFailureReasons,
    risks,
    selection,
    unsafeNoHumanOversight,
  ]);

  const recoveryGraceRef = useRef<number | null>(null);
  useEffect(() => {
    recoveryGraceRef.current = recoveryGraceRemaining;
  }, [recoveryGraceRemaining]);

  function triggerMetricPulse(delta: Partial<Record<RiskKey, number>>) {
    const nextPulse: MetricPulse = {};
    for (const k of RISK_ORDER) {
      const d = delta[k];
      if (d == null || d === 0) continue;
      nextPulse[k] = d > 0 ? "up" : "down";
    }
    setMetricPulse(nextPulse);
    if (pulseClearRef.current) window.clearTimeout(pulseClearRef.current);
    pulseClearRef.current = window.setTimeout(() => setMetricPulse({}), 900);
  }

  /** @returns true if this transition triggered game over (recovery exhausted). */
  function applyRiskTransition(
    prevSel: GameSelection,
    nextSel: GameSelection,
  ): boolean {
    const prevResult = computeGameState(prevSel);
    const nextResult = computeGameState(nextSel);
    const delta = riskDelta(prevResult.risks, nextResult.risks);
    setStructureImpactSeq((n) => n + 1);
    triggerMetricPulse(delta);

    const violated = hasDeployViolations(
      nextResult.risks,
      nextSel,
      nextResult.unsafeNoHumanOversight,
    );
    const wasViolated = hasDeployViolations(
      prevResult.risks,
      prevSel,
      prevResult.unsafeNoHumanOversight,
    );

    if (!violated) {
      setRecoveryGraceRemaining(null);
      return false;
    }
    if (!wasViolated) {
      setRecoveryGraceRemaining(RECOVERY_GRACE_MOVES);
      return false;
    }
    const cur = recoveryGraceRef.current ?? RECOVERY_GRACE_MOVES;
    const nextG = cur - 1;
    if (nextG < 0) {
      setDeployFailureReasons(
        getGameOverReasons(
          nextResult.risks,
          nextSel,
          nextResult.unsafeNoHumanOversight,
        ),
      );
      setRecoveryGraceRemaining(0);
      return true;
    }
    setRecoveryGraceRemaining(nextG);
    return false;
  }

  function runPostPlacement(
    prevSel: GameSelection,
    nextSel: GameSelection,
    cardId: string,
    cardTitle: string,
    cardType: CardType,
  ) {
    applyRiskTransition(prevSel, nextSel);
    setBlueMessage(getComponentProConMessage(cardId, cardTitle, cardType));
  }

  function pillarAllowedInSystem(p: Pillar): boolean {
    if (gameOver || deploySuccess) return false;
    if (p === "DATA") return buildStep === 0;
    if (p === "MODEL") return buildStep === 1;
    if (p === "CONTROL") return buildStep === 2;
    return false;
  }

  function canDragCardToSystem(card: GameCardDef): boolean {
    if (gameOver || deploySuccess) return false;
    if (card.pillar === "DATA") return buildStep === 0;
    if (card.pillar === "MODEL") return buildStep === 1;
    return buildStep === 2;
  }

  function handleDeploy() {
    const reasons = getGameOverReasons(risks, selection, unsafeNoHumanOversight);
    if (reasons.length > 0) {
      setBlueMessage(
        "Deploy is locked until every meter is in a safe band — adjust the stack, then try again.",
      );
      return;
    }
    setDeploySuccess(true);
    setDeployFailureReasons(null);
    setRecoveryGraceRemaining(null);
  }

  function handleGameOverUndo() {
    setDeployFailureReasons(null);
    setRecoveryGraceRemaining(null);
    if (undoStack.length > 0) {
      undoLastMove();
    }
  }

  function dismissSuccessSummary() {
    setDeploySuccess(false);
  }

  function saveSnapshotBeforeMove() {
    const s = selectionRef.current;
    const m = movesRef.current;
    setUndoStack((stack) => [
      ...stack,
      {
        selected_data: [...s.selected_data],
        selected_models: [...s.selected_models],
        selected_controls: [...s.selected_controls],
        moves: m,
      },
    ]);
  }

  function undoLastMove() {
    setRecoveryGraceRemaining(null);
    setBlueMessage(
      "Undid the last drop — meters match the earlier stack; drop a card to refresh this line.",
    );
    setUndoStack((stack) => {
      if (stack.length === 0) return stack;
      const snap = stack[stack.length - 1];
      setSelected_data(snap.selected_data);
      setSelected_models(snap.selected_models);
      setSelected_controls(snap.selected_controls);
      setMoves(snap.moves);
      return stack.slice(0, -1);
    });
  }

  function fullReset() {
    setSelectedId(null);
    setSelected_data([]);
    setSelected_models([]);
    setSelected_controls([]);
    setMoves(0);
    setUndoStack([]);
    setDeployFailureReasons(null);
    setDeploySuccess(false);
    setRecoveryGraceRemaining(null);
    setBlueMessage("");
    setStructureImpactSeq(0);
    setStructureImpactFlash(false);
    setMetricPulse({});
    clearDragState();
  }

  function handleSelect(id: string) {
    setSelectedId((prev) => (prev === id ? null : id));
  }

  function clearDragState() {
    dragPillarRef.current = null;
    setDragging(null);
    setDragSource(null);
  }

  function handleLaneDragStart(card: GameCardDef) {
    return (e: React.DragEvent<HTMLDivElement>) => {
      if (gameOver || deploySuccess || !canDragCardToSystem(card)) {
        e.preventDefault();
        return;
      }
      const payload = JSON.stringify({ id: card.id, pillar: card.pillar });
      e.dataTransfer.setData(CARD_DRAG_MIME, payload);
      e.dataTransfer.setData("text/plain", card.id);
      e.dataTransfer.effectAllowed = "move";
      dragPillarRef.current = card.pillar;
      setDragSource("lane");
      setDragging(card.pillar);
    };
  }

  function handleLaneDragEnd() {
    clearDragState();
  }

  function handleSystemMiniDragStart(card: GameCardDef) {
    return (e: React.DragEvent<HTMLDivElement>) => {
      if (gameOver || deploySuccess) {
        e.preventDefault();
        return;
      }
      const payload = JSON.stringify({
        id: card.id,
        pillar: card.pillar,
        fromSystem: true,
      });
      e.dataTransfer.setData(CARD_DRAG_MIME, payload);
      e.dataTransfer.setData("text/plain", card.id);
      e.dataTransfer.effectAllowed = "move";
      dragPillarRef.current = card.pillar;
      setDragSource("system");
      setDragging(card.pillar);
    };
  }

  function handleSystemMiniDragEnd() {
    clearDragState();
  }

  function handleSystemZoneDragOver(e: React.DragEvent) {
    if (gameOver || deploySuccess) return;
    if (dragSource === "system") return;
    const p = dragPillarRef.current;
    if (!p || !pillarAllowedInSystem(p)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }

  function applyDataToSystem(payload: { id: string; pillar: Pillar }) {
    if (payload.pillar !== "DATA" || buildStep !== 0) return;
    const prevSel: GameSelection = { ...selectionRef.current };
    const def = CARD_BY_ID[payload.id];
    const nextSel: GameSelection = {
      selected_data: [payload.id],
      selected_models: [],
      selected_controls: [],
    };
    saveSnapshotBeforeMove();
    runPostPlacement(prevSel, nextSel, def.id, def.title, def.type);
    setSelected_data(nextSel.selected_data);
    setSelected_models(nextSel.selected_models);
    setSelected_controls(nextSel.selected_controls);
    setDeploySuccess(false);
    setMoves((m) => m + 1);
    clearDragState();
  }

  function applyModelToSystem(payload: { id: string; pillar: Pillar }) {
    if (payload.pillar !== "MODEL" || buildStep !== 1) return;
    const prevSel: GameSelection = { ...selectionRef.current };
    const def = CARD_BY_ID[payload.id];
    const nextSel: GameSelection = {
      selected_data: [...prevSel.selected_data],
      selected_models: [payload.id],
      selected_controls: [...prevSel.selected_controls],
    };
    saveSnapshotBeforeMove();
    runPostPlacement(prevSel, nextSel, def.id, def.title, def.type);
    setSelected_models([payload.id]);
    setDeploySuccess(false);
    setMoves((m) => m + 1);
    clearDragState();
  }

  function applyControlToSystem(payload: { id: string; pillar: Pillar }) {
    if (payload.pillar !== "CONTROL" || buildStep !== 2) return;
    const prevSel: GameSelection = { ...selectionRef.current };
    if (prevSel.selected_controls.includes(payload.id)) {
      clearDragState();
      return;
    }
    const def = CARD_BY_ID[payload.id];
    const nextSel: GameSelection = {
      ...prevSel,
      selected_controls: [...prevSel.selected_controls, payload.id],
    };
    saveSnapshotBeforeMove();
    runPostPlacement(prevSel, nextSel, def.id, def.title, def.type);
    setSelected_controls(nextSel.selected_controls);
    setDeploySuccess(false);
    setMoves((m) => m + 1);
    clearDragState();
  }

  function handleSystemZoneDrop(e: React.DragEvent) {
    e.preventDefault();
    if (gameOver || deploySuccess) return;
    const payload = parseCardDragPayload(e);
    if (!payload || payload.fromSystem) return;
    if (!pillarAllowedInSystem(payload.pillar)) return;
    if (payload.pillar === "DATA") {
      applyDataToSystem(payload);
      return;
    }
    if (payload.pillar === "CONTROL") {
      applyControlToSystem(payload);
      return;
    }
    if (payload.pillar === "MODEL") {
      applyModelToSystem(payload);
    }
  }

  const connectedNoControls =
    Boolean(placedData && placedModel && selected_controls.length === 0);

  const draggingAllowed =
    dragging != null &&
    dragSource === "lane" &&
    pillarAllowedInSystem(dragging);

  const systemMiniDraggable = !gameOver && !deploySuccess;

  function removePlacedFromSystem(
    prevSel: GameSelection,
    nextSel: GameSelection,
  ) {
    saveSnapshotBeforeMove();
    const triggeredGameOver = applyRiskTransition(prevSel, nextSel);
    if (!triggeredGameOver) {
      const nextResult = computeGameState(nextSel);
      const stillViolated = hasDeployViolations(
        nextResult.risks,
        nextSel,
        nextResult.unsafeNoHumanOversight,
      );
      if (stillViolated) {
        setRecoveryGraceRemaining((g) => {
          if (g === null) return null;
          return Math.min(RECOVERY_GRACE_MOVES, g + 1);
        });
      }
    }
    setBlueMessage("");
    setDeploySuccess(false);
    setMoves((m) => m + 1);
    clearDragState();
  }

  function removeDataFromSystem(payload: { id: string; pillar: Pillar }) {
    if (payload.pillar !== "DATA" || payload.id !== systemDataId) return;
    const prevSel: GameSelection = { ...selectionRef.current };
    const nextSel: GameSelection = {
      selected_data: [],
      selected_models: [],
      selected_controls: [],
    };
    removePlacedFromSystem(prevSel, nextSel);
    setSelected_data(nextSel.selected_data);
    setSelected_models(nextSel.selected_models);
    setSelected_controls(nextSel.selected_controls);
  }

  function removeModelFromSystem(payload: { id: string; pillar: Pillar }) {
    if (payload.pillar !== "MODEL" || payload.id !== systemModelId) return;
    const prevSel: GameSelection = { ...selectionRef.current };
    const nextSel: GameSelection = {
      selected_data: [...prevSel.selected_data],
      selected_models: [],
      selected_controls: [],
    };
    removePlacedFromSystem(prevSel, nextSel);
    setSelected_models(nextSel.selected_models);
    setSelected_controls(nextSel.selected_controls);
  }

  function removeControlFromSystem(payload: { id: string; pillar: Pillar }) {
    if (payload.pillar !== "CONTROL") return;
    const prevSel: GameSelection = { ...selectionRef.current };
    if (!prevSel.selected_controls.includes(payload.id)) return;
    const nextSel: GameSelection = {
      ...prevSel,
      selected_controls: prevSel.selected_controls.filter(
        (id) => id !== payload.id,
      ),
    };
    removePlacedFromSystem(prevSel, nextSel);
    setSelected_controls(nextSel.selected_controls);
  }

  function handleColumnDragOver(pillar: Pillar) {
    return (e: React.DragEvent) => {
      if (gameOver || deploySuccess) return;
      if (dragSource !== "system" || dragging !== pillar) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    };
  }

  function handleColumnDrop(pillar: Pillar) {
    return (e: React.DragEvent) => {
      e.preventDefault();
      if (gameOver || deploySuccess) return;
      const payload = parseCardDragPayload(e);
      if (!payload || !payload.fromSystem || payload.pillar !== pillar) return;
      if (pillar === "DATA") {
        removeDataFromSystem(payload);
        return;
      }
      if (pillar === "MODEL") {
        removeModelFromSystem(payload);
        return;
      }
      removeControlFromSystem(payload);
    };
  }

  const systemChainClass =
    "system-chain" +
    (placedData && placedModel ? " system-chain--connected" : "") +
    (placedData && !placedModel ? " system-chain--foundation-only" : "") +
    (gameOver ? " system-chain--collapsed" : "") +
    (deploySuccess ? " system-chain--settled" : "") +
    (selected_controls.length > 0 ? " system-chain--has-stabilisers" : "") +
    ` system-chain--stability-${structureVisualTier}` +
    ` system-chain--foundation-${foundationVisual}` +
    ` system-chain--model-${modelWeightVisual}`;

  const systemZoneClass =
    "system-zone" +
    (draggingAllowed ? " system-zone--drop-ready" : "") +
    (hasSystemContent ? " system-zone--has-stack" : "") +
    (headlineTier === "unstable" &&
    hasSystemContent &&
    !gameOver &&
    !deploySuccess
      ? " system-zone--unstable"
      : "") +
    (structureVisualTier === "at_risk" &&
    towerBuilt &&
    !gameOver &&
    !deploySuccess
      ? " system-zone--structure-at-risk"
      : "") +
    (structureImpactFlash ? " system-zone--structure-impact" : "") +
    (connectedNoControls && !deploySuccess ? " system-zone--unshielded" : "");

  const systemZoneAria =
    buildStep === 0
      ? "System: drop a Data card here next."
      : buildStep === 1
        ? "System: drop a Model card here next."
        : "System: drop Control cards here, then Deploy when ready.";

  const activeLaneSet = useMemo(() => {
    if (gameOver || deploySuccess) return new Set<Pillar>();
    if (buildStep === 0) return new Set<Pillar>(["DATA"]);
    if (buildStep === 1) return new Set<Pillar>(["MODEL"]);
    return new Set<Pillar>(["CONTROL"]);
  }, [buildStep, deploySuccess, gameOver]);

  function columnClass(pillar: Pillar) {
    const returnDrop =
      dragSource === "system" &&
      dragging === pillar &&
      !gameOver &&
      !deploySuccess;
    return (
      "column" +
      (activeLaneSet.has(pillar) ? " column--needs-action" : "") +
      (returnDrop ? " column--accept-return" : "")
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <button type="button" className="menu-btn" aria-label="Open menu">
            <Menu size={20} strokeWidth={1.5} aria-hidden />
          </button>
          <div className="title-block">
            <h1 className="app-title">Customer Email Classification</h1>
            <p className="app-subtitle">
              Categorize incoming customer support emails for routing
            </p>
          </div>
        </div>
        <button
          type="button"
          className="header-palette"
          aria-label="Theme palette"
        />
      </header>

      <div
        className={`subheader subheader--narrative${
          gameOver ? " subheader--alert" : ""
        }${
          headlineTier === "unstable" &&
          hasSystemContent &&
          !gameOver &&
          !deploySuccess
            ? " subheader--unstable"
            : ""
        }`}
        role="region"
        aria-label="Scenario or component trade-off"
      >
        <p
          className="subheader-single"
          aria-live={gameOver ? "assertive" : "polite"}
        >
          {gameOver
            ? "Run ended — limits held; undo or restart from the dialog (details in the overlay)."
            : deploySuccess
              ? "Deploy cleared — open the summary overlay for domain feedback and insights."
              : !hasSystemContent
                ? SCENARIO_ONLY
                : blueMessage ||
                  "Drop a card into System to see that component's trade-offs here."}
        </p>
      </div>

      <section
        className="stats-row"
        aria-label="System pressure by dimension"
      >
        {RISK_ORDER.map((key) => (
          <StatMetricCard
            key={key}
            riskKey={key}
            value={risks[key]}
            pulse={metricPulse}
            live={hasSystemContent}
          />
        ))}
      </section>

      <main className="app-main">
        <section
          className="system-strip"
          aria-label="System build area"
        >
          <h2 className="system-strip__title">System</h2>
          <div
            className={systemZoneClass}
            data-drop-target="system"
            aria-label={systemZoneAria}
            onDragOver={handleSystemZoneDragOver}
            onDrop={handleSystemZoneDrop}
          >
            <div className="system-zone__content">
              {!hasSystemContent && (
                <Rocket
                  className="system-zone__placeholder-icon"
                  strokeWidth={1}
                  aria-hidden
                />
              )}
              {hasSystemContent && (
                <div
                  className={systemChainClass}
                  data-structure-stability={structureVisualTier}
                >
                  <div
                    className="system-chain__tower"
                    style={towerSwingVars}
                  >
                    <div className="system-chain__row">
                      {placedData && (
                        <div
                          className="system-anchor system-anchor--data"
                          role="group"
                          aria-label="Data in system"
                        >
                          <SystemMiniCard
                            card={placedData}
                            draggable={systemMiniDraggable}
                            onDragStart={handleSystemMiniDragStart(placedData)}
                            onDragEnd={handleSystemMiniDragEnd}
                          />
                        </div>
                      )}
                      {placedData && placedModel && (
                        <div className="system-chain__bridge" aria-hidden="true">
                          <span className="system-chain__line" />
                          <Link2
                            className="system-chain__icon"
                            strokeWidth={2}
                            size={18}
                          />
                          <span className="system-chain__line" />
                        </div>
                      )}
                      {placedModel && (
                        <div
                          className="system-chain__model-wrap"
                          aria-label="Model in system"
                        >
                          <SystemMiniCard
                            card={placedModel}
                            draggable={systemMiniDraggable}
                            onDragStart={handleSystemMiniDragStart(placedModel)}
                            onDragEnd={handleSystemMiniDragEnd}
                          />
                        </div>
                      )}
                    </div>
                    {placedData && placedModel && (
                      <p className="system-chain__status">
                        <span className="system-chain__status-dot" />
                        Connected
                      </p>
                    )}
                  </div>
                  {selected_controls.length > 0 && (
                    <div
                      className="system-chain__row system-chain__row--controls"
                      aria-label="Controls in system"
                    >
                      {selected_controls.map((cid) => {
                        const c = findViewCard(cid);
                        return c ? (
                          <SystemMiniCard
                            key={cid}
                            card={c}
                            draggable={systemMiniDraggable}
                            onDragStart={handleSystemMiniDragStart(c)}
                            onDragEnd={handleSystemMiniDragEnd}
                          />
                        ) : null;
                      })}
                    </div>
                  )}
                  {placedData && placedModel && !deploySuccess && (
                    <div className="system-zone__deploy">
                      <button
                        type="button"
                        className={
                          "system-deploy-btn" +
                          (deployViolationsNow
                            ? " system-deploy-btn--blocked"
                            : "")
                        }
                        onClick={handleDeploy}
                        disabled={deployViolationsNow}
                        title={
                          deployViolationsNow
                            ? "Stabilise the system before deploy."
                            : undefined
                        }
                      >
                        <Rocket
                          className="system-deploy-btn__icon"
                          strokeWidth={1.75}
                          aria-hidden
                        />
                        <span>Deploy</span>
                      </button>
                    </div>
                  )}
                  {deploySuccess && (
                    <p className="system-zone__deployed-msg">
                      Deployed successfully
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>

        <div className="board-wrap">
          <div
            className="board"
            role="group"
            aria-label="Data, model, and controls"
          >
            <div
              className={columnClass("DATA")}
              data-active-lane={activeLaneSet.has("DATA") ? "true" : undefined}
              onDragOver={handleColumnDragOver("DATA")}
              onDrop={handleColumnDrop("DATA")}
            >
              <h2 className="column-title">Data</h2>
              {DATA_CARDS.filter((c) => !selected_data.includes(c.id)).map(
                (c) => (
                  <GameCard
                    key={c.id}
                    card={c}
                    selected={selectedId === c.id}
                    onSelect={() => handleSelect(c.id)}
                    draggable={canDragCardToSystem(c)}
                    onDragStart={handleLaneDragStart(c)}
                    onDragEnd={handleLaneDragEnd}
                  />
                ),
              )}
            </div>
            <div
              className={columnClass("MODEL")}
              data-active-lane={activeLaneSet.has("MODEL") ? "true" : undefined}
              onDragOver={handleColumnDragOver("MODEL")}
              onDrop={handleColumnDrop("MODEL")}
            >
              <h2 className="column-title">Model</h2>
              {MODEL_CARDS.filter((c) => !selected_models.includes(c.id)).map(
                (c) => (
                  <GameCard
                    key={c.id}
                    card={c}
                    selected={selectedId === c.id}
                    onSelect={() => handleSelect(c.id)}
                    draggable={canDragCardToSystem(c)}
                    onDragStart={handleLaneDragStart(c)}
                    onDragEnd={handleLaneDragEnd}
                  />
                ),
              )}
            </div>
            <div
              className={columnClass("CONTROL")}
              data-active-lane={activeLaneSet.has("CONTROL") ? "true" : undefined}
              onDragOver={handleColumnDragOver("CONTROL")}
              onDrop={handleColumnDrop("CONTROL")}
            >
              <h2 className="column-title">Controls</h2>
              {CONTROL_CARDS.filter((c) => !selected_controls.includes(c.id)).map(
                (c) => (
                  <GameCard
                    key={c.id}
                    card={c}
                    selected={selectedId === c.id}
                    onSelect={() => handleSelect(c.id)}
                    draggable={canDragCardToSystem(c)}
                    onDragStart={handleLaneDragStart(c)}
                    onDragEnd={handleLaneDragEnd}
                  />
                ),
              )}
            </div>
          </div>
        </div>

        {gameOver && deployFailureReasons && (
          <div
            className="game-over-overlay"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="game-over-title"
          >
            <div className="game-over-panel">
              <h2 id="game-over-title">Run ended — limits held</h2>
              <p className="game-over-lead">
                The recovery window closed before the stack came back in range.
              </p>
              {failureSummary && (
                <>
                  <p className="game-over-section-label">Readout</p>
                  <ul className="game-over-domains">
                    {failureSummary.domains.map((d) => (
                      <li key={d.id}>{d.blurb}</li>
                    ))}
                  </ul>
                  <p className="game-over-section-label">Insights</p>
                  <ul className="game-over-insights">
                    {failureSummary.insights.map((line, i) => (
                      <li key={`in-${i}`}>{line}</li>
                    ))}
                  </ul>
                </>
              )}
              <p className="game-over-section-label game-over-section-label--muted">
                Technical detail
              </p>
              <ul className="game-over-technical">
                {deployFailureReasons.map((r, i) => (
                  <li key={`${i}-${r}`}>{r}</li>
                ))}
              </ul>
              <div className="game-over-actions">
                <button
                  type="button"
                  className="game-over-btn-primary"
                  onClick={handleGameOverUndo}
                >
                  {undoStack.length > 0
                    ? "Undo last move"
                    : "Back to build"}
                </button>
                <button
                  type="button"
                  className="game-over-btn-secondary"
                  onClick={fullReset}
                >
                  Start again
                </button>
              </div>
            </div>
          </div>
        )}

        {deploySuccess && successSummary && (
          <div
            className="success-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="success-title"
          >
            <div className="success-panel">
              <h2 id="success-title">Deploy cleared</h2>
              <p className="success-lead">
                Outcome: success. Here is how the build reads—still no live scores,
                just narrative readouts.
              </p>
              <p className="success-section-label">Domains</p>
              <ul className="success-domains">
                {successSummary.domains.map((d) => (
                  <li key={d.id}>{d.blurb}</li>
                ))}
              </ul>
              <p className="success-section-label">Insights</p>
              <ul className="success-insights">
                {successSummary.insights.map((line, i) => (
                  <li key={`s-${i}`}>{line}</li>
                ))}
              </ul>
              <div className="success-actions">
                <button
                  type="button"
                  className="success-btn-primary"
                  onClick={fullReset}
                >
                  New run
                </button>
                <button
                  type="button"
                  className="success-btn-secondary"
                  onClick={dismissSuccessSummary}
                >
                  Close summary
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      <footer className="app-footer">
        <nav
          className="footer-actions footer-actions--no-deploy"
          aria-label="Game actions"
        >
          <button type="button" className="footer-btn">
            <Settings className="footer-btn__icon" strokeWidth={1.5} aria-hidden />
            <span className="footer-btn__label">Settings</span>
          </button>
          <button type="button" className="footer-btn">
            <Calendar className="footer-btn__icon" strokeWidth={1.5} aria-hidden />
            <span className="footer-btn__label">Daily</span>
          </button>
          <button type="button" className="footer-btn">
            <Lightbulb className="footer-btn__icon" strokeWidth={1.5} aria-hidden />
            <span className="footer-btn__label">Hint</span>
          </button>
          <button
            type="button"
            className="footer-btn"
            onClick={fullReset}
          >
            <RotateCcw className="footer-btn__icon" strokeWidth={1.5} aria-hidden />
            <span className="footer-btn__label">Reset</span>
          </button>
        </nav>
        <div className="footer-brand">
          <ChevronLeft size={12} strokeWidth={2} aria-hidden />
          <span>AI Solitaire</span>
          <ChevronRight size={12} strokeWidth={2} aria-hidden />
        </div>
      </footer>
    </div>
  );
}
