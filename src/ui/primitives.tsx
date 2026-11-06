/**
 * Briques d'interface alignées sur Paperclip.
 *
 * Paperclip est construit avec shadcn/ui + Tailwind CSS v4. Sa feuille de
 * style n'est compilée qu'à partir de son propre code : une classe utilitaire
 * n'existe dans le navigateur que si l'hôte l'emploie déjà. Ces composants
 * reprennent donc mot pour mot les recettes de l'hôte (Button, Input, Command,
 * badges de statut…), relevées dans l'interface installée, et n'utilisent que
 * ses tokens (`bg-background`, `text-muted-foreground`, `border-border`,
 * `--status-task-icon-*`…). Aucune couleur ni dimension propre au plugin.
 *
 * `tests/ui-classes.test.ts` vérifie que chaque classe utilisée ici et dans
 * `index.tsx` existe dans la feuille de style de l'hôte.
 */
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  Ban,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleHelp,
  CircleMinus,
  CloudOff,
  Check,
  ChevronDown,
  Key,
  LoaderCircle,
  Search,
  type LucideIcon,
} from "lucide-react";
import { createPortal } from "react-dom";

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

// ── Button (recette `buttonVariants` de l'hôte) ─────────────────────────

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-(--tp-color-background-color-border-color-box-shadow-opacity) disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-(length:--rad-3) aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive";

const BUTTON_VARIANTS = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  outline:
    "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  ghost: "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
  link: "text-primary underline-offset-4 hover:underline",
} as const;

const BUTTON_SIZES = {
  default: "h-10 px-4 py-2 has-[>svg]:px-3",
  sm: "h-9 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
  xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
  "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
  "icon-sm": "size-9",
  // Boutons de la barre du haut : l'hôte y rend `Button` en `sm` avec `h-8`
  // (`launcherTriggerClassName`) ; sans tailwind-merge, `h-9` et `h-8`
  // cohabiteraient, d'où une taille dédiée.
  toolbar: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
  "icon-toolbar": "size-8",
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANTS;
export type ButtonSize = keyof typeof BUTTON_SIZES;

export function buttonClass(variant: ButtonVariant = "default", size: ButtonSize = "default", extra?: string): string {
  return cn(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], extra);
}

export function Button({
  variant = "default",
  size = "default",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} data-slot="button" className={buttonClass(variant, size, className)} {...props} />;
}

// ── Input (recette `Input` de l'hôte) ───────────────────────────────────

export const INPUT_CLASS = cn(
  "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-(--tp-color-box-shadow) outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
  "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-(length:--rad-3)",
  "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
);

// ── Command (recettes `Command*` de l'hôte : sélecteurs, palette) ───────

export function CommandRoot({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-slot="command" className={cn("bg-popover text-popover-foreground flex h-full w-full flex-col overflow-hidden rounded-md", className)}>
      {children}
    </div>
  );
}

export const CommandInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { trailing?: ReactNode; /** Trait sous le champ, quand la liste est affichée. */ divider?: boolean }
>(function CommandInput({ className, trailing, divider = true, ...props }, ref) {
    return (
      <div data-slot="command-input-wrapper" className={cn("flex h-9 items-center gap-2 px-3", divider && "border-b")}>
        <Search className="size-4 shrink-0 opacity-50" aria-hidden="true" />
        <input
          ref={ref}
          data-slot="command-input"
          className={cn(
            "placeholder:text-muted-foreground flex h-10 w-full rounded-md bg-transparent py-3 text-base md:text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
          {...props}
        />
        {trailing}
      </div>
    );
});

export function CommandList({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div data-slot="command-list" role="listbox" aria-label={label} className="max-h-(--sz-300px) scroll-py-1 overflow-x-hidden overflow-y-auto">
      {children}
    </div>
  );
}

export function CommandGroup({ heading, children }: { heading?: string; children: ReactNode }) {
  return (
    <div data-slot="command-group" className="text-foreground overflow-hidden p-1">
      {heading ? <div className="text-muted-foreground px-2 py-1.5 text-xs font-medium">{heading}</div> : null}
      {children}
    </div>
  );
}

export function CommandEmpty({ children }: { children: ReactNode }) {
  return (
    <div data-slot="command-empty" className="py-6 text-center text-sm">
      {children}
    </div>
  );
}

export const COMMAND_ITEM_CLASS =
  "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

/** Raccourci affiché à droite d'un élément (recette `CommandShortcut`). */
export function CommandShortcut({ children }: { children: ReactNode }) {
  return (
    <span data-slot="command-shortcut" className="text-muted-foreground ml-auto text-xs tracking-widest">
      {children}
    </span>
  );
}

// ── Filtre rapide (recette des « Quick filters » de la liste des tâches) ─

export function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

// ── Fenêtre (coque `LauncherModalShell` de l'hôte) ──────────────────────

/** Niveau de pile des fenêtres de launcher de l'hôte (`1000`, +20 par fenêtre empilée). */
const HOST_OVERLAY_Z = 1000;
/** Largeur des fenêtres `bounds: "default"` de l'hôte. */
const HOST_DIALOG_WIDTH = "min(40rem, calc(100vw - 2rem))";

/** Seuls styles en ligne du plugin : ceux que l'hôte pose lui-même sur ses fenêtres. */
export const HOST_DIALOG_STYLES: { backdrop: CSSProperties; dialog: CSSProperties } = {
  backdrop: { zIndex: HOST_OVERLAY_Z },
  dialog: { zIndex: HOST_OVERLAY_Z + 1, width: HOST_DIALOG_WIDTH },
};

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Fenêtre centrée, reprise mot pour mot de celle que Paperclip ouvre pour un
 * launcher `openModal` : voile, en-tête (titre, nom du plugin, « Close »),
 * Échap, clic à côté, focus sur le premier élément. Rendue dans `document.body`
 * pour échapper au débordement de la barre du haut.
 */
export function HostDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const first = ref.current?.querySelector<HTMLElement>(`[autofocus], ${FOCUSABLE}`);
      (first ?? ref.current)?.focus();
    });
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        closeRef.current();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return createPortal(
    <>
      <div
        className="fixed inset-0 bg-black/45"
        style={HOST_DIALOG_STYLES.backdrop}
        aria-hidden="true"
        onMouseDown={(e) => e.target === e.currentTarget && closeRef.current()}
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="fixed left-1/2 top-1/2 max-h-[calc(100vh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
        style={HOST_DIALOG_STYLES.dialog}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-sm font-semibold">
              {title}
            </h2>
            <p className="truncate text-xs text-muted-foreground">Jira link</p>
          </div>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => closeRef.current()}>
            Close
          </Button>
        </div>
        <div className="overflow-auto p-4 max-h-[calc(100vh-7rem)]">{children}</div>
      </div>
    </>,
    document.body,
  );
}

