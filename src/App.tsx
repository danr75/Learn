import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
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
  computeGameState,
  getGameOverReasons,
  STAT_FOOTERS,
  STAT_LABELS,
  type RiskKey,
} from "./gameEngine";
import "./App.css";

const CARD_DRAG_MIME = "application/x-legolearn-card";

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
} | null {
  try {
    const raw = e.dataTransfer.getData(CARD_DRAG_MIME);
    if (!raw) return null;
    const o = JSON.parse(raw) as { id?: string; pillar?: Pillar };
    if (!o.id || !o.pillar) return null;
    if (o.pillar !== "DATA" && o.pillar !== "MODEL" && o.pillar !== "CONTROL") {
      return null;
    }
    return { id: o.id, pillar: o.pillar };
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
  onDragStart?: (e: React.DragEvent<HTMLButtonElement>) => void;
  onDragEnd?: (e: React.DragEvent<HTMLButtonElement>) => void;
}) {
  const mod =
    card.pillar === "DATA"
      ? "game-card--data"
      : card.pillar === "MODEL"
        ? "game-card--model"
        : "game-card--control";
  const label = `${card.title}. ${card.description}`;

  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`game-card ${mod}${selected ? " game-card--selected" : ""}${draggable ? " game-card--draggable" : " game-card--lane-locked"}`}
      onClick={onSelect}
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
    </button>
  );
}

function SystemMiniCard({ card }: { card: GameCardDef }) {
  return (
    <div className="system-mini-card">
      <div className="system-mini-card__row">
        <span className="system-mini-card__pillar">{card.pillar}</span>
        <PillarIcon pillar={card.pillar} />
      </div>
      <p className="system-mini-card__title">{card.title}</p>
    </div>
  );
}

