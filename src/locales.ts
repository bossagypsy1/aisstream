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
    // Box extends from Senegal (8°N) north to the Canary Islands / Morocco coast (32°N)
    // and well offshore (28°W) to capture Atlantic shipping lanes.
    // If the Canary Islands band (27-29°N) shows no ships either, the API key
    // likely has a regional coverage limit for this area.
    boundingBoxes: [[[8.0, -28.0], [32.0, -8.0]]],
  },
];

export const DEFAULT_LOCALE = LOCALES[0];
