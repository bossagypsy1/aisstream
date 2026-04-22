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
    boundingBoxes: [[[11.5, -18.5], [17.5, -13.5]]],
  },
];

export const DEFAULT_LOCALE = LOCALES[0];
