/**
 * Applying `hostContext` to the document (§7.4).
 *
 * The host owns all structural color, type and radius; we only ever consume its
 * variables. Every variable used by the stylesheet has a `:root` fallback in
 * `styles.css`, and the host's values arrive here as inline custom properties on
 * the root element, which outrank that fallback — so a host that supplies a
 * partial set still leaves a coherent surface.
 */

import type { HostContext } from "./protocol.js";

const FONT_STYLE_ID = "gather-host-fonts";

/** True when there is a document to write to (false in the engine's node tests). */
function hasDom(): boolean {
  return typeof document !== "undefined" && document.documentElement !== null;
}

export function applyHostContext(context: HostContext): void {
  if (!hasDom()) return;
  const root = document.documentElement;

  for (const [key, value] of Object.entries(context.styles?.variables ?? {})) {
    if (typeof value === "string" && value.length > 0) root.style.setProperty(key, value);
    else root.style.removeProperty(key);
  }

  if (context.theme) {
    root.dataset.theme = context.theme;
    root.style.colorScheme = context.theme;
  }
  if (context.displayMode) root.dataset.displayMode = context.displayMode;
  if (context.platform) root.dataset.platform = context.platform;
  if (context.deviceCapabilities?.touch !== undefined) {
    root.dataset.touch = String(context.deviceCapabilities.touch);
  }

  const insets = context.safeAreaInsets;
  if (insets) {
    for (const side of ["top", "right", "bottom", "left"] as const) {
      root.style.setProperty(`--safe-area-inset-${side}`, `${insets[side]}px`);
    }
  }

  // Host-injected @font-face CSS. Not a runtime fetch on our part: the host
  // supplies the text, and anything it points at is subject to the host's CSP.
  const fonts = context.styles?.css?.fonts;
  if (typeof fonts === "string") {
    const existing = document.getElementById(FONT_STYLE_ID);
    const style = existing ?? document.createElement("style");
    style.id = FONT_STYLE_ID;
    style.textContent = fonts;
    if (!existing) document.head.appendChild(style);
  }
}

/** Shallow-merges a `host-context-changed` patch (§7.2 — partial updates). */
export function mergeHostContext(current: HostContext, patch: HostContext): HostContext {
  return {
    ...current,
    ...patch,
    ...(patch.styles || current.styles
      ? {
          styles: {
            ...current.styles,
            ...patch.styles,
            variables: { ...current.styles?.variables, ...patch.styles?.variables },
            css: { ...current.styles?.css, ...patch.styles?.css },
          },
        }
      : {}),
  };
}
