/** Presentation-only tokens. No scales, sampling, or playback behavior lives here. */
export const CHART_THEME = {
  background: [1, 1, 1] as const,
  line: [184 / 255, 217 / 255, 245 / 255] as const,
  lineWidth: 2,
  grid: "#E7E9ED",
  verticalGrid: "#EFF1F4",
  axis: "#777E89",
  font: "10px 'JetBrains Mono Variable', monospace",
  highlight: "#F6E7A1",
  highlightText: "#20242B",
  crosshair: "#9AAEC1",
  point: "#D5B957",
  tooltip: "#FFFDF5",
  tooltipText: "#20242B",
  overview: "#A6C9E8",
  overviewFill: "rgba(184,217,245,.14)",
};
