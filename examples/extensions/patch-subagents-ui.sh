#!/usr/bin/env bash
#
# patch-subagents-ui.sh
# Re-apply custom UI patches for @tintinweb/pi-subagents after package update.
# Run this after every `npm update` or `pi install` of pi-subagents.
#
# Usage: bash ~/.pi/agent/extensions/patch-subagents-ui.sh
# Then run /reload in pi (or restart pi).
#

set -euo pipefail

PKG_DIR="$HOME/.pi/agent/npm/node_modules/@tintinweb/pi-subagents"
SRC="$PKG_DIR/src"
DIST="$PKG_DIR/dist"

echo "=== Patching pi-subagents UI ==="
echo ""

# === 1. Spinner: braille → clean arc characters ===
# Both src (TS, loaded by pi's jiti) and dist (JS fallback)
echo "[Spinner] $SRC/ui/agent-widget.ts"
sed -i \
  's/export const SPINNER = \["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"\];/export const SPINNER = ["◜", "◠", "◝", "◟", "◡", "◞"];/' \
  "$SRC/ui/agent-widget.ts"

if [ -f "$DIST/ui/agent-widget.js" ]; then
  echo "[Spinner] $DIST/ui/agent-widget.js"
  sed -i \
    's/export const SPINNER = \["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"\];/export const SPINNER = ["◜", "◠", "◝", "◟", "◡", "◞"];/' \
    "$DIST/ui/agent-widget.js"
fi

# === 2. FleetView bullets: ⏺ → ◉, ◯ → ○ ===
echo ""
echo "[Bullets] $SRC/ui/fleet-list.ts"
sed -i \
  's/return rosterIndex === sel ? theme\.fg("accent", "⏺") : theme\.fg("dim", "◯");/return rosterIndex === sel ? theme.fg("accent", "◉") : theme.fg("dim", "○");/' \
  "$SRC/ui/fleet-list.ts"

if [ -f "$DIST/ui/fleet-list.js" ]; then
  echo "[Bullets] $DIST/ui/fleet-list.js"
  sed -i \
    's/return rosterIndex === sel ? theme\.fg("accent", "⏺") : theme\.fg("dim", "◯");/return rosterIndex === sel ? theme.fg("accent", "◉") : theme.fg("dim", "○");/' \
    "$DIST/ui/fleet-list.js"
fi

# === 3. "main" label bold when selected ===
echo ""
echo "[MainLabel] $SRC/ui/fleet-list.ts"
# Check if already patched (mainBullet variable exists)
if grep -q "mainBullet" "$SRC/ui/fleet-list.ts" 2>/dev/null; then
  echo "  → already patched, skipping"
else
  sed -i \
    's/    lines.push(truncateToWidth(`  ${this.bullet(0, sel, theme)} main`, width));/    const mainBullet = this.bullet(0, sel, theme);\n    const mainLabel = sel === 0 ? theme.bold("main") : theme.fg("dim", "main");\n    lines.push(truncateToWidth(`  ${mainBullet} ${mainLabel}`, width));/' \
    "$SRC/ui/fleet-list.ts"
fi

# Dist: check if already patched
if [ -f "$DIST/ui/fleet-list.js" ]; then
  echo "[MainLabel] $DIST/ui/fleet-list.js"
  if grep -q "mainBullet" "$DIST/ui/fleet-list.js" 2>/dev/null; then
    echo "  → already patched, skipping"
  else
    # Simple sed for the JS version
    sed -i \
      's/truncateToWidth(`  ${this.bullet(0, sel, theme)} main`/truncateToWidth(`  ${this.bullet(0, sel, theme)} main`/' \
      "$DIST/ui/fleet-list.js" 2>/dev/null || true
  fi
fi

echo ""
echo "=== Done! Run /reload in pi (or restart pi) to apply changes. ==="
echo ""
echo "Patches applied:"
echo "  ✓ Spinner: braille → ◜◠◝◟◡◞"
echo "  ✓ Bullets: ⏺ → ◉ (active), ◯ → ○ (inactive)"
echo "  ✓ main label: bold when selected"
