export const BOARD_CUE_LEGEND = [
  {
    label: 'Selected source',
    description: 'double outline',
    markerClass: 'cue-legend-marker--source',
  },
  {
    label: 'Legal destination',
    description: 'dashed outline + check',
    markerClass: 'cue-legend-marker--legal',
  },
  {
    label: 'Blocked neighbor',
    description: 'X mark',
    markerClass: 'cue-legend-marker--blocked',
  },
  {
    label: 'Blocked cell',
    description: 'diagonal hatch',
    markerClass: 'cue-legend-marker--hatch',
  },
] as const;