// ── Textes et encarts récurrents de l'hôte ──────────────────────────────

/** Titre de section, comme les en-têtes de rubrique de Paperclip. */
export function SectionHeader({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>
      {trailing ? <div className="ml-auto flex items-center gap-1">{trailing}</div> : null}
    </div>
  );
}

export function Muted({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-sm text-muted-foreground", className)}>{children}</p>;
}

export function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      {children}
    </div>
  );
}

/** Lien externe discret (identifiants), comme les identifiants de tâche de l'hôte. */
export function ExternalKey({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="shrink-0 font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
      {...props}
    >
      {children}
    </a>
  );
}

// ── Statut d'un ticket : même rendu que les objets externes de l'hôte ───

/** Catégories normalisées de l'hôte (voir `status.ts`). */
export type ExternalCategory =
  | "unknown"
  | "open"
  | "waiting"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "closed"
  | "archived"
  | "auth_required"
  | "unreachable";

/** Couleurs des objets externes de l'hôte (mêmes classes, texte seul). */
const EXTERNAL_TONE: Record<ExternalCategory, string> = {
  unknown: "text-muted-foreground",
  open: "text-blue-600 dark:text-blue-400",
  waiting: "text-amber-600 dark:text-amber-400",
  running: "text-blue-600 dark:text-blue-400",
  succeeded: "text-green-600 dark:text-green-400",
  failed: "text-red-600 dark:text-red-400",
  blocked: "text-red-600 dark:text-red-400",
  closed: "text-neutral-500",
  archived: "text-neutral-500",
  auth_required: "text-amber-600 dark:text-amber-400",
  unreachable: "text-red-600 dark:text-red-400",
};

const EXTERNAL_ICON: Record<ExternalCategory, LucideIcon> = {
  unknown: CircleHelp,
  open: CircleDot,
  waiting: CircleDashed,
  running: LoaderCircle,
  succeeded: CircleCheck,
  failed: CircleMinus,
  blocked: CircleMinus,
  closed: Circle,
  archived: Circle,
  auth_required: Key,
  unreachable: CloudOff,
};

/** Catégorie de statut Jira (`new` / `indeterminate` / `done`) → catégorie de l'hôte. */
export function categoryFromJira(statusCategoryKey: string | undefined): ExternalCategory {
  switch (statusCategoryKey) {
    case "new":
      return "open";
    case "indeterminate":
      return "running";
    case "done":
      return "closed";
    default:
      return "unknown";
  }
}

export function asExternalCategory(value: string): ExternalCategory {
  return value in EXTERNAL_TONE ? (value as ExternalCategory) : "unknown";
}

/** Pastille de statut d'un ticket, au format des objets externes de Paperclip. */
export function TicketStatus({ category, label }: { category: ExternalCategory; label: string }) {
  const Icon = EXTERNAL_ICON[category];
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-xs", EXTERNAL_TONE[category])} data-external-status={category}>
      {/* Couleur aussi sur l'icône : dans une liste, l'hôte grise les icônes sans classe `text-*`. */}
      <Icon aria-hidden="true" className={cn("h-3.5 w-3.5 shrink-0", EXTERNAL_TONE[category])} />
      <span className="truncate">{label}</span>
    </span>
  );
}

