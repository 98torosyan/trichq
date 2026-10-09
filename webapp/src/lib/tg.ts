/** Thin, typed wrapper over window.Telegram.WebApp that degrades gracefully in a normal browser. */

interface TgWebApp {
  initData: string;
  initDataUnsafe: { user?: { id: number; first_name?: string }; start_param?: string };
  colorScheme: "light" | "dark";
  platform: string;
  version: string;
  ready(): void;
  expand(): void;
  isVersionAtLeast(v: string): boolean;
  setHeaderColor(c: string): void;
  setBackgroundColor(c: string): void;
  setBottomBarColor?(c: string): void;
  disableVerticalSwipes?(): void;
  onEvent(e: string, cb: () => void): void;
  offEvent(e: string, cb: () => void): void;
  openLink(url: string, opts?: { try_instant_view?: boolean }): void;
  HapticFeedback?: {
    impactOccurred(s: "light" | "medium" | "heavy" | "rigid" | "soft"): void;
    notificationOccurred(t: "error" | "success" | "warning"): void;
    selectionChanged(): void;
  };
  BackButton?: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
  }
}

export const tg: TgWebApp | null = window.Telegram?.WebApp?.initData ? window.Telegram.WebApp : null;

export const inTelegram = Boolean(tg);

export function initTelegram(): void {
  if (!tg) return;
  tg.ready();
  tg.expand();
  tg.disableVerticalSwipes?.();
  applyScheme();
  tg.onEvent("themeChanged", applyScheme);
}

export function applyScheme(): void {
  const scheme = tg?.colorScheme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = scheme;
  // Hex header colours need Bot API 6.9+; older clients throw, and the app must still start.
  if (tg && tg.isVersionAtLeast("6.9")) {
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || (scheme === "dark" ? "#0A111D" : "#E9EFF6");
    try {
      tg.setHeaderColor(bg);
      tg.setBackgroundColor(bg);
      if (tg.isVersionAtLeast("7.10")) tg.setBottomBarColor?.(bg);
    } catch {
      /* cosmetic only */
    }
  }
}

export const haptic = {
  tap: () => tg?.HapticFeedback?.impactOccurred("light"),
  soft: () => tg?.HapticFeedback?.impactOccurred("soft"),
  select: () => tg?.HapticFeedback?.selectionChanged(),
  success: () => tg?.HapticFeedback?.notificationOccurred("success"),
  error: () => tg?.HapticFeedback?.notificationOccurred("error"),
};

export function openExternal(url: string): void {
  if (tg) tg.openLink(url);
  else window.open(url, "_blank", "noopener");
}

export function onBackButton(cb: () => void): () => void {
  const bb = tg?.BackButton;
  if (!bb) return () => {};
  bb.show();
  bb.onClick(cb);
  return () => {
    bb.offClick(cb);
    bb.hide();
  };
}
