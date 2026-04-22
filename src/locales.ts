export interface Locale {
  id:           string;
  name:         string;
  center:       [number, number];                            // [lat, lon] for map display
  zoom:         number;
  boundingBoxes: [[number, number], [number, number]][];    // AISStream subscription boxes
}

export const LOCALES: Locale[] = [
  {
    id:           'uk',
    name:         'United Kingdom',
    center:       [56.5, -3.5],
    zoom:         6,
    boundingBoxes: [[[49.0, -8.0], [62.0, 2.0]]],
  },
  {
    id:           'senegal',
    name:         'Senegal Coast',
    center:       [14.5, -17.0],
    zoom:         7,
    // Wide Atlantic box covering Senegal coast + major offshore shipping lanes.
    // Extends to 25°W to catch vessels transiting between Europe and South America/South Africa.
    // UK is at 49–62°N — zero overlap with this 8–22°N band.
    boundingBoxes: [[[8.0, -25.0], [22.0, -10.0]]],
  },
];

export const DEFAULT_LOCALE = LOCALES[0];