function formatTime(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
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
  const [seconds, setSeconds] = useState(91);
  const [selected_data, setSelected_data] = useState<string[]>([]);
  const [selected_models, setSelected_models] = useState<string[]>([]);
  const [selected_controls, setSelected_controls] = useState<string[]>([]);
  const [dragging, setDragging] = useState<Pillar | null>(null);
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

  const gameOver = deployFailureReasons !== null;

  useEffect(() => {
    selectionRef.current = selection;
    movesRef.current = moves;
  }, [selection, moves]);

  useEffect(() => {
    const id = window.setInterval(() => setSeconds((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const timeLabel = formatTime(seconds);

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

  const expectedPillar: Pillar | null =
    buildStep === 0 ? "DATA" : buildStep === 1 ? "MODEL" : "CONTROL";

  const subheaderContent = useMemo(() => {
    if (deploySuccess) {
      return {
        tip: "Deployed successfully — risks within thresholds.",
        next: null as string | null,
      };
    }
    if (gameOver) {
      return {
        tip: "Deployment failed. Use the dialog to undo or restart.",
        next: null as string | null,
      };
    }
    if (buildStep === 0) {
      return {
        tip: "Stacks run in three layers—data, then model, then controls. Your data source decides what the system learns from and drives quality, bias, and privacy before anything else runs.",
        next: "Next — Data card.",
      };
    }
    if (buildStep === 1) {
      const d = systemDataId ? CARD_BY_ID[systemDataId] : undefined;
      return {
        tip:
          d?.learningBlurb ??
          "Your data source is locked in. The model will read from this layer.",
        next: "Next — Model card.",
      };
    }
    const m = systemModelId ? CARD_BY_ID[systemModelId] : undefined;
    const lastControlId =
      selected_controls.length > 0
        ? selected_controls[selected_controls.length - 1]
        : undefined;
    const lastControl = lastControlId ? CARD_BY_ID[lastControlId] : undefined;
    return {
      tip:
        lastControl?.learningBlurb ??
        m?.learningBlurb ??
        "Controls reduce risk after data and model are connected.",
      next: "Next — Control card.",
    };
  }, [
    buildStep,
    deploySuccess,
    gameOver,
    selected_controls,
    systemDataId,
    systemModelId,
  ]);

  function pillarAllowedInSystem(p: Pillar): boolean {
    if (gameOver || deploySuccess) return false;
    return p === expectedPillar;
  }

  function canDragCardToSystem(card: GameCardDef): boolean {
    if (gameOver || deploySuccess) return false;
    return card.pillar === expectedPillar;
  }

  function handleDeploy() {
    const reasons = getGameOverReasons(risks, selection, unsafeNoHumanOversight);
    if (reasons.length > 0) {
      setDeployFailureReasons(reasons);
      return;
    }
    setDeploySuccess(true);
    setDeployFailureReasons(null);
  }

  function handleGameOverUndo() {
    setDeployFailureReasons(null);
    if (undoStack.length > 0) {
      undoLastMove();
    }
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
    setSeconds(91);
    setSelectedId(null);
    setSelected_data([]);
    setSelected_models([]);
    setSelected_controls([]);
    setMoves(0);
    setUndoStack([]);
    setDeployFailureReasons(null);
    setDeploySuccess(false);
  }

  function handleSelect(id: string) {
    setSelectedId((prev) => (prev === id ? null : id));
  }

  function handleLaneDragStart(card: GameCardDef) {
    return (e: React.DragEvent<HTMLButtonElement>) => {
      if (gameOver || deploySuccess || !canDragCardToSystem(card)) {
        e.preventDefault();
        return;
      }
      const payload = JSON.stringify({ id: card.id, pillar: card.pillar });
      e.dataTransfer.setData(CARD_DRAG_MIME, payload);
      e.dataTransfer.setData("text/plain", card.id);
      e.dataTransfer.effectAllowed = "move";
      dragPillarRef.current = card.pillar;
      setDragging(card.pillar);
    };
  }

  function handleLaneDragEnd() {
    dragPillarRef.current = null;
    setDragging(null);
  }

  function handleSystemZoneDragOver(e: React.DragEvent) {
    if (gameOver || deploySuccess) return;
    const p = dragPillarRef.current;
    if (!p || !pillarAllowedInSystem(p)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }

  function applyDataToSystem(payload: { id: string; pillar: Pillar }) {
    if (payload.pillar !== "DATA" || buildStep !== 0) return;
    saveSnapshotBeforeMove();
    setSelected_data([payload.id]);
    setSelected_models([]);
    setDeploySuccess(false);
    setMoves((m) => m + 1);
    dragPillarRef.current = null;
    setDragging(null);
  }

  function applyModelToSystem(payload: { id: string; pillar: Pillar }) {
    if (payload.pillar !== "MODEL" || buildStep !== 1) return;
    saveSnapshotBeforeMove();
    setSelected_models([payload.id]);
    setDeploySuccess(false);
    setMoves((m) => m + 1);
    dragPillarRef.current = null;
    setDragging(null);
  }

  function applyControlToSystem(payload: { id: string; pillar: Pillar }) {
    if (payload.pillar !== "CONTROL" || buildStep !== 2) return;
    const prev = selectionRef.current.selected_controls;
    if (prev.includes(payload.id)) {
      dragPillarRef.current = null;
      setDragging(null);
      return;
    }
    saveSnapshotBeforeMove();
    setSelected_controls((p) => [...p, payload.id]);
    setDeploySuccess(false);
    setMoves((m) => m + 1);
    dragPillarRef.current = null;
    setDragging(null);
  }

  function handleSystemZoneDrop(e: React.DragEvent) {
    e.preventDefault();
    if (gameOver || deploySuccess) return;
    const payload = parseCardDragPayload(e);
    if (!payload || !pillarAllowedInSystem(payload.pillar)) return;
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

  const hasSystemContent =
    Boolean(placedData) ||
    Boolean(placedModel) ||
    selected_controls.length > 0;

  const draggingAllowed =
    Boolean(dragging) &&
    expectedPillar !== null &&
    dragging === expectedPillar;

  const systemZoneClass =
    "system-zone" +
    (draggingAllowed ? " system-zone--drop-ready" : "") +
    (hasSystemContent ? " system-zone--has-stack" : "");

  const systemZoneAria =
    buildStep === 0
      ? "System: drop a Data card here next."
      : buildStep === 1
        ? "System: drop a Model card here next."
        : "System: drop Control cards here, then Deploy when ready.";

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
        <div className="header-metrics">
          <div className="metric">
            <span className="metric-label">STABILITY</span>
            <span className="metric-value metric-value--mint">50%</span>
          </div>
          <div className="metric">
            <span className="metric-label">MOVES</span>
            <span className="metric-value">{moves}</span>
          </div>
          <div className="metric">
            <span className="metric-label">TIME</span>
            <span className="metric-value">{timeLabel}</span>
          </div>
        </div>
        <button
          type="button"
          className="header-palette"
          aria-label="Theme palette"
        />
      </header>

      <div className={`subheader${gameOver ? " subheader--alert" : ""}`}>
        {subheaderContent.tip && (
          <p
            className="subheader-tip"
            aria-live={gameOver ? "assertive" : "polite"}
          >
            {subheaderContent.tip}
          </p>
        )}
        {subheaderContent.next && (
          <p className="subheader-next">{subheaderContent.next}</p>
        )}
      </div>

      <section
        className="stats-row"
        aria-label="Requirements and limits"
      >
        {RISK_ORDER.map((key) => (
          <div key={key} className="stat-card">
            <span className="stat-label">{STAT_LABELS[key]}</span>
            <span className="stat-value">{risks[key]}</span>
            <span className="stat-foot">{STAT_FOOTERS[key]}</span>
          </div>
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
          >
            <div
              className={
                "system-zone__drag-hit" +
                (dragging ? " system-zone__drag-hit--active" : "")
              }
              onDragOver={handleSystemZoneDragOver}
              onDrop={handleSystemZoneDrop}
            />
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
                  className={
                    "system-chain" +
                    (placedData && placedModel
                      ? " system-chain--connected"
                      : "")
                  }
                >
                  <div className="system-chain__row">
                    {placedData && (
                      <div
                        className="system-anchor system-anchor--data"
                        role="group"
                        aria-label="Data in system"
                      >
                        <SystemMiniCard card={placedData} />
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
                        <SystemMiniCard card={placedModel} />
                      </div>
                    )}
                  </div>
                  {placedData && placedModel && (
                    <p className="system-chain__status">
                      <span className="system-chain__status-dot" />
                      Connected
                    </p>
                  )}
                  {selected_controls.length > 0 && (
                    <div
                      className="system-chain__row system-chain__row--controls"
                      aria-label="Controls in system"
                    >
                      {selected_controls.map((cid) => {
                        const c = findViewCard(cid);
                        return c ? <SystemMiniCard key={cid} card={c} /> : null;
                      })}
                    </div>
                  )}
                  {placedData && placedModel && !deploySuccess && (
                    <div className="system-zone__deploy">
                      <button
                        type="button"
                        className="system-deploy-btn"
                        onClick={handleDeploy}
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
            aria-label="Data, model, controls, and risks"
          >
            <div className="column">
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
            <div className="column">
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
            <div className="column">
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
            <div className="column">
              <h2 className="column-title">Risks</h2>
              <div
                className="slot slot--risk"
                aria-label="Empty risks slot"
              >
                <AlertCircle className="slot-icon" strokeWidth={1} />
              </div>
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
              <h2 id="game-over-title">Deployment failed</h2>
              <p className="game-over-lead">
                Thresholds exceeded. Adjust your stack or undo.
              </p>
              <ul>
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