// ── Statut d'une tâche : même glyphe que la liste des tâches ────────────

const TASK_STATUS_LABELS: Record<string, string> = {
  backlog: "Backlog",
  todo: "À faire",
  in_progress: "En cours",
  in_review: "En revue",
  blocked: "Bloquée",
  done: "Terminée",
  cancelled: "Annulée",
};

export function taskStatusLabel(status: string): string {
  return TASK_STATUS_LABELS[status] ?? status;
}

/** Glyphe « en cours » de l'hôte : cercle à 80 %, qui tourne. */
function ProgressGlyph({ size, className, style }: { size: number; className?: string; style?: CSSProperties }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" pathLength={100} strokeDasharray="80 20" />
    </svg>
  );
}

const TASK_GLYPHS: Record<string, LucideIcon | "progress"> = {
  backlog: CircleDashed,
  todo: Circle,
  in_progress: "progress",
  in_review: CircleDot,
  done: CircleCheck,
  blocked: CircleMinus,
  cancelled: Ban,
};

/** Glyphe de statut de tâche, avec les couleurs `--status-task-icon-*` de l'hôte. */
export function TaskStatusGlyph({ status }: { status: string }) {
  const known = status in TASK_GLYPHS ? status : "backlog";
  const glyph = TASK_GLYPHS[known]!;
  const style: CSSProperties = { color: `var(--status-task-icon-${known})` };
  const className = cn("inline-block shrink-0 align-middle", known === "in_progress" && "motion-safe:animate-spin");
  const label = taskStatusLabel(status);
  return (
    <span title={label} className="inline-flex shrink-0">
      {glyph === "progress" ? (
        <ProgressGlyph size={16} className={className} style={style} />
      ) : (
        (() => {
          const Icon = glyph;
          return <Icon size={16} className={className} style={style} aria-hidden="true" />;
        })()
      )}
      <span className="sr-only">{label}</span>
    </span>
  );
}

// ── Sélecteur d'entité (recette du choix d'assigné du composeur de l'hôte) ─
//
// Déclencheur compact (`h-8 … text-xs`), puis recherche et liste au clavier.
// La liste s'ouvre dans le flux, sous le déclencheur, et non en popover : dans
// une fenêtre, elle ne peut donc pas sortir de l'écran.

export interface PickerOption {
  id: string;
  label: string;
  /** Texte secondaire (rôle, statut…). */
  hint?: string | null;
}

export function EntityPicker({
  label,
  value,
  options,
  onChange,
  placeholder,
  searchPlaceholder,
  disabled,
}: {
  /** Nom du champ (lu par les lecteurs d'écran). */
  label: string;
  /** Id de l'option choisie ; `null` : aucune. */
  value: string | null;
  options: PickerOption[];
  onChange: (id: string) => void;
  /** Texte du déclencheur sans choix. */
  placeholder: string;
  searchPlaceholder: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const selected = options.find((o) => o.id === value) ?? null;
  const q = query.trim().toLowerCase();
  const visible = q ? options.filter((o) => `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(q)) : options;

  function pick(id: string) {
    onChange(id);
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (visible.length ? (i + step + visible.length) % visible.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const option = visible[Math.min(active, visible.length - 1)];
      if (option) pick(option.id);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setOpen((o) => !o);
          setQuery("");
          setActive(Math.max(0, options.findIndex((o) => o.id === value)));
        }}
        className={buttonClass("ghost", "toolbar", "max-w-full justify-start px-2.5 text-xs")}
      >
        <span className={cn("truncate", !selected && "text-muted-foreground")}>{selected?.label ?? placeholder}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
      {open ? (
        <div className="rounded-md border border-border p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
            <input
              autoFocus
              type="search"
              aria-label={searchPlaceholder}
              placeholder={searchPlaceholder}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div className="mt-2 min-h-0 max-h-60 overflow-y-auto overscroll-contain touch-pan-y" role="listbox" aria-label={label}>
            {visible.length === 0 ? <p className="px-2 py-2 text-sm text-muted-foreground">Aucun résultat.</p> : null}
            {visible.map((option, i) => (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={option.id === value}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(option.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left focus-visible:outline-none",
                  active === i ? "bg-accent" : "hover:bg-accent",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{option.label}</span>
                  {option.hint ? <span className="block truncate text-xs text-muted-foreground">{option.hint}</span> : null}
                </span>
                {option.id === value ? <Check className="size-4 shrink-0" aria-hidden="true" /> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Ligne de la fiche : libellé à gauche, valeur à droite (recette du panneau Propriétés). */
export function PropertyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span className="w-24 shrink-0 pt-2 text-xs text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
