---
name: GenerativeAI Community
description: Dark, terminal-inspired community website
colors:
  background: "#131313"
  surface-container-lowest: "#0e0e0e"
  surface-container-low: "#1b1b1b"
  surface-container: "#1f1f1f"
  surface-container-high: "#2a2a2a"
  surface-container-highest: "#353535"
  surface-bright: "#393939"
  on-surface: "#e2e2e2"
  on-surface-variant: "#c1c6d7"
  outline: "#8b90a0"
  outline-variant: "#414754"
  primary: "#aec6ff"
  on-primary: "#002e6b"
  primary-fixed: "#d8e2ff"
  secondary: "#d0bcff"
  tertiary: "#4edea3"
  error: "#ffb4ab"
typography:
  display:
    fontFamily: "Geist Variable, Geist, system-ui, sans-serif"
    fontSize: "40px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Geist Variable, Geist, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Geist Variable, Geist, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
  code:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.0
    letterSpacing: "0.1em"
rounded:
  none: "0"
  avatar: "2px"
spacing:
  unit: "4px"
  gutter: "16px"
  margin-mobile: "16px"
  margin-desktop: "32px"
  stack-sm: "8px"
  stack-md: "24px"
  stack-lg: "48px"
components:
  button-primary:
    backgroundColor: "{colors.on-surface}"
    textColor: "{colors.background}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 16px"
  admissions-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    padding: "12px 20px"
  card:
    backgroundColor: "{colors.surface-container}"
    rounded: "{rounded.none}"
    padding: "16px"
---

# Design System: GenerativeAI Community

## Overview

**Creative North Star: "Dark terminal-inspired community"**

The incumbent identity is dark and terminal-inspired. Geist carries reading and headings; JetBrains Mono supplies compact uppercase navigation, labels, and code. Sharp borders, restrained color, and a narrow reading column keep community information and applications legible.

This is a scan of the implemented system, not a proposed redesign. Sources: `src/styles/global.css`, `src/styles/admissions.css`, shared components, `BaseLayout.astro`, and Events and brand pages.

**Key Characteristics:**
- Dark neutral surfaces with pale blue interactive accents.
- Square corners and thin rules.
- Sans-serif reading text paired with monospace labels.

## Colors

### Primary
Pale blue marks links, active navigation, focus outlines, and admissions primary actions. The shared primary button instead uses the light on-surface neutral.

### Secondary
Digital purple remains available in the incumbent theme; it is not the default action color.

### Tertiary
Neon green distinguishes inline code and supporting technical accents.

### Neutral
The background and ascending container tones organize the dark interface. On-surface is the reading color; on-surface-variant supports secondary text. Outline and outline-variant provide field strokes and subdued separators. Error supplies admissions error text and borders.

## Typography

The frontmatter records the implemented scale. Headings and body use Geist Variable; navigation, chips, section labels, and code use JetBrains Mono Variable. Labels are uppercase with expanded tracking. Mobile page headings use 32px, stepping to the display size on desktop; admissions headings use `clamp(32px, 5vw, 40px)`. Admissions introductory text is 18px with a 60ch maximum width.

## Layout

The shared shell is centered at a 48rem maximum width with mobile and desktop horizontal margins. Main content uses the medium vertical stack. The desktop navigation appears at 48rem; smaller screens use the fixed four-column bottom navigation and 80px bottom body padding. The header remains sticky. Brand text shortens below 40rem. Admissions action rows wrap with a 12px gap. Controls target at least 48px height. Events are separated by horizontal rules rather than independent tiles.

## Elevation & Depth

The inspected styles use tonal surfaces and one-pixel borders, without box shadows. Sticky and fixed navigation provide positional layering; elevation is not a decorative card effect. Shared interactive components transition colors using Tailwind defaults.

## Shapes

Buttons, fields, cards, images, and prose code blocks are square. The theme permits a small avatar corner treatment. Chips are rectangular outlined labels rather than pills.

## Components

### Buttons
Shared buttons use uppercase monospace labels and horizontal gutter padding. Primary is light neutral on dark; secondary is outlined, turning blue on hover; AI is blue-outlined and fills blue on hover. Admissions buttons use semibold body type and 12px by 20px padding; primary is pale blue with dark-blue text. Disabled admissions buttons use opacity 0.55 and a wait cursor.

### Inputs / Fields
Admissions inputs, selects, and textareas use the lowest surface, outline borders, 12px padding, and inherited body typography. Textareas start at 110px and resize vertically. Explicit admissions focus rings are 2px primary with a 4px offset on inputs, textareas, buttons, anchors, and summaries. Other shared components retain native browser focus behavior.

### Navigation
Desktop header links and mobile bottom links use monospace uppercase labels, muted inactive text, pale-blue active text, and `aria-current`. Shared links use a minimum tap height.

### Chips and Cards
Chips use an outline-variant border and 8px by 4px padding. Cards use the container surface, outline-variant border, and gutter padding. Neither adds a shadow.

### Section Labels and Prose
Section labels begin with `//`, use uppercase monospace, and sit above a horizontal rule. Prose links remain underlined; long URLs wrap and code blocks scroll horizontally. Admissions notices use container surfaces and outline borders, switching text and border to error for failures.

### Brand Assets
Reuse the G-underscore logo and original LinkedIn banner. The logo SVG is vector artwork; the banner SVG embeds raster artwork.

## Do's and Don'ts

- Reuse the existing logo and banner assets.
- Keep Apply, Events, brand, and legal pages within the shared dark shell.
- Use the existing typography, spacing, and border tokens.
- Do not replace the terminal-inspired identity during a narrow extension.
- Do not describe the raster-embedded banner SVG as vector artwork.
- Do not introduce rounded cards or decorative elevation into the documented flat system.
