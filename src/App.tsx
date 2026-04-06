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
  Layers,
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
  getMetricPresentation,
  getStructureFoundationVisual,
  getStructureModelWeightVisual,
  getSystemStateTier,
  type StructureFoundationVisual,
  type StructureModelWeightVisual,
  STAT_LABELS,
  type RiskKey,
  type SystemStateTier,
  cardBenchStrength,
  weakestOfferId,
} from "./gameEngine";
import "./App.css";

const CARD_DRAG_MIME = "application/x-legolearn-card";

/** Single line shown in the blue band before the first drop. */
const SCENARIO_ONLY =
  "Build a system to classify customer emails using internal data.";

type Pillar = "DATA" | "MODEL" | "CONTROL";

type GameCardDef = {
  id: string;
  pillar: Pillar;
  title: string;
  description: string;
  /** Teaching note for the blue instruction band (hint / detail). */
  learningBlurb: string;
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
    learningBlurb: c.learningBlurb,
    tags: c.tags,
  };
}

const RISK_ORDER: RiskKey[] = [
  "quality",
  "bias",
  "privacy",
  "automation",
  "hallucination",
];

const ALL_LANE_CARDS: GameCardDef[] = CARD_DEFINITIONS.map(toViewCard);

function findViewCard(id: string): GameCardDef | undefined {
  return ALL_LANE_CARDS.find((c) => c.id === id);
}

/** One continuous bridge under data↔model; more slots = wider bar. */
const BRICK_SLOTS = 10;

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeSeededRng(seed: string) {
  let state = hashSeed(seed) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

type LaneBundle = {
  visible: Record<Pillar, string[]>;
  deck: Record<Pillar, string[]>;
};

type DrawPileAnimState = {
  pillar: Pillar;
  weakestId: string;
  drawnId: string;
  phase: "highlight" | "fadeOut" | "entering";
};

function shuffleStringArray(ids: string[], seed: string): string[] {
  const arr = [...ids];
  const rnd = makeSeededRng(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Up to 2 face-up; rest in pile. If a pillar has only 2 cards total, use 1 + 1 so the draw pile stays usable. */
function splitVisibleAndDeck(ids: string[]): { visible: string[]; deck: string[] } {
  if (ids.length === 0) return { visible: [], deck: [] };
  if (ids.length === 1) return { visible: [...ids], deck: [] };
  if (ids.length === 2) return { visible: ids.slice(0, 1), deck: ids.slice(1) };
  return { visible: ids.slice(0, 2), deck: ids.slice(2) };
}

function createInitialLanes(): LaneBundle {
  const dataIds = shuffleStringArray(
    CARD_DEFINITIONS.filter((c) => c.type === "data").map((c) => c.id),
    "lane-init:data",
  );
  const modelIds = shuffleStringArray(
    CARD_DEFINITIONS.filter((c) => c.type === "model").map((c) => c.id),
    "lane-init:model",
  );
  const controlIds = shuffleStringArray(
    CARD_DEFINITIONS.filter((c) => c.type === "control").map((c) => c.id),
    "lane-init:control",
  );
  const dataSplit = splitVisibleAndDeck(dataIds);
  const modelSplit = splitVisibleAndDeck(modelIds);
  const controlSplit = splitVisibleAndDeck(controlIds);
  return {
    visible: {
      DATA: dataSplit.visible,
      MODEL: modelSplit.visible,
      CONTROL: controlSplit.visible,
    },
    deck: {
      DATA: dataSplit.deck,
      MODEL: modelSplit.deck,
      CONTROL: controlSplit.deck,
    },
  };
}

/** Deterministic random: which brick positions are solid (not left-to-right). */
function pickSolidBrickMask(
  slots: number,
  solidCount: number,
  seed: string,
): boolean[] {
  const mask = Array.from({ length: slots }, () => false);
  if (solidCount >= slots) {
    mask.fill(true);
    return mask;
  }
  if (solidCount <= 0) return mask;
  const rnd = makeSeededRng(`${seed}:solid`);
  const order = Array.from({ length: slots }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (let k = 0; k < solidCount; k++) {
    mask[order[k]] = true;
  }
  return mask;
}

function brickFallVars(slotIndex: number, seed: string): CSSProperties {
  const rnd = makeSeededRng(`${seed}:fall:${slotIndex}`);
  const dx = (rnd() - 0.5) * 34;
  const dy = 22 + rnd() * 16;
  const rot = (rnd() - 0.5) * 32;
  return {
    ["--brick-fall-x" as string]: `${dx}px`,
    ["--brick-fall-y" as string]: `${dy}px`,
    ["--brick-fall-rot" as string]: `${rot}deg`,
  };
}

function getStructureBrickCount(
  tier: SystemStateTier,
  controlCount: number,
  foundation: StructureFoundationVisual,
  modelWeight: StructureModelWeightVisual,
  deploySuccess: boolean,
): number {
  if (deploySuccess) return BRICK_SLOTS;
  let n = tier === "stable" ? 10 : tier === "at_risk" ? 6 : 2;
  n = Math.min(BRICK_SLOTS, n + controlCount);
  if (foundation === "strong") n = Math.min(BRICK_SLOTS, n + 1);
  if (foundation === "weak") n = Math.max(0, n - 1);
  if (modelWeight === "heavy") n = Math.max(0, n - 1);
  if (modelWeight === "light") n = Math.min(BRICK_SLOTS, n + 1);
  return Math.max(0, Math.min(BRICK_SLOTS, n));
}

function SystemContinuousBrickBridge({
  solidMask,
  layoutSeed,
  planksCollapseBurst,
}: {
  solidMask: boolean[];
  layoutSeed: string;
  planksCollapseBurst?: boolean;
}) {
  return (
    <div
      className={
        "system-chain__continuous-bridge__bricks system-chain__continuous-bridge__bricks--foot" +
        (planksCollapseBurst ? " system-bridge-planks--collapse-burst" : "")
      }
      aria-hidden
    >
      {solidMask.map((solid, i) => {
        const empty = !solid;
        const slotStyle: CSSProperties = {
          zIndex: i + 1,
          ...(empty ? brickFallVars(i, layoutSeed) : {}),
        };
        return (
          <div
            key={i}
            style={slotStyle}
            className={
              "system-brick-slot" +
              (empty ? " system-brick-slot--empty" : "")
            }
          >
            <span className="system-brick-shell" />
            <span className="system-brick-body" />
          </div>
        );
      })}
    </div>
  );
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
  onCardHint,
  draggable = false,
  onDragStart,
  onDragEnd,
  drawPileWeakestEdge = false,
  drawPileFadeOut = false,
  drawPileEnter = false,
}: {
  card: GameCardDef;
  selected: boolean;
  onSelect: () => void;
  onCardHint: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd?: (e: React.DragEvent<HTMLDivElement>) => void;
  /** Yellow edge only during Draw pile animation for this card (weakest). */
  drawPileWeakestEdge?: boolean;
  drawPileFadeOut?: boolean;
  drawPileEnter?: boolean;
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

  function handleHintPointerDown(e: React.PointerEvent) {
    e.stopPropagation();
  }

  function handleHintClick(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    onCardHint();
  }

  const titleId = `game-card-title-${card.id}`;

  return (
    <div
      className={`game-card ${mod}${selected ? " game-card--selected" : ""}${draggable ? " game-card--draggable" : " game-card--lane-locked"}${drawPileWeakestEdge ? " game-card--weakest-takeout" : ""}${drawPileFadeOut ? " game-card--draw-fade-out" : ""}${drawPileEnter ? " game-card--draw-enter" : ""}`}
      role="group"
      aria-labelledby={titleId}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div
        className="game-card__body"
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-label={label}
        onClick={onSelect}
        onKeyDown={handleKeyDown}
      >
        <div className="game-card__meta">
          <span className="game-card__pillar">{card.pillar}</span>
        </div>
        <h3 id={titleId} className="game-card__title">
          {card.title}
        </h3>
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
      <span className="game-card__pillar-icon" aria-hidden>
        <PillarIcon pillar={card.pillar} />
      </span>
      <button
        type="button"
        className="game-card__hint"
        aria-label={`Hint: more detail about ${card.title}`}
        onClick={handleHintClick}
        onPointerDown={handleHintPointerDown}
      >
        <Lightbulb className="game-card__hint-icon" strokeWidth={1.5} aria-hidden />
      </button>
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

export default function App() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected_data, setSelected_data] = useState<string[]>([]);
  const [selected_models, setSelected_models] = useState<string[]>([]);
  const [selected_controls, setSelected_controls] = useState<string[]>([]);
  const [dragging, setDragging] = useState<Pillar | null>(null);
  const [dragSource, setDragSource] = useState<"lane" | "system" | null>(null);
  const dragPillarRef = useRef<Pillar | null>(null);
  const selectionRef = useRef({
    selected_data,
    selected_models,
    selected_controls,
  });

  const selection = useMemo(
    () => ({ selected_data, selected_models, selected_controls }),
    [selected_data, selected_models, selected_controls],
  );

  const { risks, unsafeNoHumanOversight } = useMemo(
    () => computeGameState(selection),
    [selection],
  );

  const [deploySuccess, setDeploySuccess] = useState(false);
  const [blueMessage, setBlueMessage] = useState("");
  const [structureImpactSeq, setStructureImpactSeq] = useState(0);
  const [structureImpactFlash, setStructureImpactFlash] = useState(false);
  const [deployWalk, setDeployWalk] = useState<"cross" | "fall" | null>(null);
  const [deployUnstableOutcome, setDeployUnstableOutcome] = useState(false);
  const [deployPlanksCollapse, setDeployPlanksCollapse] = useState(false);
  const deployWalkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [laneState, setLaneState] = useState<LaneBundle>(() =>
    createInitialLanes(),
  );
  const [drawPileUsedByPillar, setDrawPileUsedByPillar] = useState<
    Record<Pillar, boolean>
  >({
    DATA: false,
    MODEL: false,
    CONTROL: false,
  });
  const [drawPileAnim, setDrawPileAnim] = useState<DrawPileAnimState | null>(
    null,
  );
  const drawAnimTimersRef = useRef<number[]>([]);
  const drawPileRunningRef = useRef(false);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  useEffect(() => {
    return () => {
      clearDeployAnimTimers();
      drawAnimTimersRef.current.forEach((id) => window.clearTimeout(id));
      drawAnimTimersRef.current = [];
      drawPileRunningRef.current = false;
    };
  }, []);

  function clearDeployAnimTimers() {
    if (deployWalkTimerRef.current) {
      window.clearTimeout(deployWalkTimerRef.current);
      deployWalkTimerRef.current = null;
    }
  }

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

  const towerBuilt = Boolean(placedData && placedModel);

  const structureVisualTier = useMemo((): SystemStateTier => {
    if (!towerBuilt) return "stable";
    if (deploySuccess && !deployUnstableOutcome) return "stable";
    if (deploySuccess && deployUnstableOutcome) return headlineTier;
    return headlineTier;
  }, [deploySuccess, deployUnstableOutcome, towerBuilt, headlineTier]);

  const foundationVisual = useMemo(
    () => getStructureFoundationVisual(systemDataId ?? undefined),
    [systemDataId],
  );

  const modelWeightVisual = useMemo(
    () => getStructureModelWeightVisual(systemModelId ?? undefined),
    [systemModelId],
  );

  const continuousBrickCount = useMemo(
    () =>
      getStructureBrickCount(
        structureVisualTier,
        selected_controls.length,
        foundationVisual,
        modelWeightVisual,
        deploySuccess,
      ),
    [
      structureVisualTier,
      selected_controls.length,
      foundationVisual,
      modelWeightVisual,
      deploySuccess,
    ],
  );

  const brickLayoutSeed = useMemo(
    () =>
      JSON.stringify({
        selected_data,
        selected_models,
        selected_controls,
        structureVisualTier,
        deploySuccess,
      }),
    [
      selected_data,
      selected_models,
      selected_controls,
      structureVisualTier,
      deploySuccess,
    ],
  );

  const solidBrickMask = useMemo(
    () =>
      pickSolidBrickMask(
        BRICK_SLOTS,
        continuousBrickCount,
        brickLayoutSeed + `|n=${continuousBrickCount}`,
      ),
    [brickLayoutSeed, continuousBrickCount],
  );

  const displayBrickMask = useMemo(() => {
    if (deployPlanksCollapse || (deploySuccess && deployUnstableOutcome)) {
      return Array.from({ length: BRICK_SLOTS }, () => false);
    }
    return solidBrickMask;
  }, [
    deployPlanksCollapse,
    deploySuccess,
    deployUnstableOutcome,
    solidBrickMask,
  ]);

  const successSummary = useMemo(
    () =>
      deploySuccess && !deployUnstableOutcome
        ? buildEndgameSummary(
            true,
            risks,
            selection,
            unsafeNoHumanOversight,
            [],
          )
        : null,
    [deploySuccess, deployUnstableOutcome, risks, selection, unsafeNoHumanOversight],
  );

  function applyRiskTransition(_prevSel: GameSelection, _nextSel: GameSelection) {
    setStructureImpactSeq((n) => n + 1);
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
    if (deploySuccess) return false;
    if (p === "DATA") return buildStep === 0;
    if (p === "MODEL") return buildStep === 1;
    if (p === "CONTROL") return buildStep === 2;
    return false;
  }

  function canDragCardToSystem(card: GameCardDef): boolean {
    if (deploySuccess) return false;
    if (card.pillar === "DATA") return buildStep === 0;
    if (card.pillar === "MODEL") return buildStep === 1;
    return buildStep === 2;
  }

  function handleDeploy() {
    if (deployWalk !== null) return;

    const stableDeploy = headlineTier === "stable";
    setDeployWalk(stableDeploy ? "cross" : "fall");
    setDeployUnstableOutcome(false);
    setDeployPlanksCollapse(false);

    const walkMs = stableDeploy ? 1350 : 1550;
    const plankFallMs = 700;

    clearDeployAnimTimers();
    deployWalkTimerRef.current = window.setTimeout(() => {
      setDeployWalk(null);
      if (!stableDeploy) {
        setDeployPlanksCollapse(true);
        deployWalkTimerRef.current = window.setTimeout(() => {
          deployWalkTimerRef.current = null;
          setDeployUnstableOutcome(true);
          setDeploySuccess(true);
        }, plankFallMs);
      } else {
        deployWalkTimerRef.current = null;
        setDeploySuccess(true);
      }
    }, walkMs);
  }

  function dismissSuccessSummary() {
    clearDeployAnimTimers();
    setDeployWalk(null);
    setDeployUnstableOutcome(false);
    setDeployPlanksCollapse(false);
    setDeploySuccess(false);
  }

  function fullReset() {
    setSelectedId(null);
    setSelected_data([]);
    setSelected_models([]);
    setSelected_controls([]);
    setDeploySuccess(false);
    setBlueMessage("");
    setStructureImpactSeq(0);
    setStructureImpactFlash(false);
    clearDeployAnimTimers();
    setDeployWalk(null);
    setDeployUnstableOutcome(false);
    setDeployPlanksCollapse(false);
    setLaneState(createInitialLanes());
    setDrawPileUsedByPillar({
      DATA: false,
      MODEL: false,
      CONTROL: false,
    });
    setDrawPileAnim(null);
    drawAnimTimersRef.current.forEach((id) => window.clearTimeout(id));
    drawAnimTimersRef.current = [];
    drawPileRunningRef.current = false;
    clearDragState();
  }

  function consumeLaneCard(pillar: Pillar, placedId: string) {
    setLaneState((prev) => {
      const vis = prev.visible[pillar].filter((id) => id !== placedId);
      const deck = [...prev.deck[pillar]];
      const nextVis = [...vis];
      while (nextVis.length < 2 && deck.length > 0) {
        nextVis.push(deck.shift()!);
      }
      return {
        visible: { ...prev.visible, [pillar]: nextVis },
        deck: { ...prev.deck, [pillar]: deck },
      };
    });
  }

  function returnCardToLane(pillar: Pillar, cardId: string) {
    setLaneState((prev) => {
      const deck = [cardId, ...prev.deck[pillar]];
      const nextVis = [...prev.visible[pillar]];
      const d = [...deck];
      while (nextVis.length < 2 && d.length > 0) {
        nextVis.push(d.shift()!);
      }
      return {
        visible: { ...prev.visible, [pillar]: nextVis },
        deck: { ...prev.deck, [pillar]: d },
      };
    });
  }

  function clearDrawAnimTimers() {
    drawAnimTimersRef.current.forEach((id) => window.clearTimeout(id));
    drawAnimTimersRef.current = [];
  }

  function handleDrawPile(pillar: Pillar) {
    if (
      drawPileUsedByPillar[pillar] ||
      deploySuccess ||
      drawPileAnim ||
      drawPileRunningRef.current
    )
      return;
    clearDrawAnimTimers();

    setLaneState((prev) => {
      const vis = [...prev.visible[pillar]];
      const deck = [...prev.deck[pillar]];
      if (vis.length === 0 || deck.length === 0) return prev;
      const weakest = weakestOfferId(vis);
      if (!weakest) return prev;
      if (drawPileRunningRef.current) return prev;
      drawPileRunningRef.current = true;
      const without = vis.filter((id) => id !== weakest);
      const pool = [...deck, weakest];
      const ri = Math.floor(Math.random() * pool.length);
      const drawn = pool[ri];
      const newDeck = pool.filter((_, i) => i !== ri);
      const nextVis = [...without, drawn];
      const wDef = CARD_BY_ID[weakest];
      const dDef = CARD_BY_ID[drawn];

      queueMicrotask(() => {
        setDrawPileAnim({
          pillar,
          weakestId: weakest,
          drawnId: drawn,
          phase: "highlight",
        });
        const t1 = window.setTimeout(() => {
          setDrawPileAnim({
            pillar,
            weakestId: weakest,
            drawnId: drawn,
            phase: "fadeOut",
          });
        }, 170);
        const t2 = window.setTimeout(() => {
          setLaneState((p) => ({
            visible: { ...p.visible, [pillar]: nextVis },
            deck: { ...p.deck, [pillar]: newDeck },
          }));
          setDrawPileAnim({
            pillar,
            weakestId: weakest,
            drawnId: drawn,
            phase: "entering",
          });
        }, 170 + 400);
        const t3 = window.setTimeout(() => {
          setDrawPileAnim(null);
          const stronger =
            cardBenchStrength(dDef) >= cardBenchStrength(wDef);
          setBlueMessage(
            stronger
              ? "Your draw card makes your options stronger."
              : "Your draw card made your options weaker.",
          );
          setDrawPileUsedByPillar((prev) => ({ ...prev, [pillar]: true }));
          drawPileRunningRef.current = false;
        }, 170 + 400 + 520);
        drawAnimTimersRef.current = [t1, t2, t3];
      });

      return prev;
    });
  }

  function canUseDrawPile(pillar: Pillar): boolean {
    const laneMatchesBuildStep =
      (pillar === "DATA" && buildStep === 0) ||
      (pillar === "MODEL" && buildStep === 1) ||
      (pillar === "CONTROL" && buildStep === 2);
    return (
      !deploySuccess &&
      !drawPileUsedByPillar[pillar] &&
      drawPileAnim === null &&
      laneMatchesBuildStep &&
      laneState.visible[pillar].length > 0 &&
      laneState.deck[pillar].length > 0
    );
  }

  function drawPileCardProps(
    pillar: Pillar,
    cid: string,
  ): {
    drawPileWeakestEdge: boolean;
    drawPileFadeOut: boolean;
    drawPileEnter: boolean;
  } {
    if (!drawPileAnim || drawPileAnim.pillar !== pillar) {
      return {
        drawPileWeakestEdge: false,
        drawPileFadeOut: false,
        drawPileEnter: false,
      };
    }
    const { weakestId, drawnId, phase } = drawPileAnim;
    const isWeakest = cid === weakestId;
    const isDrawn = cid === drawnId;
    return {
      drawPileWeakestEdge:
        isWeakest && (phase === "highlight" || phase === "fadeOut"),
      drawPileFadeOut: isWeakest && phase === "fadeOut",
      drawPileEnter: isDrawn && phase === "entering",
    };
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
      if (deploySuccess || !canDragCardToSystem(card)) {
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
      if (deploySuccess) {
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
    if (deploySuccess) return;
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
    runPostPlacement(prevSel, nextSel, def.id, def.title, def.type);
    setSelected_data(nextSel.selected_data);
    setSelected_models(nextSel.selected_models);
    setSelected_controls(nextSel.selected_controls);
    consumeLaneCard("DATA", payload.id);
    setDeploySuccess(false);
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
    runPostPlacement(prevSel, nextSel, def.id, def.title, def.type);
    setSelected_models([payload.id]);
    consumeLaneCard("MODEL", payload.id);
    setDeploySuccess(false);
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
    runPostPlacement(prevSel, nextSel, def.id, def.title, def.type);
    setSelected_controls(nextSel.selected_controls);
    consumeLaneCard("CONTROL", payload.id);
    setDeploySuccess(false);
    clearDragState();
  }

  function handleSystemZoneDrop(e: React.DragEvent) {
    e.preventDefault();
    if (deploySuccess) return;
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

  const systemMiniDraggable = !deploySuccess;

  function removePlacedFromSystem(
    prevSel: GameSelection,
    nextSel: GameSelection,
  ) {
    applyRiskTransition(prevSel, nextSel);
    setBlueMessage("");
    setDeploySuccess(false);
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
    returnCardToLane("DATA", payload.id);
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
    returnCardToLane("MODEL", payload.id);
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
    returnCardToLane("CONTROL", payload.id);
  }

  function handleColumnDragOver(pillar: Pillar) {
    return (e: React.DragEvent) => {
      if (deploySuccess) return;
      if (dragSource !== "system" || dragging !== pillar) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    };
  }

  function handleColumnDrop(pillar: Pillar) {
    return (e: React.DragEvent) => {
      e.preventDefault();
      if (deploySuccess) return;
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
    (deploySuccess && !deployUnstableOutcome ? " system-chain--settled" : "") +
    (deployWalk !== null ? " system-chain--deploy-walk" : "") +
    (selected_controls.length > 0 ? " system-chain--has-stabilisers" : "") +
    ` system-chain--stability-${structureVisualTier}` +
    ` system-chain--foundation-${foundationVisual}` +
    ` system-chain--model-${modelWeightVisual}`;

  const systemZoneClass =
    "system-zone" +
    (draggingAllowed ? " system-zone--drop-ready" : "") +
    (hasSystemContent ? " system-zone--has-stack" : "") +
    (headlineTier === "unstable" && hasSystemContent && !deploySuccess
      ? " system-zone--unstable"
      : "") +
    (structureVisualTier === "at_risk" && towerBuilt && !deploySuccess
      ? " system-zone--structure-at-risk"
      : "") +
    (structureImpactFlash ? " system-zone--structure-impact" : "") +
    (connectedNoControls && !deploySuccess ? " system-zone--unshielded" : "");

  const systemZoneAria =
    buildStep === 0
      ? "System: drop a Data card here next."
      : buildStep === 1
        ? "System: drop a Model card here next."
        : "System: add Control cards if you want, or Deploy when ready.";

  const activeLaneSet = useMemo(() => {
    if (deploySuccess) return new Set<Pillar>();
    if (buildStep === 0) return new Set<Pillar>(["DATA"]);
    if (buildStep === 1) return new Set<Pillar>(["MODEL"]);
    return new Set<Pillar>(["CONTROL"]);
  }, [buildStep, deploySuccess]);

  function columnClass(pillar: Pillar) {
    const returnDrop =
      dragSource === "system" && dragging === pillar && !deploySuccess;
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
          className="menu-btn app-header__settings-btn"
          aria-label="Settings"
          title="Settings"
        >
          <Settings size={20} strokeWidth={1.5} aria-hidden />
        </button>
      </header>

      {!(deploySuccess && deployUnstableOutcome) && (
        <div
          className={`subheader subheader--narrative${
            headlineTier === "unstable" && hasSystemContent && !deploySuccess
              ? " subheader--unstable"
              : ""
          }`}
          role="region"
          aria-label="Scenario or component trade-off"
        >
          <p className="subheader-single subheader-single--pre" aria-live="polite">
            {deploySuccess
              ? "Deploy cleared — open the summary overlay for domain feedback and insights."
              : blueMessage !== ""
                ? blueMessage
                : !hasSystemContent
                  ? SCENARIO_ONLY
                  : "Drop a card into System to see that component's trade-offs here."}
          </p>
        </div>
      )}

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
                <div className="system-zone__placeholder">
                  <Rocket
                    className="system-zone__placeholder-icon"
                    strokeWidth={1}
                    aria-hidden
                  />
                  <p className="system-zone__placeholder-label">Drop Here</p>
                </div>
              )}
              {hasSystemContent && (
                <div
                  className={systemChainClass}
                  data-structure-stability={structureVisualTier}
                >
                  <div className="system-chain__tower">
                    <div className="system-chain__connected-strip">
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
                          <div
                            className="system-chain__bridge"
                            aria-hidden="true"
                          >
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
                              onDragStart={handleSystemMiniDragStart(
                                placedModel,
                              )}
                              onDragEnd={handleSystemMiniDragEnd}
                            />
                          </div>
                        )}
                      </div>
                      {placedData && placedModel && (
                        <div className="system-chain__continuous-bridge">
                          {deployWalk ? (
                            <span
                              className={`system-bridge-walker system-bridge-walker--${deployWalk}`}
                              aria-hidden
                            />
                          ) : null}
                          <SystemContinuousBrickBridge
                            solidMask={displayBrickMask}
                            layoutSeed={brickLayoutSeed}
                            planksCollapseBurst={deployPlanksCollapse}
                          />
                        </div>
                      )}
                    </div>
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
                        className="system-deploy-btn"
                        onClick={handleDeploy}
                        disabled={deployWalk !== null}
                        title={
                          deployWalk !== null ? "Crossing the bridge…" : undefined
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
                    <p
                      className={
                        "system-zone__deployed-msg" +
                        (deployUnstableOutcome
                          ? " system-zone__deployed-msg--unstable"
                          : "")
                      }
                    >
                      {deployUnstableOutcome
                        ? "System unstable"
                        : "Deployed successfully"}
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
              <div className="column__cards">
                {laneState.visible.DATA.map((cid) => {
                  const c = findViewCard(cid);
                  if (!c) return null;
                  return (
                    <GameCard
                      key={c.id}
                      card={c}
                      selected={selectedId === c.id}
                      onSelect={() => handleSelect(c.id)}
                      onCardHint={() =>
                        setBlueMessage(`${c.title} — ${c.learningBlurb}`)
                      }
                      draggable={canDragCardToSystem(c)}
                      onDragStart={handleLaneDragStart(c)}
                      onDragEnd={handleLaneDragEnd}
                      {...drawPileCardProps("DATA", cid)}
                    />
                  );
                })}
              </div>
              <button
                type="button"
                className="column-draw"
                disabled={!canUseDrawPile("DATA")}
                onClick={() => handleDrawPile("DATA")}
                aria-label="Data draw pile: while the Data column is active, removes the weakest visible card, then draws a random card from the pile. One use per column."
                title="Available while Data is the active column. Removes the weakest visible card, then draws a random card from the pile (once per column)."
              >
                <Layers className="column-draw__icon" strokeWidth={1.5} aria-hidden />
                <span className="column-draw__label">Draw pile</span>
                <span className="column-draw__meta">
                  {laneState.deck.DATA.length} in pile
                </span>
              </button>
            </div>
            <div
              className={columnClass("MODEL")}
              data-active-lane={activeLaneSet.has("MODEL") ? "true" : undefined}
              onDragOver={handleColumnDragOver("MODEL")}
              onDrop={handleColumnDrop("MODEL")}
            >
              <h2 className="column-title">Model</h2>
              <div className="column__cards">
                {laneState.visible.MODEL.map((cid) => {
                  const c = findViewCard(cid);
                  if (!c) return null;
                  return (
                    <GameCard
                      key={c.id}
                      card={c}
                      selected={selectedId === c.id}
                      onSelect={() => handleSelect(c.id)}
                      onCardHint={() =>
                        setBlueMessage(`${c.title} — ${c.learningBlurb}`)
                      }
                      draggable={canDragCardToSystem(c)}
                      onDragStart={handleLaneDragStart(c)}
                      onDragEnd={handleLaneDragEnd}
                      {...drawPileCardProps("MODEL", cid)}
                    />
                  );
                })}
              </div>
              <button
                type="button"
                className="column-draw"
                disabled={!canUseDrawPile("MODEL")}
                onClick={() => handleDrawPile("MODEL")}
                aria-label="Model draw pile: while the Model column is active, removes the weakest visible card, then draws a random card from the pile. One use per column."
                title="Available while Model is the active column. Removes the weakest visible card, then draws a random card from the pile (once per column)."
              >
                <Layers className="column-draw__icon" strokeWidth={1.5} aria-hidden />
                <span className="column-draw__label">Draw pile</span>
                <span className="column-draw__meta">
                  {laneState.deck.MODEL.length} in pile
                </span>
              </button>
            </div>
            <div
              className={columnClass("CONTROL")}
              data-active-lane={activeLaneSet.has("CONTROL") ? "true" : undefined}
              onDragOver={handleColumnDragOver("CONTROL")}
              onDrop={handleColumnDrop("CONTROL")}
            >
              <h2 className="column-title">Controls</h2>
              <div className="column__cards">
                {laneState.visible.CONTROL.map((cid) => {
                  const c = findViewCard(cid);
                  if (!c) return null;
                  return (
                    <GameCard
                      key={c.id}
                      card={c}
                      selected={selectedId === c.id}
                      onSelect={() => handleSelect(c.id)}
                      onCardHint={() =>
                        setBlueMessage(`${c.title} — ${c.learningBlurb}`)
                      }
                      draggable={canDragCardToSystem(c)}
                      onDragStart={handleLaneDragStart(c)}
                      onDragEnd={handleLaneDragEnd}
                      {...drawPileCardProps("CONTROL", cid)}
                    />
                  );
                })}
              </div>
              <button
                type="button"
                className="column-draw"
                disabled={!canUseDrawPile("CONTROL")}
                onClick={() => handleDrawPile("CONTROL")}
                aria-label="Controls draw pile: while the Controls column is active, removes the weakest visible card, then draws a random card from the pile. One use per column."
                title="Available while Controls is the active column. Removes the weakest visible card, then draws a random card from the pile (once per column)."
              >
                <Layers className="column-draw__icon" strokeWidth={1.5} aria-hidden />
                <span className="column-draw__label">Draw pile</span>
                <span className="column-draw__meta">
                  {laneState.deck.CONTROL.length} in pile
                </span>
              </button>
            </div>
          </div>
        </div>

        {deploySuccess && deployUnstableOutcome && (
          <div
            className="success-overlay success-overlay--unstable-deploy"
            role="dialog"
            aria-modal="true"
            aria-labelledby="unstable-deploy-title"
          >
            <div className="success-panel success-panel--unstable-deploy">
              <h2 id="unstable-deploy-title" className="success-panel__title-unstable">
                System unstable
              </h2>
              <p className="success-lead success-lead--unstable">
                Deploy went through a risky band — every plank dropped. Readout
                matches the row above, condensed.
              </p>
              <div
                className="deploy-unstable-metrics"
                aria-label="System pressure by dimension"
              >
                {RISK_ORDER.map((key) => {
                  const p = getMetricPresentation(key, risks[key]);
                  const trafficMod =
                    p.traffic === "green"
                      ? "ok"
                      : p.traffic === "amber"
                        ? "warn"
                        : "bad";
                  return (
                    <div
                      key={key}
                      className={`deploy-mini-metric deploy-mini-metric--${trafficMod}`}
                    >
                      <span className="deploy-mini-metric__label">
                        {STAT_LABELS[key]}
                      </span>
                      <div className="deploy-mini-metric__bar" aria-hidden>
                        <div
                          className="deploy-mini-metric__fill"
                          style={{
                            width: `${Math.round(p.barFill * 100)}%`,
                          }}
                        />
                      </div>
                      <span className="deploy-mini-metric__state">{p.label}</span>
                    </div>
                  );
                })}
              </div>
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

        {deploySuccess && !deployUnstableOutcome && successSummary && (
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
